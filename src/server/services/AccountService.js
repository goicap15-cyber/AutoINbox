class AccountService {
  static removeAccount(accountId, database) {
    const normalizedId = String(accountId || '').trim();
    if (!normalizedId) {
      const error = new Error('Thiếu ID tài khoản');
      error.code = 'ACCOUNT_ID_REQUIRED';
      throw error;
    }

    const account = database.prepare(
      'SELECT id, name, profile_dir FROM accounts WHERE id = ?'
    ).get(normalizedId);
    if (!account) return null;

    const remove = database.transaction(() => {
      database.prepare(`
        INSERT INTO removed_accounts (account_id, removed_at)
        VALUES (?, CURRENT_TIMESTAMP)
        ON CONFLICT(account_id) DO UPDATE SET removed_at = CURRENT_TIMESTAMP
      `).run(normalizedId);

      // Phone-capture actions point to captures without ON DELETE CASCADE.
      // Remove those action rows first so deleting account-owned threads can
      // cascade through their phone captures safely.
      const phoneActions = database.prepare(`
        DELETE FROM campaign_phone_capture_actions
        WHERE phone_capture_id IN (
          SELECT capture.id
          FROM contact_phone_captures capture
          JOIN threads thread ON thread.id = capture.thread_id
          WHERE thread.account_id = ?
        )
      `).run(normalizedId).changes;

      // Campaign rows are historical snapshots and intentionally outlive a
      // removed account. Only prevent unsent recipients from being dispatched.
      const cancelledRecipients = database.prepare(`
        UPDATE campaign_recipients
        SET status = 'cancelled',
            last_error_code = 'ACCOUNT_REMOVED',
            last_error = 'Tài khoản Facebook đã bị xóa khỏi CRM',
            updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ? AND status IN ('pending', 'processing')
      `).run(normalizedId).changes;

      // Pages may still be useful through another owner. Detach them instead
      // of deleting them together with the personal Facebook account.
      const detachedPages = database.prepare(`
        UPDATE inbox_sources SET owner_account_id = NULL
        WHERE owner_account_id = ? AND source_type = 'page_messenger'
      `).run(normalizedId).changes;

      database.prepare(`
        DELETE FROM inbox_sources
        WHERE source_type = 'personal_messenger' AND external_id = ?
      `).run(normalizedId);

      const deleted = database.prepare('DELETE FROM accounts WHERE id = ?').run(normalizedId).changes;
      return { deleted, phoneActions, cancelledRecipients, detachedPages };
    });

    return { account, ...remove() };
  }
}

module.exports = AccountService;
