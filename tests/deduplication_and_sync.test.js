const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ConversationRepository = require('../src/server/repositories/ConversationRepository');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      external_thread_id TEXT,
      account_id TEXT,
      source_id TEXT,
      thread_url TEXT,
      contact_name TEXT DEFAULT 'Khách hàng',
      last_message TEXT,
      is_unread INTEGER DEFAULT 1,
      inbox_folder TEXT DEFAULT 'INBOX',
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      fb_message_id TEXT UNIQUE,
      client_message_id TEXT,
      sender_id TEXT,
      content TEXT,
      media_type TEXT DEFAULT 'text',
      media_url TEXT,
      local_media_path TEXT,
      attachment_id TEXT,
      timestamp_ms INTEGER,
      timestamp_source TEXT DEFAULT 'unknown',
      is_outgoing INTEGER DEFAULT 0,
      sender_role TEXT,
      sequence_order INTEGER,
      delivery_status TEXT DEFAULT 'sent',
      direction_status TEXT DEFAULT 'confirmed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

test('1. Sending same text from CRM creates exactly ONE database row', () => {
  const db = createTestDb();
  const threadId = 'thread_crm_test';

  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // 1a. CRM creates optimistic pending row
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status, direction_status, timestamp_ms)
    VALUES (?, ?, ?, 'STAFF', 'Xin chào khách hàng!', 1, 'pending', 'confirmed', ?)
  `).run(threadId, 'pending_client_1001', 'pending_client_1001', Date.now());

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Initially 1 pending row');

  // 1b. Confirmation arrives from DOM/Facebook with official ID mid.1001
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.1001',
    client_message_id: 'pending_client_1001',
    sender_id: 'STAFF',
    content: 'Xin chào khách hàng!',
    is_outgoing: true,
    timestamp_ms: Date.now(),
    source: 'dom_observer'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must still be 1 row after DOM confirmation');
  assert.equal(rows[0].content, 'Xin chào khách hàng!');
});

test('2. Sending same text from Facebook creates exactly ONE database row across multiple sources', () => {
  const db = createTestDb();
  const threadId = 'thread_fb_test';

  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // 2a. Realtime network frame arrives
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.fb_msg_2002',
    sender_id: 'CONTACT',
    content: 'Shop tư vấn giúp mình với',
    is_outgoing: false,
    timestamp_ms: 1700000000000,
    timestamp_source: 'realtime_fallback',
    source: 'realtime'
  }], db);

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, '1 row after realtime frame');

  // 2b. DOM observer scrapes same message with dom_hash ID
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'dom_thread_fb_test_hash_9999_1',
    sender_id: 'CONTACT',
    content: 'Shop tư vấn giúp mình với',
    is_outgoing: false,
    timestamp_ms: 1700000000050,
    timestamp_source: 'dom_order',
    source: 'dom_observer'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must remain 1 row after DOM observer scan');

  // 2c. History sync re-scrapes same message
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.fb_msg_2002',
    sender_id: 'CONTACT',
    content: 'Shop tư vấn giúp mình với',
    is_outgoing: false,
    timestamp_ms: 1700000000000,
    timestamp_source: 'facebook_label',
    source: 'history'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must remain 1 row after history sync');
});

test('3. Video sending creates video row only without duplicate text bubbles', () => {
  const db = createTestDb();
  const threadId = 'thread_video_test';

  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // Video send from CRM / FB
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.video_3003',
    sender_id: 'STAFF',
    content: '',
    media_type: 'video',
    media_url: 'https://video.mp4',
    is_outgoing: true,
    timestamp_ms: Date.now(),
    source: 'crm_composer'
  }], db);

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, '1 video row');
  assert.equal(rows[0].media_type, 'video');

  // DOM observer sends companion _media or empty text node
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.video_3003_media',
    sender_id: 'STAFF',
    content: '',
    media_type: 'video',
    media_url: 'https://video.mp4',
    is_outgoing: true,
    timestamp_ms: Date.now(),
    source: 'dom_observer'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must remain 1 row (no extra text bubble)');
});

test('4. History sync returning same message multiple times creates zero duplicate rows', () => {
  const db = createTestDb();
  const threadId = 'thread_history_test';

  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  const batch = [
    { fb_message_id: 'mid.h1', content: 'Tin 1', is_outgoing: false, timestamp_ms: 1000, source: 'history' },
    { fb_message_id: 'mid.h2', content: 'Tin 2', is_outgoing: true, timestamp_ms: 2000, source: 'history' },
    { fb_message_id: 'mid.h3', content: 'Tin 3', is_outgoing: false, timestamp_ms: 3000, source: 'history' },
  ];

  // First sync pass
  ConversationRepository.saveMessagesTransaction(threadId, batch, db);
  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 3, '3 rows inserted on first pass');

  // Second sync pass with same batch
  ConversationRepository.saveMessagesTransaction(threadId, batch, db);
  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 3, 'Must remain 3 rows after second pass');

  // Third sync pass with overlapping batch
  ConversationRepository.saveMessagesTransaction(threadId, [
    ...batch,
    { fb_message_id: 'mid.h4', content: 'Tin 4', is_outgoing: true, timestamp_ms: 4000, source: 'history' }
  ], db);
  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 4, 'Must be exactly 4 rows after inserting 1 new message');
});

test('5. Pending message gets official Facebook ID without inserting a new row', () => {
  const db = createTestDb();
  const threadId = 'thread_pending_upgrade_test';

  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // Insert pending client message
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status)
    VALUES (?, 'pending_client_5555', 'pending_client_5555', 'STAFF', 'Nội dung tin nhắn pending', 1, 'pending')
  `).run(threadId);

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, '1 pending row initially');
  assert.equal(rows[0].delivery_status, 'pending');

  // Official Facebook confirmation matches pending message
  const OutboundDomCorrelationService = require('../src/server/services/OutboundDomCorrelationService');
  const matched = OutboundDomCorrelationService.findTemporaryIdUpgrade(db, threadId, {
    fb_message_id: 'mid.official_5555',
    content: 'Nội dung tin nhắn pending',
    timestamp_ms: Date.now()
  });

  if (matched) {
    db.prepare(`
      UPDATE messages SET fb_message_id = ?, delivery_status = 'sent' WHERE id = ?
    `).run('mid.official_5555', matched.id);
  }

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must still be 1 row after ID upgrade');
  assert.equal(rows[0].fb_message_id, 'mid.official_5555');
  assert.equal(rows[0].delivery_status, 'sent');
});

