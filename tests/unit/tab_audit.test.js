'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTabsForAudit } = require('../../src/extension/tabAudit');

const bs = (id, pageId, extra = {}) => ({
  id, url: `https://business.facebook.com/latest/inbox/all/?asset_id=${pageId}&mailbox_id=${pageId}`, active: false, ...extra
});
const msgr = (id, extra = {}) => ({ id, url: 'https://www.messenger.com/', active: false, ...extra });
const fbHome = (id, extra = {}) => ({ id, url: 'https://www.facebook.com/', active: false, ...extra });

test('keeps one BS tab per page, closes only duplicate messengers, leaves user tabs', () => {
  const tabs = [
    bs(1, '768461266361443'),
    bs(2, '981379718397264'),
    bs(3, '1308827048971701'),
    msgr(4),                              // tab mess cá nhân (đã registry history)
    msgr(5),                              // tab mess trùng, KHÔNG registry -> rác
    fbHome(6),                            // tab người dùng -> không đụng
    msgr(7)                               // marker tab (protected) -> không đụng
  ];
  const verdict = classifyTabsForAudit({
    tabs,
    registry: {
      'page:768461266361443': 1,
      'acc_1:history': 4
    },
    protectedIds: [7]
  });
  assert.deepEqual(verdict.closeIds, [5]);
  for (const keepId of [1, 2, 3, 4, 6, 7]) {
    assert.equal(verdict.closeIds.includes(keepId), false, `tab ${keepId} must not be closed`);
  }
});

test('closes duplicate BS tab of the same page, keeps registered one', () => {
  const tabs = [bs(10, '768461266361443'), bs(11, '768461266361443')];
  const verdict = classifyTabsForAudit({
    tabs,
    registry: { 'page:768461266361443': 10 },
    protectedIds: []
  });
  assert.deepEqual(verdict.keepIds, [10]);
  assert.deepEqual(verdict.closeIds, [11]);
});

test('closes transient discovery/requests messenger tabs, keeps working roles', () => {
  const tabs = [msgr(20), msgr(21), msgr(22), msgr(23)];
  const verdict = classifyTabsForAudit({
    tabs,
    registry: {
      'acc_1:history': 20,      // keep (working role)
      'acc_1:discovery': 21,    // transient -> close
      'acc_1:requests': 22,     // transient -> close
      'acc_1:campaign': 23      // working role -> keep
    },
    protectedIds: []
  });
  assert.deepEqual(verdict.closeIds.sort((a, b) => a - b), [21, 22]);
  assert.equal(verdict.closeIds.includes(20), false);
  assert.equal(verdict.closeIds.includes(23), false);
});

test('never closes protected (marker) tabs and never touches non-extension URLs', () => {
  const tabs = [msgr(30), msgr(31), fbHome(32), bs(33, '768461266361443')];
  const verdict = classifyTabsForAudit({
    tabs,
    registry: { 'acc_1:history': 30 },
    protectedIds: [31]
  });
  assert.equal(verdict.closeIds.includes(31), false);
  assert.equal(verdict.closeIds.includes(32), false);
  assert.equal(verdict.closeIds.includes(33), false);
});

test('unregistered BS tab of an already-covered page is closed, other page kept', () => {
  const tabs = [bs(40, '768461266361443'), bs(41, '768461266361443', { active: true }), bs(42, '981379718397264')];
  const verdict = classifyTabsForAudit({
    tabs,
    registry: { 'page:768461266361443': 40 },
    protectedIds: []
  });
  // Tab 41 active nhưng page 768 đã có tab registry 40 -> 41 là trùng.
  assert.deepEqual(verdict.closeIds, [41]);
  assert.equal(verdict.keepIds.includes(42), true);
});
