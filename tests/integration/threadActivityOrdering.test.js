const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTestDatabase } = require('../helpers/testDatabase');
const { AssignmentManager } = require('../../src/server/services/AssignmentManager');

test('sidebar orders mixed SQLite and ISO activity timestamps by real time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-thread-order-'));
  const db = getTestDatabase(path.join(dir, 'database.db'));
  try {
    db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('account-order', 'Order account', '/tmp/order');
    db.prepare('INSERT INTO threads (id, account_id, contact_name, last_activity) VALUES (?, ?, ?, ?)')
      .run('older-iso', 'account-order', 'Older ISO', '2026-09-12T09:01:00.000Z');
    db.prepare('INSERT INTO threads (id, account_id, contact_name, last_activity) VALUES (?, ?, ?, ?)')
      .run('newer-sqlite', 'account-order', 'Newer SQLite', '2026-09-12 11:10:00');

    const rows = new AssignmentManager(db).getThreadsByFilter('admin', 'ADMIN');
    assert.deepEqual(rows.map((row) => row.id), ['newer-sqlite', 'older-iso']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
