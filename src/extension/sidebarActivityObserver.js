// Additive realtime fallback for Messenger's conversation list.
(function installSidebarActivityObserver() {
  const previous = globalThis.__FB_CRM_SIDEBAR_ACTIVITY_OBSERVER__;
  if (previous?.disconnect) {
    try { previous.disconnect(); } catch (_) {}
  }

  let lastFingerprint = '';
  let debounceTimer = null;

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

  function readSidebarActivity() {
    if (!/\/messages(?:\/|$|\?)/i.test(location.pathname + location.search)) return { fingerprint: '', threads: [] };
    const selectors = [
      'a[href*="/messages/t/"]',
      'a[href*="/messages/e2ee/t/"]',
      'a[href*="/messages/requests/t/"]',
      'a[href*="/messages/requests/spam/t/"]',
      'a[href*="/messages/spam/t/"]'
    ].join(',');
    const seen = new Set();
    const rows = [];
    const threads = [];
    for (const link of document.querySelectorAll(selectors)) {
      const href = link.getAttribute('href') || link.href || '';
      const match = href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/i);
      const threadId = match ? decodeURIComponent(match[1]) : '';
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      const row = link.closest('[role="row"], [role="listitem"], li') || link.parentElement || link;
      const text = normalize(row.textContent).slice(0, 320);
      const unread = Boolean(row.querySelector('[data-testid="unread-count"], .unread, [aria-label*="unread" i], [aria-label*="Ch?a ??c" i]'));
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
      threads.push({
        thread_id: threadId,
        name: name.slice(0, 80),
        last_message: lastMessage,
        is_unread: unread,
        preview_is_outgoing: /^(?:Bạn|You)\s*:/i.test(lastMessage),
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
    if (!fingerprint || fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({
        type: 'SIDEBAR_ACTIVITY_HINT',
        data: { fingerprint, threads: activity.threads, observed_at: Date.now(), url: location.href }
      }).catch(() => {});
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
  schedule();
})();
