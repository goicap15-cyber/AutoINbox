const test = require('node:test');
const assert = require('node:assert/strict');
const processManagerModule = require('../../src/server/services/ProcessManager');
const { ProcessManager, closeChromePidsGracefullySync } = processManagerModule;

function createManager() {
  // Use `new ProcessManager()` to get a fully initialized instance
  // (processes, hideTimers, etc.) and then override only what we need.
  const manager = new ProcessManager();
  manager.processes = new Map();
  manager.hideTimers = new Map();
  // Stub expensive resource-path helpers so tests run without the filesystem
  manager.binChromePath = 'stub';
  manager.extensionPath = 'stub';
  return manager;
}

test('ProcessManager: isProcessAlive correctly detects dead pid', () => {
  const manager = createManager();
  // PID 1 should exist on Linux/Windows; PID 999999999 almost certainly doesn't
  assert.equal(manager.isProcessAlive(999999999), false);
  assert.equal(manager.isProcessAlive(null), false);
  assert.equal(manager.isProcessAlive(undefined), false);
});

test('ProcessManager: getStatus cleans up dead process entry and returns STOPPED', () => {
  const manager = createManager();
  // Alive process: status = 'RUNNING', PID reused as manager's own pid (always alive)
  const ownPid = process.pid;
  manager.processes.set('acc-alive', { pid: ownPid, status: 'RUNNING', displayMode: 'VISIBLE' });
  assert.equal(manager.getStatus('acc-alive'), 'RUNNING');

  // Dead process: PID that definitely doesn't exist
  manager.processes.set('acc-dead', { pid: 999999999, status: 'RUNNING', displayMode: 'BACKGROUND' });
  assert.equal(manager.getStatus('acc-dead'), 'STOPPED');
  assert.equal(manager.processes.has('acc-dead'), false, 'Dead process entry should be removed');
});

test('ProcessManager: getDisplayMode returns display state for alive process, STOPPED for dead', () => {
  const manager = createManager();
  const ownPid = process.pid;
  manager.processes.set('acc-vis', { pid: ownPid, status: 'RUNNING', displayMode: 'VISIBLE' });
  manager.processes.set('acc-bg', { pid: ownPid, status: 'RUNNING', displayMode: 'BACKGROUND' });
  manager.processes.set('acc-dead', { pid: 999999999, status: 'RUNNING', displayMode: 'BACKGROUND' });

  assert.equal(manager.getDisplayMode('acc-vis'), 'VISIBLE');
  assert.equal(manager.getDisplayMode('acc-bg'), 'BACKGROUND');
  assert.equal(manager.getDisplayMode('acc-dead'), 'STOPPED');
  assert.equal(manager.getDisplayMode('acc-missing'), 'STOPPED');
});

test('ProcessManager: minimizeAccountForSync preserves BACKGROUND, changes VISIBLE to SYNC_MINIMIZED', () => {
  const manager = createManager();
  const ownPid = process.pid;
  manager.processes.set('acc-visible', { pid: ownPid, status: 'RUNNING', displayMode: 'VISIBLE' });
  manager.processes.set('acc-bg', { pid: ownPid, status: 'RUNNING', displayMode: 'BACKGROUND' });

  // VISIBLE -> SYNC_MINIMIZED (real PowerShell call is mocked by platform check)
  const res1 = manager.minimizeAccountForSync('acc-visible');
  assert.equal(res1, true);
  // On non-Windows or when PowerShell is fire-and-forget, displayMode is set synchronously
  const mode1 = manager.processes.get('acc-visible')?.displayMode;
  assert.ok(mode1 === 'SYNC_MINIMIZED', `Expected SYNC_MINIMIZED, got ${mode1}`);

  // BACKGROUND stays BACKGROUND (no PowerShell call needed)
  const res2 = manager.minimizeAccountForSync('acc-bg');
  assert.equal(res2, true);
  assert.equal(manager.processes.get('acc-bg')?.displayMode, 'BACKGROUND');
});

test('ProcessManager: hideAccountProcess returns error for dead process and removes stale entry', async () => {
  const manager = createManager();
  manager.processes.set('acc-dead', { pid: 999999999, displayMode: 'VISIBLE' });

  const result = await manager.hideAccountProcess('acc-dead');
  assert.equal(result.success, false);
  assert.equal(result.error, 'CHROME_PROCESS_DEAD');
  assert.equal(manager.processes.has('acc-dead'), false, 'Dead entry should be removed from map');

  const noEntry = await manager.hideAccountProcess('acc-nonexistent');
  assert.equal(noEntry.success, false);
  assert.equal(noEntry.error, 'CHROME_NOT_RUNNING');
});

