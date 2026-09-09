// The DOM observer reports the bare Facebook id (e.g. a personal PSID from
// the /messages/t/<psid> URL), but rich-message rows store the CRM's own
// thread id, which for personal threads is the compound "<account_id>:<psid>"
// - the two never compare equal directly. Reuses the exact resolution
// ConversationRepository.upsertThread already relies on elsewhere, rather
// than inventing a new lookup.
function resolveInternalThreadId(database, accountId, rawThreadId) {
  if (!rawThreadId) return null;
  const rawStr = String(rawThreadId);
  let row;
  if (accountId) {
    row = database.prepare(
      'SELECT id FROM threads WHERE account_id = ? AND (id = ? OR COALESCE(external_thread_id, id) = ? OR id LIKE ?)'
    ).get(accountId, rawStr, rawStr, `%:${rawStr}`);
  }
  if (!row) {
    row = database.prepare(
      'SELECT id FROM threads WHERE id = ? OR COALESCE(external_thread_id, id) = ? OR id LIKE ?'
    ).get(rawStr, rawStr, `%:${rawStr}`);
  }
  return row ? row.id : rawStr;
}

module.exports = { resolveInternalThreadId };
