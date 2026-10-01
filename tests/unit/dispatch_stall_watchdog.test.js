'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DispatchStallWatchdog } = require('../../src/server/services/DispatchStallWatchdog');

test('shouldProbe fires once when dispatches reach the stall limit', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 3 });
  wd.noteDispatch('acc');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), false, 'below limit');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true, 'at limit');
  assert.equal(wd.shouldProbe('acc'), false, 'already probing - fire once');
});

test('any sync result resets the stall counter (count=0 results count too)', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 2 });
  wd.noteDispatch('acc');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true);
  wd.noteResult('acc');
  assert.equal(wd.shouldProbe('acc'), false, 'reset clears both counter and probing');
  assert.equal(wd.shouldProbe('acc'), false);
});

test('probe ACK clears probing and the counter', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 1 });
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true);
  wd.noteProbeAck('acc');
  assert.equal(wd.shouldProbe('acc'), false);
  wd.noteDispatch('acc');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true, 'counter restarted from zero after ACK');
});

test('probe timeout ends the cycle; a fresh stall cycle probes again', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 2 });
  wd.noteDispatch('acc');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true);
  wd.probeTimedOut('acc');
  assert.equal(wd.shouldProbe('acc'), false, 'probe cycle consumed - recovery goes via late ACK or re-register');
  wd.noteDispatch('acc');
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true, 'new stall cycle probes again');
});

test('new registration resets everything', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 1 });
  wd.noteDispatch('acc');
  assert.equal(wd.shouldProbe('acc'), true);
  wd.noteRegistered('acc');
  assert.equal(wd.shouldProbe('acc'), false);
});

test('accounts are tracked independently and dispatches during probe do not grow the count', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 2 });
  wd.noteDispatch('a');
  wd.noteDispatch('b');
  assert.equal(wd.shouldProbe('a'), false);
  assert.equal(wd.shouldProbe('b'), false);
  wd.noteDispatch('a');
  assert.equal(wd.shouldProbe('a'), true);
  assert.equal(wd.shouldProbe('b'), false, 'b is below limit');
  wd.noteDispatch('a');
  assert.equal(wd.shouldProbe('a'), false, 'probing swallows further dispatches');
});

test('invalid account ids are ignored', () => {
  const wd = new DispatchStallWatchdog({ stallLimit: 1 });
  wd.noteDispatch('');
  wd.noteResult('');
  assert.equal(wd.shouldProbe(''), false);
});
