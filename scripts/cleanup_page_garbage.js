const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { cleanContactName } = require('../src/server/utils/textFilter');

/**
 * executeCleanup
 * An toàn dọn rác UNKNOWN_THREAD, xóa tin nhắn test cũ kẹp giữa, renumber sequence và chuẩn hóa tên khách hàng trên DB.
 * @param {Object} options
 * @param {string} [options.dbPath]
 * @param {boolean} [options.apply]
 * @returns {Object} Report
 */
function executeCleanup({ dbPath, apply = false } = {}) {
  const targetDbPath = dbPath || path.join(__dirname, '../data/database.db');
  if (!fs.existsSync(targetDbPath)) {
    throw new Error(`Database file not found at: ${targetDbPath}`);
  }

  const db = new Database(targetDbPath);
  let backupPath = null;

  try {
    if (apply) {
      backupPath = path.join(path.dirname(targetDbPath), `backup_database_${Date.now()}.db`);
      // Tạo bản sao snapshot tương thích SQLite WAL hoàn chỉnh và an toàn
      db.prepare('VACUUM INTO ?').run(backupPath);
    }

    // 1. Tìm thread rác UNKNOWN_THREAD
    const garbageThreads = db.prepare("SELECT id FROM threads WHERE id = 'UNKNOWN_THREAD' OR id LIKE '%UNKNOWN_THREAD%'").all();
    const garbageThreadIds = garbageThreads.map((t) => t.id);

    let deletedMessagesCount = 0;
    if (garbageThreadIds.length > 0) {
      const placeholders = garbageThreadIds.map(() => '?').join(',');
      const msgRow = db.prepare(`SELECT count(*) as c FROM messages WHERE thread_id IN (${placeholders})`).get(...garbageThreadIds);
      deletedMessagesCount = msgRow ? msgRow.c : 0;
    }

    const deletedThreadsCount = garbageThreadIds.length;

    // 2. Tìm tin nhắn test cũ (ví dụ spec 038 / 040 Claude test) bị kẹp vào thread thật
    let testMsgs = [];
    try {
      testMsgs = db.prepare(`
        SELECT id, thread_id FROM messages
        WHERE content LIKE '%(Claude test)%'
           OR content LIKE '%spec 038%'
           OR content LIKE '%spec 040%'
           OR content LIKE '%đây là test, chưa thật%'
           OR content LIKE '%test để gửi thử%'
           OR (thread_id = '100092115712908' AND id BETWEEN 872 AND 896)
      `).all();
    } catch (e) {
      testMsgs = [];
    }
    const testMsgIds = testMsgs.map((m) => m.id);
    const deletedTestMessagesCount = testMsgIds.length;
    const threadsWithDeletions = new Set(testMsgs.map((m) => m.thread_id));

    // 3. Tìm tên liên hệ cần chuẩn hóa
    const allThreads = db.prepare('SELECT id, contact_name FROM threads').all();
    const threadsToClean = [];
    for (const thread of allThreads) {
      if (garbageThreadIds.includes(thread.id)) continue;
      const cleaned = cleanContactName(thread.contact_name);
      if (cleaned !== thread.contact_name) {
        threadsToClean.push({ id: thread.id, oldName: thread.contact_name, newName: cleaned });
      }
    }
    const cleanedContactNamesCount = threadsToClean.length;

    // 4. Chuẩn bị danh sách renumber sequence cho các thread bị ảnh hưởng
    const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
    const hasSeq = msgCols.includes('sequence_order');
    const hasTs = msgCols.includes('timestamp_ms');
    let renumberedThreadsCount = 0;

    if (apply) {
      const cleanupTx = db.transaction(() => {
        // Xóa tin nhắn test cũ
        if (testMsgIds.length > 0) {
          const placeholders = testMsgIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...testMsgIds);
        }

        // Xóa thread rác UNKNOWN_THREAD và tin nhắn của nó
        if (garbageThreadIds.length > 0) {
          const placeholders = garbageThreadIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM messages WHERE thread_id IN (${placeholders})`).run(...garbageThreadIds);
          db.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...garbageThreadIds);
        }

        // Chuẩn hóa tên liên hệ
        const updateNameStmt = db.prepare("UPDATE threads SET contact_name = ?, sync_status = 'NEEDS_RESYNC' WHERE id = ?");
        for (const item of threadsToClean) {
          updateNameStmt.run(item.newName, item.id);
        }

        // Renumber sequence 1..N cho các thread bị kẹp tin test nếu cột tồn tại
        if (hasSeq) {
          const updateSeqStmt = db.prepare('UPDATE messages SET sequence_order = ? WHERE id = ?');
          const setThreadResyncStmt = db.prepare("UPDATE threads SET sync_status = 'NEEDS_RESYNC' WHERE id = ?");
          const orderBy = hasTs ? 'ORDER BY COALESCE(timestamp_ms, id) ASC, id ASC' : 'ORDER BY id ASC';

          for (const threadId of threadsWithDeletions) {
            if (garbageThreadIds.includes(threadId)) continue;
            const remaining = db.prepare(`
              SELECT id FROM messages
              WHERE thread_id = ?
              ${orderBy}
            `).all(threadId);

            remaining.forEach((m, idx) => {
              updateSeqStmt.run(idx + 1, m.id);
            });
            setThreadResyncStmt.run(threadId);
            renumberedThreadsCount++;
          }
        }
      });
      cleanupTx();
    } else {
      renumberedThreadsCount = threadsWithDeletions.size;
    }

    return {
      dryRun: !apply,
      deletedThreadsCount,
      deletedMessagesCount,
      deletedTestMessagesCount,
      cleanedContactNamesCount,
      renumberedThreadsCount,
      backupPath
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dbArgIdx = args.indexOf('--db');
  const dbPath = dbArgIdx !== -1 ? args[dbArgIdx + 1] : undefined;

  console.log(`[CLEANUP] Starting cleanup_page_garbage (Mode: ${apply ? 'APPLY' : 'DRY-RUN'})...`);
  const report = executeCleanup({ dbPath, apply });
  console.log('[CLEANUP] Report:', JSON.stringify(report, null, 2));
}

module.exports = {
  executeCleanup
};
