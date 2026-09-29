'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

function setupTestDb() {
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
    CREATE TABLE contacts (
      thread_id TEXT PRIMARY KEY,
      name TEXT,
      avatar_url TEXT,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
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

function orderedIds(db, threadId) {
  return db.prepare(`
    SELECT fb_message_id FROM messages
    WHERE thread_id = ? ORDER BY COALESCE(sequence_order, id) ASC, id ASC
  `).all(threadId).map((r) => r.fb_message_id);
}

// Damaged-state mirror (thread 61550030451525, 2026-09-28): every row carries
// a frozen separator-anchored stamp inside ONE minute bucket, and
// sequence_order was frozen from mixed scan waves - B and C swapped vs true
// DOM order. F is an unobserved fingerprint row (no fb id match).
function seedDamagedThread(db, threadId) {
  const T0 = 1780000000000;
  const rows = [
    ['mid.a', 'msg-a', T0, 1, 1],
    ['page_orphan_f_1', 'sys-event', T0 + 10, 2, 0],
    ['mid.c', 'msg-c', T0 + 40, 3, 1],
    ['mid.d', 'msg-d', T0 + 60, 4, 0],
    ['mid.b', 'msg-b', T0 + 20, 5, 1],
    ['mid.e', 'msg-e', T0 + 80, 6, 0]
  ];
  db.prepare(`INSERT INTO threads (id, external_thread_id, account_id) VALUES (?, ?, 'acc_1')`)
    .run(threadId, threadId);
  const ins = db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, sender_id, content, timestamp_ms,
      timestamp_source, is_outgoing, sequence_order, direction_status, created_at)
    VALUES (?, ?, '10001', ?, ?, 'separator_date_clock', ?, ?, 'confirmed', '2026-09-28T10:00:00.000Z')
  `);
  for (const [fbid, content, ts, seq, out] of rows) ins.run(threadId, fbid, content, ts, out, seq);
  return T0;
}

function domEnvelope(threadId, scanId, generation, entries) {
  return {
    thread_id: threadId,
    account_id: 'acc_1',
    page_id: 'page_1',
    session_epoch: 'epoch_dom_1',
    generation,
    scan_id: scanId,
    mode: 'page_initial',
    messages: entries
  };
}

function domBatch(T0, extra) {
  const out = { 'mid.a': 1, 'mid.b': 1, 'mid.c': 1, 'mid.d': 0, 'mid.e': 0 };
  const list = ['mid.a', 'mid.b', 'mid.c', 'mid.d', 'mid.e'].map((fbid, idx) => ({
    fb_message_id: fbid,
    content: 'msg-' + fbid.slice(4),
    timestamp_ms: T0 + idx * 20,
    timestamp_source: 'separator_date_clock',
    is_outgoing: out[fbid],
    created_at: '2026-09-28T10:00:00.000Z',
    sequence_order: idx,
    direction_status: 'confirmed'
  }));
  return extra ? list.concat([extra]) : list;
}

test('page batch reconcile slots observed rows into DOM order and never moves unobserved rows', () => {
  const db = setupTestDb();
  const T = 't_dom_reconcile_1';
  const T0 = seedDamagedThread(db, T);
  assert.deepEqual(orderedIds(db, T),
    ['mid.a', 'page_orphan_f_1', 'mid.c', 'mid.d', 'mid.b', 'mid.e']);

  const ack = ConversationRepository.processPageBatchEnvelope(
    domEnvelope(T, 'scan_dom_1', 1, domBatch(T0)), db
  );
  assert.equal(ack.status, 'committed');
  // F keeps its slot; the five observed rows land in true DOM order around it.
  assert.deepEqual(orderedIds(db, T),
    ['mid.a', 'page_orphan_f_1', 'mid.b', 'mid.c', 'mid.d', 'mid.e']);
  db.close();
});

test('page batch reconcile is idempotent and appends new messages after existing DOM order', () => {
  const db = setupTestDb();
  const T = 't_dom_reconcile_2';
  const T0 = seedDamagedThread(db, T);
  ConversationRepository.processPageBatchEnvelope(domEnvelope(T, 'scan2_first', 1, domBatch(T0)), db);
  assert.deepEqual(orderedIds(db, T),
    ['mid.a', 'page_orphan_f_1', 'mid.b', 'mid.c', 'mid.d', 'mid.e']);

  // Same window again: already ordered -> no-op, order stays stable.
  ConversationRepository.processPageBatchEnvelope(domEnvelope(T, 'scan2_again', 2, domBatch(T0)), db);
  assert.deepEqual(orderedIds(db, T),
    ['mid.a', 'page_orphan_f_1', 'mid.b', 'mid.c', 'mid.d', 'mid.e']);

  // A brand new message DOM-after the window appends at the end and never
  // pushes itself in front of an earlier message.
  ConversationRepository.processPageBatchEnvelope(domEnvelope(T, 'scan2_new', 3, domBatch(T0, {
    fb_message_id: 'mid.g',
    content: 'msg-g',
    timestamp_ms: T0 + 60000,
    timestamp_source: 'separator_date_clock',
    is_outgoing: 0,
    created_at: '2026-09-28T10:01:00.000Z',
    sequence_order: 5,
    direction_status: 'confirmed'
  })), db);
  assert.deepEqual(orderedIds(db, T),
    ['mid.a', 'page_orphan_f_1', 'mid.b', 'mid.c', 'mid.d', 'mid.e', 'mid.g']);
  db.close();
});
