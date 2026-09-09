const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const AccountService = require('../../src/server/services/AccountService');

test('removing an account clears CRM-owned data and preserves campaign history', () => {
  const db = getTestDatabase();
  try {
    db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)')
      .run('acct-remove', 'Remove me', 'data/profiles/acct-remove');
    db.prepare(`
      INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name)
      VALUES ('src_personal_acct-remove', 'personal_messenger', NULL, 'acct-remove', 'Remove me'),
             ('src_page_keep', 'page_messenger', 'acct-remove', 'page-1', 'Keep page')
    `).run();
    db.prepare(`
      INSERT INTO threads (id, account_id, source_id, contact_name)
      VALUES ('thread-remove', 'acct-remove', 'src_personal_acct-remove', 'Customer')
    `).run();
    db.prepare(`
      INSERT INTO messages (thread_id, sender_id, content)
      VALUES ('thread-remove', 'customer-1', 'hello')
    `).run();
    db.prepare(`
      INSERT INTO contact_phone_captures
        (thread_id, normalized_phone, raw_phone, message_id)
      VALUES ('thread-remove', '84901234567', '0901234567', 'message-1')
    `).run();
    const captureId = db.prepare('SELECT id FROM contact_phone_captures').get().id;

    db.prepare("INSERT INTO campaigns (id, name) VALUES ('campaign-1', 'History')").run();
    db.prepare(`
      INSERT INTO campaign_recipients
        (id, campaign_id, thread_id, account_id, selection_order, execution_order, eligibility_status, status)
      VALUES ('recipient-1', 'campaign-1', 'thread-remove', 'acct-remove', 1, 1, 'eligible', 'pending')
    `).run();
    db.prepare(`
      INSERT INTO campaign_phone_capture_actions
        (campaign_id, campaign_recipient_id, phone_capture_id, policy)
      VALUES ('campaign-1', 'recipient-1', ?, 'stop_remaining')
    `).run(captureId);

    const result = AccountService.removeAccount('acct-remove', db);

    assert.equal(result.deleted, 1);
    assert.equal(result.cancelledRecipients, 1);
    assert.equal(result.detachedPages, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'acct-remove'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM removed_accounts WHERE account_id = 'acct-remove'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads WHERE id = 'thread-remove'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox_sources WHERE id = 'src_personal_acct-remove'").get().count, 0);
    assert.equal(db.prepare("SELECT owner_account_id FROM inbox_sources WHERE id = 'src_page_keep'").get().owner_account_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM campaign_phone_capture_actions").get().count, 0);
    assert.deepEqual(
      db.prepare("SELECT status, last_error_code FROM campaign_recipients WHERE id = 'recipient-1'").get(),
      { status: 'cancelled', last_error_code: 'ACCOUNT_REMOVED' }
    );
  } finally {
    db.close();
  }
});

test('removing an unknown account is a no-op', () => {
  const db = getTestDatabase();
  try {
    assert.equal(AccountService.removeAccount('missing', db), null);
  } finally {
    db.close();
  }
});
