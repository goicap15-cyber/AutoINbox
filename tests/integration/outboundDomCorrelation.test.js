const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const OutboundDomCorrelationService = require('../../src/server/services/OutboundDomCorrelationService');
const MessageQueueRepository = require('../../src/server/repositories/MessageQueueRepository');

function withDatabase(run) {
  const db = getTestDatabase(':memory:');
  try { return run(db); } finally { db.close(); }
}

function seedPendingOutbound(db, { threadId, content, clientMessageId, createdAt = null }) {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run(threadId, threadId, 'acct-1', 'Khach hang');
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status, created_at)
    VALUES (?, ?, ?, 'SYSTEM', ?, 1, 'pending', COALESCE(?, CURRENT_TIMESTAMP))
  `).run(threadId, `pending_${clientMessageId}`, clientMessageId, content, createdAt);
}

// Regression: a real Page/Business Suite send confirmation used to get its
// text fully collapsed to '' by the junk/system-text filter (cleanMessageText)
// before the correlation logic ever ran, leaving an already-delivered send
// stuck at delivery_status='pending' forever. matchPendingOutboundByRawContent
// is the fix - it matches on the RAW (pre-cleaning) DOM text instead.
test('matches a pending outbound row by raw content when cleaned content collapsed to empty', () => withDatabase((db) => {
  seedPendingOutbound(db, { threadId: 'thread-1', content: 'Đây là tin nhắn kiểm tra spec 038', clientMessageId: 'queue_abc123' });

  const match = OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-1', 'Đây là tin nhắn kiểm tra spec 038');
  assert.ok(match, 'must find the pending row by raw content');
  assert.equal(match.client_message_id, 'queue_abc123');
}));

test('confirmPendingOutbound flips the row to sent and is replay-safe', () => withDatabase((db) => {
  seedPendingOutbound(db, { threadId: 'thread-2', content: 'hello world', clientMessageId: 'queue_def456' });
  const match = OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-2', 'hello world');
  assert.ok(match);

  const confirmed = OutboundDomCorrelationService.confirmPendingOutbound(db, null, match, {
    fbMessageId: 'mid.$REAL1',
    tsMs: 1000,
    tsSource: 'dom_order',
    rawMessage: { thread_id: 'thread-2', content: 'hello world' }
  });
  assert.equal(confirmed, true);

  const row = db.prepare('SELECT delivery_status, fb_message_id FROM messages WHERE client_message_id = ?').get('queue_def456');
  assert.deepEqual(row, { delivery_status: 'sent', fb_message_id: 'mid.$REAL1' });

  // A replayed observation for the same fb_message_id must be a no-op, not a
  // second update or a crash.
  const replay = OutboundDomCorrelationService.confirmPendingOutbound(db, null, match, {
    fbMessageId: 'mid.$REAL1',
    tsMs: 2000,
    tsSource: 'dom_order',
    rawMessage: { thread_id: 'thread-2', content: 'hello world' }
  });
  assert.equal(replay, false);
}));

test('does not match a pending row from a different thread or with unrelated content', () => withDatabase((db) => {
  seedPendingOutbound(db, { threadId: 'thread-3', content: 'unrelated pending text', clientMessageId: 'queue_ghi789' });

  assert.equal(OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-other', 'unrelated pending text'), null);
  assert.equal(OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-3', 'something completely different'), null);
  assert.equal(OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-3', ''), null);
}));

// A pending row old enough to be outside the confirmation window must not be
// coincidentally claimed by a much later, unrelated echo of the same text.
test('does not match a pending row created outside the confirmation window', () => withDatabase((db) => {
  const staleCreatedAt = "datetime('now', '-10 minutes')";
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-4', 'thread-4', 'acct-1', 'Khach hang');
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status, created_at)
    VALUES ('thread-4', 'pending_queue_stale', 'queue_stale', 'SYSTEM', 'stale text', 1, 'pending', ${staleCreatedAt})
  `).run();

  assert.equal(OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, 'thread-4', 'stale text'), null);
}));

