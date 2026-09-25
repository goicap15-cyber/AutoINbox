const test = require('node:test');
const assert = require('node:assert/strict');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

test('T005: ghép batch lịch sử cũ có anchor tin nhắn trùng khớp', () => {
  const existingRows = [
    { fb_message_id: 'm2', content: 'Tin số 2', sequence_order: 1 },
    { fb_message_id: 'm3', content: 'Tin số 3', sequence_order: 2 }
  ];

  // Batch cuộn lên có m1 và m2 (m2 là anchor)
  const incomingBatch = [
    { fb_message_id: 'm1', content: 'Tin số 1 (cũ hơn)', dom_order: 0 },
    { fb_message_id: 'm2', content: 'Tin số 2', dom_order: 1 }
  ];

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_scroll_older'
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.mergedList.length, 3);
  assert.equal(result.mergedList[0].fb_message_id, 'm1');
  assert.equal(result.mergedList[1].fb_message_id, 'm2');
  assert.equal(result.mergedList[2].fb_message_id, 'm3');

  // Kiểm tra sequence_order đánh lại 1..N
  assert.equal(result.mergedList[0].sequence_order, 1);
  assert.equal(result.mergedList[1].sequence_order, 2);
  assert.equal(result.mergedList[2].sequence_order, 3);
});

test('T005: batch cuộn tin cũ mất anchor nhưng có boundary_evidence khớp DB', () => {
  const existingRows = [
    { fb_message_id: 'm2', content: 'Tin số 2', sequence_order: 1 },
    { fb_message_id: 'm3', content: 'Tin số 3', sequence_order: 2 }
  ];

  // Không có tin nào trùng, nhưng có previous_oldest_message_id là 'm2'
  const incomingBatch = [
    { fb_message_id: 'm0', content: 'Tin rất cũ', dom_order: 0 },
    { fb_message_id: 'm1', content: 'Tin cũ vừa', dom_order: 1 }
  ];

  const boundaryEvidence = {
    previous_oldest_message_id: 'm2',
    crawler_confirmed_scroll: true
  };

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_scroll_older',
    boundary_evidence: boundaryEvidence
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.mergedList.length, 4);
  assert.equal(result.mergedList[0].fb_message_id, 'm0');
  assert.equal(result.mergedList[1].fb_message_id, 'm1');
  assert.equal(result.mergedList[2].fb_message_id, 'm2');
  assert.equal(result.mergedList[3].fb_message_id, 'm3');
});

test('T005: batch cuộn tin cũ mất anchor VÀ thiếu boundary_evidence hợp lệ -> retry_required', () => {
  const existingRows = [
    { fb_message_id: 'm2', content: 'Tin số 2', sequence_order: 1 }
  ];

  const incomingBatch = [
    { fb_message_id: 'm0', content: 'Tin lạ', dom_order: 0 }
  ];

  // Boundary evidence sai (previous_oldest_message_id không tồn tại trong DB)
  const boundaryEvidence = {
    previous_oldest_message_id: 'non_existent_id',
    crawler_confirmed_scroll: true
  };

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_scroll_older',
    boundary_evidence: boundaryEvidence
  });

  assert.equal(result.status, 'retry_required');
  assert.equal(result.reason, 'missing_anchor_and_invalid_boundary');
});

test('T005: hai tin "alo" liên tiếp cùng nội dung không bị merge/gộp nhầm', () => {
  const existingRows = [
    { fb_message_id: 'msg_alo_1', content: 'alo', sequence_order: 1 }
  ];

  const incomingBatch = [
    { fb_message_id: 'msg_alo_1', content: 'alo', dom_order: 0 },
    { fb_message_id: 'msg_alo_2', content: 'alo', dom_order: 1 }
  ];

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_initial'
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.mergedList.length, 2);
  assert.equal(result.mergedList[0].content, 'alo');
  assert.equal(result.mergedList[1].content, 'alo');
  assert.equal(result.mergedList[0].sequence_order, 1);
  assert.equal(result.mergedList[1].sequence_order, 2);
});

