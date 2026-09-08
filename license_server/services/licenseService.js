const crypto = require('crypto');
const db = require('../db');

class LicenseService {
  async getPricingSettings() {
    const row = await db.prepare('SELECT * FROM pricing_settings WHERE id = 1').get();
    return {
      unitPrice: row.unit_price,
      extraSlotPrice: row.extra_slot_price,
      discounts: { 1: row.discount_1, 3: row.discount_3, 6: row.discount_6, 12: row.discount_12 },
      updatedAt: row.updated_at
    };
  }

  async updatePricingSettings(input = {}) {
    const unitPrice = Number(input.unitPrice);
    const extraSlotPrice = Number(input.extraSlotPrice);
    const discounts = input.discounts || {};
    if (!Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > 100000000) {
      return { success: false, status: 400, message: 'Đơn giá phải là số nguyên từ 1 đến 100.000.000đ' };
    }
    if (!Number.isInteger(extraSlotPrice) || extraSlotPrice < 0 || extraSlotPrice > 100000000) {
      return { success: false, status: 400, message: 'Giá thêm slot phải là số nguyên từ 0 đến 100.000.000đ' };
    }
    const values = [1, 3, 6, 12].map((month) => Number(discounts[month]));
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 90)) {
      return { success: false, status: 400, message: 'Mức giảm giá phải là số nguyên từ 0 đến 90%' };
    }
    await db.prepare(`UPDATE pricing_settings SET unit_price = ?, extra_slot_price = ?, discount_1 = ?, discount_3 = ?, discount_6 = ?, discount_12 = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(unitPrice, extraSlotPrice, ...values);
    return { success: true, data: await this.getPricingSettings() };
  }

  /**
   * Tính tổng tiền theo bảng giá đang được Admin cấu hình.
   */
  async calculatePrice(months, machines) {
    const pricing = await this.getPricingSettings();
    const UNIT_PRICE = pricing.unitPrice;
    const EXTRA_SLOT_PRICE = pricing.extraSlotPrice;
    let discountPercent = pricing.discounts[1];
    if (months >= 12) discountPercent = pricing.discounts[12];
    else if (months >= 6) discountPercent = pricing.discounts[6];
    else if (months >= 3) discountPercent = pricing.discounts[3];

    const rawTotal = months * (UNIT_PRICE + Math.max(0, machines - 1) * EXTRA_SLOT_PRICE);
    const finalTotal = Math.floor(rawTotal * (1 - discountPercent / 100));

    return {
      unitPrice: UNIT_PRICE,
      extraSlotPrice: EXTRA_SLOT_PRICE,
      months,
      machines,
      discountPercent,
      rawTotal,
      finalTotal
    };
  }

  /**
   * Tạo đơn hàng thanh toán mới
   */
  async createOrder({ months, machines, licenseKey }) {
    const target = licenseKey ? await db.prepare('SELECT * FROM licenses WHERE key_value=? AND is_active=1').get(String(licenseKey).trim()) : null;
    if (licenseKey && !target) throw new Error('License cần gia hạn không tồn tại hoặc đã bị khóa');
    const monthsNum = target ? Math.max(0, parseInt(months, 10) || 0) : Math.max(1, parseInt(months, 10) || 1);
    const machinesNum = target ? Math.max(0, parseInt(machines, 10) || 0) : Math.max(1, parseInt(machines, 10) || 1);
    if (target && monthsNum === 0 && machinesNum === 0) throw new Error('Cần chọn thêm tháng hoặc thêm máy');
    const priceInfo = target
      ? await this.calculateUpgradePrice(target, monthsNum, machinesNum)
      : await this.calculatePrice(monthsNum, machinesNum);

    const orderId = 'ORD_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const orderCode = 'FB' + Math.floor(100000 + Math.random() * 900000);

    await db.prepare(`
      INSERT INTO orders (id, order_code, months, machines, unit_price, total_amount, status, order_type, target_license_id)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(orderId, orderCode, monthsNum, machinesNum, priceInfo.unitPrice, priceInfo.finalTotal, target ? 'UPGRADE' : 'NEW', target?.id || null);

    const bankNo = process.env.BANK_ACCOUNT_NUMBER || '0813468094';
    const bankName = process.env.BANK_NAME || 'MBBank';
    const accountName = process.env.BANK_ACCOUNT_NAME || 'LE VAN KHANG';

    const qrCodeUrl = `https://img.vietqr.io/image/${bankName}-${bankNo}-compact.png?amount=${priceInfo.finalTotal}&addInfo=${orderCode}&accountName=${encodeURIComponent(accountName)}`;

    return {
      orderId,
      orderCode,
      months: monthsNum,
      machines: machinesNum,
      totalAmount: priceInfo.finalTotal,
      discountPercent: priceInfo.discountPercent,
      bankNo,
      bankName,
      accountName,
      qrCodeUrl,
      status: 'PENDING',
      orderType: target ? 'UPGRADE' : 'NEW',
      licenseKey: target?.key_value || null
    };
  }

  async calculateUpgradePrice(license, addMonths, addMachines) {
    const pricing = await this.getPricingSettings();
    const discount = pricing.discounts[addMonths] || 0;
    const extensionRaw = addMonths * (pricing.unitPrice + Math.max(0, license.machines - 1) * pricing.extraSlotPrice);
    const remainingMonths = Math.max(1, Math.ceil((new Date(license.expires_at) - Date.now()) / (30 * 86400000)) + addMonths);
    const slotsRaw = addMachines * pricing.extraSlotPrice * remainingMonths;
    const rawTotal = extensionRaw + slotsRaw;
    return { unitPrice: pricing.unitPrice, extraSlotPrice: pricing.extraSlotPrice, discountPercent: discount, rawTotal, finalTotal: Math.floor(rawTotal * (1 - discount / 100)) };
  }

  /**
   * Lấy thông tin đơn hàng
   */
  async getOrder(orderCodeOrId) {
    return await db.prepare(`
      SELECT o.*, l.key_value, l.expires_at
      FROM orders o
      LEFT JOIN licenses l ON l.id=o.target_license_id OR (o.target_license_id IS NULL AND o.id=l.order_id)
      WHERE o.id = ? OR o.order_code = ?
    `).get(orderCodeOrId, orderCodeOrId);
  }

  /**
   * Sinh chuỗi Mã Key: KEY-XXXX-XXXX-XXXX-XXXX
   */
  generateKeyString() {
    const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
    return `KEY-${part()}-${part()}-${part()}-${part()}`;
  }

  /**
   * Xử lý thanh toán từ SePay Webhook
   */
  async fulfillPayment(orderCode, transactionAmount) {
    const order = await db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
    if (!order) {
      return { success: false, reason: 'ORDER_NOT_FOUND' };
    }

    if (order.status === 'PAID') {
      const existingLicense = order.target_license_id ? await db.prepare('SELECT * FROM licenses WHERE id=?').get(order.target_license_id) : await db.prepare('SELECT * FROM licenses WHERE order_id = ?').get(order.id);
      return { success: true, alreadyPaid: true, order, license: existingLicense };
    }

    if (transactionAmount < order.total_amount) {
      console.warn(`[Payment] Đơn hàng ${orderCode} thiếu tiền: Nhận ${transactionAmount}, Cần ${order.total_amount}`);
      return { success: false, reason: 'AMOUNT_MISMATCH', required: order.total_amount, received: transactionAmount };
    }

    const targetLicense = order.target_license_id ? await db.prepare('SELECT * FROM licenses WHERE id=?').get(order.target_license_id) : null;
    const expiresAt = targetLicense ? new Date(Math.max(Date.now(), new Date(targetLicense.expires_at).getTime())) : new Date();
    expiresAt.setDate(expiresAt.getDate() + (order.months * 30));

    const keyValue = this.generateKeyString();

    const tx = db.transaction(async () => {
      await db.prepare(`UPDATE orders SET status = 'PAID', paid_at = CURRENT_TIMESTAMP WHERE id = ?`).run(order.id);
      if (targetLicense) {
        await db.prepare('UPDATE licenses SET machines=machines+?,months=months+?,expires_at=? WHERE id=?')
          .run(order.machines, order.months, expiresAt, targetLicense.id);
      } else {
        await db.prepare(`
          INSERT INTO licenses (order_id, key_value, machines, months, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(order.id, keyValue, order.machines, order.months, expiresAt);
      }
    });

    await tx();

    const createdLicense = targetLicense ? await db.prepare('SELECT * FROM licenses WHERE id=?').get(targetLicense.id) : await db.prepare('SELECT * FROM licenses WHERE order_id = ?').get(order.id);
    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

    console.log(`[Payment] ✅ Đã khớp đơn ${orderCode}! Đã cấp Key: ${keyValue}`);

    return {
      success: true,
      order: updatedOrder,
      license: createdLicense
    };
  }

  /**
   * Kích hoạt License Key cho một máy tính (Machine ID)
   */
  async activateLicense({ key, machineId, deviceName }) {
    if (!key || !machineId) {
      return { success: false, reason: 'INVALID_PARAMS', message: 'Thiếu Key hoặc Machine ID' };
    }

    const license = await db.prepare('SELECT * FROM licenses WHERE key_value = ? AND is_active = 1').get(key.trim());
    if (!license) {
      return { success: false, reason: 'KEY_NOT_FOUND', message: 'Mã License Key không tồn tại hoặc đã bị khóa' };
    }

    const now = new Date();
    const expiresAt = new Date(license.expires_at);
    if (now > expiresAt) {
      return { success: false, reason: 'KEY_EXPIRED', message: 'License Key đã hết hạn sử dụng', expiresAt: license.expires_at };
    }

    // Kiểm tra xem máy này đã kích hoạt trước đó chưa
    const existingDevice = await db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND machine_id = ?').get(license.id, machineId);

    if (existingDevice) {
      // Cập nhật last_seen
      await db.prepare('UPDATE license_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(existingDevice.id);
      return {
        success: true,
        message: 'Kích hoạt thành công (Thiết bị cũ)',
        license: {
          key: license.key_value,
          machines: license.machines,
          expiresAt: license.expires_at
        }
      };
    }

    // Đếm số máy đã kích hoạt hiện tại
    const activeCount = (await db.prepare('SELECT COUNT(*) as count FROM license_devices WHERE license_id = ?').get(license.id)).count;

    if (activeCount >= license.machines) {
      return {
        success: false,
        reason: 'SLOTS_FULL',
        message: `Mã Key này đã đạt giới hạn tối đa ${license.machines}/${license.machines} máy. Vui lòng đăng xuất ở máy khác trước.`
      };
    }

    // Đăng ký máy mới vào CSDL
    await db.prepare(`
      INSERT INTO license_devices (license_id, machine_id, device_name)
      VALUES (?, ?, ?)
    `).run(license.id, machineId, deviceName || 'Máy CRM');

    return {
      success: true,
      message: 'Kích hoạt License thành công!',
      license: {
        key: license.key_value,
        machines: license.machines,
        expiresAt: license.expires_at,
        usedSlots: activeCount + 1
      }
    };
  }

  /**
   * Đăng xuất / Hủy liên kết một máy khỏi Key (Deactivate)
   */
  async deactivateDevice({ key, machineId }) {
    const license = await db.prepare('SELECT * FROM licenses WHERE key_value = ?').get(key.trim());
    if (!license) {
      return { success: false, reason: 'KEY_NOT_FOUND' };
    }

    const res = await db.prepare('DELETE FROM license_devices WHERE license_id = ? AND machine_id = ?').run(license.id, machineId);
    return {
      success: true,
      removed: res.changes > 0,
      message: res.changes > 0 ? 'Đã hủy liên kết máy này thành công' : 'Máy này chưa từng kích hoạt'
    };
  }

  /**
   * Verify bản quyền realtime khi App khởi động
   */
  async verifyLicense({ key, machineId }) {
    if (!key || !machineId) {
      return { valid: false, reason: 'MISSING_PARAMS' };
    }

    const license = await db.prepare('SELECT * FROM licenses WHERE key_value = ? AND is_active = 1').get(key.trim());
    if (!license) {
      return { valid: false, reason: 'KEY_NOT_FOUND', message: 'License Key không hợp lệ' };
    }

    const now = new Date();
    const expiresAt = new Date(license.expires_at);
    if (now > expiresAt) {
      return { valid: false, reason: 'EXPIRED', message: 'License đã hết hạn', expiresAt: license.expires_at };
    }

    const device = await db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND machine_id = ?').get(license.id, machineId);
    if (!device) {
      return { valid: false, reason: 'DEVICE_NOT_ACTIVATED', message: 'Máy tính này chưa được đăng ký kích hoạt cho Key này' };
    }

    // Cập nhật last_seen
    await db.prepare('UPDATE license_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(device.id);

    return {
      valid: true,
      expiresAt: license.expires_at,
      machines: license.machines,
      daysRemaining: Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24))
    };
  }

  /**
   * Lưu tên công ty theo License Key sau khi khách hàng thanh toán.
   */
  async setCompanyName({ key, companyName }) {
    const normalizedKey = String(key || '').trim();
    const normalizedName = String(companyName || '').trim().replace(/\s+/g, ' ');
    if (!normalizedKey) {
      return { success: false, status: 400, reason: 'INVALID_KEY', message: 'Thiếu License Key' };
    }
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      return { success: false, status: 400, reason: 'INVALID_COMPANY_NAME', message: 'Tên công ty phải từ 2 đến 120 ký tự' };
    }

    const license = await db.prepare('SELECT id FROM licenses WHERE key_value = ? AND is_active = 1').get(normalizedKey);
    if (!license) {
      return { success: false, status: 404, reason: 'KEY_NOT_FOUND', message: 'License Key không tồn tại hoặc đã bị khóa' };
    }

    await db.prepare('UPDATE licenses SET company_name = ? WHERE id = ?').run(normalizedName, license.id);
    return { success: true, companyName: normalizedName };
  }

  /**
   * Admin: Lấy danh sách tất cả các Key & Thiết bị
   */
  async getAllLicenses() {
    const licenses = await db.prepare(`
      SELECT l.*, o.order_code, o.total_amount AS initial_total_amount,
             o.paid_at AS initial_paid_at, o.created_at AS order_created_at
      FROM licenses l
      LEFT JOIN orders o ON l.order_id = o.id
      ORDER BY l.created_at DESC
    `).all();

    for (const lic of licenses) {
      const paidOrders = await db.prepare(`
        SELECT order_code, total_amount, paid_at, created_at
        FROM orders
        WHERE status = 'PAID' AND (id = ? OR target_license_id = ?)
        ORDER BY paid_at DESC, created_at DESC
      `).all(lic.order_id || '', lic.id);

      if (paidOrders.length > 0) {
        lic.total_amount = paidOrders.reduce((sum, ord) => sum + Number(ord.total_amount || 0), 0);
        lic.paid_at = paidOrders[0].paid_at || paidOrders[0].created_at || lic.initial_paid_at;
        lic.order_code = paidOrders[0].order_code || lic.order_code;
      } else {
        lic.total_amount = Number(lic.initial_total_amount || 0);
        lic.paid_at = lic.initial_paid_at;
      }

      lic.devices = await db.prepare('SELECT * FROM license_devices WHERE license_id = ?').all(lic.id);
    }
    return licenses;
  }

  /**
   * Admin: Gỡ thiết bị thủ công
   */
  async removeDeviceAdmin(deviceId) {
    await db.prepare('DELETE FROM license_devices WHERE id = ?').run(deviceId);
    return { success: true };
  }

  /**
   * Admin: Xóa vĩnh viễn License Key và toàn bộ thiết bị liên quan.
   * Đơn hàng được giữ lại để bảo toàn lịch sử thanh toán.
   */
  async deleteLicenseAdmin(licenseId) {
    const license = await db.prepare('SELECT id, key_value FROM licenses WHERE id = ?').get(licenseId);
    if (!license) return { success: false, status: 404, message: 'Không tìm thấy License Key' };

    const removeLicense = db.transaction(async () => {
      // Giữ lịch sử thanh toán nhưng bỏ tham chiếu để khóa ngoại không chặn xóa Key.
      await db.prepare('UPDATE orders SET target_license_id = NULL WHERE target_license_id = ?').run(licenseId);
      await db.prepare('UPDATE client_users SET license_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE license_id = ?').run(licenseId);
      await db.prepare('DELETE FROM license_devices WHERE license_id = ?').run(licenseId);
      await db.prepare('DELETE FROM licenses WHERE id = ?').run(licenseId);
    });
    await removeLicense();

    return { success: true, key: license.key_value };
  }
}

module.exports = new LicenseService();
