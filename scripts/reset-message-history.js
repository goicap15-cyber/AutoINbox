const Database = require('better-sqlite3');
const path = require('path');

// Optional explicit DB path lets a packaged installation be reset without
// touching accounts, contacts or configuration. Existing dev behavior stays
// exactly the same when no argument is supplied.
const databasePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('data/database.db');
const database = new Database(databasePath);
const reset = database.transaction(() => {
  const before = database.prepare('SELECT COUNT(*) AS total FROM messages').get().total;
  database.prepare('DELETE FROM messages').run();
  database.prepare("UPDATE threads SET sync_status = 'LOCAL', sync_cursor = NULL, sync_error = NULL").run();
  const after = database.prepare('SELECT COUNT(*) AS total FROM messages').get().total;
  const threadsReset = database.prepare(
    "SELECT COUNT(*) AS total FROM threads WHERE sync_status = 'LOCAL' AND sync_cursor IS NULL AND sync_error IS NULL"
  ).get().total;
  return { before, after, threads_reset: threadsReset };
});

console.log(JSON.stringify({ database: databasePath, ...reset() }));
database.close();
