const test = require('node:test');
const assert = require('node:assert/strict');
const HistorySyncManager = require('../../src/server/services/HistorySyncManager');

test('boundary actually reached -> SYNCED', () => {
  const status = HistorySyncManager.resolveStatusFromCheckpoint({ stop_reason: 'boundary_reached', boundary_reached: true });
  assert.equal(status, 'SYNCED');
});

test('crawl stalled but no known boundary yet (no_scroll_growth) -> SYNCED (genuinely no more content to load)', () => {
  const status = HistorySyncManager.resolveStatusFromCheckpoint({ stop_reason: 'no_scroll_growth', boundary_reached: false });
  assert.equal(status, 'SYNCED');
});

test('crawl stopped only because it ran out of round budget -> PARTIAL', () => {
  const status = HistorySyncManager.resolveStatusFromCheckpoint({ stop_reason: 'max_rounds_hit', boundary_reached: false });
  assert.equal(status, 'PARTIAL');
});

test('legacy checkpoint without stop_reason -> SYNCED (backward-compatible, never downgrades old data)', () => {
  assert.equal(HistorySyncManager.resolveStatusFromCheckpoint({ mode: 'initial' }), 'SYNCED');
  assert.equal(HistorySyncManager.resolveStatusFromCheckpoint(null), 'SYNCED');
});

test('on-demand page remains partial until scrolling reaches the real beginning', () => {
  assert.equal(HistorySyncManager.resolveStatusFromCheckpoint({ stop_reason: 'on_demand_page' }), 'PARTIAL');
});
