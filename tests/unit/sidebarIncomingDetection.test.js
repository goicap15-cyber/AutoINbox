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

test('rejects a weak sidebar echo of a recent outbound but keeps strong incoming evidence', () => {
  const base = {
    previousThread: { last_message: 'old message' },
    cleanLastMessage: 'just sent by CRM',
    isActivitySummary: false,
    hasRecentMatchingOutbound: true
  };
  assert.equal(isChangedIncomingSidebarPreview({
    ...base,
    incomingThread: { is_unread: false, is_like: false, preview_is_outgoing: false }
  }), false);
  assert.equal(isChangedIncomingSidebarPreview({
    ...base,
    incomingThread: { is_unread: true, is_like: false, preview_is_outgoing: false }
  }), true);
});

test('explicit outgoing preview wins over a stale unread marker', () => {
  assert.equal(isChangedIncomingSidebarPreview({
    previousThread: { last_message: 'old message' },
    incomingThread: { is_unread: true, is_like: false, preview_is_outgoing: true },
    cleanLastMessage: 'new message',
    isActivitySummary: false
  }), false);
});

test('rejects outgoing, unchanged, unknown-direction, and activity previews', () => {
  const previousThread = { last_message: 'Tin cũ' };
  const base = { previousThread, cleanLastMessage: 'Tin mới', isActivitySummary: false };
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: { preview_is_outgoing: true } }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: {} }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, cleanLastMessage: 'Tin cũ', incomingThread: { preview_is_outgoing: false } }), false);
  assert.equal(isChangedIncomingSidebarPreview({ ...base, incomingThread: { preview_is_outgoing: false }, isActivitySummary: true }), false);
});

test('server grants weak sidebar previews a one-hour outbound echo lookback', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(server, /hasRecentMatchingOutgoing[\s\S]+?windowMs: 60 \* 60 \* 1000/);
});
