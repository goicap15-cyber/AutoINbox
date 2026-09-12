const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

test('T009: luồng xử lý PAGE_THREAD_MESSAGES_SYNCED_V1, ACK và idempotency', () => {
  const tmpDbPath = path.join(__dirname, `tmp_test_batch_${Date.now()}.db`);
  const db = new Database(tmpDbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        contact_name TEXT,
        sync_status TEXT,
        unread_count INTEGER DEFAULT 0,
        last_activity TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        fb_message_id TEXT UNIQUE,
        client_message_id TEXT,
        sender_id TEXT NOT NULL,
        content TEXT,
        media_type TEXT DEFAULT 'text',
        media_url TEXT,
        is_outgoing BOOLEAN NOT NULL DEFAULT 0,
        sender_role TEXT DEFAULT 'customer',
        sequence_order INTEGER,
        direction_status TEXT DEFAULT 'confirmed',
        is_unsent BOOLEAN DEFAULT 0,
        timestamp_ms INTEGER,
        timestamp_source TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    db.prepare("INSERT INTO threads (id, account_id, contact_name, sync_status) VALUES ('thread_p1', 'acc_1', 'Khách Page', 'SYNCED')").run();

    const envelope1 = {
      thread_id: 'thread_p1',
      account_id: 'acc_1',
      page_id: 'page_100',
      session_epoch: 'epoch_uuid_1',
      generation: 1,
      scan_id: 'scan_uuid_1',
      batch_sequence: 1,
      mode: 'page_initial',
      messages: [
        {
          fb_message_id: 'p_msg_1',
          content: 'Chào shop',
          media_type: 'text',
          is_outgoing: false,
          sender_id: 'CONTACT',
          sender_role: 'customer',
          direction_status: 'confirmed',
          direction_confidence: 'high',
          dom_order: 0,
          timestamp_ms: 1787114500000,
          timestamp_source: 'facebook_label'
        },
        {
          fb_message_id: 'p_msg_2',
          content: 'Tư vấn giúp em',
          media_type: 'text',
          is_outgoing: false,
          sender_id: 'CONTACT',
          sender_role: 'customer',
          direction_status: 'confirmed',
          direction_confidence: 'high',
          dom_order: 1,
          timestamp_ms: 1787114510000,
          timestamp_source: 'facebook_label'
        }
      ]
    };

    // 1. Process batch lần 1
    const ack1 = ConversationRepository.processPageBatchEnvelope(envelope1, db);
    assert.equal(ack1.status, 'committed');
    assert.equal(ack1.persisted_count, 2);

    const rows = db.prepare('SELECT fb_message_id, sequence_order FROM messages WHERE thread_id = ? ORDER BY sequence_order ASC').all('thread_p1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].sequence_order, 1);
    assert.equal(rows[1].sequence_order, 2);

    // 2. Gửi lại cùng scan_id (Idempotency) -> trả về duplicate
    const ackDuplicate = ConversationRepository.processPageBatchEnvelope(envelope1, db);
    assert.equal(ackDuplicate.status, 'duplicate');

    // 3. Gửi batch với generation cũ hơn (Stale-drop)
    const staleEnvelope = {
      ...envelope1,
      scan_id: 'scan_uuid_2',
      generation: 0 // Generation cũ
    };
    const ackStale = ConversationRepository.processPageBatchEnvelope(staleEnvelope, db);
    assert.equal(ackStale.status, 'rejected');
  } finally {
    db.close();
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  }
});
