const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const CampaignResponseStatsService = require('../../src/server/services/CampaignResponseStatsService');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY);
    CREATE TABLE threads (id TEXT PRIMARY KEY, contact_name TEXT);
    CREATE TABLE campaign_recipients (id TEXT PRIMARY KEY, campaign_id TEXT, thread_id TEXT, account_id TEXT, status TEXT, sent_at TEXT, selection_order INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, fb_message_id TEXT, thread_id TEXT, content TEXT, is_outgoing INTEGER, created_at TEXT);
    CREATE TABLE contact_phone_captures (id INTEGER PRIMARY KEY, thread_id TEXT, message_id TEXT, normalized_phone TEXT, selection_state TEXT, message_timestamp_ms INTEGER, detected_at TEXT);
    CREATE TABLE campaign_response_events (id INTEGER PRIMARY KEY, campaign_id TEXT, campaign_recipient_id TEXT, message_id INTEGER UNIQUE, created_at TEXT);
  `);
  return db;
}

test('counts a newly attributed reply without comparing timestamps', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:07', 1);
    INSERT INTO messages VALUES (1, 'mid.reply', 'thread-1', 'Phản hồi đầu tiên', 0, '2026-01-01 10:00:00');
    INSERT INTO campaign_response_events VALUES (1, 'campaign-1', 'recipient-1', 1, '2026-01-01 10:00:08');
  `);
  const result = CampaignResponseStatsService.get('campaign-1', db);
  assert.equal(result.counts.replied, 1);
  assert.equal(result.recipients[0].reply_preview, 'Phản hồi đầu tiên');
  db.close();
});

test('a historical message is not counted without a response event', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.old', 'thread-1', 'Tin cũ', 0, '2099-01-01 10:00:00');
  `);
  const result = CampaignResponseStatsService.get('campaign-1', db);
  assert.equal(result.counts.replied, 0);
  db.close();
});

test('phone statistics use the capture attached to the attributed message', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.phone', 'thread-1', '0912345678', 0, '2026-01-01 10:01:00');
    INSERT INTO campaign_response_events VALUES (1, 'campaign-1', 'recipient-1', 1, '2026-01-01 10:01:01');
    INSERT INTO contact_phone_captures VALUES (1, 'thread-1', 'mid.phone.upgraded', '0912345678', 'selected', 1767261660000, '2026-01-01 10:01:01');
  `);
  const result = CampaignResponseStatsService.get('campaign-1', db);
  assert.equal(result.counts.with_phone, 1);
  assert.equal(result.recipients[0].phone, '0912345678');
  db.close();
});

test('missed calls never count as campaign replies and stale attribution is repaired', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-call');
    INSERT INTO threads VALUES ('thread-call', 'Khách Gọi');
    INSERT INTO campaign_recipients VALUES ('recipient-call', 'campaign-call', 'thread-call', 'account-1', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.call', 'thread-call', 'Cuộc gọi nhỡ', 0, '2026-01-01 10:01:00');
    INSERT INTO campaign_response_events VALUES (1, 'campaign-call', 'recipient-call', 1, '2026-01-01 10:01:01');
  `);
  const result = CampaignResponseStatsService.get('campaign-call', db);
  assert.equal(result.counts.replied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_response_events').get().count, 0);
  assert.equal(CampaignResponseStatsService.recordIncomingResponse({ messageId: 1, threadId: 'thread-call', accountId: 'account-1' }, db), null);
  db.close();
});

test('outgoing messages never count as campaign replies', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-own');
    INSERT INTO threads VALUES ('thread-own', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-own', 'campaign-own', 'thread-own', 'account-1', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.own', 'thread-own', 'Tin chiến dịch', 1, '2026-01-01 10:00:01');
  `);
  assert.equal(CampaignResponseStatsService.recordIncomingResponse({ messageId: 1, threadId: 'thread-own', accountId: 'account-1' }, db), null);
  db.close();
});
test('records an incoming reply against the latest sent campaign recipient', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-old'), ('campaign-new');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-old', 'campaign-old', 'thread-1', 'account-1', 'sent', '2026-01-01 09:00:00', 1);
    INSERT INTO campaign_recipients VALUES ('recipient-new', 'campaign-new', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.reply', 'thread-1', 'Em phản hồi', 0, '2026-01-01 10:00:01');
  `);
  const event = CampaignResponseStatsService.recordIncomingResponse({ messageId: 1, threadId: 'thread-1', accountId: 'account-1' }, db);
  assert.equal(event.campaign_id, 'campaign-new');
  assert.equal(CampaignResponseStatsService.get('campaign-new', db).counts.replied, 1);
  assert.equal(CampaignResponseStatsService.get('campaign-old', db).counts.replied, 0);
  assert.equal(CampaignResponseStatsService.recordIncomingResponse({ messageId: 1, threadId: 'thread-1', accountId: 'account-1' }, db).campaign_id, 'campaign-new');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_response_events').get().count, 1);
  db.close();
});

test('does not attribute an incoming message to another account', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-2', 'sent', '2026-01-01 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'mid.reply', 'thread-1', 'Sai tài khoản', 0, '2026-01-01 10:00:01');
  `);
  assert.equal(CampaignResponseStatsService.recordIncomingResponse({ messageId: 1, threadId: 'thread-1', accountId: 'account-1' }, db), null);
  db.close();
});

test('rejects a historical DOM message from before the campaign send minute', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 13:55:40', 1);
    INSERT INTO messages VALUES (1, 'mid.old', 'thread-1', 'Tin cũ', 0, '2026-01-01 13:45:00');
  `);
  assert.equal(CampaignResponseStatsService.recordIncomingResponse({
    messageId: 1, threadId: 'thread-1', accountId: 'account-1', observedAtMs: Date.parse('2026-01-01T13:45:00Z')
  }, db), null);
  db.close();
});

test('accepts the first reply in the same displayed minute as campaign send', () => {
  const db = createDb();
  db.exec(`
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 13:55:40', 1);
    INSERT INTO messages VALUES (1, 'mid.phone', 'thread-1', '0973148256', 0, '2026-01-01 13:55:00');
  `);
  const result = CampaignResponseStatsService.recordIncomingResponse({
    messageId: 1, threadId: 'thread-1', accountId: 'account-1', observedAtMs: Date.parse('2026-01-01T13:55:00Z')
  }, db);
  assert.equal(result.campaign_id, 'campaign-1');
  db.close();
});
