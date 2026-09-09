const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTestDatabase } = require('../helpers/testDatabase');
const { seedPersonalThread } = require('./campaignTestUtils');
const OutboundAttachmentService = require('../../src/server/services/OutboundAttachmentService');
const RichMessageService = require('../../src/server/services/RichMessageService');
const RichMessageCapabilityService = require('../../src/server/services/RichMessageCapabilityService');
const OutboundConfirmationService = require('../../src/server/services/OutboundConfirmationService');
const OutboundAttemptRepository = require('../../src/server/repositories/OutboundAttemptRepository');
const queueWorker = require('../../src/server/services/QueueWorker');

const PERSONAL_CONFIG = {
  enabled: true,
  maxBytes: 8 * 1024 * 1024,
  adapters: {
    page_messenger: { image: false, file: false },
    personal_messenger: { image: true, file: false }
  }
};

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

function withPersonalFixture(run) {
  const db = getTestDatabase(':memory:');
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-personal-image-'));
  const sentEnvelopes = [];
  const ws = {
    readyState: 1,
    send(value) {
      sentEnvelopes.push(JSON.parse(value));
    }
  };
  seedPersonalThread(db, { id: 'thread-personal-image' });
  db.prepare('UPDATE threads SET thread_url = ?, contact_name = ? WHERE id = ?').run('https://www.facebook.com/messages/t/thread-personal-image', 'Personal Contact', 'thread-personal-image');
  const capabilityOptions = {
    database: db,
    getConnection: () => ws,
    config: PERSONAL_CONFIG
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

async function createPersonalImage({ db, storageDir, capabilityOptions }) {
  const attachment = OutboundAttachmentService.stageUpload({
    threadId: 'thread-personal-image',
    createdBy: null,
    originalName: 'ảnh cá nhân.jpg',
    declaredMimeType: 'image/jpeg',
    buffer: jpegBytes()
  }, { database: db, storageDir, capabilityOptions });
  const accepted = RichMessageService.submit({
    threadId: 'thread-personal-image',
    clientMessageId: 'client-personal-image',
    content: 'xin chào kèm ảnh',
    attachmentId: attachment.id
  }, { database: db, capabilityOptions });
  return { attachment, accepted };
}

test('personal_messenger capability reports image enabled only when its own adapter flag is set', () => withPersonalFixture(({ db, capabilityOptions }) => {
  const capability = RichMessageCapabilityService.getForThread('thread-personal-image', capabilityOptions);
  assert.equal(capability.source_type, 'personal_messenger');
  assert.equal(capability.page_id, null);
  assert.equal(capability.image.enabled, true);
  assert.deepEqual(capability.image.mime_types, ['image/jpeg', 'image/png', 'image/webp']);

  const disabledCapability = RichMessageCapabilityService.getForThread('thread-personal-image', {
    ...capabilityOptions,
    config: { ...PERSONAL_CONFIG, adapters: { ...PERSONAL_CONFIG.adapters, personal_messenger: { image: false, file: false } } }
  });
  assert.equal(disabledCapability.image.enabled, false);
  assert.deepEqual(disabledCapability.image.mime_types, []);
}));

test('personal_messenger image queue builds a v2 envelope with no page_id and confirms only from Facebook observation', () => withPersonalFixture(async (fixture) => {
  const { db, sentEnvelopes } = fixture;
  const { attachment, accepted } = await createPersonalImage(fixture);
  const dispatch = await queueWorker.processNext();

  assert.equal(dispatch.outcome, 'dispatched');
  assert.equal(sentEnvelopes.length, 1);
  const envelope = sentEnvelopes[0];
  assert.equal(envelope.type, 'SEND_QUEUED_MESSAGE');
  assert.equal(envelope.data.contract_version, 2);
  assert.equal(envelope.data.source_type, 'personal_messenger');
  assert.equal(envelope.data.thread_url, 'https://www.facebook.com/messages/t/thread-personal-image');
  assert.equal(envelope.data.expected_contact_name, 'Personal Contact');
  assert.equal(envelope.data.outbound_attempt_id, accepted.attempt_id);
  assert.equal(envelope.data.idempotency_key, null);
  assert.equal(envelope.data.attachment.id, attachment.id);
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
    threadId: 'thread-personal-image',
    fbMessageId: 'mid.facebook.personal.image.1',
    isOutgoing: true,
    mediaType: 'image',
    content: 'xin chào kèm ảnh',
    observedAt: Date.now(),
    confirmationSource: 'personal_dom'
  }, { database: db });

  assert.equal(confirmed.matched, true);
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(accepted.message_id).delivery_status, 'sent');
  assert.equal(OutboundAttemptRepository.getById(accepted.attempt_id, db).status, 'sent');
}));

test('an image upload is rejected before queueing when personal_messenger has no image capability', () => withPersonalFixture(({ db, storageDir }) => {
  const disabledCapabilityOptions = {
    database: db,
    getConnection: () => ({ readyState: 1, send() {} }),
    config: { ...PERSONAL_CONFIG, adapters: { ...PERSONAL_CONFIG.adapters, personal_messenger: { image: false, file: false } } }
  };

  assert.throws(
    () => OutboundAttachmentService.stageUpload({
      threadId: 'thread-personal-image',
      createdBy: null,
      originalName: 'ảnh cá nhân.jpg',
      declaredMimeType: 'image/jpeg',
      buffer: jpegBytes()
    }, { database: db, storageDir, capabilityOptions: disabledCapabilityOptions }),
    (error) => error.code === 'ATTACHMENT_UNSUPPORTED'
  );
}));
