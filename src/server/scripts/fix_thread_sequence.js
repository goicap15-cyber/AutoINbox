// Script to recalibrate and normalize sequence_order for all threads in SQLite
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.resolve(__dirname, '../../../data/database.db');
const db = new Database(dbPath);

console.log('[FixSequence] Connecting to database:', dbPath);

const ConversationRepository = require('../repositories/ConversationRepository');

const threads = db.prepare('SELECT id, contact_name FROM threads').all();
console.log(`[FixSequence] Found ${threads.length} threads. Normalizing sequences...`);

let totalNormalized = 0;
for (const thread of threads) {
  const count = ConversationRepository.normalizeMessageSequence(thread.id, db);
  totalNormalized += count;
}

console.log(`[FixSequence] Completed normalization of ${totalNormalized} messages across ${threads.length} threads.`);

// Specifically inspect thread 100018089229407 to confirm
const sampleRows = db.prepare(`
  SELECT id, content, media_type, sequence_order, timestamp_ms, created_at
  FROM messages
  WHERE thread_id = '100018089229407'
  ORDER BY sequence_order ASC, id ASC
`).all();

console.log('[FixSequence] Thread 100018089229407 normalized messages:');
sampleRows.forEach(r => {
  console.log(`  [seq ${r.sequence_order}] id=${r.id} | ${r.media_type} | content="${r.content || ''}" | created_at=${r.created_at}`);
});
