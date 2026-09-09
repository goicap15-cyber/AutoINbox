const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const licenseService = require('./services/licenseService');
const clientUserService = require('./services/clientUserService');
const registrationOtpService = require('./services/registrationOtpService');

const app = express();
const PORT = process.env.PORT || 5055;
const adminSessions = new Set();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CloudLinux Passenger may keep the public base URI in req.url instead of
// stripping it before forwarding to Express. Support both hosting and local URLs.
const PUBLIC_BASE_PATH = String(process.env.BASE_PATH || '/license_server').replace(/\/$/, '');
app.use((req, _res, next) => {
  if (PUBLIC_BASE_PATH && (req.url === PUBLIC_BASE_PATH || req.url.startsWith(`${PUBLIC_BASE_PATH}/`))) {
    req.url = req.url.slice(PUBLIC_BASE_PATH.length) || '/';
  }
  next();
});

function isAdminRequest(req) {
  const pass = process.env.ADMIN_PASSWORD || 'admin123';
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return token === pass || adminSessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
  next();
}

app.post('/api/admin/login', async (req, res) => {
  const pass = process.env.ADMIN_PASSWORD || 'admin123';
  if (String(req.body?.password || '') !== pass) {
    return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ success: true, token });
});

app.post('/api/client-auth/register-otp', async (req, res) => {
  try {
    const result = await registrationOtpService.send(req.body?.email);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) {
    console.error('[Registration OTP]', error);
    res.status(error.code === 'OTP_MAIL_NOT_CONFIGURED' ? 503 : 500).json({ success: false, code: error.code || 'OTP_SEND_FAILED', message: error.message || 'Không thể gửi mã OTP.' });
  }
});

app.post('/api/client-auth/reset-password-otp', async (req, res) => {
  try {
    const email = registrationOtpService.normalizeGmail(req.body?.email);
    if (!email) return res.status(400).json({ success: false, code: 'INVALID_GMAIL', message: 'Vui lòng nhập địa chỉ @gmail.com hợp lệ.' });
    const userCheck = await clientUserService.accountStatus({ username: email });
    if (!userCheck.success) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'Email này chưa được đăng ký trong hệ thống.' });
    }
    const result = await registrationOtpService.send(email);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) {
    console.error('[Reset Password OTP]', error);
    res.status(error.code === 'OTP_MAIL_NOT_CONFIGURED' ? 503 : 500).json({ success: false, code: error.code || 'OTP_SEND_FAILED', message: error.message || 'Không thể gửi mã OTP.' });
  }
});

app.post('/api/client-auth/reset-password', async (req, res) => {
  try {
    const email = registrationOtpService.normalizeGmail(req.body?.email || req.body?.username);
    const verified = registrationOtpService.verify(email, req.body?.otp);
    if (!verified.success) return res.status(verified.status || 400).json(verified);
    const result = await clientUserService.resetPasswordByOtp({ ...req.body, email });
    if (result.success) registrationOtpService.verify(email, req.body?.otp, true);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, code: 'AUTH_SERVER_ERROR', message: 'Không thể đặt lại mật khẩu.' });
  }
});

app.post('/api/client-auth/register', async (req, res) => {
  try {
    const email = registrationOtpService.normalizeGmail(req.body?.email || req.body?.username);
    const verified = registrationOtpService.verify(email, req.body?.otp);
    if (!verified.success) return res.status(verified.status || 400).json(verified);
    const result = await clientUserService.register({ ...req.body, username: email, email });
    if (result.success) registrationOtpService.verify(email, req.body?.otp, true);
    res.status(result.success ? 201 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, code: 'AUTH_SERVER_ERROR', message: 'Không thể đăng ký tài khoản.' }); }
});

app.post('/api/client-auth/login', async (req, res) => {
  try {
    const result = await clientUserService.login(req.body);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, code: 'AUTH_SERVER_ERROR', message: 'Không thể đăng nhập tài khoản.' }); }
});

app.post('/api/client-auth/google', async (req, res) => {
  try {
    const result = await clientUserService.loginGoogle(req.body || {});
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) {
    console.error('[Google Auth]', error);
    res.status(500).json({ success: false, code: 'GOOGLE_AUTH_SERVER_ERROR', message: 'Không thể đăng nhập bằng Google.' });
  }
});

