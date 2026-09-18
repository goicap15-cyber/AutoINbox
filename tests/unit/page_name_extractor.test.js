const test = require('node:test');
const assert = require('node:assert/strict');
const PageNameExtractor = require('../../src/extension/pageNameExtractor.js');

test('pageNameExtractor: cleanPageName loại bỏ rác, URL và giữ tên hợp lệ', () => {
  assert.equal(PageNameExtractor.cleanPageName('  Cà Phê Hà Nội - 299  '), 'Cà Phê Hà Nội - 299');
  assert.equal(PageNameExtractor.cleanPageName('(3) Cà Phê Hà Nội'), 'Cà Phê Hà Nội');
  assert.equal(PageNameExtractor.cleanPageName('• Tiệm Bánh Mì'), 'Tiệm Bánh Mì');
  assert.equal(PageNameExtractor.cleanPageName('"Shop Thời Trang"'), 'Shop Thời Trang');
  
  // Chặn tuyệt đối URL / Link
  assert.equal(PageNameExtractor.cleanPageName('business.facebook.com/latest/inbox/all/?asset_id=1209772058877160&mailbox_id=1209772058877160&select'), null);
  assert.equal(PageNameExtractor.cleanPageName('https://business.facebook.com/latest/inbox/all/?asset_id=1209772058877160'), null);
  assert.equal(PageNameExtractor.cleanPageName('https://www.facebook.com/messages/t/12345'), null);
  assert.equal(PageNameExtractor.cleanPageName('/latest/inbox/all/?asset_id=1209772058877160'), null);

  // Loại trừ tên hệ thống hoặc id thuần túy
  assert.equal(PageNameExtractor.cleanPageName('Meta Business Suite'), null);
  assert.equal(PageNameExtractor.cleanPageName('Business Suite'), null);
  assert.equal(PageNameExtractor.cleanPageName('Hộp thư'), null);
  assert.equal(PageNameExtractor.cleanPageName('Inbox'), null);
  assert.equal(PageNameExtractor.cleanPageName('Tất cả tin nhắn'), null);
  assert.equal(PageNameExtractor.cleanPageName('All messages'), null);
  assert.equal(PageNameExtractor.cleanPageName('Tin nhắn'), null);
  assert.equal(PageNameExtractor.cleanPageName('Messages'), null);
  assert.equal(PageNameExtractor.cleanPageName('Đang tải...'), null);
  assert.equal(PageNameExtractor.cleanPageName('Page 1209772058877160'), null);
  assert.equal(PageNameExtractor.cleanPageName('1209772058877160'), null);
  assert.equal(PageNameExtractor.cleanPageName(''), null);
  assert.equal(PageNameExtractor.cleanPageName(null), null);
});

test('pageNameExtractor: extractPageNameFromScripts bóc tách chính xác từ script JSON của Meta', () => {
  const mockDoc = {
    querySelectorAll: (tag) => {
      if (tag === 'script') {
        return [
          { textContent: 'window.__some_config = { version: "1.0" };' },
          { textContent: '{"require":[["ScheduledServerJS","handle",null,[{"asset_id":"1209772058877160","name":"Cà Phê Hà Nội - 299","category":"Coffee Shop"}]]]}' }
        ];
      }
      return [];
    }
  };

  const name = PageNameExtractor.extractPageNameFromScripts(mockDoc, '1209772058877160');
  assert.equal(name, 'Cà Phê Hà Nội - 299');
});

test('pageNameExtractor: extractPageNameFromTitle bóc tách chuẩn cấu trúc title của Meta Business Suite', () => {
  // Case 1: Tiếng Việt chuẩn
  const t1 = 'Hộp thư | Cà Phê Hà Nội - 299 | Meta Business Suite';
  assert.equal(PageNameExtractor.extractPageNameFromTitle(t1), 'Cà Phê Hà Nội - 299');

  // Case 2: Tiếng Anh chuẩn
  const t2 = 'Inbox | Cà Phê Hà Nội - 299 | Meta Business Suite';
  assert.equal(PageNameExtractor.extractPageNameFromTitle(t2), 'Cà Phê Hà Nội - 299');

  // Case 3: Có số tin chưa đọc ở đầu
  const t3 = '(5) Hộp thư | Nha Khoa Thẩm Mỹ Quốc Tế | Meta Business Suite';
  assert.equal(PageNameExtractor.extractPageNameFromTitle(t3), 'Nha Khoa Thẩm Mỹ Quốc Tế');

  // Case 4: Chỉ có Hộp thư | Meta Business Suite (Không có tên page) -> Trả về null
  const t4 = 'Hộp thư | Meta Business Suite';
  assert.equal(PageNameExtractor.extractPageNameFromTitle(t4), null);

  // Case 5: URL làm title -> Trả về null
  const t5 = 'business.facebook.com/latest/inbox/all/?asset_id=1209772058877160';
  assert.equal(PageNameExtractor.extractPageNameFromTitle(t5), null);
});

test('pageNameExtractor: extractPageNameFromDom bóc tách từ switcher DOM', () => {
  const mockDoc = {
    querySelector: (selector) => {
      if (selector.includes('business_switcher')) {
        return {
          getAttribute: () => null,
          innerText: '  Cà Phê Hà Nội - 299  '
        };
      }
      return null;
    },
    querySelectorAll: () => []
  };

  assert.equal(PageNameExtractor.extractPageNameFromDom(mockDoc), 'Cà Phê Hà Nội - 299');
});

test('pageNameExtractor: detectPageName ưu tiên Scripts -> DOM -> Title', () => {
  // Ưu tiên 1: Scripts
  const mockDocWithAll = {
    querySelectorAll: (tag) => {
      if (tag === 'script') {
        return [{ textContent: '{"asset_id":"1209772058877160","name":"Tên Từ Script"}' }];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel.includes('business_switcher')) return { innerText: 'Tên Từ DOM' };
      return null;
    },
    title: 'Hộp thư | Tên Từ Title | Meta Business Suite'
  };

  assert.equal(
    PageNameExtractor.detectPageName({ document: mockDocWithAll, pageId: '1209772058877160' }),
    'Tên Từ Script'
  );

  // Ưu tiên 2: DOM khi script không có
  const mockDocNoScript = {
    querySelectorAll: () => [],
    querySelector: (sel) => {
      if (sel.includes('business_switcher')) return { innerText: 'Tên Từ DOM' };
      return null;
    },
    title: 'Hộp thư | Tên Từ Title | Meta Business Suite'
  };

  assert.equal(
    PageNameExtractor.detectPageName({ document: mockDocNoScript, pageId: '1209772058877160' }),
    'Tên Từ DOM'
  );
});
