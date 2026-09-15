const test = require('node:test');
const assert = require('node:assert/strict');
const FbPageVideoDetector = require('../../src/extension/pageVideoDetector');
const FbPageVideoUploader = require('../../src/extension/pageVideoUploader');

// Minimal mock DOM node builder for headless Node environment
function createMockElement(tagName, attrs = {}, children = [], text = '') {
  const childrenList = [...children];
  const attributes = { ...attrs };

  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    hasAttribute: (name) => name in attributes,
    setAttribute: (name, val) => { attributes[name] = String(val); },
    innerText: text,
    textContent: text,
    children: childrenList,
    parentElement: null,
    closest: (selector) => {
      let cur = el;
      while (cur) {
        if (selector.includes('composer') && cur.getAttribute('data-surface')?.includes('composer')) return cur;
        if (selector.includes('form') && cur.tagName === 'FORM') return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const results = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (selector === 'video' && child.tagName === 'VIDEO') results.push(child);
          else if (selector.includes('a[href]') && child.tagName === 'A' && child.getAttribute('href')) results.push(child);
          else if (selector.includes('[role="img"]') && child.getAttribute('role') === 'img') results.push(child);
          else if (selector.includes('source[src]') && child.tagName === 'SOURCE' && child.getAttribute('src')) results.push(child);
          else if (selector.includes('img') && child.tagName === 'IMG') results.push(child);
          else if (selector.includes('background-image') && child.getAttribute('style')?.includes('background-image')) results.push(child);
          walk(child);
        }
      };
      walk(el);
      return results;
    },
    querySelector: (selector) => el.querySelectorAll(selector)[0] || null
  };

  for (const child of childrenList) {
    child.parentElement = el;
  }
  return el;
}

