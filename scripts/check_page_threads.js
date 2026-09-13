const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../data/database.db'));
const pageThreads = db.prepare('SELECT id, contact_name, last_message, source_id, thread_url FROM threads WHERE source_id LIKE ?').all('%page%');
console.log('Page threads count:', pageThreads.length);
console.log(JSON.stringify(pageThreads, null, 2));
db.close();
