const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { executeCleanup } = require('../../scripts/cleanup_page_garbage');

test('T008: cleanup script --dry-run in kết quả không làm thay đổi DB', () => {
  const tmpDbPath = path.join(__dirname, `tmp_test_cleanup_${Date.now()}.db`);
  const db = new Database(tmpDbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        contact_name TEXT,
        sync_status TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        content TEXT
      );
    `);

    db.prepare("INSERT INTO threads (id, contact_name, sync_status) VALUES ('UNKNOWN_THREAD', 'Tất cả tin nhắn', 'SYNCED')").run();
    db.prepare("INSERT INTO threads (id, contact_name, sync_status) VALUES ('page_thread_1', 'Tất cả tin nhắnTất cả tin nhắn', 'SYNCED')").run();
    db.prepare("INSERT INTO messages (thread_id, content) VALUES ('UNKNOWN_THREAD', 'Meta Business Suite')").run();
    db.prepare("INSERT INTO messages (thread_id, content) VALUES ('UNKNOWN_THREAD', 'Quảng cáo')").run();
    db.prepare("INSERT INTO messages (thread_id, content) VALUES ('page_thread_1', 'Xin chào khách hàng')").run();

    // Chạy dry-run
    const reportDry = executeCleanup({ dbPath: tmpDbPath, apply: false });
    assert.equal(reportDry.dryRun, true);
    assert.equal(reportDry.deletedThreadsCount, 1);
    assert.equal(reportDry.deletedMessagesCount, 2);
    assert.equal(reportDry.cleanedContactNamesCount, 1);

    // Xác nhận trong DB số lượng không đổi
    const countThreads = db.prepare('SELECT count(*) as c FROM threads').get().c;
    assert.equal(countThreads, 2);

    // Chạy apply
    const reportApply = executeCleanup({ dbPath: tmpDbPath, apply: true });
    assert.equal(reportApply.dryRun, false);
    assert.ok(reportApply.backupPath && fs.existsSync(reportApply.backupPath));

    // Xác nhận trong DB đã được dọn
    const countThreadsAfter = db.prepare('SELECT count(*) as c FROM threads').get().c;
    assert.equal(countThreadsAfter, 1); // UNKNOWN_THREAD đã bị xóa

    const cleanThread = db.prepare('SELECT * FROM threads WHERE id = ?').get('page_thread_1');
    assert.equal(cleanThread.contact_name, 'Khách hàng');
    assert.equal(cleanThread.sync_status, 'NEEDS_RESYNC');

    const countMsgsAfter = db.prepare('SELECT count(*) as c FROM messages').get().c;
    assert.equal(countMsgsAfter, 1);

    // Xóa backup file test
    if (reportApply.backupPath && fs.existsSync(reportApply.backupPath)) {
      fs.unlinkSync(reportApply.backupPath);
    }
  } finally {
    db.close();
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  }
});
