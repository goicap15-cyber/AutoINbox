const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolvePageIdFromUrl, verifyPageOwnership } = require('../../src/server/utils/pageContextResolver');

test('T003: trích xuất page_id từ URL query asset_id hoặc path', () => {
  const url1 = 'https://business.facebook.com/latest/inbox/all?asset_id=100092115712908&mailbox_id=100092115712908';
  assert.equal(resolvePageIdFromUrl(url1), '100092115712908');

  const url2 = 'https://business.facebook.com/messages/t/123456789?business_id=987654321';
  assert.equal(resolvePageIdFromUrl(url2), null);
});

test('T003: xác minh quyền sở hữu Page thuộc Account (với mock DB đơn giản)', () => {
  const mockDb = {
    prepare: (sql) => ({
      get: (accountId, pageId) => {
        if (accountId === 'acc_1' && (pageId === 'page_100' || pageId === 'src_page_page_100')) {
          return { id: 'src_page_page_100', owner_account_id: 'acc_1', external_id: 'page_100' };
        }
        return null;
      }
    })
  };

  assert.equal(verifyPageOwnership('acc_1', 'page_100', mockDb), true);
  assert.equal(verifyPageOwnership('acc_2', 'page_100', mockDb), false);
  assert.equal(verifyPageOwnership(null, 'page_100', mockDb), false);
});

test('T003: xác minh quyền sở hữu Page với SQLite CSDL thực tế (fallback threads & auto-backfill)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inbox_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      owner_account_id TEXT,
      external_id TEXT NOT NULL,
      display_name TEXT
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source_id TEXT,
      thread_url TEXT
    );
  `);

  // Page 1: Có owner_account_id trực tiếp
  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name)
    VALUES ('src_page_111', 'page_messenger', 'acc_1', '111', 'Page 111')
  `).run();

  // Page 2: owner_account_id ban đầu là NULL, nhưng có thread thuộc acc_1
  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name)
    VALUES ('src_page_222', 'page_messenger', NULL, '222', 'Page 222')
  `).run();
  db.prepare(`
    INSERT INTO threads (id, account_id, source_id)
    VALUES ('thread_222_1', 'acc_1', 'src_page_222')
  `).run();

  // Page 3: Không có owner và không có thread nào thuộc acc_1
  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name)
    VALUES ('src_page_333', 'page_messenger', 'acc_other', '333', 'Page 333')
  `).run();

  // 1. Kiểm tra Page 1 -> true
  assert.equal(verifyPageOwnership('acc_1', '111', db), true);
  assert.equal(verifyPageOwnership('acc_2', '111', db), false);

  // 2. Kiểm tra Page 2 -> fallback qua threads thành công & auto-backfill
  assert.equal(verifyPageOwnership('acc_1', '222', db), true);
  const updatedPage2 = db.prepare('SELECT owner_account_id FROM inbox_sources WHERE external_id = ?').get('222');
  assert.equal(updatedPage2.owner_account_id, 'acc_1', 'Phải tự động backfill owner_account_id');

  // 3. Kiểm tra Page 3 -> false
  assert.equal(verifyPageOwnership('acc_1', '333', db), false);

  db.close();
});
