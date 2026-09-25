'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

function setupFullTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE inbox_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      owner_account_id TEXT,
      external_id TEXT NOT NULL,
      display_name TEXT
    );

    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      external_thread_id TEXT,
      account_id TEXT NOT NULL,
      source_id TEXT,
      thread_url TEXT,
      contact_name TEXT,
      last_message TEXT,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_unread INTEGER,
      inbox_folder TEXT
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      fb_message_id TEXT UNIQUE,
      client_message_id TEXT,
      sender_id TEXT,
      sender_role TEXT,
      content TEXT,
      media_type TEXT,
      media_url TEXT,
      timestamp_ms INTEGER,
      timestamp_source TEXT,
      is_outgoing INTEGER,
      sequence_order INTEGER,
      direction_status TEXT,
      created_at DATETIME,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
  `);

  return db;
}

function makeEnvelope(overrides = {}) {
  return {
    thread_id: '100018089229407',
    account_id: 'acc_fb_1',
    page_id: '1209772058877160',
    source_id: 'src_page_1209772058877160',
    contact_name: 'Nguyễn Văn A',
    session_epoch: 'epoch_1',
    generation: 1,
    scan_id: 'scan_1',
    mode: 'page_initial',
    messages: [],
    ...overrides
  };
}

function makeMessage(overrides = {}) {
  return {
    fb_message_id: 'mid.x',
    sender_id: '100018089229407',
    content: 'hello',
    media_type: 'text',
    media_url: null,
    is_outgoing: false,
    timestamp_ms: 1700000000000,
    timestamp_source: 'dom_order',
    dom_order: 0,
    ...overrides
  };
}

test('T010: caption "video"/"ảnh" của media sống sót qua ingest; duration rác vẫn bị lọc', () => {
  const db = setupFullTestDb();
  try {
    const ack = ConversationRepository.processPageBatchEnvelope(makeEnvelope({
      messages: [
        makeMessage({ fb_message_id: 'mid.cap1', media_type: 'video', media_url: 'https://cdn.example.com/v1.mp4', content: 'video' }),
        makeMessage({ fb_message_id: 'mid.cap2', media_type: 'video', media_url: 'https://cdn.example.com/v2.mp4', content: 'ảnh' }),
        makeMessage({ fb_message_id: 'mid.cap3', media_type: 'video', media_url: 'https://cdn.example.com/v3.mp4', content: '0:00 / 0:19' }),
        makeMessage({ fb_message_id: 'mid.cap4', media_type: 'video', media_url: 'https://cdn.example.com/v4.mp4', content: '0:19' }),
        makeMessage({ fb_message_id: 'mid.cap5', media_type: 'image', media_url: 'https://cdn.example.com/i1.jpg', content: 'ảnh' }),
        makeMessage({ fb_message_id: 'mid.cap6', media_type: 'image', media_url: 'https://cdn.example.com/i2.jpg', content: 'video' })
      ]
    }), db);

    assert.equal(ack.status, 'committed');

    const row = (id) => db.prepare('SELECT content, media_type FROM messages WHERE fb_message_id = ?').get(id);
    assert.equal(row('mid.cap1').content, 'video', 'caption chữ "video" của video phải được giữ');
    assert.equal(row('mid.cap2').content, 'ảnh', 'caption chữ "ảnh" của video phải được giữ');
    assert.equal(row('mid.cap3').content, null, 'duration "0:00 / 0:19" phải bị lọc');
    assert.equal(row('mid.cap4').content, null, 'duration "0:19" phải bị lọc');
    assert.equal(row('mid.cap5').content, 'ảnh', 'caption chữ "ảnh" của ảnh phải được giữ');
    assert.equal(row('mid.cap6').content, 'video', 'caption chữ "video" của ảnh phải được giữ');
  } finally {
    db.close();
  }
});

test('T011: dom_order không bao giờ ghi đè timestamp đã tồn tại khi cào lại (re-stamp drift)', () => {
  const db = setupFullTestDb();
  try {
    const t1 = new Date('2026-09-19T10:00:00Z').getTime();

    // Lần cào đầu: tin A được stamp giờ cào dom_order = t1
    const ack1 = ConversationRepository.processPageBatchEnvelope(makeEnvelope({
      scan_id: 'scan_first',
      messages: [
        makeMessage({ fb_message_id: 'mid.driftA', content: 'tin cũ 19/09', timestamp_ms: t1, dom_order: 0 }),
        makeMessage({ fb_message_id: 'mid.driftB', content: 'tin kế tiếp', timestamp_ms: t1 + 1000, dom_order: 1 })
      ]
    }), db);
    assert.equal(ack1.status, 'committed');

    // Lần cào lại sau đó 6 tiếng: DOM vẫn mount tin A -> extension gửi lại
    // timestamp_ms = giờ cào MỚI (dom_order), chênh t1 hàng giờ
    const t2 = t1 + 6 * 3600 * 1000;
    const ack2 = ConversationRepository.processPageBatchEnvelope(makeEnvelope({
      scan_id: 'scan_rescan',
      messages: [
        makeMessage({ fb_message_id: 'mid.driftA', content: 'tin cũ 19/09', timestamp_ms: t2, dom_order: 0 }),
        makeMessage({ fb_message_id: 'mid.driftC', content: 'tin mới phát sinh', timestamp_ms: t2 + 1000, dom_order: 1 })
      ]
    }), db);
    assert.equal(ack2.status, 'committed');

    const rowA = db.prepare('SELECT timestamp_ms, timestamp_source FROM messages WHERE fb_message_id = ?').get('mid.driftA');
    assert.equal(rowA.timestamp_ms, t1, 'timestamp thật của tin cũ phải được bảo toàn, không bị giờ cào mới đè');
    assert.equal(rowA.timestamp_source, 'dom_order');

    const rowC = db.prepare('SELECT timestamp_ms FROM messages WHERE fb_message_id = ?').get('mid.driftC');
    assert.equal(rowC.timestamp_ms, t2 + 1000, 'tin mới chưa từng có vẫn nhận stamp dom_order bình thường');
  } finally {
    db.close();
  }
});

test('T012: shouldUpgradeTimestamp chặn drift dom_order nhưng vẫn cho rank cao hơn / giờ chưa có qua', () => {
  const t1 = new Date('2026-09-19T10:00:00Z').getTime();
  const t2 = t1 + 6 * 3600 * 1000;

  // Cùng rank dom_order, chênh hàng giờ -> KHÔNG upgrade (bug 2026-09-24)
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('dom_order', 'dom_order', t1, t2), false);

  // realtime fallback/delta vẫn bị chặn như cũ
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('realtime_fallback', 'realtime_fallback', t1, t2), false);

  // Existing chưa có giờ (unknown/0) -> nhận dom_order (rank 1 -> 2)
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('unknown', 'dom_order', 0, t2), true);

  // dom_order được thay bằng nguồn tin cậy hơn (facebook_label) -> upgrade bình thường
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('dom_order', 'facebook_label', t1, t2), true);

  // Cùng rank tin cậy, chênh >= 30s -> upgrade bình thường
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('facebook_label', 'facebook_label', t1, t2), true);
});
