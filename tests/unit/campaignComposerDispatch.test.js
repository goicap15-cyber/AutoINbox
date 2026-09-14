const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const MessageQueueRepository = require('../../src/server/repositories/MessageQueueRepository');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_queue (
      id TEXT PRIMARY KEY, thread_id TEXT, campaign_id TEXT,
      status TEXT, error_reason TEXT, processed_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, thread_id TEXT, client_message_id TEXT,
      fb_message_id TEXT, is_outgoing INTEGER, delivery_status TEXT,
      delivery_error TEXT
    );
  `);
  return db;
}

test('composer dispatch settles a campaign queue and stops its CRM bubble spinner', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO message_queue VALUES ('q1', 'thread-1', 'campaign-1', 'processing', NULL, CURRENT_TIMESTAMP);
    INSERT INTO messages VALUES (1, 'thread-1', 'queue_q1', 'pending_queue_q1', 1, 'pending', NULL);
  `);
  const result = MessageQueueRepository.confirmCampaignComposerDispatch('q1', db);
  assert.equal(result.client_message_id, 'queue_q1');
  assert.equal(db.prepare('SELECT status FROM message_queue WHERE id = ?').get('q1').status, 'sent');
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id = 1').get().delivery_status, 'sent');
  db.close();
});

test('composer dispatch does not auto-confirm a non-campaign queue', () => {
  const db = createDb();
  db.exec(`INSERT INTO message_queue VALUES ('q1', 'thread-1', NULL, 'processing', NULL, CURRENT_TIMESTAMP)`);
  assert.equal(MessageQueueRepository.confirmCampaignComposerDispatch('q1', db), null);
  assert.equal(db.prepare('SELECT status FROM message_queue WHERE id = ?').get('q1').status, 'processing');
  db.close();
});
