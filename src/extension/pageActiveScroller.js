/**
 * pageActiveScroller.js
 * Module hỗ trợ cào chủ động (Active Crawler) an toàn cho Fanpage Meta Business Suite.
 * Thiết kế theo chuẩn UMD / CommonJS để chạy mượt mà cả trong Extension content script và Node.js test runner.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageActiveScroller = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Tính toán khoảng cách cuộn an toàn mỗi bước (70 - 85% chiều cao viewport)
   * Giữ lại 15 - 30% để làm anchor overlap cho React Virtualizer.
   */
  function calculateStepDistance(clientHeight) {
    const height = Number(clientHeight) || 600;
    const rawStep = Math.round(height * 0.75);
    // Giới hạn an toàn: tối thiểu 150px (cho màn hình nhỏ), tối đa 1500px (cho màn hình cực lớn)
    return Math.max(150, Math.min(1500, rawStep));
  }

  /**
   * Tạo bộ tích lũy tin nhắn (Accumulator) qua các vòng cuộn
   * Giữ nguyên 100% tin nhắn trung gian kể cả khi Facebook unmount các tin vừa cuộn qua.
   * Bảo toàn thứ tự đọc từ trên xuống dưới (tin cũ ở đầu mảng, tin mới ở cuối mảng).
   */
  function createMessageAccumulator() {
    let orderedList = [];
    const itemMap = new Map(); // fb_message_id -> messageObj

    function accumulate(messages) {
      if (!Array.isArray(messages) || messages.length === 0) return 0;

      // Tìm anchor trùng khớp đầu tiên giữa batch mới và danh sách hiện có
      let anchorIndexInExisting = -1;
      let anchorIndexInBatch = -1;

      for (let bIdx = 0; bIdx < messages.length; bIdx++) {
        const msg = messages[bIdx];
        if (!msg || !msg.fb_message_id) continue;
        const eIdx = orderedList.findIndex(m => m.fb_message_id === msg.fb_message_id);
        if (eIdx !== -1) {
          anchorIndexInExisting = eIdx;
          anchorIndexInBatch = bIdx;
          break;
        }
      }

      if (anchorIndexInExisting !== -1 && anchorIndexInBatch !== -1) {
        // Có neo trùng khớp:
        // Các tin nằm trước anchor trong batch mới là các tin cũ hơn vừa xuất hiện ở phía trên
        const prependItems = [];
        for (let i = 0; i < anchorIndexInBatch; i++) {
          const item = messages[i];
          if (!itemMap.has(item.fb_message_id)) {
            itemMap.set(item.fb_message_id, item);
            prependItems.push(item);
          }
        }

        // Cập nhật các tin từ anchor trở đi (nếu có thông tin bổ sung)
        for (let i = anchorIndexInBatch; i < messages.length; i++) {
          const item = messages[i];
          if (!itemMap.has(item.fb_message_id)) {
            itemMap.set(item.fb_message_id, item);
            orderedList.push(item);
          } else {
            // Nâng cấp thông tin timestamp nếu tin mới có độ tin cậy cao hơn
            const existing = itemMap.get(item.fb_message_id);
            if ((!existing.timestamp_ms || existing.timestamp_ms <= 0) && item.timestamp_ms > 0) {
              existing.timestamp_ms = item.timestamp_ms;
              existing.timestamp_source = item.timestamp_source;
            }
          }
        }

        if (prependItems.length > 0) {
          orderedList = [...prependItems, ...orderedList];
        }
      } else {
        // Lần đầu nạp (hoặc không tìm thấy neo): nạp tuần tự
        for (const item of messages) {
          if (!item || !item.fb_message_id) continue;
          if (!itemMap.has(item.fb_message_id)) {
            itemMap.set(item.fb_message_id, item);
            orderedList.push(item);
          }
        }
      }

      return itemMap.size;
    }

    function getAll() {
      return [...orderedList];
    }

    function getCount() {
      return orderedList.length;
    }

    return {
      accumulate,
      getAll,
      getCount
    };
  }

  /**
   * Kiểm tra một phần tử có phải là Container chứa danh sách tin nhắn hợp lệ hay không
   * Loại trừ triệt để vùng Navigation và Sidebar hội thoại.
   */
  function isMessageLogContainer(el) {
    if (!el || typeof el.closest !== 'function') return false;

    // Loại trừ navigation và sidebar
    const isNav = el.closest('[role="navigation"], [data-surface*="thread_list"], .sidebar, [aria-label*="H?i tho?i"], [aria-label*="Chats"]');
    if (isNav) return false;

    const hasScroll = el.scrollHeight > el.clientHeight + 10;
    const hasBubbles = typeof el.querySelector === 'function' ? !!el.querySelector('[data-message-id], [dir="auto"]') : true;

    return !!(hasScroll && hasBubbles);
  }

  /**
   * Tìm chính xác 100% khung cuộn tin nhắn thực tế của Fanpage (Meta Business Suite)
   * Sử dụng hệ thống chấm điểm (Scoring) thích nghi từ Messenger cá nhân nhưng điều chỉnh
   * cho bong bóng [data-message-id] của Business Suite.
   */
  function findPageHistoryScroller(container) {
    if (!container) return null;
    const candidates = new Set([container]);
    const anyMessage = typeof container.querySelector === 'function' ? container.querySelector('[data-message-id]') : null;
    if (anyMessage) {
      let node = anyMessage;
      while (node && node !== (typeof document !== 'undefined' ? document.body : null)) {
        candidates.add(node);
        node = node.parentElement;
      }
    }
    if (typeof container.querySelectorAll === 'function') {
      const allDivs = container.querySelectorAll('div');
      for (let i = 0; i < allDivs.length; i++) {
        const div = allDivs[i];
        if (div.scrollHeight > div.clientHeight + 8) {
          candidates.add(div);
        }
      }
    }

    const scored = [...candidates].map((node) => {
      if (!node) return { node, score: -1 };
      // Loại trừ navigation và sidebar
      if (typeof node.closest === 'function') {
        const isNav = node.closest('[role="navigation"], [data-surface*="thread_list"], .sidebar, [aria-label*="H?i tho?i"], [aria-label*="Chats"]');
        if (isNav) return { node, score: -1 };
      }

      const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(node)
        : (node.style || {});
      const rect = typeof node.getBoundingClientRect === 'function'
        ? node.getBoundingClientRect()
        : { width: 300, height: 600 };

      const range = Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0));
      const hasOverflow = ['auto', 'scroll', 'overlay'].includes(style?.overflowY);
      const hasBubbles = typeof node.querySelector === 'function' ? !!node.querySelector('[data-message-id]') : false;

      const score = range
        + (hasOverflow ? 100000 : 0)
        + (hasBubbles ? 200000 : 0)
        + ((rect.width > 180 && rect.height > 180) ? 50000 : 0);

      return { node, score };
    }).filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.node || null;
  }

  /**
   * Phát chuỗi thao tác cuộn an toàn kết hợp fallback và hỗ trợ chạm đỉnh (forceToTop)
   */
  function dispatchScrollGestures(scroller, stepDistance, options = {}) {
    if (!scroller) return;
    const distance = typeof stepDistance === 'number' ? stepDistance : calculateStepDistance(scroller.clientHeight);
    const forceToTop = options && options.forceToTop === true;

    // 1. Focus con trỏ vào khung cuộn nếu có
    if (typeof scroller.focus === 'function') {
      try { scroller.focus({ preventScroll: true }); } catch (e) {}
    }

    // 2. Cu?n c? h?c b?ng scrollBy
    if (typeof scroller.scrollBy === 'function') {
      scroller.scrollBy({ top: -distance, behavior: 'auto' });
    } else if (typeof scroller.scrollTop === 'number') {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
    }

    // 3. Bắt buộc dispatch event scroll tiêu chuẩn
    if (typeof scroller.dispatchEvent === 'function') {
      try {
        let scrollEvt;
        if (typeof Event === 'function') {
          scrollEvt = new Event('scroll', { bubbles: true, cancelable: false });
        } else {
          scrollEvt = { type: 'scroll' };
        }
        scroller.dispatchEvent(scrollEvt);
      } catch (e) {
        // Silent catch for test env
      }

      // 4. Dispatch WheelEvent b? tr?
      try {
        let wheelEvt;
        if (typeof WheelEvent === 'function') {
          wheelEvt = new WheelEvent('wheel', {
            deltaY: -distance,
            deltaMode: 0,
            bubbles: true,
            cancelable: true
          });
        } else {
          wheelEvt = { type: 'wheel', deltaY: -distance };
        }
        scroller.dispatchEvent(wheelEvt);
      } catch (e) {
        // Fallback if WheelEvent not constructed
      }
    }

    // 5. Chạm đỉnh tuyệt đối (forceToTop) để kích hoạt API tải tin cũ của Facebook
    if (forceToTop && typeof scroller.scrollTop === 'number') {
      scroller.scrollTop = 0;
      if (typeof scroller.dispatchEvent === 'function') {
        try {
          const scrollEvt = typeof Event === 'function' ? new Event('scroll', { bubbles: true }) : { type: 'scroll' };
          scroller.dispatchEvent(scrollEvt);
        } catch (e) {}
      }
    }
  }

  /**
   * Quan sát DOM chờ trạng thái ổn định sau một bước cuộn
   * Bắt spinner loading, kiểm tra tăng trưởng scrollHeight và ID tin nhắn đầu tiên.
   */
  async function waitForDomSettle(scroller, options = {}) {
    const maxWaitMs = options.maxWaitMs || 2500;
    const pollIntervalMs = options.pollIntervalMs || 50;
    const getFirstMessageId = typeof options.getFirstMessageId === 'function' ? options.getFirstMessageId : () => null;

    const startTime = Date.now();
    const initialHeight = scroller ? scroller.scrollHeight : 0;
    const initialFirstId = getFirstMessageId();

    let lastHeight = initialHeight;
    let lastFirstId = initialFirstId;
    let stableRounds = 0;
    let hasGrowth = false;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));

      const isSpinnerVisible = scroller && typeof scroller.querySelector === 'function'
        ? !!scroller.querySelector('svg[aria-label="Loading"], div[role="progressbar"], [aria-busy="true"]')
        : false;

      const currentHeight = scroller ? scroller.scrollHeight : 0;
      const currentFirstId = getFirstMessageId();

      if (currentHeight > initialHeight || (currentFirstId && currentFirstId !== initialFirstId)) {
        hasGrowth = true;
      }

      if (!isSpinnerVisible && currentHeight === lastHeight && currentFirstId === lastFirstId) {
        stableRounds++;
      } else {
        stableRounds = 0;
      }

      lastHeight = currentHeight;
      lastFirstId = currentFirstId;

      // 2 vòng liên tiếp ổn định không có spinner -> DOM đã sẵn sàng
      if (!isSpinnerVisible && stableRounds >= 2) {
        return {
          settled: true,
          hasGrowth,
          timedOut: false
        };
      }
    }

    return {
      settled: false,
      hasGrowth,
      timedOut: true
    };
  }

  /**
   * Bộ quản lý Mutex chống xung đột đa luồng khi người dùng cuộn nhanh hoặc đổi thread
   */
  function createCrawlMutex() {
    let currentToken = null;

    function acquire(threadId) {
      const now = Date.now();
      // Nếu đang có crawl cùng thread chưa quá 15s -> coalesce (từ chối chạy trùng)
      if (currentToken && currentToken.threadId === threadId && now - currentToken.timestamp < 15000) {
        return null;
      }

      const newToken = {
        token: Math.random().toString(36).substring(2, 9),
        threadId: String(threadId),
        timestamp: now
      };
      currentToken = newToken;
      return newToken;
    }

    function isTokenValid(token, activeThreadId) {
      if (!token || !currentToken) return false;
      return token.token === currentToken.token && token.threadId === String(activeThreadId);
    }

    function release(token) {
      if (token && currentToken && token.token === currentToken.token) {
        currentToken = null;
      }
    }

    function isBusy() {
      return !!currentToken;
    }

    return {
      acquire,
      isTokenValid,
      release,
      isBusy
    };
  }

  /**
   * Khóa luồng realtime khi đang trong tiến trình cào dữ liệu lịch sử
   */
  function shouldSuppressRealtimeMessage({ crawlInProgress, isHistoricalRow }) {
    return !!crawlInProgress && !!isHistoricalRow;
  }

  return {
    calculateStepDistance,
    createMessageAccumulator,
    isMessageLogContainer,
    findPageHistoryScroller,
    dispatchScrollGestures,
    waitForDomSettle,
    createCrawlMutex,
    shouldSuppressRealtimeMessage
  };
}));