function seedPendingImageOutbound(db, { threadId, accountId = 'acct-img', createdAtModifier = null } = {}) {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run(accountId, 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run(threadId, threadId, accountId, 'Khach hang');
  const queueId = MessageQueueRepository.insertCampaignDispatch({
    thread_id: threadId,
    account_id: accountId,
    content: '',
    attachment_id: 'attachment-1',
    attachment_path: '/tmp/fake.jpg',
    campaign_id: 'campaign-1',
    campaign_recipient_id: 'recipient-1',
    campaign_attempt_id: 'attempt-1',
    idempotency_key: 'campaign:campaign-1:recipient:recipient-1:attempt:1-' + threadId
  }, db).queueId;
  if (createdAtModifier) {
    db.prepare("UPDATE messages SET created_at = datetime('now', ?) WHERE client_message_id = ?")
      .run(createdAtModifier, 'queue_' + queueId);
  }
  return queueId;
}

// Regression: the image-confirmation match previously had no time bound at
// all, so a pending image could sit indefinitely and later be coincidentally
// claimed by an unrelated confirmation. matchPendingImageOutbound applies the
// same confirmation-window bound already used for the text match.
test('matchPendingImageOutbound finds a recent pending image dispatch', () => withDatabase((db) => {
  const queueId = seedPendingImageOutbound(db, { threadId: 'thread-img-1' });
  const match = OutboundDomCorrelationService.matchPendingImageOutbound(db, 'thread-img-1');
  assert.ok(match);
  assert.equal(match.client_message_id, 'queue_' + queueId);
}));

test('matchPendingImageOutbound does not match a pending image outside the confirmation window', () => withDatabase((db) => {
  seedPendingImageOutbound(db, { threadId: 'thread-img-2', createdAtModifier: '-10 minutes' });
  assert.equal(OutboundDomCorrelationService.matchPendingImageOutbound(db, 'thread-img-2'), null);
}));

test('matchPendingImageOutbound does not match a pending image from a different thread', () => withDatabase((db) => {
  seedPendingImageOutbound(db, { threadId: 'thread-img-3' });
  assert.equal(OutboundDomCorrelationService.matchPendingImageOutbound(db, 'thread-img-other'), null);
}));

// Regression (spec 040): a manifest dispatch (message_queue.manifest_id set,
// attachment_id NULL) was invisible to this matcher entirely - the query only
// ever checked attachment_id IS NOT NULL, so a campaign send with several
// files or one folder ZIP would never get confirmed and would time out even
// on a real, successful Facebook send. Caught by campaignFileTransport.test.js
// before this fix; pinned here at the unit level too.
test('matchPendingImageOutbound finds a pending manifest dispatch (no attachment_id, only manifest_id)', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-manifest', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-manifest-1', 'thread-manifest-1', 'acct-manifest', 'Khach hang');
  const { queueId, clientMessageId } = MessageQueueRepository.insertCampaignDispatch({
    thread_id: 'thread-manifest-1',
    account_id: 'acct-manifest',
    content: '',
    manifest_id: 'manifest-1',
    campaign_id: 'campaign-1',
    campaign_recipient_id: 'recipient-1',
    campaign_attempt_id: 'attempt-1',
    idempotency_key: 'campaign:campaign-1:recipient:recipient-1:attempt:manifest'
  }, db);

  const match = OutboundDomCorrelationService.matchPendingImageOutbound(db, 'thread-manifest-1');
  assert.ok(match, 'must find the pending manifest dispatch row');
  assert.equal(match.client_message_id, clientMessageId);
  assert.equal(clientMessageId, 'queue_' + queueId);
}));

// Regression (spec 040 T020): a real file-transport image send with a
// caption was confirmed live 2026-08-17/18 to arrive as ONE DOM event with
// BOTH real media evidence (media_type/media_url) AND non-empty content -
// page_content.js's resolveMessageContent was fixed the same day to report
// this shape instead of dropping the image. isMediaConfirmationEvent must
// treat this as a media confirmation regardless of the caption, or a real
// successful file-transport send could never be recognized as sent (it
// would fall through to the text-only match, which correctly refuses to
// confirm a manifest/attachment dispatch by content alone - see
// matchPendingOutboundByRawContent above - and time out, triggering a real
// duplicate resend since QUEUE_CONFIRMATION_TIMEOUT is retryable).
test('isMediaConfirmationEvent treats media evidence as a confirmation even with a caption present', () => {
  assert.equal(
    OutboundDomCorrelationService.isMediaConfirmationEvent({ content: 'Test caption', media_type: 'image', media_url: null }),
    true
  );
  assert.equal(
    OutboundDomCorrelationService.isMediaConfirmationEvent({ content: 'Test caption', media_type: null, media_url: 'https://scontent.example/x.jpg' }),
    true
  );
  assert.equal(
    OutboundDomCorrelationService.isMediaConfirmationEvent({ content: '', media_type: 'image', media_url: null }),
    true
  );
  assert.equal(
    OutboundDomCorrelationService.isMediaConfirmationEvent({ content: 'plain text only', media_type: 'text', media_url: null }),
    false
  );
  assert.equal(
    OutboundDomCorrelationService.isMediaConfirmationEvent({ content: '', media_type: 'text', media_url: null }),
    false
  );
});

test('matches a temporary numeric outbound id to a later official mid by Messenger timestamp', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-upgrade', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-upgrade', 'thread-upgrade', 'acct-upgrade', 'Khach hang');
  db.prepare(`INSERT INTO messages
    (thread_id, fb_message_id, client_message_id, sender_id, content, media_type, is_outgoing, delivery_status, timestamp_ms, created_at)
    VALUES ('thread-upgrade', '7503047504317053640', 'client_one', 'acct-upgrade', 'same text', 'text', 1, 'sent', 100000, datetime('now', '-30 seconds'))`).run();

  const match = OutboundDomCorrelationService.findTemporaryIdUpgrade(db, 'thread-upgrade', {
    fb_message_id: 'mid.$OFFICIAL', content: 'same text', media_type: 'text', timestamp_ms: 100000
  }, false);
  assert.ok(match);
  assert.equal(match.client_message_id, 'client_one');
}));

