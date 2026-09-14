const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const OutboundAttachmentRepository = require('../../src/server/repositories/OutboundAttachmentRepository');
const OutboundAttemptRepository = require('../../src/server/repositories/OutboundAttemptRepository');
const MessageQueueRepository = require('../../src/server/repositories/MessageQueueRepository');
const { seedPageThread } = require('./campaignTestUtils');
const { resolveInternalThreadId } = require('../../src/server/utils/threadIdResolver');

function withDatabase(run) {
  const db = getTestDatabase(':memory:');
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function insertPendingMessage(db, threadId, clientMessageId = 'client-rich-1') {
  return Number(db.prepare(`
    INSERT INTO messages
      (thread_id, fb_message_id, client_message_id, sender_id, content,
       media_type, is_outgoing, delivery_status)
    VALUES (?, ?, ?, 'SYSTEM', '', 'image', 1, 'pending')
  `).run(threadId, `pending_${clientMessageId}`, clientMessageId).lastInsertRowid);
}

test('rich-message schema exposes attachment, attempt, message, and queue contract fields', () => withDatabase((db) => {
  const tableNames = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('outbound_attachments', 'outbound_attempts')
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tableNames, ['outbound_attachments', 'outbound_attempts']);

  const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
  for (const name of ['attachment_id', 'latest_attempt_id', 'media_name', 'media_mime_type', 'media_size']) {
    assert.equal(messageColumns.has(name), true, `missing messages.${name}`);
  }

  const queueColumns = new Set(db.prepare('PRAGMA table_info(message_queue)').all().map((column) => column.name));
  for (const name of ['outbound_attempt_id', 'attachment_media_type', 'attachment_byte_size', 'attachment_checksum', 'contract_version']) {
    assert.equal(queueColumns.has(name), true, `missing message_queue.${name}`);
  }
}));

test('repositories persist a thread-bound attachment and immutable attempt transitions', () => withDatabase((db) => {
  seedPageThread(db, { id: 'thread-rich-persistence' });
  const messageId = insertPendingMessage(db, 'thread-rich-persistence');
  const attachment = OutboundAttachmentRepository.create({
    id: 'attachment-rich-1',
    thread_id: 'thread-rich-persistence',
    created_by: null,
    original_name: 'ảnh test.png',
    safe_name: 'anh_test.png',
    media_type: 'image',
    mime_type: 'image/png',
    byte_size: 67,
    storage_path: '/tmp/rich/ab/cd/checksum.png',
    checksum_sha256: 'a'.repeat(64),
    expires_at: '2026-08-12T10:00:00.000Z'
  }, db);
  assert.equal(attachment.status, 'staged');
  assert.equal(OutboundAttachmentRepository.bindToMessage(attachment.id, messageId, db), true);
  assert.equal(OutboundAttachmentRepository.getById(attachment.id, db).consumed_by_message_id, messageId);

  const attempt = OutboundAttemptRepository.create({
    id: 'attempt-rich-1',
    message_id: messageId,
    attachment_id: attachment.id,
    source_id: 'src-page-1',
    source_type: 'page_messenger',
    account_id: 'acct-1',
    page_id: 'page-1',
    attempt_number: 1,
    idempotency_key: 'rich:thread-rich-persistence:client-rich-1'
  }, db);
  assert.equal(attempt.status, 'queued');
  assert.equal(OutboundAttemptRepository.transition(attempt.id, ['queued'], 'dispatching', {
    dispatch_method: 'rich-message-v1'
  }, db), true);
  assert.equal(OutboundAttemptRepository.getById(attempt.id, db).status, 'dispatching');
  assert.equal(OutboundAttemptRepository.transition(attempt.id, ['queued'], 'failed', {}, db), false);
}));

