const db = require('../src/server/database/db');
const contact = db.prepare("SELECT * FROM contacts WHERE name LIKE '%Khang%' OR name LIKE '%Lê Văn%'").all();
console.log('Contacts:', contact);
if (contact.length > 0) {
  const tid = contact[0].thread_id;
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(tid);
  console.log('Thread:', thread);
  const msgs = db.prepare('SELECT id, sequence_order, thread_id, fb_message_id, is_outgoing, sender_role, content, media_type, media_url, local_media_path, timestamp_ms, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC').all(tid);
  console.log('Messages count:', msgs.length);
  console.log('All messages:', JSON.stringify(msgs, null, 2));
}
