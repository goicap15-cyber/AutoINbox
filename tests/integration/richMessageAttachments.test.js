const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTestDatabase } = require('../helpers/testDatabase');
const { seedPageThread } = require('./campaignTestUtils');
const OutboundAttachmentService = require('../../src/server/services/OutboundAttachmentService');
const RichMessageService = require('../../src/server/services/RichMessageService');
const OutboundConfirmationService = require('../../src/server/services/OutboundConfirmationService');
const OutboundAttemptRepository = require('../../src/server/repositories/OutboundAttemptRepository');
const queueWorker = require('../../src/server/services/QueueWorker');

const PAGE_CONFIG = {
  enabled: true,
  maxBytes: 8 * 1024 * 1024,
  adapters: {
    page_messenger: { image: true, file: false },
    personal_messenger: { image: false, file: false }
  }
};

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

function withPageFixture(run) {
  const db = getTestDatabase(':memory:');
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-page-image-'));
  const sentEnvelopes = [];
  const ws = {
    readyState: 1,
    send(value) {
      sentEnvelopes.push(JSON.parse(value));
    }
  };
  seedPageThread(db, { id: 'thread-page-image' });
  const capabilityOptions = {
    database: db,
    getConnection: () => ws,
    config: PAGE_CONFIG
  };
  queueWorker.configure({
    database: db,
    getConnection: () => ws,
    campaignEnabled: () => true,
    onQueueFail: () => {}
  });
  return Promise.resolve()
    .then(() => run({ db, storageDir, sentEnvelopes, capabilityOptions }))
    .finally(() => {
      db.close();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });
}

async function createPageImage({ db, storageDir, capabilityOptions }) {
  const attachment = OutboundAttachmentService.stageUpload({
    threadId: 'thread-page-image',
    createdBy: null,
    originalName: 'ảnh page.jpg',
    declaredMimeType: 'image/jpeg',
    buffer: jpegBytes()
  }, { database: db, storageDir, capabilityOptions });
  const accepted = RichMessageService.submit({
    threadId: 'thread-page-image',
    clientMessageId: 'client-page-image',
    content: '',
    attachmentId: attachment.id
  }, { database: db, capabilityOptions });
  return { attachment, accepted };
}

test('Page image queue emits a verified v2 envelope and confirms only from Facebook observation', () => withPageFixture(async (fixture) => {
  const { db, sentEnvelopes } = fixture;
  const { attachment, accepted } = await createPageImage(fixture);
  const dispatch = await queueWorker.processNext();

  assert.equal(dispatch.outcome, 'dispatched');
  assert.equal(sentEnvelopes.length, 1);
  const envelope = sentEnvelopes[0];
  assert.equal(envelope.type, 'SEND_QUEUED_MESSAGE');
  assert.equal(envelope.data.contract_version, 2);
  assert.equal(envelope.data.source_type, 'page_messenger');
  assert.equal(envelope.data.page_id, 'page-1');
  assert.equal(envelope.data.outbound_attempt_id, accepted.attempt_id);
  assert.equal(envelope.data.idempotency_key, null);
  assert.equal(envelope.data.attachment.id, attachment.id);
  assert.equal(envelope.data.attachment.byte_size, jpegBytes().length);
  assert.equal(envelope.data.attachment.local_path, attachment.storage_path);
  assert.equal(OutboundAttemptRepository.getById(accepted.attempt_id, db).status, 'dispatching');
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(accepted.message_id).delivery_status, 'pending');

  OutboundAttemptRepository.transition(
    accepted.attempt_id,
    ['dispatching'],
    'awaiting_confirmation',
    {},
    db
  );
  const confirmed = OutboundConfirmationService.confirmObservation({
    threadId: 'thread-page-image',
    fbMessageId: 'mid.facebook.page.image.1',
    isOutgoing: true,
    mediaType: 'image',
    content: '',
    observedAt: Date.now(),
    confirmationSource: 'page_dom'
  }, { database: db });

  assert.equal(confirmed.matched, true);
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(accepted.message_id).delivery_status, 'sent');
  assert.equal(OutboundAttemptRepository.getById(accepted.attempt_id, db).status, 'sent');
  assert.equal(db.prepare('SELECT status FROM message_queue WHERE id = ?').get(accepted.queue_id).status, 'sent');
  assert.equal(db.prepare('SELECT status FROM outbound_attachments WHERE id = ?').get(attachment.id).status, 'sent');
}));