test('ProcessManager: unhideWindow returns error for dead process and removes stale entry', async () => {
  const manager = createManager();
  manager.processes.set('acc-dead', { pid: 999999999, displayMode: 'BACKGROUND' });

  const result = await manager.unhideWindow('acc-dead');
  assert.equal(result.success, false);
  assert.equal(result.error, 'CHROME_PROCESS_DEAD');
  assert.equal(manager.processes.has('acc-dead'), false);

  const noEntry = await manager.unhideWindow('acc-nonexistent');
  assert.equal(noEntry.success, false);
  assert.equal(noEntry.error, 'CHROME_NOT_RUNNING');
});

test('Auto-hide request lifecycle: background=true registers, background=false clears', () => {
  const backgroundAfterConnectRequests = new Map();
  const backgroundAfterConnectTimers = new Map();

  const clearAutoBg = (accId) => {
    backgroundAfterConnectRequests.delete(accId);
    const t = backgroundAfterConnectTimers.get(accId);
    if (t) {
      clearTimeout(t);
      backgroundAfterConnectTimers.delete(accId);
    }
  };

  const simulateStart = (accId, background) => {
    clearAutoBg(accId);
    if (background) {
      backgroundAfterConnectRequests.set(accId, Date.now());
      backgroundAfterConnectTimers.set(accId, setTimeout(() => {}, 10000));
    }
  };

  // 1. Start with background = true
  simulateStart('acc-99', true);
  assert.equal(backgroundAfterConnectRequests.has('acc-99'), true);
  assert.equal(backgroundAfterConnectTimers.has('acc-99'), true);

  // 2. User clicks "Hiện Chrome" or start with background = false
  simulateStart('acc-99', false);
  assert.equal(backgroundAfterConnectRequests.has('acc-99'), false);
  assert.equal(backgroundAfterConnectTimers.has('acc-99'), false);
});

test('ProcessManager: concurrent hide and unhide serializes and supersedes older operation', async () => {
  const manager = createManager();
  const ownPid = process.pid;
  manager.processes.set('acc-race', { pid: ownPid, status: 'RUNNING', displayMode: 'BACKGROUND' });

  // Simulate an in-flight operation using _enqueueDisplayOp:
  // Op 1 (hide) simulates a slow operation (50ms)
  // Op 2 (unhide) starts immediately after (10ms)
  let op1Completed = false;
  let op2Completed = false;

  const p1 = manager._enqueueDisplayOp('acc-race', async (opToken) => {
    await new Promise((r) => setTimeout(r, 50));
    if (manager.displayOpTokens.get('acc-race') === opToken) {
      manager.processes.get('acc-race').displayMode = 'BACKGROUND';
      op1Completed = true;
      return { success: true };
    }
    return { success: false, error: 'OPERATION_SUPERSEDED' };
  });

  const p2 = manager._enqueueDisplayOp('acc-race', async (opToken) => {
    await new Promise((r) => setTimeout(r, 10));
    if (manager.displayOpTokens.get('acc-race') === opToken) {
      manager.processes.get('acc-race').displayMode = 'VISIBLE';
      op2Completed = true;
      return { success: true };
    }
    return { success: false, error: 'OPERATION_SUPERSEDED' };
  });

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.success, false, 'Op 1 should fail because it was superseded by Op 2');
  assert.equal(res1.error, 'OPERATION_SUPERSEDED');
  assert.equal(op1Completed, false, 'Op 1 should not commit its state');

  assert.equal(res2.success, true, 'Op 2 should succeed');
  assert.equal(op2Completed, true, 'Op 2 should commit its state');
  assert.equal(manager.processes.get('acc-race').displayMode, 'VISIBLE', 'Final displayMode must be VISIBLE');
});

test('ProcessManager: stopAccountProcess supersedes any pending display operation', async () => {
  const manager = createManager();
  manager.processes.set('acc-stop', { status: 'RUNNING', displayMode: 'BACKGROUND' });

  const p1 = manager._enqueueDisplayOp('acc-stop', async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { success: true };
  });

  // User calls stop while display op is pending
  manager.stopAccountProcess('acc-stop');

  const res1 = await p1;
  assert.equal(res1.success, false);
  assert.equal(res1.error, 'OPERATION_SUPERSEDED');
});

