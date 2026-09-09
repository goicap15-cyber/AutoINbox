const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '436041288370-9v5egma47gmsbi2pgalj77un535j15r7.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

function credentials(input = {}) {
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) && username.length <= 254;
  if (!USERNAME_PATTERN.test(username) && !isEmail) return { error: 'INVALID_USERNAME', message: 'Tên đăng nhập hoặc email không hợp lệ.' };
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return { error: 'INVALID_PASSWORD', message: 'Mật khẩu phải có 8-72 ký tự.' };
  return { username, password };
}

function publicUser(row) {
  return row && { id: row.id, username: row.username, google_id: row.google_id || null, email: row.email || null, avatar_url: row.avatar_url || null, status: row.status, created_at: row.created_at, last_login_at: row.last_login_at, last_machine_id: row.last_machine_id, company_role: row.company_role || 'ADMIN', company_admin_id: row.company_admin_id || row.id };
}

async function loginGoogle(input = {}) {
  const credential = String(input.credential || '');
  if (!credential) return { success: false, status: 400, code: 'GOOGLE_CREDENTIAL_REQUIRED', message: 'Thiếu thông tin xác thực Google.' };

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (_) {
    return { success: false, status: 401, code: 'INVALID_GOOGLE_TOKEN', message: 'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn.' };
  }
  if (!payload?.sub || !payload?.email || payload.email_verified !== true) {
    return { success: false, status: 401, code: 'GOOGLE_EMAIL_NOT_VERIFIED', message: 'Email Google chưa được xác minh.' };
  }

  const email = String(payload.email).trim().toLowerCase();
  let row = await db.prepare('SELECT * FROM client_users WHERE google_id=? OR email=? OR username=? LIMIT 1')
    .get(String(payload.sub), email, email);
  if (row?.status === 'BLOCKED') return { success: false, status: 403, code: 'ACCOUNT_BLOCKED', message: 'Tài khoản đã bị quản trị viên khóa.' };

  if (!row) {
    const randomPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('base64url'), 12);
    const result = await db.prepare("INSERT INTO client_users(username,password_hash,status,google_id,email,avatar_url) VALUES (?,?,'ACTIVE',?,?,?)")
      .run(email, randomPasswordHash, String(payload.sub), email, payload.picture || null);
    row = await db.prepare('SELECT * FROM client_users WHERE id=?').get(result.lastInsertRowid);
  } else {
    await db.prepare('UPDATE client_users SET google_id=COALESCE(google_id,?),email=COALESCE(email,?),avatar_url=?,last_login_at=CURRENT_TIMESTAMP,last_machine_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(String(payload.sub), email, payload.picture || row.avatar_url || null, String(input.machineId || '').slice(0, 200) || null, row.id);
    row = await db.prepare('SELECT * FROM client_users WHERE id=?').get(row.id);
  }
  return { success: true, data: publicUser(row) };
}

async function createCompanyEmployee({ adminUsername, username, password }) {
  const admin = await db.prepare("SELECT id,license_id FROM client_users WHERE username=? AND company_role='ADMIN'").get(String(adminUsername || '').trim());
  if (!admin?.license_id) return { success: false, status: 403, code: 'ADMIN_PACKAGE_REQUIRED', message: 'Admin doanh nghiệp chưa có gói License.' };
  const value = credentials({ username, password });
  if (value.error) return { success: false, status: 400, code: value.error, message: value.message };
  try {
    const result = await db.prepare("INSERT INTO client_users(username,password_hash,status,license_id,company_admin_id,company_role) VALUES (?,?,'ACTIVE',?,?,'EMPLOYEE')")
      .run(value.username, bcrypt.hashSync(value.password, 12), admin.license_id, admin.id);
    return { success: true, data: publicUser(await db.prepare('SELECT * FROM client_users WHERE id=?').get(result.lastInsertRowid)) };
  } catch (error) {
    if (['ER_DUP_ENTRY','ER_DUP_KEY'].includes(String(error.code || ''))) return { success: false, status: 409, code: 'USERNAME_TAKEN', message: 'Tên đăng nhập đã được sử dụng.' };
    throw error;
  }
}

