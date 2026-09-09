const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CampaignService = require('../../src/server/services/CampaignService');
const CampaignRepository = require('../../src/server/repositories/CampaignRepository');
const { CampaignRunner } = require('../../src/server/services/CampaignRunner');
const CampaignAttachmentService = require('../../src/server/services/CampaignAttachmentService');
const { seedPageThread, withCampaignDatabase } = require('../integration/campaignTestUtils');

const { CAMPAIGN_ERROR_CODES } = CampaignService;

test('validateAndNormalizeMessages accepts 1 to 5 messages and supports empty text for attachment drafts', () => {
  const single = CampaignService.validateAndNormalizeMessages([{ text_content: 'Xin chào' }]);
  assert.equal(single.length, 1);
  assert.equal(single[0].text_content, 'Xin chào');

  // Empty text draft is allowed (e.g. for attaching media before preview)
  const emptyDraft = CampaignService.validateAndNormalizeMessages([{ text_content: '' }]);
  assert.equal(emptyDraft.length, 1);
  assert.equal(emptyDraft[0].text_content, '');

  const five = CampaignService.validateAndNormalizeMessages([
    { text_content: 'Tin 1' },
    { text_content: 'Tin 2' },
    { text_content: 'Tin 3' },
    { text_content: 'Tin 4' },
    { text_content: 'Tin 5' }
  ]);
  assert.equal(five.length, 5);
  assert.equal(five[4].text_content, 'Tin 5');
});

test('validateAndNormalizeMessages rejects > 5 messages and empty array with proper error codes', () => {
  // Empty array throws MESSAGE_INVALID (not INVALID_ORDER)
  assert.throws(
    () => CampaignService.validateAndNormalizeMessages([]),
    (err) => {
      assert.equal(err.code, CAMPAIGN_ERROR_CODES.MESSAGE_INVALID);
      return true;
    }
  );

  // Over 5 messages throws SEND_LIMIT_REACHED without silent slicing
  const six = [
    { text_content: '1' }, { text_content: '2' }, { text_content: '3' },
    { text_content: '4' }, { text_content: '5' }, { text_content: '6' }
  ];
  assert.throws(
    () => CampaignService.validateAndNormalizeMessages(six),
    (err) => {
      assert.equal(err.code, CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED);
      assert.match(err.message, /tối đa 5 tin/);
      return true;
    }
  );
});

test('validateAndNormalizeMessages rejects content exceeding 2000 characters with MESSAGE_INVALID', () => {
  const longContent = 'A'.repeat(2001);
  assert.throws(
    () => CampaignService.validateAndNormalizeMessages([{ text_content: longContent }]),
    (err) => {
      assert.equal(err.code, CAMPAIGN_ERROR_CODES.MESSAGE_INVALID);
      assert.match(err.message, /2000/);
      return true;
    }
  );
});

test('preview enforces text OR valid attachment for every message', () => withCampaignDatabase((db) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-attach-'));
  try {
    seedPageThread(db, { id: 'thread-attach-preview' });
    // Draft with empty text is permitted
    const campaign = CampaignService.createDraft({
      name: 'Attachment only draft',
      thread_ids: ['thread-attach-preview'],
      messages: [{ text_content: '' }],
      send_cap: 1
    }, db);

    // Preview fails when neither text nor attachment exists
    assert.throws(
      () => CampaignService.preview(campaign.id, db),
      (err) => err.code === CAMPAIGN_ERROR_CODES.MESSAGE_INVALID
    );

    // Add a valid image attachment
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    CampaignAttachmentService.saveUpload({
      campaignId: campaign.id,
      campaignMessageId: campaign.messages[0].id,
      originalName: 'photo.jpg',
      declaredMimeType: 'image/jpeg',
      buffer: jpeg
    }, { database: db, storageDir, imageEnabled: true });

    // Preview succeeds with attachment-only message
    const ready = CampaignService.preview(campaign.id, db);
    assert.equal(ready.status, 'ready');
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
}));

