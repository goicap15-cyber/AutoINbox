const test = require('node:test');
const assert = require('node:assert/strict');
const { isChangedIncomingSidebarPreview } = require('../../src/server/utils/sidebarIncomingDetection');

test('accepts an explicitly incoming changed preview even when unread is already cleared', () => {
  assert.equal(isChangedIncomingSidebarPreview({
    previousThread: { last_message: 'Tin cũ' },
    incomingThread: { is_unread: false, is_like: false, preview_is_outgoing: false },
    cleanLastMessage: 'Tin khách vừa gửi',
    isActivitySummary: false
  }), true);
});

test('rejects outgoing, unchanged, unknown-direction, and activity previews', () => {
  const previousThread = { last_message: 'Tin cũ' };
  const base = { previousThread, cleanLastMessage: 'Tin mới', isActivitySummary: false };
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: { preview_is_outgoing: true } }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: {} }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, cleanLastMessage: 'Tin cũ', incomingThread: { preview_is_outgoing: false } }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: { preview_is_outgoing: false }, isActivitySummary: true }), false);
});