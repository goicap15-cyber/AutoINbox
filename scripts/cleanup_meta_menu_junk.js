const Database = require('better-sqlite3');
const path = require('path');
const { isSystemOrMetadataText } = require('../src/server/utils/textFilter');

const dbPath = path.join(__dirname, '../data/database.db');
const db = new Database(dbPath);

const junkIds = [16398, 16399, 16400, 16401, 16402, 16403, 16404, 16405, 16406, 16407];
const del = db.prepare(`DELETE FROM messages WHERE id IN (${junkIds.join(',')})`).run();
console.log('Deleted junk messages:', del.changes);

const lastMsg = db.prepare(`
  SELECT content FROM messages 
  WHERE thread_id = ? AND content IS NOT NULL AND trim(content) != '' 
  ORDER BY id DESC LIMIT 1
`).get('100092115712908');

if (lastMsg) {
  db.prepare('UPDATE threads SET last_message = ? WHERE id = ?').run(lastMsg.content, '100092115712908');
  console.log('Updated thread last_message to:', lastMsg.content);
}
db.close();
console.log('Cleanup completed successfully.');
