'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HistorySyncRetryPolicy = require('../../src/server/services/HistorySyncRetryPolicy');

// Phase 1 (plan 2026-10-01): when the navigated_away guard cancels a retry,
// the thread must be handed to the requeue handler (server re-enqueues it at
// the tail of the sweep queue) instead of being lost. Bounded: at most
// MAX_NAVIGATED_AWAY_REQUEUES per thread until a retry actually fires.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('navigated_away guard hands the thread to the requeue handler instead of dropping it', async () => {
  HistorySyncRetryPolicy._reset();
  const requeued = [];
  HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: (acc, tid) => requeued.push([acc, tid]) });
  try {
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB'); // operator is viewing threadB
    let fired = false;
    const ok = HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadA', () => { fired = true; }, [5]);
    assert.equal(ok, true);
    await sleep(40);
    assert.equal(fired, false, 'retry must not fire while operator is elsewhere');
    assert.deepEqual(requeued, [['acc1', 'threadA']]);
  } finally {
    HistorySyncRetryPolicy._reset();
    HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: null });
  }
});

test('requeue is capped at 3 per thread so a permanently failing thread cannot loop forever', async () => {
  HistorySyncRetryPolicy._reset();
  const requeued = [];
  HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: (acc, tid) => requeued.push(tid) });
  try {
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB');
    for (let i = 0; i < 5; i += 1) {
      const ok = HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadC', () => {}, [5]);
      assert.equal(ok, true);
      await sleep(20);
    }
    assert.equal(requeued.length, 3, `expected exactly 3 requeues, got ${requeued.length}`);
  } finally {
    HistorySyncRetryPolicy._reset();
    HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: null });
  }
});

test('a retry that actually fires resets the requeue budget for that thread', async () => {
  HistorySyncRetryPolicy._reset();
  const requeued = [];
  HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: (acc, tid) => requeued.push(tid) });
  try {
    // Round 1: guard trips once, thread is requeued.
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB');
    HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadD', () => {}, [5]);
    await sleep(20);
    assert.deepEqual(requeued, ['threadD']);

    // Operator comes back; a fresh retry fires for real.
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadD');
    let fired = false;
    HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadD', () => { fired = true; }, [5]);
    await sleep(20);
    assert.equal(fired, true);

    // Round 2: operator leaves again; budget must be back to a full 3 (first requeue logs requeue=1/3 semantics).
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB');
    HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadD', () => {}, [5]);
    await sleep(20);
    assert.equal(requeued.length, 2);
  } finally {
    HistorySyncRetryPolicy._reset();
    HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: null });
  }
});

test('without a configured handler the guard still skips safely (no crash)', async () => {
  HistorySyncRetryPolicy._reset();
  HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: null });
  try {
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB');
    const ok = HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadE', () => {}, [5]);
    assert.equal(ok, true);
    await sleep(20);
  } finally {
    HistorySyncRetryPolicy._reset();
  }
});

test('cancelRetry before the timer prevents both fire and requeue', async () => {
  HistorySyncRetryPolicy._reset();
  const requeued = [];
  HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: (acc, tid) => requeued.push(tid) });
  try {
    HistorySyncRetryPolicy.noteManualRequest('acc1', 'threadB');
    HistorySyncRetryPolicy.scheduleRetry('acc1', 'threadF', () => {}, [5000]);
    HistorySyncRetryPolicy.cancelRetry('threadF');
    await sleep(20);
    assert.deepEqual(requeued, []);
  } finally {
    HistorySyncRetryPolicy._reset();
    HistorySyncRetryPolicy.configure({ onNavigatedAwayRequeue: null });
  }
});
