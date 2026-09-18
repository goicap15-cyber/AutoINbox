const test = require('node:test');
const assert = require('node:assert/strict');

// Import helper module (sẽ được implement ở T002)
let PageActiveScroller;
try {
  PageActiveScroller = require('../../src/extension/pageActiveScroller.js');
} catch (err) {
  // Sẽ pass sau khi T002 hoàn thành
}

test('T001: 1. Accumulator gom trọn vẹn snapshot qua các vòng unmount và dedupe chuẩn', () => {
  const { createMessageAccumulator } = PageActiveScroller;
  assert.equal(typeof createMessageAccumulator, 'function');

  const acc = createMessageAccumulator();

  // Vòng 1: DOM đang mount tin 10, 11, 12
  acc.accumulate([
    { fb_message_id: 'mid_10', content: 'Tin 10', dom_order: 0 },
    { fb_message_id: 'mid_11', content: 'Tin 11', dom_order: 1 },
    { fb_message_id: 'mid_12', content: 'Tin 12', dom_order: 2 }
  ]);

  // Vòng 2: Facebook cuộn lên, tin 12 bị unmount khỏi DOM, mount thêm tin 8, 9, overlap tin 10, 11
  acc.accumulate([
    { fb_message_id: 'mid_8', content: 'Tin 8', dom_order: 0 },
    { fb_message_id: 'mid_9', content: 'Tin 9', dom_order: 1 },
    { fb_message_id: 'mid_10', content: 'Tin 10', dom_order: 2 },
    { fb_message_id: 'mid_11', content: 'Tin 11', dom_order: 3 }
  ]);

  // Vòng 3: Facebook cuộn lên tiếp, tin 10, 11 bị unmount, mount thêm tin 6, 7, overlap tin 8, 9
  acc.accumulate([
    { fb_message_id: 'mid_6', content: 'Tin 6', dom_order: 0 },
    { fb_message_id: 'mid_7', content: 'Tin 7', dom_order: 1 },
    { fb_message_id: 'mid_8', content: 'Tin 8', dom_order: 2 },
    { fb_message_id: 'mid_9', content: 'Tin 9', dom_order: 3 }
  ]);

  const allMessages = acc.getAll();
  // Tổng cộng phải có đủ 7 tin từ mid_6 đến mid_12 mà không bị mất tin nào dù DOM đã unmount!
  assert.equal(allMessages.length, 7);
  const ids = allMessages.map(m => m.fb_message_id);
  assert.deepEqual(ids, ['mid_6', 'mid_7', 'mid_8', 'mid_9', 'mid_10', 'mid_11', 'mid_12']);
});

test('T001: 2. calculateStepDistance tính bước cuộn 70-85% viewport, có min/max an toàn', () => {
  const { calculateStepDistance } = PageActiveScroller;
  assert.equal(typeof calculateStepDistance, 'function');

  // Viewport chuẩn 800px -> 75% = 600px
  const step1 = calculateStepDistance(800);
  assert.ok(step1 >= 800 * 0.7 && step1 <= 800 * 0.85);

  // Viewport cực nhỏ 200px -> min clamp
  const step2 = calculateStepDistance(200);
  assert.ok(step2 >= 150);

  // Viewport cực lớn 3000px -> max clamp an toàn
  const step3 = calculateStepDistance(3000);
  assert.ok(step3 <= 1500);
});

test('T001: 3. isMessageLogContainer nhận diện đúng vùng chat chính, loại trừ sidebar/nav', () => {
  const { isMessageLogContainer } = PageActiveScroller;
  assert.equal(typeof isMessageLogContainer, 'function');

  // Node nằm trong navigation -> false
  const navNode = {
    closest: (selector) => (selector.includes('navigation') ? {} : null),
    clientHeight: 600,
    scrollHeight: 1200
  };
  assert.equal(isMessageLogContainer(navNode), false);

  // Node nằm trong sidebar -> false
  const sidebarNode = {
    closest: (selector) => (selector.includes('sidebar') ? {} : null),
    clientHeight: 600,
    scrollHeight: 1200
  };
  assert.equal(isMessageLogContainer(sidebarNode), false);

  // Node nằm trong role="main" có chiều cao cuộn hợp lệ -> true
  const validNode = {
    closest: (selector) => {
      if (selector.includes('navigation') || selector.includes('sidebar')) return null;
      if (selector.includes('main')) return {};
      return null;
    },
    clientHeight: 600,
    scrollHeight: 1200,
    querySelector: (sel) => (sel.includes('data-message-id') ? {} : null)
  };
  assert.equal(isMessageLogContainer(validNode), true);
});