app.post('/api/client-auth/license-status', async (req, res) => {
  res.json({ success: true, data: await clientUserService.licenseStatus(req.body || {}) });
});

app.post('/api/client-auth/account-status', async (req, res) => {
  const result = await clientUserService.accountStatus(req.body || {});
  res.status(result.success ? 200 : result.status || 400).json(result);
});

app.post('/api/client-auth/company-employees', async (req, res) => {
  try {
    const result = await clientUserService.createCompanyEmployee(req.body || {});
    res.status(result.success ? 201 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, message: 'Không thể tạo nhân viên doanh nghiệp.' }); }
});

app.delete('/api/client-auth/company-employees', async (req, res) => {
  try {
    const result = await clientUserService.removeCompanyEmployee(req.body || {});
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, message: 'Không thể xóa nhân viên doanh nghiệp.' }); }
});

app.get('/api/admin/client-users', requireAdmin, async (req, res) => {
  res.json({ success: true, data: await clientUserService.list() });
});

app.patch('/api/admin/client-users/:id/status', requireAdmin, async (req, res) => {
  try {
    const result = await clientUserService.setStatus(req.params.id, req.body.status);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, message: 'Không thể cập nhật tài khoản.' }); }
});

app.patch('/api/admin/client-users/:id/password', requireAdmin, async (req, res) => {
  try {
    const result = await clientUserService.resetPassword(req.params.id, req.body.password);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, message: 'Không thể đặt lại mật khẩu.' }); }
});

app.delete('/api/admin/client-users', requireAdmin, async (req, res) => {
  try { res.json(await clientUserService.removeAll()); }
  catch (error) { res.status(500).json({ success: false, message: 'Không thể xóa tất cả tài khoản.' }); }
});