test('2 recipients x 3 messages dispatch sequentially in order: A1, A2, A3, B1, B2, B3', () => withCampaignDatabase(async (db) => {
  seedPageThread(db, { id: 'thread-cust-a', accountId: 'acc-multi' });
  seedPageThread(db, { id: 'thread-cust-b', accountId: 'acc-multi' });

  const campaign = CampaignService.createDraft({
    name: 'Multi recipient multi message',
    thread_ids: ['thread-cust-a', 'thread-cust-b'],
    messages: [
      { text_content: 'Tin 1' },
      { text_content: 'Tin 2' },
      { text_content: 'Tin 3' }
    ],
    pacing_ms: 0,
    send_cap: 2
  }, db);

  CampaignService.preview(campaign.id, db);
  CampaignRepository.updateCampaignStatus(campaign.id, 'ready', 'running', db);

  const dispatched = [];
  const queue = new Map();
  const runner = new CampaignRunner({ database: db });
  runner.configure({
    enqueueMessage: async ({ recipient, attempt, content }) => {
      const queueId = 'queue-' + attempt.id;
      dispatched.push({ threadId: recipient.thread_id, content });
      queue.set(queueId, { id: queueId, status: 'sent' });
      return { queueId, clientMessageId: 'queue_' + queueId };
    },
    getQueueStatus: (queueId) => queue.get(queueId),
    pollIntervalMs: 1,
    confirmationTimeoutMs: 100
  });

  await runner.start(campaign.id);
  const finished = CampaignRepository.getCampaign(campaign.id, db);
  assert.equal(finished.status, 'completed');

  assert.deepEqual(dispatched, [
    { threadId: 'thread-cust-a', content: 'Tin 1' },
    { threadId: 'thread-cust-a', content: 'Tin 2' },
    { threadId: 'thread-cust-a', content: 'Tin 3' },
    { threadId: 'thread-cust-b', content: 'Tin 1' },
    { threadId: 'thread-cust-b', content: 'Tin 2' },
    { threadId: 'thread-cust-b', content: 'Tin 3' }
  ]);
}));

test('countAccountSentToday counts in-flight (created, dispatched), unknown, and confirmed attempts', () => withCampaignDatabase((db) => {
  seedPageThread(db, { id: 'thread-inflight-check', accountId: 'acc-status-test' });
  const campaign = CampaignService.createDraft({
    name: 'Status test',
    thread_ids: ['thread-inflight-check'],
    messages: [
      { text_content: '1' }, { text_content: '2' },
      { text_content: '3' }, { text_content: '4' }
    ],
    send_cap: 1
  }, db);
  CampaignService.preview(campaign.id, db);

  // 1. Initial count: 0
  assert.equal(CampaignRepository.countAccountSentToday('acc-status-test', db), 0);

  // 2. Created attempt counts towards quota
  const rec1 = CampaignRepository.getNextRecipient(campaign.id, db);
  const att1 = CampaignRepository.createAttempt(rec1.id, rec1.campaign_message_id, db);
  assert.equal(CampaignRepository.countAccountSentToday('acc-status-test', db), 1);

  // 3. Dispatched attempt counts towards quota
  CampaignRepository.linkAttemptQueue(att1.id, 'queue-1', 'client-1', db);
  assert.equal(CampaignRepository.countAccountSentToday('acc-status-test', db), 1);

  // 4. Confirmed attempt counts towards quota
  CampaignRepository.finishAttempt(att1.id, 'confirmed', null, null, db);
  assert.equal(CampaignRepository.countAccountSentToday('acc-status-test', db), 1);

  // 5. Unknown attempt counts towards quota (conservative anti-spam policy)
  const rec2 = CampaignRepository.getNextRecipient(campaign.id, db);
  const att2 = CampaignRepository.createAttempt(rec2.id, rec2.campaign_message_id, db);
  CampaignRepository.finishAttempt(att2.id, 'unknown', null, null, db);
  assert.equal(CampaignRepository.countAccountSentToday('acc-status-test', db), 2);
}));

