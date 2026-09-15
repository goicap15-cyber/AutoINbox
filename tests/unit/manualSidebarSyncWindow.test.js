const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('sidebar polling is opt-in for one minute and the icon can stop it early', () => {
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  const sidebar = fs.readFileSync('src/client/components/ConversationSidebar.jsx', 'utf8');
  const scheduler = fs.readFileSync('src/server/services/InboxSyncScheduler.js', 'utf8');
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.equal(app.includes('SET_SIDEBAR_SYNC_WINDOW'), true);
  assert.equal(app.includes('duration_ms: 60000'), true);
  assert.equal(app.includes('sidebarSyncActive && socket && isConnected'), true);
  assert.equal(sidebar.includes('onToggleSidebarSync'), true);
  assert.equal(sidebar.includes('sidebarSyncSecondsRemaining'), true);
  assert.equal(scheduler.includes('syncEnabledUntil: 0'), true);
  assert.equal(scheduler.includes('startSyncWindow(accountId, durationMs = 60000)'), true);
  assert.equal(scheduler.includes('stopSyncWindow(accountId'), true);
  assert.equal(server.includes("socket.on('SET_SIDEBAR_SYNC_WINDOW'"), true);
});

test('turning polling off closes only discovery and requests tabs', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.equal(background.includes('async function closeSidebarSyncTabs(accountId)'), true);
  assert.equal(background.includes("for (const roleName of ['discovery', 'requests'])"), true);
  assert.equal(background.includes("case 'SET_SIDEBAR_SYNC_WINDOW'"), true);
  assert.equal(background.includes('pendingDiscoveryScans.delete(syncAccountKey)'), true);
});
