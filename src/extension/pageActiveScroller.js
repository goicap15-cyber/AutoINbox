/**
 * pageActiveScroller.js
 * Module há»— trá»£ cÃ o chá»§ Ä‘á»™ng (Active Crawler) an toÃ n cho Fanpage Meta Business Suite.
 * Thiáº¿t káº¿ theo chuáº©n UMD / CommonJS Ä‘á»ƒ cháº¡y mÆ°á»£t mÃ  cáº£ trong Extension content script vÃ  Node.js test runner.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageActiveScroller = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * TÃ­nh toÃ¡n khoáº£ng cÃ¡ch cuá»™n an toÃ n má»—i bÆ°á»›c (70 - 85% chiá»u cao viewport)
   * Giá»¯ láº¡i 15 - 30% Ä‘á»ƒ lÃ m anchor overlap cho React Virtualizer.
   */
  function calculateStepDistance(clientHeight) {
    const height = Number(clientHeight) || 600;
    const rawStep = Math.round(height * 0.75);
    // Giá»›i háº¡n an toÃ n: tá»‘i thiá»ƒu 150px (cho mÃ n hÃ¬nh nhá»), tá»‘i Ä‘a 1500px (cho mÃ n hÃ¬nh cá»±c lá»›n)
    return Math.max(150, Math.min(1500, rawStep));
  }

  /**
   * Táº¡o bá»™ tÃ­ch lÅ©y tin nháº¯n (Accumulator) qua cÃ¡c vÃ²ng cuá»™n
   * Giá»¯ nguyÃªn 100% tin nháº¯n trung gian ká»ƒ cáº£ khi Facebook unmount cÃ¡c tin vá»«a cuá»™n qua.
   * Báº£o toÃ n thá»© tá»± Ä‘á»c tá»« trÃªn xuá»‘ng dÆ°á»›i (tin cÅ© á»Ÿ Ä‘áº§u máº£ng, tin má»›i á»Ÿ cuá»‘i máº£ng).
   */
  function createMessageAccumulator() {
    let orderedList = [];
    const itemMap = new Map(); // fb_message_id -> messageObj

    function accumulate(messages) {
      if (!Array.isArray(messages) || messages.length === 0) return 0;

      // TÃ¬m anchor trÃ¹ng khá»›p Ä‘áº§u tiÃªn giá»¯a batch má»›i vÃ  danh sÃ¡ch hiá»‡n cÃ³
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
        // CÃ³ neo trÃ¹ng khá»›p:
        // CÃ¡c tin náº±m trÆ°á»›c anchor trong batch má»›i lÃ  cÃ¡c tin cÅ© hÆ¡n vá»«a xuáº¥t hiá»‡n á»Ÿ phÃ­a trÃªn
        const prependItems = [];
        for (let i = 0; i < anchorIndexInBatch; i++) {
          const item = messages[i];
          if (!itemMap.has(item.fb_message_id)) {
            itemMap.set(item.fb_message_id, item);
            prependItems.push(item);
          }
        }

        // Cáº­p nháº­t cÃ¡c tin tá»« anchor trá»Ÿ Ä‘i (náº¿u cÃ³ thÃ´ng tin bá»• sung)
        for (let i = anchorIndexInBatch; i < messages.length; i++) {
          const item = messages[i];
          if (!itemMap.has(item.fb_message_id)) {
            itemMap.set(item.fb_message_id, item);
            orderedList.push(item);
          } else {
            // NÃ¢ng cáº¥p thÃ´ng tin timestamp náº¿u tin má»›i cÃ³ Ä‘á»™ tin cáº­y cao hÆ¡n
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
        // Láº§n Ä‘áº§u náº¡p (hoáº·c khÃ´ng tÃ¬m tháº¥y neo): náº¡p tuáº§n tá»±
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
   * Kiá»ƒm tra má»™t pháº§n tá»­ cÃ³ pháº£i lÃ  Container chá»©a danh sÃ¡ch tin nháº¯n há»£p lá»‡ hay khÃ´ng
   * Loáº¡i trá»« triá»‡t Ä‘á»ƒ vÃ¹ng Navigation vÃ  Sidebar há»™i thoáº¡i.
   */
  function isMessageLogContainer(el) {
    if (!el || typeof el.closest !== 'function') return false;

    // Loáº¡i trá»« navigation vÃ  sidebar
    const isNav = el.closest('[role="navigation"], [data-surface*="thread_list"], .sidebar, [aria-label*="Há»™i thoáº¡i"], [aria-label*="Chats"]');
    if (isNav) return false;

    const hasScroll = el.scrollHeight > el.clientHeight + 10;
    const hasBubbles = typeof el.querySelector === 'function' ? !!el.querySelector('[data-message-id], [dir="auto"]') : true;

    return !!(hasScroll && hasBubbles);
  }

  /**
   * TÃ¬m chÃ­nh xÃ¡c 100% khung cuá»™n tin nháº¯n thá»±c táº¿ cá»§a Fanpage (Meta Business Suite)
   * Sá»­ dá»¥ng há»‡ thá»‘ng cháº¥m Ä‘iá»ƒm (Scoring) thÃ­ch nghi tá»« Messenger cÃ¡ nhÃ¢n nhÆ°ng Ä‘iá»u chá»‰nh
   * cho bong bÃ³ng [data-message-id] cá»§a Business Suite.
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
      // Loáº¡i trá»« navigation vÃ  sidebar
      if (typeof node.closest === 'function') {
        const isNav = node.closest('[role="navigation"], [data-surface*="thread_list"], .sidebar, [aria-label*="Há»™i thoáº¡i"], [aria-label*="Chats"]');
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
   * PhÃ¡t chuá»—i thao tÃ¡c cuá»™n an toÃ n káº¿t há»£p fallback vÃ  há»— trá»£ cháº¡m Ä‘á»‰nh (forceToTop)
   */
  function dispatchScrollGestures(scroller, stepDistance, options = {}) {
    if (!scroller) return;
    const distance = typeof stepDistance === 'number' ? stepDistance : calculateStepDistance(scroller.clientHeight);
    const forceToTop = options && options.forceToTop === true;

    // 1. Focus con trá» vÃ o khung cuá»™n náº¿u cÃ³
    if (typeof scroller.focus === 'function') {
      try { scroller.focus({ preventScroll: true }); } catch (e) {}
    }

    // 2. Cuá»™n cÆ¡ há»c báº±ng scrollBy
    if (typeof scroller.scrollBy === 'function') {
      scroller.scrollBy({ top: -distance, behavior: 'auto' });
    } else if (typeof scroller.scrollTop === 'number') {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
    }

    // 3. Báº¯t buá»™c dispatch event scroll tiÃªu chuáº©n
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

      // 4. Dispatch WheelEvent bá»• trá»£
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

    // 5. Cháº¡m Ä‘á»‰nh tuyá»‡t Ä‘á»‘i (forceToTop) Ä‘á»ƒ kÃ­ch hoáº¡t API táº£i tin cÅ© cá»§a Facebook
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
   * Quan sÃ¡t DOM chá» tráº¡ng thÃ¡i á»•n Ä‘á»‹nh sau má»™t bÆ°á»›c cuá»™n
   * Báº¯t spinner loading, kiá»ƒm tra tÄƒng trÆ°á»Ÿng scrollHeight vÃ  ID tin nháº¯n Ä‘áº§u tiÃªn.
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

      // 2 vÃ²ng liÃªn tiáº¿p á»•n Ä‘á»‹nh khÃ´ng cÃ³ spinner -> DOM Ä‘Ã£ sáºµn sÃ ng
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
   * Bá»™ quáº£n lÃ½ Mutex chá»‘ng xung Ä‘á»™t Ä‘a luá»“ng khi ngÆ°á»i dÃ¹ng cuá»™n nhanh hoáº·c Ä‘á»•i thread
   */
  function createCrawlMutex() {
    let currentToken = null;

    function acquire(threadId) {
      const now = Date.now();
      // Náº¿u Ä‘ang cÃ³ crawl cÃ¹ng thread chÆ°a quÃ¡ 15s -> coalesce (tá»« chá»‘i cháº¡y trÃ¹ng)
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
   * KhÃ³a luá»“ng realtime khi Ä‘ang trong tiáº¿n trÃ¬nh cÃ o dá»¯ liá»‡u lá»‹ch sá»­
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