test('validateReadyForStart reserves quota for concurrent running campaigns on same account', () => withCampaignDatabase((db) => {
  seedPageThread(db, { id: 'thread-c1-rec1', accountId: 'acc-compete' });
  seedPageThread(db, { id: 'thread-c2-rec1', accountId: 'acc-compete' });

  // Campaign 1: 1 recipient x 3 messages = 3 messages planned
  const c1 = CampaignService.createDraft({
    name: 'Campaign 1 Running',
    thread_ids: ['thread-c1-rec1'],
    messages: [{ text_content: 'A' }, { text_content: 'B' }, { text_content: 'C' }],
    send_cap: 1
  }, db);
  CampaignService.preview(c1.id, db);
  CampaignRepository.updateCampaignStatus(c1.id, 'ready', 'running', db);

  // Campaign 2: 1 recipient x 3 messages = 3 messages planned
  const c2 = CampaignService.createDraft({
    name: 'Campaign 2 Competing',
    thread_ids: ['thread-c2-rec1'],
    messages: [{ text_content: 'D' }, { text_content: 'E' }, { text_content: 'F' }],
    send_cap: 1
  }, db);
  CampaignService.preview(c2.id, db);

  // If daily cap = 5:
  // Campaign 1 reserved 3 messages, Campaign 2 needs 3 messages. Total = 6 > 5.
  assert.throws(
    () => CampaignService.validateReadyForStart(c2.id, db, { accountDailyCap: 5 }),
    (err) => {
      assert.equal(err.code, CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED);
      assert.equal(err.details.other_running, 3);
      assert.equal(err.details.planned, 3);
      assert.equal(err.details.cap, 5);
      return true;
    }
  );

  // If daily cap = 6 (>= 6): Starting Campaign 2 passes
  const ready = CampaignService.validateReadyForStart(c2.id, db, { accountDailyCap: 6 });
  assert.ok(ready);
}));

test('createAttempt atomically enforces daily cap inside SQLite transaction', () => withCampaignDatabase((db) => {
  seedPageThread(db, { id: 'thread-atomic-cap', accountId: 'acc-atomic' });
  const campaign = CampaignService.createDraft({
    name: 'Atomic cap test',
    thread_ids: ['thread-atomic-cap'],
    messages: [{ text_content: '1' }, { text_content: '2' }],
    send_cap: 1
  }, db);
  CampaignService.preview(campaign.id, db);

  const recipient = CampaignRepository.getNextRecipient(campaign.id, db);

  // With accountDailyCap = 1: first attempt succeeds
  const att1 = CampaignRepository.createAttempt(recipient.id, recipient.campaign_message_id, db, { accountDailyCap: 1 });
  assert.ok(att1.id);
  CampaignRepository.finishAttempt(att1.id, 'confirmed', null, null, db);

  // Second attempt hits cap limit 1 atomically and throws SEND_LIMIT_REACHED
  const nextRec = CampaignRepository.getNextRecipient(campaign.id, db);
  assert.throws(
    () => CampaignRepository.createAttempt(nextRec.id, nextRec.campaign_message_id, db, { accountDailyCap: 1 }),
    (err) => err.code === 'SEND_LIMIT_REACHED'
  );
}));

test('CampaignRunner pauses cleanly when daily cap is reached without infinite loop', () => withCampaignDatabase(async (db) => {
  seedPageThread(db, { id: 'thread-runner-cap', accountId: 'acc-runner-cap' });
  const campaign = CampaignService.createDraft({
    name: 'Runner daily cap test',
    thread_ids: ['thread-runner-cap'],
    messages: [{ text_content: 'Message 1' }, { text_content: 'Message 2' }],
    pacing_ms: 0,
    send_cap: 2
  }, db);
  CampaignService.preview(campaign.id, db);
  CampaignRepository.updateCampaignStatus(campaign.id, 'ready', 'running', db);

  const dispatched = [];
  const queue = new Map();
  const runner = new CampaignRunner({ database: db });
  runner.configure({
    accountDailyCap: 1, // Cap is 1, so 1st message sends, 2nd hits SEND_LIMIT_REACHED
    enqueueMessage: async ({ recipient, attempt }) => {
      const queueId = 'queue-' + attempt.id;
      dispatched.push(recipient.text_content);
      queue.set(queueId, { id: queueId, status: 'sent' });
      return { queueId, clientMessageId: 'cli_' + queueId };
    },
    getQueueStatus: (queueId) => queue.get(queueId),
    pollIntervalMs: 1,
    confirmationTimeoutMs: 100,
    database: db
  });

  // Runner should not hang or loop infinitely; it must pause and complete cleanly
  await runner.start(campaign.id);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], 'Message 1');

  const updatedCampaign = CampaignRepository.getCampaign(campaign.id, db);
  assert.equal(updatedCampaign.status, 'paused', 'Campaign must be paused upon reaching daily cap');

  // Verify recipient for message 2 is still pending so it can resume later
  const nextRec = CampaignRepository.getNextRecipient(campaign.id, db);
  assert.ok(nextRec, 'Unsent message recipient remains pending');
  assert.equal(nextRec.status, 'pending');

  // Verify audit log recorded the paused event with reason SEND_LIMIT_REACHED
  const auditEntries = db.prepare('SELECT * FROM campaign_audit_events WHERE campaign_id = ? AND event_type = ?').all(campaign.id, 'paused');
  assert.ok(auditEntries.length > 0, 'Audit log must record paused event');
  const auditPayload = JSON.parse(auditEntries[auditEntries.length - 1].payload_json);
  assert.equal(auditPayload.reason, 'SEND_LIMIT_REACHED');

  // Runner is no longer in active runners map
  assert.equal(runner.runners.has(campaign.id), false);
}));

