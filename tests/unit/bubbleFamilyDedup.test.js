const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

test('each Facebook bubble occurrence is preserved even when grouped content repeats', () => {
  const rows = [
    { id: 1, fb_message_id: 'mid.abc', content: 'hello', is_outgoing: 0, media_type: 'text' },
    { id: 2, fb_message_id: 'mid.abc__bubble_1', content: 'hello', is_outgoing: 0, media_type: 'text' },
    { id: 3, fb_message_id: 'mid.abc__bubble_2', content: 'different', is_outgoing: 0, media_type: 'text' }
  ];
  assert.deepEqual(ConversationRepository.dedupeBubbleFamilyMessages(rows).map((row) => row.id), [1, 2, 3]);
});

test('history persistence stores a distinct grouped bubble occurrence', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, client_message_id TEXT, sender_id TEXT, content TEXT, media_type TEXT, media_url TEXT, timestamp_ms INTEGER, timestamp_source TEXT, is_outgoing INTEGER, sender_role TEXT, sequence_order REAL, direction_status TEXT, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, content, media_type, timestamp_ms, timestamp_source, is_outgoing, sender_role, direction_status, created_at) VALUES ('t1', 'mid.abc', 'hello', 'text', 1000, 'facebook_label', 0, 'customer', 'confirmed', '2026-01-01T00:00:00Z')`).run();
  const result = ConversationRepository.saveMessagesTransaction('t1', [{
    fb_message_id: 'mid.abc__bubble_1', content: 'hello', media_type: 'text',
    timestamp_ms: 1001, timestamp_source: 'dom_order', is_outgoing: false,
    direction_status: 'confirmed', created_at: '2026-01-01T00:00:00.001Z'
  }], db);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 2);
  assert.deepEqual(result.insertedIds, ['mid.abc__bubble_1']);
  db.close();
});

test('identical text, like and video occurrences in one native family are never collapsed', () => {
  const rows = [
    { id: 1, fb_message_id: 'mid.text', content: 'c', is_outgoing: 0, media_type: 'text' },
    { id: 2, fb_message_id: 'mid.text__bubble_1', content: 'c', is_outgoing: 0, media_type: 'text' },
    { id: 3, fb_message_id: 'mid.text__bubble_2', content: 'c', is_outgoing: 0, media_type: 'text' },
    { id: 4, fb_message_id: 'mid.like', content: '👍', is_outgoing: 0, media_type: 'text' },
    { id: 5, fb_message_id: 'mid.like__bubble_1', content: '👍', is_outgoing: 0, media_type: 'text' },
    { id: 6, fb_message_id: 'mid.video', content: '', is_outgoing: 0, media_type: 'video' },
    { id: 7, fb_message_id: 'mid.video__bubble_1', content: '', is_outgoing: 0, media_type: 'video' }
  ];
  assert.deepEqual(ConversationRepository.dedupeBubbleFamilyMessages(rows).map((row) => row.id),
    [1, 2, 3, 4, 5, 6, 7]);
});

test('authoritative history promotes a sidebar preview without duplicating it', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, client_message_id TEXT, sender_id TEXT, content TEXT, media_type TEXT, media_url TEXT, timestamp_ms INTEGER, timestamp_source TEXT, is_outgoing INTEGER, sender_role TEXT, sequence_order REAL, direction_status TEXT, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, content, media_type, timestamp_ms, timestamp_source, is_outgoing, sender_role, direction_status, created_at) VALUES ('t1', 'sidebar_preview_x', 'reply now', 'text', 100000, 'sidebar_preview', 0, 'customer', 'confirmed', '2026-01-01T00:00:00Z')`).run();
  const result = ConversationRepository.saveMessagesTransaction('t1', [{
    fb_message_id: 'mid.real', content: 'reply now', media_type: 'text',
    timestamp_ms: 100500, timestamp_source: 'facebook_label', is_outgoing: false,
    direction_status: 'confirmed', created_at: '2026-01-01T00:00:00.500Z'
  }], db);
  assert.deepEqual(db.prepare('SELECT fb_message_id, content FROM messages').all(), [{ fb_message_id: 'mid.real', content: 'reply now' }]);
  assert.deepEqual(result.updatedIds, ['mid.real']);
  db.close();
});

test('native and DOM observations of the same text or image reuse one row', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, client_message_id TEXT, sender_id TEXT, content TEXT, media_type TEXT, media_url TEXT, timestamp_ms INTEGER, timestamp_source TEXT, is_outgoing INTEGER, sender_role TEXT, sequence_order REAL, direction_status TEXT, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, content, media_type, media_url, timestamp_ms, is_outgoing) VALUES ('t1', 'dom_t1_hash_1_0', 'hello', 'text', NULL, 100000, 0), ('t1', 'dom_t1_hash_2_0', '', 'image', 'https://cdn/image.jpg', 200000, 0)`).run();
  ConversationRepository.saveMessagesTransaction('t1', [
    { fb_message_id: 'mid.text', content: 'hello', media_type: 'text', timestamp_ms: 100500, is_outgoing: false },
    { fb_message_id: 'mid.image', content: '', media_type: 'image', media_url: 'https://cdn/image.jpg', timestamp_ms: 200500, is_outgoing: false }
  ], db);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 2);
  db.close();
});

test('stale sidebar regression after a newer outbound is not a new incoming message', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, client_message_id TEXT, sender_id TEXT, content TEXT, media_type TEXT, media_url TEXT, timestamp_ms INTEGER, timestamp_source TEXT, is_outgoing INTEGER, sender_role TEXT, sequence_order REAL, direction_status TEXT, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, content, media_type, timestamp_ms, is_outgoing) VALUES ('t1', 'mid.in', 'Vggghghg', 'text', 1000, 0), ('t1', 'mid.out', '', 'image', 2000, 1)`).run();
  assert.equal(ConversationRepository.hasNewerOutgoingAfterMatchingIncoming('t1', 'Vggghghg', db), true);
  assert.equal(ConversationRepository.hasNewerOutgoingAfterMatchingIncoming('t1', 'nội dung mới', db), false);
  db.close();
});

