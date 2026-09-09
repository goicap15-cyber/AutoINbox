const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');
const { OUTBOUND_STATUS, OUTBOUND_ERROR_CODE, OutboundMessageService } = require('../../src/server/services/OutboundMessageService');

test('outbound state constants expose the safe lifecycle', () => {
  assert.deepEqual(OUTBOUND_STATUS, { PENDING: 'pending', SENT: 'sent', FAILED: 'failed' });
  assert.equal(OUTBOUND_ERROR_CODE.FACEBOOK_API_ERROR, 'FACEBOOK_API_ERROR');
});

test('safe diagnostics remove credentials without mutating input', () => {
  const input = { status: 200, token: 'secret', cookie: 'session', headers: { cookie: 'x', authorization: 'y' } };
  const safe = OutboundMessageService.safeDiagnostics(input);
  assert.equal(safe.status, 200);
  assert.equal(safe.token, undefined);
  assert.equal(safe.cookie, undefined);
  assert.equal(safe.headers.cookie, undefined);
  assert.equal(input.token, 'secret');
});

test('duplicate history event does not create a second outbound row', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  ConversationRepository.saveMessagesTransaction('thread-1', [{ fb_message_id: 'dom-1', sender_id: 'acct-1', content: 'hello', is_outgoing: true, timestamp_ms: 1000 }], db);
  ConversationRepository.saveMessagesTransaction('thread-1', [{ fb_message_id: 'dom-1', sender_id: 'acct-1', content: 'hello', is_outgoing: true, timestamp_ms: 1000 }], db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE fb_message_id = ?').get('dom-1').count, 1);
  db.close();
});

test('history replay with a changed synthetic DOM id reuses the existing row', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  ConversationRepository.saveMessagesTransaction('thread-1', [{ fb_message_id: 'dom_thread-1_hash_abc_4', content: 'old hello', is_outgoing: false, timestamp_ms: 100000 }], db);
  ConversationRepository.saveMessagesTransaction('thread-1', [{ fb_message_id: 'dom_thread-1_hash_abc_0', content: 'old hello', is_outgoing: false, timestamp_ms: 100010 }], db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND content = ?').get('thread-1', 'old hello').count, 1);
  db.close();
});

test('history timestamp never moves a thread backwards or to the current clock', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  db.prepare('UPDATE threads SET last_activity = ?, last_message = ? WHERE id = ?').run('2026-09-07T10:00:00.000Z', 'newer', 'thread-1');
  assert.equal(ConversationRepository.touchThreadFromHistory('thread-1', 'older', Date.parse('2026-09-06T10:00:00.000Z'), db), false);
  assert.equal(db.prepare('SELECT last_message FROM threads WHERE id = ?').get('thread-1').last_message, 'newer');
  assert.equal(ConversationRepository.touchThreadFromHistory('thread-1', 'newest', Date.parse('2026-09-07T11:00:00.000Z'), db), true);
  const updated = db.prepare('SELECT last_activity, last_message FROM threads WHERE id = ?').get('thread-1');
  assert.equal(updated.last_message, 'newest');
  assert.equal(Date.parse(updated.last_activity), Date.parse('2026-09-07T11:00:00.000Z'));
  db.close();
});

test('normalizing a multi-page history snapshot removes duplicate ranks and orders old messages first', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  ConversationRepository.saveMessagesTransaction('thread-1', [
    { fb_message_id: 'new-1', content: 'new', timestamp_ms: 3000, sequence_order: 1 },
    { fb_message_id: 'old-1', content: 'old', timestamp_ms: 1000, sequence_order: 1 },
    { fb_message_id: 'middle-1', content: 'middle', timestamp_ms: 2000, sequence_order: 17557 }
  ], db);

  assert.equal(ConversationRepository.normalizeMessageSequence('thread-1', db), 3);
  const rows = db.prepare('SELECT fb_message_id, sequence_order FROM messages WHERE thread_id = ? ORDER BY sequence_order').all('thread-1');
  assert.deepEqual(rows, [
    { fb_message_id: 'old-1', sequence_order: 1 },
    { fb_message_id: 'middle-1', sequence_order: 2 },
    { fb_message_id: 'new-1', sequence_order: 3 }
  ]);
  db.close();
});
