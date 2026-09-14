const fs = require('fs');
const path = require('path');
const { getMachineId } = require('../utils/machineId');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');
const { isLocalDevRequest } = require('../utils/localDevAccess');

const DATA_DIR = APP_DATA_ROOT;
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://genblackmmoonline.online/license_server';

async function fetchLicenseWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

class LicenseChecker {
  constructor() {
    this.cachedStatus = {
      isLicensed: false,
      reason: 'UNCHECKED',
      message: 'Đang kiểm tra bản quyền...',
      key: '',
      expiresAt: null,
      daysRemaining: 0
    };
    this.checkTimer = null;
  }

  // Đọc Key lưu cục bộ trong data/license.json
  getSavedKey() {
    try {
      if (fs.existsSync(LICENSE_FILE)) {
        const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        return data.key || '';
      }
    } catch (e) {
      console.error('[LicenseChecker] Error reading license.json:', e);
    }
    return '';
  }

  // Lưu Key vào data/license.json
  saveKey(key) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key: key.trim(), updatedAt: new Date().toISOString() }), 'utf8');
    } catch (e) {
      console.error('[LicenseChecker] Error saving license.json:', e);
    }
  }

  // Xóa Key
  removeKey() {
    try {
      if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
    } catch (e) {}
    this.cachedStatus = {
      isLicensed: false,
      reason: 'KEY_REMOVED',
      message: 'Chưa kích hoạt bản quyền',
      key: '',
      expiresAt: null,
      daysRemaining: 0
    };
  }

  // Gọi Central License Server kiểm tra bản quyền
  async verify() {
    const savedKey = this.getSavedKey();
    if (!savedKey) {
      this.cachedStatus = {
        isLicensed: false,
        reason: 'NO_KEY',
        message: 'Ứng dụng chưa được kích hoạt License Key',
        key: '',
        expiresAt: null,
        daysRemaining: 0
      };
      return this.cachedStatus;
    }

    try {
      const machineId = getMachineId();
      const res = await fetchLicenseWithTimeout(`${LICENSE_SERVER_URL}/api/license/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: savedKey, machineId })
      });

      const json = await res.json();
      if (json.valid) {
        this.cachedStatus = {
          isLicensed: true,
          reason: 'VALID',
          message: 'Bản quyền hợp lệ',
          key: savedKey,
          expiresAt: json.expiresAt,
          daysRemaining: json.daysRemaining,
          machines: json.machines
        };
      } else {
        this.cachedStatus = {
          isLicensed: false,
          reason: json.reason || 'INVALID',
          message: json.message || 'License Key không hợp lệ hoặc đã hết hạn',
          key: savedKey,
          expiresAt: json.expiresAt || null,
          daysRemaining: 0
        };
      }
    } catch (err) {
      console.warn(`[LicenseChecker] Failed to connect to Central Server (${LICENSE_SERVER_URL}):`, err.message);
      // Nếu mất mạng tạm thời nhưng có Key cũ và trước đó đã valid ➔ Cho phép grace period 1 ngày
      if (this.cachedStatus.isLicensed) {
        console.log('[LicenseChecker] Using grace period cache.');
      } else {
        this.cachedStatus = {
          isLicensed: false,
          reason: 'SERVER_OFFLINE',
          message: 'Không thể kết nối đến License Server để xác minh bản quyền',
          key: savedKey,
          expiresAt: null,
          daysRemaining: 0
        };
      }
    }

    return this.cachedStatus;
  }

  // Middleware Express chặn tất cả API nếu chưa có bản quyền
  middleware() {
    return async (req, res, next) => {
      if (isLocalDevRequest(req, 'LOCAL_DEV_SKIP_LICENSE')) {
        return next();
      }

      // Các đường dẫn API công khai được phép gọi khi chưa kích hoạt
      const publicPaths = [
        '/api/license/status',
        '/api/license/activate',
        '/api/license/deactivate',
        '/api/orders/create',
        '/api/orders/status',
        '/api/payment/sepay-webhook'
      ];

      if (publicPaths.some(p => req.path.startsWith(p))) {
        return next();
      }

      // Kiểm tra cachedStatus
      if (!this.cachedStatus.isLicensed) {
        // Re-verify nhanh
        await this.verify();
      }

      if (!this.cachedStatus.isLicensed) {
        return res.status(402).json({
          success: false,
          code: 'LICENSE_REQUIRED',
          message: this.cachedStatus.message || 'Ứng dụng chưa được kích hoạt bản quyền. Vui lòng mua hoặc nhập Key.',
          status: this.cachedStatus
        });
      }

      next();
    };
  }
}

const instance = new LicenseChecker();
// Tự động kiểm tra bản quyền mỗi 10 phút
setInterval(() => instance.verify(), 10 * 60 * 1000);
instance.verify();

module.exports = instance;
