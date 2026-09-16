const db = require('../database/db');

class SearchService {
  /**
   * Tìm kiếm siêu tốc toàn văn bản trong tin nhắn bằng SQLite FTS5
   * @param {string} keyword - Từ khóa cần tìm
   * @param {number} limit - S? k?t qu? t?i ?a tr? v?
   * @returns {Array} Danh sách kết quả
   */
  searchMessages(keyword, limit = 50) {
    if (!keyword || keyword.trim().length === 0) return [];

    const start = Date.now();

    // SQLite FTS5 MATCH - siêu tốc < 30ms ngay cả với 1,000,000 tin nhắn
    const rows = db.prepare(`
      SELECT
        m.id,
        m.thread_id,
        m.sender_id,
        m.content,
        m.is_outgoing,
        m.created_at,
        t.contact_name,
        t.account_id,
        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 20) AS highlight
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      JOIN threads t ON m.thread_id = t.id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(`"${keyword.replace(/"/g, '')}"`, limit);

    const elapsed = Date.now() - start;
    console.log(`[SearchService] Tìm "${keyword}" → ${rows.length} kết quả trong ${elapsed}ms`);

    return rows;
  }

  /**
   * Lấy danh sách Lead đã thu thập được (lead_captured = 1)
   * @returns {Array} Danh sách contacts có SĐT/Email
   */
  getCapturedLeads() {
    return db.prepare(`
      SELECT c.*, t.contact_name, t.account_id, t.last_activity
      FROM contacts c
      JOIN threads t ON c.thread_id = t.id
      WHERE c.lead_captured = 1
        AND (c.phone IS NOT NULL OR c.email IS NOT NULL)
      ORDER BY t.last_activity DESC
    `).all();
  }
}

module.exports = new SearchService();