test('rich-message queue uses contract v2 and never writes campaign idempotency_key', () => withDatabase((db) => {
  seedPageThread(db, { id: 'thread-rich-queue' });
  const messageId = insertPendingMessage(db, 'thread-rich-queue');
  OutboundAttemptRepository.create({
    id: 'attempt-rich-queue',
    message_id: messageId,
    source_id: 'src-page-1',
    source_type: 'page_messenger',
    account_id: 'acct-1',
    page_id: 'page-1',
    attempt_number: 1,
    idempotency_key: 'rich:thread-rich-queue:client-rich-1'
  }, db);

  const queueId = MessageQueueRepository.insertRichMessage({
    thread_id: 'thread-rich-queue',
    account_id: 'acct-1',
    source_id: 'src-page-1',
    source_type: 'page_messenger',
    page_id: 'page-1',
    content: '',
    outbound_attempt_id: 'attempt-rich-queue',
    attachment_media_type: 'image',
    attachment_byte_size: 67,
    attachment_checksum: 'b'.repeat(64),
    // This value must be ignored by the rich-message insert path.
    idempotency_key: 'must-not-enter-message-queue'
  }, db);

  const row = db.prepare('SELECT * FROM message_queue WHERE id = ?').get(queueId);
  assert.equal(row.contract_version, 2);
  assert.equal(row.outbound_attempt_id, 'attempt-rich-queue');
  assert.equal(row.idempotency_key, null);
  assert.equal(OutboundAttemptRepository.linkQueue('attempt-rich-queue', queueId, db), true);
  assert.equal(OutboundAttemptRepository.getById('attempt-rich-queue', db).queue_id, queueId);
}));

test('outbound attempt idempotency is independent from campaign queue idempotency', () => withDatabase((db) => {
  seedPageThread(db, { id: 'thread-rich-idempotency' });
  const messageId = insertPendingMessage(db, 'thread-rich-idempotency');
  const data = {
    id: 'attempt-idempotent-1',
    message_id: messageId,
    source_id: 'src-page-1',
    source_type: 'page_messenger',
    account_id: 'acct-1',
    page_id: 'page-1',
    attempt_number: 1,
    idempotency_key: 'rich:thread-rich-idempotency:client-rich-1'
  };
  const first = OutboundAttemptRepository.create(data, db);
  const repeated = OutboundAttemptRepository.create({ ...data, id: 'attempt-idempotent-2' }, db);
  assert.equal(repeated.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbound_attempts').get().count, 1);
}));

test('resolveInternalThreadId maps a personal thread\'s bare PSID back to its compound CRM id', () => withDatabase((db) => {
  db.prepare(`
    INSERT INTO accounts (id, name, profile_dir, status)
    VALUES ('acct-personal-1', 'Test personal account', '/tmp/autochatbot-thread-resolver-test', 'ACTIVE')
  `).run();
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, contact_name)
    VALUES ('acct-personal-1:969878666067566', '969878666067566', 'acct-personal-1', 'Test contact')
  `).run();

  assert.equal(
    resolveInternalThreadId(db, 'acct-personal-1', '969878666067566'),
    'acct-personal-1:969878666067566'
  );

  // Page threads where external_thread_id and id already coincide (no
  // account_id prefix) still resolve correctly via the same lookup.
  db.prepare(`
    INSERT INTO threads (id, external_thread_id, account_id, contact_name)
    VALUES ('100092115712908', '100092115712908', 'acct-personal-1', 'Test page contact')
  `).run();
  assert.equal(
    resolveInternalThreadId(db, 'acct-personal-1', '100092115712908'),
    '100092115712908'
  );

  db.prepare(`
    INSERT INTO accounts (id, name, profile_dir, status)
    VALUES ('acct-personal-2', 'Second personal account', '/tmp/autochatbot-thread-resolver-test-2', 'ACTIVE')
  `).run();
  assert.equal(
    resolveInternalThreadId(db, 'acct-personal-2', '100092115712908'),
    'acct-personal-2:100092115712908'
  );
  // An id with no matching thread row falls back to itself unchanged, rather
  // than throwing - confirmObservation() will then just find no candidate,
  // identical to today's behavior.
  assert.equal(
    resolveInternalThreadId(db, 'acct-personal-1', 'no-such-psid'),
    'no-such-psid'
  );
}));
