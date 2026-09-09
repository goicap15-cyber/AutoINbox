const crypto = require('crypto');
const nodemailer = require('nodemailer');

const pendingOtps = new Map();
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function normalizeGmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/.test(email) ? email : null;
}

function digest(email, otp) {
  return crypto.createHash('sha256').update(`${email}:${otp}`).digest();
}

async function send(emailInput) {
  const email = normalizeGmail(emailInput);
  if (!email) return { success: false, status: 400, code: 'INVALID_GMAIL', message: 'Vui lòng nhập địa chỉ @gmail.com hợp lệ.' };
  const previous = pendingOtps.get(email);
  if (previous && Date.now() - previous.sentAt < RESEND_COOLDOWN_MS) {
    return { success: false, status: 429, code: 'OTP_COOLDOWN', message: 'Vui lòng chờ 60 giây trước khi gửi lại mã.' };
  }
  const user = String(process.env.GMAIL_USER || '').trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) {
    const error = new Error('Máy chủ chưa cấu hình Gmail gửi OTP.');
    error.code = 'OTP_MAIL_NOT_CONFIGURED';
    throw error;
  }
  const otp = String(crypto.randomInt(100000, 1000000));
  const mailer = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await mailer.sendMail({
    from: `MISSPRICE CRM <${user}>`, to: email,
    subject: 'Mã xác minh đăng ký MISSPRICE CRM',
    text: `Mã OTP của bạn là ${otp}. Mã có hiệu lực trong 5 phút.`,
    html: `<div style="font-family:Arial,sans-serif"><h2>MISSPRICE CRM</h2><p>Mã xác minh đăng ký:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${otp}</p><p>Mã có hiệu lực trong 5 phút. Không cung cấp mã này cho người khác.</p></div>`
  });
  pendingOtps.set(email, { hash: digest(email, otp), expiresAt: Date.now() + OTP_TTL_MS, sentAt: Date.now(), attempts: 0 });
  return { success: true, data: { email, expires_in: 300, resend_after: 60 } };
}

function verify(emailInput, otpInput, consume = false) {
  const email = normalizeGmail(emailInput);
  const record = email ? pendingOtps.get(email) : null;
  if (!record) return { success: false, status: 400, code: 'OTP_NOT_REQUESTED', message: 'Vui lòng gửi mã OTP trước.' };
  if (Date.now() > record.expiresAt) {
    pendingOtps.delete(email);
    return { success: false, status: 400, code: 'OTP_EXPIRED', message: 'Mã OTP đã hết hạn. Vui lòng gửi mã mới.' };
  }
  if (record.attempts >= 5) {
    pendingOtps.delete(email);
    return { success: false, status: 429, code: 'OTP_TOO_MANY_ATTEMPTS', message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng gửi mã mới.' };
  }
  const actual = digest(email, String(otpInput || '').trim());
  if (!crypto.timingSafeEqual(actual, record.hash)) {
    record.attempts += 1;
    return { success: false, status: 400, code: 'OTP_INVALID', message: 'Mã OTP không chính xác.' };
  }
  if (consume) pendingOtps.delete(email);
  return { success: true, email };
}

module.exports = { send, verify, normalizeGmail };
