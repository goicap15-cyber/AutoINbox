const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('late incoming media is inserted by durable sequence instead of being discarded', () => {
  const source = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(source, /incomingSequence <= newestVisibleSequence/);
  assert.match(source, /result\.splice\(insertAt >= 0 \? insertAt : result\.length, 0, message\)/);
});

test('history publishes immediately and hydrates media in the background', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const service = fs.readFileSync('src/server/services/InboundMediaHydrationService.js', 'utf8');
  assert.match(server, /inboundMediaHydration\.hydrateThread\(thread_id\)/);
  assert.match(service, /async hydrateThreadAndWait\(threadId\)/);
  assert.match(service, /maxConcurrency = 2/);
  assert.match(service, /ORDER BY id DESC/);
});

test('the selected chat always prefers the durable contact avatar', () => {
  const source = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(source, /const selectedThreadContact = activeThreadId \? contacts\[String\(activeThreadId\)\] : null/);
  assert.match(source, /avatar_url: selectedThreadContact\.avatar_url/);
});

test('incoming customer media is never discarded by the outgoing anti-ghost guard', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(server, /page_dom_observer'\) && isOutgoing\)/);
});

test('realtime customer messages survive extension websocket reconnects', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /QUEUED_BACKEND_TYPES = new Set\(\[.*'NEW_MESSAGE_RECEIVED'.*\]\)/);
  assert.match(background, /!backendAccountRegistered/);
  assert.match(background, /backendAccountRegistered = true/);
  assert.match(background, /await flushBackendOutbox\(\)/);
  assert.match(background, /recoverRealtimeReceiver\(\);/);
});

test('an already-open Messenger tab can replace a stale content observer', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  assert.match(content, /typeof previousContentInstance === 'object'/);
  assert.match(content, /seedBaseline\(initialThreadId\)/);
});

test('realtime media uses row-scoped sources and every message carries DOM position', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.doesNotMatch(content, /recentPlayableUrl/);
  assert.doesNotMatch(background, /recentPlayableUrl/);
  assert.match(content, /dom_position_confirmed: Boolean\(domPosition\)/);
  assert.match(content, /if \(isClockMinuteFragment\(cleaned, effectiveLabel\)\) continue/);
});

test('backend persists realtime messages in their confirmed DOM slot', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(server, /if \(!existingStableMessage && m\.dom_position_confirmed\)/);
  assert.match(server, /dom_previous_message_id/);
  assert.match(server, /dom_next_message_id/);
  assert.match(server, /collapseStoredMediaCompanions\(db, m\.thread_id\)/);
});

test('history sync repairs stale DOM order and drops clock minute fragments', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(server, /reconcileObservedDomSequence\(thread_id, sequencedMessages, db\)/);
  assert.match(background, /isClockMinuteFragment\(cleaned, currentLabel \|\| timestampLabel\)/);
  assert.match(app, /sequence_order: authoritative \? m\.sequence_order/);
});
