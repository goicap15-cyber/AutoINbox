const bcrypt = require('bcryptjs');
const db = require('../database/db');

class EnterpriseAccessService {
  constructor(database = db) { this.db = database; }

  isCompanyAdmin(user) { return user?.company_role === 'ADMIN'; }

  canAccessAccount(user, accountId) {
    if (!user || !accountId) return false;
    if (user.role === 'ADMIN') return true;
    if (this.isCompanyAdmin(user)) {
      return Boolean(this.db.prepare('SELECT 1 FROM accounts WHERE id=? AND company_id=?').get(String(accountId), user.company_id));
    }
    return Boolean(this.db.prepare(`
      SELECT 1 FROM account_user_assignments x JOIN accounts a ON a.id=x.account_id
      WHERE x.account_id=? AND x.user_id=? AND a.company_id=?
    `).get(String(accountId), user.id, user.company_id));
  }

  canAccessThread(user, threadId) {
    const row = this.db.prepare('SELECT account_id FROM threads WHERE id=?').get(String(threadId));
    return Boolean(row && this.canAccessAccount(user, row.account_id));
  }

  listAccounts(user) {
    if (user.role === 'ADMIN') return this.db.prepare('SELECT * FROM accounts').all();
    if (this.isCompanyAdmin(user)) return this.db.prepare('SELECT * FROM accounts WHERE company_id=?').all(user.company_id);
    return this.db.prepare(`SELECT a.* FROM accounts a JOIN account_user_assignments x ON x.account_id=a.id
      WHERE x.user_id=? AND a.company_id=? ORDER BY a.created_at`).all(user.id, user.company_id);
  }

  listEmployees(admin) {
    return this.db.prepare(`SELECT id,username,company_role,created_at FROM users
      WHERE company_id=? AND id<>? AND company_role='EMPLOYEE' ORDER BY created_at DESC`).all(admin.company_id, admin.id);
  }

  createEmployee(admin, { username, password }) {
    const normalized = String(username || '').trim().toLowerCase();
    const secret = String(password || '');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(normalized)) throw Object.assign(new Error('Tên đăng nhập không hợp lệ.'), { status: 400 });
    if (secret.length < 8 || Buffer.byteLength(secret, 'utf8') > 72) throw Object.assign(new Error('Mật khẩu phải có 8-72 ký tự.'), { status: 400 });
    try {
      const result = this.db.prepare(`INSERT INTO users(username,password_hash,role,company_id,company_role)
        VALUES (?,?,'STAFF',?,'EMPLOYEE')`).run(normalized, bcrypt.hashSync(secret, 12), admin.company_id);
      return this.db.prepare('SELECT id,username,company_role,created_at FROM users WHERE id=?').get(result.lastInsertRowid);
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw Object.assign(new Error('Tên đăng nhập đã tồn tại.'), { status: 409 });
      throw error;
    }
  }

  deleteEmployee(admin, employeeId) {
    return this.db.prepare("DELETE FROM users WHERE id=? AND company_id=? AND company_role='EMPLOYEE'").run(Number(employeeId), admin.company_id).changes > 0;
  }

  setAssignments(admin, employeeId, accountIds = []) {
    const employee = this.db.prepare("SELECT id FROM users WHERE id=? AND company_id=? AND company_role='EMPLOYEE'").get(Number(employeeId), admin.company_id);
    if (!employee) throw Object.assign(new Error('Không tìm thấy nhân viên trong công ty.'), { status: 404 });
    const allowed = new Set(this.db.prepare('SELECT id FROM accounts WHERE company_id=?').all(admin.company_id).map(row => String(row.id)));
    const selected = [...new Set(accountIds.map(String))];
    if (selected.some(id => !allowed.has(id))) throw Object.assign(new Error('Có tài khoản Facebook không thuộc công ty.'), { status: 403 });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM account_user_assignments WHERE user_id=?').run(employee.id);
      const insert = this.db.prepare('INSERT INTO account_user_assignments(account_id,user_id,assigned_by) VALUES (?,?,?)');
      selected.forEach(id => insert.run(id, employee.id, admin.id));
    })();
    return selected;
  }

  assignmentMap(companyId) {
    const rows = this.db.prepare(`SELECT x.user_id,x.account_id FROM account_user_assignments x
      JOIN accounts a ON a.id=x.account_id WHERE a.company_id=?`).all(companyId);
    return rows.reduce((map, row) => { (map[row.user_id] ||= []).push(String(row.account_id)); return map; }, {});
  }
}

module.exports = new EnterpriseAccessService();
module.exports.EnterpriseAccessService = EnterpriseAccessService;