async function removeCompanyEmployee({ adminUsername, username }) {
  const admin = await db.prepare("SELECT id FROM client_users WHERE username=? AND company_role='ADMIN'").get(String(adminUsername || '').trim());
  if (!admin) return { success: false, status: 403, message: 'Không có quyền quản lý doanh nghiệp.' };
  const result = await db.prepare("DELETE FROM client_users WHERE username=? AND company_admin_id=? AND company_role='EMPLOYEE'")
    .run(String(username || '').trim(), admin.id);
  return result.changes ? { success: true } : { success: false, status: 404, message: 'Không tìm thấy nhân viên.' };
}

async function register(input) {
  const value = credentials(input);
  if (value.error) return { success: false, status: 400, code: value.error, message: value.message };
  try {
    const result = await db.prepare("INSERT INTO client_users (username,password_hash,status,email) VALUES (?,?,'ACTIVE',?)")
      .run(value.username, bcrypt.hashSync(value.password, 12), input.email || null);
    return { success: true, data: publicUser(await db.prepare('SELECT * FROM client_users WHERE id=?').get(result.lastInsertRowid)) };
  } catch (error) {
    if (['ER_DUP_ENTRY','ER_DUP_KEY'].includes(String(error.code || ''))) return { success: false, status: 409, code: 'USERNAME_TAKEN', message: 'Tên đăng nhập đã được sử dụng.' };
    throw error;
  }
}

