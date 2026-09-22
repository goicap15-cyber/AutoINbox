const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanFacebookProfileUrl,
  isProfileLinkIndicator,
  extractProfileUrlFromElement
} = require('../../src/extension/pageProfileUrlExtractor');
const Database = require('better-sqlite3');
const ContactService = require('../../src/server/services/ContactService');

test('cleanFacebookProfileUrl cleans numeric profile.php URLs', () => {
  assert.equal(
    cleanFacebookProfileUrl('https://www.facebook.com/profile.php?id=100018089229407&__tn__=R'),
    'https://www.facebook.com/profile.php?id=100018089229407'
  );
  assert.equal(
    cleanFacebookProfileUrl('https://facebook.com/profile.php?id=61592703398056'),
    'https://www.facebook.com/profile.php?id=61592703398056'
  );
  assert.equal(
    cleanFacebookProfileUrl('//facebook.com/user/100027516660484/'),
    'https://www.facebook.com/profile.php?id=100027516660484'
  );
});

test('cleanFacebookProfileUrl cleans vanity username URLs', () => {
  assert.equal(
    cleanFacebookProfileUrl('https://www.facebook.com/hung.pham.dev?mibextid=ZbWKwL'),
    'https://www.facebook.com/hung.pham.dev'
  );
  assert.equal(
    cleanFacebookProfileUrl('https://facebook.com/thuoanh.nguyen.12'),
    'https://www.facebook.com/thuoanh.nguyen.12'
  );
});

test('cleanFacebookProfileUrl rejects Business Suite, system routes, and external links', () => {
  assert.equal(cleanFacebookProfileUrl('https://business.facebook.com/latest/inbox/all'), null);
  assert.equal(cleanFacebookProfileUrl('https://www.facebook.com/messages/t/100018089229407'), null);
  assert.equal(cleanFacebookProfileUrl('https://www.facebook.com/policies/cookies/'), null);
  assert.equal(cleanFacebookProfileUrl('https://www.facebook.com/help/12345'), null);
  assert.equal(cleanFacebookProfileUrl('https://google.com'), null);
  assert.equal(cleanFacebookProfileUrl(''), null);
  assert.equal(cleanFacebookProfileUrl(null), null);
});

test('isProfileLinkIndicator recognizes profile cues in text and href', () => {
  assert.equal(isProfileLinkIndicator('', 'Xem trang cá nhân trên Facebook'), true);
  assert.equal(isProfileLinkIndicator('', 'View profile on Facebook'), true);
  assert.equal(isProfileLinkIndicator('https://www.facebook.com/profile.php?id=123', ''), true);
  assert.equal(isProfileLinkIndicator('https://www.facebook.com/user/123', ''), true);
  assert.equal(isProfileLinkIndicator('https://business.facebook.com/settings', 'Cài đặt'), false);
});

test('extractProfileUrlFromElement fallback to numeric threadId when no container exists', () => {
  assert.equal(
    extractProfileUrlFromElement(null, '100018089229407'),
    'https://www.facebook.com/profile.php?id=100018089229407'
  );
  assert.equal(
    extractProfileUrlFromElement(null, '61592703398056'),
    'https://www.facebook.com/profile.php?id=61592703398056'
  );
  // Non-numeric or short string threadId must not produce fake URL
  assert.equal(extractProfileUrlFromElement(null, 'short_id'), null);
  assert.equal(extractProfileUrlFromElement(null, '12345'), null);
});

test('ContactService.update persists and retrieves profile_url in SQLite', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      thread_id TEXT PRIMARY KEY,
      name TEXT,
      nickname TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      tags TEXT,
      lead_captured BOOLEAN DEFAULT 0,
      avatar_url TEXT,
      status_id INTEGER,
      custom_fields TEXT DEFAULT '[]',
      phone_source TEXT,
      phone_capture_id INTEGER,
      phone_captured_at DATETIME,
      profile_url TEXT
    );
  `);

  const threadId = 'thread_page_test_123';
  const updated = ContactService.update(threadId, {
    name: 'Khách Test Fanpage',
    profile_url: 'https://www.facebook.com/profile.php?id=100018089229407'
  }, db);

  assert.equal(updated.name, 'Khách Test Fanpage');
  assert.equal(updated.profile_url, 'https://www.facebook.com/profile.php?id=100018089229407');

  const row = db.prepare('SELECT profile_url FROM contacts WHERE thread_id = ?').get(threadId);
  assert.equal(row.profile_url, 'https://www.facebook.com/profile.php?id=100018089229407');

  db.close();
});
