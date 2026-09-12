const test = require('node:test');
const assert = require('node:assert/strict');
const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

test('T002: getTimestampRank đánh giá chuẩn xác thang điểm từ 1 đến 6', () => {
  // Rank 6 (Level 5)
  assert.equal(ConversationRepository.getTimestampRank('facebook_payload'), 6);
  assert.equal(ConversationRepository.getTimestampRank('facebook_timestamp'), 6);

  // Rank 5 (Level 4)
  assert.equal(ConversationRepository.getTimestampRank('facebook_label'), 5);
  assert.equal(ConversationRepository.getTimestampRank('facebook_dom'), 5);

  // Rank 4 (Level 3)
  assert.equal(ConversationRepository.getTimestampRank('separator_date_clock'), 4);
  assert.equal(ConversationRepository.getTimestampRank('dom_clock_order'), 4);

  // Rank 3 (Level 2)
  assert.equal(ConversationRepository.getTimestampRank('realtime_delta'), 3);
  assert.equal(ConversationRepository.getTimestampRank('client_submit'), 3);
  assert.equal(ConversationRepository.getTimestampRank('composer_confirmation'), 3);
  assert.equal(ConversationRepository.getTimestampRank('realtime_fallback'), 3);
  assert.equal(ConversationRepository.getTimestampRank('sync'), 3);

  // Rank 2 (Level 1)
  assert.equal(ConversationRepository.getTimestampRank('dom_order'), 2);

  // Rank 1 (Level 0)
  assert.equal(ConversationRepository.getTimestampRank('unknown'), 1);
  assert.equal(ConversationRepository.getTimestampRank('fallback'), 1);
  assert.equal(ConversationRepository.getTimestampRank(null), 1);
  assert.equal(ConversationRepository.getTimestampRank(''), 1);
});

test('T002: Nguồn cấp cao hơn nâng cấp nguồn cấp thấp hơn', () => {
  assert.ok(ConversationRepository.shouldUpgradeTimestamp('unknown', 'dom_order'));
  assert.ok(ConversationRepository.shouldUpgradeTimestamp('dom_order', 'separator_date_clock'));
  assert.ok(ConversationRepository.shouldUpgradeTimestamp('separator_date_clock', 'facebook_label'));
  assert.ok(ConversationRepository.shouldUpgradeTimestamp('facebook_label', 'facebook_timestamp'));
});

test('T002: Nguồn cùng cấp hoặc cấp thấp hơn không được phép ghi đè', () => {
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('facebook_timestamp', 'dom_order'), false);
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('facebook_label', 'dom_order'), false);
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('facebook_label', 'facebook_label'), false);
  assert.equal(ConversationRepository.shouldUpgradeTimestamp('dom_order', 'dom_order'), false);
});

test('T002: upgradeMessageTimestamp cập nhật timestamp trong CSDL khi source cao hơn', () => {
  const { getTestDatabase } = require('../helpers/testDatabase');
  const db = getTestDatabase(':memory:');

  // Tạo account, thread và message ban đầu với dom_order
  db.prepare('INSERT INTO accounts (id, name, profile_dir) VALUES (?, ?, ?)').run('acc-1', 'Test Account', '/tmp/acc-1');
  db.prepare(`INSERT INTO threads (id, account_id, contact_name) VALUES ('th-test', 'acc-1', 'Test Contact')`).run();
  db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, sender_id, content, timestamp_ms, timestamp_source, is_outgoing, sender_role, sequence_order)
    VALUES ('th-test', 'mid-101', 'acc-1', 'hello', 1000, 'dom_order', 0, 'customer', 1)
  `).run();

  // Nâng cấp lên separator_date_clock (rank 4 > rank 2) -> Thành công
  const res1 = ConversationRepository.upgradeMessageTimestamp('th-test', 'mid-101', 5000, 'separator_date_clock', db);
  assert.ok(res1);
  assert.equal(res1.timestamp_ms, 5000);
  assert.equal(res1.timestamp_source, 'separator_date_clock');

  // Cố hạ cấp xuống dom_order (rank 2 < rank 4) -> Thất bại (bị từ chối)
  const resReject = ConversationRepository.upgradeMessageTimestamp('th-test', 'mid-101', 2000, 'dom_order', db);
  assert.equal(resReject, null);

  // Nâng cấp lên facebook_label (rank 5 > rank 4) -> Thành công
  const res2 = ConversationRepository.upgradeMessageTimestamp('th-test', 'mid-101', 9999, 'facebook_label', db);
  assert.ok(res2);
  assert.equal(res2.timestamp_ms, 9999);
  assert.equal(res2.timestamp_source, 'facebook_label');

  db.close();
});
