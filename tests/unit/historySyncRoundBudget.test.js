const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/extension/historySyncRoundBudget.js', 'utf8'), context);
const { getMaxRounds, decideStopReason } = context.FbCrmHistorySyncRoundBudget;

test('round-budget matches the modes actually sent by the server', () => {
  assert.equal(getMaxRounds('initial'), 12);
  assert.equal(getMaxRounds('incremental'), 1);
  assert.equal(getMaxRounds('deep_backfill'), 20);
});

test('unknown mode falls back to a safe default instead of silently under-crawling', () => {
  assert.equal(getMaxRounds('unknown_mode'), 5);
  assert.equal(getMaxRounds(undefined), 5);
});

test('stop reason prioritizes boundary_reached over no_scroll_growth', () => {
  assert.equal(decideStopReason({ boundaryReached: true, noScrollGrowth: true }), 'boundary_reached');
});

test('stop reason is no_scroll_growth when content genuinely stopped growing', () => {
  assert.equal(decideStopReason({ boundaryReached: false, noScrollGrowth: true }), 'no_scroll_growth');
});

test('stop reason defaults to max_rounds_hit when the loop just ran out of budget', () => {
  assert.equal(decideStopReason({ boundaryReached: false, noScrollGrowth: false }), 'max_rounds_hit');
});
