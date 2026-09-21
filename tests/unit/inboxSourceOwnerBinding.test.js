'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const InboxSourceService = require('../../src/server/services/InboxSourceService');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inbox_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      owner_account_id TEXT,
      external_id TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      access_token_encrypted TEXT,
      webhook_verify_token TEXT,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      external_thread_id TEXT,
      source_id TEXT
    );
  `);
  return db;
}

test('ensurePageSource binds owner to a pre-existing owner-less row (auto-discovered page)', () => {
  const db = setupTestDb();
  // Row tự tạo bởi scan Business Suite TRƯỚC khi user bấm "Kết nối Page".
  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
    VALUES ('src_page_123', 'page_messenger', NULL, '123', 'Page 123', 'ACTIVE')
  `).run();

  const source = InboxSourceService.ensurePageSource({ pageId: '123', accountId: 'acc_1' }, db);
  assert.equal(source.owner_account_id, 'acc_1');
  const row = db.prepare('SELECT owner_account_id, display_name FROM inbox_sources WHERE id = ?').get('src_page_123');
  assert.equal(row.owner_account_id, 'acc_1');
  // Display_name giữ nguyên (chỉ bind owner).
  assert.equal(row.display_name, 'Page 123');
});

test('ensurePageSource never steals an owner that is already bound', () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
    VALUES ('src_page_456', 'page_messenger', 'acc_1', '456', 'Page 456', 'ACTIVE')
  `).run();

  InboxSourceService.ensurePageSource({ pageId: '456', accountId: 'acc_2' }, db);
  const row = db.prepare('SELECT owner_account_id FROM inbox_sources WHERE id = ?').get('src_page_456');
  assert.equal(row.owner_account_id, 'acc_1');
});

test('ensurePageSource creates a bound ACTIVE row when none exists', () => {
  const db = setupTestDb();
  const source = InboxSourceService.ensurePageSource({ pageId: '789', accountId: 'acc_9' }, db);
  assert.equal(source.owner_account_id, 'acc_9');
  assert.equal(source.status, 'ACTIVE');
  assert.equal(source.external_id, '789');
});
