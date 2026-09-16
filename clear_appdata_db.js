const Database = require('better-sqlite3');
const dbPath = process.env.APPDATA + '\\\\autochatbot-fb-crm\\\\data\\\\database.db';
console.log('DB path:', dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get();
console.log('Messages before:', msgCount.c);

// Backup implicit - just delete
db.prepare('DELETE FROM messages').run();
db.prepare("UPDATE threads SET last_message=NULL, sync_status='LOCAL', sync_cursor=NULL").run();

const after = db.prepare('SELECT COUNT(*) as c FROM messages').get();
console.log('Messages after:', after.c);
db.close();
console.log('DONE');
