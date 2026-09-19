'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InitialMessageSweepService } = require('../../src/server/services/InitialMessageSweepService');

test('initial sweep queues each unsynced thread once and remembers completion', async () => {
  const service = new InitialMessageSweepService({ tickMs: 1, jitterMs: 0, userQuietMs: 1, startDelayMs: 0 });
  const queued = [];
  service.configure({
    listThreads: () => [{ id: 'a' }, { id: 'b' }],
    enqueue: (job) => { queued.push(job); return true; },
    isBusy: () => false,
    isReady: () => true
  });

  assert.equal(service.start('account-1'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(queued.map((job) => job.thread_id), ['a', 'b']);
  assert.equal(service.start('account-1'), false);
  assert.equal(queued.every((job) => job.reason === 'initial_sweep' && job.allow_navigation === true), true);
  service.stop('account-1');
});

test('forced initial sweep can run again after completion', async () => {
  const service = new InitialMessageSweepService({ tickMs: 1, jitterMs: 0, startDelayMs: 0 });
  let count = 0;
  service.configure({
    listThreads: () => [{ id: 'a' }],
    enqueue: () => { count += 1; return true; },
    isBusy: () => false,
    isReady: () => true
  });
  service.start('account-1');
  await new Promise((resolve) => setTimeout(resolve, 20));
  service.start('account-1', { force: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(count, 2);
  service.stop('account-1');
});

test('initial sweep partitions threads into page and personal lanes with priority sorting', async () => {
  const service = new InitialMessageSweepService({ tickMs: 1, jitterMs: 0, userQuietMs: 1, startDelayMs: 0 });
  const queuedByLane = new Map();
  service.configure({
    listThreads: () => [
      { id: 'p1_read_with_msg', page_id: 'page-1', is_unread: 0, message_count: 5, last_activity: 100 },
      { id: 'p1_unread', page_id: 'page-1', is_unread: 1, message_count: 2, last_activity: 50 },
      { id: 'p1_empty_msg', page_id: 'page-1', is_unread: 0, message_count: 0, last_activity: 80 },
      { id: 'personal_thread', page_id: null, is_unread: 1, message_count: 0, last_activity: 200 },
      { id: 'p2_thread', page_id: 'page-2', is_unread: 0, message_count: 1, last_activity: 300 }
    ],
    enqueue: (job) => {
      const lk = job.lane_key;
      if (!queuedByLane.has(lk)) queuedByLane.set(lk, []);
      queuedByLane.get(lk).push(job.thread_id);
      return true;
    },
    isBusy: () => false,
    isReady: () => true
  });

  assert.equal(service.start('account-1'), true);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify Page-1 prioritized unread first, then empty message count, then latest activity
  assert.deepEqual(queuedByLane.get('page:page-1'), ['p1_unread', 'p1_empty_msg', 'p1_read_with_msg']);
  // Verify Page-2 lane
  assert.deepEqual(queuedByLane.get('page:page-2'), ['p2_thread']);
  // Verify Personal lane
  assert.deepEqual(queuedByLane.get('personal:account-1'), ['personal_thread']);

  service.stop('account-1');
});

test('initial sweep re-arms automatically when newly discovered threads appear after completion', async () => {
  const service = new InitialMessageSweepService({ tickMs: 1, jitterMs: 0, userQuietMs: 1, startDelayMs: 0 });
  let currentThreads = [{ id: 't1', page_id: 'page-1' }];
  const queued = [];
  service.configure({
    listThreads: () => currentThreads,
    enqueue: (job) => { queued.push(job.thread_id); return true; },
    isBusy: () => false,
    isReady: () => true
  });

  assert.equal(service.start('account-1'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(queued, ['t1']);

  // Call start again with no new threads: should return false (no-op)
  assert.equal(service.start('account-1'), false);
  assert.deepEqual(queued, ['t1']);

  // A new thread 't2' is discovered
  currentThreads = [{ id: 't1', page_id: 'page-1' }, { id: 't2', page_id: 'page-1' }];
  // Re-start without force: should detect t2 and re-arm
  assert.equal(service.start('account-1'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(queued, ['t1', 't2']);

  service.stop('account-1');
});

