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


    // Active Crawler state (Feature 055)
    let crawlInProgress = false;
    const crawlMutex = (typeof FbPageActiveScroller !== 'undefined' && FbPageActiveScroller.createCrawlMutex)
        ? FbPageActiveScroller.createCrawlMutex()
        : { acquire: (id) => ({ token: 'mock_' + id, threadId: id }), isTokenValid: () => true, release: () => {}, isBusy: () => false };

    // Use polling to be completely immune to React DOM shuffling
    setInterval(scanForMessages, 1000);

    // Feature 055: Old passive scrollBackForHistory interval is deprecated and replaced
    // by the active on-demand crawler triggered by REQUEST_PAGE_BATCH_SYNC.
    // setInterval(scrollBackForHistory, SCROLL_INTERVAL_MS);

    let isScanning = false;

    function resolveCurrentThreadId() {
        const href = window.location.href;
        const urlMatch = href.match(/[?&](?:selected_item_id|thread_id)=(\d+)/) || href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
        if (urlMatch && urlMatch[1]) {
            return urlMatch[1];
        }

        // DOM Fallback: Find currently selected item in Business Suite sidebar
        const selectedContainer = document.querySelector('[aria-selected="true"]') ||
                                  document.querySelector('[aria-current="page"]') ||
                                  document.querySelector('[aria-current="true"]');
        if (selectedContainer) {
            const links = selectedContainer.tagName === 'A' ? [selectedContainer] : Array.from(selectedContainer.querySelectorAll('a[href]'));
            for (const link of links) {
                const linkHref = link.getAttribute('href') || link.href || '';
                const m = linkHref.match(/(?:selected_item_id|thread_id)=(\d+)/) || linkHref.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
                if (m && m[1]) return m[1];
            }
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
    // avatar) can be scoped to it instead of querying the whole document - the
    // Business Suite sidebar conversation list has its own avatar thumbnails
    // that must never leak into the currently-open thread's contact info.
    function findMessageListContainer() {
        const anchor = document.querySelector('[data-message-id]')
            || document.querySelector('[role="main"]')
            || document.querySelector('[role="grid"]')
            || document.querySelector('[aria-label*="Đoạn chat"]')
            || document.querySelector('[aria-label*="tin nhắn"]');
        if (!anchor) return document.body;
        let curr = anchor.parentElement || anchor;
        while (curr && curr !== document.body) {
            if (curr.getAttribute) {
                const label = (curr.getAttribute('aria-label') || '').toLowerCase();
                const role = curr.getAttribute('role');
                if (role === 'region' && (label.includes('tin nhắn') || label.includes('message') || label.includes('msg'))) {
                    return curr;
                }
                if (role === 'main' || role === 'grid') {
                    return curr;
                }
            }
            curr = curr.parentElement;
        }
        return anchor.parentElement || document.body;
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
            return classifier({
                containerRect: messageListContainer.getBoundingClientRect(),
                bubbleRect: messageEl.getBoundingClientRect(),
                tolerancePx: 12
            });
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

    function getOrInitStateMachine(threadId) {
        if (!threadId) return null;
        if (!threadSM || threadSM.threadId !== threadId) {
            const SMClass = (typeof ThreadScanStateMachine !== 'undefined' ? ThreadScanStateMachine : null)
                || (typeof window !== 'undefined' ? window.ThreadScanStateMachine : null);
            if (SMClass) {
                threadSM = new SMClass(threadId);
                lastSyncedOldestMessageId = null;
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

            const text = (el.textContent || '').trim();
            if (!text || text.length > 50) continue;

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
        const messageEls = Array.from(container.querySelectorAll('[data-message-id]'));
        const parser = (typeof FbPageTimestampParser !== 'undefined' ? FbPageTimestampParser.parsePageTimestamp : null)
            || (typeof window !== 'undefined' && window.FbPageTimestampParser ? window.FbPageTimestampParser.parsePageTimestamp : null);

        const separators = findDateSeparatorsInContainer(container);

        const list = [];
        for (let i = 0; i < messageEls.length; i++) {
            const el = messageEls[i];
            const fbMessageId = el.getAttribute('data-message-id');
            if (!fbMessageId) continue;

            const resolved = resolveMessageContent(el);
            if (resolved.kind === 'none') continue;

            const dirEvidence = getDirectionEvidence(el, container);
            const rawDir = dirEvidence.direction;
            const isOutgoing = (rawDir === true || rawDir === 1)
                ? true
                : ((rawDir === false || rawDir === 0) ? false : null);

            let parsedTs = 0;
            let tsSource = 'unknown';

            // 1. Kiểm tra timestamp trên bubble
            if (typeof parser === 'function') {
                const p = parser(el);
                if (p && p.timestamp_ms > 0) {
                    parsedTs = p.timestamp_ms;
                    tsSource = p.timestamp_source;
                }
            }

            // 2. Nếu chưa có, tìm Date Separator gần nhất xuất hiện trước bubble này
            if (parsedTs === 0 && separators.length > 0) {
                let matchingSep = null;
                for (let sIdx = 0; sIdx < separators.length; sIdx++) {
                    const sep = separators[sIdx];
                    if (sep.element.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
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

            // 3. Fallback theo knownMessageTimestamps nếu đã biết từ trước
            if (parsedTs === 0 && knownMessageTimestamps.has(fbMessageId)) {
                parsedTs = knownMessageTimestamps.get(fbMessageId);
                tsSource = 'dom_order';
            }

            if (parsedTs > 0 && !knownMessageTimestamps.has(fbMessageId)) {
                knownMessageTimestamps.set(fbMessageId, parsedTs);
            }

            const isMedia = resolved.kind === 'media';
            const text = isMedia ? (resolved.caption || '') : resolved.text;

            list.push({
                fb_message_id: fbMessageId,
                content: text,
                media_type: isMedia ? 'image' : 'text',
                media_url: isMedia ? resolved.mediaUrl : null,
                is_outgoing: isOutgoing,
                direction_status: isOutgoing === null ? 'pending' : 'confirmed',
                direction_confidence: isOutgoing === null ? 'unknown' : dirEvidence.confidence,
                dom_order: i,
                timestamp_ms: parsedTs,
                timestamp_source: tsSource
            });
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
            if (threadJustChanged) seedTimestampAnchorsForThread(currentThreadId);

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
                // Ưu tiên thẻ title trong thread list / thread detail
                const titleEl = document.querySelector('[data-surface*="thread_and_detail"] [data-surface*="thread_title"], [data-surface*="thread_title"]');
                const titleTxt = (titleEl?.textContent || '').trim().split('\n')[0].trim();
                if (titleTxt && !isInvalidName(titleTxt) && titleTxt.length >= 2 && titleTxt.length <= 80) {
                    currentContactName = cleanName(titleTxt);
                }

                // Header chính giữa hoặc thông tin chi tiết bên phải
                if (!currentContactName || isInvalidName(currentContactName)) {
                    const headerEls = document.querySelectorAll('[role="main"] header [dir="auto"], [role="main"] header h2, header [role="heading"], [data-surface*="contact_name"], [data-surface*="profile_header"]');
                    for (const el of headerEls) {
                        const txt = (el.textContent || '').trim().split('\n')[0].trim();
                        if (txt && !isInvalidName(txt) && txt.length >= 2 && txt.length <= 80) {
                            currentContactName = cleanName(txt);
                            break;
                        }
                    }
                }
            }

            // Kích hoạt Baselining theo State Machine khi thread mới mở và DOM đã mount tin nhắn
            const sm = getOrInitStateMachine(currentThreadId);
            if (sm && sm.getState() === 'UNINITIALIZED' && messageListContainer) {
                const batchMessages = collectMountedBatchMessages(messageListContainer);
                // Chỉ kích hoạt baselining khi DOM đã thực sự render ít nhất 1 tin nhắn (tránh gửi batch rỗng count=0)
                if (batchMessages.length > 0) {
                    const meta = sm.startBaselining();
                    lastSyncedOldestMessageId = batchMessages[0].fb_message_id;
                    chrome.runtime.sendMessage({
                        type: 'PAGE_THREAD_MESSAGES_SYNCED_V1',
                        data: {
                            thread_id: currentThreadId,
                            account_id: null,
                            page_id: assetId,
                            session_epoch: meta.session_epoch,
                            generation: meta.generation,
                            scan_id: meta.scan_id,
                            batch_sequence: 1,
                            mode: 'page_initial',
                            contact_name: currentContactName || null,
                            messages: batchMessages
                        }
                    });
                }
            }

            // 2. Trích xuất Avatar URL (currentAvatarUrl)
            if (!currentAvatarUrl) {
                const avatarCandidates = document.querySelectorAll(
                    '[data-surface*="thread_list"] img[src*="fbcdn.net"], [data-surface*="thread_list"] img[src*="scontent"], [data-surface*="thread_list"] img.img, [role="main"] header img, [data-surface*="thread_detail"] img, .x1q0g3np img, img[src*="fbcdn.net"], img[src*="scontent"]'
                );
                for (const img of avatarCandidates) {
                    const src = img.getAttribute('src');
                    if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('static.xx.fbcdn')) {
                        currentAvatarUrl = src;
                        break;
                    }
                }
            }

            // Phát hiện metadata mới -> gửi ngay sang background (chỉ gửi khi có thay đổi)
            if ((currentContactName && !isInvalidName(currentContactName)) || currentAvatarUrl) {
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
            if (messageListContainer) {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while (node = walker.nextNode()) {
                    const text = node.nodeValue.trim();
                    if (text.length > 0) {
                        const el = node.parentElement;
                        if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'A' && el.tagName !== 'BUTTON' && !el.closest('a') && !el.closest('button')) {
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
    function resolveMessageContent(messageIdNode) {
        const fullText = (messageIdNode.innerText || messageIdNode.textContent || '').trim();

        // Call Log Guard: Never treat a call notification wrapper (which may contain avatar/icon <img>) as an image attachment!
        const lowerFullText = fullText.toLowerCase();
        if (fullText && (lowerFullText.includes('cuộc gọi') || lowerFullText.includes('bỏ lỡ') || lowerFullText.includes('đã nhỡ') || lowerFullText.includes('nhỡ'))) {
            return { kind: 'text', text: fullText };
        }

        // Spec 040 T020: a message can combine real caption text with an
        // attached image in the SAME [data-message-id] wrapper - confirmed
        // live 2026-08-17/18 for a file-transport image manifest sent with a
        // caption. The old code returned on fullText alone and never even
        // checked for an <img>, so this shape was always reported as
        // kind:'text' with the image silently dropped - the resulting
        // campaign dispatch could never be recognized as media (safe per the
        // false-positive fix elsewhere, but never confirmed 'sent' either,
        // and since QUEUE_CONFIRMATION_TIMEOUT is retryable this meant an
        // already-successful file send would get resent for real). Checking
        // for a real (empty-alt) media image BEFORE the fullText early-return
        // - using fullText as the media's caption when both are present -
        // fixes this while leaving every other shape (pure text, pure
        // emoji/sticker, pure photo) unchanged: forwardResolvedMessage
        // already reads resolvedContent.caption for kind:'media'.
        const imgs = messageIdNode.querySelectorAll('img[src]');
        for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (!src || src.includes('/emoji.php') || src.includes('/rsrc.php')) continue;

            const alt = (img.getAttribute('alt') || '').toLowerCase();
            if (alt.includes('ảnh đại diện') || alt.includes('profile picture') || alt.includes('biểu tượng cảm xúc')) continue;

            const isAvatar = img.closest && img.closest('[aria-label*="Ảnh đại diện"], [aria-label*="profile"], [data-surface*="profile"]');
            if (isAvatar) continue;
            if ((img.width > 0 && img.width <= 36) || (img.height > 0 && img.height <= 36)) continue;

            return { kind: 'media', mediaUrl: src, caption: fullText || null };
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
                        return { kind: 'media', mediaUrl: url, caption: fullText || bgEl.getAttribute('aria-label') || null };
                    }
                }
            }
        }

        // Temporary diagnostic (spec 040 T020, 2026-08-18): a real
        // file-transport image + caption send still isn't being recognized
        // as media even after checking both <img> and CSS-background - ran
        // once live and found imgCount=0 too, so whatever markup Facebook
        // actually uses for this case is still unknown. Dump the wrapper's
        // own outerHTML (truncated) so the real shape can be seen directly
        // instead of guessing a third time. Scoped to this test's own
        // messages (marker text) to avoid dumping real customer content.
        if (fullText && /spec 0[34]0/i.test(fullText) && chrome?.runtime?.id) {
            try {
                // Run 3 (2026-08-18) climbed 3 ancestor levels and found only
                // an unrelated read-receipt avatar <img> (real alt text, a
                // "seen at HH:MM" description) - not the 2 uploaded photos.
                // Search the WHOLE document instead for real content images
                // using this file's own established convention (an empty
                // alt="" marks a real sent/received photo, as opposed to an
                // avatar/emoji which always has descriptive alt text - see
                // the isPhotoMessage comment elsewhere in this file), and
                // report each one's closest [data-message-id] ancestor (or
                // lack of one) to find out where they actually live.
                const emptyAltImgs = document.querySelectorAll('img[src][alt=""]');
                const emptyAltInfo = [...emptyAltImgs].slice(0, 10).map((img) => {
                    const closestId = img.closest('[data-message-id]');
                    return {
                        srcPrefix: (img.getAttribute('src') || '').substring(0, 40),
                        dataMessageId: closestId ? closestId.getAttribute('data-message-id') : null
                    };
                });
                chrome.runtime.sendMessage({
                    type: 'CONTENT_DEBUG',
                    data: {
                        reason: 'test_message_wrapper_dump_v3',
                        fullTextSnippet: fullText.substring(0, 60),
                        thisWrapperId: messageIdNode.getAttribute('data-message-id'),
                        imgCount: imgs.length,
                        bgElCount: bgEls.length,
                        emptyAltImgCountWholeDoc: emptyAltImgs.length,
                        emptyAltImgs: emptyAltInfo
                    }
                });
            } catch (e) { /* best-effort diagnostic only */ }
        }

        if (fullText) {
            return { kind: 'text', text: fullText };
        }

        for (const img of imgs) {
            const alt = (img.getAttribute('alt') || '').trim();
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
                    parsedTs = matchingSep.timestamp_ms;
                    tsSource = 'separator_date_clock';
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

        const dedupKey = fbMessageId || text + '_' + (isOutgoing === null ? 'unknown' : isOutgoing);
        const hash = threadId + '_' + dedupKey;
        if (processedHashes.has(hash)) return;

        if (!inChatContainer) {
            return;
        }

        if (!isMedia) {
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
            fb_message_id: fbMessageId,
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
            payloadData.media_type = 'image';
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
                            contact_name: currentContactName || null,
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

    // Incoming calls are handled exclusively by content.js.
} // End isBusiness block
