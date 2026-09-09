const test = require('node:test');
const assert = require('node:assert/strict');
const { planGroupCallTabs } = require('../../src/extension/callTabDeduplicator');

test('deduplicates an old Messenger window navigated to groupcall and a new popup', () => {
  const result = planGroupCallTabs([
    { id: 10, windowId: 1, url: 'https://www.facebook.com/groupcall/ROOM:1/?call_id=old' },
    { id: 20, windowId: 2, url: 'https://www.facebook.com/groupcall/ROOM:1/?call_id=new' }
  ], null, [2]);
  assert.equal(result.keeper.id, 20);
  assert.deepEqual(result.duplicateTabIds, [10]);
});

test('keeps the same tab throughout later cleanup ticks', () => {
  const result = planGroupCallTabs([
    { id: 30, windowId: 3, url: 'https://www.facebook.com/groupcall/ROOM:1/?call_id=keeper' },
    { id: 40, windowId: 4, url: 'https://www.facebook.com/groupcall/ROOM:1/?call_id=late' },
    { id: 50, windowId: 5, url: 'https://www.facebook.com/messages' }
  ], 30, [4]);
  assert.equal(result.keeper.id, 30);
  assert.deepEqual(result.duplicateTabIds, [40]);
});
