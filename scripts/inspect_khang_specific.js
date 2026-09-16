const db = require('../src/server/database/db');
const tid = '100004449999465';
const msgs = db.prepare('SELECT id, sequence_order, fb_message_id, is_outgoing, sender_role, content, media_type, media_url, local_media_path, timestamp_ms, created_at FROM messages WHERE thread_id = ? ORDER BY COALESCE(sequence_order, id) ASC, id ASC').all(tid);
console.log('Total msgs:', msgs.length);
// Find msgs where content contains alooo or 20ch or szdx
msgs.forEach((m, idx) => {
  if (/alooo|20ch|szdx|ảo|1123344|tại sao/i.test(m.content || '')) {
    console.log(`[${idx}] id=${m.id}, seq=${m.sequence_order}, out=${m.is_outgoing}, content="${m.content}", media=${m.media_type}, path=${m.local_media_path}, url=${m.media_url ? m.media_url.substring(0, 60) : null}`);
  }
});
