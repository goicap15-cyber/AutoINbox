'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolveInternalThreadId } = require('../../src/server/utils/threadIdResolver');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

function setupTestDb() {
  const db = new Database(':memory:');
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
      is_unread INTEGER,
      inbox_folder TEXT
    );
  `);
  return db;
}

test('legacy namespaced row keeps its identity when the same page resolves again', () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, source_id, contact_name)
    VALUES ('page:100:cust999', 'cust999', 'acc_1', 'src_page_100', 'Customer X')
  `).run();

  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust999', '100'), 'page:100:cust999');
  assert.equal(resolveInternalThreadId(db, 'acc_1', 'page:100:cust999', '100'), 'page:100:cust999');
});

test('a different page for the same bare id mints its own namespaced id (real collision)', () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, source_id, contact_name)
    VALUES ('page:100:cust999', 'cust999', 'acc_1', 'src_page_100', 'Customer X')
  `).run();

  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust999', '200'), 'page:200:cust999');
});

test('bare-first: unbound bare row is adopted instead of minting a duplicate', () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, source_id, contact_name)
    VALUES ('cust777', 'cust777', 'acc_1', NULL, 'Khách hàng')
  `).run();

  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust777', '300'), 'cust777');
});

test('bare-first: unknown thread resolves to the bare id', () => {
  const db = setupTestDb();
  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust888', '300'), 'cust888');
  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust888'), 'cust888');
});

test('personal-bound bare row collides for an incoming page conversation', () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, source_id, contact_name)
    VALUES ('cust555', 'cust555', 'acc_1', 'src_personal_acc_1', 'Customer P')
  `).run();

  assert.equal(resolveInternalThreadId(db, 'acc_1', 'cust555', '100'), 'page:100:cust555');
});

test('ConversationRepository.upsertThread keeps Page 1 and Page 2 conversations distinct for the same customer', () => {
  const db = setupTestDb();

  // Same customer 'cust_shared' chats with Page 1 and Page 2 under the same FB account 'acc_1'
  const t1 = ConversationRepository.upsertThread({
    id: 'cust_shared',
    account_id: 'acc_1',
    source_id: 'src_page_1',
    contact_name: 'Khách Hàng Page 1',
    last_message: 'Hỏi mua cà phê Page 1'
  }, db);

  const t2 = ConversationRepository.upsertThread({
    id: 'cust_shared',
    account_id: 'acc_1',
    source_id: 'src_page_2',
    contact_name: 'Khách Hàng Page 2',
    last_message: 'Hỏi mua trà Page 2'
  }, db);

  // Both threads must exist in the database with their respective source_ids!
  assert.notEqual(t1.id, t2.id);
  assert.equal(t1.source_id, 'src_page_1');
  assert.equal(t2.source_id, 'src_page_2');
  assert.equal(t1.last_message, 'Hỏi mua cà phê Page 1');
  assert.equal(t2.last_message, 'Hỏi mua trà Page 2');

  const allThreads = db.prepare('SELECT * FROM threads').all();
  assert.equal(allThreads.length, 2);
});

test('ConversationRepository.upsertThread adopts an unbound bare row instead of minting a duplicate', () => {
  const db = setupTestDb();

  // Legacy bare row created before the page source was known (source_id NULL).
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, source_id, contact_name)
    VALUES ('100018089229407', '100018089229407', 'acc_1', NULL, 'Phạm Hùng')
  `).run();

  const upserted = ConversationRepository.upsertThread({
    id: '100018089229407',
    external_thread_id: '100018089229407',
    account_id: 'acc_1',
    source_id: 'src_page_1209772058877160',
    contact_name: 'Phạm Hùng',
    last_message: 'xin chào'
  }, db);

  // The SAME bare row is reused and its source bound - no namespaced twin.
  assert.equal(upserted.id, '100018089229407');
  assert.equal(upserted.source_id, 'src_page_1209772058877160');
  const allThreads = db.prepare('SELECT id, source_id FROM threads').all();
  assert.equal(allThreads.length, 1);
});
