// ── Page Content Script for Business Suite Inbox ──────────────────────────────
// Injected into https://business.facebook.com/* via manifest.json

// Prevent running in normal www.facebook.com personal chats
// We only want to run in business.facebook.com OR in an iframe embedded within it.
const isBusiness = window.location.hostname.includes('business.facebook.com')
    || window.location.href.includes('asset_id=')
    || window.location.href.includes('/biz/')
    || (window.top !== window.self
        && window.location.hostname.includes('facebook.com')
        && document.referrer.includes('business.facebook.com'));

if (isBusiness) {
    console.log(`[PageContent] Business Suite Inbox DOM observer started in ${window.top === window.self ? 'TOP FRAME' : 'IFRAME'}: ${window.location.href}`);

    class BoundedSet {
        constructor(maxSize) {
            this.maxSize = maxSize;
            this.set = new Set();
            this.queue = [];
        }
        has(val) { return this.set.has(val); }
        add(val) {
            if (!this.set.has(val)) {
                if (this.queue.length >= this.maxSize) {
                    const oldest = this.queue.shift();
                    this.set.delete(oldest);
                }
                this.set.add(val);
                this.queue.push(val);
            }
        }
    }
    let processedHashes = new BoundedSet(1000);

    // Feature 017: a message bubble can be scanned before Facebook attaches its
    // real data-message-id (a genuine render-timing race for just-arrived
    // messages). Forwarding it immediately with fb_message_id=null makes the
    // backend fall back to a content+timestamp fingerprint as its identity;
    // once the real id attaches a tick later, that's a *different* identity,
    // so the same logical message lands as two DB rows. Deferring a bounded
    // number of ticks before forwarding an ID-less bubble gives the real id a
    // chance to attach first, without ever dropping a message that genuinely
    // never gets one (see MAX_PENDING_TICKS fallback below).
    let currentTick = 0;
    let pendingNoIdBubbles = new WeakMap(); // bubbleEl -> { firstSeenTick }
    const MAX_PENDING_TICKS = 2;

    // A hash whose direction never resolves (e.g. a non-message UI element
    // like a Business Suite date separator, which sits outside any real
    // message bubble and so never gets directional geometry) is never added
    // to processedHashes below (gated on isOutgoing !== null) - so it would
    // re-fire as "new" on every 1s scan tick, forever, if it isn't otherwise
    // filtered. Bound how many ticks an unresolved-direction hash is allowed
    // to keep re-forwarding before it's remembered anyway. Real messages
    // resolve their direction (or acquire a real fb_message_id, which keys
    // off a separate stable hash - see dedupKey below) well within this
    // window; anything still unresolved past it is presumed not to be a
    // real message at all.
    let unresolvedHashFirstSeenTick = new Map(); // hash -> firstSeenTick
    const MAX_UNRESOLVED_DIRECTION_TICKS = 5;
    let lastReportedContactName = null;
    let lastReportedAvatarUrl = null;

    // Verified via live DevTools inspection: Business Suite never exposes a real
    // per-message clock time (no data-timestamp/title/hover label). What DOM order
    // does reliably give us is the true chronological order of whatever is
    // currently mounted (top = oldest, bottom = newest) - that never depends on
    // Facebook's build-specific class names. We turn that ordering into a
    // monotonic synthetic timestamp per fb_message_id, anchored against ids we've
    // already assigned, so relative order stays correct even across virtualization
    // remounts and scroll-back reveals of older history.
    const ORDER_GAP_MS = 1000;
    const MAX_KNOWN_TIMESTAMPS = 3000;
    // Spec 047: how far behind Date.now() a forward-extrapolated timestamp is
    // allowed to drift before it's treated as an untrustworthy stale anchor
    // (see assignOrderedTimestamps below) rather than a real recent time.
    const STALE_ANCHOR_MS = 5 * 60 * 1000;
    let knownMessageTimestamps = new Map(); // fbMessageId -> assigned timestamp_ms

    // Fallback only for the rare message with no data-message-id at all (see
    // isLikelyBacklog below): messages first seen within this long of opening a
    // thread are backlog, not new arrivals, so they must not be stamped with "now".
    const THREAD_BACKLOG_WINDOW_MS = 4000;
    let lastKnownThreadId = null;
    let lastThreadSwitchAt = Date.now();
    let currentContactName = null;
    let currentAvatarUrl = null;
    let currentAvatarSourceTier = 0; // 0: none, 1: sidebar/header, 2: right details pane


    // Active Crawler state (Feature 055)
    let crawlInProgress = false;
    const crawlMutex = (typeof FbPageActiveScroller !== 'undefined' && FbPageActiveScroller.createCrawlMutex)
        ? FbPageActiveScroller.createCrawlMutex()
        : { acquire: (id) => ({ token: 'mock_' + id, threadId: id }), isTokenValid: () => true, release: () => {}, isBusy: () => false };

    // Use polling to be completely immune to React DOM shuffling
    setInterval(scanForMessages, 1000);
    setInterval(scanPageSidebarThreads, 3500);
    setTimeout(scanPageSidebarThreads, 1500);

    // Feature Realtime Sidebar: Lắng nghe biến động Sidebar phát hiện tin nhắn mới tức thì
    let sidebarDebounceTimer = null;
    function setupSidebarObserver() {
        const sidebarContainer = document.querySelector('[data-surface*="thread_list"], [data-surface*="bizweb_inbox:thread_list"], [role="navigation"]');
        if (!sidebarContainer) {
            setTimeout(setupSidebarObserver, 2000);
            return;
        }
        try {
            const observer = new MutationObserver(() => {
                if (sidebarDebounceTimer) clearTimeout(sidebarDebounceTimer);
                sidebarDebounceTimer = setTimeout(() => {
                    scanPageSidebarThreads();
                }, 300);
            });
            observer.observe(sidebarContainer, { childList: true, subtree: true, characterData: true });
            console.log('[PageContent] ⚡ Đã kích hoạt MutationObserver theo dõi Sidebar real-time (< 1s)');
        } catch (e) {
            console.warn('[PageContent] Không thể gắn observer cho sidebar:', e.message);
        }
    }
    setTimeout(setupSidebarObserver, 2000);

    // Feature 055: Old passive scrollBackForHistory interval is deprecated and replaced
    // by the active on-demand crawler triggered by REQUEST_PAGE_BATCH_SYNC.
    // setInterval(scrollBackForHistory, SCROLL_INTERVAL_MS);

    let isScanning = false;

    function resolveCurrentThreadId() {
        // DOM First: Find currently selected item in Business Suite sidebar
        const selectedContainer = document.querySelector('[role="navigation"] [aria-selected="true"], [role="gridcell"] [aria-selected="true"], [data-surface*="thread_list"] [aria-selected="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]');
        if (selectedContainer) {
            const links = selectedContainer.tagName === 'A' ? [selectedContainer] : Array.from(selectedContainer.querySelectorAll('a[href]'));
            for (const link of links) {
                const linkHref = link.getAttribute('href') || link.href || '';
                const m = linkHref.match(/(?:selected_item_id|thread_id)=(\d+)/) || linkHref.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
                if (m && m[1]) return m[1];
            }
        }

        const href = window.location.href;
        const urlMatch = href.match(/[?&](?:selected_item_id|thread_id)=(\d+)/) || href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
        if (urlMatch && urlMatch[1]) {
            return urlMatch[1];
        }

        const selectors = [
            '[role="navigation"] [aria-selected="true"] a',
            '[role="gridcell"] a[href*="selected_item_id="]',
            'div[role="navigation"] a[aria-current="page"]',
            'a[href*="selected_item_id="]',
            'a[href*="/messages/t/"]'
        ];

        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const linkHref = el.getAttribute('href') || el.href || '';
                const match = linkHref.match(/(?:selected_item_id|thread_id)=(\d+)/) || linkHref.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
                if (match && match[1]) {
                    return match[1];
                }
            }
        }

        return null;
    }

    window.addEventListener('popstate', () => setTimeout(scanForMessages, 300));
    window.addEventListener('hashchange', () => setTimeout(scanForMessages, 300));
    document.addEventListener('click', (e) => {
        if (e.target?.closest?.('[role="listitem"], [role="row"], a[href]')) {
            setTimeout(scanForMessages, 500);
        }
    }, true);

    // Lắng nghe hover tooltip để bóc tách giờ thật chi tiết từ Facebook Page
    let hoverTooltipTimer = null;
    document.addEventListener('mouseover', (e) => {
        const msgEl = e.target?.closest?.('[data-message-id]');
        if (!msgEl) return;
        const fbMessageId = msgEl.getAttribute('data-message-id');
        if (!fbMessageId) return;

        clearTimeout(hoverTooltipTimer);
        hoverTooltipTimer = setTimeout(() => {
            const describedBy = msgEl.getAttribute('aria-describedby');
            let tooltipEl = describedBy ? document.getElementById(describedBy) : null;
            if (!tooltipEl) {
                const tooltips = document.querySelectorAll('[role="tooltip"], [data-testid*="tooltip"]');
                if (tooltips.length > 0) tooltipEl = tooltips[tooltips.length - 1];
            }
            if (tooltipEl) {
                const tooltipText = (tooltipEl.textContent || '').trim();
                const parser = (typeof FbPageTimestampParser !== 'undefined' ? FbPageTimestampParser.parseTimeFromLabel : null)
                    || (typeof window !== 'undefined' && window.FbPageTimestampParser ? window.FbPageTimestampParser.parseTimeFromLabel : null);
                if (typeof parser === 'function') {
                    const preciseTs = parser(tooltipText);
                    if (preciseTs && preciseTs > 0) {
                        knownMessageTimestamps.set(fbMessageId, preciseTs);
                        const threadId = resolveCurrentThreadId();
                        if (threadId) {
                            chrome.runtime.sendMessage({
                                type: 'UPGRADE_MESSAGE_TIMESTAMP',
                                data: {
                                    thread_id: threadId,
                                    fb_message_id: fbMessageId,
                                    timestamp_ms: preciseTs,
                                    timestamp_source: 'facebook_label'
                                }
                            });
                        }
                    }
                }
            }
        }, 350);
    }, { passive: true });

    function isLikelyBacklog(threadId) {
        if (threadId !== lastKnownThreadId) {
            lastKnownThreadId = threadId;
            lastThreadSwitchAt = Date.now();
            currentContactName = null;
            currentAvatarUrl = null;
            currentAvatarSourceTier = 0;
            return true; // just switched/opened this thread; whatever is already mounted is backlog
        }
        return (Date.now() - lastThreadSwitchAt) < THREAD_BACKLOG_WINDOW_MS;
    }

    // Re-seeds knownMessageTimestamps from the backend's persisted record for
    // this thread when we start observing it. Without this, a content-script
    // restart (tab reload, browser restart, service worker restart) wipes
    // knownMessageTimestamps, and any message that's genuinely new to the
    // backend but discovered with zero surviving anchors falls back to "now" -
    // stamping a message from days ago as if it arrived today. Fire-and-forget:
    // never awaited, never blocks the 1s scan cadence, degrades to today's
    // existing in-memory-only behavior if the backend is unreachable.
    function seedTimestampAnchorsForThread(threadId) {
        if (!threadId) return;
        chrome.runtime.sendMessage({ type: 'GET_THREAD_TIMESTAMPS', data: { threadId } }, (response) => {
            if (chrome.runtime.lastError) return; // background unreachable - degrade silently
            const timestamps = response && response.timestamps;
            if (!Array.isArray(timestamps)) return;
            for (const entry of timestamps) {
                const id = entry && entry.fb_message_id;
                const ts = entry && entry.timestamp_ms;
                // Never overwrite an anchor this session already set more precisely.
                if (id && typeof ts === 'number' && !knownMessageTimestamps.has(id)) {
                    knownMessageTimestamps.set(id, ts);
                }
            }
        });
    }

    function findScrollableMessageContainer() {
        const scrollerHelper = typeof FbPageActiveScroller !== 'undefined' ? FbPageActiveScroller : null;
        if (scrollerHelper && typeof scrollerHelper.findPageHistoryScroller === 'function') {
            const scoredScroller = scrollerHelper.findPageHistoryScroller(document.body);
            if (scoredScroller) return scoredScroller;
        }

        const anyMessage = document.querySelector('[data-message-id]');
        if (!anyMessage) return null;
        let curr = anyMessage.parentElement;
        let overflowCapableFallback = null;

        while (curr && curr !== document.body) {
            const style = window.getComputedStyle(curr);
            const isOverflowCapable = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay';
            if (isOverflowCapable) {
                if (scrollerHelper && typeof scrollerHelper.isMessageLogContainer === 'function') {
                    if (scrollerHelper.isMessageLogContainer(curr)) {
                        return curr;
                    }
                } else {
                    const isNav = curr.closest && curr.closest('[role="navigation"], [data-surface*="thread_list"], .sidebar');
                    if (!isNav && curr.scrollHeight > curr.clientHeight + 10) {
                        return curr;
                    }
                }
                if (!overflowCapableFallback) overflowCapableFallback = curr;
            }
            curr = curr.parentElement;
        }
        return overflowCapableFallback;
    }

    // Same role="region"/main/grid detection strategy already used by the
    // inChatContainer walk in processPotentialMessage, but returning the actual
    // container element instead of a boolean, so other lookups (contact name /
    function isExcludedElement(el) {
        if (!el) return false;
        const target = el.nodeType === 1 ? el : el.parentElement;
        if (!target) return false;
        if (target.closest('nav, [role="navigation"], [data-surface*="nav"], header, [role="banner"], aside, [aria-label*="Điều hướng"], [aria-label*="Navigation"], [data-surface*="thread_list"], [role="gridcell"], form, [role="textbox"], [contenteditable="true"]')) {
            return true;
        }
        try {
            const rect = target.getBoundingClientRect();
            if (rect.width > 0 && rect.right < 200) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    // Same role="region"/main/grid detection strategy already used by the
    // inChatContainer walk in processPotentialMessage, but returning the actual
    // container element instead of a boolean, so other lookups (contact name /
    // avatar) can be scoped to it instead of querying the whole document - the
    // Business Suite sidebar conversation list has its own avatar thumbnails
    // that must never leak into the currently-open thread's contact info.
    function findMessageListContainer() {
        const anchor = document.querySelector('[data-message-id]')
            || document.querySelector('[aria-label*="Đoạn chat"]')
            || document.querySelector('[aria-label*="tin nhắn"]');
        if (!anchor) return null;
        let curr = anchor.parentElement || anchor;
        while (curr && curr !== document.body) {
            if (curr.getAttribute) {
                const label = (curr.getAttribute('aria-label') || '').toLowerCase();
                const role = curr.getAttribute('role');
                if (role === 'region' && (label.includes('tin nhắn') || label.includes('message') || label.includes('msg') || label.includes('chat'))) {
                    return curr;
                }
                if (role === 'grid' && !label.includes('hội thoại') && !label.includes('cuộc trò chuyện') && !label.includes('thread')) {
                    return curr;
                }
                if (role === 'main' && !label.includes('bảng feed') && !label.includes('sidebar')) {
                    return curr;
                }
            }
            curr = curr.parentElement;
        }
        return anchor.parentElement || null;
    }

    // Direction is measured relative to the actual message-list container.
    // A missing/ambiguous layout is deliberately returned as unknown; callers
    // persist it as pending instead of silently treating it as incoming.
    function getDirectionEvidence(messageEl, messageListContainer) {
        const classifier = globalThis.FbCrmPageDirection
            && globalThis.FbCrmPageDirection.classifyByContainerEdges;
        if (!classifier || !messageEl || !messageListContainer) {
            return { direction: null, source: 'unknown', confidence: 'unknown' };
        }
        try {
            // 1. Kiểm tra aria-label trợ năng trên messageEl hoặc row cha
            const messageRow = messageEl.closest?.('[role="row"], [role="article"], [data-surface*="message"]') || messageEl.parentElement;
            const elAria = (messageEl.getAttribute?.('aria-label') || '').toLowerCase();
            const rowAria = (messageRow?.getAttribute?.('aria-label') || '').toLowerCase();
            const combinedAria = elAria + ' ' + rowAria;

            if (combinedAria.includes('tin nhắn do bạn gửi') || combinedAria.includes('message from you') || combinedAria.includes('you sent')) {
                return { direction: true, source: 'aria_label', confidence: 'high' };
            }

            const sentByMatch = combinedAria.match(/tin nhắn do ([^]+?) gửi lúc/i) || combinedAria.match(/message sent by ([^]+?) at/i);
            if (sentByMatch) {
                const rawSender = sentByMatch[1].trim().toLowerCase();
                if (rawSender === 'bạn' || rawSender === 'you') {
                    return { direction: true, source: 'aria_label', confidence: 'high' };
                } else {
                    return { direction: false, source: 'aria_label', confidence: 'high' };
                }
            }

            // 2. Tìm visual element thực sự bên trong (tránh lấy bounding box của thẻ cha width 100%)
            let targetMeasureEl = messageEl;
            if (messageEl.tagName && (messageEl.tagName.toLowerCase() === 'svg' || messageEl.tagName.toLowerCase() === 'img' || messageEl.getAttribute?.('role') === 'img')) {
                targetMeasureEl = messageEl;
            } else if (isLikeElementOrWrapper(messageEl)) {
                const likeVisual = messageEl.querySelector?.('svg:not([aria-label*="tùy chọn" i]):not([aria-label*="bày tỏ" i]):not([aria-label*="khác" i]), [role="img"]:not([aria-label*="đại diện" i]), img:not([alt*="đại diện" i])');
                if (likeVisual) targetMeasureEl = likeVisual;
            } else {
                const innerVisual = messageEl.querySelector?.('[dir="auto"], svg:not([aria-label*="tùy chọn" i]):not([aria-label*="bày tỏ" i]):not([aria-label*="khác" i]), img:not([alt*="đại diện" i]):not([alt*="profile" i]), [role="img"]:not([aria-label*="đại diện" i])');
                if (innerVisual) {
                    const vRect = innerVisual.getBoundingClientRect();
                    if (vRect.width > 0 && vRect.height > 0) {
                        targetMeasureEl = innerVisual;
                    }
                }
            }

            // 3. Kiểm tra avatar của khách hàng đi kèm trong cụm tin nhắn
            let hasContactAvatar = null;
            if (messageRow) {
                hasContactAvatar = messageRow.querySelector?.('img[alt*="đại diện" i], img[alt*="profile" i], [aria-label*="ảnh đại diện" i], [aria-label*="profile picture" i]');
                if (!hasContactAvatar && currentContactName && typeof currentContactName === 'string') {
                    const cleanName = currentContactName.trim();
                    if (cleanName.length >= 2) {
                        const allImgs = Array.from(messageRow.querySelectorAll?.('img[alt], [role="img"][aria-label], img[aria-label]') || []);
                        for (const img of allImgs) {
                            const alt = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').toLowerCase();
                            if (alt.includes(cleanName.toLowerCase())) {
                                hasContactAvatar = img;
                                break;
                            }
                        }
                    }
                }
            }

            // Nếu phát hiện có avatar của khách hàng trong cụm tin nhắn -> 100% là tin khách gửi (incoming)
            if (hasContactAvatar) {
                return { direction: false, source: 'avatar_contact_match', confidence: 'high' };
            }

            // 3.5. Kiểm tra đặc trưng Màu sắc cho nút Like (Vàng/Cam = Page, Xanh = Khách)
            if (isLikeElementOrWrapper(messageEl)) {
                const checkElements = [messageEl, targetMeasureEl, messageEl.parentElement, ...(messageEl.querySelectorAll ? Array.from(messageEl.querySelectorAll('svg, path, [role="img"], img')) : [])];
                for (const node of checkElements) {
                    if (!node) continue;
                    const fill = (node.getAttribute?.('fill') || (node.style && node.style.fill) || '').toLowerCase();
                    const stroke = (node.getAttribute?.('stroke') || (node.style && node.style.stroke) || '').toLowerCase();
                    const style = (node.getAttribute?.('style') || '').toLowerCase();
                    const color = (node.style && node.style.color ? node.style.color : '').toLowerCase();
                    const combined = fill + ' ' + stroke + ' ' + style + ' ' + color;

                    // Màu vàng/cam/amber -> Nút Like của Page (Outgoing)
                    if (/f7b125|fa3e3e|fa7b25|rgb\(\s*247|rgb\(\s*250|rgb\(\s*255,\s*(?:1|2)|yellow|gold|amber|orange/i.test(combined)) {
                        return { direction: true, source: 'like_color_page', confidence: 'high' };
                    }
                    // Màu xanh dương -> Nút Like của Khách (Incoming)
                    if (/0084ff|0080ff|0a7cff|rgb\(\s*0,\s*132|rgb\(\s*0,\s*128|blue/i.test(combined)) {
                        return { direction: false, source: 'like_color_customer', confidence: 'high' };
                    }
                }
            }

            // 4. Đo mép container kết hợp đường phân chia trung tâm (Center-line)
            const cRect = messageListContainer.getBoundingClientRect();
            const bRect = targetMeasureEl.getBoundingClientRect();

            if (cRect.width > 0 && bRect.width > 0) {
                const containerCenter = cRect.left + cRect.width * 0.52;
                const bubbleCenter = bRect.left + bRect.width / 2;
                if (bubbleCenter < containerCenter - 15) {
                    return { direction: false, source: 'container_centerline', confidence: 'high' };
                }
                if (bubbleCenter > containerCenter + 15) {
                    return { direction: true, source: 'container_centerline', confidence: 'high' };
                }
            }

            const geom = classifier({
                containerRect: cRect,
                bubbleRect: bRect,
                tolerancePx: 12
            });

            return geom;
        } catch (error) {
            console.warn('[PageContent] Direction geometry unavailable:', error.message);
            return { direction: null, source: 'unknown', confidence: 'unknown' };
        }
    }

    // Assigns every currently-mounted message a monotonic synthetic timestamp
    // consistent with its DOM position, using previously-assigned values as fixed
    // anchors so already-sent messages never change order. New ids slot in via
    // interpolation between their nearest known neighbors (or extrapolate past the
    // oldest/newest known anchor for scroll-back history / brand new arrivals).
    function assignOrderedTimestamps(orderedIds) {
        let lastKnownIdx = -1;
        let lastKnownTs = null;

        for (let i = 0; i < orderedIds.length; i++) {
            const id = orderedIds[i];
            if (!id) continue;
            if (knownMessageTimestamps.has(id)) {
                lastKnownIdx = i;
                lastKnownTs = knownMessageTimestamps.get(id);
                continue;
            }

            let nextKnownIdx = -1;
            let nextKnownTs = null;
            for (let j = i + 1; j < orderedIds.length; j++) {
                if (orderedIds[j] && knownMessageTimestamps.has(orderedIds[j])) {
                    nextKnownIdx = j;
                    nextKnownTs = knownMessageTimestamps.get(orderedIds[j]);
                    break;
                }
            }

            let assigned;
            if (lastKnownTs !== null && nextKnownTs !== null && nextKnownTs > lastKnownTs) {
                const span = nextKnownIdx - lastKnownIdx;
                const pos = i - lastKnownIdx;
                assigned = Math.round(lastKnownTs + (nextKnownTs - lastKnownTs) * (pos / span));
                if (assigned <= lastKnownTs) assigned = lastKnownTs + 1;
                if (assigned >= nextKnownTs) assigned = nextKnownTs - 1;
            } else if (lastKnownTs !== null) {
                assigned = lastKnownTs + ORDER_GAP_MS * (i - lastKnownIdx);
                // Spec 047: lastKnownTs can be a stale anchor left over from
                // hours ago (e.g. reopening a thread after a long gap, or the
                // async backend re-seed on thread switch racing this scan) -
                // extrapolating forward from it unbounded stamps a message
                // captured NOW with a synthetic timestamp hours in the past,
                // scrambling display order against messages from the
                // intervening time that DID get a fresh anchor. Live evidence
                // (2026-08-19): a message captured at 09:33 was assigned
                // 04:41 this way. There's no nextKnownTs bounding this from
                // above, so nothing else will catch the drift - re-anchor to
                // now instead, same as the no-anchors-at-all fallback below.
                if (Date.now() - assigned > STALE_ANCHOR_MS) {
                    assigned = Date.now() - ORDER_GAP_MS * (orderedIds.length - i);
                }
            } else if (nextKnownTs !== null) {
                assigned = nextKnownTs - ORDER_GAP_MS * (nextKnownIdx - i);
            } else {
                // No anchors anywhere in the currently-mounted list yet (fresh session).
                assigned = Date.now() - ORDER_GAP_MS * (orderedIds.length - i);
            }

            knownMessageTimestamps.set(id, assigned);
            // This new id becomes an anchor for the rest of this pass, so a long
            // run of consecutive unknowns still spaces out monotonically.
            lastKnownIdx = i;
            lastKnownTs = assigned;
        }

        if (knownMessageTimestamps.size > MAX_KNOWN_TIMESTAMPS) knownMessageTimestamps.clear();
    }

    let threadSM = null;
    let lastSyncedOldestMessageId = null;
    let lastSyncedMountedSignature = '';

    function getOrInitStateMachine(threadId) {
        if (!threadId) return null;
        if (!threadSM || threadSM.threadId !== threadId) {
            const SMClass = (typeof ThreadScanStateMachine !== 'undefined' ? ThreadScanStateMachine : null)
                || (typeof window !== 'undefined' ? window.ThreadScanStateMachine : null);
            if (SMClass) {
                threadSM = new SMClass(threadId);
                lastSyncedOldestMessageId = null;
                lastSyncedMountedSignature = '';
            }
        }
        return threadSM;
    }

    function findDateSeparatorsInContainer(container) {
        if (!container) return [];
        const sepParser = (typeof FbPageTimestampParser !== 'undefined' ? FbPageTimestampParser.parseDateSeparator : null)
            || (typeof window !== 'undefined' && window.FbPageTimestampParser ? window.FbPageTimestampParser.parseDateSeparator : null);
        if (typeof sepParser !== 'function') return [];

        const candidates = container.querySelectorAll('div, span, p');
        const separators = [];

        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el.matches('[data-message-id]') || el.querySelector('[data-message-id]')) continue;
            if (el.children.length > 2) continue;
            if (el.closest && el.closest('video, [role="region"], [aria-label*="video" i], [aria-label*="player" i], [data-surface*="video"]')) continue;

            const text = (el.textContent || '').trim();
            if (!text || text.length > 50) continue;
            if (/^\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}$/.test(text) || /^0:\d{2}$/.test(text)) continue;

            const isSepFormat = /^\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?$/i.test(text) ||
                                /^\d{1,2}:\d{2}\s+\d{1,2}\s+Tháng\s+\d{1,2},?\s+\d{4}$/i.test(text) ||
                                /^\d{1,2}\s+Tháng\s+\d{1,2}(?:,?\s*\d{4})?$/i.test(text) ||
                                /^(?:Thứ (?:Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|Hôm nay|Hôm qua|Today|Yesterday)$/i.test(text) ||
                                /^(?:T[2-7]|CN)$/i.test(text);

            if (isSepFormat) {
                const isParentAlreadyAdded = separators.some(s => s.element.contains(el) || el.contains(s.element));
                if (isParentAlreadyAdded) continue;

                const parsed = sepParser(text, null);
                if (parsed && parsed.timestamp_ms > 0) {
                    separators.push({
                        element: el,
                        text: text,
                        timestamp_ms: parsed.timestamp_ms
                    });
                }
            }
        }
        return separators;
    }

    function collectMountedBatchMessages(container) {
        if (!container) return [];
        const parser = (typeof FbPageTimestampParser !== 'undefined' ? FbPageTimestampParser.parsePageTimestamp : null)
            || (typeof window !== 'undefined' && window.FbPageTimestampParser ? window.FbPageTimestampParser.parsePageTimestamp : null);

        const separators = findDateSeparatorsInContainer(container);
        const currentThread = resolveCurrentThreadId();

        const messageEls = Array.from(container.querySelectorAll('[data-message-id]'));
        const likeCandidates = Array.from(container.querySelectorAll('svg, [role="img"], img[alt="👍"], img[alt*="thích" i], img[alt*="like" i]'))
            .filter(cand => {
                if (cand.closest('[aria-label*="tùy chọn" i], [aria-label*="bày tỏ" i], [aria-label*="chuyển tiếp" i], [aria-label*="trả lời" i], button[aria-label*="menu" i], [data-surface*="composer"], form, footer')) {
                    return false;
                }
                return isLikeElementOrWrapper(cand);
            });

        // Xây dựng danh sách các đơn vị tin nhắn (rawUnits)
        const rawUnits = [];
        const handledLikeNodes = new Set();

        // 1. Duyệt qua các messageEls có sẵn
        for (const el of messageEls) {
            const fbMessageId = el.getAttribute('data-message-id');
            if (!fbMessageId) continue;

            const likesInside = likeCandidates.filter(cand => el.contains(cand));
            if (likesInside.length === 0) {
                // Tin nhắn bình thường (text hoặc media)
                const resolved = resolveMessageContent(el);
                if (resolved.kind !== 'none') {
                    rawUnits.push({
                        element: el,
                        fbMessageId: fbMessageId,
                        resolved: resolved,
                        isStandaloneLike: false
                    });
                }
            } else {
                // Có nút Like bên trong messageEl
                const rawText = (el.innerText || el.textContent || '').trim();
                const hasSubstantialText = rawText.length > 0 && rawText !== '👍' && !/^(?:thích|like)$/i.test(rawText);
                if (hasSubstantialText) {
                    rawUnits.push({
                        element: el,
                        fbMessageId: fbMessageId,
                        resolved: { kind: 'text', text: rawText },
                        isStandaloneLike: false
                    });
                }
                for (let li = 0; li < likesInside.length; li++) {
                    const likeNode = likesInside[li];
                    handledLikeNodes.add(likeNode);
                    rawUnits.push({
                        element: likeNode,
                        fbMessageId: li === 0 && !hasSubstantialText ? fbMessageId : null,
                        resolved: { kind: 'text', text: '👍' },
                        isStandaloneLike: true
                    });
                }
            }
        }

        // 2. Thêm các likeCandidates độc lập nằm ngoài bất kỳ messageEl nào
        for (const cand of likeCandidates) {
            if (handledLikeNodes.has(cand)) continue;
            handledLikeNodes.add(cand);
            // Standalone customer like: không kế thừa ID của container cha tránh đè lên message khác
            const ownMsgId = cand.getAttribute('data-message-id') || (cand.parentElement && cand.parentElement.getAttribute('data-message-id'));
            rawUnits.push({
                element: cand,
                fbMessageId: ownMsgId || null,
                resolved: { kind: 'text', text: '👍' },
                isStandaloneLike: true
            });
        }

        // 3. Sắp xếp rawUnits theo ĐÚNG THỨ TỰ XUẤT HIỆN TỰ NHIÊN TRONG CÂY DOM (Top-to-Bottom)
        rawUnits.sort((a, b) => {
            if (a.element === b.element) return 0;
            const pos = a.element.compareDocumentPosition(b.element);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        // 4. Xây dựng danh sách batch kết quả theo thứ tự DOM chuẩn
        const list = [];
        let lastKnownMsgId = null;
        let likeCounterAfterAnchor = 0;
        for (let i = 0; i < rawUnits.length; i++) {
            const unit = rawUnits[i];
            let fbMessageId = unit.fbMessageId;
            if (fbMessageId && !unit.isStandaloneLike) {
                lastKnownMsgId = fbMessageId;
                likeCounterAfterAnchor = 0;
            } else if (unit.isStandaloneLike) {
                if (!fbMessageId || list.some(item => item.fb_message_id === fbMessageId) || !fbMessageId.startsWith('mid.')) {
                    likeCounterAfterAnchor++;
                    const anchorKey = lastKnownMsgId ? `after_${lastKnownMsgId}` : 'prefix';
                    fbMessageId = `page_like_${currentThread}_${anchorKey}_${likeCounterAfterAnchor}`;
                } else {
                    lastKnownMsgId = fbMessageId;
                    likeCounterAfterAnchor = 0;
                }
            } else if (!fbMessageId || list.some(item => item.fb_message_id === fbMessageId)) {
                likeCounterAfterAnchor++;
                const anchorKey = lastKnownMsgId ? `after_${lastKnownMsgId}` : 'prefix';
                fbMessageId = `page_like_${currentThread}_${anchorKey}_${likeCounterAfterAnchor}`;
            }

            const targetMeasure = unit.element;
            const dirEvidence = getDirectionEvidence(targetMeasure, container);
            const rawDir = dirEvidence.direction;
            const isOutgoing = (rawDir === true || rawDir === 1)
                ? true
                : ((rawDir === false || rawDir === 0) ? false : null);

            let parsedTs = 0;
            let tsSource = 'unknown';

            // A. Timestamp trên bubble nếu có parser
            if (typeof parser === 'function' && !unit.isStandaloneLike) {
                const p = parser(unit.element);
                if (p && p.timestamp_ms > 0) {
                    parsedTs = p.timestamp_ms;
                    tsSource = p.timestamp_source;
                }
            }

            // B. Date Separator xuất hiện trước phần tử này
            if (parsedTs === 0 && separators.length > 0) {
                let matchingSep = null;
                for (let sIdx = 0; sIdx < separators.length; sIdx++) {
                    const sep = separators[sIdx];
                    if (sep.element.compareDocumentPosition(unit.element) & Node.DOCUMENT_POSITION_FOLLOWING) {
                        matchingSep = sep;
                    } else {
                        break;
                    }
                }
                if (matchingSep) {
                    parsedTs = matchingSep.timestamp_ms + (i * 10);
                    tsSource = 'separator_date_clock';
                }
            }

            // C. Fallback knownMessageTimestamps
            if (parsedTs === 0 && knownMessageTimestamps.has(fbMessageId)) {
                parsedTs = knownMessageTimestamps.get(fbMessageId);
                tsSource = 'dom_order';
            }

            if (parsedTs > 0 && !knownMessageTimestamps.has(fbMessageId)) {
                knownMessageTimestamps.set(fbMessageId, parsedTs);
            }

            const isMedia = unit.resolved.kind === 'media';
            const text = isMedia ? (unit.resolved.caption || '') : unit.resolved.text;
            let effectiveMediaUrl = isMedia ? unit.resolved.mediaUrl : null;
            if (isMedia && unit.resolved.mediaType === 'video' && !effectiveMediaUrl) {
                const vidCache = (typeof FbPageVideoDetector !== 'undefined' && FbPageVideoDetector.getVideoCache ? FbPageVideoDetector.getVideoCache() : null) ||
                    (typeof window !== 'undefined' && window.FbPageVideoDetector?.getVideoCache ? window.FbPageVideoDetector.getVideoCache() : null);
                const cached = vidCache?.get(fbMessageId);
                const domAttr = unit.element?.getAttribute?.('data-crm-video-url') ||
                    unit.element?.querySelector?.('[data-crm-video-url]')?.getAttribute?.('data-crm-video-url');
                effectiveMediaUrl = domAttr || cached?.videoUrl || null;
                if (!effectiveMediaUrl && typeof FbPageVideoDetector !== 'undefined' && typeof FbPageVideoDetector.requestVideoResolutionFromMain === 'function') {
                    FbPageVideoDetector.requestVideoResolutionFromMain(fbMessageId);
                }
            }

            list.push({
                fb_message_id: fbMessageId,
                content: text,
                media_type: isMedia ? (unit.resolved.mediaType || 'image') : 'text',
                media_url: effectiveMediaUrl,
                is_outgoing: isOutgoing,
                direction_status: isOutgoing === null ? 'pending' : 'confirmed',
                direction_confidence: isOutgoing === null ? 'unknown' : dirEvidence.confidence,
                dom_order: i,
                timestamp_ms: parsedTs,
                timestamp_source: tsSource
            });
        }

        // 5. Nội suy đơn điệu (Monotonic Interpolation) để các tin nhắn Like xen kẽ có timestamp tăng dần chuẩn xác
        const orderedIds = list.map(item => item.fb_message_id);
        assignOrderedTimestamps(orderedIds);
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (knownMessageTimestamps.has(item.fb_message_id)) {
                item.timestamp_ms = knownMessageTimestamps.get(item.fb_message_id);
            }
        }

        return list;
    }

    function scrollBackForHistory() {
        const threadId = resolveCurrentThreadId();
        if (!threadId) return;
        if (threadId !== lastScrollThreadId) {
            lastScrollThreadId = threadId;
            scrollAttemptsForThread = 0;
        }
        if (scrollAttemptsForThread >= MAX_SCROLL_ATTEMPTS_PER_THREAD) return;

        const container = findScrollableMessageContainer();
        if (!container) return;

        if (container.scrollTop > 0) {
            container.scrollTop = Math.max(0, container.scrollTop - container.clientHeight);
            scrollAttemptsForThread++;
            console.log(`[PageContent] Scroll-back for history: attempt ${scrollAttemptsForThread}/${MAX_SCROLL_ATTEMPTS_PER_THREAD}, thread=${threadId}`);
        } else {
            // Reached the top of whatever is currently mounted: either genuinely at
            // the start of history, or Business Suite needs a "load more" click we
            // don't perform yet. Stop trying for this thread either way.
            scrollAttemptsForThread = MAX_SCROLL_ATTEMPTS_PER_THREAD;
        }
    }

    function scanForMessages() {
        if (isScanning) return;
        isScanning = true;
        currentTick++;
        try {
            // Early thread resolution to reset cache if needed, and try to find contact info
            const currentThreadId = resolveCurrentThreadId();
            if (!currentThreadId) return; // Ngắt quét an toàn khi không xác định được thread ID

            const threadJustChanged = currentThreadId !== lastKnownThreadId;
            isLikelyBacklog(currentThreadId); // this updates lastKnownThreadId and resets cache if thread changed
            if (threadJustChanged) {
                lastThreadSwitchAt = Date.now();
                currentContactName = null;
                currentAvatarUrl = null;
                currentAvatarSourceTier = 0;
                lastReportedContactName = null;
                lastReportedAvatarUrl = null;
                lastSyncedMountedSignature = '';
                seedTimestampAnchorsForThread(currentThreadId);
            }

            // Resolved once per tick and threaded through to both passes below
            // (and into processPotentialMessage/walkBubbleAncestors), so every
            // containment check this tick uses the exact same container node.
            const messageListContainer = findMessageListContainer();

            const isInvalidName = (n) => {
                if (globalThis.FbCrmTextFilter?.isInvalidContactName) {
                    return globalThis.FbCrmTextFilter.isInvalidContactName(n);
                }
                if (!n || typeof n !== 'string') return true;
                const str = n.trim();
                return str.length < 2 || str.toLowerCase().includes('đã xem');
            };

            const cleanName = (n) => {
                if (globalThis.FbCrmTextFilter?.cleanContactName) {
                    return globalThis.FbCrmTextFilter.cleanContactName(n);
                }
                return isInvalidName(n) ? 'Khách hàng' : n.trim();
            };

            const urlParams = new URLSearchParams(window.location.search);
            const assetId = urlParams.get('asset_id') || urlParams.get('mailbox_id') || null;

            // 1. Trích xuất Tên khách hàng (currentContactName)
            if (!currentContactName || isInvalidName(currentContactName)) {
                // A. Ưu tiên tìm chính xác dòng của threadId này trong Sidebar
                if (currentThreadId) {
                    const rowForThread = document.querySelector(`[role="navigation"] a[href*="${currentThreadId}"], [data-surface*="thread_list"] a[href*="${currentThreadId}"], a[href*="selected_item_id=${currentThreadId}"]`)?.closest('[role="row"], [role="listitem"], [data-surface*="thread_row"]');
                    if (rowForThread) {
                        const titleEl = rowForThread.querySelector('[data-surface*="thread_title"], h2, h3, h4, [role="heading"], [dir="auto"], strong, b');
                        const rowTxt = (titleEl?.textContent || '').trim().split('\n')[0].trim();
                        if (rowTxt && !isInvalidName(rowTxt) && rowTxt.length >= 2 && rowTxt.length <= 80 && !/^\d+$/.test(rowTxt)) {
                            currentContactName = cleanName(rowTxt);
                        }
                    }
                }

                // B. Nếu chưa có và thời gian chuyển thread đã qua grace period (1.5s), mới lấy từ hàng active hoặc header
                if ((!currentContactName || isInvalidName(currentContactName)) && (Date.now() - lastThreadSwitchAt >= 1500)) {
                    const activeRow = document.querySelector('[role="navigation"] [aria-selected="true"], [role="gridcell"] [aria-selected="true"], [data-surface*="thread_list"] [aria-selected="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]');
                    if (activeRow) {
                        const activeTitleEl = activeRow.querySelector('[data-surface*="thread_title"], h2, h3, h4, [role="heading"], [dir="auto"], strong, b');
                        const activeTxt = (activeTitleEl?.textContent || activeRow.textContent || '').trim().split('\n')[0].trim();
                        if (activeTxt && !isInvalidName(activeTxt) && activeTxt.length >= 2 && activeTxt.length <= 80 && !/^\d+$/.test(activeTxt)) {
                            currentContactName = cleanName(activeTxt);
                        }
                    }

                    if (!currentContactName || isInvalidName(currentContactName)) {
                        const headerEls = document.querySelectorAll('[role="main"] header [dir="auto"], [role="main"] header h2, header [role="heading"], [data-surface*="contact_name"], [data-surface*="profile_header"]');
                        for (const el of headerEls) {
                            const txt = (el.textContent || '').trim().split('\n')[0].trim();
                            if (txt && !isInvalidName(txt) && txt.length >= 2 && txt.length <= 80 && !/^\d+$/.test(txt)) {
                                currentContactName = cleanName(txt);
                                break;
                            }
                        }
                    }
                }
            }

            // Compute mounted DOM signature for messageListContainer
            let currentMountedSignature = '';
            if (messageListContainer) {
                const mountedMsgEls = messageListContainer.querySelectorAll('[data-message-id]');
                const mountedLikes = messageListContainer.querySelectorAll('svg, [role="img"], img[alt="👍"], img[alt*="thích" i], img[alt*="like" i]');
                const mountedVideos = messageListContainer.querySelectorAll('video');
                let videoSrcSignature = '';
                for (let vi = 0; vi < mountedVideos.length; vi++) {
                    const vel = mountedVideos[vi];
                    const vSrc = vel.currentSrc || vel.src || vel.getAttribute('src') || vel.getAttribute('data-crm-video-url') || '';
                    if (vSrc) {
                        videoSrcSignature += `_v${vi}:${vSrc.substring(0, 40)}`;
                    }
                }
                const firstMid = mountedMsgEls.length > 0 ? (mountedMsgEls[0].getAttribute('data-message-id') || '') : '';
                const lastMid = mountedMsgEls.length > 0 ? (mountedMsgEls[mountedMsgEls.length - 1].getAttribute('data-message-id') || '') : '';
                currentMountedSignature = `${currentThreadId}_${mountedMsgEls.length}_${mountedLikes.length}_${firstMid}_${lastMid}${videoSrcSignature}`;
            }

            // Kích hoạt Baselining theo State Machine khi thread mới mở và DOM đã mount tin nhắn
            // HOẶC khi DOM thay đổi / mount thêm tin nhắn & Like mới trong lúc State Machine đã READY
            const sm = getOrInitStateMachine(currentThreadId);
            if (sm && sm.getState() === 'UNINITIALIZED' && messageListContainer) {
                const batchMessages = collectMountedBatchMessages(messageListContainer);
                // Chỉ kích hoạt baselining khi DOM đã thực sự render ít nhất 1 tin nhắn (tránh gửi batch rỗng count=0)
                if (batchMessages.length > 0) {
                    const meta = sm.startBaselining();
                    lastSyncedOldestMessageId = batchMessages[0].fb_message_id;
                    lastSyncedMountedSignature = currentMountedSignature;
                    chrome.runtime.sendMessage({
                        type: 'PAGE_THREAD_MESSAGES_SYNCED_V1',
                        data: {
                            thread_id: currentThreadId,
                            account_id: null,
                            page_id: assetId,
                            session_epoch: meta.session_epoch,
                            generation: meta.generation,
                            scan_id: meta.scan_id,
                            batch_sequence: meta.generation,
                            mode: 'page_initial',
                            contact_name: currentContactName || null,
                            messages: batchMessages
                        }
                    });
                }
            } else if (sm && sm.getState() === 'READY' && !crawlInProgress && messageListContainer && currentMountedSignature && currentMountedSignature !== lastSyncedMountedSignature) {
                const batchMessages = collectMountedBatchMessages(messageListContainer);
                if (batchMessages.length > 0) {
                    const meta = sm.startBaselining();
                    lastSyncedOldestMessageId = batchMessages[0].fb_message_id;
                    lastSyncedMountedSignature = currentMountedSignature;
                    chrome.runtime.sendMessage({
                        type: 'PAGE_THREAD_MESSAGES_SYNCED_V1',
                        data: {
                            thread_id: currentThreadId,
                            account_id: null,
                            page_id: assetId,
                            session_epoch: meta.session_epoch,
                            generation: meta.generation,
                            scan_id: meta.scan_id,
                            batch_sequence: meta.generation,
                            mode: 'page_mounted_update',
                            contact_name: currentContactName || null,
                            messages: batchMessages
                        }
                    });
                }
            }

            // 2. Trích xuất Avatar URL (currentAvatarUrl) đa tầng:
            // Tier 2: Cột chi tiết khách hàng bên phải (Right Details Pane) - chứa ảnh Anime thật
            // Tier 1: Header cuộc trò chuyện hoặc danh sách hội thoại bên trái (thường là silhouette placeholder)
            let candidateAvatarUrl = null;
            let candidateTier = 0;

            // Tier 2: Quét cột bên phải (Right Details / Customer Info Pane)
            const rightPane = document.querySelector('[role="complementary"], [data-surface*="details"], [data-surface*="contact"], [aria-label*="Chi tiết" i], [aria-label*="Details" i]');
            if (rightPane) {
                const rightImgs = Array.from(rightPane.querySelectorAll('img[src*="fbcdn.net"], img[src*="scontent"], img.img'));
                for (const img of rightImgs) {
                    const src = img.getAttribute('src');
                    if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('static.xx.fbcdn')) {
                        if ((img.naturalWidth && img.naturalWidth <= 24) || (img.width > 0 && img.width <= 24)) continue;
                        candidateAvatarUrl = src;
                        candidateTier = 2;
                        break;
                    }
                }
            }

            // Hoặc vùng chứa liên kết trang cá nhân Facebook (nếu rightPane chưa có role riêng)
            if (!candidateAvatarUrl) {
                const profileLink = document.querySelector('a[href*="facebook.com/profile"], a[href*="facebook.com/"][role="link"], a:has(> [aria-label*="Trang cá nhân" i])');
                if (profileLink) {
                    const profileContainer = profileLink.closest('div, section');
                    if (profileContainer) {
                        const img = profileContainer.querySelector('img[src*="fbcdn.net"], img[src*="scontent"], img.img');
                        if (img) {
                            const src = img.getAttribute('src');
                            if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('static.xx.fbcdn')) {
                                candidateAvatarUrl = src;
                                candidateTier = 2;
                            }
                        }
                    }
                }
            }

            // Tier 1: Nếu chưa có avatar hoặc đang ở Tier 1, quét Header và Sidebar bên trái
            if (!candidateAvatarUrl && currentAvatarSourceTier < 2) {
                const headerEl = document.querySelector('[role="main"] header');
                const activeRow = document.querySelector('[role="navigation"] [aria-selected="true"], [role="gridcell"] [aria-selected="true"], [data-surface*="thread_list"] [aria-selected="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]');
                const fallbackScopes = [headerEl, activeRow].filter(Boolean);
                for (const scope of fallbackScopes) {
                    const img = scope.querySelector('img[src*="fbcdn.net"], img[src*="scontent"], img.img');
                    if (img) {
                        const src = img.getAttribute('src');
                        if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('static.xx.fbcdn')) {
                            candidateAvatarUrl = src;
                            candidateTier = 1;
                            break;
                        }
                    }
                }
            }

            // Nâng cấp avatar nếu tìm thấy nguồn cấp cao hơn (Tier 2 > Tier 1) hoặc avatar mới
            if (candidateAvatarUrl && (candidateTier > currentAvatarSourceTier || (!currentAvatarUrl && candidateTier >= currentAvatarSourceTier) || (candidateTier === currentAvatarSourceTier && candidateAvatarUrl !== currentAvatarUrl))) {
                currentAvatarUrl = candidateAvatarUrl;
                currentAvatarSourceTier = candidateTier;
            }

            // Phát hiện metadata mới -> gửi ngay sang background (chỉ gửi khi có thay đổi, khớp ID và qua grace period 1.5s)
            if (currentThreadId && ((currentContactName && !isInvalidName(currentContactName)) || currentAvatarUrl)) {
                const activeIdNow = resolveCurrentThreadId();
                if (String(activeIdNow) === String(currentThreadId) && (Date.now() - lastThreadSwitchAt >= 1500)) {
                    if (lastReportedContactName !== currentContactName || lastReportedAvatarUrl !== currentAvatarUrl) {
                        lastReportedContactName = currentContactName;
                        lastReportedAvatarUrl = currentAvatarUrl;
                        chrome.runtime.sendMessage({
                            type: 'UPDATE_THREAD_METADATA',
                            data: {
                                thread_id: currentThreadId,
                                contact_name: currentContactName,
                                avatar_url: currentAvatarUrl,
                                page_id: assetId
                            }
                        });
                    }
                }
            }

            const messageEls = Array.from(document.querySelectorAll('[data-message-id]'));

            // Trích xuất Date Separators để seed anchor thật cho knownMessageTimestamps
            if (messageListContainer) {
                const separators = findDateSeparatorsInContainer(messageListContainer);
                if (separators.length > 0) {
                    for (let i = 0; i < messageEls.length; i++) {
                        const mEl = messageEls[i];
                        const mId = mEl.getAttribute('data-message-id');
                        if (!mId) continue;
                        let matchingSep = null;
                        for (let sIdx = 0; sIdx < separators.length; sIdx++) {
                            const sep = separators[sIdx];
                            if (sep.element.compareDocumentPosition(mEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
                                matchingSep = sep;
                            } else {
                                break;
                            }
                        }
                        if (matchingSep) {
                            knownMessageTimestamps.set(mId, matchingSep.timestamp_ms + (i * 10));
                        }
                    }
                }
            }

            const orderedIds = messageEls.map(n => n.getAttribute('data-message-id'));
            assignOrderedTimestamps(orderedIds);

            // Only the first text-node fragment of a given message wrapper is
            // processed per tick; the rest of that wrapper's fragments (e.g. emoji
            // splitting a bubble into multiple text nodes) are folded into the full
            // wrapper text instead of being sent/dropped as separate fragments.
            const processedWrappersThisTick = new Set();

            // Feature 023 (FR-002): without a resolved message-list container
            // there is no safe scope to test containment against - skip the
            // whole-document text scan for this tick entirely instead of
            // falling back to unscoped scanning (which is how non-chat UI text
            // used to leak in as fake messages).
            if (messageListContainer && messageListContainer !== document.body) {
                const walker = document.createTreeWalker(messageListContainer, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while (node = walker.nextNode()) {
                    const text = node.nodeValue.trim();
                    if (text.length > 0) {
                        const el = node.parentElement;
                        if (el && !isExcludedElement(el) && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'A' && el.tagName !== 'BUTTON' && !el.closest('a') && !el.closest('button')) {
                            processPotentialMessage(el, text, processedWrappersThisTick, messageListContainer);
                        }
                    }
                }
            }

            // Feature 018: a bubble whose entire content is non-text (a
            // picker emoji, a sticker, or a photo) has zero text nodes inside
            // it, so the TreeWalker above never visits it and
            // processPotentialMessage is never called for it. This second
            // pass catches exactly those wrappers - anything already handled
            // above via a real text node is skipped via the shared
            // processedWrappersThisTick set.
            for (const wrapperEl of messageEls) {
                if (processedWrappersThisTick.has(wrapperEl)) continue;
                processedWrappersThisTick.add(wrapperEl);
                const resolvedContent = resolveMessageContent(wrapperEl);
                if (resolvedContent.kind === 'none') continue;
                const fbMessageId = wrapperEl.getAttribute('data-message-id');
                const { isInsideMessageBubble, inChatContainer } = walkBubbleAncestors(wrapperEl, messageListContainer);
                forwardResolvedMessage(wrapperEl, wrapperEl, fbMessageId, isInsideMessageBubble, inChatContainer, resolvedContent, messageListContainer);
            }

            // Pass 2b (Direct Thumbs Up / Like Scanner):
            // Lưu ý: Toàn bộ nút Like đã mount trong messageListContainer đều được xử lý và đồng bộ
            // bảo toàn 100% thứ tự DOM qua hàm collectMountedBatchMessages (PAGE_THREAD_MESSAGES_SYNCED_V1).
            // Không bắn lẻ qua forwardResolvedMessage (NEW_PAGE_MESSAGE_FROM_DOM) để tránh việc backend
            // hiểu lầm là tin nhắn mới phát sinh và gán sequence_order = MAX + 1 đẩy xuống đáy.

            // Pass 3 (Call Log): Quét span[dir="auto"] TRONG KHUNG CHAT (messageListContainer)
            var callSpans = messageListContainer ? messageListContainer.querySelectorAll('span[dir="auto"]') : [];
            for (var ci = 0; ci < callSpans.length; ci++) {
                var spanEl = callSpans[ci];
                var spanText = (spanEl.textContent || '').trim();
                var lowerSpan = spanText.toLowerCase();
                if (!spanText) continue;
                if (!lowerSpan.includes('cuộc gọi') && !lowerSpan.includes('nhỡ') && !lowerSpan.includes('bỏ lỡ')) continue;

                var { isInsideMessageBubble, inChatContainer } = walkBubbleAncestors(spanEl, messageListContainer);
                if (!inChatContainer || !isInsideMessageBubble) continue;

                var threadId = resolveCurrentThreadId();
                if (!threadId || threadId === 'UNKNOWN_THREAD') continue;
                var callId = 'call_' + threadId + '_' + spanText.replace(/\s+/g, '_');

                if (processedHashes.has(callId)) continue;
                processedHashes.add(callId);

                console.log('[CALL_SCANNER] Phat hien cuoc goi: "' + spanText + '" | ID: ' + callId);

                chrome.runtime.sendMessage({
                    type: 'NEW_PAGE_MESSAGE_FROM_DOM',
                    data: {
                        thread_id: threadId,
                        fb_message_id: callId,
                        content: spanText,
                        is_outgoing: false,
                        direction_status: 'confirmed',
                        direction_source: 'call_log_pass',
                        direction_confidence: 'high',
                        source: 'page_dom_observer',
                        timestamp_ms: Date.now(),
                        timestamp_source: 'realtime_fallback',
                        contact_name: currentContactName || null
                    }
                });
            }

        } finally {
            isScanning = false;
        }
    }

    // Single ancestor walk used by processPotentialMessage for two purposes at
    // once: (a) the pending-id tracking below needs a stable-ish reference to
    // "the bubble" for a message that has no data-message-id yet, using the
    // same dir="auto" ancestor the structural filter already looks for; (b)
    // the existing inChatContainer/isInsideMessageBubble structural filter.
    // Computing both in one pass avoids walking the same ancestor chain twice.
    //
    // Feature 023: inChatContainer used to be decided by this same upward walk
    // independently accepting the first role="main"/role="grid" ancestor it
    // found - but Business Suite reuses those roles for unrelated widgets
    // (confirmed live: the account/page switcher panel can share the exact
    // same broad region as the real message list, whose own aria-label admits
    // it holds "tin nhắn, gợi ý và chỉ báo đăng nhập" - not messages only).
    // inChatContainer is now a direct containment test against the specific
    // container findMessageListContainer() resolved from a real
    // [data-message-id] anchor, passed in by the caller, instead of a second
    // independent guess.
    function walkBubbleAncestors(element, messageListContainer) {
        let bubbleAncestor = null;
        let isInsideMessageBubble = false;
        let currNode = element;

        while (currNode && currNode !== document.body) {
            if (currNode.getAttribute && currNode.getAttribute('dir') === 'auto') {
                isInsideMessageBubble = true;
                if (!bubbleAncestor) bubbleAncestor = currNode;
            }
            currNode = currNode.parentElement;
        }

        const inChatContainer = !!(messageListContainer && messageListContainer.contains(element));

        return { bubbleAncestor, isInsideMessageBubble, inChatContainer };
    }

    // Feature 018: resolves what a [data-message-id] wrapper actually
    // contains when it has no (or no useful) text node for the TreeWalker to
    // find - a picker emoji, a sticker, or a photo. Priority: real text >
    // picker-emoji alt > media (img src or CSS background-image). Verified
    // live against three real samples in the same test thread:
    //   - emoji:  <img alt="💩" src=".../emoji.php/v9/.../1f4a9.png">
    //   - photo/img-sticker (DOM-identical, can't be told apart): <img alt
    //     class="img" src="https://scontent...fbcdn.net/v/t1.15752-9/...">
    //   - CSS-background sticker (no <img> at all): <div role="img"
    //     aria-label="Joyful Plans, characters leaning in and rubbing hands
    //     together gleefully sticker" style="background-image:url('https://
    //     scontent...fbcdn.net/v/t39.1997-6/....webp?...')">
    // The emoji/media split on <img> is by alt shape, not by hostname: an
    // empty alt means "no text to show" (media); a short, letter-free alt is
    // a real Unicode character (emoji), as opposed to the multi-word English
    // caption sentences Facebook auto-generates for aria-label on the
    // CSS-background case, which are never mistaken for emoji text since
    // aria-label is only read on the role="img" div path below.
    function isLikeElementOrWrapper(node, rawText) {
        if (!node) return false;

        // 1. Kiểm tra text trực tiếp
        const trimmed = (rawText || '').trim();
        if (trimmed === '👍') return true;
        if (/^(?:thích|like|biểu tượng thích|biểu tượng cảm xúc thích|gửi biểu tượng thích|thumbs up)$/i.test(trimmed)) {
            return true;
        }

        // 2. Kiểm tra aria-label trên chính wrapper hoặc phần tử gốc
        const wrapperAria = (node.getAttribute?.('aria-label') || '').trim().toLowerCase();
        if (wrapperAria) {
            if (wrapperAria === 'thích' || wrapperAria === 'like' || wrapperAria === 'thumbs up' || wrapperAria === 'biểu tượng thích' || wrapperAria === 'gửi biểu tượng thích') {
                return true;
            }
            if (/^(?:tin nhắn.*:)?\s*(?:thích|like|biểu tượng thích|thumbs up|nhãn dán thích)$/i.test(wrapperAria)) {
                return true;
            }
            if (wrapperAria.includes('biểu tượng thích') || wrapperAria.includes('thumbs up') || wrapperAria.includes('nhãn dán thích')) {
                return true;
            }
        }

        // 3. QuerySelector các phần tử mang nhãn Like trong cây DOM của bubble
        const likeSelectorEl = node.querySelector?.(
            '[aria-label*="biểu tượng thích" i], [aria-label*="thumbs up" i], [aria-label*="nhãn dán thích" i], ' +
            '[aria-label="Thích" i], [aria-label="Like" i], [aria-label="thích" i], [aria-label="like" i], ' +
            'svg[aria-label*="Thích" i], svg[aria-label*="Like" i], ' +
            '[role="img"][aria-label*="Thích" i], [role="img"][aria-label*="Like" i]'
        );
        if (node.matches?.(
            '[aria-label*="biểu tượng thích" i], [aria-label*="thumbs up" i], [aria-label*="nhãn dán thích" i], ' +
            '[aria-label="Thích" i], [aria-label="Like" i], [aria-label="thích" i], [aria-label="like" i], ' +
            'svg[aria-label*="Thích" i], svg[aria-label*="Like" i], ' +
            '[role="img"][aria-label*="Thích" i], [role="img"][aria-label*="Like" i]'
        )) {
            return true;
        }
        if (likeSelectorEl) {
            return true;
        }

        // 4. Kiểm tra SVG thumbs up trong Meta Business Suite
        const isSvgNode = node.tagName && node.tagName.toLowerCase() === 'svg';
        const svgs = isSvgNode ? [node] : Array.from(node.querySelectorAll?.('svg') || []);
        for (const svg of svgs) {
            // Chỉ loại trừ các nút bấm hành động phụ (bày tỏ, tùy chọn, chuyển tiếp) hoặc composer, không loại trừ role="button" của tin nhắn
            if (svg.closest('[aria-label*="tùy chọn" i], [aria-label*="bày tỏ" i], [aria-label*="chuyển tiếp" i], [aria-label*="trả lời" i], button[aria-label*="menu" i], [data-surface*="composer"], form, footer')) {
                continue;
            }
            const vb = (svg.getAttribute('viewBox') || '').trim();
            const title = (svg.querySelector?.('title')?.textContent || '').trim().toLowerCase();
            if (title === 'thích' || title === 'like' || title.includes('thumbs up') || title.includes('biểu tượng thích')) {
                return true;
            }

            const svgAria = (svg.getAttribute('aria-label') || '').toLowerCase();
            if (svgAria.includes('thích') || svgAria.includes('like') || svgAria.includes('thumbs up')) {
                return true;
            }

            const isStandardLikeVb = vb.includes('16') || vb.includes('20') || vb.includes('24') || vb.includes('28') || vb.includes('32') || vb.includes('36') || vb.includes('40') || vb.includes('48') || vb.includes('64');
            const fill = (svg.getAttribute('fill') || svg.innerHTML || '').toLowerCase();
            const isBlueLikeSvg = fill.includes('0084ff') || fill.includes('0a7cff') || fill.includes('0099ff') || fill.includes('rgb(0, 132, 255)') || fill.includes('rgb(10, 124, 255)') || fill.includes('rgb(0,132,255)') || fill.includes('currentcolor');
            if ((isStandardLikeVb || isBlueLikeSvg) && !svg.closest('[data-testid*="status"]') && !svg.closest('[aria-label*="Đã gửi" i]') && !svg.closest('[aria-label*="Đã chuyển" i]')) {
                return true;
            }
        }

        // 5. Kiểm tra Sticker / Image thumbs up
        const isImgNode = node.tagName && node.tagName.toLowerCase() === 'img';
        const imgs = isImgNode ? [node] : Array.from(node.querySelectorAll?.('img[src]') || []);
        for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            const alt = (img.getAttribute('alt') || '').trim().toLowerCase();

            if (alt === '👍' || alt === 'thích' || alt === 'like' || alt.includes('biểu tượng thích') || alt.includes('thumbs up') || alt.includes('nhãn dán thích')) {
                return true;
            }

            if (src.includes('369239263222822') || src.includes('like_sticker') || src.includes('thumbs-up') || src.includes('thumbsup')) {
                return true;
            }
        }

        // 6. Kiểm tra [role="img"] với CSS background-image
        const isBgNode = node.getAttribute?.('role') === 'img';
        const bgEls = isBgNode ? [node] : Array.from(node.querySelectorAll?.('[role="img"]') || []);
        for (const bgEl of bgEls) {
            const bgAria = (bgEl.getAttribute('aria-label') || '').toLowerCase();
            if (bgAria === 'thích' || bgAria === 'like' || bgAria.includes('biểu tượng thích') || bgAria.includes('thumbs up') || bgAria.includes('nhãn dán thích')) {
                return true;
            }
            const style = bgEl.getAttribute('style') || '';
            if (style.includes('369239263222822') || style.includes('like_sticker')) {
                return true;
            }
        }

        return false;
    }

    function resolveMessageContent(messageIdNode) {
        const rawText = (messageIdNode.innerText || messageIdNode.textContent || '').trim();
        const textFilter = globalThis.FbCrmTextFilter || (typeof window !== 'undefined' && window.FbCrmTextFilter);
        const cleanedText = textFilter && typeof textFilter.cleanMessageText === 'function'
            ? textFilter.cleanMessageText(rawText)
            : rawText;

        // Ưu tiên kiểm tra Nút Thích / Like (Thumbs Up 👍) đầu tiên
        if (isLikeElementOrWrapper(messageIdNode, cleanedText || rawText)) {
            return { kind: 'text', text: '👍' };
        }

        // Call Log Guard: Never treat a call notification wrapper (which may contain avatar/icon <img>) as an image attachment!
        const lowerRawText = rawText.toLowerCase();
        if (rawText && (lowerRawText.includes('cuộc gọi') || lowerRawText.includes('bỏ lỡ') || lowerRawText.includes('đã nhỡ') || lowerRawText.includes('nhỡ'))) {
            return { kind: 'text', text: rawText };
        }

        // Kiểm tra Video bằng pageVideoDetector chuyên biệt cho Page
        const videoDetector = globalThis.FbPageVideoDetector || (typeof window !== 'undefined' && window.FbPageVideoDetector);
        if (videoDetector && typeof videoDetector.detectPageVideo === 'function') {
            const videoResult = videoDetector.detectPageVideo(messageIdNode, cleanedText || rawText);
            if (videoResult && videoResult.isVideo) {
                return {
                    kind: 'media',
                    mediaType: 'video',
                    mediaUrl: videoResult.mediaUrl || null,
                    caption: videoResult.caption || null
                };
            }
        }

        const imgs = messageIdNode.querySelectorAll('img[src]');
        for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (!src || src.includes('/emoji.php') || src.includes('/rsrc.php')) continue;

            const alt = (img.getAttribute('alt') || '').toLowerCase();
            if (alt.includes('ảnh đại diện') || alt.includes('profile picture') || alt.includes('biểu tượng cảm xúc')) continue;

            const isAvatar = img.closest && img.closest('[aria-label*="Ảnh đại diện"], [aria-label*="profile"], [data-surface*="profile"]');
            if (isAvatar) continue;
            if ((img.width > 0 && img.width <= 36) || (img.height > 0 && img.height <= 36)) continue;

            return { kind: 'media', mediaUrl: src, caption: (cleanedText || rawText) || null };
        }

        const bgEls = messageIdNode.querySelectorAll('[role="img"]');
        for (const bgEl of bgEls) {
            const style = bgEl.getAttribute('style') || '';
            const match = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/);
            if (match) {
                const url = match[2];
                if (url && !url.includes('/emoji.php') && !url.includes('/rsrc.php')) {
                    const aria = (bgEl.getAttribute('aria-label') || '').toLowerCase();
                    if (!aria.includes('ảnh đại diện') && !aria.includes('profile picture') && !aria.includes('biểu tượng cảm xúc')) {
                        return { kind: 'media', mediaUrl: url, caption: (cleanedText || rawText) || bgEl.getAttribute('aria-label') || null };
                    }
                }
            }
        }

        // Kiểm tra xem rawText có phải chỉ toàn chuỗi thời gian/hệ thống hay không
        const isMetadataOnly = textFilter && typeof textFilter.isSystemOrMetadataText === 'function'
            ? textFilter.isSystemOrMetadataText(rawText)
            : (/^\d{1,2}:\d{2}/.test(rawText));

        if (cleanedText && !isMetadataOnly) {
            return { kind: 'text', text: cleanedText };
        } else if (rawText && !isMetadataOnly) {
            return { kind: 'text', text: rawText };
        }

        for (const img of imgs) {
            const alt = (img.getAttribute('alt') || '').trim();
            if (alt && (alt === '👍' || /^(?:thích|like)$/i.test(alt))) {
                return { kind: 'text', text: '👍' };
            }
            if (alt && alt.length <= 8 && !/[A-Za-z]/.test(alt)) {
                return { kind: 'emoji_text', text: alt };
            }
        }

        return { kind: 'none' };
    }

    // Shared identity/dedup/forward tail for both entry points: the
    // text-node TreeWalker pass (via processPotentialMessage) and the
    // per-wrapper media pass (in scanForMessages, for wrappers with no text
    // node at all). isInsideMessageBubble/inChatContainer are passed in
    // rather than recomputed here so each entry point only walks the
    // ancestor chain once (see walkBubbleAncestors).
    function forwardResolvedMessage(messageIdNode, anchorElement, fbMessageId, isInsideMessageBubble, inChatContainer, resolvedContent, messageListContainer) {
        if (resolvedContent.kind === 'none') return;

        const directionEvidence = getDirectionEvidence(messageIdNode || anchorElement, messageListContainer);
        const rawDir = directionEvidence.direction;
        const isOutgoing = (rawDir === true || rawDir === 1)
            ? true
            : ((rawDir === false || rawDir === 0)
                ? false
                : null);

        const threadId = resolveCurrentThreadId();
        if (!threadId) return;

        const urlParams = new URLSearchParams(window.location.search);
        const assetId = urlParams.get('asset_id') || urlParams.get('mailbox_id');

        let parsedTs = 0;
        let tsSource = 'unknown';
        const parser = (typeof FbPageTimestampParser !== 'undefined' ? FbPageTimestampParser.parsePageTimestamp : null)
            || (typeof window !== 'undefined' && window.FbPageTimestampParser ? window.FbPageTimestampParser.parsePageTimestamp : null);

        if (typeof parser === 'function') {
            const p = parser(messageIdNode || anchorElement);
            if (p && p.timestamp_ms > 0) {
                parsedTs = p.timestamp_ms;
                tsSource = p.timestamp_source;
            }
        }
        if (parsedTs === 0 && messageListContainer) {
            const separators = findDateSeparatorsInContainer(messageListContainer);
            if (separators.length > 0) {
                const targetNode = messageIdNode || anchorElement;
                let matchingSep = null;
                for (let sIdx = 0; sIdx < separators.length; sIdx++) {
                    const sep = separators[sIdx];
                    if (sep.element.compareDocumentPosition(targetNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
                        matchingSep = sep;
                    } else {
                        break;
                    }
                }
                if (matchingSep) {
                    const isLiveSession = !crawlInProgress && !isLikelyBacklog(threadId);
                    if (isLiveSession && Date.now() - matchingSep.timestamp_ms > 120000) {
                        parsedTs = Date.now();
                        tsSource = 'realtime_fallback';
                    } else {
                        parsedTs = matchingSep.timestamp_ms;
                        tsSource = 'separator_date_clock';
                    }
                }
            }
        }
        if (parsedTs === 0 && fbMessageId && knownMessageTimestamps.has(fbMessageId)) {
            parsedTs = knownMessageTimestamps.get(fbMessageId);
            tsSource = 'dom_order';
        } else if (parsedTs === 0 && !isLikelyBacklog(threadId)) {
            parsedTs = Date.now();
            tsSource = 'realtime_fallback';
        }

        const isMedia = resolvedContent.kind === 'media';
        const text = isMedia ? (resolvedContent.caption || '') : resolvedContent.text;

        const isCallLog = Boolean(text && (
            text.includes('Cuộc gọi thoại') ||
            text.includes('Cuộc gọi video') ||
            text.includes('cuộc gọi') ||
            text.includes('bỏ lỡ')
        ));

        let effectiveFbMessageId = fbMessageId;
        if (text === '👍' && messageListContainer) {
            // Nút Like độc lập (cả Like của Page lẫn Like của Khách) đã nằm trong khung chat
            // được quản lý đồng bộ chính xác theo thứ tự DOM bởi Batch Sync (PAGE_THREAD_MESSAGES_SYNCED_V1).
            // Không bắn lẻ qua NEW_PAGE_MESSAGE_FROM_DOM để tránh gán sai sequence_order ở đuôi DB.
            return;
        }

        const dedupKey = effectiveFbMessageId || text + '_' + (isOutgoing === null ? 'unknown' : isOutgoing);
        const hash = threadId + '_' + dedupKey;
        if (processedHashes.has(hash)) return;

        if (!inChatContainer || isExcludedElement(messageIdNode || anchorElement)) {
            return;
        }

        if (!isMedia) {
            const textFilter = globalThis.FbCrmTextFilter || (typeof window !== 'undefined' && window.FbCrmTextFilter);
            if (textFilter && typeof textFilter.isSystemOrMetadataText === 'function') {
                if (textFilter.isSystemOrMetadataText(text)) return;
            }

            const lowerText = text.toLowerCase();
            if (!isInsideMessageBubble && !isCallLog) {
                const sysTexts = ['xem thêm', 'đang tải...', 'chưa đọc'];
                if (sysTexts.some(t => lowerText.includes(t))) return;
            }

            const switcherPanelTexts = ['tài sản doanh nghiệp', 'tài khoản của bạn', 'trang quản lý tài sản doanh nghiệp'];
            if (switcherPanelTexts.some(t => lowerText.includes(t))) return;

            if (/thêm tin nhắn được cá nhân h(?:óa|oá)/i.test(text)) return;

            if (/^\d{1,2}:\d{2}\s+\d{1,2}\s+Tháng\s+\d{1,2},?\s+\d{4}$/i.test(text) ||
                /^\d{1,2}\s+Tháng\s+\d{1,2}(?:,?\s*\d{4})?$/i.test(text)) return;

            if (/^(?:Thứ (?:Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|Hôm nay|Hôm qua|Today|Yesterday)$/i.test(text)) return;
        }

        if (isOutgoing !== null) {
            processedHashes.add(hash);
            unresolvedHashFirstSeenTick.delete(hash);
        } else {
            const firstSeen = unresolvedHashFirstSeenTick.get(hash);
            if (firstSeen === undefined) {
                unresolvedHashFirstSeenTick.set(hash, currentTick);
            } else if (currentTick - firstSeen >= MAX_UNRESOLVED_DIRECTION_TICKS) {
                processedHashes.add(hash);
                unresolvedHashFirstSeenTick.delete(hash);
            }
        }

        console.log('[PageContent] Detected new message in thread ' + threadId + ': ' + (text || '').substring(0, 30) + ' (Outgoing: ' + (isOutgoing === null ? 'unknown' : isOutgoing) + ', ts=' + tsSource + ', kind=' + resolvedContent.kind + ')');

        const payloadData = {
            thread_id: threadId,
            fb_message_id: effectiveFbMessageId,
            content: text,
            is_outgoing: isOutgoing,
            direction_status: isOutgoing === null ? 'pending' : 'confirmed',
            direction_source: directionEvidence.source,
            direction_confidence: isOutgoing === null ? 'unknown' : directionEvidence.confidence,
            page_id: assetId,
            source: 'page_dom_observer',
            timestamp_ms: parsedTs,
            timestamp_source: tsSource
        };
        if (isMedia) {
            payloadData.media_type = resolvedContent.mediaType || 'image';
            payloadData.media_url = resolvedContent.mediaUrl;
        }
        if (currentContactName) payloadData.contact_name = currentContactName;
        if (currentAvatarUrl) payloadData.avatar_url = currentAvatarUrl;

        const sm = getOrInitStateMachine(threadId);
        if (sm && sm.getState() === 'BASELINING') {
            sm.bufferRealtimeMessage(payloadData);
            return;
        }

        // Feature 055: Realtime Leak Guard - khóa luồng phát NEW_PAGE_MESSAGE_FROM_DOM
        // khi Active Crawler đang cuộn kéo lịch sử tin nhắn cũ.
        if (crawlInProgress) {
            return;
        }

        chrome.runtime.sendMessage({
            type: 'NEW_PAGE_MESSAGE_FROM_DOM',
            data: payloadData
        });
    }

    function processPotentialMessage(element, text, processedWrappersThisTick, messageListContainer) {
        let messageIdNode = element.closest('[data-message-id]');
        let fbMessageId = messageIdNode ? messageIdNode.getAttribute('data-message-id') : null;

        if (messageIdNode) {
            if (processedWrappersThisTick.has(messageIdNode)) return;
            processedWrappersThisTick.add(messageIdNode);
        }

        const { bubbleAncestor, isInsideMessageBubble, inChatContainer } = walkBubbleAncestors(element, messageListContainer);

        if (!fbMessageId) {
            if (bubbleAncestor) {
                const pending = pendingNoIdBubbles.get(bubbleAncestor);
                if (!pending) {
                    pendingNoIdBubbles.set(bubbleAncestor, { firstSeenTick: currentTick });
                    return;
                }
                if (currentTick - pending.firstSeenTick < MAX_PENDING_TICKS) {
                    return;
                }
                pendingNoIdBubbles.delete(bubbleAncestor);
            }
        } else if (bubbleAncestor && pendingNoIdBubbles.has(bubbleAncestor)) {
            pendingNoIdBubbles.delete(bubbleAncestor);
        }

        const resolvedContent = messageIdNode ? resolveMessageContent(messageIdNode) : { kind: 'text', text };
        forwardResolvedMessage(messageIdNode, element, fbMessageId, isInsideMessageBubble, inChatContainer, resolvedContent, messageListContainer);
    }

    // Lắng nghe phản hồi link CDN video từ MAIN world (injected.js)
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE') {
            const { fb_message_id, videoUrl, posterUrl } = event.data;
            if (fb_message_id && videoUrl) {
                const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(fb_message_id) : fb_message_id;
                const msgNode = document.querySelector(`[data-message-id="${escaped}"]`) ||
                    document.querySelector(`[data-id="${escaped}"]`);
                if (msgNode) {
                    msgNode.setAttribute('data-crm-video-url', videoUrl);
                    if (posterUrl) msgNode.setAttribute('data-crm-poster-url', posterUrl);
                    const vEl = msgNode.querySelector('video');
                    if (vEl) {
                        vEl.setAttribute('data-crm-video-url', videoUrl);
                        if (posterUrl) vEl.setAttribute('data-crm-poster-url', posterUrl);
                    }
                }
                lastSyncedMountedSignature = '';
            }
        }
    });

    // Khi một thẻ video nạp xong link src/metadata từ mạng, reset signature để kích hoạt đồng bộ tức thì
    document.addEventListener('loadeddata', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            lastSyncedMountedSignature = '';
        }
    }, true);
    document.addEventListener('loadedmetadata', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            lastSyncedMountedSignature = '';
        }
    }, true);

    // Message listener for ACK and on-demand batch synchronization requests from background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'PAGE_BATCH_ACK') {
            const ack = request.data;
            if (threadSM && ack && ack.thread_id === threadSM.threadId) {
                const flushed = threadSM.handleAck(ack);
                if (Array.isArray(flushed)) {
                    for (const msg of flushed) {
                        chrome.runtime.sendMessage({
                            type: 'NEW_PAGE_MESSAGE_FROM_DOM',
                            data: msg
                        });
                    }
                }
            }
        } else if (request.type === 'REQUEST_PAGE_BATCH_SYNC') {
            const req = request.data || {};
            const threadId = req.thread_id || resolveCurrentThreadId();
            if (!threadId) return;

            // Feature 055: Mutex coalescing - ngăn nhiều request crawl chạy song song cho cùng 1 thread
            const crawlToken = crawlMutex.acquire(threadId);
            if (!crawlToken) {
                console.log(`[PageContent] Bỏ qua REQUEST_PAGE_BATCH_SYNC: thread ${threadId} đang có crawler hoạt động.`);
                return;
            }

            crawlInProgress = true;

            (async () => {
                try {
                    const scrollerHelper = typeof FbPageActiveScroller !== 'undefined' ? FbPageActiveScroller : null;
                    const accumulator = scrollerHelper && typeof scrollerHelper.createMessageAccumulator === 'function'
                        ? scrollerHelper.createMessageAccumulator()
                        : {
                            _list: [],
                            accumulate: function(arr) { this._list = [...this._list, ...arr]; return this._list.length; },
                            getAll: function() { return this._list; }
                        };

                    const container = findMessageListContainer();
                    const initialBatch = collectMountedBatchMessages(container);
                    accumulator.accumulate(initialBatch);

                    const isOlderMode = req.mode === 'page_scroll_older' || req.mode === 'ondemand_older';
                    const targetOldestId = (req.cursor && req.cursor.oldest_message_id) ? req.cursor.oldest_message_id : null;

                    if (isOlderMode && scrollerHelper) {
                        const scroller = findScrollableMessageContainer();
                        if (scroller) {
                            const beforeTop = scroller.scrollTop;
                            const beforeHeight = scroller.scrollHeight;
                            const className = scroller.className ? String(scroller.className).slice(0, 80) : '';

                            try {
                                chrome.runtime.sendMessage({
                                    type: 'PAGE_SCROLLER_DEBUG',
                                    data: {
                                        thread_id: threadId,
                                        stage: 'SCROLLER_FOUND',
                                        class_name: className,
                                        client_height: scroller.clientHeight,
                                        scroll_height: beforeHeight,
                                        scroll_top: beforeTop
                                    }
                                });
                            } catch (e) {}

                            const maxRounds = 3;
                            for (let round = 0; round < maxRounds; round++) {
                                // Kiểm tra khẩn cấp: nếu người dùng đã đổi thread hoặc iframe reload -> hủy crawler ngay
                                if (!crawlMutex.isTokenValid(crawlToken, resolveCurrentThreadId())) {
                                    console.warn(`[PageContent] Hủy crawler: thread đã đổi từ ${threadId} sang ${resolveCurrentThreadId()} tại vòng ${round + 1}`);
                                    return;
                                }

                                const stepDistance = scrollerHelper.calculateStepDistance(scroller.clientHeight);
                                scrollerHelper.dispatchScrollGestures(scroller, stepDistance, { forceToTop: true });

                                try {
                                    chrome.runtime.sendMessage({
                                        type: 'PAGE_SCROLLER_DEBUG',
                                        data: {
                                            thread_id: threadId,
                                            stage: 'SCROLLED_TO_TOP',
                                            round: round + 1,
                                            before_top: beforeTop,
                                            after_top: scroller.scrollTop,
                                            scroll_height: scroller.scrollHeight
                                        }
                                    });
                                } catch (e) {}

                                const settleRes = await scrollerHelper.waitForDomSettle(scroller, {
                                    maxWaitMs: 3500,
                                    pollIntervalMs: 60,
                                    getFirstMessageId: () => {
                                        const firstEl = container ? container.querySelector('[data-message-id]') : null;
                                        return firstEl ? firstEl.getAttribute('data-message-id') : null;
                                    }
                                });

                                // Chụp snapshot ngay khi vòng này settle -> đưa vào accumulator trước khi React unmount!
                                const countBefore = accumulator.getCount();
                                const roundBatch = collectMountedBatchMessages(container);
                                accumulator.accumulate(roundBatch);
                                const countAfter = accumulator.getCount();
                                const newlyAdded = countAfter - countBefore;

                                try {
                                    chrome.runtime.sendMessage({
                                        type: 'PAGE_SCROLLER_DEBUG',
                                        data: {
                                            thread_id: threadId,
                                            stage: 'DOM_SETTLED',
                                            round: round + 1,
                                            has_growth: settleRes.hasGrowth,
                                            new_messages_count: newlyAdded,
                                            total_accumulated: countAfter,
                                            scroll_height: scroller.scrollHeight
                                        }
                                    });
                                } catch (e) {}

                                // Kiểm tra điều kiện dừng:
                                // 1. Chạm mốc tin cũ đã biết (targetOldestId)
                                const allSoFar = accumulator.getAll();
                                if (targetOldestId && allSoFar.some(m => m.fb_message_id === targetOldestId)) {
                                    console.log(`[PageContent] Đã chạm mốc tin cũ ${targetOldestId} tại vòng ${round + 1}. Dừng crawler.`);
                                    break;
                                }

                                // 2. Nếu đã qua vòng 2 và không phát hiện tăng trưởng -> dừng
                                if (round >= 1 && !settleRes.hasGrowth && newlyAdded === 0) {
                                    console.log(`[PageContent] Không phát hiện tăng trưởng DOM tại vòng ${round + 1}. Dừng crawler.`);
                                    break;
                                }
                            }

                            // Bắt buộc cuộn trả lại đáy để Facebook mount lại các tin nhắn mới nhất
                            try {
                                scroller.scrollTop = scroller.scrollHeight;
                                await scrollerHelper.waitForDomSettle(scroller, {
                                    maxWaitMs: 1500,
                                    pollIntervalMs: 50
                                });
                                const bottomBatch = collectMountedBatchMessages(container);
                                accumulator.accumulate(bottomBatch);
                            } catch (_) {}
                        } else {
                            try {
                                chrome.runtime.sendMessage({
                                    type: 'PAGE_SCROLLER_DEBUG',
                                    data: {
                                        thread_id: threadId,
                                        stage: 'SCROLLER_NOT_FOUND'
                                    }
                                });
                            } catch (e) {}
                        }
                    }

                    // Kiểm tra thread lần cuối trước khi đóng gói gửi backend
                    const currentThreadNow = resolveCurrentThreadId();
                    if (!crawlMutex.isTokenValid(crawlToken, currentThreadNow)) {
                        console.warn(`[PageContent] Hủy phát batch: thread hiện tại (${currentThreadNow}) không khớp token (${threadId}).`);
                        return;
                    }

                    const batchMessages = accumulator.getAll();

                    // Khởi động State Machine và bắt đầu đếm timeout 10s TẠI ĐÂY (chỉ sau khi crawl xong)
                    const sm = getOrInitStateMachine(threadId);
                    const meta = sm ? sm.startBaselining() : { session_epoch: 'epoch_1', generation: 1, scan_id: 'scan_1' };

                    let boundaryEvidence = null;
                    const prevOldest = targetOldestId || lastSyncedOldestMessageId;
                    if (prevOldest) {
                        const overlapItem = batchMessages.find(m => m.fb_message_id === prevOldest);
                        boundaryEvidence = {
                            previous_oldest_message_id: prevOldest,
                            crawler_confirmed_scroll: true,
                            overlap_id: overlapItem ? overlapItem.fb_message_id : null
                        };
                    }

                    if (batchMessages.length > 0) {
                        lastSyncedOldestMessageId = batchMessages[0].fb_message_id;
                    }

                    const urlParams = new URLSearchParams(window.location.search);
                    const assetId = req.page_id || urlParams.get('asset_id') || urlParams.get('mailbox_id') || null;

                    chrome.runtime.sendMessage({
                        type: 'PAGE_THREAD_MESSAGES_SYNCED_V1',
                        data: {
                            thread_id: threadId,
                            account_id: req.account_id || null,
                            page_id: assetId,
                            session_epoch: meta.session_epoch,
                            generation: meta.generation,
                            scan_id: meta.scan_id,
                            batch_sequence: 1,
                            mode: req.mode || (isOlderMode ? 'page_scroll_older' : 'page_initial'),
                            contact_name: (String(threadId) === String(resolveCurrentThreadId()) ? (currentContactName || null) : null),
                            boundary_evidence: boundaryEvidence,
                            messages: batchMessages
                        }
                    });
                } catch (err) {
                    console.error('[PageContent] Lỗi trong quá trình Active Crawl:', err);
                } finally {
                    crawlMutex.release(crawlToken);
                    crawlInProgress = false;
                }
            })();
        }
    });

    // Tự động cào danh sách hội thoại từ Sidebar của Meta Business Suite
    let lastSidebarSyncHash = '';
    let lastSidebarSyncTime = 0;

    function scanPageSidebarThreads() {
        try {
            const now = Date.now();
            if (now - lastSidebarSyncTime < 1000) return;

            const urlParams = new URLSearchParams(window.location.search);
            const pageId = urlParams.get('asset_id') || urlParams.get('mailbox_id') || null;
            const currentSelectedId = resolveCurrentThreadId();

            const isInvalidText = (txt) => {
                if (!txt || typeof txt !== 'string') return true;
                const s = txt.trim();
                if (s.length < 2) return true;
                const systemKeywordsRegex = /^(?:Tất cả tin nhắn|Tất cả|All messages|All|Tin nhắn trực tiếp|Direct messages|Hộp thư đến|Hộp thư|Inbox|Chưa đọc|Unread|Đã xong|Done|Gắn dấu sao|Đã gắn dấu sao|Starred|Spam|Thư rác|Bình luận.*|Comments.*|Thông báo|Notifications|Đang hoạt động.*|Hoạt động.*|Active now|Active recently|Online|Offline|Đang|Facebook|Messenger|Meta)$/i;
                if (systemKeywordsRegex.test(s)) return true;
                const singleKeywordsPattern = '(?:Tất cả tin nhắn|Tất cả|All messages|All|Tin nhắn trực tiếp|Direct messages|Hộp thư đến|Hộp thư|Inbox|Chưa đọc|Unread|Đã xong|Done|Gắn dấu sao|Đã gắn dấu sao|Starred|Spam|Thư rác|Thông báo|Notifications|Facebook|Messenger|Meta)';
                const repeatedRegex = new RegExp(`^(?:${singleKeywordsPattern}[\\s\\n\\r]*)+$`, 'i');
                if (repeatedRegex.test(s)) return true;
                return false;
            };

            const sidebar = document.querySelector('[data-surface*="thread_list"], [data-surface*="bizweb_inbox:thread_list"], [role="navigation"]') || document;
            
            const rowCandidates = Array.from(sidebar.querySelectorAll(
                '[data-surface*="thread_row"], [role="row"], [role="listitem"], a[href*="selected_item_id="], a[href*="thread_id="]'
            ));

            const leftAvatars = Array.from(sidebar.querySelectorAll('img[src*="fbcdn.net"], img[src*="scontent"]')).filter(img => {
                try {
                    const rect = img.getBoundingClientRect();
                    return rect.width > 0 && rect.left < 500 && !img.closest('[data-message-id], [role="main"]');
                } catch (_) { return false; }
            });
            for (const img of leftAvatars) {
                const parentRow = img.closest('[role="row"], [role="listitem"], [data-surface*="thread_row"]') || img.parentElement?.parentElement;
                if (parentRow && !rowCandidates.includes(parentRow)) {
                    rowCandidates.push(parentRow);
                }
            }

            const discoveredThreads = [];
            const seenIds = new Set();

            for (const row of rowCandidates) {
                try {
                    if (row.closest('[data-message-id], [data-surface*="message_list"], [role="main"] header, form')) continue;

                    let threadId = null;

                    const links = row.tagName === 'A' ? [row] : Array.from(row.querySelectorAll('a[href]'));
                    for (const l of links) {
                        const href = l.getAttribute('href') || l.href || '';
                        const m = href.match(/(?:selected_item_id|thread_id)=(\d+)/) || href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
                        if (m && m[1] && m[1] !== pageId) {
                            threadId = m[1];
                            break;
                        }
                    }

                    if (!threadId) {
                        try {
                            const keys = Object.keys(row);
                            const reactKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
                            if (reactKey) {
                                let curr = row[reactKey];
                                let depth = 0;
                                while (curr && depth < 40) {
                                    depth++;
                                    const props = curr.memoizedProps || curr.props;
                                    if (props) {
                                        const candidateProps = ['threadKey', 'thread_key', 'thread_id', 'threadId', 'recipientId', 'otherUserFbId', 'selected_item_id', 'userId'];
                                        for (const p of candidateProps) {
                                            const val = String(props[p] || '');
                                            const m = val.match(/(\d{12,})/);
                                            if (m && m[1] !== pageId) {
                                                threadId = m[1];
                                                break;
                                            }
                                        }
                                        if (threadId) break;
                                    }
                                    curr = curr.return || curr.child;
                                }
                            }
                        } catch (_) {}
                    }

                    if (!threadId && currentSelectedId && (Date.now() - lastThreadSwitchAt >= 1500) && (row.getAttribute('aria-selected') === 'true' || row.getAttribute('aria-current') === 'true')) {
                        threadId = currentSelectedId;
                    }

                    if (!threadId || threadId === pageId || seenIds.has(threadId)) continue;
                    seenIds.add(threadId);

                    let name = '';
                    const nameEl = row.querySelector('[data-surface*="thread_title"], h2, h3, [role="heading"], [dir="auto"], strong, b');
                    if (nameEl) {
                        const txt = (nameEl.textContent || '').trim().split('\n')[0].trim();
                        if (txt && !isInvalidText(txt) && txt.length >= 2 && txt.length <= 80 && !/^\d+$/.test(txt)) {
                            name = txt;
                        }
                    }
                    if (!name) {
                        const lines = String(row.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
                        for (const line of lines) {
                            if (line && !isInvalidText(line) && line.length >= 2 && line.length <= 80 && !/^\d+$/.test(line) && !/^\d{1,2}:\d{2}$/.test(line)) {
                                name = line;
                                break;
                            }
                        }
                    }
                    if (!name) name = 'Khách hàng';

                    let avatarUrl = null;
                    const avatarImg = row.querySelector('img[src*="fbcdn.net"], img[src*="scontent"], img.img');
                    if (avatarImg) {
                        const src = avatarImg.getAttribute('src');
                        if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('static.xx.fbcdn')) {
                            avatarUrl = src;
                        }
                    }

                    let lastMessage = '';
                    const textNodes = Array.from(row.querySelectorAll('span, div')).filter(el => el.children.length === 0);
                    for (let i = textNodes.length - 1; i >= 0; i--) {
                        const t = (textNodes[i].textContent || '').trim();
                        if (t && t !== name && !/^\d{1,2}:\d{2}$/.test(t) && !isInvalidText(t) && t.length > 1) {
                            lastMessage = t;
                            break;
                        }
                    }

                    const isOutgoingPreview = /^(?:Bạn:|You:)/i.test(lastMessage.trim());
                    const hasUnreadIndicator = Boolean(row.querySelector('[aria-label*="chưa đọc" i], [aria-label*="unread" i], [data-testid="unread-count"], [aria-label*="Đánh dấu là chưa đọc" i]'));
                    const isUnread = !isOutgoingPreview && hasUnreadIndicator;

                    discoveredThreads.push({
                        id: threadId,
                        thread_id: threadId,
                        contact_name: name,
                        avatar_url: avatarUrl,
                        last_message: lastMessage || 'Chưa có tin nhắn',
                        is_unread: isUnread ? 1 : 0,
                        source_type: 'page_messenger',
                        page_id: pageId,
                        inbox_folder: 'INBOX'
                    });
                } catch (_) {}
            }

            if (discoveredThreads.length > 0) {
                const currentHash = discoveredThreads.map(t => `${t.id}:${t.contact_name}:${t.last_message}`).join('|');
                if (currentHash !== lastSidebarSyncHash) {
                    lastSidebarSyncHash = currentHash;
                    lastSidebarSyncTime = now;
                    console.log(`[PageContent] 🚀 Tự động cào được ${discoveredThreads.length} hội thoại Page:`, discoveredThreads.map(t => `${t.contact_name} (${t.id})`));
                    chrome.runtime.sendMessage({
                        type: 'PAGE_SIDEBAR_THREADS_DISCOVERED',
                        data: {
                            page_id: pageId,
                            threads: discoveredThreads
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[PageContent] Lỗi scanPageSidebarThreads:', e.message);
        }
    }

    // Incoming calls are handled exclusively by content.js.
} // End isBusiness block
