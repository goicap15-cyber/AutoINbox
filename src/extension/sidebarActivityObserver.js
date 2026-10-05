// Additive realtime fallback for Messenger's conversation list.
(function installSidebarActivityObserver() {
  const previous = globalThis.__FB_CRM_SIDEBAR_ACTIVITY_OBSERVER__;
  if (previous?.disconnect) {
    try { previous.disconnect(); } catch (_) {}
  }

  let lastFingerprint = '';
  let debounceTimer = null;

  // 2026-09-30: chuỗi hint từng lạnh hoàn toàn mà không có dấu vết (background
  // không log được thứ nào xuống composer-debug.log). Bắn kèm CONTENT_DEBUG
  // để đo được: observer có cài không, hint có gửi không.
  function obsDebug(info) {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'CONTENT_DEBUG', data: { kind: 'obs', ...info } }).catch(() => {});
    } catch (_) {}
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hash(value) {
    let result = 2166136261;
    const input = String(value || '');
    for (let index = 0; index < input.length; index += 1) {
      result ^= input.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  const isMessengerHost = /(^|\.)messenger\.com$/i.test(location.hostname);

  // Dòng thời gian relative trên row ("Bây giờ", "1 phút", "12:30"...). Server
  // dùng để nhận diện media thuần trên thread đã unread sẵn (không còn flip).
  const TIME_LINE_RE = /^(?:bây giờ|just now|vừa xong|vài giây|a few seconds ago|hôm qua|yesterday|thứ [a-zà-ỹ]+|mon|tue|wed|thu|fri|sat|sun|\d{1,2}:\d{2}|\d+\s*(?:giây|phút|giờ|ngày|tuần|tháng|năm|s|m|h|d|w|y)(?:\s*(?:trước|ago))?)$/iu;

  function extractThreadId(href) {
    const raw = String(href || '');
    const m = raw.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/i)
      || (isMessengerHost ? raw.match(/\/t\/([^\/?#]+)/i) : null);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // 2026-10-03: FB bỏ data-testid="unread-count"/.unread trên row Messenger
  // mới (đo DOM thật: 0 match, cả ngày 03-10). Chấm chưa đọc giờ là div tròn
  // 6-16px nền xanh FB trong row - dò theo hình dạng+màu để không phụ thuộc
  // class hash đổi liên tục, kèm biến thể aria-label (CSS i-flag không gập
  // được Đ/đ nên so sánh bằng JS regex).
  function detectRowUnread(row) {
    if (row.querySelector('[data-testid="unread-count"], .unread')) return true;
    for (const el of row.querySelectorAll('[aria-label]')) {
      if (/chưa đọc|unread|tin nhắn mới|new message/i.test(el.getAttribute('aria-label') || '')) return true;
    }
    for (const el of row.querySelectorAll('div, span, i')) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 6 || w > 16 || h < 6 || h > 16) continue;
      const st = getComputedStyle(el);
      const radius = parseFloat(st.borderTopLeftRadius);
      if (!(Number.isFinite(radius) && radius >= Math.min(w, h) / 2)) continue;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(st.backgroundColor);
      if (!m) continue;
      const alpha = m[4] === undefined ? 1 : Number(m[4]);
      if (alpha < 0.2) continue;
      // Xanh FB (#0866FF/#1877F2/#0064E0): b cao, r thấp, g vừa. Loại chấm
      // trạng thái online (xanh lá), xám, trắng.
      if (+m[3] >= 180 && +m[1] <= 90 && +m[2] >= 50 && +m[2] <= 170) return true;
    }
    return false;
  }

  function readSidebarActivity() {
    // Tab chat CRM có thể là facebook.com/messages hoặc messenger.com/t/...
    if (!isMessengerHost && !/\/messages(?:\/|$|\?)/i.test(location.pathname + location.search)) {
      return { fingerprint: '', threads: [] };
    }
    const selectors = [
      'a[href*="/messages/t/"]',
      'a[href*="/messages/e2ee/t/"]',
      'a[href*="/messages/requests/t/"]',
      'a[href*="/messages/requests/spam/t/"]',
      'a[href*="/messages/spam/t/"]',
      ...(isMessengerHost ? ['a[href*="/t/"]'] : [])
    ].join(',');
    const seen = new Set();
    const rows = [];
    const threads = [];
    for (const link of document.querySelectorAll(selectors)) {
      const href = link.getAttribute('href') || link.href || '';
      const threadId = extractThreadId(href);
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      const row = link.closest('[role="row"], [role="listitem"], li') || link.parentElement || link;
      const text = normalize(row.textContent).slice(0, 320);
      const unread = detectRowUnread(row);
      rows.push(`${threadId}|${unread ? 1 : 0}|${text}`);
      // Preserve the exact row while it is still mounted. Messenger can
      // virtualize it away between this mutation and background.executeScript.
      // The background parser remains primary; this snapshot is only its
      // empty-result fallback.
      const lines = String(row.innerText || row.textContent || '').split(/\n+/)
        .map(normalize).filter(Boolean);
      const name = lines[0] || `Khách hàng (${threadId.slice(0, 8)})`;
      const lastMessage = [...lines].reverse().find((line) => (
        line !== name && line.length < 200
        && !/^\d+\s*(?:giây|phút|giờ|ngày|tuần|tháng|năm|s|m|h|d|y)(?:\s*(?:trước|ago))?$/iu.test(line)
      )) || '';
      const timeLine = [...lines].reverse().find((line) => TIME_LINE_RE.test(line)) || '';
      threads.push({
        thread_id: threadId,
        name: name.slice(0, 80),
        last_message: lastMessage,
        is_unread: unread,
        preview_is_outgoing: /^(?:Bạn|You)\s*:/i.test(lastMessage),
        row_time_text: timeLine.slice(0, 24),
        thread_url: (() => { try { return new URL(href, location.origin).toString(); } catch (_) { return href; } })(),
        is_e2ee: /\/messages\/(?:e2ee\/)?t\//i.test(href)
      });
      if (rows.length >= 30) break;
    }
    return { fingerprint: rows.length ? hash(rows.join('\n')) : '', threads };
  }

  function emitIfChanged() {
    debounceTimer = null;
    const activity = readSidebarActivity();
    const fingerprint = activity.fingerprint;
    if (!fingerprint) {
      if (!emitIfChanged.warnedPath) {
        emitIfChanged.warnedPath = true;
        obsDebug({ stage: 'OBS_NO_ROWS', path: String(location.pathname).substring(0, 60) });
      }
      return;
    }
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    obsDebug({ stage: 'HINT_SENT', threads: activity.threads.length, unread: activity.threads.filter((t) => t.is_unread).length, fp: fingerprint.substring(0, 10) });
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({
        type: 'SIDEBAR_ACTIVITY_HINT',
        data: { fingerprint, threads: activity.threads, observed_at: Date.now(), url: location.href }
      }).catch((err) => {
        obsDebug({ stage: 'HINT_SEND_FAIL', error: String(err && err.message || err).substring(0, 90) });
      });
    } catch (_) {}
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(emitIfChanged, 45);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-current', 'class', 'href']
  });
  const fallbackTimer = setInterval(emitIfChanged, 500);
  globalThis.__FB_CRM_SIDEBAR_ACTIVITY_OBSERVER__ = {
    disconnect() {
      observer.disconnect();
      clearInterval(fallbackTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
    }
  };
  obsDebug({ stage: 'OBS_INSTALLED', href: String(location.href).substring(0, 90) });
  schedule();
})();
