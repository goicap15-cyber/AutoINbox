/**
 * scripts/repair-thread-sequence.js
 * 
 * Script một lần chuẩn hóa lại sequence_order cho toàn bộ tin nhắn trong DB
 * theo thuật toán mới (Minute-block + timestamp + ID/DOM order tie-break),
 * hoàn toàn loại bỏ việc xáo trộn do hash hex 'mid.$'.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'database.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ Không tìm thấy database tại', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const ConversationRepository = require('../src/server/repositories/ConversationRepository');

const args = process.argv.slice(2);
const threadIdOpt = args.find(a => a.startsWith('--thread='));
const targetThreadId = threadIdOpt ? threadIdOpt.split('=')[1] : null;

console.log('========================================================');
console.log('🔧 BẮT ĐẦU CHUẨN HÓA THỨ TỰ TIN NHẮN (REPAIR SEQUENCE) 🔧');
console.log('========================================================');

try {
  let threadRows = [];
  if (targetThreadId) {
    threadRows = [{ thread_id: targetThreadId }];
    console.log(`Chỉ định chuẩn hóa 1 thread: ${targetThreadId}`);
  } else {
    threadRows = db.prepare('SELECT DISTINCT thread_id FROM messages WHERE thread_id IS NOT NULL').all();
    console.log(`Tìm thấy ${threadRows.length} threads có tin nhắn cần chuẩn hóa.`);
  }

  let totalProcessed = 0;
  let totalMessages = 0;
  const startTime = Date.now();

  for (const { thread_id } of threadRows) {
    if (!thread_id) continue;
    try {
      const count = ConversationRepository.normalizeMessageSequence(thread_id, db);
      totalProcessed += 1;
      totalMessages += (Number(count) || 0);

      if (totalProcessed % 50 === 0 || totalProcessed === threadRows.length) {
        console.log(`[Tiến độ] Đã chuẩn hóa ${totalProcessed}/${threadRows.length} threads (${totalMessages} tin nhắn)...`);
      }
    } catch (err) {
      console.error(`⚠️ Lỗi khi chuẩn hóa thread ${thread_id}:`, err.message);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('========================================================');
  console.log(`✅ HOÀN THÀNH: Đã chuẩn hóa ${totalProcessed} threads với ${totalMessages} tin nhắn trong ${durationSec}s.`);
  console.log('========================================================');
} catch (error) {
  console.error('❌ Lỗi không mong muốn trong quá trình repair:', error);
  process.exit(1);
} finally {
  try { db.close(); } catch (_) {}
}