test('T001: 4. dispatchScrollGestures thực hiện chuỗi fallback cuộn', () => {
  const { dispatchScrollGestures } = PageActiveScroller;
  assert.equal(typeof dispatchScrollGestures, 'function');

  const eventsDispatched = [];
  let scrollByCalledWith = null;

  const mockScroller = {
    scrollBy: (opts) => { scrollByCalledWith = opts; },
    dispatchEvent: (evt) => { eventsDispatched.push(evt.type); }
  };

  dispatchScrollGestures(mockScroller, 450);

  assert.deepEqual(scrollByCalledWith, { top: -450, behavior: 'auto' });
  assert.ok(eventsDispatched.includes('scroll'), 'Phải phát event scroll');
  assert.ok(eventsDispatched.includes('wheel'), 'Phải phát event wheel bổ trợ');
});

test('T001: 5. waitForDomSettle thoát an toàn khi spinner treo và phát hiện growth qua ID', async () => {
  const { waitForDomSettle } = PageActiveScroller;
  assert.equal(typeof waitForDomSettle, 'function');

  // Case A: Spinner kẹt -> timeout an toàn sau maxWaitMs
  const stuckScroller = {
    querySelector: (sel) => (sel.includes('Loading') ? {} : null),
    scrollHeight: 1000
  };
  const startA = Date.now();
  const resA = await waitForDomSettle(stuckScroller, {
    maxWaitMs: 150,
    pollIntervalMs: 20,
    getFirstMessageId: () => 'mid_1'
  });
  const elapsedA = Date.now() - startA;
  assert.equal(resA.timedOut, true);
  assert.ok(elapsedA >= 100);

  // Case B: scrollHeight giữ nguyên nhưng firstMessageId đổi -> hasGrowth = true
  let probeCount = 0;
  const growthScroller = {
    querySelector: () => null, // không có spinner
    scrollHeight: 1000
  };
  const resB = await waitForDomSettle(growthScroller, {
    maxWaitMs: 300,
    pollIntervalMs: 20,
    getFirstMessageId: () => {
      probeCount++;
      return probeCount > 2 ? 'mid_older_999' : 'mid_initial_100';
    }
  });
  assert.equal(resB.hasGrowth, true);
  assert.equal(resB.timedOut, false);
});

test('T001: 6. Mutex Manager ngăn 2 crawler chạy song song và hủy khi đổi thread', () => {
  const { createCrawlMutex } = PageActiveScroller;
  assert.equal(typeof createCrawlMutex, 'function');

  const mutex = createCrawlMutex();

  // Bắt đầu crawl thread A
  const tokenA = mutex.acquire('thread_A');
  assert.ok(tokenA !== null, 'Phải cấp token cho thread A');

  // Request tiếp theo cho thread A trong khi đang chạy -> bị từ chối/coalesced
  const tokenA2 = mutex.acquire('thread_A');
  assert.equal(tokenA2, null, 'Không được cấp token song song cho cùng 1 thread');

  // Đổi sang thread B -> token A lập tức bị coi là cancelled
  const tokenB = mutex.acquire('thread_B');
  assert.ok(tokenB !== null);
  assert.equal(mutex.isTokenValid(tokenA, 'thread_B'), false, 'Token A phải bị vô hiệu khi thread hiện tại là B');
  assert.equal(mutex.isTokenValid(tokenB, 'thread_B'), true);

  mutex.release(tokenB);
  assert.equal(mutex.isBusy(), false);
});

