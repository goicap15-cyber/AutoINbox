const test = require('node:test');
const assert = require('node:assert/strict');
const { directionFromAccessibilityLabel } = require('../../src/extension/callDirection');

test('call owned by the logged-in account is outgoing', () => {
  assert.equal(directionFromAccessibilityLabel('Nhấp, Tin nhắn do Bạn gửi lúc 15:14'), true);
  assert.equal(directionFromAccessibilityLabel('Message sent by you at 15:14'), true);
});

test('call owned by the other participant is incoming', () => {
  assert.equal(directionFromAccessibilityLabel('Nhấp, Tin nhắn do Lê Văn Khang gửi lúc 15:14'), false);
  assert.equal(directionFromAccessibilityLabel('Message sent by Alex at 15:14'), false);
});

test('new Messenger timed accessibility format identifies both sides', () => {
  assert.equal(directionFromAccessibilityLabel('Lúc 15:14, Bạn: Cuộc gọi thoại'), true);
  assert.equal(directionFromAccessibilityLabel('Lúc 15:14, Lê Văn Khang: Cuộc gọi thoại'), false);
});

test('unrelated labels do not override avatar or geometry fallback', () => {
  assert.equal(directionFromAccessibilityLabel('Cuộc gọi thoại'), null);
  assert.equal(directionFromAccessibilityLabel('Nhấn để gọi lại'), null);
});