async function login(input) {
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  const row = await db.prepare('SELECT * FROM client_users WHERE username=? OR email=?').get(username, username);
  if (!row) return { success: false, status: 404, code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại.' };
  if (!bcrypt.compareSync(password, row.password_hash)) return { success: false, status: 401, code: 'INVALID_CREDENTIALS', message: 'Tên đăng nhập hoặc mật khẩu không đúng.' };
  if (row.status === 'BLOCKED') return { success: false, status: 403, code: 'ACCOUNT_BLOCKED', message: 'Tài khoản đã bị quản trị viên khóa.' };
  await db.prepare('UPDATE client_users SET last_login_at=CURRENT_TIMESTAMP,last_machine_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(input.machineId || '').slice(0, 200) || null, row.id);
  return { success: true, data: publicUser(await db.prepare('SELECT * FROM client_users WHERE id=?').get(row.id)) };
}

async function list() {
  return await db.prepare(`
    SELECT u.id,u.username,u.status,u.created_at,u.last_login_at,u.last_machine_id,u.updated_at,
      COALESCE(u.company_role, 'ADMIN') AS company_role,
      u.company_admin_id,
      l.key_value AS license_key,l.company_name,l.months AS package_months,l.expires_at AS package_expires_at,
      CASE WHEN l.id IS NOT NULL AND l.is_active=1 AND l.expires_at>NOW() THEN 'ACTIVE' ELSE 'NONE' END AS package_status,
      COUNT(e.id) AS member_count,
      GROUP_CONCAT(e.username SEPARATOR ', ') AS member_usernames
    FROM client_users u
    LEFT JOIN licenses l ON l.id=u.license_id
    LEFT JOIN client_users e
      ON e.company_admin_id = u.id
     AND COALESCE(e.company_role, 'ADMIN') = 'EMPLOYEE'
    WHERE COALESCE(u.company_role, 'ADMIN') = 'ADMIN'
    GROUP BY
      u.id,u.username,u.status,u.created_at,u.last_login_at,u.last_machine_id,u.updated_at,
      u.company_role,u.company_admin_id,
      l.key_value,l.company_name,l.months,l.expires_at,l.id,l.is_active
    ORDER BY u.id DESC
  `).all();
}

async function bindLicense(username, key) {
  const license = await db.prepare('SELECT id FROM licenses WHERE key_value=? AND is_active=1').get(String(key || '').trim());
  if (!license) return false;
  return await db.prepare('UPDATE client_users SET license_id=?,updated_at=CURRENT_TIMESTAMP WHERE username=?')
    .run(license.id, String(username || '').trim()).changes > 0;
}

async function licenseStatus({ username, key, machineId }) {
  const row = await db.prepare(`SELECT l.id AS license_id, l.key_value, l.expires_at, l.machines, l.is_active
    FROM client_users u LEFT JOIN licenses l ON l.id=u.license_id
    WHERE u.username=?`).get(String(username || '').trim());
  if (!row?.key_value) return { valid: false, reason: 'NO_PACKAGE', message: 'Tài khoản chưa có gói License.' };
  
  const providedKey = String(key || '').trim();
  if (providedKey && row.key_value !== providedKey) {
    return { valid: false, reason: 'WRONG_ACCOUNT_LICENSE', message: 'License trên máy không thuộc tài khoản này.' };
  }
  
  if (!row.is_active || new Date(row.expires_at) <= new Date()) {
    return { valid: false, reason: 'EXPIRED', message: 'Gói License đã hết hạn.' };
  }

  const mId = String(machineId || '').trim();
  if (mId) {
    const device = await db.prepare('SELECT id FROM license_devices WHERE license_id=? AND machine_id=?')
      .get(row.license_id, mId);
    if (!device) {
      const registeredCount = (await db.prepare('SELECT COUNT(*) AS total FROM license_devices WHERE license_id=?').get(row.license_id))?.total || 0;
      if (registeredCount < (row.machines || 1)) {
        try {
          await db.prepare('INSERT INTO license_devices (license_id, machine_id, device_name) VALUES (?, ?, ?)')
            .run(row.license_id, mId, 'Máy CRM (' + String(username || '') + ')');
        } catch (e) {}
      } else {
        return { valid: false, reason: 'MAX_DEVICES_REACHED', message: `Gói đã đạt giới hạn tối đa ${row.machines} thiết bị sử dụng.` };
      }
    }
  }

  return { valid: true, key: row.key_value, expiresAt: row.expires_at, machines: row.machines, daysRemaining: Math.ceil((new Date(row.expires_at)-Date.now())/86400000) };
}

async function accountStatus({ username }) {
  const target = String(username || '').trim();
  const row = await db.prepare('SELECT id,username,status FROM client_users WHERE username=? OR email=?')
    .get(target, target);
  if (!row) return { success: false, status: 404, code: 'USER_NOT_FOUND', message: 'Tài khoản không còn tồn tại.' };
  if (row.status !== 'ACTIVE') return { success: false, status: 403, code: 'ACCOUNT_BLOCKED', message: 'Tài khoản đã bị khóa.' };
  return { success: true, data: publicUser(row) };
}

async function setStatus(id, status) {
  const normalized = String(status || '').toUpperCase();
  if (!['ACTIVE', 'BLOCKED'].includes(normalized)) return { success: false, status: 400, message: 'Trạng thái không hợp lệ.' };
  const result = await db.prepare('UPDATE client_users SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(normalized, Number(id));
  if (!result.changes) return { success: false, status: 404, message: 'Không tìm thấy tài khoản.' };
  return { success: true, data: publicUser(await db.prepare('SELECT * FROM client_users WHERE id=?').get(Number(id))) };
}

async function resetPassword(id, password) {
  const text = String(password || '');
  if (text.length < 8 || Buffer.byteLength(text, 'utf8') > 72) return { success: false, status: 400, message: 'Mật khẩu phải có 8-72 ký tự.' };
  const result = await db.prepare('UPDATE client_users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(bcrypt.hashSync(text, 12), Number(id));
  if (!result.changes) return { success: false, status: 404, message: 'Không tìm thấy tài khoản.' };
  return { success: true };
}

async function resetPasswordByOtp(input = {}) {
  const email = String(input.email || input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, status: 400, code: 'INVALID_EMAIL', message: 'Vui lòng nhập địa chỉ Gmail hợp lệ.' };
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return { success: false, status: 400, code: 'INVALID_PASSWORD', message: 'Mật khẩu phải có từ 8 đến 72 ký tự.' };
  }
  const row = await db.prepare('SELECT * FROM client_users WHERE email=? OR username=?').get(email, email);
  if (!row) {
    return { success: false, status: 404, code: 'USER_NOT_FOUND', message: 'Email này chưa được đăng ký trong hệ thống.' };
  }
  const hash = bcrypt.hashSync(password, 12);
  await db.prepare('UPDATE client_users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hash, row.id);
  return { success: true, message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.' };
}

async function remove(id) {
  const result = await db.prepare('DELETE FROM client_users WHERE id=?').run(Number(id));
  if (!result.changes) return { success: false, status: 404, message: 'Không tìm thấy tài khoản.' };
  return { success: true, deleted: result.changes };
}

async function removeAll() {
  const result = await db.prepare('DELETE FROM client_users').run();
  return { success: true, deleted: result.changes };
}

module.exports = { register, login, loginGoogle, list, accountStatus, createCompanyEmployee, removeCompanyEmployee, setStatus, resetPassword, resetPasswordByOtp, remove, removeAll, bindLicense, licenseStatus };

