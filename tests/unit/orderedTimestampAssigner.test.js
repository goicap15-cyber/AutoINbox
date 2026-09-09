const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/extension/orderedTimestampAssigner.js', 'utf8'), context);
const { assignOrderedTimestamps } = context.FbCrmOrderedTimestampAssigner;

test('live-evidence regression (2026-08-20): a message captured now is NOT stamped with a ~5-hour-stale anchor', () => {
  // Anchor left over from ~5 hours ago (matches the real DB evidence: anchor
  // at 04:41:47.489, new message actually captured at 09:33:00.355).
  const fiveHoursAgo = new Date('2026-08-19T04:41:47.489Z').getTime();
  const now = new Date('2026-08-19T09:33:00.355Z').getTime();

  const known = new Map([['anchor_msg', fiveHoursAgo]]);
  const orderedIds = ['anchor_msg', 'new_msg'];

  assignOrderedTimestamps(orderedIds, known, { now: () => now });

  const assigned = known.get('new_msg');
  assert.ok(now - assigned < 60 * 1000, `expected assigned (${new Date(assigned).toISOString()}) to be close to now (${new Date(now).toISOString()}), not the stale anchor`);
});

test('a genuinely recent anchor (well within the stale threshold) is still used for extrapolation (no regression)', () => {
  const now = 1_700_000_000_000;
  const twoSecondsAgo = now - 2000;
  const known = new Map([['anchor_msg', twoSecondsAgo]]);
  const orderedIds = ['anchor_msg', 'new_msg'];

  assignOrderedTimestamps(orderedIds, known, { now: () => now });

  const assigned = known.get('new_msg');
  assert.equal(assigned, twoSecondsAgo + 1000); // ORDER_GAP_MS extrapolation, unchanged behavior
});

test('backward extrapolation (scroll-back history, nextKnownTs but no lastKnownTs) is unaffected by the staleness bound (FR-002)', () => {
  const now = 1_700_000_000_000;
  const nextTs = now - 3000;
  const known = new Map([['future_msg', nextTs]]);
  const orderedIds = ['older_msg', 'future_msg'];

  assignOrderedTimestamps(orderedIds, known, { now: () => now });

  const assigned = known.get('older_msg');
  assert.equal(assigned, nextTs - 1000); // extrapolated backward from nextKnownTs, untouched by the fix
});

test('interpolation between two known anchors is unaffected by the staleness bound (FR-002)', () => {
  const known = new Map([
    ['a', 1000],
    ['c', 5000]
  ]);
  const orderedIds = ['a', 'b', 'c'];
  assignOrderedTimestamps(orderedIds, known, { now: () => 1_700_000_000_000 });

  assert.equal(known.get('b'), 3000); // midpoint interpolation, untouched
});

test('no anchors at all falls back to now-based spacing (existing behavior, unchanged)', () => {
  const now = 1_700_000_000_000;
  const known = new Map();
  const orderedIds = ['a', 'b', 'c'];
  assignOrderedTimestamps(orderedIds, known, { now: () => now });

  assert.equal(known.get('a'), now - 1000 * 3);
  assert.equal(known.get('b'), now - 1000 * 2);
  assert.equal(known.get('c'), now - 1000 * 1);
});
