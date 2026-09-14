const Database = require('better-sqlite3');
const path = require('path');

// Optional explicit DB path lets a packaged installation be reset without
// touching accounts, contacts or configuration. Existing dev behavior stays
// exactly the same when no argument is supplied.
const databasePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('data/database.db');
const database = new Database(databasePath);
const reset = database.transaction(() => {
  const before = database.prepare('SELECT COUNT(*) AS total FROM messages').get().total;
  // Break the messages <-> outbound_attempts reference cycle first. The
  // attempt rows then cascade from messages without violating SQLite FKs.
  database.prepare('UPDATE messages SET latest_attempt_id = NULL WHERE latest_attempt_id IS NOT NULL').run();
  database.prepare('DELETE FROM messages').run();
  // A clean message test must not leave a stale sidebar preview/unread badge
  // that still looks like the deleted message. Keep contacts, accounts,
  // folders and campaign definitions unchanged.
  database.prepare(`
    UPDATE threads
    SET last_message = NULL,
        is_unread = 0,
        sync_status = 'LOCAL',
        sync_cursor = NULL,
        sync_error = NULL
  `).run();
  const after = database.prepare('SELECT COUNT(*) AS total FROM messages').get().total;
  const threadsReset = database.prepare(
    "SELECT COUNT(*) AS total FROM threads WHERE sync_status = 'LOCAL' AND sync_cursor IS NULL AND sync_error IS NULL"
  ).get().total;
  return { before, after, threads_reset: threadsReset };
});

console.log(JSON.stringify({ database: databasePath, ...reset() }));
database.close();