test('REGISTER_ACCOUNT auto-hide flow emits ACCOUNT_DISPLAY_CHANGED', async () => {
  const emitted = [];
  const fakeIo = {
    emit: (event, payload) => emitted.push({ event, payload })
  };

  const fakeProcessManager = {
    hideAccountProcess: async () => ({ success: true })
  };

  const backgroundAfterConnectRequests = new Map();
  const backgroundAfterConnectTimers = new Map();
  const KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE = false;

  const account_id = '10001234';
  backgroundAfterConnectRequests.set(String(account_id), Date.now());

  // Simulate REGISTER_ACCOUNT auto-hide branch
  const backgroundRequestedAt = backgroundAfterConnectRequests.get(String(account_id));
  const backgroundRequestIsFresh = Number.isFinite(backgroundRequestedAt)
    && Date.now() - backgroundRequestedAt < 120000;
  const pending_key = null;

  if (!pending_key && backgroundRequestIsFresh && !KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE) {
    backgroundAfterConnectRequests.delete(String(account_id));
    if (backgroundAfterConnectTimers.has(String(account_id))) {
      clearTimeout(backgroundAfterConnectTimers.get(String(account_id)));
      backgroundAfterConnectTimers.delete(String(account_id));
    }
    const hideResult = await fakeProcessManager.hideAccountProcess(account_id);
    if (hideResult?.success) {
      fakeIo.emit('ACCOUNT_DISPLAY_CHANGED', {
        account_id: String(account_id),
        chrome_display_mode: 'BACKGROUND',
        is_chrome_running: true
      });
    }
  }

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'ACCOUNT_DISPLAY_CHANGED');
  assert.deepEqual(emitted[0].payload, {
    account_id: '10001234',
    chrome_display_mode: 'BACKGROUND',
    is_chrome_running: true
  });
});

test('CHECKPOINT_DETECTED flow unhides window and emits ACCOUNT_DISPLAY_CHANGED', async () => {
  const emitted = [];
  const fakeIo = {
    emit: (event, payload) => emitted.push({ event, payload })
  };

  let unhideCalled = false;
  const fakeProcessManager = {
    unhideWindow: async () => {
      unhideCalled = true;
      return { success: true };
    }
  };

  const account_id = '10005678';

  // Simulate CHECKPOINT_DETECTED handler
  const unhideRes = await fakeProcessManager.unhideWindow(account_id);
  if (unhideRes?.success) {
    fakeIo.emit('ACCOUNT_DISPLAY_CHANGED', {
      account_id: String(account_id),
      chrome_display_mode: 'VISIBLE',
      is_chrome_running: true
    });
  }
  fakeIo.emit('ACCOUNT_STATUS_CHANGED', { account_id, status: 'CHECKPOINT' });

  assert.equal(unhideCalled, true);
  const displayChanged = emitted.find((e) => e.event === 'ACCOUNT_DISPLAY_CHANGED');
  assert.ok(displayChanged);
  assert.deepEqual(displayChanged.payload, {
    account_id: '10005678',
    chrome_display_mode: 'VISIBLE',
    is_chrome_running: true
  });
});

test('Topbar ChatHeader toggle error handling logic alerts on API failure', async () => {
  let alertedMessage = null;
  const mockAlert = (msg) => { alertedMessage = msg; };

  const simulateToggle = async ({ ok, dataSuccess, errorText, isChromeHidden }) => {
    const res = { ok };
    const data = { success: dataSuccess, error: errorText };
    if (!res.ok || !data?.success) {
      const errorMsg = data?.error || (isChromeHidden ? 'Không thể hiện cửa sổ Chrome' : 'Không thể ẩn cửa sổ Chrome');
      mockAlert(errorMsg);
    }
  };

  await simulateToggle({ ok: true, dataSuccess: false, errorText: 'NO_WINDOW_FOUND', isChromeHidden: true });
  assert.equal(alertedMessage, 'NO_WINDOW_FOUND');

  await simulateToggle({ ok: false, dataSuccess: false, errorText: null, isChromeHidden: false });
  assert.equal(alertedMessage, 'Không thể ẩn cửa sổ Chrome');
});

test('closeChromePidsGracefullySync trên non-win32 trả về mảng rỗng', async () => {
  const origPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const res = closeChromePidsGracefullySync([12345], 100);
    assert.deepEqual(res, []);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
  }
});

test('ProcessManager: stopAccountProcess với PID đã chết trả về true và dọn entry', () => {
  const manager = createManager();
  manager.processes.set('acc-dead2', { pid: 999999999, status: 'RUNNING', displayMode: 'VISIBLE' });
  const res = manager.stopAccountProcess('acc-dead2');
  assert.equal(res, true);
  assert.equal(manager.processes.has('acc-dead2'), false);
});

test('ProcessManager: hideAccountProcess and unhideWindow success path updates displayMode', async () => {
  const manager = createManager();
  const ownPid = process.pid;
  manager.processes.set('acc-live', { pid: ownPid, status: 'RUNNING', displayMode: 'VISIBLE' });

  const origPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const hideRes = await manager.hideAccountProcess('acc-live');
    assert.equal(hideRes.success, true);
    assert.equal(manager.processes.get('acc-live').displayMode, 'BACKGROUND');

    const unhideRes = await manager.unhideWindow('acc-live');
    assert.equal(unhideRes.success, true);
    assert.equal(manager.processes.get('acc-live').displayMode, 'VISIBLE');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
  }
});


