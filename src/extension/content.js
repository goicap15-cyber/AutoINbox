// AutoChatbot FB Engine - Content Script (Unified with Avatar Extraction)
(function () {
  // A boolean marker survives an extension/app reload in an already-open
  // Facebook tab. The old content-script context can no longer talk to
  // chrome.runtime, but that stale boolean used to make the replacement
  // script exit immediately. Keep a short-lived instance marker instead:
  // simultaneous injections are still collapsed, while a health-check
  // failure can install a fresh realtime observer in the existing page.
  const previousContentInstance = globalThis.__FB_CRM_CONTENT_ACTIVE__;
  const contentInstanceStartedAt = Date.now();
  if (previousContentInstance && typeof previousContentInstance === 'object'
    && contentInstanceStartedAt - Number(previousContentInstance.started_at || 0) < 5000) return;
  const contentInstance = {
    started_at: contentInstanceStartedAt,
    last_health_at: contentInstanceStartedAt
  };
  globalThis.__FB_CRM_CONTENT_ACTIVE__ = contentInstance;
  // Facebook sets c_user=0 as a placeholder while a page is mid-login/logged
  // out - a naive \d+ regex treats "0" as a real user id, which registered a
  // bogus "FB Account (0)" the moment an existing profile's session cookie
  // had expired and Facebook was showing a login screen (no actual login
  // action needed to trigger it).
  function sanitizeUserId(rawId) {
    if (!rawId) return null;
    const id = String(rawId).trim();
    return (!id || id === '0') ? null : id;
  }

  let capturedFbDtsg = null;
  let capturedUserId = sanitizeUserId(document.cookie.match(/c_user=(\d+)/)?.[1]);
  let capturedAccountName = '';
  let capturedAccountAvatarUrl = '';

  // BÃ¡ÂºÂ¯t crm_pending_key tÃ¡Â»Â« URL nÃ¡ÂºÂ¿u cÃƒÂ³ vÃƒÂ  lÃ†Â°u vÃƒÂ o chrome.storage.local
  const urlParams = new URLSearchParams(window.location.search);
  let pendingKeyFromUrl = urlParams.get('crm_pending_key');
  if (!pendingKeyFromUrl) {
    const nextParam = urlParams.get('next');
    if (nextParam) {
      try {
        const nextUrl = new URL(nextParam, window.location.origin);
        pendingKeyFromUrl = nextUrl.searchParams.get('crm_pending_key');
      } catch (_) {}
    }
  }
  if (pendingKeyFromUrl) {
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ crm_pending_key: pendingKeyFromUrl });
      }
    } catch (e) { }
  }

  // Keep the interactive login/PIN page lightweight. The document_start
  // pending-key script and background cookie watcher are sufficient during
  // setup; full DOM/message/call observers start after setup completes and
  // the tab is reloaded once without this marker.
  try {
    // A sessionStorage marker can survive an extension/app rebuild in the
    // existing tab. Only the explicit setup URL may suppress realtime hooks;
    // otherwise the marker can disable inbound messages indefinitely.
    if (pendingKeyFromUrl) {
      console.log('[FB Content] Heavy observers skipped during account setup.');
      return;
    }
  } catch (_) {}

  function stopAllRingtoneAudio() {
    try {
      var mediaEls = document.querySelectorAll('audio, video');
      for (var i = 0; i < mediaEls.length; i++) {
        var el = mediaEls[i];
        if (!el.paused) {
          try {
            el.pause();
            el.currentTime = 0;
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  function triggerCallAnswer(action, callback) {
    var targetLabel = action === 'accept' ? 'Ch\u1ea5p nh\u1eadn' : 'T\u1eeb ch\u1ed1i';
    var deadline = Date.now() + 5000;
    var completed = false;
    function finish(success) {
      if (completed) return;
      completed = true;
      callback?.(!!success);
    }
    function findExactButton() {
      // Additive fallback for Facebook's icon-only decline control.
      if (action === 'decline') {
        var defensiveDecline = findKnownMessengerDeclineButton() ||
          findCallButtonFromRingingText('decline') ||
          findRedIncomingCallDeclineButton();
        if (defensiveDecline) return defensiveDecline;
      }
      var selectors = action === 'accept'
        ? ['[aria-label="Ch\u1ea5p nh\u1eadn"][role="button"]', '[aria-label="Ch\u1ea5p nh\u1eadn"]', '[role="button"][aria-label*="Accept"]', '[role="button"][aria-label*="Answer"]']
        : ['[aria-label="T\u1eeb ch\u1ed1i"][role="button"]', '[aria-label="T\u1eeb ch\u1ed1i"]', '[role="button"][aria-label*="Decline"]', '[role="button"][aria-label*="Reject"]'];
      for (var i = 0; i < selectors.length; i++) {
        var exact = document.querySelector(selectors[i]);
        if (exact && isVisibleCallElement(exact)) return exact;
      }
      var allButtons = document.querySelectorAll('[role="button"], button');
      for (var j = 0; j < allButtons.length; j++) {
        var button = allButtons[j];
        if (!isVisibleCallElement(button)) continue;
        var txt = (button.textContent || '').trim();
        if (txt === targetLabel || txt.includes(targetLabel)) return button;
        if (callButtonIntent(button) === action) return button;
      }
      return null;
    }
    function attempt() {
      if (completed) return;
      var btn = findExactButton();
      if (btn) {
        try {
          btn.click();
          // Do not stop the ringtone here. Messenger may ignore an untrusted
          // HTMLElement.click(); the background verifies the control and
          // retries with a trusted CDP click before declaring success.
          finish(true);
          return;
        } catch (_) {}
      }
      if (Date.now() < deadline) window.setTimeout(attempt, 100);
      else finish(false);
    }
    attempt();
  }

  try {
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'FB_CRM_HEALTH_CHECK') {
          if (globalThis.__FB_CRM_CONTENT_ACTIVE__ !== contentInstance) return;
          contentInstance.last_health_at = Date.now();
          sendResponse?.({ success: true, thread_id: extractThreadIdFromUrl?.() || null });
          return;
        }
        if (msg.type === 'CLEAR_PENDING_KEY') {
          try {
            if (chrome?.storage?.local) {
              chrome.storage.local.remove(['crm_pending_key']);
            }
          } catch (e) {}
        }
        if (msg.type === 'ANSWER_INCOMING_CALL') {
          triggerCallAnswer(msg.action, (success) => sendResponse?.({ success }));
          return true;
        }
        if (msg.type === 'GET_INCOMING_CALL_BUTTON_RECT') {
          var candidate = findIncomingCallCandidate();
          var button = (candidate && (msg.action === 'accept' ? candidate.acceptButton : candidate.declineButton)) ||
            (msg.action === 'decline' ? (findKnownMessengerDeclineButton() || findCallButtonFromRingingText('decline') || findRedIncomingCallDeclineButton()) : null) ||
            findIncomingCallActionButton(msg.action);
          if (!button || !isVisibleCallElement(button)) {
            sendResponse?.({ success: false });
            return;
          }
          var rect = button.getBoundingClientRect();
          sendResponse?.({ success: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          return;
        }
      });
    }
  } catch (e) {}

  function normalizeTimestampMs(ts) {
    if (!ts) return null;
    let numericTs = Number(ts);
    if (isNaN(numericTs)) return null;
    // NÃ¡ÂºÂ¿u timestamp < 10000000000 (10 digits), nÃƒÂ³ lÃƒÂ  giÃƒÂ¢y -> nhÃƒÂ¢n 1000 ra mili giÃƒÂ¢y
    if (numericTs > 0 && numericTs < 10000000000) {
      numericTs *= 1000;
    }
    return numericTs;
  }

  // LÃ¡ÂºÂ¯ng nghe tin nhÃ¡ÂºÂ¯n tÃ¡Â»Â« injected.js (MAIN World Interceptor)
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FB_NETWORK_MESSAGE') {
      const netMsg = event.data.data;
      if (!netMsg || !netMsg.thread_id || !netMsg.content) return;
      
      capturedUserId = capturedUserId || sanitizeUserId(document.cookie.match(/c_user=(\d+)/)?.[1]);
      let sender_id = netMsg.sender_id || (netMsg.is_outgoing ? capturedUserId : null);
      let is_outgoing = netMsg.is_outgoing || false;
       // Ignore incomplete main-world fragments; DOM/history will provide the canonical row.
       if (!sender_id || !netMsg.fb_message_id) return;
      
      if (sender_id && capturedUserId && String(sender_id) === String(capturedUserId)) {
        is_outgoing = true;
      }
      if (is_outgoing) markObservedOutgoing(netMsg.thread_id, netMsg.content);

      const finalTsMs = normalizeTimestampMs(netMsg.timestamp_ms);

      try {
        if (chrome?.runtime?.id) {
          recentNetworkEmits.set(`${netMsg.thread_id}:${netMsg.content}`, Date.now());
          chrome.runtime.sendMessage({
            type: 'NEW_MESSAGE_FROM_FB',
            data: {
              thread_id: netMsg.thread_id,
              fb_message_id: netMsg.fb_message_id || null,
              sender_id: sender_id,
              sender_name: netMsg.sender_name || (is_outgoing ? 'BÃ¡ÂºÂ¡n' : ''),
              content: netMsg.content,
              is_outgoing: is_outgoing,
              source: 'network_interceptor',
              timestamp_ms: finalTsMs || null,
              timestamp_source: finalTsMs ? 'facebook_payload' : 'realtime_fallback',
              created_at: finalTsMs ? new Date(finalTsMs).toISOString() : (netMsg.created_at || new Date().toISOString())
            }
          });
        }
      } catch (e) {}
    }
    if (event.data && event.data.type === 'FB_TOKEN_DISCOVERED') {
      if (event.data.fb_dtsg) {
        capturedFbDtsg = event.data.fb_dtsg;
        capturedUserId = capturedUserId || sanitizeUserId(document.cookie.match(/c_user=(\d+)/)?.[1]);
        if (capturedFbDtsg && capturedUserId) {
          reportTokens(capturedFbDtsg, capturedUserId);
        }
      }
    }
  });

  const processedKeys = new Set();
  // Do not use text + timestamp as a packet key. Facebook may assign the same
  // second timestamp to several physical bubbles (v, v, v, v). The old key
  // silently discarded every occurrence after the first one.
  let fallbackNetworkObservation = 0;
  function networkPacketIdentity(prefix, threadId, payload, timestampMs) {
    const nativeId = payload && (
      payload.message_id || payload.messageId || payload.offline_threading_id || payload.id ||
      payload?.metadata?.message_id || payload?.metadata?.messageId
    );
    if (nativeId) return `${prefix}_mid_${String(nativeId)}`;
    fallbackNetworkObservation += 1;
    return `${prefix}_${String(threadId || '')}_${Number(timestampMs) || Date.now()}_${fallbackNetworkObservation}`;
  }
  const recentNetworkEmits = new Map();
  const recentDomEmits = new Map();
  const isDedicatedBackgroundTab = /(?:[?&])crm_tab_role=(?:history|discovery|requests|request_action)/i.test(window.location.search);
  // Direction ledger: Messenger may replay a rendered outgoing bubble as an
  // incoming DOM row while React hydrates its aria metadata.
  const recentObservedOutgoing = new Map();
  function normalizeObservedText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
  }
  function markObservedOutgoing(threadId, content) {
    const normalized = normalizeObservedText(content);
    if (!threadId || !normalized) return;
    const key = `${String(threadId)}:${normalized}`;
    recentObservedOutgoing.set(key, Date.now());
    if (recentObservedOutgoing.size > 500) recentObservedOutgoing.delete(recentObservedOutgoing.keys().next().value);
  }
  function isRecentObservedOutgoing(threadId, content) {
    const normalized = normalizeObservedText(content);
    const key = `${String(threadId || '')}:${normalized}`;
    const at = recentObservedOutgoing.get(key) || 0;
    if (!at) return false;
    if (Date.now() - at > 10 * 60 * 1000) { recentObservedOutgoing.delete(key); return false; }
    return true;
  }
  const domOccurrenceIds = new WeakMap();
  let nextDomOccurrenceId = 1;
  function markDomOccurrence(parsed, sourceNode) {
    // A MutationObserver callback can be rooted at a shared wrapper that
    // contains several new bubbles. Use the exact article/row discovered by
    // the parser first; using callback sourceNode made c,c,c share one fallback
    // id and only the first bubble reached CRM.
    const parsedAnchor = parsed?.dom_anchor;
    const anchor = parsedAnchor?.closest?.('[role=article], [role=row]') || parsedAnchor
      || sourceNode?.closest?.('[role=article], [role=row]') || sourceNode;
    if (!anchor || typeof anchor !== 'object') return parsed;
    if (!domOccurrenceIds.has(anchor)) domOccurrenceIds.set(anchor, nextDomOccurrenceId++);
    parsed.dom_occurrence_id = domOccurrenceIds.get(anchor);
    return parsed;
  }

  function decodeFacebookString(value) {
    try { return JSON.parse(`"${value}"`); } catch (_) { return String(value || ''); }
  }

  function extractCurrentFacebookAccountName(userId, scripts) {
    const safeUserId = String(userId || '').replace(/[^0-9]/g, '');
    if (!safeUserId) return '';
    const patterns = [
      new RegExp(`"ACCOUNT_ID":"${safeUserId}"[\\s\\S]{0,1200}?"NAME":"((?:\\\\.|[^"\\\\])*)"`),
      new RegExp(`"USER_ID":"${safeUserId}"[\\s\\S]{0,1200}?"NAME":"((?:\\\\.|[^"\\\\])*)"`),
      new RegExp(`"NAME":"((?:\\\\.|[^"\\\\])*)"[\\s\\S]{0,500}?"ACCOUNT_ID":"${safeUserId}"`)
    ];
    for (const script of scripts || []) {
      const source = script.textContent || '';
      if (!source.includes(safeUserId)) continue;
      for (const pattern of patterns) {
        const match = source.match(pattern);
        const candidate = decodeFacebookString(match?.[1] || '').trim();
        if (candidate && candidate.length <= 100 && !/^(facebook|messenger)$/i.test(candidate)) return candidate;
      }
    }
    return '';
  }
  function extractCurrentFacebookAccountAvatar(userId, scripts) {
    const safeUserId = String(userId || '').replace(/[^0-9]/g, '');
    if (!safeUserId) return '';
    const patterns = [
      new RegExp(`"ACCOUNT_ID":"${safeUserId}"[\\s\\S]{0,1800}?"PROFILE_PICTURE_URI":"((?:\\\\.|[^"\\\\])*)"`),
      new RegExp(`"USER_ID":"${safeUserId}"[\\s\\S]{0,1800}?"PROFILE_PICTURE_URI":"((?:\\\\.|[^"\\\\])*)"`),
      new RegExp(`"ACCOUNT_ID":"${safeUserId}"[\\s\\S]{0,1800}?"profile_picture":\\{"uri":"((?:\\\\.|[^"\\\\])*)"`),
      new RegExp(`"PROFILE_PICTURE_URI":"((?:\\\\.|[^"\\\\])*)"[\\s\\S]{0,700}?"ACCOUNT_ID":"${safeUserId}"`)
    ];
    for (const script of scripts || []) {
      const source = script.textContent || '';
      if (!source.includes(safeUserId)) continue;
      for (const pattern of patterns) {
        const match = source.match(pattern);
        const candidate = decodeFacebookString(match?.[1] || '').trim();
        if (/^https?:\/\//i.test(candidate) && candidate.length <= 4096) return candidate;
      }
    }
    const accountAvatarSelectors = [
      '[aria-label*="profile" i] img, [aria-label*="profile" i] image',
      '[aria-label*="account" i] img, [aria-label*="account" i] image',
      '[aria-label*="trang cÃƒÂ¡ nhÃƒÂ¢n" i] img, [aria-label*="trang cÃƒÂ¡ nhÃƒÂ¢n" i] image',
      '[aria-label*="tÃƒÂ i khoÃ¡ÂºÂ£n" i] img, [aria-label*="tÃƒÂ i khoÃ¡ÂºÂ£n" i] image',
      '[role="banner"] img, [role="banner"] image',
      '[role="navigation"] img, [role="navigation"] image'
    ];
    for (const selector of accountAvatarSelectors) {
      for (const node of document.querySelectorAll(selector)) {
        const candidate = String(
          node.currentSrc || node.src || node.href?.baseVal
          || node.getAttribute?.('href') || node.getAttribute?.('xlink:href') || ''
        ).trim();
        if (/^https?:\/\//i.test(candidate) && candidate.length <= 4096) return candidate;
      }
    }    return '';
  }
  function reportTokens(fb_dtsg, user_id) {
    if (!user_id) return;
    try {
      if (chrome?.runtime?.id) {
        if (chrome?.storage?.local) {
          chrome.storage.local.get(['crm_pending_key'], (res) => {
            const pending_key = res?.crm_pending_key || pendingKeyFromUrl || null;
            chrome.runtime.sendMessage({ type: 'FB_TOKENS_EXTRACTED', data: { fb_dtsg: fb_dtsg || '', user_id, pending_key, name: capturedAccountName || null, avatar_url: capturedAccountAvatarUrl || null } });
          });
        } else {
          chrome.runtime.sendMessage({ type: 'FB_TOKENS_EXTRACTED', data: { fb_dtsg: fb_dtsg || '', user_id, pending_key: pendingKeyFromUrl || null, name: capturedAccountName || null, avatar_url: capturedAccountAvatarUrl || null } });
        }
      }
    } catch (e) { }
  }

  function extractFbTokensFromDOM() {
    if (!capturedUserId) {
      capturedUserId = sanitizeUserId(document.cookie.match(/c_user=(\d+)/)?.[1]);
    }
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!capturedUserId) {
        const uMatch = text.match(/"USER_ID":"(\d+)"/) || text.match(/"actorID":"(\d+)"/) || text.match(/"ACCOUNT_ID":"(\d+)"/);
        if (uMatch) capturedUserId = sanitizeUserId(uMatch[1]);
      }
      if (!capturedFbDtsg) {
        if (text.includes('DTSGInitialData') || text.includes('DTSGInitData') || text.includes('fb_dtsg')) {
          const match = text.match(/"token":"([^"]+)"/) || text.match(/"fb_dtsg":"([^"]+)"/) || text.match(/"async_get_token":"([^"]+)"/);
          if (match) capturedFbDtsg = match[1];
        }
      }
    }
    if (!capturedAccountName && capturedUserId) {
      capturedAccountName = extractCurrentFacebookAccountName(capturedUserId, scripts);
    }
    if (!capturedAccountAvatarUrl && capturedUserId) {
      capturedAccountAvatarUrl = extractCurrentFacebookAccountAvatar(capturedUserId, scripts);
    }
    const inputEl = document.querySelector('input[name="fb_dtsg"]');
    if (inputEl?.value) { capturedFbDtsg = inputEl.value; }

    if (capturedUserId) {
      reportTokens(capturedFbDtsg, capturedUserId);
    }
  }


  // WebSocket interceptor
  function patchWebSocket() {
    if (window._fb_ws_patched) return; window._fb_ws_patched = true;
    const origWebSocket = window.WebSocket;
    window.WebSocket = function (url, ...args) {
      const ws = new origWebSocket(url, args);
      ws.addEventListener('message', function (e) {
        const data = e.data;
        if (typeof data !== 'string') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.actions) parsed.actions.forEach(action => {
            if ((action.type === 'chat' || action.body) && action.body) {
              const thread_id = action.thread_fbid || action.thread_id;
              const sender_id = action.actor_fbid || action.sender_fbid || action.sender_user_id;
              const content = action.body;
              const timestampMs = normalizeTimestampMs(action.timestamp || Date.now());
              const packetId = networkPacketIdentity('ws', thread_id, action, timestampMs);
              const cacheKey = packetId;
              if (processedKeys.has(cacheKey)) return; processedKeys.add(cacheKey);
              if (processedKeys.size > 1000) processedKeys.delete(processedKeys.values().next().value);
              recentNetworkEmits.set(`${thread_id}:${content}`, Date.now());
              if (recentNetworkEmits.size > 500) recentNetworkEmits.delete(recentNetworkEmits.keys().next().value);
              if (chrome?.runtime?.id) {
                try {
                  capturedUserId = capturedUserId || document.cookie.match(/c_user=(\d+)/)?.[1] || null;
                  const is_outgoing = !!(sender_id && capturedUserId && String(sender_id) === String(capturedUserId));
                  if (is_outgoing) markObservedOutgoing(thread_id, content);
                  const fbMsgId = packetId;
                  chrome.runtime.sendMessage({
                    type: 'NEW_MESSAGE_FROM_FB',
                    data: {
                      thread_id,
                      sender_id,
                      content,
                      is_outgoing,
                      fb_message_id: fbMsgId,
                      media_type: 'text',
                      timestamp_ms: timestampMs || null,
                      timestamp_source: action.timestamp ? 'facebook_payload' : 'realtime_fallback',
                      created_at: new Date(timestampMs).toISOString(),
                      source: 'websocket'
                    }
                  });
                } catch (err) { }
              }
            }
          });
          if (parsed.payload_push?.mutations) parsed.payload_push.mutations.forEach(mut => {
            if (mut.path?.thread_key?.fbid2 || mut.path?.thread_key?.second_fbid) {
              const thread_id = mut.path.thread_key.fbid2 || mut.path.thread_key.second_fbid;
              if (mut.args?.[0]?.body) {
                const content = mut.args[0].body;
                const sender_id = mut.args[0].actor_fbid || mut.args[0].sender_fbid;
                const tsMs = normalizeTimestampMs(mut.args[0].timestamp || Date.now());
                const packetId = networkPacketIdentity('mercury', thread_id, mut.args[0], tsMs);
                const cacheKey = packetId;
                if (!processedKeys.has(cacheKey)) {
                  processedKeys.add(cacheKey); 
                  recentNetworkEmits.set(`${thread_id}:${content}`, Date.now());
                  if (recentNetworkEmits.size > 500) recentNetworkEmits.delete(recentNetworkEmits.keys().next().value);
                  try {
                    if (chrome?.runtime?.id) {
                      capturedUserId = capturedUserId || document.cookie.match(/c_user=(\d+)/)?.[1] || null;
                      const is_outgoing = !!(sender_id && capturedUserId && String(sender_id) === String(capturedUserId));
      if (is_outgoing) markObservedOutgoing(thread_id, content);
                                  if (is_outgoing) markObservedOutgoing(thread_id, content);
                      console.log(`[Content Interceptor] mercury mutation intercepted message: thread_id=${thread_id} | content="${content.substring(0, 40)}"`);
                      chrome.runtime.sendMessage({
                        type: 'NEW_MESSAGE_FROM_FB',
                        data: {
                          thread_id,
                          sender_id,
                          content,
                          is_outgoing: is_outgoing,
                          fb_message_id: packetId,
                          media_type: 'text',
                          timestamp_ms: mut.args[0].timestamp ? tsMs : null,
                          timestamp_source: mut.args[0].timestamp ? 'facebook_payload' : 'realtime_fallback',
                          created_at: new Date(tsMs).toISOString(),
                          source: 'mercury'
                        }
                      });
                    }
                  } catch (err) { }
                }
              }
            }
          });
        } catch (err) { }
      });
      return ws;
    };
  }

  // XHR interceptor
  function patchXHR() {
    if (window._fb_xhr_patched) return; window._fb_xhr_patched = true;
    const origXHROpen = XMLHttpRequest.prototype.open, origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...args) { this._fbUrl = url; return origXHROpen.call(this, method, url, ...args); };
    XMLHttpRequest.prototype.send = function (...args) {
      const urlStr = this._fbUrl?.toString?.() || '';
      if (urlStr.includes('/api/graphql/') || urlStr.includes('graphql')) tryExtractDtsgFromBody(args[0]);
      this.addEventListener('load', function () { try { if (urlStr.includes('/api/graphql/') || urlStr.includes('ajax/mercury/')) tryParseMessages(this.responseText); } catch (e) { } });
      return origXHRSend.call(this, ...args);
    };
  }

  function tryExtractDtsgFromBody(body) {
    if (!body || typeof body !== 'string') return;
    const match = body.match(/fb_dtsg=([^&\s]+)/);
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded && decoded !== capturedFbDtsg) {
        capturedFbDtsg = decoded; capturedUserId = document.cookie.match(/c_user=(\d+)/)?.[1] || capturedUserId; reportTokens(capturedFbDtsg, capturedUserId);
      }
    }
  }

  // Fetch interceptor
  function patchFetch() {
    if (window._fb_fetch_patched) return; window._fb_fetch_patched = true;
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/graphql/') || url.includes('graphql')) {
        const body = init?.body; if (typeof body === 'string') tryExtractDtsgFromBody(body);
      }
      const response = await origFetch.call(this, input, init);
      try { if (url.includes('/api/graphql/') || url.includes('ajax/mercury/')) response.clone().text().then(text => { tryParseMessages(text); }).catch(() => { }); } catch (e) { }; return response;
    };
  }

  // Parse messages from XHR/Fetch response
  function tryParseMessages(text) {
    try {
      const bodyRegex = /"body":"((?:[^"\\]|\\.)*)"/g;
      const threadRegex = /"thread_fbid":"?(\d+)"?|"threadFbId":"?(\d+)"?/;
      const senderRegex = /"actorFbId":"?(\d+)"?|"sender_fbid":"?(\d+)"?/;
      const timestampRegex = /"timestamp":"?(\d+)"?|"timestamp_precise":"?(\d+)"?/;
      const threadMatch = text.match(threadRegex); if (!threadMatch) return;
      const thread_id = threadMatch[1] || threadMatch[2];
      const senderMatch = text.match(senderRegex);
      const sender_id = senderMatch ? (senderMatch[1] || senderMatch[2]) : null;
      const tsMatch = text.match(timestampRegex);
      const timestampMs = tsMatch ? normalizeTimestampMs(tsMatch[1] || tsMatch[2]) : null;
      let match, bodies = [];
      while ((match = bodyRegex.exec(text)) !== null) {
        const msgText = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (msgText && msgText.length > 0 && msgText.length < 5000) bodies.push(msgText);
      }
      if (bodies.length === 0) return;
      const content = bodies[bodies.length - 1];
      const rawMessageIdMatch = text.match(/"(?:message_id|messageId)"\s*:\s*"([^"]+)"/);
       // A generic XHR response can contain an unrelated final body. Require
       // actor and durable id; DOM/history covers any incomplete frame.
       if (!sender_id || !rawMessageIdMatch?.[1]) return;
       const packetId = networkPacketIdentity('xhr', thread_id, { message_id: rawMessageIdMatch[1] }, timestampMs);
      const cacheKey = packetId;
      if (processedKeys.has(cacheKey)) return;
      processedKeys.add(cacheKey);
      if (processedKeys.size > 500) processedKeys.delete(processedKeys.values().next().value);
      recentNetworkEmits.set(`${thread_id}:${content}`, Date.now());
      if (recentNetworkEmits.size > 500) recentNetworkEmits.delete(recentNetworkEmits.keys().next().value);
      capturedUserId = capturedUserId || document.cookie.match(/c_user=(\d+)/)?.[1] || null;
      const is_outgoing = !!(sender_id && capturedUserId && String(sender_id) === String(capturedUserId));
      if (is_outgoing) markObservedOutgoing(thread_id, content);
      try {
        if (chrome?.runtime?.id) {
          console.log(`[Content Interceptor] network_xhr intercepted message: thread_id=${thread_id} | content="${content.substring(0, 40)}"`);
          chrome.runtime.sendMessage({
            type: 'NEW_MESSAGE_FROM_FB',
            data: {
              thread_id,
              sender_id,
              content,
              is_outgoing,
              fb_message_id: packetId,
              media_type: 'text',
              timestamp_ms: timestampMs,
              timestamp_source: timestampMs ? 'facebook_payload' : 'realtime_fallback',
              created_at: new Date(timestampMs || Date.now()).toISOString(),
              source: 'network_xhr'
            }
          });
        }
      } catch (e) { }
    } catch (e) { }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ DOM Observer with Avatar Extraction Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Map<fbMessageId, lastForwardedIsOutgoing> rather than a plain Set: an id is
  // now stable across direction-unstable re-scans of the same message (spec
  // 045), so "already observed" alone can no longer gate resending - a re-scan
  // that disagrees on direction must still reach the server (with the SAME id)
  // so ConversationRepository.reconcileExistingMessage's hysteresis (spec 019)
  // gets a chance to resolve it, instead of being silently dropped forever.
  let lastObservedMessages = new Map();

  // Messenger mounts an article before its media URL is hydrated. Let the
  // same stable message id pass again only when its payload becomes richer.
  function domObservationSignature(parsed) {
    return [
      parsed?.is_outgoing ? 'out' : 'in',
      parsed?.media_type || 'text',
      parsed?.media_url || '',
      parsed?.content || ''
    ].join('|');
  }

  function extractThreadIdFromUrl() {
    const match = document.location.href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/) || 
                  document.location.href.match(/\/messages\/t\/(\d+)/);
    if (match && /^\d+$/.test(match[1])) {
      return match[1];
    }
    return null;
  }

  const EXCLUDED_PATTERNS = [
    /Messenger/i,
    /CuÃ¡Â»â„¢c gÃ¡Â»Âi video/i,
    /CuÃ¡Â»â„¢c gÃ¡Â»Âi thoÃ¡ÂºÂ¡i/i,
    /BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ bÃ¡Â»Â lÃ¡Â»Â¡ cuÃ¡Â»â„¢c gÃ¡Â»Âi/i,
    /Meta/i,
    /Trang chÃ¡Â»Â§/i,
    /Watch/i,
    /Marketplace/i,
    /NhÃƒÂ³m$/i,
    /ThÃƒÂ´ng bÃƒÂ¡o$/i,
  ];

  // Shared bubble-text cleanup, extracted so both the per-bubble text loop
  // and the image-caption extraction below use the exact same rules.
  function cleanBubbleText(rawText) {
    let cleanText = (rawText || '').trim();
    if (!cleanText) return '';
    const filter = globalThis.FbCrmTextFilter;
    if (filter?.cleanMessageText) {
      cleanText = filter.cleanMessageText(cleanText);
    } else {
      cleanText = cleanText.replace(/^(?:NhÃ¡ÂºÂ­p,\s*)?Tin nhÃ¡ÂºÂ¯n do [\s\S]+? gÃ¡Â»Â­i lÃƒÂºc [^\n]*?(?:ch:|\b\d{1,2}:\d{2}(?:ch)?:|\b\d{1,2}:\d{2}(?:ch)?\s+)\s*/i, '').trim();
      cleanText = cleanText.replace(/^NhÃ¡ÂºÂ­p,\s*/i, '').trim();
      cleanText = cleanText.replace(/^[:\s]+/, '').trim();
      const sentEmojiMatch = cleanText.match(/^[^,\n]{1,80}\s+(?:Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i|sent),\s*(.+)$/i);
      if (sentEmojiMatch) {
        const payload = sentEmojiMatch[1].trim();
        if (payload && !/[A-Za-zÃƒâ‚¬-Ã¡Â»Â¹0-9]/.test(payload)) cleanText = payload;
      }
      cleanText = cleanText.replace(/(?:\n|\r|\s{2,})(?:Ã„ÂÃƒÂ£ gÃ¡Â»Â­i|Ã„ÂÃƒÂ£ nhÃ¡ÂºÂ­n|Ã„ÂÃƒÂ£ xem|Sent|Delivered|Seen|NhÃ¡ÂºÂ¥n Enter Ã„â€˜Ã¡Â»Æ’ gÃ¡Â»Â­i)\s*$/i, '').trim();
      cleanText = cleanText.replace(/(?<=\S)(?:Ã„ÂÃƒÂ£ gÃ¡Â»Â­i|Ã„ÂÃƒÂ£ nhÃ¡ÂºÂ­n|Ã„ÂÃƒÂ£ xem|Sent|Delivered|Seen)$/i, '').trim();
      cleanText = cleanText.replace(/^\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?\s*$/i, '').replace(/(?:\n|\r)\s*\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?$/i, '').trim();
      cleanText = cleanText.replace(/^[:\s]+/, '').trim();
    }
    return cleanText;
  }

  // Personal Messenger renders many emoji as an image/SVG;
  // they are absent from textContent. Read only short pictographic labels so
  // avatar names and accessibility prose can never become chat content.
  // NOTE: Quick-like (Ã°Å¸â€˜Â hover button / "ThÃƒÂ­ch") detection is intentionally
  // removed Ã¢â‚¬â€œ the floating reaction button shares the same aria-label as a
  // real Like message, causing ghost Ã°Å¸â€˜Â entries in CRM every time a message
  // is sent. We no longer report quick-likes from the left side at all.
  function extractBubbleEmoji(container) {
    if (!container?.querySelectorAll) return '';
    const candidates = container.querySelectorAll('img[alt], [aria-label], [title], svg title');
    for (const element of candidates) {
      const exactReceivedLikeTitle = element.tagName === 'TITLE'
        && /^(?:k\u00fd hi\u1ec7u gi\u01a1 ng\u00f3n tay c\u00e1i|thumbs up symbol)$/i.test(String(element.textContent || '').trim());
      if (exactReceivedLikeTitle) return 'Ã°Å¸â€˜Â';
      // Controls for Like/reaction are UI, not message content.
      if (element.matches?.('[role="button"], button') || element.closest?.('[role="button"], button')) continue;
      // Messenger's Like glyph is currently an SVG whose human label lives in
      // a child <title>, e.g. <title>KÃƒÂ½ hiÃ¡Â»â€¡u giÃ†Â¡ ngÃƒÂ³n tay cÃƒÂ¡i</title>.
      const value = String(
        element.getAttribute('alt') || element.getAttribute('aria-label') || element.getAttribute('title')
        || (element.tagName === 'TITLE' ? element.textContent : '') || ''
      ).trim();
      if (!value) continue;
      // Only match when the attribute value IS itself an emoji character
      // (e.g. alt="Ã°Å¸â€˜Â", alt="Ã¢ÂÂ¤Ã¯Â¸Â"). Word-based labels like "ThÃƒÂ­ch"/"Like"/
      // "thumbs up" are deliberately excluded to prevent the hover Like
      // button from being mistaken for a real customer message.
      if (value.length <= 16 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u20D0-\u20FF]*$/u.test(value)) return value;
      // Match the exact SVG <title> used by Messenger's received Like.
      // The hover control remains excluded above because it is a button.
      if (/(?:giÃ†Â¡ ngÃƒÂ³n tay cÃƒÂ¡i|thumbs?\s*up|\blike\b|thÃƒÂ­ch|Ã°Å¸â€˜Â)/i.test(value)
        && (element.matches?.('img, svg, title, [role="img"]') || element.closest?.('svg'))) return 'Ã°Å¸â€˜Â';    }
    // Fallback: textContent of container itself is a single pictographic character
    const directText = (container.textContent || '').trim();
    if (directText.length <= 4 && /^\p{Extended_Pictographic}+$/u.test(directText)) return directText;
    return '';
  }


  function isClockMinuteFragment(value, label) {
    const normalized = String(value || '').trim().replace(/\s+/g, '');
    const fragment = normalized.match(/^(\d{1,2})(?:sÃƒÂ¡ng|chiÃ¡Â»Âu|tÃ¡Â»â€˜i|am|pm|sa|ch)?$/i);
    if (!fragment) return false;
    const match = String(label || '').match(/\b\d{1,2}:(\d{2})\b/);
    return !!match && Number(fragment[1]) === Number(match[1]);
  }


  function parseMessagesFromDOMNode(node, isRealtime = false) {
    if (!node || node.nodeType !== 1) return [];

    // Ã¢â€â‚¬Ã¢â€â‚¬ Composer/UI exclusion tuyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»â€˜i Ã¢â€â‚¬Ã¢â€â‚¬
    const COMPOSER_EXCLUDE = 'form, [contenteditable="true"], [role="textbox"], [aria-label="Aa"], [aria-label="Tin nhÃ¡ÂºÂ¯n"], [aria-label*="composer"], [aria-label*="SoÃ¡ÂºÂ¡n"], [role="contentinfo"], header, nav, [role="complementary"], [aria-label*="ThÃƒÂ´ng tin vÃ¡Â»Â Ã„â€˜oÃ¡ÂºÂ¡n chat"], [aria-label*="Conversation information"], [aria-label*="Chi tiÃ¡ÂºÂ¿t cuÃ¡Â»â„¢c trÃƒÂ² chuyÃ¡Â»â€¡n"]';

    // Ã„ÂÃ¡ÂºÂ£m bÃ¡ÂºÂ£o node nÃ¡ÂºÂ±m trong vÃƒÂ¹ng chat trung tÃƒÂ¢m main, khÃƒÂ´ng nÃ¡ÂºÂ±m trong composer/header/nav
    const inMain = node.closest?.('div[role="main"]');
    const inComposer = node.closest?.(COMPOSER_EXCLUDE);
    if (!inMain || inComposer) return [];

    // Ã¢â€â‚¬Ã¢â€â‚¬ XÃƒÂ¡c minh node thuÃ¡Â»â„¢c hoÃ¡ÂºÂ·c chÃ¡Â»Â©a message row thÃ¡ÂºÂ­t Ã¢â€â‚¬Ã¢â€â‚¬
    // Facebook Ã„â€˜ÃƒÂ£ chuyÃ¡Â»Æ’n message container tÃ¡Â»Â« role="row" sang role="article"
    // (xÃƒÂ¡c nhÃ¡ÂºÂ­n qua live DOM inspection 2026-08-13) - mÃ¡Â»â„¢t tin Ã¡ÂºÂ£nh cÃƒÂ³ caption
    // hiÃ¡Â»Æ’n thÃ¡Â»â€¹ caption vÃƒÂ  <img> dÃ†Â°Ã¡Â»â€ºi dÃ¡ÂºÂ¡ng 2 node con riÃƒÂªng biÃ¡Â»â€¡t cÃ¡Â»Â§a cÃƒÂ¹ng 1
    // article; MutationObserver chÃ¡Â»â€° bÃƒÂ¡o node vÃ¡Â»Â«a thÃƒÂªm (thÃ†Â°Ã¡Â»Âng lÃƒÂ  node caption
    // nhÃ¡Â»Â), nÃƒÂªn phÃ¡ÂºÂ£i leo lÃƒÂªn article mÃ¡Â»â€ºi thÃ¡ÂºÂ¥y Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ£ <img> anh em cÃ¡Â»Â§a nÃƒÂ³.
    const directRowMatch = node.closest?.('div[role="article"]') || node.closest?.('div[role="row"]');
    if (!directRowMatch) {
      // node isn't itself scoped to a single row - check whether it's a bulk
      // container holding MULTIPLE separate rows (e.g. Facebook mounting a
      // whole thread's worth of content at once on a fresh/cold profile's
      // initial load, or a large virtualization re-render) before falling
      // back to treating the whole thing as one row below. Live evidence
      // (2026-08-20, fresh Chrome-for-Testing profile): a page's intro card
      // (follower count, category tag, "conversation details" link) and
      // several unrelated real messages all got merged into ONE fake "row"
      // this way, sharing the SAME arbitrary native_id and SAME arbitrary
      // direction reading (whichever nested element the querySelector calls
      // below happened to match first) - producing both garbage-as-message
      // rows AND ghost duplicates of already-seen real messages with a
      // flipped direction. Recursing per actual row gives each one its own
      // correctly-scoped native_id/direction lookup instead.
      const nestedRows = node.querySelectorAll('div[role="article"], div[role="row"]');
      if (nestedRows.length > 1) {
        let combined = [];
        for (const row of nestedRows) {
          combined = combined.concat(parseMessagesFromDOMNode(row, isRealtime));
        }
        return combined;
      }
    }
    const messageRow = directRowMatch || node;
    let rowEmojiContent = extractBubbleEmoji(messageRow);

    // Ã¢â€â‚¬Ã¢â€â‚¬ STALE DOM GUARD (Self-Tagging Marker) Ã¢â€â‚¬Ã¢â€â‚¬
    if (messageRow && messageRow.dataset) {
      const currentUrlThreadId = extractThreadIdFromUrl();
      const existingThreadId = messageRow.dataset.crmThreadId;
      if (existingThreadId && currentUrlThreadId && existingThreadId !== currentUrlThreadId) {
        return []; // BÃ¡Â»Â qua vÃƒÂ¬ Ã„â€˜ÃƒÂ¢y lÃƒÂ  DOM cÃ¡Â»Â§a thread cÃ…Â©!
      }
      if (currentUrlThreadId) {
        messageRow.dataset.crmThreadId = currentUrlThreadId;
      }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Media detection (Ã¡ÂºÂ£nh gÃ¡Â»Â­i/nhÃ¡ÂºÂ­n trÃƒÂªn Messenger cÃƒÂ¡ nhÃƒÂ¢n) Ã¢â€â‚¬Ã¢â€â‚¬
    // Live DOM inspection (2026-08-13, real sent-photo message) found the
    // photo <img>'s alt is always the fixed UI action label "MÃ¡Â»Å¸ Ã¡ÂºÂ£nh" ("Open
    // photo") - not empty, and not a description. An avatar/read-receipt
    // <img> next to a bubble always carries the contact's real name instead
    // (e.g. alt="Thu Oanh Nguyen" or "Thu Oanh Nguyen Ã„â€˜ÃƒÂ£ xem lÃƒÂºc..."), so
    // matching on this fixed label (rather than "alt is empty", which does
    // NOT hold here) reliably tells a sent/received photo apart from an
    // avatar without ever matching a real name. The <img> src for a
    // just-sent photo is often an inline `data:image/...;base64,...`
    // thumbnail rather than a real fbcdn/scontent URL - only forward src as
    // media_url when it's a real CDN link (an unusable, multi-KB data: URI
    // has no value to the backend, which never uses this value for
    // confirmation matching - only media_type - and would just waste a
    // failed download attempt in MediaDownloader).
    //
    // Checked BEFORE the aria-label-based hasMessageLabel gate below and
    // used to bypass it entirely when a photo is found: live testing showed
    // an image-only row's accessibility label (the "Tin nhÃ¡ÂºÂ¯n do ... gÃ¡Â»Â­i
    // lÃƒÂºc" helper text) is not always present yet at the exact moment
    // MutationObserver's callback fires - React appears to hydrate it a
    // beat after inserting the <img> itself - so gating on that label made
    // every real-time photo detection silently miss (return []) while the
    // *separate*, later-arriving caption-only row (which has its own label
    // already attached) went through fine. The <img alt="MÃ¡Â»Å¸ Ã¡ÂºÂ£nh"> itself is
    // static markup set at creation time, not hydrated later, so it doesn't
    // have this race and is sufficient proof on its own that this is a real
    // message row, not composer/avatar/unrelated UI.
    const OPEN_PHOTO_ALT_PATTERN = /^(?:MÃ¡Â»Å¸ Ã¡ÂºÂ£nh|Xem Ã¡ÂºÂ£nh|Open photo|View photo)$/i;
    const OPEN_VIDEO_LABEL_PATTERN = /(?:ph\u00e1t|m\u1edf|xem|play|open|watch)?\s*video/i;
    let isPhotoMessage = false;
    let isVideoMessage = false;
    let mediaUrl = null;
    const rowImgs = messageRow.querySelectorAll?.('img[src]') || [];
    for (const img of rowImgs) {
      if (img.closest(COMPOSER_EXCLUDE)) continue;
      const src = img.getAttribute('src') || '';
      const alt = (img.getAttribute('alt') || '').trim();
      if (src && OPEN_PHOTO_ALT_PATTERN.test(alt)) {
        isPhotoMessage = true;
        mediaUrl = /^https?:\/\/.*(?:fbcdn\.net|scontent)/i.test(src) ? src : null;
        break;
      }
    }

    // Some Messenger builds omit the Open-photo alt text while the image is
    // hydrating. A large visible image inside one message row is still media;
    // avatars, receipts and emoji stay below this size threshold.
    if (!isPhotoMessage) {
      const largeImage = Array.from(rowImgs).find((img) => {
        if (img.closest(COMPOSER_EXCLUDE)) return false;
        const rect = img.getBoundingClientRect?.();
        const width = Number(rect?.width || img.naturalWidth || 0);
        const height = Number(rect?.height || img.naturalHeight || 0);
        return width >= 96 && height >= 96;
      });
      if (largeImage) {
        const source = largeImage.currentSrc || largeImage.getAttribute('src') || '';
        isPhotoMessage = true;
        mediaUrl = /^(?:https?:\/\/|data:image\/)/i.test(source) ? source : null;
      }
    }

    const rowVideos = messageRow.querySelectorAll?.('video') || [];
    for (const video of rowVideos) {
      if (video.closest(COMPOSER_EXCLUDE)) continue;
      const label = (video.getAttribute('aria-label') || video.getAttribute('title') || '').trim();
      const sourceCandidates = [
        video.currentSrc,
        video.getAttribute('src'),
        ...Array.from(video.querySelectorAll('source[src]')).map((source) => source.getAttribute('src'))
      ].filter(Boolean);
      const source = sourceCandidates.find((candidate) => /^https?:\/\//i.test(candidate)) || sourceCandidates[0] || '';
      if (source || OPEN_VIDEO_LABEL_PATTERN.test(label) || video.closest('[aria-label*="video" i]')) {
        isVideoMessage = true;
        // A blob URL only works inside Facebook, and poster is not a playable
        // video. Wait for a durable CDN URL instead of poisoning the CRM row.
        const poster = video.poster || video.getAttribute('poster') || '';
        // A performance entry belongs to the page, not to this message row.
        // Reusing the newest entry assigned one customer's video to several
        // different rows. Only row-scoped sources/posters are safe here.
        mediaUrl = /^https?:\/\//i.test(source)
          ? source
          : (/^(?:https?:\/\/|data:image\/)/i.test(poster) ? poster : null);
        break;
      }
    }
    if (!isVideoMessage) {
      const videoControl = Array.from(messageRow.querySelectorAll?.('[aria-label], a[href]') || []).find((element) => {
        const label = (element.getAttribute('aria-label') || '').trim();
        const href = element.getAttribute('href') || '';
        return OPEN_VIDEO_LABEL_PATTERN.test(label) || /\/(?:watch|videos|reel)\//i.test(href) || /\.mp4(?:\?|$)/i.test(href);
      });
      if (videoControl) {
        isVideoMessage = true;
        const href = videoControl.href || videoControl.getAttribute('href') || '';
        mediaUrl = /^https?:\/\/.*\.mp4(?:\?|$)/i.test(href) ? href : null;
      }
    }
    if (!isVideoMessage) {
      const semanticVideo = Array.from(messageRow.querySelectorAll?.('[role="img"]') || []).find((element) => {
        if (element.closest(COMPOSER_EXCLUDE)) return false;
        const label = String(element.getAttribute('aria-label') || element.getAttribute('title') || '').trim();
        return OPEN_VIDEO_LABEL_PATTERN.test(label) && !/(?:cu\u1ed9c g\u1ecdi|video call|call video)/i.test(label);
      });
      if (semanticVideo) isVideoMessage = true;
    }

    const rowAriaLabel = messageRow.getAttribute?.('aria-label') || '';
    const childMsgEl = !rowAriaLabel ? messageRow.querySelector?.('[aria-label*="Tin nhÃ¡ÂºÂ¯n do"], [aria-label*="Message sent"]') : null;
    const effectiveLabel = rowAriaLabel || (childMsgEl?.getAttribute?.('aria-label') || '');

    const hasMessageLabel = /Tin nhÃ¡ÂºÂ¯n do .+ gÃ¡Â»Â­i lÃƒÂºc|Message sent by/i.test(effectiveLabel);
    // [data-message-id] checked first: live DOM inspection (spec 043) found it's
    // the reliable current-structure marker, set on the row at insertion time -
    // unlike the aria-label above, which React hydrates a beat later. Checking
    // it first means a message row already has a STABLE native_id on the very
    // first (label-not-yet-hydrated) MutationObserver pass, not just the second.
    const nativeIdEl = messageRow.querySelector?.('[data-message-id], [data-id], [id^="mid."]');
    // Facebook commonly puts the native id on messageRow itself during the
    // first render. querySelector() above only searches descendants; include
    // the row so the first incoming message is captured immediately instead
    // of waiting for a second message to trigger a React re-render.
    const hasNativeId = !!nativeIdEl || messageRow.hasAttribute?.('data-message-id') ||
      messageRow.hasAttribute?.('data-id') || String(messageRow.id || '').startsWith('mid.');

    if (!hasMessageLabel && !hasNativeId && !isPhotoMessage && !isVideoMessage && !rowEmojiContent) return []; // KhÃƒÂ´ng phÃ¡ÂºÂ£i message row

    const rawText = (node.textContent || '').trim();
    if (!isPhotoMessage && !isVideoMessage) {
      if (!rawText && !rowEmojiContent) return [];

      for (const pat of EXCLUDED_PATTERNS) {
        if (pat.test(rawText)) return [];
      }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ TÃƒÂ¬m tÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ leaf bubbles Ã¢â€â‚¬Ã¢â€â‚¬
    const searchRoot = isRealtime ? node : messageRow;
    const allBubbles = searchRoot.querySelectorAll?.('div[dir="auto"], span[dir="auto"]');
    const leafBubbles = [];
    if (allBubbles && allBubbles.length > 0) {
      for (const b of allBubbles) {
        if (b.closest(COMPOSER_EXCLUDE)) continue;
        if (!b.querySelector('div[dir="auto"], span[dir="auto"]')) {
          leafBubbles.push(b);
        }
      }
    }

    if (leafBubbles.length === 0) {
      if (searchRoot.matches?.('div[dir="auto"], span[dir="auto"]') && !searchRoot.querySelector('div[dir="auto"], span[dir="auto"]')) {
        if (!searchRoot.closest(COMPOSER_EXCLUDE)) {
          leafBubbles.push(searchRoot);
        }
      }
    }

    let finalBubbles = leafBubbles;
    if (isRealtime) {
      // Filter visual bubbles to avoid clones, hidden texts, or accessibility wrappers
      finalBubbles = leafBubbles.filter(b => {
        const rects = b.getClientRects();
        if (!rects || rects.length === 0) return false;
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // KiÃ¡Â»Æ’m tra xem cÃƒÂ³ bÃ¡Â»â€¹ Ã¡ÂºÂ©n qua CSS khÃƒÂ´ng
        const style = window.getComputedStyle(b);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      });
    }

    if (finalBubbles.length === 0 && !isPhotoMessage && !isVideoMessage && !rowEmojiContent) return [];

    let sender_name = '';
    let is_outgoing = false;

    const contactNameEl = document.querySelector('header h1, header h2, [role="main"] h1, [role="main"] h2, span[aria-level="1"]');
    const contactNameStr = contactNameEl ? contactNameEl.textContent.trim() : '';

    const isMissedCallContent = /nhÃ¡Â»Â¡|bÃ¡Â»Â lÃ¡Â»Â¡|missed/i.test(effectiveLabel || (node && node.textContent) || '');

    if (isMissedCallContent) {
      is_outgoing = false;
      sender_name = contactNameStr || 'KhÃƒÂ¡ch hÃƒÂ ng';
    } else if (/do BÃ¡ÂºÂ¡n gÃ¡Â»Â­i|Tin nhÃ¡ÂºÂ¯n do BÃ¡ÂºÂ¡n gÃ¡Â»Â­i lÃƒÂºc|BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i|sent by you|You sent|Message sent by you/i.test(effectiveLabel)) {
      is_outgoing = true;
      sender_name = 'BÃ¡ÂºÂ¡n';
    } else {
      const nameMatch = effectiveLabel.match(/Tin nhÃ¡ÂºÂ¯n do ([^]+?) gÃ¡Â»Â­i lÃƒÂºc/i) || effectiveLabel.match(/Message sent by ([^]+?) at/i);
      if (nameMatch) {
        const rawSender = nameMatch[1].trim();
        if (/^(?:BÃ¡ÂºÂ¡n|You)$/i.test(rawSender)) {
          is_outgoing = true;
          sender_name = 'BÃ¡ÂºÂ¡n';
        } else {
          is_outgoing = false;
          sender_name = rawSender;
        }
      } else {
        const hasContactAvatar = contactNameStr ? !!(
          Array.from(messageRow.querySelectorAll('img[alt], div[role="img"][aria-label], img[aria-label]')).some(el => {
            const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
            return alt.toLowerCase().includes(contactNameStr.toLowerCase());
          })
        ) : false;

        if (hasContactAvatar) {
          is_outgoing = false;
          sender_name = contactNameStr;
        } else {
          const mainEl = document.querySelector('div[role="main"]');
          const targetNode = messageRow || node;
          if (mainEl && targetNode && typeof targetNode.getBoundingClientRect === 'function') {
            const mainRect = mainEl.getBoundingClientRect();
            const nodeRect = targetNode.getBoundingClientRect();
            if (mainRect.width > 0 && nodeRect.width > 0) {
              const nodeCenter = nodeRect.left + nodeRect.width / 2;
              const mainCenter = mainRect.left + mainRect.width * 0.55;
              is_outgoing = nodeCenter > mainCenter;
            } else {
              is_outgoing = false;
            }
          } else {
            is_outgoing = false;
          }
          sender_name = is_outgoing ? 'BÃ¡ÂºÂ¡n' : contactNameStr;
        }
      }
    }

    // Facebook can hydrate an incorrect/stale accessibility sender label for
    // a freshly mounted bubble. In realtime, a clearly left/right visual
    // bubble is the strongest direction evidence and prevents customer text
    // from being discarded as our own message until history runs later.
    if (isRealtime && finalBubbles.length > 0) {
      const mainEl = document.querySelector('div[role="main"]');
      const visualBubble = finalBubbles.reduce((best, candidate) => {
        const rect = candidate.getBoundingClientRect();
        const bestRect = best?.getBoundingClientRect?.();
        return !bestRect || rect.width * rect.height > bestRect.width * bestRect.height ? candidate : best;
      }, null);
      const mainRect = mainEl?.getBoundingClientRect?.();
      const bubbleRect = visualBubble?.getBoundingClientRect?.();
      if (mainRect?.width > 0 && bubbleRect?.width > 0) {
        const relativeCenter = (bubbleRect.left + bubbleRect.width / 2 - mainRect.left) / mainRect.width;
        if (relativeCenter <= 0.45) {
          is_outgoing = false;
          sender_name = contactNameStr || 'KhÃƒÂ¡ch hÃƒÂ ng';
        } else if (relativeCenter >= 0.55) {
          is_outgoing = true;
          sender_name = 'BÃ¡ÂºÂ¡n';
        }
      }
    }
    const filter = globalThis.FbCrmTextFilter;

    // A Like row can contain a visual minute fragment (for example 37sÃƒÂ¡ng)
    // beside its SVG. That fragment is timestamp chrome, not message text.
    const hasOnlyClockFragments = finalBubbles.length > 0 && finalBubbles.every((bubble) => {
      const bubbleText = cleanBubbleText(bubble.textContent);
      return !bubbleText || isClockMinuteFragment(bubbleText, effectiveLabel);
    });
    // Some Messenger builds expose no semantic title for a received Like, but
    // the message row still contains its SVG and a dir=auto timestamp minute.
    // In that exact shape the minute (e.g. 55) must become the Like glyph.
    if (!rowEmojiContent && hasOnlyClockFragments && messageRow.querySelector?.('svg')) rowEmojiContent = 'Ã°Å¸â€˜Â';
    if (rowEmojiContent && (finalBubbles.length === 0 || hasOnlyClockFragments) && !isPhotoMessage && !isVideoMessage) {
      return [{
        sender_name: sender_name || (is_outgoing ? 'BÃ¡ÂºÂ¡n' : ''),
        content: rowEmojiContent,
        is_outgoing,
        native_id: nativeIdEl?.getAttribute('data-message-id') || nativeIdEl?.getAttribute('data-id') || nativeIdEl?.getAttribute('id') || messageRow.getAttribute?.('data-message-id') || messageRow.getAttribute?.('data-id') || null,
        effective_label: effectiveLabel,
        is_valid: true,
        bubble_idx: 0,
        media_type: 'text',
        media_url: null,
        dom_anchor: messageRow,
        }];
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Ã¡ÂºÂ¢nh: trÃ¡ÂºÂ£ vÃ¡Â»Â Ã„â€˜ÃƒÂºng 1 kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ duy nhÃ¡ÂºÂ¥t cho cÃ¡ÂºÂ£ row Ã¢â€â‚¬Ã¢â€â‚¬
    // Live DOM inspection found Facebook renders a sent photo+caption pair
    // as two SEPARATE message articles (an image-only one with no text
    // bubble, immediately followed by a text-only one for the caption) -
    // not one combined bubble. This branch only ever fires for the
    // image-only article (finalBubbles is empty there), so caption always
    // comes back '' here; the caption's own article runs through the normal
    // per-bubble loop below as its own independent text event, unaffected.
    if (isPhotoMessage || isVideoMessage) {
      let caption = '';
      const MEDIA_PLACEHOLDER_RE = /^\[?(?:Ã¡ÂºÂ¢nh|Photo|Image|Video|TÃ¡Â»â€¡p|File|MÃ¡Â»Å¸ Ã¡ÂºÂ£nh|Xem Ã¡ÂºÂ£nh|Open photo|View photo|Attachment)\]?$/i;
      for (const bubble of finalBubbles) {
        const cleaned = cleanBubbleText(bubble.textContent);
        if (!cleaned || cleaned.length > 1000) continue;
        if (isClockMinuteFragment(cleaned, effectiveLabel)) continue;
        if (MEDIA_PLACEHOLDER_RE.test(cleaned)) continue;
        if (filter?.isSystemOrMetadataText && filter.isSystemOrMetadataText(cleaned)) continue;
        caption = cleaned;
        break;
      }
      return [{
        sender_name: sender_name || (is_outgoing ? 'BÃ¡ÂºÂ¡n' : ''),
        content: caption || '',
        is_outgoing,
        native_id: nativeIdEl?.getAttribute('data-message-id') || nativeIdEl?.getAttribute('data-id') || nativeIdEl?.getAttribute('id') || messageRow.getAttribute?.('data-message-id') || messageRow.getAttribute?.('data-id') || null,
        effective_label: effectiveLabel,
        is_valid: true,
        bubble_idx: 0,
        media_type: isVideoMessage ? 'video' : 'image',
        media_url: mediaUrl,
        dom_anchor: messageRow,
        }];
    }

    const results = [];
    let bubble_idx = 0;
    for (const bubble of finalBubbles) {
      const textContent = cleanBubbleText(bubble.textContent);
      // Keep icon ownership scoped to this exact bubble.
      const emojiContent = extractBubbleEmoji(bubble);
      const cleanText = emojiContent && (!textContent || isClockMinuteFragment(textContent, effectiveLabel))
        ? emojiContent
        : textContent;

      if (!cleanText || cleanText.length < 1 || cleanText.length > 1000) {
        bubble_idx++;
        continue;
      }
      if (filter?.isSystemOrMetadataText && filter.isSystemOrMetadataText(cleanText)) {
        bubble_idx++;
        continue;
      }

      const PRESENCE_EXACT = /^(?:Ã„Âang hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng.*|HoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng(?:\s+\d+.*)?|Ã„ÂÃƒÂ£ hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng.*|Active now|Active recently|Active \d+.*|Online|Offline|Ã„ÂÃƒÂ£ gÃ¡Â»Â­i|Ã„ÂÃƒÂ£ nhÃ¡ÂºÂ­n|Ã„ÂÃƒÂ£ xem|Sent|Delivered|Seen|Typing|Ã„ÂÃƒÂ£ gÃ¡Â»Â­i\s+\d+\s+(?:giÃƒÂ¢y|phÃƒÂºt|giÃ¡Â»Â|ngÃƒÂ y|tuÃ¡ÂºÂ§n|thÃƒÂ¡ng|nÃ„Æ’m)\s+trÃ†Â°Ã¡Â»â€ºc[.Ã¢â‚¬Â¦]*|Ã„Âang nhÃ¡ÂºÂ­p[.Ã¢â‚¬Â¦]*|Ã„Âang gÃ¡Â»Â­i[.Ã¢â‚¬Â¦]*|Ã„Âang tÃ¡ÂºÂ£i[.Ã¢â‚¬Â¦]*|Loading[.Ã¢â‚¬Â¦]*|Sending[.Ã¢â‚¬Â¦]*)$/i;
      if (PRESENCE_EXACT.test(cleanText)) {
        bubble_idx++;
        continue;
      }

      results.push({
        sender_name: sender_name || (is_outgoing ? 'BÃ¡ÂºÂ¡n' : ''),
        content: cleanText,
        is_outgoing,
        native_id: nativeIdEl?.getAttribute('data-message-id') || nativeIdEl?.getAttribute('data-id') || nativeIdEl?.getAttribute('id') || messageRow.getAttribute?.('data-message-id') || messageRow.getAttribute?.('data-id') || null,
        effective_label: effectiveLabel,
        is_valid: true,
        bubble_idx
      });
      bubble_idx++;
    }

    // Preserve the exact physical row for stable fallback IDs. This property is
    // local to the parser and is never sent over the wire.
    results.forEach((parsed) => { parsed.dom_anchor = messageRow; });
    return results;
  }

  // Avatar extractor - search up to 8 levels up for profile pic img
  function extractContactAvatarFromNode(node) {
    let current = node, depth = 0;
    while (current && current !== document.body && depth < 8) {
      depth++;
      const allImgs = current.querySelectorAll?.('img');
      if (allImgs) {
        for (const img of allImgs) {
          const src = img.currentSrc || img.src || '';
          const label = (String(img.getAttribute?.('alt') || '') + ' ' + String(img.getAttribute?.('aria-label') || '')).toLowerCase();
          const rect = img.getBoundingClientRect?.();
          const width = Number(rect?.width || img.width || 0);
          const height = Number(rect?.height || img.height || 0);
          // Message photos/videos also live under the same ancestor and use
          // fbcdn URLs. Only accept profile-sized images; otherwise a customer
          // attachment can overwrite the contact avatar and later disappear.
          const isProfileSized = width > 0 && height > 0 && width <= 80 && height <= 80;
          const isMessageMedia = /open photo|view photo|mÃ¡Â»Å¸ Ã¡ÂºÂ£nh|xem Ã¡ÂºÂ£nh|video/.test(label);
          if (isProfileSized && !isMessageMedia && src && !src.includes('transparent') && !src.includes('blank') && (src.includes('fbcdn.net') || src.includes('scontent') || src.includes('platform.facebook.com')) && src.length > 50) return src;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  let currentBaselineThreadId = null;
  let observerPaused = false;

  function makeDomMessageId(thread_id, parsed) {
    // Real Facebook native id (data-message-id/data-id/mid.*) is always the
    // most stable identifier when present. Facebook can place several
    // consecutive bubbles inside one native message wrapper, though. Keep
    // the first bubble's legacy id for DB compatibility and give subsequent
    // bubbles a stable suffix so they are not silently deduplicated.
    if (parsed.native_id) {
      const nativeId = String(parsed.native_id);
      const bubbleIndex = Number(parsed.bubble_idx) || 0;
      return bubbleIndex > 0 ? `${nativeId}__bubble_${bubbleIndex}` : nativeId;
    }
    // Fallback hash for messages with no native id. is_outgoing/sender_name/
    // effective_label are deliberately excluded: all three are derived from
    // the message row's aria-label (see the sender/direction block above),
    // which React can hydrate a beat after MutationObserver's first pass
    // fires. Hashing them in meant a re-scan of the SAME physical message
    // that read a different (still-settling) label produced a DIFFERENT id -
    // so neither this dedup nor the server's UNIQUE(fb_message_id) ever saw
    // it as the same message, and it landed as a ghost duplicate row with a
    // flipped direction (spec 045). Only thread_id+content go into the hash
    // now - content is read straight off the bubble text node, not the
    // label, so it doesn't share this instability.
    let textHash = 0;
    const strToHash = `${thread_id}|${parsed.content}`;
    for (let i = 0; i < strToHash.length; i++) {
      textHash = Math.imul(31, textHash) + strToHash.charCodeAt(i) | 0;
    }
    const occurrence = parsed.dom_occurrence_id ? `_occ_${parsed.dom_occurrence_id}` : '';
    return `dom_${thread_id}_hash_${Math.abs(textHash)}_${parsed.bubble_idx}${occurrence}`;
  }

  function getDomMessagePosition(sourceNode, threadId, expectedMessageId) {
    try {
      const log = sourceNode.closest?.('[role="log"]') || document.querySelector('div[role="main"] [role="log"]');
      if (!log) return null;
      const rows = Array.from(log.querySelectorAll('[role="article"]'));
      const candidates = [];
      // Flatten every parsed bubble, not just every article. Messenger can put
      // several rapid messages inside one article and article-level neighbors
      // cannot express their real order.
      const flatEntries = [];
      for (const row of rows) {
        for (const item of parseMessagesFromDOMNode(row, true)) {
          markDomOccurrence(item, row);
          flatEntries.push({ id: makeDomMessageId(threadId, item), row });
        }
      }
      const flatIndex = flatEntries.findIndex((entry) => entry.id === expectedMessageId);
      if (flatIndex >= 0) {
        return {
          dom_previous_message_id: flatEntries[flatIndex - 1]?.id || null,
          dom_next_message_id: flatEntries[flatIndex + 1]?.id || null,
          dom_order_index: flatIndex,
          dom_order_total: flatEntries.length
        };
      }
      const closest = sourceNode.matches?.('[role="article"]') ? sourceNode : sourceNode.closest?.('[role="article"]');
      if (closest) candidates.push(closest);
      sourceNode.querySelectorAll?.('[role="article"]').forEach((candidate) => candidates.push(candidate));
      let row = candidates.find((candidate) => {
        const parsed = parseMessagesFromDOMNode(candidate, true);
        return parsed.some((item) => makeDomMessageId(threadId, item) === expectedMessageId);
      }) || closest || candidates[0];
      if (!row) return null;
      const index = rows.indexOf(row);
      if (index < 0) return null;
      const nearestMessageId = (rowIndex, step, fromEnd) => {
        for (let cursor = rowIndex; cursor >= 0 && cursor < rows.length; cursor += step) {
          const parsed = parseMessagesFromDOMNode(rows[cursor], true);
          if (!parsed.length) continue;
          const item = parsed[fromEnd ? parsed.length - 1 : 0];
          const id = makeDomMessageId(threadId, item);
          if (id && id !== expectedMessageId) return id;
        }
        return null;
      };
      return {
        dom_previous_message_id: nearestMessageId(index - 1, -1, true),
        dom_next_message_id: nearestMessageId(index + 1, 1, false),
        dom_order_index: index,
        dom_order_total: rows.length
      };
    } catch (_) {
      return null;
    }
  }
  function seedBaseline(thread_id) {
    const existingRows = document.querySelectorAll('div[role="row"], div[role="article"], div[data-scope="messages_table"] div[dir="auto"]');
    existingRows.forEach(row => {
      const parsedMessages = parseMessagesFromDOMNode(row);
      parsedMessages.forEach(p => {
        markDomOccurrence(p, row);
        lastObservedMessages.set(makeDomMessageId(thread_id, p), domObservationSignature(p));
      });
    });
    while (lastObservedMessages.size > 2000) lastObservedMessages.delete(lastObservedMessages.keys().next().value);
  }

  // If the app/extension reconnects while Facebook is already open, a customer
  // message can be mounted before MutationObserver is attached. Re-submit only
  // incoming rows carrying Facebook's durable native id. The server's unique
  // fb_message_id makes this safe for old rows, while the just-arrived row is no
  // longer swallowed by the startup baseline.
  function replayStableIncomingTail(thread_id) {
    const main = document.querySelector('div[role=main]');
    if (!main) return;
    const rows = Array.from(main.querySelectorAll('div[role=row], div[role=article]')).slice(-32);
    for (const row of rows) {
      for (const parsed of parseMessagesFromDOMNode(row, true)) {
        if (!parsed.native_id) continue;
        // This recovery pass is incoming-only. Never forward an outgoing DOM bubble as CONTACT.
        // The previous hard-coded is_outgoing:false here manufactured the ghost text.
        if (parsed.is_outgoing) {
          markObservedOutgoing(thread_id, parsed.content);
          continue;
        }
        if (isRecentObservedOutgoing(thread_id, parsed.content)) continue;
        markDomOccurrence(parsed, row);
        const fbMessageId = makeDomMessageId(thread_id, parsed);
        const domPosition = getDomMessagePosition(row, thread_id, fbMessageId);
        const observationSignature = domObservationSignature(parsed);
        if (lastObservedMessages.get(fbMessageId) === observationSignature) continue;
        lastObservedMessages.set(fbMessageId, observationSignature);

        let timestampMs = null;
        const timeMatch = String(parsed.effective_label || '').match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH))?/i);
        if (timeMatch) {
          let hours = Number(timeMatch[1]);
          const minutes = Number(timeMatch[2]);
          const suffix = String(timeMatch[3] || '').toUpperCase();
          if ((suffix === 'PM' || suffix === 'CH') && hours < 12) hours += 12;
          if ((suffix === 'AM' || suffix === 'SA') && hours === 12) hours = 0;
          const observedAt = new Date();
          observedAt.setHours(hours, minutes, 0, 0);
          if (observedAt.getTime() > Date.now() + 60000) observedAt.setDate(observedAt.getDate() - 1);
          timestampMs = observedAt.getTime();
        }

        try {
          chrome.runtime.sendMessage({
            type: 'NEW_MESSAGE_FROM_FB',
            data: {
              thread_id,
              sender_id: null,
              sender_name: parsed.sender_name,
              content: parsed.content,
              is_outgoing: false,
              sender_role: 'customer',
              fb_message_id: fbMessageId,
              media_type: parsed.media_type || 'text',
              media_url: parsed.media_url || null,
              timestamp_ms: timestampMs,
              timestamp_source: timestampMs ? 'facebook_label' : 'startup_catchup',
              created_at: new Date(timestampMs || Date.now()).toISOString(),
              source: 'dom_observer',
              ...(domPosition || {}),
              dom_position_confirmed: Boolean(domPosition),
              contact_avatar: extractContactAvatarFromNode(row) || ''
            }
          });
        } catch (_) {}
      }
    }
  }

  const chatObserver = new MutationObserver((mutations) => {
    if (isDedicatedBackgroundTab) return;
    const thread_id = extractThreadIdFromUrl();
    if (!thread_id || !/^\d+$/.test(thread_id)) return;

    // KiÃ¡Â»Æ’m tra DOM stale (URL update nhÃ†Â°ng sidebar chÃ†Â°a update)
    const activeSidebarItem = document.querySelector('a[aria-current="page"][href*="/messages/"], a[aria-current="true"][href*="/messages/"]');
    if (activeSidebarItem) {
      const activeUrl = activeSidebarItem.getAttribute('href') || '';
      const activeMatch = activeUrl.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/);
      const activeId = activeMatch ? decodeURIComponent(activeMatch[1]) : null;
      if (activeId && String(activeId) !== String(thread_id)) return; // BÃ¡Â»Â qua toÃƒÂ n bÃ¡Â»â„¢ mutation vÃƒÂ¬ DOM chÃ†Â°a Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ vÃ¡Â»â€ºi URL
    }

    // PhÃƒÂ¡t hiÃ¡Â»â€¡n Ã„â€˜Ã¡Â»â€¢i thread NGAY TRONG TICK cÃ¡Â»Â§a MutationObserver, khÃƒÂ´ng dÃƒÂ¹ng setInterval Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh trÃ¡Â»â€¦
    if (thread_id !== currentBaselineThreadId) {
      currentBaselineThreadId = thread_id;
      observerPaused = true;
      // Seed only the DOM that already exists at the instant this thread is
      // selected, then listen immediately. The old second seed 1.5s later
      // marked customer messages arriving during navigation as historical;
      // they appeared in CRM only after our next outgoing send caused another
      // mutation. Server-side stable-id dedup safely handles late history
      // hydration, so keeping this blind window is both unnecessary and lossy.
      // The mounted DOM already contains historical bubbles when switching users.
      // Do not replay that tail through realtime: history sync owns these rows.
      seedBaseline(thread_id);
      observerPaused = false;
    }

    if (observerPaused) return;

    mutations.forEach(mutation => {
      const changedNodes = mutation.type === 'attributes'
        ? [mutation.target]
        : Array.from(mutation.addedNodes || []);
      changedNodes.forEach(node => {
      if (node.nodeType !== 1) return;

      const inMain = node.closest?.('div[role="main"]');
      const inComposerOrHeader = node.closest?.('form, [role="contentinfo"], [aria-label*="composer"], [aria-label*="SoÃ¡ÂºÂ¡n"], header, nav');
      if (!inMain || inComposerOrHeader) return;

      const parsedMessages = parseMessagesFromDOMNode(node, true);
      if (parsedMessages.length === 0) return;

      // Baseline rows were already added to lastObservedMessages before the
      // observer was unpaused. Do not suppress incoming bubbles here: the first
      // customer reply often arrives while Messenger is still hydrating after
      // our outgoing bubble, and suppressing all incoming rows in that window
      // made the customer have to send a second message. Stable DOM/native IDs
      // below remain the replay guard for old history.
      const activeParsed = parsedMessages;
      if (activeParsed.length === 0) return;

      const contactAvatar = extractContactAvatarFromNode(node);

      activeParsed.forEach((parsed) => {
        // Every physical bubble gets its own identity. Content/time based
        // cooldowns incorrectly collapsed rapid messages such as c, c, c.
        markDomOccurrence(parsed, node);

        const fbMessageId = makeDomMessageId(thread_id, parsed);
        const domPosition = getDomMessagePosition(node, thread_id, fbMessageId);

        // Skip only if THIS exact reading (same id, same direction) was already
        // forwarded - a re-scan that now disagrees on direction is deliberately
        // let through (with the same fbMessageId) so the server's existing
        // reconcile/hysteresis path (spec 019) can settle it, rather than a new
        // duplicate row being created or the correction being silently dropped.
        const observationSignature = domObservationSignature(parsed);
        if (lastObservedMessages.get(fbMessageId) === observationSignature) return;
        lastObservedMessages.set(fbMessageId, observationSignature);
        if (lastObservedMessages.size > 2000) lastObservedMessages.delete(lastObservedMessages.keys().next().value);

        let tsMs = null;
        let tsSource = 'realtime_fallback';
        if (parsed.effective_label) {
          // Parse: "Tin nhÃ¡ÂºÂ¯n do BÃ¡ÂºÂ¡n gÃ¡Â»Â­i lÃƒÂºc 15:20" hoÃ¡ÂºÂ·c "15:20"
          const timeMatch = parsed.effective_label.match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH))?/i);
          if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const ampm = timeMatch[3]?.toUpperCase();
            if (ampm === 'PM' || ampm === 'CH') {
              if (hours < 12) hours += 12;
            } else if (ampm === 'AM' || ampm === 'SA') {
              if (hours === 12) hours = 0;
            }
            
            const now = new Date();
            // Assuming current day. If label has specific day, it gets complex.
            now.setHours(hours, minutes, 0, 0);
            
            // If the parsed time is slightly in the future (e.g. timezone mismatch), subtract 1 day
            if (now.getTime() > Date.now() + 60000) {
              now.setDate(now.getDate() - 1);
            }
            
            tsMs = now.getTime();
            tsSource = 'facebook_label';
          }
        }

        if (parsed.is_outgoing) markObservedOutgoing(thread_id, parsed.content);
        if (!parsed.is_outgoing && isRecentObservedOutgoing(thread_id, parsed.content)) return;

        // The explicit composer confirmation/network intercept owns plain outgoing text.
        // The DOM observer must not forward the same rendered bubble a second time.
        const isPlainOutgoingDomText = parsed.is_outgoing
          && !parsed.media_url
          && (!parsed.media_type || parsed.media_type === 'text');
        if (isPlainOutgoingDomText) return;
        try {
          if (chrome?.runtime?.id) {
            console.log(`[DOM Observer] matched message: thread_id=${thread_id} | id=${fbMessageId} | media_type=${parsed.media_type || 'text'} | content="${parsed.content.substring(0, 40)}" | tsMs=${tsMs}`);
            chrome.runtime.sendMessage({
              type: 'NEW_MESSAGE_FROM_FB',
              data: {
                thread_id: thread_id,
                sender_id: parsed.is_outgoing ? capturedUserId : null,
                sender_name: parsed.sender_name,
                content: parsed.content,
                is_outgoing: parsed.is_outgoing,
                sender_role: parsed.is_outgoing ? 'operator' : 'customer',
                fb_message_id: fbMessageId,
                media_type: parsed.media_type || 'text',
                media_url: parsed.media_url || null,
                timestamp_ms: tsMs,
                timestamp_source: tsSource,
                created_at: new Date(tsMs || Date.now()).toISOString(),
                source: 'dom_observer',
                ...(domPosition || {}),
                dom_position_confirmed: Boolean(domPosition),
                contact_avatar: contactAvatar || ''
              }
            });
          }
        } catch (err) {}
      });
    });
    });
  });

  // React sometimes hydrates an already-mounted Messenger article by changing
  // text/attributes instead of adding a new element. Reconcile only the tail
  // of the active log and only confirmed incoming bubbles; the existing
  // baseline/dedupe map prevents old history from being replayed.
  function reconcileLatestIncomingMessages() {
    if (observerPaused) return;
    const thread_id = extractThreadIdFromUrl();
    if (!thread_id || !/^\d+$/.test(thread_id) || thread_id !== currentBaselineThreadId) return;
    const log = document.querySelector('[role="log"][aria-label*="Tin nh\u1eafn trong cu\u1ed9c tr\u00f2 chuy\u1ec7n"], [role="log"][aria-label*="Messages in the conversation"]')
      || document.querySelector('div[role="main"] [role="log"]');
    if (!log) return;
    const rows = Array.from(log.querySelectorAll('div[role="row"], div[role="article"]')).slice(-24);
    for (const row of rows) {
      for (const parsed of parseMessagesFromDOMNode(row, true)) {
        markDomOccurrence(parsed, row);
        // Tail reconciliation is hydration recovery, so require Facebook's
        // durable identity. Virtualized history without a native id can remount
        // after our own video send and must never become a new CRM message.
        if (!parsed.native_id) continue;
        const parsedText = String(parsed.content || '').toLocaleLowerCase('vi-VN');
        const isCallRow = /(?:cu?c g?i|nh?|b? l?|audio call|video call|missed call|call ended)/i.test(parsedText);
        const isMediaRow = Boolean(parsed.media_url || (parsed.media_type && parsed.media_type !== 'text'));
        if (parsed.is_outgoing) markObservedOutgoing(thread_id, parsed.content);
        if (!parsed.is_outgoing && isRecentObservedOutgoing(thread_id, parsed.content)) continue;
        // Outgoing media is required here: MutationObserver often sees the
        // video shell before Facebook hydrates its native id/media element.
        // The periodic tail pass then provides the confirmation that clears
        // the CRM pending spinner. Plain outgoing text remains on its existing path.
        if (parsed.is_outgoing && !isCallRow && !isMediaRow) continue;
        const fbMessageId = makeDomMessageId(thread_id, parsed);
        const domPosition = getDomMessagePosition(row, thread_id, fbMessageId);
        const observationSignature = domObservationSignature(parsed);
        if (lastObservedMessages.get(fbMessageId) === observationSignature) continue;
        let tsMs = null;
        const timeMatch = String(parsed.effective_label || '').match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH))?/i);
        if (timeMatch) {
          let hours = Number(timeMatch[1]);
          const minutes = Number(timeMatch[2]);
          const ampm = String(timeMatch[3] || '').toUpperCase();
          if ((ampm === 'PM' || ampm === 'CH') && hours < 12) hours += 12;
          if ((ampm === 'AM' || ampm === 'SA') && hours === 12) hours = 0;
          const observed = new Date();
          observed.setHours(hours, minutes, 0, 0);
          if (observed.getTime() > Date.now() + 60000) observed.setDate(observed.getDate() - 1);
          tsMs = observed.getTime();
        }
        lastObservedMessages.set(fbMessageId, observationSignature);
        try {
          if (chrome?.runtime?.id) chrome.runtime.sendMessage({
            type: 'NEW_MESSAGE_FROM_FB',
            data: {
              thread_id,
              sender_id: parsed.is_outgoing ? capturedUserId : null,
              sender_name: parsed.sender_name,
              content: parsed.content,
              is_outgoing: parsed.is_outgoing,
              sender_role: parsed.is_outgoing ? 'operator' : 'customer',
              fb_message_id: fbMessageId,
              media_type: parsed.media_type || 'text',
              media_url: parsed.media_url || null,
              timestamp_ms: tsMs,
              timestamp_source: tsMs ? 'facebook_label' : 'realtime_fallback',
              created_at: new Date(tsMs || Date.now()).toISOString(),
              source: 'dom_observer',
              ...(domPosition || {}),
              dom_position_confirmed: Boolean(domPosition),
              contact_avatar: extractContactAvatarFromNode(row) || ''
            }
          });
        } catch (_) {}
      }
    }
    while (lastObservedMessages.size > 2000) lastObservedMessages.delete(lastObservedMessages.keys().next().value);
  }

  // Initialize everything
  patchXHR(); patchFetch(); patchWebSocket();
  extractFbTokensFromDOM(); setInterval(extractFbTokensFromDOM, 3000);

  // Seed the already-mounted history once and start observing immediately.
  // Delaying this by 1s and seeding again after another 3s swallowed any
  // customer message received during those four seconds.
  observerPaused = true;
  const initialThreadId = extractThreadIdFromUrl();
  if (initialThreadId && /^\d+$/.test(initialThreadId)) {
    currentBaselineThreadId = initialThreadId;
    // Already-mounted history is seeded, not replayed as realtime.
    seedBaseline(initialThreadId);
  }
  chatObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'poster', 'aria-label', 'data-message-id', 'data-id']
  });
  observerPaused = false;
  setInterval(reconcileLatestIncomingMessages, 250);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Call Log Scanner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // QuÃƒÂ©t span[dir="auto"] chÃ¡Â»Â©a text cuÃ¡Â»â„¢c gÃ¡Â»Âi mÃ¡Â»â€”i 2 giÃƒÂ¢y.
  // Facebook Messenger (www.facebook.com) dÃƒÂ¹ng cÃ¡ÂºÂ¥u trÃƒÂºc:
  //   <span dir="auto">CuÃ¡Â»â„¢c gÃ¡Â»Âi thoÃ¡ÂºÂ¡i</span>
  //   <span dir="auto">Ã„ÂÃƒÂ£ nhÃ¡Â»Â¡ cuÃ¡Â»â„¢c gÃ¡Â»Âi thoÃ¡ÂºÂ¡i</span>
  //   <span dir="auto">CuÃ¡Â»â„¢c gÃ¡Â»Âi video</span>
  var _callSentIds = new Set();
  var _callSeenCounts = new Map();
  var _callPendingDirections = new Map();
  var _lastScannedThreadId = null;
  var _callBaselineReady = false;

  function callSignatureHash(value) {
    var hash = 0;
    var input = String(value || '');
    for (var index = 0; index < input.length; index++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function scanCallLogsNow() {
    try {
      var threadId = extractThreadIdFromUrl();
      if (!threadId || !/^\d+$/.test(threadId)) return;

      if (threadId !== _lastScannedThreadId) {
        _lastScannedThreadId = threadId;
        _callSentIds.clear();
        _callSeenCounts.clear();
        _callPendingDirections.clear();
        _callBaselineReady = false;
      }

      // Scan only the active conversation's message log. role="main" also
      // contains the Messenger sidebar, whose conversation previews include
      // call text and unrelated avatars (confirmed against the live DOM).
      var mainContainer = document.querySelector(
        '[role="log"][aria-label*="Tin nh\u1eafn trong cu\u1ed9c tr\u00f2 chuy\u1ec7n"], ' +
        '[role="log"][aria-label*="Messages in the conversation"]'
      ) || document.querySelector('div[role="main"] [role="log"]');
      if (!mainContainer) return;

      // DOM virtualization remounts historical call rows while the history
      // viewport is away from the latest messages. Those are not realtime
      // calls. Reset the baseline while away from the bottom so returning to
      // the latest viewport also establishes a fresh baseline without emits.
      var callScroller = mainContainer;
      var scrollProbe = mainContainer;
      while (scrollProbe && scrollProbe !== document.body) {
        if (scrollProbe.scrollHeight > scrollProbe.clientHeight + 8) {
          callScroller = scrollProbe;
          break;
        }
        scrollProbe = scrollProbe.parentElement;
      }
      var distanceFromBottom = Math.max(0, callScroller.scrollHeight - callScroller.clientHeight - callScroller.scrollTop);
      if (distanceFromBottom > 120) {
        _callSeenCounts.clear();
        _callPendingDirections.clear();
        _callBaselineReady = false;
        return;
      }

      var spans = mainContainer.querySelectorAll('span[dir="auto"]');
      var contactHeading = document.querySelector('header h1, header h2, [role="main"] h1, [role="main"] h2, span[aria-level="1"]');
      var rawHeadingText = (contactHeading ? contactHeading.textContent : '').replace(/\s+/g, ' ').trim();
      rawHeadingText = rawHeadingText.replace(/(?:HoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng|Active|Ã„Âang hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng).*$/i, '').trim();
      var expectedContactName = rawHeadingText.toLowerCase();
      var scanCounts = new Map();
      var scanCalls = [];
      var seenCallRows = new Set();
      for (var i = 0; i < spans.length; i++) {
        var spanEl = spans[i];
        var txt = (spanEl.textContent || '').trim();
        var lower = txt.toLowerCase();
        if (!txt) continue;
        if (!lower.includes('cuÃ¡Â»â„¢c gÃ¡Â»Âi') && !lower.includes('nhÃ¡Â»Â¡') && !lower.includes('bÃ¡Â»Â lÃ¡Â»Â¡') && !lower.includes('video')) continue;

        var parentEl = spanEl.closest('[role="button"]') || spanEl.closest('div.x78zum5') || spanEl.parentElement;
        if (!parentEl || !mainContainer.contains(parentEl)) continue;
        // A real Messenger bubble is an article. Sidebar previews are not.
        var canonicalCallRow = spanEl.closest('[role="article"]');
        if (!canonicalCallRow || !mainContainer.contains(canonicalCallRow)) continue;
        if (seenCallRows.has(canonicalCallRow)) continue;
        seenCallRows.add(canonicalCallRow);
        var parentText = parentEl ? (parentEl.textContent || '').trim() : '';
        var timeMatch = parentText.match(/(\d{1,2}:\d{2}|\d+\s*(?:giÃƒÂ¢y|phÃƒÂºt|giÃ¡Â»Â|ngÃƒÂ y))/i);
        var timeStr = timeMatch ? timeMatch[1].replace(/[:\s]/g, '') : 'notime';
        // Missed is an outcome, not a sender direction. Avatar/position below
        // must decide which side owns the call row.
        lower = lower.replace(/\u0111\u00e3\s+nh\u1ee1|\u0111\u00e3\s+b\u1ecf\s+l\u1ee1|b\u1ecf\s+l\u1ee1/g, '');
        var isOutgoing = false;
        if (lower.includes('cÃ¡Â»Â§a bÃ¡ÂºÂ¡n') || lower.includes('bÃ¡Â»Å¸i bÃ¡ÂºÂ¡n') || lower.includes('do bÃ¡ÂºÂ¡n')) {
          isOutgoing = true;
        } else if (lower.includes('Ã„â€˜ÃƒÂ£ nhÃ¡Â»Â¡') || lower.includes('bÃ¡Â»Â lÃ¡Â»Â¡')) {
          isOutgoing = false;
        } else {
          var rowContainer = spanEl.parentElement;
          for (var d = 0; d < 15 && rowContainer; d++) {
            var tag = rowContainer.tagName ? rowContainer.tagName.toLowerCase() : '';
            if (tag === 'article' || rowContainer.getAttribute('role') === 'row' || rowContainer.getAttribute('role') === 'listitem') break;
            rowContainer = rowContainer.parentElement;
          }
          if (rowContainer) {
            var imgs = rowContainer.querySelectorAll('img[alt], img[aria-label]');
            var hasContactAvatar = false;
            for (var ii = 0; ii < imgs.length; ii++) {
              var candidateAlt = (imgs[ii].getAttribute('alt') || imgs[ii].getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (expectedContactName && candidateAlt && (expectedContactName.includes(candidateAlt) || candidateAlt.includes(expectedContactName))) {
                hasContactAvatar = true;
                break;
              }
              if (!expectedContactName) {
                var altTxt = (imgs[ii].getAttribute('alt') || imgs[ii].getAttribute('aria-label') || '').trim();
                if (altTxt && !/^(bÃ¡ÂºÂ¡n|you)$/i.test(altTxt)) {
                  hasContactAvatar = true;
                  break;
                }
              }
            }
            if (hasContactAvatar) {
              isOutgoing = false;
            } else {
              var containerEl2 = document.querySelector('div[role="main"]') || document.body;
              var cRect2 = containerEl2.getBoundingClientRect();
              var sRect2 = spanEl.getBoundingClientRect();
              if (cRect2.width > 0 && sRect2.width > 0) {
                isOutgoing = (sRect2.left - cRect2.left) > (cRect2.width * 0.45);
              } else {
                isOutgoing = true;
              }
            }
          }
        }

        var durationMatch = parentText.match(/(\d+\s*(?:giÃƒÂ¢y|phÃƒÂºt|giÃ¡Â»Â))/i);
        // The owner label can be on the article itself, a deep child, or a
        // wrapper above it (Facebook changes this during hydration). Inspect
        // all three instead of querySelector-only, which misses the row itself
        // and caused an A -> B call to be guessed from geometry on B's side.
        var ownershipLabels = [];
        var labelCursor = canonicalCallRow;
        for (var labelDepth = 0; labelDepth < 4 && labelCursor && mainContainer.contains(labelCursor); labelDepth++) {
          var cursorLabel = labelCursor.getAttribute?.('aria-label');
          if (cursorLabel) ownershipLabels.push(cursorLabel);
          labelCursor = labelCursor.parentElement;
        }
        var ownershipNodes = canonicalCallRow.querySelectorAll?.('[aria-label]') || [];
        for (var labelIndex = 0; labelIndex < ownershipNodes.length; labelIndex++) {
          ownershipLabels.push(ownershipNodes[labelIndex].getAttribute('aria-label') || '');
        }
        for (var ownerIndex = 0; ownerIndex < ownershipLabels.length; ownerIndex++) {
          var authoritativeDirection = globalThis.FbCrmCallDirection?.directionFromAccessibilityLabel(ownershipLabels[ownerIndex]);
          if (authoritativeDirection !== null && authoritativeDirection !== undefined) {
            isOutgoing = authoritativeDirection;
            break;
          }
        }

        // Final authority for call bubbles: Messenger renders the contact's
        // avatar only on the contact-owned row. "You" rows have no avatar.
        // Scope this strictly to the canonical call article so header/sidebar
        // avatars cannot flip the result. Do not let aria labels or geometry
        // override this rule.
        var rowAvatarCandidates = canonicalCallRow.querySelectorAll?.('img') || [];
        var hasVisibleRowAvatar = false;
        for (var avatarIndex = 0; avatarIndex < rowAvatarCandidates.length; avatarIndex++) {
          var avatarEl = rowAvatarCandidates[avatarIndex];
          var avatarSrc = avatarEl.currentSrc || avatarEl.src || '';
          if (!avatarSrc || /transparent|blank|emoji|staticxx/i.test(avatarSrc)) continue;
          var avatarRect = avatarEl.getBoundingClientRect?.();
          if (!avatarRect || avatarRect.width < 16 || avatarRect.height < 16) continue;
          if (avatarRect.width > 80 || avatarRect.height > 80) continue;
          var avatarStyle = window.getComputedStyle?.(avatarEl);
          if (avatarStyle && (avatarStyle.display === 'none' || avatarStyle.visibility === 'hidden' || avatarStyle.opacity === '0')) continue;
          hasVisibleRowAvatar = true;
          break;
        }
        isOutgoing = !hasVisibleRowAvatar;

        var displayContent = txt;
        if (durationMatch && !txt.includes(durationMatch[1])) displayContent = txt + ' Ã¢â‚¬Â¢ ' + durationMatch[1];

        // Direction is deliberately NOT part of identity. Facebook hydrates
        // ownership labels after the call row first appears; including the
        // temporary side here turned one call into two bubbles (first A, then B).
        var signature = threadId + '|' + displayContent.toLowerCase().replace(/\s+/g, ' ').trim() + '|' + timeStr;
        var occurrence = (scanCounts.get(signature) || 0) + 1;
        scanCounts.set(signature, occurrence);
        scanCalls.push({ signature: signature, occurrence: occurrence, displayContent: displayContent, timeStr: timeStr, isOutgoing: isOutgoing, hasRowAvatar: hasVisibleRowAvatar });
      }

      if (!_callBaselineReady) {
        // First scan establishes baseline: seed all existing calls as "already seen"
        // so only genuinely NEW calls after this point will trigger emission.
        scanCounts.forEach(function(count, signature) {
          _callSeenCounts.set(signature, count);
        });
        _callPendingDirections.clear();
        _callBaselineReady = true;
        return; // Don't emit anything on the very first scan - it's all history
      }

      for (var c = 0; c < scanCalls.length; c++) {
        var call = scanCalls[c];
        var previouslySeen = _callSeenCounts.get(call.signature) || 0;
        if (call.occurrence <= previouslySeen) continue;

        // Require 2 consecutive scans with the same avatar result (was 4)
        // to give lazy-loaded avatars time to mount before committing direction.
        var pendingKey = call.signature + '|occ' + call.occurrence;
        var pendingDirection = _callPendingDirections.get(pendingKey);
        if (!pendingDirection || pendingDirection.isOutgoing !== call.isOutgoing) {
          _callPendingDirections.set(pendingKey, { isOutgoing: call.isOutgoing, confirmations: 1 });
          continue;
        }
        pendingDirection.confirmations += 1;
        if (pendingDirection.confirmations < 2) continue;
        _callPendingDirections.delete(pendingKey);
        _callSeenCounts.set(call.signature, call.occurrence);

        // Duration/text are not unique: two separate calls to the same person
        // can both be "Voice call - 2 seconds". Baseline/seen-counts already
        // prevent old DOM rows from being emitted again, so add this detection
        // instant to distinguish genuinely new calls across the same thread.
        var callId = 'call_dom_' + callSignatureHash(call.signature + '|occ' + call.occurrence);
        if (_callSentIds.has(callId)) continue;
        _callSentIds.add(callId);

        console.log('[CALL_SCANNER] Tim thay cuoc goi MOI: "' + call.displayContent + '" (' + call.timeStr + ') | hasRowAvatar=' + call.hasRowAvatar + ' | isOutgoing=' + call.isOutgoing + ' | thread=' + threadId + ' | id=' + callId);
        try {
          if (chrome && chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({
              type: 'NEW_MESSAGE_FROM_FB',
              data: {
                thread_id: threadId,
                fb_message_id: callId,
                sender_id: call.isOutgoing ? capturedUserId : null,
                sender_name: call.isOutgoing ? 'BÃ¡ÂºÂ¡n' : '',
                content: call.displayContent,
                is_outgoing: call.isOutgoing,
                has_row_avatar: call.hasRowAvatar,
                direction_evidence: 'call_article_avatar',
                media_type: 'text',
                source: 'dom_observer',
                timestamp_ms: Date.now(),
                timestamp_source: 'realtime_fallback',
                created_at: new Date().toISOString()
              }
            });
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  // Messenger mounts the final call bubble asynchronously after its ringing
  // dialog disappears. Targeted short retries make that bubble realtime while
  // retaining scanCallLogsNow's existing baseline/direction/dedup guards.
  function scheduleFastCallLogSync() {
    [0, 60, 140, 300, 600, 1000, 1600, 2500].forEach(function(delay) {
      window.setTimeout(scanCallLogsNow, delay);
    });
  }

  // Call result rows can mount without another ringing-dialog transition
  // (especially outbound/rejected calls). Observe the chat log itself so the
  // canonical call scanner runs immediately instead of waiting for history.
  var callLogScanTimer = null;
  var callLogObserver = new MutationObserver(function(mutations) {
    if (!mutations.some(function(mutation) { return mutation.addedNodes && mutation.addedNodes.length; })) return;
    if (callLogScanTimer) window.clearTimeout(callLogScanTimer);
    callLogScanTimer = window.setTimeout(function() {
      callLogScanTimer = null;
      scanCallLogsNow();
    }, 35);
  });
  // Do not attach this scanner to arbitrary DOM mutations. Video/image hydration
  // remounts virtualized historical call rows and previously emitted fake
  // call_dom_* records. Real incoming-call lifecycle explicitly seeds/runs it.

  // Synthetic call scanning is deliberately disabled: virtualized historical
  // call rows can remount and look new. The canonical stable-id observer below
  // handles fresh calls without creating fake call_dom_* events.

  // Incoming-call detector. A candidate is valid only when Facebook exposes a
  // visible modal dialog containing BOTH call action buttons and an SVG icon in
  // each button. Never scan page text: call-log messages also contain call words.
  function normalizeCallText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[Ã„â€˜Ã„Â]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function isVisibleCallElement(element) {
    if (!element || !element.isConnected) return false;
    var style = window.getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  }

  function callButtonIntent(button) {
    if (!button) return null;
    var labels = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-tooltip-content'),
      button.textContent
    ];
    var labelled = button.querySelectorAll ? button.querySelectorAll('[aria-label], [title], svg title') : [];
    for (var i = 0; i < labelled.length; i++) {
      labels.push(labelled[i].getAttribute('aria-label'));
      labels.push(labelled[i].getAttribute('title'));
      labels.push(labelled[i].textContent);
    }
    var combined = normalizeCallText(labels.filter(Boolean).join(' '));

    if (/chap nhan|accept|answer|answer call|tra loi|nghe|nhac may|pick up/.test(combined)) return 'accept';
    if (/tu choi|decline|reject|decline call|dismiss|hang up|end call|ignore|ket thuc|bo qua|khong nghe|huy cuoc goi/.test(combined)) return 'decline';
    return null;
  }

  // Control lookup is intentionally independent from ringing detection. Once
  // the CRM popup exists, Facebook may re-render the two control columns at
  // different times. Requiring both buttons again here made either action miss.
  function findIncomingCallActionButton(action) {
    var targetLabel = action === 'accept' ? 'Ch\u1ea5p nh\u1eadn' : 'T\u1eeb ch\u1ed1i';
    var exact = document.querySelector('[aria-label="' + targetLabel + '"][role="button"]') ||
      document.querySelector('[aria-label="' + targetLabel + '"]');
    if (exact && isVisibleCallElement(exact)) return exact;

    var allButtons = document.querySelectorAll('[role="button"], button, a');
    for (var i = 0; i < allButtons.length; i++) {
      var target = allButtons[i];
      if (!isVisibleCallElement(target)) continue;
      if (callButtonIntent(target) === action) {
        return target;
      }
    }
    return null;
  }

  function findKnownMessengerDeclineButton() {
    var root = liveIncomingCallCandidate?.dialog || document;
    var selectors = [
      'div[role="button"][tabindex="0"][aria-label="T\u1eeb ch\u1ed1i"].x1i10hfl.x1ejq31n.x18oe1m7.x1sy0etr',
      'div[role="button"][tabindex="0"][aria-label="T\u1eeb ch\u1ed1i"]',
      '[role="button"][aria-label="T\u1eeb ch\u1ed1i"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var exact = root.querySelector(selectors[i]);
      if (exact && isVisibleCallElement(exact)) return exact;
    }

    // Stable icon fingerprint from the supplied Messenger DOM. Facebook's x*
    // classes are generated and can change, while this decline-X vector is the
    // actual control graphic. Always climb back to the clickable role=button.
    var paths = root.querySelectorAll('svg path');
    for (var j = 0; j < paths.length; j++) {
      var pathData = String(paths[j].getAttribute('d') || '').trim();
      if (!pathData.startsWith('m12.631 25.138 5.196-5.189')) continue;
      var button = paths[j].closest('[role="button"], button');
      if (button && isVisibleCallElement(button)) return button;
    }
    return null;
  }

  // Independent decline fallback: current Messenger builds may omit the
  // aria-label but retain a red circular phone-off control. This intentionally
  // never references or derives position from the Accept button.
  function findRedIncomingCallDeclineButton() {
    var candidate = liveIncomingCallCandidate || findIncomingCallCandidate();
    var root = candidate?.dialog || document;
    var controls = root.querySelectorAll('[role="button"], button');
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (!isVisibleCallElement(control) || callButtonIntent(control) === 'accept') continue;
      var rect = control.getBoundingClientRect();
      if (rect.width < 32 || rect.height < 32 || rect.width > 110 || rect.height > 110) continue;
      var painted = [control].concat(Array.from(control.querySelectorAll('div, span, svg')));
      var redStrength = 0;
      for (var j = 0; j < painted.length; j++) {
        var color = window.getComputedStyle(painted[j]).backgroundColor || '';
        var rgb = color.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
        if (!rgb) continue;
        var red = Number(rgb[1]);
        var green = Number(rgb[2]);
        var blue = Number(rgb[3]);
        redStrength = Math.max(redStrength, red - Math.max(green, blue));
      }
      if (redStrength < 45) continue;
      var roundness = Math.abs(rect.width - rect.height);
      var score = redStrength - roundness;
      if (score > bestScore) { best = control; bestScore = score; }
    }
    return best;
  }
  function findCallButtonFromRingingText(action) {
    var candidate = liveIncomingCallCandidate || findIncomingCallCandidate();
    var root = candidate?.dialog || null;
    if (!root || !isVisibleCallElement(root)) return null;
    var pattern = action === 'accept'
      ? /chap nhan|accept|answer|tra loi|nghe|nhac may|pick up/
      : /tu choi|decline|reject|dismiss|hang up|end call|ket thuc|bo qua|khong nghe|huy cuoc goi/;
    var nodes = root.querySelectorAll('[aria-label], [title], [role="button"], button, span, div');
    var best = null;
    var bestArea = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!isVisibleCallElement(node)) continue;
      var ownLabel = normalizeCallText((node.getAttribute?.('aria-label') || '') + ' ' + (node.getAttribute?.('title') || ''));
      var ownText = normalizeCallText(node.textContent || '');
      if (!pattern.test(ownLabel) && !(ownText.length > 0 && ownText.length <= 80 && pattern.test(ownText))) continue;
      var clickable = node.matches?.('[role="button"], button')
        ? node
        : node.closest?.('[role="button"], button') || node.querySelector?.('[role="button"], button');
      if (!clickable || !root.contains(clickable) || !isVisibleCallElement(clickable)) continue;
      var rect = clickable.getBoundingClientRect();
      var area = rect.width * rect.height;
      if (area < bestArea) { best = clickable; bestArea = area; }
    }
    return best;
  }

  function findDeclineButtonBesideAccept() {
    var acceptButton = findIncomingCallActionButton('accept');
    if (!acceptButton) return null;
    var root = acceptButton.closest?.('[role="dialog"], [role="alertdialog"]');
    if (!root) {
      var candidate = findIncomingCallCandidate();
      root = candidate?.dialog || null;
    }
    if (!root) return null;

    var acceptRect = acceptButton.getBoundingClientRect();
    var acceptX = acceptRect.left + acceptRect.width / 2;
    var acceptY = acceptRect.top + acceptRect.height / 2;
    var controls = root.querySelectorAll('[role="button"], button');
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (control === acceptButton || control.contains(acceptButton) || acceptButton.contains(control)) continue;
      if (!isVisibleCallElement(control) || callButtonIntent(control) === 'accept') continue;
      var rect = control.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var dx = Math.abs(x - acceptX);
      var dy = Math.abs(y - acceptY);
      if (dx < 20 || dx > 320 || dy > 70) continue;
      var score = dx + dy * 4;
      if (callButtonIntent(control) === 'decline') score -= 1000;
      if (score < bestScore) { best = control; bestScore = score; }
    }
    return best;
  }

  function extractCallerNameFromDialog(dialog) {
    var nodes = dialog.querySelectorAll('h1, h2, h3, span, div');
    for (var i = 0; i < nodes.length; i++) {
      var raw = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length > 120) continue;
      var normalized = normalizeCallText(raw);
      var marker = normalized.indexOf(' dang goi cho ban');
      if (marker > 0) {
        var directMatch = raw.match(/^(.+?)\s+Ã„â€˜ang gÃ¡Â»Âi cho bÃ¡ÂºÂ¡n(?:\s|$)/i);
        return (directMatch ? directMatch[1] : raw.slice(0, marker)).trim().substring(0, 60);
      }
    }
    return '';
  }

  function findIncomingCallCandidate() {
    var isAudioRinging = false;
    try {
      var audioElements = document.querySelectorAll('audio, video');
      for (var a = 0; a < audioElements.length; a++) {
        var mediaEl = audioElements[a];
        if (!mediaEl.paused && mediaEl.currentTime > 0 && /ring|call|audio|voice/i.test(mediaEl.src || '')) {
          isAudioRinging = true;
          break;
        }
      }
    } catch (_) {}

    var candidateSelectors = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="banner"]',
      'div[aria-label*="gÃ¡Â»Âi"]',
      'div[aria-label*="call"]',
      'div[aria-label*="GÃ¡Â»Å’I"]',
      'div[class*="call"]',
      'div[class*="Call"]',
      'div[class*="ring"]',
      'div[class*="Ring"]'
    ];
    var candidates = document.querySelectorAll(candidateSelectors.join(', '));
    for (var i = 0; i < candidates.length; i++) {
      var dialog = candidates[i];
      if (!isVisibleCallElement(dialog)) continue;

      // Never match elements inside main chat transcript grid/feed
      if (dialog.closest && dialog.closest('[role="main"], [role="grid"], [role="feed"]')) {
        continue;
      }

      var rawAria = dialog.getAttribute('aria-label') || '';
      var rawText = dialog.textContent || '';
      var combinedText = normalizeCallText(rawAria + ' ' + rawText);

      // Must be an active incoming call indicator or active audio ringtone
      var isCallIndicator = isAudioRinging || /cuoc goi|incoming call|dang goi cho ban|is calling/.test(combinedText);
      if (!isCallIndicator) continue;

      // The supplied Facebook DOM exposes these exact aria-labels on the
      // clickable role=button nodes. Prefer them before fuzzy text matching.
      var acceptButton = dialog.querySelector(
        '[role="button"][aria-label="Ch\u1ea5p nh\u1eadn"], [role="button"][aria-label="Accept"], [role="button"][aria-label="Answer"]'
      );
      var declineButton = dialog.querySelector(
        '[role="button"][aria-label="T\u1eeb ch\u1ed1i"], [role="button"][aria-label="Decline"], [role="button"][aria-label="Reject"]'
      );
      var buttons = dialog.querySelectorAll('[role="button"], button, a');
      for (var j = 0; j < buttons.length; j++) {
        if (!isVisibleCallElement(buttons[j])) continue;
        var intent = callButtonIntent(buttons[j]);
        if (!acceptButton && intent === 'accept') acceptButton = buttons[j];
        if (!declineButton && intent === 'decline') declineButton = buttons[j];
      }

      // Do not return a nested half of the controls. The previous OR condition
      // commonly returned the Accept column before the Decline column existed
      // in that candidate, making Accept reliable and Decline a null target.
      if (acceptButton || declineButton) {
        return { dialog: dialog, acceptButton: acceptButton, declineButton: declineButton, callerName: extractCallerNameFromDialog(dialog) };
      }
    }
    return null;
  }

  var incomingCallState = { phase: 'IDLE', signature: null, stableScans: 0, callId: null, callerName: '' };
  var liveIncomingCallCandidate = null;
  function scanIncomingCallDialog() {
    try {
      var candidate = findIncomingCallCandidate();
      liveIncomingCallCandidate = candidate || null;
      if (!candidate) {
        if (incomingCallState.phase === 'RINGING') {
          stopAllRingtoneAudio();
          chrome.runtime.sendMessage({ type: 'INCOMING_CALL_ENDED', data: { call_id: incomingCallState.callId, timestamp: Date.now() } });
          scheduleFastCallLogSync();
        }
        incomingCallState = { phase: 'IDLE', signature: null, stableScans: 0, callId: null, callerName: '' };
        return;
      }

      var threadId = extractThreadIdFromUrl();
      // Do not include caller name: Facebook inserts it after the dialog shell,
      // and changing the signature here would restart detection mid-ring.
      var signature = (threadId || 'unknown') + '|incoming-dialog';
      if (incomingCallState.signature !== signature) {
        incomingCallState = { phase: 'CANDIDATE', signature: signature, stableScans: 1, callId: null, callerName: candidate.callerName || '' };
        return;
      }
      incomingCallState.stableScans += 1;
      if (incomingCallState.phase !== 'RINGING' && incomingCallState.stableScans >= 2) {
        incomingCallState.phase = 'RINGING';
        incomingCallState.callId = 'incoming_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        incomingCallState.callerName = candidate.callerName || '';
        chrome.runtime.sendMessage({
          type: 'INCOMING_CALL_RINGING',
          data: { call_id: incomingCallState.callId, thread_id: threadId || null, caller_name: incomingCallState.callerName, timestamp: Date.now() }
        });
        // Seed the existing call rows before the new final row is mounted.
        // This ensures the first post-call scan can recognize it as new.
        scanCallLogsNow();
      } else if (incomingCallState.phase === 'RINGING' && candidate.callerName && candidate.callerName !== incomingCallState.callerName) {
        // Update the existing CRM popup as soon as the delayed caller name is mounted.
        incomingCallState.callerName = candidate.callerName;
        chrome.runtime.sendMessage({
          type: 'INCOMING_CALL_RINGING',
          data: { call_id: incomingCallState.callId, thread_id: threadId || null, caller_name: incomingCallState.callerName, timestamp: Date.now(), update: true }
        });
      }
    } catch (error) {
      console.warn('[CALL_RINGING] Detector error:', error);
    }
  }

  // MutationObserver catches Facebook's short-lived mount transitions; the
  // interval remains as a fallback when React mutates attributes in place.
  var incomingCallScanQueued = false;
  var incomingCallObserver = new MutationObserver(function () {
    if (incomingCallScanQueued) return;
    incomingCallScanQueued = true;
    window.setTimeout(function () {
      incomingCallScanQueued = false;
      scanIncomingCallDialog();
    }, 50);
  });
  incomingCallObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-modal', 'role'] });
  setInterval(scanIncomingCallDialog, 300);
  // Ã¢â€â‚¬Ã¢â€â‚¬ End Call Log Scanner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
})();
