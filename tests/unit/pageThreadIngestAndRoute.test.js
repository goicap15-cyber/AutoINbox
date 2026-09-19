'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolveInternalThreadId } = require('../../src/server/utils/threadIdResolver');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');
const { InboxSyncScheduler } = require('../../src/server/services/InboxSyncScheduler');

function extractBareThreadId(threadId) {
  if (!threadId) return '';
  const str = String(threadId).trim();
  const parts = str.split(':').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : str;
}

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

test('extractBareThreadId extracts the PSID/client thread ID correctly across all namespace formats', () => {
  // 3-part page thread: page:<page_id>:<psid>
  assert.equal(extractBareThreadId('page:1209772058877160:100018089229407'), '100018089229407');
  
  // 2-part source thread: src_page_123:100018089229407
  assert.equal(extractBareThreadId('src_page_123:100018089229407'), '100018089229407');
  
  // 2-part personal thread: acc_1:100018089229407
  assert.equal(extractBareThreadId('acc_1:100018089229407'), '100018089229407');
  
  // Bare thread: 100018089229407
  assert.equal(extractBareThreadId('100018089229407'), '100018089229407');
  
  // Empty / null
  assert.equal(extractBareThreadId(''), '');
  assert.equal(extractBareThreadId(null), '');
});

test('PAGE_THREAD_MESSAGES_SYNCED_V1 pipeline with new thread succeeds without foreign key violation', () => {
  const db = setupFullTestDb();
  const authenticatedAccountId = 'acc_fb_1';
  const pageId = '1209772058877160';
  const pageSourceId = `src_page_${pageId}`;

  db.prepare(`
    INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name)
    VALUES (?, 'page_messenger', ?, ?, 'My Shop Fanpage')
  `).run(pageSourceId, authenticatedAccountId, pageId);

  // Incoming envelope from extension with bare thread id (e.g. from Business Suite DOM)
  const barePageThreadId = '100018089229407';
  const envelope = {
    thread_id: barePageThreadId,
    account_id: authenticatedAccountId,
    page_id: pageId,
    contact_name: 'Nguyễn Văn A',
    session_epoch: 'epoch_1',
    generation: 1,
    scan_id: 'scan_1',
    mode: 'page_initial',
    messages: [
      {
        fb_message_id: 'mid.12345',
        sender_id: barePageThreadId,
        content: 'Chào shop, em muốn tư vấn sản phẩm',
        is_outgoing: false,
        timestamp_ms: 1700000000000,
        dom_order: 1
      },
      {
        fb_message_id: 'mid.12346',
        sender_id: authenticatedAccountId,
        content: 'Dạ chào bạn, shop có thể giúp gì ạ?',
        is_outgoing: true,
        timestamp_ms: 1700000010000,
        dom_order: 2
      }
    ]
  };

  // Pipeline execution matching server.js (bare-first policy):
  // 1. Resolve canonical thread ID - bare id IS the canonical identity now.
  const canonicalThreadId = resolveInternalThreadId(db, authenticatedAccountId, barePageThreadId, pageId);
  assert.equal(canonicalThreadId, barePageThreadId);

  // 2. Upsert thread
  const threadRecord = ConversationRepository.upsertThread({
    id: canonicalThreadId,
    external_thread_id: barePageThreadId,
    account_id: authenticatedAccountId,
    source_id: pageSourceId,
    contact_name: envelope.contact_name,
    last_message: envelope.messages[envelope.messages.length - 1].content,
    is_unread: 0,
    inbox_folder: 'INBOX'
  }, db);

  assert.equal(threadRecord.id, barePageThreadId);
  assert.equal(threadRecord.external_thread_id, barePageThreadId);
  assert.equal(threadRecord.source_id, pageSourceId);

  // 3. Upsert contacts (MUST NOT trigger SQLite FOREIGN KEY constraint failed error)
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO contacts (thread_id, name, avatar_url)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        name = COALESCE(excluded.name, contacts.name),
        avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url)
    `).run(canonicalThreadId, envelope.contact_name, 'https://example.com/avatar.jpg');
  });

  // Verify contacts row exists with canonicalThreadId
  const contactRow = db.prepare('SELECT * FROM contacts WHERE thread_id = ?').get(canonicalThreadId);
  assert.equal(contactRow.thread_id, barePageThreadId);
  assert.equal(contactRow.name, 'Nguyễn Văn A');

  // 4. Process page batch envelope using canonicalThreadId
  const ack = ConversationRepository.processPageBatchEnvelope({
    ...envelope,
    thread_id: canonicalThreadId,
    account_id: authenticatedAccountId,
    page_id: pageId,
    source_id: pageSourceId
  }, db);

  assert.equal(ack.status, 'committed');

  // 5. Verify messages belong to canonicalThreadId and are not orphaned
  const messages = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_order ASC').all(canonicalThreadId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].fb_message_id, 'mid.12345');
  assert.equal(messages[0].thread_id, barePageThreadId);
  assert.equal(messages[1].fb_message_id, 'mid.12346');
  assert.equal(messages[1].thread_id, barePageThreadId);

  // ACK sent to extension must maintain bare thread id for extension state machine
  const extensionAck = { ...ack, thread_id: barePageThreadId };
  assert.equal(extensionAck.thread_id, barePageThreadId);
});

test('InboxSyncScheduler.markThreadSyncResult finds and releases in-flight page job using bare ID fallback', () => {
  const scheduler = new InboxSyncScheduler();
  const accountId = 'acc_1';
  const pageId = 'page_99';
  const bareId = 'user_123';
  const canonicalId = `page:${pageId}:${bareId}`;

  scheduler.configure({
    getConnection: () => ({ readyState: 1 }),
    dispatchThreadMessagesSync: () => true
  });

  // Page lane gate: mark the page READY before enqueue/drain
  scheduler.markPageReady(pageId, accountId);
  // Enqueue job using canonical ID (as InitialMessageSweepService does)
  scheduler.enqueueThreadSync({
    account_id: accountId,
    thread_id: canonicalId,
    page_id: pageId,
    reason: 'initial_sweep'
  });

  // Drain to put it in flight
  scheduler.drainThreadQueue(`page:${pageId}`);
  assert.equal(scheduler.isLaneBusy(`page:${pageId}`), true);

  // Mark result with bareId and pageId: scheduler must find the job and release the lane!
  scheduler.markThreadSyncResult(accountId, bareId, null, pageId);
  assert.equal(scheduler.isLaneBusy(`page:${pageId}`), false);
});
