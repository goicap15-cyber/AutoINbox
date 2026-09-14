const test = require('node:test');
const assert = require('node:assert/strict');
const { isOlderHistoryBatch } = require('../../src/server/services/HistoryViewportDirection');
const fs = require('fs');

test('CRM viewport scroll up stores the mounted page before existing messages', () => {
  assert.equal(isOlderHistoryBatch('ondemand_viewport', -640), true);
});

test('CRM viewport scroll down does not classify the page as older history', () => {
  assert.equal(isOlderHistoryBatch('ondemand_viewport', 640), false);
});

test('legacy older history modes remain unchanged', () => {
  assert.equal(isOlderHistoryBatch('ondemand_older', 0), true);
  assert.equal(isOlderHistoryBatch('deep_backfill', 0), true);
});

test('server preserves real CRM wheel delta for an older-page request', () => {
  const source = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(source, /scroll_delta:\s*\['viewport', 'older'\]\.includes\(direction\)/);
});