test('reconcileBatchWithAnchors chèn tin cũ xuất hiện trước anchor vào đúng vị trí trước anchor trong page_initial', () => {
  const existingRows = [
    { fb_message_id: 'm_newer', content: 'Tin mới', sequence_order: 1 }
  ];

  // Batch có tin m_older và m_newer
  const incomingBatch = [
    { fb_message_id: 'm_older', content: 'Tin cũ', dom_order: 0 },
    { fb_message_id: 'm_newer', content: 'Tin mới', dom_order: 1 }
  ];

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_initial'
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.mergedList.length, 2);
  assert.equal(result.mergedList[0].fb_message_id, 'm_older');
  assert.equal(result.mergedList[1].fb_message_id, 'm_newer');
  assert.equal(result.mergedList[0].sequence_order, 1);
  assert.equal(result.mergedList[1].sequence_order, 2);
});

test('T008: page_scroll_older tra ve reached_top khi khong co tin cu nao moi (overlap)', () => {
  const existingRows = [
    { fb_message_id: 'm1', content: 'Tin 1', sequence_order: 1 },
    { fb_message_id: 'm2', content: 'Tin 2', sequence_order: 2 }
  ];

  // Batch cuon len chi chua m1 va m2 (khong co tin nao moi hon hoac cu hon)
  const incomingBatch = [
    { fb_message_id: 'm1', content: 'Tin 1', dom_order: 0 },
    { fb_message_id: 'm2', content: 'Tin 2', dom_order: 1 }
  ];

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_scroll_older'
  });

  assert.equal(result.status, 'reached_top');
  assert.equal(result.reached_top, true);
  assert.equal(result.mergedList.length, 2);
});

test('T008: page_scroll_older loc trung va tra ve reached_top khi incomingBatch deu da co trong DB', () => {
  const existingRows = [
    { fb_message_id: 'm1', content: 'Tin 1', sequence_order: 1 },
    { fb_message_id: 'm2', content: 'Tin 2', sequence_order: 2 }
  ];

  // Boundary evidence khop previous oldest nhung incoming toan tin da co
  const incomingBatch = [
    { fb_message_id: 'm1', content: 'Tin 1 lap lai', dom_order: 0 }
  ];

  const result = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, {
    mode: 'page_scroll_older',
    boundary_evidence: {
      previous_oldest_message_id: 'm1',
      crawler_confirmed_scroll: true
    }
  });

  assert.equal(result.status, 'reached_top');
  assert.equal(result.reached_top, true);
  assert.equal(result.mergedList.length, 2);
  assert.equal(result.mergedList[0].fb_message_id, 'm1');
  assert.equal(result.mergedList[1].fb_message_id, 'm2');
});

test('T009: normalizeMessageSequence sort on dinh theo phut va khong dung hash ngau nhien', () => {
  const { getTestDatabase } = require('../helpers/testDatabase');
  const db = getTestDatabase();
  try {
    db.prepare("INSERT INTO accounts (id, name, profile_dir) VALUES ('acc1', 'Acc 1', '/tmp')").run();
    db.prepare("INSERT INTO threads (id, account_id, contact_name) VALUES ('t1', 'acc1', 'Test')").run();

    // Tin 1: 08:00 (hom qua)
    db.prepare("INSERT INTO messages (thread_id, fb_message_id, sender_id, content, timestamp_ms, created_at, sequence_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('t1', 'mid.$zzz_larger_hex', 's1', 'Tin hom qua', 1700000000000, '2026-09-23 08:00:00', 1);

    // Tin 2: 10:00 (hom nay - nhung hex nho hon mid.$aaa)
    db.prepare("INSERT INTO messages (thread_id, fb_message_id, sender_id, content, timestamp_ms, created_at, sequence_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('t1', 'mid.$aaa_smaller_hex', 's1', 'Tin hom nay', 1700086400000, '2026-09-24 10:00:00', 2);

    ConversationRepository.normalizeMessageSequence('t1', db);

    const rows = db.prepare("SELECT fb_message_id, sequence_order FROM messages WHERE thread_id = 't1' ORDER BY sequence_order ASC").all();
    assert.equal(rows[0].fb_message_id, 'mid.$zzz_larger_hex');
    assert.equal(rows[1].fb_message_id, 'mid.$aaa_smaller_hex');
    assert.equal(rows[0].sequence_order, 1);
    assert.equal(rows[1].sequence_order, 2);
  } finally {
    db.close();
  }
});
