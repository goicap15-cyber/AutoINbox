const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('a superseded extension socket cannot delete its healthy replacement', () => {
  const source = fs.readFileSync('src/server/server.js', 'utf8');
  const marker = `ws.on('close'`;
  const closeHandler = source.slice(source.indexOf(marker), source.indexOf('// Socket.io:', source.indexOf(marker)));
  assert.match(closeHandler, /extensionConnections\.get\(ws\.accountId\) !== ws/);
  assert.match(closeHandler, /extensionConnections\.delete\(ws\.accountId\)/);
});

test('send timeout reports failure without reloading the extension', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const extension = fs.readFileSync('src/extension/background.js', 'utf8');
  const sendStart = server.indexOf('async function sendViaExtension');
  const sendEnd = server.indexOf('function enqueueCampaignMessage', sendStart);
  const sendHandler = server.slice(sendStart, sendEnd);
  const commandStart = extension.indexOf(`case 'SEND_MESSAGE'`);
  const commandEnd = extension.indexOf(`case 'SEND_QUEUED_MESSAGE'`, commandStart);
  const commandHandler = extension.slice(commandStart, commandEnd);
  assert.doesNotMatch(sendHandler, /type: 'RELOAD_EXTENSION'/);
  assert.match(sendHandler, /error_code: 'EXTENSION_ACK_TIMEOUT'/);
  assert.match(commandHandler, /await handleSendMessage\(message\.data\)/);
  assert.doesNotMatch(commandHandler, /Promise\.race|runtime\.reload|TEXT_HANDLER_TIMEOUT/);
});

test('optional chat prewarm cannot occupy the serialized send chain', () => {
  const extension = fs.readFileSync('src/extension/background.js', 'utf8');
  const start = extension.indexOf(`case 'PREPARE_CHAT_THREAD'`);
  const end = extension.indexOf(`case 'SEND_MESSAGE'`, start);
  const handler = extension.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(handler, /runPersonalSendSerialized|ensureTabOnThread/);
});

test('direct sends use the original non-destructive websocket wait', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const sendStart = server.indexOf('async function sendViaExtension');
  const sendEnd = server.indexOf('function deleteOutboundMessageRows', sendStart);
  const sendHandler = server.slice(sendStart, sendEnd);
  assert.match(sendHandler, /extensionConnections\.get\(thread\.account_id\)/);
  assert.match(sendHandler, /Date\.now\(\) - startWait < 8000/);
  assert.doesNotMatch(sendHandler, /requireResponsiveExtension|probeExtensionConnection|recoverExtensionConnection/);
});

test('an old extension socket cannot clear a newer connected socket', () => {
  const extension = fs.readFileSync('src/extension/background.js', 'utf8');
  const connectStart = extension.indexOf('function connectWebSocket()');
  const connectEnd = extension.indexOf('// Facebook can issue c_user/xs', connectStart);
  const connectHandler = extension.slice(connectStart, connectEnd);
  assert.match(connectHandler, /let socket = null;[\s\S]+?socket = new WebSocket\(targetWsUrl\)/);
  assert.match(connectHandler, /socket\.onclose = \(event\) => \{[\s\S]+?if \(ws !== socket\) return;/);
  assert.match(connectHandler, /socket\.onerror = \(err\) => \{[\s\S]+?if \(ws !== socket\) return;/);
});

test('desktop startup never kills Chrome because a worker heartbeat is late', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const start = server.indexOf('function startServer()');
  const end = server.indexOf('module.exports =', start);
  const startHandler = server.slice(start, end);
  assert.doesNotMatch(server, /function startExtensionHealthMonitor|EXTENSION_HEARTBEAT_STALE_MS/);
  assert.doesNotMatch(startHandler, /forceExtensionReload|recoverExtensionConnection|probeExtensionConnection/);
});

test('queued media uses the existing websocket without destructive recovery', () => {
  const worker = fs.readFileSync('src/server/services/QueueWorker.js', 'utf8');
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.doesNotMatch(worker, /getResponsiveConnection/);
  assert.match(worker, /this\.getExtensionConnection\(message\.account_id\)/);
  assert.doesNotMatch(server, /getResponsiveConnection: \(accountId\)/);
  assert.match(server, /queueWorker\.configure\(\{[\s\S]+?database: db/);
});
