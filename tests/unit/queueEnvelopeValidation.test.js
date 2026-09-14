const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQueuedEnvelope } = require('../../src/extension/queueEnvelopeValidation');

const CHECKSUM = 'a'.repeat(64);

function basePayload(overrides = {}) {
  return {
    contract_version: 2,
    campaign_id: 'campaign-1',
    campaign_attempt_id: 'attempt-1',
    queue_id: 'queue-1',
    thread_id: 'thread-1',
    account_id: 'acct-1',
    source_type: 'page_messenger',
    source_id: 'src-1',
    page_id: 'page-1',
    content: '',
    ...overrides
  };
}

function fileAttachment(overrides = {}) {
  return {
    id: 'attachment-1',
    name: 'doc.pdf',
    local_path: '/tmp/doc.pdf',
    media_type: 'file',
    mime_type: 'application/pdf',
    byte_size: 1024,
    checksum_sha256: CHECKSUM,
    ...overrides
  };
}

test('a contract_version 1 envelope is never validated (legacy passthrough)', () => {
  assert.doesNotThrow(() => validateQueuedEnvelope({ contract_version: 1 }));
});

test('a single attachment envelope validates exactly as before spec 040', () => {
  assert.doesNotThrow(() => validateQueuedEnvelope(basePayload({ attachment: fileAttachment() })));
});

test('a valid attachment_manifest with several files passes', () => {
  assert.doesNotThrow(() => validateQueuedEnvelope(basePayload({
    attachment_manifest: [fileAttachment({ id: 'a' }), fileAttachment({ id: 'b', name: 'b.pdf' })]
  })));
});

test('an empty attachment_manifest is rejected', () => {
  assert.throws(
    () => validateQueuedEnvelope(basePayload({ attachment_manifest: [] })),
    (error) => error.code === 'CAMPAIGN_CONTRACT_ATTACHMENT_MANIFEST_EMPTY'
  );
});

test('a manifest with one invalid member is rejected, not silently dropped', () => {
  assert.throws(
    () => validateQueuedEnvelope(basePayload({
      attachment_manifest: [fileAttachment({ id: 'a' }), fileAttachment({ id: 'b', checksum_sha256: 'not-a-checksum' })]
    })),
    (error) => error.code === 'CAMPAIGN_CONTRACT_ATTACHMENT_INVALID'
  );
});

test('an MP4 video attachment is accepted and unsupported video MIME is rejected', () => {
  assert.doesNotThrow(() => validateQueuedEnvelope(basePayload({
    attachment: fileAttachment({ media_type: 'video', mime_type: 'video/mp4', name: 'clip.mp4' })
  })));
  assert.throws(() => validateQueuedEnvelope(basePayload({
    attachment: fileAttachment({ media_type: 'video', mime_type: 'video/x-unknown' })
  })), (error) => error.code === 'CAMPAIGN_CONTRACT_ATTACHMENT_UNSUPPORTED');
});

test('a personal_messenger envelope with page_id set is rejected regardless of manifest', () => {
  assert.throws(
    () => validateQueuedEnvelope(basePayload({
      source_type: 'personal_messenger',
      campaign_attempt_id: 'attempt-1',
      attachment_manifest: [fileAttachment()]
    })),
    (error) => error.code === 'CAMPAIGN_CONTRACT_PERSONAL_PAGE_FORBIDDEN'
  );
});

test('an envelope with neither content nor attachment nor manifest is rejected', () => {
  assert.throws(
    () => validateQueuedEnvelope(basePayload()),
    (error) => error.code === 'CAMPAIGN_CONTRACT_EMPTY'
  );
});

test('expectedAccountId mismatch is rejected even for a manifest envelope', () => {
  assert.throws(
    () => validateQueuedEnvelope(basePayload({ attachment_manifest: [fileAttachment()] }), { expectedAccountId: 'someone-else' }),
    (error) => error.code === 'QUEUED_ACCOUNT_MISMATCH'
  );
});
