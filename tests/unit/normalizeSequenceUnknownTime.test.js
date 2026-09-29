const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

function insertRow(db, id, ts, created, seq) {
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, sender_id, content, timestamp_ms, created_at, sequence_order)
              VALUES ('t1', ?, 's1', ?, ?, ?, ?)`).run(id, `tin ${id}`, ts, created, seq);
}

test('tin không có thời gian hợp lệ được xếp sau mọi tin có thời gian', () => {
  const db = getTestDatabase();
  try {
    db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc1', 'Acc 1', '/tmp')").run();
    db.prepare("INSERT INTO threads (id, account_id, contact_name) VALUES ('t1', 'acc1', 'Test')").run();
    // Tin hợp lệ 16/9 nhưng seq cũ lớn; tin hợp lệ 25/9 seq cũ nhỏ;
    // tin "mất thời gian" nằm giữa theo seq cũ.
    insertRow(db, 'mid.a_16', 1758000000000, '2026-09-16 08:00:00', 3);
    insertRow(db, 'mid.b_25', 1758800000000, '2026-09-25 08:00:00', 1);
    insertRow(db, 'mid.c_nots', 0, null, 2);

    ConversationRepository.normalizeMessageSequence('t1', db);

    const rows = db.prepare("SELECT fb_message_id, sequence_order FROM messages WHERE thread_id = 't1' ORDER BY sequence_order ASC").all();
    assert.deepEqual(rows.map(r => r.fb_message_id), ['mid.a_16', 'mid.b_25', 'mid.c_nots']);
    assert.deepEqual(rows.map(r => r.sequence_order), [1, 2, 3]);
  } finally {
    db.close();
  }
});

test('các tin không thời gian giữ nguyên thứ tự cũ trong nhóm của chúng', () => {
  const db = getTestDatabase();
  try {
    db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc1', 'Acc 1', '/tmp')").run();
    db.prepare("INSERT INTO threads (id, account_id, contact_name) VALUES ('t1', 'acc1', 'Test')").run();
    insertRow(db, 'mid.old', 1758000000000, '2026-09-16 08:00:00', 1);
    insertRow(db, 'mid.n1', 0, null, 4);
    insertRow(db, 'mid.n2', 0, null, 2);

    ConversationRepository.normalizeMessageSequence('t1', db);

    const rows = db.prepare("SELECT fb_message_id FROM messages WHERE thread_id = 't1' ORDER BY sequence_order ASC").all();
    assert.deepEqual(rows.map(r => r.fb_message_id), ['mid.old', 'mid.n2', 'mid.n1']);
  } finally {
    db.close();
  }
});
