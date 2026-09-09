const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'crm_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class AuthService {
  constructor(database) {
    this.db = database;
  }

  normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
  }

  validateCredentials(username, password) {
    const normalizedUsername = this.normalizeUsername(username);
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedUsername) && normalizedUsername.length <= 254;
    if (!USERNAME_PATTERN.test(normalizedUsername) && !isEmail) {
      throw new AuthError('INVALID_USERNAME', 'Tên đăng nhập phải có 3-32 ký tự: chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
    }
    const passwordText = String(password || '');
    if (passwordText.length < 8 || Buffer.byteLength(passwordText, 'utf8') > 72) {
      throw new AuthError('INVALID_PASSWORD', 'Mật khẩu phải có ít nhất 8 ký tự và không vượt quá 72 byte.');
    }
    return { username: normalizedUsername, password: passwordText };
  }

  register({ username, password }) {
    const credentials = this.validateCredentials(username, password);
    const passwordHash = bcrypt.hashSync(credentials.password, 12);
    try {
      const result = this.db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'STAFF')"
      ).run(credentials.username, passwordHash);
      this.db.prepare("UPDATE users SET company_id=id,company_role='ADMIN' WHERE id=?").run(result.lastInsertRowid);
      return this.publicUser(this.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(result.lastInsertRowid));
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AuthError('USERNAME_TAKEN', 'Tên đăng nhập đã được sử dụng.', 409);
      }
      throw error;
    }
  }

  ensureLocalUser({ username, password }, centralIdentity = null) {
    const credentials = this.validateCredentials(username, password);
    let user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE lower(username)=?').get(credentials.username);
    if (!user) {
      const result = this.db.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'STAFF')")
        .run(credentials.username, bcrypt.hashSync(credentials.password, 12));
      this.db.prepare("UPDATE users SET company_id=id,company_role='ADMIN' WHERE id=?").run(result.lastInsertRowid);
      user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE id=?').get(result.lastInsertRowid);
    } else {
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(credentials.password, 12), user.id);
    }
    if (centralIdentity) {
      const companyId = Number(centralIdentity.company_admin_id || centralIdentity.id || user.id);
      const companyRole = centralIdentity.company_role === 'EMPLOYEE' ? 'EMPLOYEE' : 'ADMIN';
      const previousCompanyId = Number(user.company_id || user.id);
      if (companyRole === 'ADMIN' && previousCompanyId !== companyId) {
        this.db.prepare('UPDATE accounts SET company_id=? WHERE company_id=?').run(companyId, previousCompanyId);
        this.db.prepare('UPDATE users SET company_id=? WHERE company_id=?').run(companyId, previousCompanyId);
      }
      this.db.prepare('UPDATE users SET company_id=?,company_role=? WHERE id=?').run(companyId, companyRole, user.id);
      user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE id=?').get(user.id);
    }
    return this.publicUser(user);
  }

  async registerManaged(input, centralClient) {
    const username = this.normalizeUsername(input.username);
    const payload = { ...input, username };
    const centralIdentity = await centralClient.register(payload);
    return this.ensureLocalUser(payload, centralIdentity);
  }

  async loginManaged(input, centralClient) {
    const username = this.normalizeUsername(input.username);
    const payload = { ...input, username };
    let centralIdentity;
    try {
      centralIdentity = await centralClient.login(payload);
    } catch (error) {
      if (error.code !== 'USER_NOT_FOUND') throw error;
      const local = this.db.prepare('SELECT password_hash FROM users WHERE lower(username)=?').get(username);
      if (!local || !bcrypt.compareSync(String(input.password || ''), local.password_hash)) throw error;
      centralIdentity = await centralClient.register(payload);
      centralIdentity = await centralClient.login(payload);
    }
    const user = this.ensureLocalUser(payload, centralIdentity);
    return { user, ...this.createSession(user.id) };
  }

  async loginGoogleManaged(input, centralClient) {
    const centralIdentity = await centralClient.google(input.credential);
    const username = this.normalizeUsername(centralIdentity.email || centralIdentity.username);
    if (!username) throw new AuthError('INVALID_GOOGLE_ACCOUNT', 'Tài khoản Google không có email hợp lệ.', 401);
    let user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE google_id=? OR email=? COLLATE NOCASE OR lower(username)=? LIMIT 1')
      .get(String(centralIdentity.google_id || ''), username, username);
    if (!user) {
      const passwordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('base64url'), 12);
      const result = this.db.prepare("INSERT INTO users(username,password_hash,role,google_id,email,avatar_url) VALUES (?,?,'STAFF',?,?,?)")
        .run(username, passwordHash, centralIdentity.google_id || null, username, centralIdentity.avatar_url || null);
      this.db.prepare("UPDATE users SET company_id=id,company_role='ADMIN' WHERE id=?").run(result.lastInsertRowid);
      user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE id=?').get(result.lastInsertRowid);
    } else {
      this.db.prepare('UPDATE users SET google_id=COALESCE(google_id,?),email=COALESCE(email,?),avatar_url=COALESCE(?,avatar_url) WHERE id=?')
        .run(centralIdentity.google_id || null, username, centralIdentity.avatar_url || null, user.id);
    }
    const companyId = Number(centralIdentity.company_admin_id || centralIdentity.id || user.id);
    const companyRole = centralIdentity.company_role === 'EMPLOYEE' ? 'EMPLOYEE' : 'ADMIN';
    this.db.prepare('UPDATE users SET company_id=?,company_role=? WHERE id=?').run(companyId, companyRole, user.id);
    user = this.db.prepare('SELECT id,username,role,company_id,company_role FROM users WHERE id=?').get(user.id);
    return { user: this.publicUser(user), ...this.createSession(user.id) };
  }

  login({ username, password }) {
    const normalizedUsername = this.normalizeUsername(username);
    const passwordText = String(password || '');
    const user = this.db.prepare(
      'SELECT id, username, password_hash, role FROM users WHERE lower(username) = ?'
    ).get(normalizedUsername);
    if (!user || !bcrypt.compareSync(passwordText, user.password_hash)) {
      throw new AuthError('INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng.', 401);
    }
    return { user: this.publicUser(user), ...this.createSession(user.id) };
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    this.db.prepare(
      'INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  getUserByToken(token) {
    if (!token) return null;
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    const row = this.db.prepare(`
      SELECT session.id AS session_id, user.id, user.username, user.role, user.company_id, user.company_role
      FROM auth_sessions session
      JOIN users user ON user.id = session.user_id
      WHERE session.token_hash = ? AND session.expires_at > ?
    `).get(hashToken(token), now);
    if (!row) return null;
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.session_id);
    return this.publicUser(row);
  }

  getRequestToken(req) {
    return parseCookies(req.headers.cookie || '')[COOKIE_NAME] || null;
  }

  getRequestUser(req) {
    return this.getUserByToken(this.getRequestToken(req));
  }

  revokeRequestSession(req) {
    const token = this.getRequestToken(req);
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  sessionCookie(token) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  middleware() {
    return (req, res, next) => {
      const user = this.getRequestUser(req);
      if (!user) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Vui lòng đăng nhập để tiếp tục.' });
      }
      req.user = user;
      next();
    };
  }

  publicUser(user) {
    return { id: Number(user.id), username: user.username, role: user.role, company_id: Number(user.company_id || user.id), company_role: user.company_role || 'ADMIN' };
  }
}

module.exports = { AuthService, AuthError, COOKIE_NAME, SESSION_LIFETIME_MS, hashToken, parseCookies };
