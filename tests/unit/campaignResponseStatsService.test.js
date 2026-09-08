const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const CampaignResponseStatsService = require('../../src/server/services/CampaignResponseStatsService');

test('campaign response stats counts replies and phones after a successful send', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY);
    CREATE TABLE threads (id TEXT PRIMARY KEY, contact_name TEXT);
    CREATE TABLE campaign_recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT, thread_id TEXT, account_id TEXT,
      status TEXT, sent_at TEXT, selection_order INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, thread_id TEXT, content TEXT, is_outgoing INTEGER,
      is_unsent INTEGER, media_type TEXT, created_at TEXT
    );
    CREATE TABLE contact_phone_captures (
      id INTEGER PRIMARY KEY, thread_id TEXT, normalized_phone TEXT,
      selection_state TEXT, detected_at TEXT
    );
    INSERT INTO campaigns VALUES ('campaign-1');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một'), ('thread-2', 'Khách Hai');
    INSERT INTO campaign_recipients VALUES
      ('recipient-1', 'campaign-1', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:00', 1),
      ('recipient-2', 'campaign-1', 'thread-2', 'account-1', 'sent', '2026-01-01 10:00:00', 2);
    INSERT INTO messages VALUES
      (1, 'thread-1', 'Tin cũ', 0, 0, 'text', '2026-01-01 09:59:00'),
      (2, 'thread-1', 'Tôi quan tâm', 0, 0, 'text', '2026-01-01 10:05:00');
    INSERT INTO contact_phone_captures VALUES
      (1, 'thread-1', '0912345678', 'selected', '2026-01-01 10:06:00');
  `);

  const result = CampaignResponseStatsService.get('campaign-1', db);
  assert.deepEqual(result.counts, { sent: 2, replied: 1, with_phone: 1, unanswered: 1 });
  assert.equal(result.rates.reply_rate, 50);
  assert.equal(result.recipients.find((row) => row.recipient_id === 'recipient-1').reply_preview, 'Tôi quan tâm');
  assert.equal(result.recipients.find((row) => row.recipient_id === 'recipient-2').replied, false);
  db.close();
});

test('a response is attributed only to the newest campaign send for the thread', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY);
    CREATE TABLE threads (id TEXT PRIMARY KEY, contact_name TEXT);
    CREATE TABLE campaign_recipients (id TEXT PRIMARY KEY, campaign_id TEXT, thread_id TEXT, account_id TEXT, status TEXT, sent_at TEXT, selection_order INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT, content TEXT, is_outgoing INTEGER, is_unsent INTEGER, media_type TEXT, created_at TEXT);
    CREATE TABLE contact_phone_captures (id INTEGER PRIMARY KEY, thread_id TEXT, normalized_phone TEXT, selection_state TEXT, detected_at TEXT);
    INSERT INTO campaigns VALUES ('old'), ('new');
    INSERT INTO threads VALUES ('thread-1', 'Khách Một');
    INSERT INTO campaign_recipients VALUES
      ('old-r', 'old', 'thread-1', 'account-1', 'sent', '2026-01-01 10:00:00', 1),
      ('new-r', 'new', 'thread-1', 'account-1', 'sent', '2026-01-02 10:00:00', 1);
    INSERT INTO messages VALUES (1, 'thread-1', 'Trả lời chiến dịch mới', 0, 0, 'text', '2026-01-02 10:05:00');
  `);

  assert.equal(CampaignResponseStatsService.get('old', db).counts.replied, 0);
  assert.equal(CampaignResponseStatsService.get('new', db).counts.replied, 1);
  db.close();
});
