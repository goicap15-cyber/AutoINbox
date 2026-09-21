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
        c.status_id, ls.name AS status_name, ls.color AS status_color, r.due_at AS reminder_due_at, r.note AS reminder_note, r.status AS reminder_status, t.unread_manual
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
    // last_activity contains both ISO strings and SQLite CURRENT_TIMESTAMP.
    // julianday normalizes both instead of comparing their string shapes.
    // Chưa đọc luôn nổi đầu danh sách (mới nhất trước); đọc rồi thì quay về
    // đúng vị trí theo thời gian như cũ.
    query += ' ORDER BY CASE WHEN COALESCE(t.is_unread, 0) = 1 OR COALESCE(t.unread_manual, 0) = 1 THEN 0 ELSE 1 END ASC, julianday(t.last_activity) DESC, t.id DESC';
    const rows = this.db.prepare(query).all(...params);

    // Preview kiểu Messenger: khi last_message là placeholder (sidebar sync
    // không bóc được preview trong DOM mới), lấy nội dung tin mới nhất trong
    // DB làm preview thay vì hiện "Chưa có tin nhắn".
    const isPlaceholderPreview = (v) => {
      const s = String(v || '').trim();
      return !s || s === 'Chưa có tin nhắn';
    };
    const needPreview = rows.filter((r) => isPlaceholderPreview(r.last_message));
    if (needPreview.length) {
      const ids = needPreview.map((r) => String(r.id));
      const slots = ids.map(() => '?').join(',');
      const latest = this.db.prepare(`
        SELECT thread_id, content, media_type FROM messages
        WHERE thread_id IN (${slots})
        ORDER BY COALESCE(timestamp_ms, 0) DESC, id DESC
      `).all(...ids);
      const latestByThread = new Map();
      for (const m of latest) {
        if (!latestByThread.has(m.thread_id)) latestByThread.set(m.thread_id, m);
      }
      for (const row of needPreview) {
        const m = latestByThread.get(String(row.id));
        if (!m) continue;
        if (m.media_type && m.media_type !== 'text') {
          const label = { image: 'Ảnh', video: 'Video', voice: 'Voice', file: 'File', call: 'Cuộc gọi' }[m.media_type] || m.media_type;
          row.last_message = `[${label}]`;
        } else if (m.content) {
          row.last_message = m.content;
        }
      }
    }
    return rows;
  }
}

module.exports = new AssignmentManager();
module.exports.AssignmentManager = AssignmentManager;
