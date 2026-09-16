/**
 * AutoReplyEngine.js
 * Tự động trả lời theo từ khóa kích hoạt (trigger keyword).
 * Hỗ trợ biến cá nhân hóa: {ten_khach_hang}, {account_name}
 */
const db = require('../database/db');

class AutoReplyEngine {
  /**
   * Kiểm tra và gửi auto-reply nếu nội dung tin nhắn khớp từ khóa.
   * @param {object} msg - Tin nh?n v?a nh?n ???c
   * @param {function} sendFn - Hàm gửi tin nhắn: sendFn(thread_id, text)
   * @returns {boolean} true nếu đã tự động trả lời
   */
  async processIncoming(msg, sendFn) {
    if (msg.is_outgoing) return false;
    if (!msg.content) return false;

    // Kiểm tra AI không đang bị tạm dừng
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(msg.thread_id);
    if (!thread) return false;

    const now = new Date();
    if (thread.ai_paused_until && new Date(thread.ai_paused_until) > now) {
      console.log(`[AutoReply] Thread ${msg.thread_id} - AI t?m d?ng ??n ${thread.ai_paused_until}`);
      return false;
    }

    // Lấy tất cả auto-replies đang active cho tài khoản này
    const rules = db.prepare(`
      SELECT * FROM auto_replies
      WHERE account_id = ? AND is_active = 1
    `).all(thread.account_id);

    const lowerContent = msg.content.toLowerCase().trim();

    for (const rule of rules) {
      const keyword = rule.trigger_keyword.toLowerCase().trim();
      if (lowerContent.includes(keyword)) {
        // Cá nhân hóa template
        const response = this._interpolate(rule.response_template, {
          ten_khach_hang: thread.contact_name || 'b?n',
          account_name: thread.account_id,
          keyword: rule.trigger_keyword
        });

        console.log(`[AutoReply] Matched keyword "${rule.trigger_keyword}" ? g?i t? ??ng cho thread ${msg.thread_id}`);
        await sendFn(msg.thread_id, response);
        return true;
      }
    }

    return false;
  }

  /**
   * Thay thế các biến trong template: {ten_khach_hang} → tên thật
   */
  _interpolate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || `{${key}}`);
  }

  // ── CRUD Quản lý quy tắc Auto Reply ──

  /** T?o quy t?c m?i */
  createRule({ account_id, trigger_keyword, response_template, created_by_staff_id = null }) {
    const info = db.prepare(`
      INSERT INTO auto_replies (account_id, trigger_keyword, response_template, created_by_staff_id)
      VALUES (?, ?, ?, ?)
    `).run(account_id, trigger_keyword, response_template, created_by_staff_id);
    return { id: info.lastInsertRowid, success: true };
  }

  /** Lấy tất cả quy tắc của một tài khoản */
  getRules(account_id) {
    return db.prepare('SELECT * FROM auto_replies WHERE account_id = ? ORDER BY id DESC').all(account_id);
  }

  /** Cập nhật trạng thái kích hoạt */
  toggleRule(id, is_active) {
    db.prepare('UPDATE auto_replies SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
    return { success: true };
  }

  /** Xóa quy tắc */
  deleteRule(id) {
    db.prepare('DELETE FROM auto_replies WHERE id = ?').run(id);
    return { success: true };
  }
}

module.exports = new AutoReplyEngine();
