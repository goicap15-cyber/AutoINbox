const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/extension/textFilter.js', 'utf8'), context);
const clean = context.FbCrmTextFilter.cleanMessageText;

test('strips Vietnamese accessibility label without losing message content', () => {
  assert.equal(clean('Tin nhắn do Bảo Khánh gửi lúc Thứ Sáu 10:09 sáng: 👍'), '👍');
});

test('strips English accessibility label without losing message content', () => {
  assert.equal(clean('Message sent by Alice at Friday 10:09: hello'), 'hello');
});

test('identifies and rejects system labels as contact names', () => {
  const isInvalid = context.FbCrmTextFilter.isInvalidContactName;
  const cleanContact = context.FbCrmTextFilter.cleanContactName;

  assert.equal(isInvalid('Tất cả tin nhắn'), true);
  assert.equal(isInvalid('Tất cả'), true);
  assert.equal(isInvalid('All messages'), true);
  assert.equal(isInvalid('Hộp thư đến'), true);
  assert.equal(isInvalid('Chưa đọc'), true);
  assert.equal(isInvalid('Đang hoạt động'), true);
  assert.equal(isInvalid('Hoạt động 5 phút trước'), true);
  assert.equal(isInvalid('Facebook'), true);
  assert.equal(isInvalid('Messenger'), true);
  assert.equal(isInvalid('Meta'), true);

  assert.equal(isInvalid('Thu Oanh Nguyen'), false);
  assert.equal(isInvalid('Nguyễn Trường'), false);
  assert.equal(isInvalid('John Doe'), false);

  assert.equal(cleanContact('Tất cả tin nhắn'), 'Khách hàng');
  assert.equal(cleanContact('Thu Oanh Nguyen'), 'Thu Oanh Nguyen');
});

test('rejects the E2EE "restore chat history" interstitial as message content, not just Vietnamese wording (2026-08-20 live capture)', () => {
  assert.equal(clean('Restore messages'), '');
  assert.equal(clean('Restore now'), '');
  assert.equal(clean('Personal chats are secured with end-to-end encryption, so you need to restore chat history when you switch devices.'), '');
  assert.equal(clean('Khôi phục tin nhắn'), '');
  assert.equal(clean('Thiếu tin nhắn.'), '');
  assert.equal(clean('Thiếu tin nhắn'), '');
  assert.equal(clean('Không khôi phục được tin nhắn.'), '');
  assert.equal(clean('Không khôi phục được tin nhắn'), '');
});

test('rejects short day-of-week/relative-day separators leaking in as fake messages (spec 047)', () => {
  assert.equal(clean('Thứ Ba'), '');
  assert.equal(clean('Thứ Hai'), '');
  assert.equal(clean('Chủ Nhật'), '');
  assert.equal(clean('Hôm nay'), '');
  assert.equal(clean('Hôm qua'), '');
});

test('rejects the Business Suite "add a personalized message" CTA leaking in as a fake Page message (2026-08-20 live report)', () => {
  assert.equal(clean('Thêm tin nhắn được cá nhân hóa.'), '');
  assert.equal(clean('Thêm tin nhắn được cá nhân hóa'), '');
  assert.equal(clean('Thêm tin nhắn được cá nhân hoá.'), '');
});

test('rejects the short date-only separator "20 Tháng 4" leaking in as a fake message (2026-08-20 live report)', () => {
  assert.equal(clean('20 Tháng 4'), '');
  assert.equal(clean('6 Tháng 8, 2026'), '');
  assert.equal(clean('13:52 6 Tháng 8, 2026'), '');
});

