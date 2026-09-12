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