test('collapses stored numeric and official ids for the same outbound text', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-collapse', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-collapse', 'thread-collapse', 'acct-collapse', 'Khach hang');
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, media_type, is_outgoing, delivery_status, timestamp_ms)
    VALUES ('thread-collapse', '7503047504317053640', 'client_one', 'acct-collapse', 'same text', 'text', 1, 'sent', 100000)`).run();
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, sender_id, content, media_type, is_outgoing, delivery_status, timestamp_ms)
    VALUES ('thread-collapse', 'mid.$OFFICIAL', 'acct-collapse', 'same text', 'text', 1, 'sent', 100000)`).run();

  assert.equal(OutboundDomCorrelationService.collapseStoredTemporaryIdUpgrades(db, 'thread-collapse'), 1);
  const rows = db.prepare('SELECT fb_message_id, client_message_id FROM messages WHERE thread_id = ?').all('thread-collapse');
  assert.deepEqual(rows, [{ fb_message_id: 'mid.$OFFICIAL', client_message_id: 'client_one' }]);
}));

test('merges a Messenger _media companion into its caption/base row', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-media', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-media', 'thread-media', 'acct-media', 'Khach hang');
  db.prepare(`INSERT INTO messages
    (thread_id, fb_message_id, sender_id, content, media_type, is_outgoing, delivery_status)
    VALUES ('thread-media', 'mid.$ONE', 'acct-media', 'caption', 'text', 1, 'sent')`).run();

  const merged = OutboundDomCorrelationService.mergeMediaCompanion(db, 'thread-media', {
    fb_message_id: 'mid.$ONE_media', media_type: 'image', media_url: 'https://example.test/image.jpg'
  }, true);

  assert.ok(merged);
  assert.equal(merged.fb_message_id, 'mid.$ONE');
  assert.equal(merged.content, 'caption');
  assert.equal(merged.media_type, 'image');
  assert.equal(merged.media_url, 'https://example.test/image.jpg');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM messages WHERE thread_id = ?').get('thread-media').total, 1);
}));

test('merges an official media companion into the existing temporary attachment row', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-temp-media', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-temp-media', 'thread-temp-media', 'acct-temp-media', 'Khach hang');
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, media_type, media_url, is_outgoing, delivery_status, timestamp_ms)
    VALUES ('thread-temp-media', '7503000', 'client-img', 'acct-temp-media', '', 'image', '/api/local', 1, 'sent', 137000)`).run();
  db.prepare(`INSERT INTO messages (thread_id, fb_message_id, sender_id, content, media_type, is_outgoing, delivery_status, timestamp_ms)
    VALUES ('thread-temp-media', 'mid.$IMG', 'acct-temp-media', '57', 'text', 1, 'sent', 100002)`).run();

  const merged = OutboundDomCorrelationService.mergeMediaCompanion(db, 'thread-temp-media', {
    fb_message_id: 'mid.$IMG_media', content: '', media_type: 'image', media_url: 'https://facebook/image.jpg',
    timestamp_ms: 100001, timestamp_source: 'dom_order'
  }, true);
  assert.ok(merged);
  assert.equal(merged.client_message_id, 'client-img');
  assert.equal(merged.fb_message_id, 'mid.$IMG');
  assert.equal(db.prepare('SELECT COUNT(*) total FROM messages WHERE thread_id = ?').get('thread-temp-media').total, 1);
}));

test('collapses media companion rows already stored in the database', () => withDatabase((db) => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-old-media', 'Test', '/tmp/test');
  db.prepare('INSERT OR IGNORE INTO threads (id, external_thread_id, account_id, contact_name) VALUES (?, ?, ?, ?)')
    .run('thread-old-media', 'thread-old-media', 'acct-old-media', 'Khach hang');
  db.prepare(`INSERT INTO messages
    (thread_id, fb_message_id, sender_id, content, media_type, is_outgoing, delivery_status)
    VALUES ('thread-old-media', 'mid.$OLD', 'acct-old-media', 'caption', 'text', 1, 'sent')`).run();
  db.prepare(`INSERT INTO messages
    (thread_id, fb_message_id, sender_id, content, media_type, media_url, is_outgoing, delivery_status)
    VALUES ('thread-old-media', 'mid.$OLD_media', 'acct-old-media', '', 'image', 'https://example.test/old.jpg', 1, 'sent')`).run();

  assert.equal(OutboundDomCorrelationService.collapseStoredMediaCompanions(db, 'thread-old-media'), 1);
  const rows = db.prepare('SELECT fb_message_id, content, media_type, media_url FROM messages WHERE thread_id = ?').all('thread-old-media');
  assert.deepEqual(rows, [{ fb_message_id: 'mid.$OLD', content: 'caption', media_type: 'image', media_url: 'https://example.test/old.jpg' }]);
}));
