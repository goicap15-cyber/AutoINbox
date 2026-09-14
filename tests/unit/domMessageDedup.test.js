const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/extension/domMessageDedup.js', 'utf8'), context);
const { makeDomMessageId, shouldSkipObservation } = context.FbCrmDomMessageDedup;

test('same message re-scanned with a flipped is_outgoing produces the SAME id (SC-001)', () => {
  const firstScan = { content: 'chào shop', is_outgoing: false, sender_name: '', effective_label: '', native_id: null, bubble_idx: 0 };
  const secondScan = { content: 'chào shop', is_outgoing: true, sender_name: 'Bạn', effective_label: 'Tin nhắn do Bạn gửi lúc 10:09: chào shop', native_id: null, bubble_idx: 0 };
  assert.equal(makeDomMessageId('969878666067566', firstScan), makeDomMessageId('969878666067566', secondScan));
});

test('a stable native_id makes the id direction-independent regardless of content/label drift', () => {
  const firstScan = { content: '20sáng', is_outgoing: false, native_id: 'mid.abc123', bubble_idx: 2 };
  const secondScan = { content: 'chào shop', is_outgoing: true, native_id: 'mid.abc123', bubble_idx: 2 };
  assert.equal(makeDomMessageId('t1', firstScan), makeDomMessageId('t1', secondScan));
});

test('grouped native bubbles keep the legacy first id and distinguish later bubbles', () => {
  const first = { content: 'tin mot', is_outgoing: false, native_id: 'mid.grouped', bubble_idx: 0 };
  const second = { content: 'tin hai', is_outgoing: false, native_id: 'mid.grouped', bubble_idx: 1 };
  const third = { content: 'tin ba', is_outgoing: false, native_id: 'mid.grouped', bubble_idx: 2 };

  assert.equal(makeDomMessageId('t1', first), 'mid.grouped');
  assert.equal(makeDomMessageId('t1', second), 'mid.grouped__bubble_1');
  assert.equal(makeDomMessageId('t1', third), 'mid.grouped__bubble_2');
});

test('genuinely different content still produces different ids (no regression, SC-002)', () => {
  const a = { content: 'ok', is_outgoing: false, native_id: null, bubble_idx: 0 };
  const b = { content: 'ok nhé', is_outgoing: false, native_id: null, bubble_idx: 0 };
  assert.notEqual(makeDomMessageId('t1', a), makeDomMessageId('t1', b));
});

test('shouldSkipObservation: identical id+direction already forwarded -> skip', () => {
  const seen = new Map([['dom_t1_hash_1_0', false]]);
  assert.equal(shouldSkipObservation(seen, 'dom_t1_hash_1_0', false), true);
});

test('shouldSkipObservation: same id but direction now disagrees -> do NOT skip (let the correction through, SC-001)', () => {
  const seen = new Map([['dom_t1_hash_1_0', false]]);
  assert.equal(shouldSkipObservation(seen, 'dom_t1_hash_1_0', true), false);
});

test('shouldSkipObservation: id never seen before -> do NOT skip', () => {
  const seen = new Map();
  assert.equal(shouldSkipObservation(seen, 'dom_t1_hash_1_0', false), false);
});

test('separate physical bubbles with identical content keep separate ids', () => {
  const first = { content: 'c', native_id: null, bubble_idx: 0, dom_occurrence_id: 101 };
  const second = { content: 'c', native_id: null, bubble_idx: 0, dom_occurrence_id: 102 };
  assert.notEqual(makeDomMessageId('t1', first), makeDomMessageId('t1', second));
});

test('content observer has no delayed startup or thread-change baseline window', () => {
  const source = fs.readFileSync('src/extension/content.js', 'utf8');
  assert.doesNotMatch(source, /Second seed after 3s/);
  assert.doesNotMatch(source, /seedBaseline\(thread_id\);\s*setTimeout/);
  assert.match(source, /chatObserver\.observe\(document\.body[\s\S]*observerPaused = false;/);
});
