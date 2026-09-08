const test = require('node:test');
const assert = require('node:assert/strict');
const { isEnabled, isLoopbackAddress, isLocalDevRequest } = require('../../src/server/utils/localDevAccess');

test('local dev flags require an explicit true value', () => {
  assert.equal(isEnabled('true'), true);
  assert.equal(isEnabled(' TRUE '), true);
  assert.equal(isEnabled('false'), false);
  assert.equal(isEnabled(undefined), false);
});

test('local dev access accepts loopback addresses only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
});

test('local dev access requires both the flag and a loopback request', () => {
  const localRequest = { socket: { remoteAddress: '::1' } };
  const lanRequest = { socket: { remoteAddress: '192.168.1.20' } };
  assert.equal(isLocalDevRequest(localRequest, 'LOCAL_DEV_AUTH', { LOCAL_DEV_AUTH: 'true' }, false), true);
  assert.equal(isLocalDevRequest(localRequest, 'LOCAL_DEV_AUTH', {}, false), false);
  assert.equal(isLocalDevRequest(lanRequest, 'LOCAL_DEV_AUTH', { LOCAL_DEV_AUTH: 'true' }, false), false);
  assert.equal(isLocalDevRequest(localRequest, 'LOCAL_DEV_AUTH', { LOCAL_DEV_AUTH: 'true' }, true), false);
});
