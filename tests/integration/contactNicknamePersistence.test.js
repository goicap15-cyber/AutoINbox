const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTestDatabase } = require('../helpers/testDatabase');
const ContactService = require('../../src/server/services/ContactService');

function withDb(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-nickname-'));
  const db = getTestDatabase(path.join(dir, 'database.db'));
  try {
    db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('a1', 'Test', '/tmp/test');
    db.prepare("INSERT INTO threads (id, account_id, contact_name) VALUES (?, ?, ?)").run('t1', 'a1', 'Tên Facebook');
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('persists, preserves and clears a CRM-only nickname', () => withDb((db) => {
  let contact = ContactService.update('t1', { name: 'Tên Facebook', nickname: '  Khách VIP  ' }, db);
  assert.equal(contact.nickname, 'Khách VIP');
  assert.equal(db.prepare('SELECT contact_name FROM threads WHERE id = ?').get('t1').contact_name, 'Tên Facebook');
  contact = ContactService.update('t1', { phone: '0912345678' }, db);
  assert.equal(contact.nickname, 'Khách VIP');
  contact = ContactService.update('t1', { nickname: '' }, db);
  assert.equal(contact.nickname, null);
}));

test('rejects nicknames longer than 80 characters', () => withDb((db) => {
  assert.throws(() => ContactService.update('t1', { nickname: 'x'.repeat(81) }, db),
    (error) => error.code === 'NICKNAME_TOO_LONG');
}));
