const db = require('./src/server/database/db');
db.prepare('DELETE FROM messages').run();
db.prepare("UPDATE threads SET last_message=NULL, last_activity=NULL, sync_status='LOCAL', sync_cursor=NULL").run();
const r = db.prepare('SELECT COUNT(*) as c FROM messages').get();
console.log('Messages remaining:', r.c);
console.log('DONE');
