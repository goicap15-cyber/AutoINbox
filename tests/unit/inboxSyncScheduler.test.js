const test = require('node:test');
const assert = require('node:assert/strict');
const schedulerSingleton = require('../../src/server/services/InboxSyncScheduler');
const { InboxSyncScheduler } = schedulerSingleton;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('default lightweight inbox fallback targets near-realtime delivery', () => {
  const scheduler = new InboxSyncScheduler();
  assert.equal(scheduler.sidebarIntervalMs, 350);
  assert.equal(scheduler.sidebarCooldownMs, 250);
  assert.equal(scheduler.requestsIntervalMs, 15000);
});

test('account registration dispatches the first realtime inbox scan immediately', () => {
  const wsMessages = [];
  const ws = { readyState: 1, send: (payload) => wsMessages.push(JSON.parse(payload)) };
  const scheduler = new InboxSyncScheduler();
  scheduler.configure({ getConnection: () => ws, dispatchThreadMessagesSync: () => false });
  scheduler.registerAccount('acc');
  assert.equal(wsMessages.length, 1);
  assert.equal(wsMessages[0].type, 'SYNC_THREADS');
  assert.equal(wsMessages[0].data.scan_mode, 'realtime');
  scheduler.markSidebarResult('acc');
  scheduler.unregisterAccount('acc');
});

test('viewport scroll delta reaches the extension dispatcher', () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 1, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job); return true; } });
  scheduler.enqueueThreadSync({
    account_id: 'acc',
    thread_id: 'thread',
    reason: 'crm_scroll_viewport',
    sync_mode: 'ondemand_viewport',
    scroll_delta: -640,
    priority: 'high'
  });
  assert.equal(dispatched[0]?.scroll_delta, -640);
  scheduler.markThreadSyncResult('acc', 'thread');
  scheduler.unregisterAccount('acc');
});

test('rapid viewport gestures are accumulated while Messenger sync is in flight', async () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 1, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job); return true; } });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'thread', reason: 'crm_scroll_viewport', sync_mode: 'ondemand_viewport', scroll_delta: -300, priority: 'high' });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'thread', reason: 'crm_scroll_viewport', sync_mode: 'ondemand_viewport', scroll_delta: -400, priority: 'high' });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'thread', reason: 'crm_scroll_viewport', sync_mode: 'ondemand_viewport', scroll_delta: -500, priority: 'high' });
  scheduler.markThreadSyncResult('acc', 'thread');
  await wait(40);
  assert.equal(dispatched[1]?.scroll_delta, -900);
  scheduler.markThreadSyncResult('acc', 'thread');
  scheduler.unregisterAccount('acc');
});

test('in-flight thread change is replayed after the current sync result', async () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 5, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job); return true; } });
  assert.equal(scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'thread', reason: 'first' }), true);
  assert.equal(scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'thread', reason: 'changed' }), false);
  assert.equal(dispatched.length, 1);
  await wait(8);
  scheduler.markThreadSyncResult('acc', 'thread');
  await wait(15);
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1].reason, /replay/);
  scheduler.markThreadSyncResult('acc', 'thread');
  scheduler.unregisterAccount('acc');
});

test('account queue remains single-flight while different threads wait', async () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 1, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job.thread_id); return true; } });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'one' });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'two' });
  assert.deepEqual(dispatched, ['one']);
  scheduler.markThreadSyncResult('acc', 'one');
  await wait(40);
  assert.deepEqual(dispatched, ['one', 'two']);
  scheduler.markThreadSyncResult('acc', 'two');
  scheduler.unregisterAccount('acc');
});

test('manual navigation can preempt a stale conversation without its late result releasing the new job', async () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 1, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job.thread_id); return true; } });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'old' });
  assert.equal(scheduler.preemptActiveThreadSync('acc', (job) => job.thread_id === 'old'), 1);
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'new', priority: 'high' });
  assert.deepEqual(dispatched, ['old', 'new']);
  scheduler.markThreadSyncResult('acc', 'old');
  assert.equal(scheduler.isAccountThreadBusy('acc'), true);
  scheduler.markThreadSyncResult('acc', 'new');
  assert.equal(scheduler.isAccountThreadBusy('acc'), false);
  scheduler.unregisterAccount('acc');
});

