const test = require('node:test');
const assert = require('node:assert/strict');
const { isMessagesUrl, planMessengerTabs } = require('../../src/extension/messengerTabDeduplicator');

test('keeps one Messenger tab and closes duplicate Messenger tabs', () => {
  const result = planMessengerTabs([
    { id: 1, url: 'https://www.facebook.com/messages' },
    { id: 2, url: 'https://www.facebook.com/messages/t/123' },
    { id: 3, url: 'https://www.facebook.com/profile.php?id=1' }
  ], 2);
  assert.equal(result.keeper.id, 2);
  assert.deepEqual(result.duplicateTabIds, [1]);
});

test('never treats a groupcall as a background Messenger tab', () => {
  assert.equal(isMessagesUrl('https://www.facebook.com/groupcall/ROOM:1/?call_id=2'), false);
});