test('detects only a recent exact outbound text as a possible sidebar echo', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, content TEXT, media_type TEXT, timestamp_ms INTEGER, is_outgoing INTEGER, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, content, media_type, timestamp_ms, is_outgoing, created_at) VALUES
    ('t1', 'same text', 'text', 190000, 1, '1970-01-01T00:03:10.000Z'),
    ('t1', 'old text', 'text', 1000, 1, '1970-01-01T00:00:01.000Z'),
    ('t2', 'same text', 'text', 190000, 1, '1970-01-01T00:03:10.000Z')`).run();
  const options = { nowMs: 200000, windowMs: 120000, futureToleranceMs: 1 };
  assert.equal(ConversationRepository.hasRecentMatchingOutgoing('t1', 'same text', db, options), true);
  assert.equal(ConversationRepository.hasRecentMatchingOutgoing('t1', 'old text', db, options), false);
  assert.equal(ConversationRepository.hasRecentMatchingOutgoing('t1', 'different', db, options), false);
  db.close();
});

test('normalization uses DOM sequence inside the same Facebook minute', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, timestamp_ms INTEGER, sequence_order REAL, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, timestamp_ms, sequence_order) VALUES
    ('t1', 'image', 60003, 1), ('t1', 'Ggy', 60000, 2), ('t1', 'Uuuuuu', 60000, 3), ('t1', 'Frtt', 60000, 4)`).run();
  ConversationRepository.normalizeMessageSequence('t1', db);
  assert.deepEqual(db.prepare('SELECT fb_message_id FROM messages ORDER BY sequence_order').all().map((row) => row.fb_message_id),
    ['image', 'Ggy', 'Uuuuuu', 'Frtt']);
  db.close();
});

test('a later partial scan cannot move an already stored customer text', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, client_message_id TEXT, sender_id TEXT, content TEXT, media_type TEXT, media_url TEXT, timestamp_ms INTEGER, timestamp_source TEXT, is_outgoing INTEGER, sender_role TEXT, sequence_order REAL, direction_status TEXT, created_at TEXT)`);
  ConversationRepository.saveMessagesTransaction('t1', [{
    fb_message_id: 'mid.customer', content: 'Vggggg', media_type: 'text',
    timestamp_ms: 1000, timestamp_source: 'dom_order', sequence_order: 4,
    is_outgoing: false, direction_status: 'confirmed', created_at: '2026-01-01T00:00:01Z'
  }], db);
  ConversationRepository.saveMessagesTransaction('t1', [{
    fb_message_id: 'mid.customer', content: 'Vggggg', media_type: 'text',
    timestamp_ms: 1000, timestamp_source: 'dom_order', sequence_order: 99,
    is_outgoing: false, direction_status: 'confirmed', created_at: '2026-01-01T00:00:01Z'
  }], db);
  assert.equal(db.prepare(`SELECT sequence_order FROM messages WHERE fb_message_id = 'mid.customer'`).get().sequence_order, 4);
  db.close();
});

test('an authoritative Messenger DOM window repairs stale relative sequence slots', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, fb_message_id TEXT UNIQUE, timestamp_ms INTEGER, sequence_order REAL, created_at TEXT)`);
  db.prepare(`INSERT INTO messages (id, thread_id, fb_message_id, timestamp_ms, sequence_order) VALUES
    (1, 't1', 'older', 60000, 1),
    (2, 't1', 'outgoing_text', 60000, 2),
    (3, 't1', 'incoming_one', 60000, 3),
    (4, 't1', 'incoming_two', 60000, 4),
    (5, 't1', 'mid.video', 60000, 5),
    (6, 't1', 'newer', 60000, 6)`).run();

  const changed = ConversationRepository.reconcileObservedDomSequence('t1', [
    { fb_message_id: 'incoming_one' },
    { fb_message_id: 'incoming_two' },
    // The _media row may already have been collapsed into mid.video.
    { fb_message_id: 'mid.video_media' },
    { fb_message_id: 'outgoing_text' }
  ], db);

  assert.equal(changed, 4);
  assert.deepEqual(db.prepare('SELECT fb_message_id FROM messages ORDER BY sequence_order, id').all().map((row) => row.fb_message_id),
    ['older', 'incoming_one', 'incoming_two', 'mid.video', 'outgoing_text', 'newer']);
  db.close();
});
