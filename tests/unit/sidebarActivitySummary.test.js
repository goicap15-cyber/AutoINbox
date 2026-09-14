const test = require('node:test');
const assert = require('node:assert/strict');
const { isSidebarActivitySummary } = require('../../src/server/utils/textFilter');

test('attachment and missed-call sidebar summaries are signals, not chat bubbles', () => {
  assert.equal(isSidebarActivitySummary('Bạn đã gửi một ảnh.'), true);
  assert.equal(isSidebarActivitySummary('You sent a photo.'), true);
  assert.equal(isSidebarActivitySummary('Mai đã gửi 1 ảnh.'), true);
  assert.equal(isSidebarActivitySummary('Cuộc gọi nhỡ'), true);
  assert.equal(isSidebarActivitySummary('khách nhắn nội dung thật'), false);
});