test('6. Outgoing Page message with sidebar_preview_ is promoted to mid.$ without inserting duplicate row', () => {
  const db = createTestDb();
  const threadId = 'thread_page_outgoing_test';
  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // 6a. Sidebar preview captures outgoing message from Page
  const previewTime = Date.now();
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'sidebar_preview_thread_page_outgoing_test_hash_123',
    sender_id: 'PAGE',
    content: 'Dạ shop xin chào bạn!',
    is_outgoing: true,
    timestamp_ms: previewTime,
    source: 'sidebar_preview'
  }], db);

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Initially 1 sidebar preview row');
  assert.equal(rows[0].is_outgoing, 1);

  // 6b. Official Facebook mid arrives from main chat bubble sync
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.$cAAQWv0d54Lem1wFJumgpbxYQUHqQ',
    sender_id: 'PAGE',
    content: 'Dạ shop xin chào bạn!',
    is_outgoing: true,
    timestamp_ms: previewTime + 500,
    source: 'dom_observer'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must still be exactly 1 row in DB (promoted in-place)');
  assert.equal(rows[0].fb_message_id, 'mid.$cAAQWv0d54Lem1wFJumgpbxYQUHqQ');
});

test('7. Outgoing pending message without client_message_id in sync payload is upgraded in-place', () => {
  const db = createTestDb();
  const threadId = 'thread_pending_no_client_id_test';
  ConversationRepository.upsertThread({ id: threadId, account_id: 'acc_1' }, db);

  // 7a. Pending outgoing message created by CRM
  const sendTime = Date.now();
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status, timestamp_ms)
    VALUES (?, 'pending_client_7777', 'client_7777', 'STAFF', 'Nội dung chat kiểm tra x2', 1, 'pending', ?)
  `).run(threadId, sendTime);

  let rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Initially 1 pending row');

  // 7b. Facebook sync returns official mid but lacks client_message_id
  ConversationRepository.saveMessagesTransaction(threadId, [{
    fb_message_id: 'mid.$official_mid_7777',
    sender_id: 'STAFF',
    content: 'Nội dung chat kiểm tra x2',
    is_outgoing: true,
    timestamp_ms: sendTime + 200,
    source: 'facebook_sync'
  }], db);

  rows = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all(threadId);
  assert.equal(rows.length, 1, 'Must still be exactly 1 row (upgraded in-place)');
  assert.equal(rows[0].fb_message_id, 'mid.$official_mid_7777');
  assert.equal(rows[0].delivery_status, 'sent');
});

