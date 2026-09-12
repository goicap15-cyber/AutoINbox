const Database = require('better-sqlite3');
const ConversationRepository = require('../src/server/repositories/ConversationRepository');

function runBenchmark() {
  console.log('[Benchmark] 🚀 Khởi tạo benchmark renumber sequence trên 10.000 records...');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      contact_name TEXT,
      sync_status TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      fb_message_id TEXT UNIQUE,
      client_message_id TEXT,
      sender_id TEXT NOT NULL,
      content TEXT,
      media_type TEXT DEFAULT 'text',
      media_url TEXT,
      is_outgoing BOOLEAN NOT NULL DEFAULT 0,
      sender_role TEXT DEFAULT 'customer',
      sequence_order INTEGER,
      direction_status TEXT DEFAULT 'confirmed',
      is_unsent BOOLEAN DEFAULT 0,
      timestamp_ms INTEGER,
      timestamp_source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_messages_thread_seq ON messages(thread_id, sequence_order);
  `);

  db.prepare("INSERT INTO threads (id, account_id, contact_name, sync_status) VALUES ('bench_thread', 'acc_1', 'Khách Benchmark', 'SYNCED')").run();

  // Populate 10,000 messages
  console.log('[Benchmark] ⏳ Đang chèn 10.000 messages ban đầu...');
  const insertStmt = db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, sender_id, content, sequence_order, timestamp_ms, timestamp_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const populateTx = db.transaction(() => {
    for (let i = 1; i <= 10000; i++) {
      insertStmt.run(
        'bench_thread',
        `msg_${i}`,
        'CONTACT',
        `Nội dung tin nhắn số ${i}`,
        i,
        1787114000000 + i * 1000,
        'facebook_timestamp'
      );
    }
  });
  populateTx();
  console.log('[Benchmark] ✅ Đã nạp xong 10.000 messages.');

  const times = [];
  const iterations = 5;

  // Warmup run
  console.log('[Benchmark] 🔄 Chạy warm-up...');
  const warmupBatch = [];
  for (let j = 1; j <= 50; j++) {
    warmupBatch.push({
      fb_message_id: `warmup_${j}`,
      content: `Warmup message ${j}`,
      media_type: 'text',
      is_outgoing: false,
      sender_id: 'CONTACT',
      sender_role: 'customer',
      direction_status: 'confirmed',
      direction_confidence: 'high',
      dom_order: j - 1,
      timestamp_ms: 1787114000000 + j * 500,
      timestamp_source: 'facebook_label'
    });
  }
  ConversationRepository.processPageBatchEnvelope({
    thread_id: 'bench_thread',
    account_id: 'acc_1',
    session_epoch: 'bench_epoch',
    generation: 1,
    scan_id: 'warmup_scan',
    batch_sequence: 1,
    mode: 'page_initial',
    messages: warmupBatch
  }, db);

  // 5 formal iterations
  console.log(`[Benchmark] ⏱️ Bắt đầu ${iterations} vòng đo...`);
  for (let iter = 1; iter <= iterations; iter++) {
    const batch = [];
    for (let j = 1; j <= 50; j++) {
      batch.push({
        fb_message_id: `bench_iter_${iter}_msg_${j}`,
        content: `Batch message ${j} vòng ${iter}`,
        media_type: 'text',
        is_outgoing: false,
        sender_id: 'CONTACT',
        sender_role: 'customer',
        direction_status: 'confirmed',
        direction_confidence: 'high',
        dom_order: j - 1,
        timestamp_ms: 1787114000000 + j * 500,
        timestamp_source: 'facebook_label'
      });
    }

    const t0 = performance.now();
    const ack = ConversationRepository.processPageBatchEnvelope({
      thread_id: 'bench_thread',
      account_id: 'acc_1',
      session_epoch: 'bench_epoch',
      generation: iter + 1,
      scan_id: `scan_iter_${iter}`,
      batch_sequence: iter,
      mode: 'page_scroll_older',
      boundary_evidence: {
        previous_oldest_message_id: 'msg_1',
        crawler_confirmed_scroll: true
      },
      messages: batch
    }, db);

    // Simulate socket broadcast payload serialization
    const rows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_order ASC LIMIT 100').all('bench_thread');
    JSON.stringify(rows);

    const elapsed = performance.now() - t0;
    times.push(elapsed);
    console.log(`[Benchmark] Vòng ${iter}: ${elapsed.toFixed(2)}ms (ACK: ${ack.status})`);
  }

  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`[Benchmark] 📊 Kết quả: min=${times[0].toFixed(2)}ms, max=${times[times.length - 1].toFixed(2)}ms, p95=${p95.toFixed(2)}ms`);

  db.close();
  if (p95 < 300) {
    console.log(`[Benchmark] ✅ PASS: p95 (${p95.toFixed(2)}ms) < 300ms yêu cầu.`);
    return true;
  } else {
    console.error(`[Benchmark] ❌ FAIL: p95 (${p95.toFixed(2)}ms) vượt ngưỡng 300ms.`);
    return false;
  }
}

if (require.main === module) {
  const ok = runBenchmark();
  process.exit(ok ? 0 : 1);
}

module.exports = { runBenchmark };
