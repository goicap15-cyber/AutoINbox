'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripSyncReasonSuffix } = require('../../src/extension/messengerTabRoles');

test('strips _extension_replay suffix (the mass-failure case)', () => {
  assert.equal(stripSyncReasonSuffix('initial_sweep_extension_replay'), 'initial_sweep');
  assert.equal(stripSyncReasonSuffix('crm_navigation_extension_replay'), 'crm_navigation');
});

test('strips plain _replay suffix (possibly repeated)', () => {
  assert.equal(stripSyncReasonSuffix('history_retry_replay'), 'history_retry');
  assert.equal(stripSyncReasonSuffix('initial_sweep_replay_replay'), 'initial_sweep');
});

test('leaves allowed base reasons untouched', () => {
  assert.equal(stripSyncReasonSuffix('initial_sweep'), 'initial_sweep');
  assert.equal(stripSyncReasonSuffix('crm_navigation'), 'crm_navigation');
  assert.equal(stripSyncReasonSuffix('history_retry'), 'history_retry');
  assert.equal(stripSyncReasonSuffix('sidebar_incoming'), 'sidebar_incoming');
});

test('handles empty and null safely', () => {
  assert.equal(stripSyncReasonSuffix(''), '');
  assert.equal(stripSyncReasonSuffix(null), '');
  assert.equal(stripSyncReasonSuffix(undefined), '');
});
