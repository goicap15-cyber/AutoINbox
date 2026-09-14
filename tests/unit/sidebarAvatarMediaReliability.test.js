const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('client normalizes SQLite UTC timestamps in every sidebar ordering path', () => {
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  const item = fs.readFileSync('src/client/components/ConversationItem.jsx', 'utf8');
  const util = fs.readFileSync('src/client/utils/threadActivity.js', 'utf8');
  assert.match(util, /SQLITE_UTC_TIMESTAMP/);
  assert.match(util, /replace\(' ', 'T'\).*Z/);
  assert.equal((app.match(/sortThreadsByActivity\(/g) || []).length, 3);
  assert.match(item, /new Date\(normalizeThreadTimestamp\(value\)\)/);
});

test('REST starts bounded background media hydration and downloader follows Facebook redirects', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const downloader = fs.readFileSync('src/server/services/RobustMediaDownloader.js', 'utf8');
  assert.match(server, /const mediaDownloader = require\('\.\/services\/RobustMediaDownloader'\)/);
  assert.match(server, /app\.get\('\/api\/threads\/:id\/messages', async/);
  assert.match(server, /inboundMediaHydration\.hydrateThread\(req\.params\.id\)/);
  assert.doesNotMatch(server, /await inboundMediaHydration\.hydrateThreadAndWait\(req\.params\.id\)/);
  assert.match(downloader, /\[301, 302, 303, 307, 308\]/);
});

test('Facebook account avatar is persisted instead of reverting to a letter', () => {
  const schema = fs.readFileSync('src/server/database/schema.sql', 'utf8');
  const database = fs.readFileSync('src/server/database/db.js', 'utf8');
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS accounts \([\s\S]*?avatar_url TEXT/);
  assert.match(database, /version: 60[\s\S]*?ALTER TABLE accounts ADD COLUMN avatar_url TEXT/);
  assert.match(server, /saveAvatarFromBase64OrUrl\(avatar_url, `account_\$\{account_id\}`\)/);
  assert.match(server, /avatar_url = COALESCE\(excluded\.avatar_url, accounts\.avatar_url\)/);
});