app.delete('/api/admin/client-users/:id', requireAdmin, async (req, res) => {
  try {
    const result = await clientUserService.remove(req.params.id);
    res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (error) { res.status(500).json({ success: false, message: 'Không thể xóa tài khoản.' }); }
});

// Trang chủ health check
app.get('/', async (req, res) => {
  res.json({
    status: 'online',
    service: 'FB Personal Messenger CRM - Central License Server',
    time: new Date().toISOString()
  });
});

/**
 * Bảng giá công khai cho màn hình thanh toán
 */
app.get('/api/pricing', async (req, res) => {
  try {
    res.json({ success: true, data: await licenseService.getPricingSettings() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Không thể tải bảng giá', error: error.message });
  }
});

/**
 * 1. API Tạo đơn hàng thanh toán
 * Body: { months: 1, machines: 2 }
 */
app.post('/api/orders/create', async (req, res) => {
  try {
    const { months, machines, licenseKey } = req.body;
    const orderInfo = await licenseService.createOrder({ months, machines, licenseKey });
    res.json({ success: true, data: orderInfo });
  } catch (error) {
    console.error('[API Create Order Error]:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 2. API Kiểm tra trạng thái đơn hàng (Polling từ App Client)
 * GET /api/orders/status/:orderCode
 */
app.get('/api/orders/status/:orderCode', async (req, res) => {
  try {
    const { orderCode } = req.params;
    const order = await licenseService.getOrder(orderCode);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
    }

    res.json({
      success: true,
      data: {
        orderCode: order.order_code,
        status: order.status,
        totalAmount: order.total_amount,
        keyValue: order.key_value || null,
        expiresAt: order.expires_at || null,
        paidAt: order.paid_at || null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 3. Webhook nhận thông báo tiền vào từ SePay 24/7
 * POST /api/sepay/webhook
 */
app.post('/api/sepay/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[SePay Webhook Received]:', JSON.stringify(payload));

    // SePay gửi payload dạng: { transferAmount: 198000, content: "FB889234 CHUYEN TIEN", ... }
    const content = [payload.content, payload.description, payload.referenceCode, payload.transactionContent]
      .filter(Boolean).join(' ');
    const rawAmount = payload.transferAmount ?? payload.amount ?? payload.transfer_amount ?? payload.creditAmount ?? 0;
    const transferAmount = Number(String(rawAmount).replace(/[^0-9.-]/g, ''));

    // Tìm mã đơn hàng FBXXXXXX trong nội dung chuyển khoản
    const match = String(content).replace(/\s+/g, '').match(/FB\d{6}/i);

    if (!match) {
      console.log('[SePay Webhook] Không tìm thấy mã đơn FBxxxxxx trong nội dung:', content);
      return res.json({ success: true, message: 'Bỏ qua - Không có mã đơn hàng hợp lệ' });
    }

    const orderCode = match[0].toUpperCase();
    const result = await licenseService.fulfillPayment(orderCode, transferAmount);

    if (result.success) {
      return res.json({ success: true, message: 'Xử lý thanh toán và sinh Key thành công', data: result });
    } else {
      return res.status(400).json({ success: false, message: result.reason || 'Xử lý thất bại' });
    }
  } catch (error) {
    console.error('[SePay Webhook Error]:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 4. API Kích hoạt License Key cho 1 máy tính
 * Body: { key: "KEY-XXXX", machineId: "CPU-1234", deviceName: "PC-Sales" }
 */
app.post('/api/license/activate', async (req, res) => {
  try {
    const { key, machineId, deviceName, clientUsername } = req.body;
    const result = await licenseService.activateLicense({ key, machineId, deviceName });

    if (result.success) {
      if (clientUsername) await clientUserService.bindLicense(clientUsername, key);
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 4b. Lưu tên công ty gắn với License Key sau thanh toán
 * Body: { key: "KEY-XXXX", companyName: "Tên công ty" }
 */
app.post('/api/license/company', async (req, res) => {
  try {
    const result = await licenseService.setCompanyName(req.body || {});
    if (!result.success) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Không thể lưu tên công ty', error: error.message });
  }
});

/**
 * 5. API Hủy kích hoạt / Đăng xuất Key khỏi 1 máy
 * Body: { key: "KEY-XXXX", machineId: "CPU-1234" }
 */
app.post('/api/license/deactivate', async (req, res) => {
  try {
    const { key, machineId } = req.body;
    const result = await licenseService.deactivateDevice({ key, machineId });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 6. API Verify bản quyền khi App Client khởi động
 * Body: { key: "KEY-XXXX", machineId: "CPU-1234" }
 */
app.post('/api/license/verify', async (req, res) => {
  try {
    const { key, machineId } = req.body;
    const result = await licenseService.verifyLicense({ key, machineId });
    res.json(result);
  } catch (error) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

/**
 * 7. Admin API: Lấy danh sách Keys & Devices
 */
app.get('/api/admin/licenses', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
    }
    const licenses = await licenseService.getAllLicenses();
    res.json({ success: true, data: licenses });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/pricing', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
  }
  res.json({ success: true, data: await licenseService.getPricingSettings() });
});

app.put('/api/admin/pricing', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
    }
    const result = await licenseService.updatePricingSettings(req.body);
    if (!result.success) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Không thể cập nhật bảng giá', error: error.message });
  }
});

/**
 * 8. Admin API: Xóa / Gỡ thiết bị thủ công
 */
app.post('/api/admin/remove-device', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
    }
    const { deviceId } = req.body;
    const result = await licenseService.removeDeviceAdmin(deviceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 9. Admin API: Xóa vĩnh viễn License Key
 */
app.delete('/api/admin/licenses/:licenseId', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(401).json({ success: false, message: 'Mật khẩu Admin không đúng' });
    }

    const licenseId = Number(req.params.licenseId);
    if (!Number.isInteger(licenseId) || licenseId <= 0) {
      return res.status(400).json({ success: false, message: 'License ID không hợp lệ' });
    }

    const result = await licenseService.deleteLicenseAdmin(licenseId);
    if (!result.success) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Serve Admin UI Dashboard HTML
app.get('/admin', async (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

async function start() {
  await require('./db').ready;
  app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Central License Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`🌐 Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`=======================================================`);
  });
}

start().catch((error) => {
  console.error('[Startup] MySQL initialization failed:', error);
  process.exitCode = 1;
});
