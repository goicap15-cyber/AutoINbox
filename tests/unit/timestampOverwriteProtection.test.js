const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

function setupThread(db) {
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
}

test('quét lại thiếu thời gian (ts <= 0) không xóa timestamp đã lưu', () => {
  const db = getTestDatabase();
  try {
    setupThread(db);
    ConversationRepository.saveMessagesTransaction('thread-1', [{
      fb_message_id: 'm1', content: 'tin cu', is_outgoing: false,
      timestamp_ms: 1000, timestamp_source: 'dom_order', created_at: '2026-09-16T10:00:00.000Z'
    }], db);
    // Lần quét sau không lấy được thời gian, lại có source "xịn" hơn
    ConversationRepository.saveMessagesTransaction('thread-1', [{
      fb_message_id: 'm1', content: 'tin cu', is_outgoing: false,
      timestamp_ms: 0, timestamp_source: 'facebook_label', created_at: '2026-09-28T11:00:00.000Z'
    }], db);
    const row = db.prepare('SELECT timestamp_ms, timestamp_source, created_at FROM messages WHERE fb_message_id = ?').get('m1');
    assert.equal(row.timestamp_ms, 1000);
    assert.equal(row.timestamp_source, 'dom_order');
    assert.equal(row.created_at, '2026-09-16T10:00:00.000Z');
  } finally {
    db.close();
  }
});

test('quét lại có thời gian hợp lệ + source xịn hơn thì được cập nhật', () => {
  const db = getTestDatabase();
  try {
    setupThread(db);
    ConversationRepository.saveMessagesTransaction('thread-1', [{
      fb_message_id: 'm1', content: 'tin cu', is_outgoing: false,
      timestamp_ms: 1000, timestamp_source: 'dom_order', created_at: '2026-09-16T10:00:00.000Z'
    }], db);
    ConversationRepository.saveMessagesTransaction('thread-1', [{
      fb_message_id: 'm1', content: 'tin cu', is_outgoing: false,
      timestamp_ms: 2000, timestamp_source: 'facebook_label', created_at: '2026-09-28T11:00:00.000Z'
    }], db);
    const row = db.prepare('SELECT timestamp_ms, timestamp_source FROM messages WHERE fb_message_id = ?').get('m1');
    assert.equal(row.timestamp_ms, 2000);
    assert.equal(row.timestamp_source, 'facebook_label');
  } finally {
    db.close();
  }
});