test('Concurrent race condition: simultaneous attempts under tight cap allow only 1 to succeed', () => withCampaignDatabase(async (db) => {
  seedPageThread(db, { id: 'thread-race-1', accountId: 'acc-race' });
  seedPageThread(db, { id: 'thread-race-2', accountId: 'acc-race' });

  const campaign = CampaignService.createDraft({
    name: 'Race condition test',
    thread_ids: ['thread-race-1', 'thread-race-2'],
    messages: [{ text_content: 'Promo race' }],
    send_cap: 2
  }, db);
  CampaignService.preview(campaign.id, db);

  const rec1 = db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND thread_id = 'thread-race-1'").get(campaign.id);
  const rec2 = db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND thread_id = 'thread-race-2'").get(campaign.id);

  // Both attempt to reserve the single remaining quota concurrently
  const results = await Promise.allSettled([
    Promise.resolve().then(() => CampaignRepository.createAttempt(rec1.id, campaign.messages[0].id, db, { accountDailyCap: 1 })),
    Promise.resolve().then(() => CampaignRepository.createAttempt(rec2.id, campaign.messages[0].id, db, { accountDailyCap: 1 }))
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one concurrent attempt must succeed');
  assert.equal(rejected.length, 1, 'Exactly one concurrent attempt must be rejected');
  assert.equal(rejected[0].reason.code, 'SEND_LIMIT_REACHED');

  // Total attempts created in DB must be exactly 1
  const count = db.prepare("SELECT COUNT(*) AS count FROM campaign_attempts WHERE status IN ('created', 'dispatched', 'unknown', 'confirmed')").get().count;
  assert.equal(count, 1, 'Database must never have more attempts than cap');
}));

test('validateReadyForStart counts only remaining unsent messages for retry/resumed campaigns', () => withCampaignDatabase((db) => {
  seedPageThread(db, { id: 'thread-retry-calc', accountId: 'acc-retry-calc' });

  // 1 recipient, 3 messages
  const campaign = CampaignService.createDraft({
    name: 'Retry calculation test',
    thread_ids: ['thread-retry-calc'],
    messages: [{ text_content: 'M1' }, { text_content: 'M2' }, { text_content: 'M3' }],
    send_cap: 3
  }, db);
  CampaignService.preview(campaign.id, db);

  const recipient = CampaignRepository.getNextRecipient(campaign.id, db);

  // Simulate Message 1 was already confirmed in an earlier run yesterday
  // (we insert an attempt with confirmed status and an older date so it is not in sentToday)
  db.prepare(`
    INSERT INTO campaign_attempts (id, campaign_recipient_id, campaign_message_id, attempt_number, idempotency_key, status, created_at, confirmed_at)
    VALUES ('att-past-1', ?, ?, 1, 'past-key-1', 'confirmed', datetime('now', '-2 days'), datetime('now', '-2 days'))
  `).run(recipient.id, campaign.messages[0].id);

  // Since message 1 is confirmed, remaining messages are 2 (M2 and M3).
  // If accountDailyCap is 2:
  // Old code would compute planned = 1 recipient * 3 messages = 3, failing cap 2.
  // Fixed code computes planned = 2, so it succeeds with cap = 2!
  const ready = CampaignService.validateReadyForStart(campaign.id, db, { accountDailyCap: 2 });
  assert.ok(ready, 'Validation must pass when remaining messages fit inside daily cap');

  // If daily cap is 1: remaining (2) > 1, so it properly fails
  assert.throws(
    () => CampaignService.validateReadyForStart(campaign.id, db, { accountDailyCap: 1 }),
    (err) => err.code === CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED
  );
}));

