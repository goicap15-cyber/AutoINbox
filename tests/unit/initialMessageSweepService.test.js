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
