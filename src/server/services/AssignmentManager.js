const db = require('../database/db');

class AssignmentManager {
  constructor(database = db) {
    this.db = database;
  }

  // Gán nhân viên phụ trách độc quyền cho một hội thoại
  assignThread(threadId, userId) {
    const thread = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
    if (!thread) {
      return { success: false, error: 'Không tìm thấy hội thoại' };
    }

    if (thread.assigned_user_id && thread.assigned_user_id !== userId) {
      const current = this.db.prepare('SELECT username FROM users WHERE id = ?').get(thread.assigned_user_id);
      return {
        success: false,
        error: `Hội thoại đã được phân công cho nhân viên: ${current?.username}`
      };
    }

    this.db.prepare(`
      UPDATE threads
      SET assigned_user_id = ?, status = 'ASSIGNED'
      WHERE id = ?
    `).run(userId, threadId);

    return { success: true, thread_id: threadId, assigned_user_id: userId };
  }

  // Nhân viên hoàn thành hội thoại (đánh dấu Đã chốt)
  completeThread(threadId) {
    this.db.prepare(`
      UPDATE threads SET status = 'COMPLETED' WHERE id = ?
    `).run(threadId);
    return { success: true, thread_id: threadId, status: 'COMPLETED' };
  }

  // Lấy danh sách hội thoại theo tab/filter
  getThreadsByFilter(userId, role, tab = 'ALL', sourceFilter = 'all', companyId = userId, companyRole = 'EMPLOYEE', username = '') {
    let query = `
      SELECT t.*, c.nickname, c.phone, c.email, c.address, c.tags, c.lead_captured, c.avatar_url,
        s.source_type, s.display_name AS source_name, s.status AS source_status, s.external_id AS source_external_id,
        c.status_id, ls.name AS status_name, ls.color AS status_color, r.due_at AS reminder_due_at, r.note AS reminder_note, r.status AS reminder_status
      FROM threads t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN contacts c ON c.thread_id = t.id
      LEFT JOIN inbox_sources s ON s.id = t.source_id
      LEFT JOIN lead_statuses ls ON ls.id = c.status_id
      LEFT JOIN conversation_reminders r ON r.thread_id = t.id AND r.status = 'active'
    `;
    const params = [];
    const where = [];

    if (role !== 'ADMIN') {
      where.push('a.company_id = ?');
      params.push(companyId);
      if (companyRole !== 'ADMIN') {
        where.push('EXISTS (SELECT 1 FROM account_user_assignments aua WHERE aua.account_id=a.id AND aua.user_id=?)');
        params.push(userId);
      }
    }

    if (tab === 'WAITING') {
      where.push("COALESCE(t.inbox_folder, 'INBOX') IN ('MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE')");
      where.push('t.archived_at IS NULL');
    } else {
      // Every normal CRM view is the accepted inbox only. Message requests
      // remain exclusively in WAITING until an outgoing reply promotes them.
      where.push("COALESCE(t.inbox_folder, 'INBOX') = 'INBOX'");
      if (tab === 'ASSIGNED') {
        where.push('t.status = ? AND t.assigned_user_id = ?');
        params.push('ASSIGNED', userId);
      } else if (tab === 'UNPROCESSED') {
        where.push('t.status = ?');
        params.push('UNPROCESSED');
      } else if (tab === 'COMPLETED') {
        where.push('t.status = ?');
        params.push('COMPLETED');
      } else if (companyRole !== 'ADMIN' && role !== 'ADMIN') {
        // Tab ALL: staff chỉ thấy thread của mình + chưa xử lý; admin thấy tất cả
        where.push('(t.assigned_user_id = ? OR t.status = ?)');
        params.push(userId, 'UNPROCESSED');
      }
    }

    if (sourceFilter && sourceFilter !== 'all' && sourceFilter !== 'ALL') {
      if (sourceFilter === 'personal_messenger' || sourceFilter === 'page_messenger') {
        where.push('s.source_type = ?');
        params.push(sourceFilter);
      } else {
        where.push('t.source_id = ?');
        params.push(sourceFilter);
      }
    }

    if (where.length) query += ' WHERE ' + where.join(' AND ');
    query += ' ORDER BY t.last_activity DESC';
    return this.db.prepare(query).all(...params);
  }
}

module.exports = new AssignmentManager();
module.exports.AssignmentManager = AssignmentManager;
