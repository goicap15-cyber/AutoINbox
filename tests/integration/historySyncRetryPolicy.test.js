const test = require('node:test');
const assert = require('node:assert/strict');
const HistorySyncRetryPolicy = require('../../src/server/services/HistorySyncRetryPolicy');

test('transient failure retries automatically and stops once it succeeds', (t) => {
  HistorySyncRetryPolicy._reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fireCount = 0;
  const scheduled = HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', () => { fireCount++; });
  assert.equal(scheduled, true);
  assert.equal(fireCount, 0, 'must not fire before the backoff elapses');

  t.mock.timers.tick(2000);
  assert.equal(fireCount, 1, 'fires once the first backoff (2000ms) elapses');

  // Simulate the retry having succeeded - a real success path calls cancelRetry(thread_id).
  HistorySyncRetryPolicy.cancelRetry('threadA');
  t.mock.timers.tick(20000);
  assert.equal(fireCount, 1, 'no further retries after success cancels the policy');
});

test('navigating to a different thread of the same account cancels the pending retry', (t) => {
  HistorySyncRetryPolicy._reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fireCount = 0;
  HistorySyncRetryPolicy.scheduleRetry('acc1', 'staleThread', () => { fireCount++; });

  // Operator clicks a different thread on the same account before the retry fires.
  HistorySyncRetryPolicy.noteManualRequest('acc1', 'newThread');

  t.mock.timers.tick(20000);
  assert.equal(fireCount, 0, 'retry for the thread the operator navigated away from must never fire');
});

test('a fresh manual request for the same thread also cancels its own pending retry', (t) => {
  HistorySyncRetryPolicy._reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fireCount = 0;
  HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', () => { fireCount++; });
  HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadA');

  t.mock.timers.tick(20000);
  assert.equal(fireCount, 0, 'a manual click on the same thread should not double up with a delayed retry');
});

test('retries stop after the max attempt budget is exhausted', () => {
  HistorySyncRetryPolicy._reset();
  const noop = () => {};

  assert.equal(HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', noop), true);
  assert.equal(HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', noop), true);
  assert.equal(HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', noop), true);
  assert.equal(HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', noop), false, 'must refuse a 4th attempt');

  HistorySyncRetryPolicy._reset();
});
