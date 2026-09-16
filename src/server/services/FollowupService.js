class FollowupService {
  constructor(database) {
    this.db = database;
  }

  ensureThread(threadId) {
    if (!this.db.prepare('SELECT id FROM threads WHERE id = ?').get(String(threadId))) {
      const error = new Error('Không tìm thấy hội thoại.');
      error.statusCode = 404;
      throw error;
    }
  }

  setReminder(threadId, dueAtValue, noteValue, now = Date.now()) {
    const dueAt = new Date(dueAtValue);
    const note = String(noteValue || '').trim();
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= now) {
      const error = new Error('Th?i ?i?m nh?c ph?i ? t??ng lai.');
      error.statusCode = 400;
      throw error;
    }
    if (note.length > 200) {
      const error = new Error('Ghi chú nhắc tối đa 200 ký tự.');
      error.statusCode = 400;
      throw error;
    }
    this.ensureThread(threadId);
    this.db.prepare(`INSERT INTO conversation_reminders (thread_id, due_at, note, status, updated_at)
      VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON CONFLICT(thread_id) DO UPDATE SET
        due_at=excluded.due_at, note=excluded.note, status='active', updated_at=CURRENT_TIMESTAMP`)
      .run(String(threadId), dueAt.toISOString(), note || null);
    return this.db.prepare(`SELECT thread_id, due_at, note, status
      FROM conversation_reminders WHERE thread_id = ? AND status = 'active'`).get(String(threadId));
  }

  closeReminder(threadId, status) {
    const result = this.db.prepare(`UPDATE conversation_reminders
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE thread_id = ? AND status = 'active'`).run(status, String(threadId));
    if (!result.changes) {
      const error = new Error('Không có nhắc đang hoạt động.');
      error.statusCode = 404;
      throw error;
    }
    return { success: true };
  }

  completeReminder(threadId) { return this.closeReminder(threadId, 'completed'); }
  cancelReminder(threadId) { return this.closeReminder(threadId, 'cancelled'); }

  archive(threadId) {
    this.ensureThread(threadId);
    this.db.prepare('UPDATE threads SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(threadId));
    return this.db.prepare('SELECT archived_at FROM threads WHERE id = ?').get(String(threadId));
  }

  restore(threadId) {
    this.ensureThread(threadId);
    this.db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ?').run(String(threadId));
    return { archived_at: null };
  }

  restoreOnIncoming(threadId) {
    return this.db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
      .run(String(threadId)).changes > 0;
  }
}

module.exports = FollowupService;
