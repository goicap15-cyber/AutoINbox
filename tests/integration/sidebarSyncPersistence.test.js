const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

test('partial sidebar snapshot preserves other conversations', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  ConversationRepository.upsertThread({ id: 'thread-2', account_id: 'acct-1', contact_name: 'Bob' }, db);
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', last_message: 'Mới nhất' }, db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM threads').get().count, 2);
  assert.equal(db.prepare('SELECT last_message FROM threads WHERE id = ?').get('thread-2').last_message, null);
  db.close();
});

test('same Facebook thread id stays isolated between connected accounts', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'First', '/tmp/first');
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-2', 'Second', '/tmp/second');

  const first = ConversationRepository.upsertThread({
    id: 'shared-facebook-id',
    external_thread_id: 'shared-facebook-id',
    account_id: 'acct-1',
    contact_name: 'First contact'
  }, db);
  const second = ConversationRepository.upsertThread({
    id: 'shared-facebook-id',
    external_thread_id: 'shared-facebook-id',
    account_id: 'acct-2',
    contact_name: 'Second contact'
  }, db);

  assert.equal(first.id, 'shared-facebook-id');
  assert.equal(second.id, 'acct-2:shared-facebook-id');
  assert.equal(db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(first.id).contact_name, 'First contact');
  assert.equal(db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(second.id).contact_name, 'Second contact');
  db.close();
});
test('empty sidebar snapshot preserves all conversations', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({ id: 'thread-1', account_id: 'acct-1', contact_name: 'Alice' }, db);
  const before = db.prepare('SELECT COUNT(*) AS count FROM threads').get().count;
  const after = db.prepare('SELECT COUNT(*) AS count FROM threads').get().count;
  assert.equal(after, before);
  db.close();
});

test('incoming updates do not promote a message request into the normal inbox', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({
    id: 'request-1',
    account_id: 'acct-1',
    contact_name: 'Request sender',
    inbox_folder: 'MESSAGE_REQUEST_SPAM'
  }, db);

  ConversationRepository.upsertThread({
    id: 'request-1',
    account_id: 'acct-1',
    last_message: 'Khách gửi thêm tin'
  }, db);

  assert.equal(
    db.prepare('SELECT inbox_folder FROM threads WHERE id = ?').get('request-1').inbox_folder,
    'MESSAGE_REQUEST_SPAM'
  );
  db.close();
});

test('an explicit inbox sync can promote a replied message request', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({
    id: 'request-1',
    account_id: 'acct-1',
    inbox_folder: 'MESSAGE_REQUEST_POSSIBLE'
  }, db);
  ConversationRepository.upsertThread({
    id: 'request-1',
    account_id: 'acct-1',
    inbox_folder: 'INBOX'
  }, db);

  assert.equal(
    db.prepare('SELECT inbox_folder FROM threads WHERE id = ?').get('request-1').inbox_folder,
    'INBOX'
  );
  db.close();
});

test('a verified Requests surface can repair a legacy Inbox classification', () => {
  const db = getTestDatabase();
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acct-1', 'Test', '/tmp/test');
  ConversationRepository.upsertThread({
    id: 'legacy-request',
    account_id: 'acct-1',
    inbox_folder: 'INBOX'
  }, db);
  ConversationRepository.upsertThread({
    id: 'legacy-request',
    account_id: 'acct-1',
    inbox_folder: 'MESSAGE_REQUEST_POSSIBLE',
    inbox_folder_verified: true
  }, db);

  assert.equal(
    db.prepare('SELECT inbox_folder FROM threads WHERE id = ?').get('legacy-request').inbox_folder,
    'MESSAGE_REQUEST_POSSIBLE'
  );
  db.close();
});
