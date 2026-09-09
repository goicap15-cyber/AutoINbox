const test = require('node:test');
const assert = require('node:assert/strict');
const SidebarSyncCooldown = require('../../src/server/services/SidebarSyncCooldown');

test('first registration is never in cooldown', () => {
  SidebarSyncCooldown._reset();
  assert.equal(SidebarSyncCooldown.isInCooldown('acc1', 1000), false);
});

test('a dispatch marks the account in cooldown for the configured window', () => {
  SidebarSyncCooldown._reset();
  SidebarSyncCooldown.markDispatched('acc1', 1000, 15000);
  assert.equal(SidebarSyncCooldown.isInCooldown('acc1', 1000), true);
  assert.equal(SidebarSyncCooldown.isInCooldown('acc1', 15999), true);
  assert.equal(SidebarSyncCooldown.isInCooldown('acc1', 16000), false, 'cooldown must expire exactly at the boundary');
});

test('cooldown is tracked per account, not globally', () => {
  SidebarSyncCooldown._reset();
  SidebarSyncCooldown.markDispatched('acc1', 1000, 15000);
  assert.equal(SidebarSyncCooldown.isInCooldown('acc2', 1000), false, 'a different account must not inherit acc1 cooldown');
});

test('remainingMs reports how long is left, zero once expired', () => {
  SidebarSyncCooldown._reset();
  SidebarSyncCooldown.markDispatched('acc1', 1000, 15000);
  assert.equal(SidebarSyncCooldown.remainingMs('acc1', 1000), 15000);
  assert.equal(SidebarSyncCooldown.remainingMs('acc1', 10000), 6000);
  assert.equal(SidebarSyncCooldown.remainingMs('acc1', 999999), 0);
});