test('Page image bytes changed after staging fail checksum verification before extension dispatch', () => withPageFixture(async (fixture) => {
  const { db, sentEnvelopes } = fixture;
  const { attachment, accepted } = await createPageImage(fixture);
  fs.writeFileSync(attachment.storage_path, Buffer.from('tampered'));

  const dispatch = await queueWorker.processNext();
  assert.equal(dispatch.outcome, 'failed');
  assert.equal(sentEnvelopes.length, 0);
  assert.equal(OutboundAttemptRepository.getById(accepted.attempt_id, db).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM message_queue WHERE id = ?').get(accepted.queue_id).status, 'failed');
}));

test('an official media echo already stored by history is collapsed into the pending CRM row', () => withPageFixture(async (fixture) => {
  const { db } = fixture;
  const { accepted } = await createPageImage(fixture);
  await queueWorker.processNext();
  OutboundAttemptRepository.transition(accepted.attempt_id, ['dispatching'], 'awaiting_confirmation', {}, db);

  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, sender_id, content, media_type, media_url, is_outgoing, delivery_status, timestamp_ms)
    VALUES ('thread-page-image', 'mid.facebook.history.echo', 'SYSTEM', '', 'image', 'https://scontent.example/image.jpg', 1, 'sent', ?)
  `).run(Date.now());

  const confirmed = OutboundConfirmationService.confirmObservation({
    threadId: 'thread-page-image',
    fbMessageId: 'mid.facebook.history.echo',
    isOutgoing: true,
    mediaType: 'image',
    content: '',
    observedAt: Date.now(),
    confirmationSource: 'personal_dom'
  }, { database: db });

  assert.equal(confirmed.matched, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = 'thread-page-image' AND media_type = 'image'").get().count, 1);
  assert.equal(db.prepare('SELECT fb_message_id FROM messages WHERE id = ?').get(accepted.message_id).fb_message_id, 'mid.facebook.history.echo');
}));

test('a stale rich-message dispatch is failed during queue recovery', () => withPageFixture(async (fixture) => {
  const { db } = fixture;
  const { attachment, accepted } = await createPageImage(fixture);
  const dispatch = await queueWorker.processNext();
  assert.equal(dispatch.outcome, 'dispatched');

  db.prepare(`
    UPDATE outbound_attempts
    SET dispatched_at = datetime('now', '-10 minutes'),
        updated_at = datetime('now', '-10 minutes')
    WHERE id = ?
  `).run(accepted.attempt_id);
  db.prepare(`
    UPDATE message_queue
    SET processed_at = datetime('now', '-10 minutes')
    WHERE id = ?
  `).run(accepted.queue_id);

  const recovered = queueWorker.recoverStaleRichDispatches({
    dispatchTimeoutMs: 3 * 60 * 1000,
    confirmationTimeoutMs: 3 * 60 * 1000
  });

  assert.deepEqual(recovered, { dispatching: 1, awaiting_confirmation: 0 });
  assert.equal(OutboundAttemptRepository.getById(accepted.attempt_id, db).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM message_queue WHERE id = ?').get(accepted.queue_id).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM outbound_attachments WHERE id = ?').get(attachment.id).status, 'failed');
}));
test('an image attempt ignores a video observation and remains available for the real image confirmation', () => withPageFixture(async (fixture) => {
  const { db } = fixture;
  const { accepted } = await createPageImage(fixture);
  await queueWorker.processNext();
  OutboundAttemptRepository.transition(accepted.attempt_id, ['dispatching'], 'awaiting_confirmation', {}, db);

  const wrongKind = OutboundConfirmationService.confirmObservation({
    threadId: 'thread-page-image',
    fbMessageId: 'mid.facebook.unrelated.video',
    isOutgoing: true,
    mediaType: 'video',
    content: '',
    observedAt: Date.now(),
    confirmationSource: 'personal_dom'
  }, { database: db });
  assert.equal(wrongKind.matched, false);
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(accepted.message_id).delivery_status, 'pending');

  const correctKind = OutboundConfirmationService.confirmObservation({
    threadId: 'thread-page-image',
    fbMessageId: 'mid.facebook.real.image',
    isOutgoing: true,
    mediaType: 'image',
    content: '',
    observedAt: Date.now(),
    confirmationSource: 'personal_dom'
  }, { database: db });
  assert.equal(correctKind.matched, true);
}));
