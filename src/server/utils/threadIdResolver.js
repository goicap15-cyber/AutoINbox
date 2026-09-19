// The DOM observer reports the bare Facebook id (e.g. a personal PSID from
// the /messages/t/<psid> URL or Business Suite selected_item_id), but
// rich-message rows store the CRM's own thread id.
//
// Canonical policy (2026-09-19): page threads keep the BARE id. The extension
// DOM, crawl mutex, URL navigation and avatars all speak bare ids, so
// namespacing every page thread created duplicate rows (bare + namespaced),
// UNIQUE violations on (source_id, external_thread_id) and identity checks
// that can never match. The namespaced form `page:<pageId>:<psid>` is minted
// ONLY for a real collision - the bare conversation is already owned by a
// DIFFERENT source (another page, or the personal inbox) within this account.
function resolveInternalThreadId(database, accountId, rawThreadId, pageId = null) {
  if (!rawThreadId) return null;
  const rawStr = String(rawThreadId);
  const bareStr = rawStr.includes(':') ? rawStr.split(':').pop() : rawStr;
  let row;

  if (accountId) {
    // Prefer the exact id, then the bare row, then external/legacy aliases.
    row = database.prepare(`
      SELECT id, source_id FROM threads
      WHERE account_id = ?
        AND (id = ? OR id = ? OR COALESCE(external_thread_id, id) = ? OR id LIKE ?)
      ORDER BY CASE
        WHEN id = ? THEN 0
        WHEN id = ? THEN 1
        ELSE 2 END
      LIMIT 1
    `).get(accountId, rawStr, bareStr, bareStr, `%:${bareStr}`, rawStr, bareStr);

    if (row) {
      const belongsToOtherOwner = row.source_id
        && String(row.source_id).startsWith('src_')
        && String(row.source_id) !== `src_page_${String(pageId)}`;
      if (pageId && belongsToOtherOwner) {
        // Real collision: this conversation (same bare id) is already owned by
        // another page or the personal inbox -> mint a namespaced id so the
        // incoming page's conversation stays distinct.
        return `page:${String(pageId)}:${bareStr}`;
      }
      return row.id;
    }

    // No row for this account yet -> bare id, unless the bare id is taken by
    // another account (legacy compound namespacing for personal threads).
    const crossAccountCollision = database.prepare(
      'SELECT id, account_id FROM threads WHERE id = ? OR COALESCE(external_thread_id, id) = ? OR id LIKE ? LIMIT 1'
    ).get(bareStr, bareStr, `%:${bareStr}`);
    if (crossAccountCollision && String(crossAccountCollision.account_id) !== String(accountId)) {
      if (pageId) return `page:${String(pageId)}:${bareStr}`;
      return rawStr.startsWith(`${accountId}:`) ? rawStr : `${accountId}:${rawStr}`;
    }
    return bareStr;
  }

  row = database.prepare(
    'SELECT id FROM threads WHERE id = ? OR COALESCE(external_thread_id, id) = ? OR id LIKE ?'
  ).get(rawStr, rawStr, `%:${rawStr}`);
  return row ? row.id : rawStr;
}

module.exports = { resolveInternalThreadId };
