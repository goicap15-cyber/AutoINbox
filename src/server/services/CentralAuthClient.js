const { getMachineId } = require('../utils/machineId');

class CentralAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class CentralAuthClient {
  constructor(baseUrl = process.env.LICENSE_SERVER_URL || 'https://genblackmmoonline.online/license_server') {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
  }

  async request(path, credentials) {
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credentials, machineId: getMachineId() })
      });
    } catch (error) {
      throw new CentralAuthError('CENTRAL_AUTH_UNAVAILABLE', 'Không thể kết nối máy chủ tài khoản.', 503);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) throw new CentralAuthError(body.code || 'CENTRAL_AUTH_FAILED', body.message || 'Máy chủ tài khoản từ chối yêu cầu.', response.status);
    return body.data;
  }

  register(credentials) { return this.request('/api/client-auth/register', credentials); }
  requestRegistrationOtp(email) { return this.request('/api/client-auth/register-otp', { email }); }
  requestResetPasswordOtp(email) { return this.request('/api/client-auth/reset-password-otp', { email }); }
  resetPassword(data) { return this.request('/api/client-auth/reset-password', data); }
  login(credentials) { return this.request('/api/client-auth/login', credentials); }
  google(credential) { return this.request('/api/client-auth/google', { credential }); }
  accountStatus(username) { return this.request('/api/client-auth/account-status', { username }); }
}

module.exports = { CentralAuthClient, CentralAuthError };
