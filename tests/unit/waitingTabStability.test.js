const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('waiting tab clears stale chat and ignores out-of-order list responses', () => {
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(app, /const threadListRequestVersionRef = useRef\(0\)/);
  assert.match(app, /activeTabRef\.current !== requestedTab/);
  assert.match(app, /setActiveThreadId\(null\);[\s\S]+?setThreads\(\[\]\);[\s\S]+?setActiveTab\(normalizedTab\)/);
  assert.match(app, /REQUEST_SYNC_MESSAGE_REQUESTS/);
});

test('realtime thread events are scoped to the visible inbox folder', () => {
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(app, /const relevantSyncedThreads = syncedThreads\.filter\(belongsToCurrentTab\)/);
  assert.match(server, /const emittedThreads = isRealtimeSidebarHint/);
});
