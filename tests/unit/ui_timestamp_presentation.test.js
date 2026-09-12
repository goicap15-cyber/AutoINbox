const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getMessageDisplayTime,
  getMessageDateKey,
  formatDateSeparatorLabel,
  isConfirmedOutgoing
} = require('../../src/client/utils/messageTimestampPresentation');

test('T007: getMessageDisplayTime không fallback sang created_at khi timestamp_ms <= 0', () => {
  const msgWithCreatedAtOnly = {
    content: 'Tin nhắn cũ chưa rõ giờ',
    timestamp_ms: 0,
    timestamp_source: 'unknown',
    created_at: '2026-09-10T08:30:00.000Z'
  };

  const displayTime = getMessageDisplayTime(msgWithCreatedAtOnly);
  assert.equal(displayTime, ''); // Ẩn giờ hiển thị thay vì lấy 08:30 từ created_at

  const msgWithRealTs = {
    content: 'Tin nhắn có giờ thật',
    timestamp_ms: new Date('2026-09-10T14:45:00.000Z').getTime(),
    timestamp_source: 'facebook_label',
    created_at: '2026-09-10T15:00:00.000Z'
  };

  const displayTimeReal = getMessageDisplayTime(msgWithRealTs);
  assert.ok(displayTimeReal.length > 0);
  assert.notEqual(displayTimeReal, '');
});

test('T007: getMessageDateKey và formatDateSeparatorLabel không nhóm ngày dựa trên created_at', () => {
  const msgWithoutTs = {
    timestamp_ms: 0,
    timestamp_source: 'unknown',
    created_at: '2026-09-10T08:30:00.000Z'
  };

  assert.equal(getMessageDateKey(msgWithoutTs), null);
  assert.equal(formatDateSeparatorLabel(msgWithoutTs), '');

  const msgWithTs = {
    timestamp_ms: new Date('2026-09-10T14:45:00.000Z').getTime(),
    timestamp_source: 'facebook_label'
  };
  assert.ok(getMessageDateKey(msgWithTs) !== null);
});

test('T007: isConfirmedOutgoing chỉ coi là tin gửi đi khi direction_status là confirmed', () => {
  const pendingMsg = {
    is_outgoing: 0, // SQLite storage placeholder
    direction_status: 'pending'
  };
  assert.equal(isConfirmedOutgoing(pendingMsg), false);

  const confirmedOut = {
    is_outgoing: 1,
    direction_status: 'confirmed'
  };
  assert.equal(isConfirmedOutgoing(confirmedOut), true);

  const confirmedIn = {
    is_outgoing: 0,
    direction_status: 'confirmed'
  };
  assert.equal(isConfirmedOutgoing(confirmedIn), false);
});
