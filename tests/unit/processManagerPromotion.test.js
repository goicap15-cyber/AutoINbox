const test = require('node:test');
const assert = require('node:assert/strict');
const processManagerModule = require('../../src/server/services/ProcessManager');
const { ProcessManager } = processManagerModule;

test('promoting a pending profile stops the old account process and removes pending alias', () => {
  const manager = Object.create(ProcessManager.prototype);
  const oldEntry = { pid: 101, profileDir: 'old-profile' };
  const pendingEntry = { pid: 202, profileDir: 'pending-profile' };
  manager.processes = new Map([
    ['account-1', oldEntry],
    ['pending-1', pendingEntry]
  ]);
  const stopped = [];
  manager.stopAccountProcess = (accountId) => {
    stopped.push(accountId);
    const pid = manager.processes.get(accountId)?.pid;
    for (const [key, entry] of manager.processes) {
      if (entry.pid === pid) manager.processes.delete(key);
    }
    return true;
  };

  assert.equal(manager.promotePendingProcess('pending-1', 'account-1'), true);
  assert.deepEqual(stopped, ['account-1']);
  assert.equal(manager.processes.has('pending-1'), false);
  assert.equal(manager.processes.get('account-1'), pendingEntry);
});