test('T001: 7. Realtime Leak Guard khóa luồng NEW_PAGE_MESSAGE_FROM_DOM trong lúc crawl', () => {
  const { shouldSuppressRealtimeMessage } = PageActiveScroller;
  assert.equal(typeof shouldSuppressRealtimeMessage, 'function');

  // Khi đang crawl -> mọi tin lịch sử bị chặn
  assert.equal(shouldSuppressRealtimeMessage({ crawlInProgress: true, isHistoricalRow: true }), true);

  // Khi không crawl -> tin realtime được đi qua
  assert.equal(shouldSuppressRealtimeMessage({ crawlInProgress: false, isHistoricalRow: false }), false);
});

test('T001: 8. findPageHistoryScroller chấm điểm và chọn chính xác khung cuộn của Page', () => {
  const { findPageHistoryScroller } = PageActiveScroller;
  assert.equal(typeof findPageHistoryScroller, 'function');

  // Node A: Thẻ sidebar/navigation -> bị loại trừ (score = -1)
  const navNode = {
    closest: (sel) => (sel.includes('navigation') ? {} : null),
    scrollHeight: 1500,
    clientHeight: 600,
    style: { overflowY: 'auto' }
  };

  // Node B: Thẻ chat thật sự chứa tin nhắn -> score cao nhất
  const messageEl = {
    getAttribute: (name) => (name === 'data-message-id' ? 'mid_123' : null),
    parentElement: null
  };
  const chatScroller = {
    closest: () => null,
    scrollHeight: 2000,
    clientHeight: 600,
    style: { overflowY: 'auto' },
    querySelector: (sel) => (sel.includes('data-message-id') ? messageEl : null),
    querySelectorAll: () => []
  };
  messageEl.parentElement = chatScroller;

  const rootContainer = {
    querySelector: (sel) => (sel.includes('data-message-id') ? messageEl : null),
    querySelectorAll: (sel) => [navNode, chatScroller]
  };

  const chosen = findPageHistoryScroller(rootContainer);
  assert.equal(chosen, chatScroller, 'Phải chọn trúng khung chat có bong bóng tin nhắn và overflow');
});

test('T001: 9. waitForDomSettle mode older không thoát sớm trước minWaitMs khi chưa có growth hoặc spinner', async () => {
  const { waitForDomSettle } = PageActiveScroller;

  const staticScroller = {
    querySelector: () => null,
    scrollHeight: 1000
  };

  const start = Date.now();
  const res = await waitForDomSettle(staticScroller, {
    mode: 'older',
    minWaitMs: 120,
    maxWaitMs: 300,
    pollIntervalMs: 15,
    getFirstMessageId: () => 'mid_static'
  });

  const duration = Date.now() - start;
  assert.ok(duration >= 100, `Phải đợi ít nhất qua mốc minWaitMs, thực tế: ${duration}ms`);
  assert.equal(res.hasGrowth, false);
});

test('T001: 10. waitForDomSettle mode older nhận diện spinner xuất hiện rồi biến mất là đã tải xong', async () => {
  const { waitForDomSettle } = PageActiveScroller;

  let ticks = 0;
  const dynamicScroller = {
    querySelector: (sel) => {
      ticks++;
      // Vòng 1-3: chưa có spinner. Vòng 4-6: spinner xuất hiện. Sau đó biến mất.
      if (ticks >= 4 && ticks <= 6 && sel.includes('Loading')) return {};
      return null;
    },
    scrollHeight: 1000
  };

  let currentId = 'mid_initial';
  const res = await waitForDomSettle(dynamicScroller, {
    mode: 'older',
    minWaitMs: 50,
    maxWaitMs: 400,
    pollIntervalMs: 15,
    getFirstMessageId: () => {
      if (ticks > 6) currentId = 'mid_prepended_older';
      return currentId;
    }
  });

  assert.equal(res.settled, true);
  assert.equal(res.hasGrowth, true);
  assert.equal(res.timedOut, false);
});

