const test = require('node:test');
const assert = require('node:assert/strict');
const InboxSourceService = require('../../src/server/services/InboxSourceService');
const db = require('../../src/server/database/db');

test('Unit Test: InboxSourceService.ensurePageSource for Auto-Discovery', async (t) => {
  const testPageId = '999888777' + Date.now();
  const testAccountId = '1000999888' + Date.now();

  await t.test('tạo page source mới thành công không cần token', () => {
    const source = InboxSourceService.ensurePageSource({
      pageId: testPageId,
      accountId: testAccountId,
      pageName: 'Tiệm Trà Hoa Quả'
    }, db);

    assert.ok(source);
    assert.equal(source.id, 'src_page_' + testPageId);
    assert.equal(source.source_type, 'page_messenger');
    assert.equal(source.display_name, 'Tiệm Trà Hoa Quả');
    assert.equal(source.owner_account_id, testAccountId);
  });

  await t.test('idempotent: gọi lại không bị lỗi và giữ nguyên source', () => {
    const sourceAgain = InboxSourceService.ensurePageSource({
      pageId: testPageId,
      accountId: testAccountId,
      pageName: 'Tiệm Trà Hoa Quả'
    }, db);

    assert.ok(sourceAgain);
    assert.equal(sourceAgain.id, 'src_page_' + testPageId);
  });

  await t.test('tự động gắn owner cho source mồ côi (owner_account_id IS NULL)', () => {
    const orphanPageId = '888777666' + Date.now();
    // Tạo source mồ côi
    db.prepare(`
      INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
      VALUES (?, 'page_messenger', NULL, ?, 'Trang Mồ Côi', 'ACTIVE')
    `).run('src_page_' + orphanPageId, orphanPageId);

    // ensurePageSource với accountId mới -> phải auto-bind
    const bound = InboxSourceService.ensurePageSource({
      pageId: orphanPageId,
      accountId: testAccountId,
      pageName: 'Trang Mồ Côi'
    }, db);

    assert.ok(bound);
    assert.equal(bound.owner_account_id, testAccountId);

    // Cleanup
    db.prepare('DELETE FROM inbox_sources WHERE external_id IN (?, ?)').run(testPageId, orphanPageId);
  });
});
