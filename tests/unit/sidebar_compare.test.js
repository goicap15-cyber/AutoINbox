'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sidebarShouldSkipSweep, isStaleThreadLastActivity, normalizePreviewText } = require('../../src/server/utils/sidebarCompare');

// Vietnamese via unicode escapes so this source stays ASCII.
const PREVIEW = 'H\u00f4m nay em t\u1eb7ng \u01b0u \u0111\u00e3i gi\u1ea3m gi\u00e1 mua h\u00e0ng cho anh qua s\u1ed1 zalo n\u00e0o \u0111\u01b0\u1ee3c a?';
const STORED_SAME = PREVIEW;
const STORED_LONGER = PREVIEW + ' Mong anh ph\u1ea3n h\u1ed3i s\u1edbm.';
const OTHER = 'C\u1ed5ng Nh\u00f4m \u0110\u00fac Tr\u1ed1ng \u0110\u1ed3ng hoch\u1ea5t l\u01b0\u1ee3ng cao';

test('skips sweep when sidebar preview matches stored last message', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: STORED_SAME, isUnread: 0 }), true);
});

test('skips when preview is a truncated prefix of the stored message', () => {
  const truncated = PREVIEW.slice(0, 40);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: truncated, storedContent: STORED_SAME, isUnread: 0 }), true);
});

test('skips when stored is a prefix of the preview (BS shows more text than stored)', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: STORED_LONGER, storedContent: PREVIEW, isUnread: 0 }), true);
});

test('never skips unread threads even when preview matches', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: STORED_SAME, isUnread: 1 }), false);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: STORED_SAME, isUnread: true }), false);
});

test('does not skip when the last message changed', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: OTHER, isUnread: 0 }), false);
});

test('does not skip very short previews (repeated short chats like "ok")', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: 'Ok', storedContent: 'Ok', isUnread: 0 }), false);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: 'D\u1ea1', storedContent: 'D\u1ea1', isUnread: 0 }), false);
});

test('normalizes zero-width chars, whitespace and case before comparing', () => {
  const messyPreview = '  \u200b' + PREVIEW.slice(0, 30) + '  ';
  assert.equal(normalizePreviewText(messyPreview), normalizePreviewText(PREVIEW.slice(0, 30)));
  assert.equal(
    sidebarShouldSkipSweep({ sidebarPreview: messyPreview, storedContent: PREVIEW, isUnread: 0 }),
    true
  );
});

test('never skips when preview or stored content is empty', () => {
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: '', storedContent: STORED_SAME, isUnread: 0 }), false);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: '', isUnread: 0 }), false);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: null, isUnread: 0 }), false);
  assert.equal(sidebarShouldSkipSweep({ sidebarPreview: PREVIEW, storedContent: STORED_SAME }), false);
});

test('isStaleThreadLastActivity: old last message and not unread -> defer', () => {
  const now = Date.now();
  assert.equal(isStaleThreadLastActivity({ lastMsgTs: now - 40 * 86400000, nowMs: now, staleDays: 30 }), true);
  assert.equal(isStaleThreadLastActivity({ lastMsgTs: now - 5 * 86400000, nowMs: now, staleDays: 30 }), false);
  assert.equal(isStaleThreadLastActivity({ lastMsgTs: 0, nowMs: now, staleDays: 30 }), false); // chua co tin -> khong stale
  assert.equal(isStaleThreadLastActivity({ lastMsgTs: now - 40 * 86400000, nowMs: now, staleDays: 60 }), false);
});
