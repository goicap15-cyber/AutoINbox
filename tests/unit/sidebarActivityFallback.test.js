const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('manifest installs the additive sidebar activity observer before the existing content observer', () => {
  const manifest = JSON.parse(fs.readFileSync('src/extension/manifest.json', 'utf8'));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const hintIndex = scripts.indexOf('sidebarActivityObserver.js');
  const contentIndex = scripts.indexOf('content.js');
  assert.ok(hintIndex >= 0);
  assert.ok(contentIndex > hintIndex);
});

test('sidebar observer fingerprints changes and debounces mutation bursts', () => {
  const observer = fs.readFileSync('src/extension/sidebarActivityObserver.js', 'utf8');
  assert.match(observer, /new MutationObserver\(schedule\)/);
  assert.match(observer, /fingerprint === lastFingerprint/);
  assert.match(observer, /setTimeout\(emitIfChanged, 140\)/);
  assert.match(observer, /setInterval\(emitIfChanged, 2500\)/);
  assert.match(observer, /type: 'SIDEBAR_ACTIVITY_HINT'/);
  assert.match(observer, /threads: activity\.threads/);
});

test('background reuses the existing sidebar parser for a non-terminal partial result', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /message\.type === 'SIDEBAR_ACTIVITY_HINT'/);
  assert.match(background, /func: scrapeFacebookSidebar/);
  assert.match(background, /parsedThreads\.length[\s\S]+?observedThreads/);
  assert.match(background, /canForwardRealtime\(role\)/);
  assert.match(background, /partial: true,[\s\S]+?sync_status: 'realtime_hint'/);
});

test('realtime hints update threads without completing or masking the legacy sync job', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const start = server.indexOf(`case 'SYNC_THREADS_RESULT'`);
  const end = server.indexOf(`case 'THREAD_MESSAGES_SYNCED'`, start);
  const handler = server.slice(start, end);
  assert.match(handler, /sync_status === 'realtime_hint' \|\| sync_status === 'realtime_requests'/);
  assert.match(handler, /if \(!isRealtimeSidebarHint\)[\s\S]+?FACEBOOK_SYNC_STATUS/);
  assert.match(handler, /if \(partial !== true\)[\s\S]+?markSidebarResult/);
  assert.match(handler, /io\.emit\('THREADS_SYNCED'/);
});

test('realtime discovery confirms a stable lazy-load tail before cycling to the top', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /if \(isRealtimeInboxScan && !target\.requestSection\) \{[\s\S]+?func: moveMessengerDiscoverySidebar[\s\S]+?args: \['step'\]/);
  assert.match(background, /realtimeMoveState\.atEnd[\s\S]+?await delay\(1400\)[\s\S]+?stalls >= 3[\s\S]+?args: \['restore'\]/);
  assert.match(background, /if \(!isRealtimeScan && !budgetExpired && !cancelled\)/);
});

test('request polling scans both request buttons in its own lightweight mode', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  const scheduler = fs.readFileSync('src/server/services/InboxSyncScheduler.js', 'utf8');
  assert.match(scheduler, /scanMode = fullDiscoveryDue \? 'full' : \(requestsDue \? 'realtime_requests' : 'realtime'\)/);
  assert.match(background, /const isRealtimeRequestScan = scan_mode === 'realtime_requests'/);
  assert.match(background, /\[role="tab"\], \[role="button"\], button, \[tabindex\]/);
  assert.match(background, /MESSAGE_REQUEST_POSSIBLE/);
  assert.match(background, /MESSAGE_REQUEST_SPAM/);
  assert.match(background, /const verifiedPrimary = primaryVisible\.filter/);
  assert.match(background, /rect\.left < Math\.min\(680, window\.innerWidth \* 0\.55\)/);
  assert.match(scheduler, /reason === 'scheduler_requests' \? 12000 : 30000/);
  assert.match(background, /\/messages\/requests\/spam\?crm_tab_role=requests/);
  assert.match(background, /People you may know/);
  assert.match(background, /isRealtimeRequestScan && Boolean\(target\.requestSection\)/);
  assert.match(background, /scan_mode === 'realtime' && activeDiscoveryAccountKey/);
  assert.match(background, /rect\.right > 0/);
  assert.match(background, /const scopedRequestIds = new Set/);
  assert.match(background, /scopedRequestIds\.has\(String\(thread\?\.thread_id/);
  assert.match(background, /e2ee\/requests\/t/);
});

test('sidebar scroll resolves the semantic left scroller and falls back to a trusted wheel', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.doesNotMatch(background, /const navContainer = null/);
  assert.match(background, /\[aria-label\*="Hội thoại" i\]/);
  assert.match(background, /scroller\.dataset\.crmDiscoveryScroller = 'true'/);
  assert.match(background, /moved: after !== before/);
  assert.match(background, /!realtimeMoveState\.moved && !realtimeMoveState\.atEnd/);
  assert.match(background, /dispatchTrustedHistoryWheel\([\s\S]+?realtimeMoveState\.point/);
  assert.match(background, /DISCOVERY_REALTIME\] trusted_scroll=/);
});