test('pageVideoDetector - phát hiện thẻ <video> có direct src', () => {
  const video = createMockElement('video', {
    src: 'https://video.xx.fbcdn.net/v/t42.1790-2/test.mp4',
    poster: 'https://scontent.xx.fbcdn.net/v/poster.jpg'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.123' }, [video], 'Video sản phẩm mẫu');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, 'Video sản phẩm mẫu');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://video.xx.fbcdn.net/v/t42.1790-2/test.mp4');
  assert.equal(result.caption, 'Video sản phẩm mẫu');
});

test('pageVideoDetector - phát hiện thẻ <video> có <source src> và poster', () => {
  const source = createMockElement('source', { src: 'https://video.xx.fbcdn.net/v/stream.mp4' });
  const video = createMockElement('video', { poster: 'https://scontent.xx.fbcdn.net/v/thumb.jpg' }, [source]);
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.456' }, [video]);

  const result = FbPageVideoDetector.detectPageVideo(wrapper);
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://video.xx.fbcdn.net/v/stream.mp4');
  assert.equal(result.posterUrl, 'https://scontent.xx.fbcdn.net/v/thumb.jpg');
});

test('pageVideoDetector - phát hiện thẻ link video /reel/ kèm label xem video', () => {
  const link = createMockElement('a', {
    href: 'https://www.facebook.com/reel/9988776655',
    'aria-label': 'Xem video này trên Facebook'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.789' }, [link], 'Gửi bạn xem clip');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, 'Gửi bạn xem clip');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://www.facebook.com/reel/9988776655');
  assert.equal(result.caption, 'Gửi bạn xem clip');
});

test('pageVideoDetector - bỏ qua cuộc gọi video (call log guard)', () => {
  const callNode = createMockElement('div', { 'data-message-id': 'mid.call1' }, [], 'Cuộc gọi video đã nhỡ');
  const result = FbPageVideoDetector.detectPageVideo(callNode, 'Cuộc gọi video đã nhỡ');
  assert.equal(result.isVideo, false);
});

test('pageVideoDetector - trả về isVideo: false cho ảnh thông thường', () => {
  const img = createMockElement('img', { src: 'https://scontent.xx.fbcdn.net/photo.jpg', alt: 'Hình ảnh' });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.img1' }, [img], 'Ảnh chụp màn hình');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, 'Ảnh chụp màn hình');
  assert.equal(result.isVideo, false);
});

test('pageVideoDetector - trả về isVideo: false cho tin nhắn văn bản thông thường', () => {
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.text1' }, [], 'Dạ shop còn màu xanh không ạ?');
  const result = FbPageVideoDetector.detectPageVideo(wrapper, 'Dạ shop còn màu xanh không ạ?');
  assert.equal(result.isVideo, false);
});

test('pageVideoUploader - resolvePreferredKind chuẩn xác cho các loại attachment', () => {
  assert.equal(FbPageVideoUploader.resolvePreferredKind({ media_type: 'video', mime_type: 'video/mp4' }), 'video');
  assert.equal(FbPageVideoUploader.resolvePreferredKind([{ media_type: 'file', mime_type: 'video/mp4' }]), 'video');
  assert.equal(FbPageVideoUploader.resolvePreferredKind({ media_type: 'image', mime_type: 'image/jpeg' }), 'image');
  assert.equal(FbPageVideoUploader.resolvePreferredKind({ media_type: 'file', mime_type: 'application/pdf' }), 'file');
  assert.equal(FbPageVideoUploader.hasVideoAttachment({ media_type: 'video' }), true);
  assert.equal(FbPageVideoUploader.hasVideoAttachment({ media_type: 'image' }), false);
});

test('pageVideoDetector - phát hiện thẻ <video> có src dạng blob: trong Business Suite và lọc sạch thời lượng 0:00 / 0:19', () => {
  const video = createMockElement('video', {
    src: 'blob:https://business.facebook.com/d94f31c2-3e21-4d33-91cb-700f77977469'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.blob1' }, [video], '0:00 / 0:19');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:19');
  assert.equal(result.isVideo, true);
  // Caption được lọc sạch, không còn chứa chuỗi 0:00 / 0:19
  assert.equal(result.caption, null);
});

test('pageVideoDetector - phát hiện video dạng blob: có caption kèm theo thời lượng', () => {
  const video = createMockElement('video', {
    src: 'blob:https://business.facebook.com/12345678'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.blob2' }, [video], '0:00 / 0:19 212');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:19 212');
  assert.equal(result.isVideo, true);
  // Caption chỉ giữ lại phần nội dung thực "212", bỏ phần thời lượng video
  assert.equal(result.caption, '212');
});

test('pageVideoDetector - phát hiện video khách gửi có thời lượng 0:00 / 0:03 và bóc tách thumbnail img', () => {
  const thumb = createMockElement('img', {
    src: 'https://scontent.xx.fbcdn.net/v/poster_customer.jpg'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.cust1' }, [thumb], '0:00 / 0:03');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:03');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://scontent.xx.fbcdn.net/v/poster_customer.jpg');
  assert.equal(result.caption, null);
});

test('pageVideoDetector - phát hiện video khách gửi có style background-image làm poster', () => {
  const bgThumb = createMockElement('div', {
    style: 'background-image: url("https://scontent.xx.fbcdn.net/v/bg_poster.jpg")'
  });
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.cust2' }, [bgThumb], '0:00 / 0:03');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:03');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://scontent.xx.fbcdn.net/v/bg_poster.jpg');
  assert.equal(result.caption, null);
});

test('pageVideoDetector - extractVideoCdnFromReact trích xuất playable_url từ React Fiber', () => {
  const node = {
    __reactFiber$test123: {
      memoizedProps: {
        playable_url: 'https://video.fhan17-1.fna.fbcdn.net/v/t39.1234-2/video_playable.mp4?test=1',
        preview_url: 'https://scontent.xx.fbcdn.net/v/t1.15752-9/preview.jpg'
      }
    }
  };

  const result = FbPageVideoDetector.extractVideoCdnFromReact(node);
  assert.equal(result.videoUrl, 'https://video.fhan17-1.fna.fbcdn.net/v/t39.1234-2/video_playable.mp4?test=1');
  assert.equal(result.posterUrl, 'https://scontent.xx.fbcdn.net/v/t1.15752-9/preview.jpg');
});

test('pageVideoDetector - bóc tách playable_url từ React Fiber khi thẻ <video> chỉ có src dạng blob:', () => {
  const video = createMockElement('video', {
    src: 'blob:https://business.facebook.com/d94f31c2-3e21-4d33-91cb-700f77977469'
  });
  video.__reactFiber$fiber1 = {
    memoizedProps: {
      attachment: {
        playable_url: 'https://video.fna.fbcdn.net/v/t39.254/office_chair_stream.mp4'
      }
    }
  };
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.cust_blob_fiber' }, [video], '0:00 / 0:03');

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:03');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://video.fna.fbcdn.net/v/t39.254/office_chair_stream.mp4');
  assert.equal(result.caption, null);
});

test('pageVideoDetector - bóc tách preview_url từ React Fiber khi video chỉ có thời lượng 0:00 / 0:03', () => {
  const wrapper = createMockElement('div', { 'data-message-id': 'mid.cust_fiber_preview' }, [], '0:00 / 0:03');
  wrapper.__reactProps$props1 = {
    blob_attachments: [
      {
        large_preview: {
          uri: 'https://scontent.xx.fbcdn.net/v/office_chair_poster.jpg'
        }
      }
    ]
  };

  const result = FbPageVideoDetector.detectPageVideo(wrapper, '0:00 / 0:03');
  assert.equal(result.isVideo, true);
  assert.equal(result.mediaUrl, 'https://scontent.xx.fbcdn.net/v/office_chair_poster.jpg');
  assert.equal(result.posterUrl, 'https://scontent.xx.fbcdn.net/v/office_chair_poster.jpg');
  assert.equal(result.caption, null);
});

