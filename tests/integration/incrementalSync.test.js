const test = require('node:test');
const assert = require('node:assert/strict');
const HistorySyncManager = require('../../src/server/services/HistorySyncManager');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');
const { getTestDatabase } = require('../helpers/testDatabase');

test('Incremental Sync - cursor transitions retain checkpoint on failure', () => {
  const db = getTestDatabase();
  db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc_1', 'Acc 1', '/tmp')").run();
  db.prepare("INSERT INTO threads (id, account_id) VALUES ('thread_1', 'acc_1')").run();
  const cursor = { mode: 'incremental', newest_timestamp_ms: 1000, oldest_timestamp_ms: 500, newest_message_id: 'msg_10', oldest_message_id: 'msg_1' };
  assert.equal(HistorySyncManager.getSyncState('thread_1', db).sync_status, 'LOCAL');
  HistorySyncManager.updateSyncStatus('thread_1', 'SYNCED', cursor, null, db);
  assert.deepEqual(HistorySyncManager.getSyncState('thread_1', db).sync_cursor, cursor);
  HistorySyncManager.updateSyncStatus('thread_1', 'FAILED', null, 'timeout', db);
  const failed = HistorySyncManager.getSyncState('thread_1', db);
  assert.equal(failed.sync_status, 'FAILED');
  assert.equal(failed.sync_error, 'timeout');
  assert.deepEqual(failed.sync_cursor, cursor);
  db.close();
});

test('Incremental Sync - unchanged batches report skipped and do not duplicate', () => {
  const db = getTestDatabase();
  db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc_2', 'Acc 2', '/tmp')").run();
  db.prepare("INSERT INTO threads (id, account_id) VALUES ('thread_2', 'acc_2')").run();
  const batch = [
    { fb_message_id: 'msg_1', content: 'hello', timestamp_ms: 1000, sender_id: 'a' },
    { fb_message_id: 'msg_2', content: 'world', timestamp_ms: 2000, sender_id: 'a' }
  ];
  const first = ConversationRepository.saveMessagesTransaction('thread_2', batch, db);
  assert.deepEqual(first.insertedIds, ['msg_1', 'msg_2']);
  const second = ConversationRepository.saveMessagesTransaction('thread_2', batch, db);
  assert.equal(second.insertedIds.length, 0);
  assert.equal(second.updatedIds.length, 0);
  assert.equal(second.skippedCount, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = 'thread_2'").get().count, 2);
  db.close();
});

test('Incremental Sync - late fallback scan cannot move an accurately timestamped old message', () => {
  const db = getTestDatabase();
  db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc_3', 'Acc 3', '/tmp')").run();
  db.prepare("INSERT INTO threads (id, account_id) VALUES ('thread_3', 'acc_3')").run();
  ConversationRepository.saveMessagesTransaction('thread_3', [{
    fb_message_id: 'accurate_1', content: 'old', timestamp_ms: 1000,
    timestamp_source: 'facebook_label', created_at: new Date(1000).toISOString()
  }], db);
  const replay = ConversationRepository.saveMessagesTransaction('thread_3', [{
    fb_message_id: 'accurate_1', content: 'old', timestamp_ms: 999999,
    timestamp_source: 'fallback', created_at: new Date(999999).toISOString()
  }], db);
  const stored = db.prepare('SELECT timestamp_ms, timestamp_source FROM messages WHERE fb_message_id = ?').get('accurate_1');
  assert.equal(replay.updatedIds.length, 0);
  assert.equal(stored.timestamp_ms, 1000);
  assert.equal(stored.timestamp_source, 'facebook_label');
  db.close();
});

test('DOM sequence and sender role are persisted independently from timestamps', () => {
  const db = getTestDatabase();
  db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc_4', 'Acc 4', '/tmp')").run();
  db.prepare("INSERT INTO threads (id, account_id) VALUES ('thread_4', 'acc_4')").run();
  ConversationRepository.saveMessagesTransaction('thread_4', [
    { fb_message_id: 'm_customer', content: 'customer', timestamp_ms: 9000, sequence_order: 2, is_outgoing: false },
    { fb_message_id: 'm_operator', content: 'operator', timestamp_ms: 1000, sequence_order: 1, is_outgoing: true }
  ], db);
  const rows = ConversationRepository.getMessages('thread_4', 50, 0, db);
  assert.deepEqual(rows.map((row) => row.content), ['operator', 'customer']);
  assert.deepEqual(rows.map((row) => row.sender_role), ['operator', 'customer']);
  db.close();
});