test('high priority navigation can switch away and immediately back despite thread cooldown', () => {
  const dispatched = [];
  const scheduler = new InboxSyncScheduler({ threadCooldownMs: 30000, threadTimeoutMs: 200 });
  scheduler.configure({ getConnection: () => null, dispatchThreadMessagesSync: (job) => { dispatched.push(job.thread_id); return true; } });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'a', priority: 'high' });
  scheduler.preemptActiveThreadSync('acc', (job) => job.thread_id === 'a');
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'b', priority: 'high' });
  scheduler.preemptActiveThreadSync('acc', (job) => job.thread_id === 'b');
  assert.equal(scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'a', priority: 'high' }), true);
  assert.deepEqual(dispatched, ['a', 'b', 'a']);
  scheduler.unregisterAccount('acc');
});

test('realtime sidebar polling continues while history crawl owns the account', async () => {
  const wsMessages = [];
  const dispatchedThreads = [];
  const ws = { readyState: 1, send: (payload) => wsMessages.push(JSON.parse(payload)) };
  const scheduler = new InboxSyncScheduler({ sidebarCooldownMs: 1, threadCooldownMs: 1, threadTimeoutMs: 200 });
  scheduler.configure({
    getConnection: () => ws,
    dispatchThreadMessagesSync: (job) => { dispatchedThreads.push(job.thread_id); return true; }
  });
  scheduler.enqueueThreadSync({ account_id: 'acc', thread_id: 'history' });
  assert.equal(scheduler.requestSidebarSync('acc', 'scheduler_realtime', { scanMode: 'realtime' }), true);
  assert.deepEqual(dispatchedThreads, ['history']);
  assert.equal(wsMessages.length, 1);
  assert.equal(wsMessages[0]?.data?.scan_mode, 'realtime');
  assert.equal(wsMessages[0]?.data?.time_budget_ms, 5000);
  scheduler.markSidebarResult('acc');
  scheduler.markThreadSyncResult('acc', 'history');
});

test('lightweight request polling reaches the extension with a bounded budget', () => {
  const wsMessages = [];
  const ws = { readyState: 1, send: (payload) => wsMessages.push(JSON.parse(payload)) };
  const scheduler = new InboxSyncScheduler({ sidebarCooldownMs: 1 });
  scheduler.configure({ getConnection: () => ws, dispatchThreadMessagesSync: () => false });
  assert.equal(scheduler.requestSidebarSync('acc', 'scheduler_requests', { scanMode: 'realtime_requests' }), true);
  assert.equal(wsMessages[0]?.data?.scan_mode, 'realtime_requests');
  assert.equal(wsMessages[0]?.data?.time_budget_ms, 30000);
  scheduler.markSidebarResult('acc');
  scheduler.unregisterAccount('acc');
});

test('opening the waiting tab queues a request scan behind the active inbox scan', async () => {
  const wsMessages = [];
  const ws = { readyState: 1, send: (payload) => wsMessages.push(JSON.parse(payload)) };
  const scheduler = new InboxSyncScheduler({ sidebarCooldownMs: 1 });
  scheduler.configure({ getConnection: () => ws, dispatchThreadMessagesSync: () => false });
  assert.equal(scheduler.requestSidebarSync('acc', 'scheduler_realtime', { scanMode: 'realtime' }), true);
  assert.equal(scheduler.requestMessageRequestsSync('acc'), false);
  scheduler.markSidebarResult('acc');
  await wait(40);
  assert.equal(wsMessages[1]?.data?.scan_mode, 'realtime_requests');
  scheduler.markSidebarResult('acc');
  scheduler.unregisterAccount('acc');
});
