const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

// Test both extension textFilter and server textFilter
const serverFilter = require('../../src/server/utils/textFilter');

const extContext = { console };
vm.createContext(extContext);
vm.runInContext(fs.readFileSync('src/extension/textFilter.js', 'utf8'), extContext);
const extFilter = extContext.FbCrmTextFilter;

test('T004: kiểm tra blacklist thread_id chặn UNKNOWN_THREAD và sentinel rác', () => {
  const { isBlacklistedThreadId } = require('../../src/server/utils/threadGuard');
  assert.equal(isBlacklistedThreadId('UNKNOWN_THREAD'), true);
  assert.equal(isBlacklistedThreadId('unknown_dom'), true);
  assert.equal(isBlacklistedThreadId(''), true);
  assert.equal(isBlacklistedThreadId(null), true);
  assert.equal(isBlacklistedThreadId(undefined), true);
  assert.equal(isBlacklistedThreadId('   '), true);

  assert.equal(isBlacklistedThreadId('100092115712908'), false);
  assert.equal(isBlacklistedThreadId('t_123456789'), false);
});

test('T004: cleanContactName và isInvalidContactName chặn chuỗi lặp lại "Tất cả tin nhắn"', () => {
  const badNames = [
    'Tất cả tin nhắn',
    'Tất cả tin nhắnTất cả tin nhắn',
    'Tất cả tin nhắn Tất cả tin nhắn',
    'Tất cả tin nhắnTất cả tin nhắnTất cả tin nhắn',
    'All messagesAll messages',
    'All messages All messages',
    'Hộp thư đếnHộp thư đến',
    'Meta Business Suite'
  ];

  for (const name of badNames) {
    assert.equal(serverFilter.isInvalidContactName(name), true, `Server filter must flag: ${name}`);
    assert.equal(serverFilter.cleanContactName(name), 'Khách hàng', `Server clean must fallback: ${name}`);
    assert.equal(extFilter.isInvalidContactName(name), true, `Extension filter must flag: ${name}`);
    assert.equal(extFilter.cleanContactName(name), 'Khách hàng', `Extension clean must fallback: ${name}`);
  }

  const goodNames = [
    'Nguyễn Văn A',
    'Bảo Khánh',
    'Thu Oanh Nguyen',
    'John Doe'
  ];

  for (const name of goodNames) {
    assert.equal(serverFilter.isInvalidContactName(name), false, `Server filter must allow: ${name}`);
    assert.equal(serverFilter.cleanContactName(name), name, `Server clean must keep: ${name}`);
    assert.equal(extFilter.isInvalidContactName(name), false, `Extension filter must allow: ${name}`);
    assert.equal(extFilter.cleanContactName(name), name, `Extension clean must keep: ${name}`);
  }
});
