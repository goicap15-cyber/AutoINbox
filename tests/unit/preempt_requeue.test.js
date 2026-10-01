'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schedulerModule = require('../../src/server/services/InboxSyncScheduler');
const { InboxSyncScheduler } = schedulerModule;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeScheduler = (dispatched) => {
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 1, threadTimeoutMs: 500, preemptRequeueDelayMs: 10 });
  scheduler.configure({
    getConnection: () => null,
    dispatchThreadMessagesSync: (job) => { dispatched.push(job); return true; }
  });
  return scheduler;
};

test('preempted background sweep job is re-dispatched instead of being lost', async () => {
  const dispatched = [];
  const scheduler = makeScheduler(dispatched);
  try {
    const ok = scheduler.enqueueThreadSync({
      account_id: 'acc1',
      thread_id: 't1',
      reason: 'initial_sweep',
      allow_navigation: true
    });
    assert.equal(ok, true);
    assert.equal(dispatched.length, 1);

    // Operator clicks a different conversation -> preempt everything else.
    scheduler.preemptActiveThreadSync('acc1', (job) => job.thread_id !== 'clicked');
    assert.equal(dispatched.length, 1, 'no immediate re-dispatch (must not steal the lane from the incoming click)');
    await wait(60);
    assert.equal(dispatched.length, 2, 'background job must come back through the replay path');
    assert.equal(dispatched[1].thread_id, 't1');
    assert.equal(dispatched[1].reason, 'initial_sweep');
  } finally {
    scheduler.unregisterAccount('acc1');
  }
});

test('preempted operator-driven job keeps the old behavior (dropped, not requeued)', async () => {
  const dispatched = [];
  const scheduler = makeScheduler(dispatched);
  try {
    const ok = scheduler.enqueueThreadSync({
      account_id: 'acc1',
      thread_id: 't2',
      reason: 'crm_navigation',
      allow_navigation: true,
      priority: 'high'
    });
    assert.equal(ok, true);
    assert.equal(dispatched.length, 1);

    scheduler.preemptActiveThreadSync('acc1', (job) => job.thread_id !== 'clicked');
    await wait(60);
    assert.equal(dispatched.length, 1, 'crm_navigation job must stay dropped: the new click replaces the old one');
  } finally {
    scheduler.unregisterAccount('acc1');
  }
});

test('history-completed threads are not re-queued after preempt', async () => {
  const dispatched = [];
  const scheduler = makeScheduler(dispatched);
  try {
    const ok = scheduler.enqueueThreadSync({
      account_id: 'acc1',
      thread_id: 't3',
      reason: 'initial_sweep',
      allow_navigation: true
    });
    assert.equal(ok, true);
    scheduler.historyCompletedThreads.add('acc1:t3');
    scheduler.historyCompletedThreads.add('t3');

    scheduler.preemptActiveThreadSync('acc1', () => true);
    await wait(60);
    assert.equal(dispatched.length, 1, 'completed thread must not crawl again');
  } finally {
    scheduler.unregisterAccount('acc1');
  }
});
