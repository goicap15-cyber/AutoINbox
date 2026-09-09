const test = require('node:test');
const assert = require('node:assert/strict');
const Roles = require('../../src/extension/messengerTabRoles');

test('maps registered tabs to three independent personal roles', () => {
  const entries = [
    [Roles.roleKey('a1', 'interaction'), 11],
    [Roles.roleKey('a1', 'discovery'), 12],
    [Roles.roleKey('a1', 'history'), 13]
  ];
  assert.equal(Roles.roleForTab(entries, 'a1', 11), 'interaction');
  assert.equal(Roles.roleForTab(entries, 'a1', 12), 'discovery');
  assert.equal(Roles.roleForTab(entries, 'a1', 13), 'history');
});

test('legacy personal key remains the interaction role', () => {
  assert.equal(Roles.roleForTab([['personal:a1', 7]], 'a1', 7), 'interaction');
});

test('message-request actions use an isolated non-realtime tab', () => {
  const key = Roles.roleKey('a1', 'request_action');
  assert.equal(Roles.roleForTab([[key, 21]], 'a1', 21), 'request_action');
  assert.equal(Roles.canForwardRealtime('request_action'), false);
  assert.equal(Roles.canForwardCallRealtime('request_action'), false);
});

test('live interaction and discovery surfaces forward realtime events', () => {
  assert.equal(Roles.canForwardRealtime('interaction'), true);
  assert.equal(Roles.canForwardRealtime('discovery'), true);
  assert.equal(Roles.canForwardRealtime('history'), false);
  assert.equal(Roles.canForwardRealtime(null), false);
  assert.equal(Roles.canForwardCallRealtime('interaction'), true);
  assert.equal(Roles.canForwardCallRealtime('discovery'), true);
  assert.equal(Roles.canForwardCallRealtime('history'), false);
  assert.equal(Roles.canForwardCallRealtime('requests'), false);
  assert.equal(Roles.canForwardCallRealtime(null), false);
});

test('history surface never forwards remounted rows as realtime messages', () => {
  assert.equal(Roles.canForwardRealtime('history'), false);
  assert.equal(Roles.canForwardIncomingRealtime('history'), false);
  assert.equal(Roles.canForwardIncomingRealtime('requests'), false);
});
