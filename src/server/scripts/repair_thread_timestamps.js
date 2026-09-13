const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../../data/database.db');
const db = new Database(dbPath);

console.log('=== INSPECTING AND REPAIRING CORRUPTED TIMESTAMPS ===');

// The messages corrupted today at 15:45:
// Their timestamp_ms was set to 17892027145xx (12/9/2026 15:45)
// Let's identify each corrupted message by its fb_message_id and cluster them to their real historical dates:

// Group 1: 17/8/2026 (mid starts with SmRB, SmRC, SmRD, SmRE, SmRF, SmRN)
// Similar to 1831-1834 which have 17/8/2026 17:34:00 (1787013240000)

// Group 2: 19/8/2026 (mid starts with SmSn, SmSo, SmSq, SmSw, SmWZ, SmZ9)
// Similar to 1702 which has 19/8/2026 15:43:00 (1787176980000)

// Group 3: 28/8/2026 (mid starts with SmeR)
// Similar to 864, 865 which have 28/8/2026 17:06:00 (1787911560000)
// Messages: "alooooo", "111111111", "test nha bạn"

// Group 4: 31/8/2026 (mid starts with Smh2)
// Message: "Vhj"

// Group 5: 10/9/2026 (mid starts with Smu2, Smu_, SmvG)
// Similar to 1020 which has 10/9/2026 16:42:00 (1789042920000)
// Messages: "aloo em ơi", "em có nghe thấy anh nói j ko", "alo xem nào", "tại sao lại ko nhờ", "ơ sao mất tin nhờ", "aloooo", "123344"

const corruptedRows = db.prepare(`
  SELECT id, content, fb_message_id, timestamp_ms, timestamp_source, sequence_order
  FROM messages
  WHERE thread_id = '100092115712908'
    AND timestamp_source = 'realtime_fallback'
    AND timestamp_ms >= 1789202700000 AND timestamp_ms <= 1789202800000
  ORDER BY id ASC
`).all();

console.log(`Found ${corruptedRows.length} corrupted messages.`);

let updateCount = 0;
const updateStmt = db.prepare(`
  UPDATE messages
  SET timestamp_ms = ?, timestamp_source = 'separator_date_clock', created_at = ?
  WHERE id = ?
`);

for (const row of corruptedRows) {
  const mid = String(row.fb_message_id || '');
  let targetTs = null;

  if (mid.includes('SmRB') || mid.includes('SmRC') || mid.includes('SmRD') || mid.includes('SmRE') || mid.includes('SmRF') || mid.includes('SmRN')) {
    // 17/8/2026 17:40:00 (after 1834 at 17:34)
    targetTs = new Date('2026-08-17T17:40:00.000+07:00').getTime() + (row.id % 60) * 1000;
  } else if (mid.includes('SmSn') || mid.includes('SmSo') || mid.includes('SmSq') || mid.includes('SmSw') || mid.includes('SmWZ') || mid.includes('SmZ9')) {
    // 19/8/2026 15:50:00
    targetTs = new Date('2026-08-19T15:50:00.000+07:00').getTime() + (row.id % 60) * 1000;
  } else if (mid.includes('SmeR')) {
    // 28/8/2026 17:06:00
    targetTs = new Date('2026-08-28T17:06:00.000+07:00').getTime() + (row.id % 60) * 1000;
  } else if (mid.includes('Smh2')) {
    // 31/8/2026 10:15:00
    targetTs = new Date('2026-08-31T10:15:00.000+07:00').getTime();
  } else if (mid.includes('Smu2') || mid.includes('Smu_') || mid.includes('SmvG')) {
    // 10/9/2026 16:45:00
    targetTs = new Date('2026-09-10T16:45:00.000+07:00').getTime() + (row.id % 60) * 1000;
  }

  if (targetTs) {
    const iso = new Date(targetTs).toISOString();
    updateStmt.run(targetTs, iso, row.id);
    console.log(`Repaired ID ${row.id} ("${(row.content || '').slice(0, 25)}") -> ${new Date(targetTs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
    updateCount++;
  }
}

console.log(`Successfully repaired ${updateCount} messages.`);

// Now let's recalculate sequence_order for thread 100092115712908 so it is strictly monotonic by timestamp_ms
const allThreadMessages = db.prepare(`
  SELECT id, timestamp_ms
  FROM messages
  WHERE thread_id = '100092115712908'
  ORDER BY timestamp_ms ASC, id ASC
`).all();

const updateSeqStmt = db.prepare(`UPDATE messages SET sequence_order = ? WHERE id = ?`);
allThreadMessages.forEach((msg, idx) => {
  updateSeqStmt.run(idx + 1, msg.id);
});

console.log(`Recalibrated sequence_order for ${allThreadMessages.length} messages in thread 100092115712908.`);
