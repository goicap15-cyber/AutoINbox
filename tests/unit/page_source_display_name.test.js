const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const InboxSourceService = require('../../src/server/services/InboxSourceService.js');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inbox_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      owner_account_id TEXT,
      external_id TEXT,
      display_name TEXT,
      avatar_url TEXT,
      access_token_encrypted TEXT,
      webhook_verify_token TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      source_id TEXT,
      contact_name TEXT
    );
  `);
  return db;
}

test('InboxSourceService: ensurePageSource tạo mới với fallback name và cập nhật khi có pageName', () => {
  const db = createTestDb();

  // 1. Tạo mới khi chưa có pageName -> display_name = 'Page 123456'
  const s1 = InboxSourceService.ensurePageSource({ pageId: '123456', accountId: 'acc_1' }, db);
  assert.equal(s1.display_name, 'Page 123456');

  // 2. Gọi lại với pageName thật -> tự động cập nhật
  const s2 = InboxSourceService.ensurePageSource({ pageId: '123456', pageName: 'Cà Phê Hà Nội - 299' }, db);
  assert.equal(s2.display_name, 'Cà Phê Hà Nội - 299');
});

test('InboxSourceService: updatePageDisplayName cập nhật tên thật và bỏ qua tên không hợp lệ', () => {
  const db = createTestDb();
  InboxSourceService.ensurePageSource({ pageId: '999999', accountId: 'acc_1' }, db);

  // Cập nhật tên hợp lệ
  const updated = InboxSourceService.updatePageDisplayName({ pageId: '999999', pageName: 'Tiệm Trà Tháng Năm' }, db);
  assert.equal(updated.display_name, 'Tiệm Trà Tháng Năm');

  // Bỏ qua tên dạng "Page 123" hoặc rác
  const ignored = InboxSourceService.updatePageDisplayName({ pageId: '999999', pageName: 'Page 999999' }, db);
  assert.equal(ignored, null);

  // Bỏ qua đường link URL
  const ignoredUrl = InboxSourceService.updatePageDisplayName({
    pageId: '999999',
    pageName: 'business.facebook.com/latest/inbox/all/?asset_id=999999&mailbox_id=999999'
  }, db);
  assert.equal(ignoredUrl, null);

  // Bỏ qua chuỗi tĩnh Meta
  const ignoredGeneric = InboxSourceService.updatePageDisplayName({
    pageId: '999999',
    pageName: 'Meta Business Suite'
  }, db);
  assert.equal(ignoredGeneric, null);

  const current = InboxSourceService.getSourceById('src_page_999999', db);
  assert.equal(current.display_name, 'Tiệm Trà Tháng Năm');
});
