// AutoChatbot FB Engine - MAIN World Interceptor
(function() {
  if (window.__AUTOCHATBOT_INJECTED__) return;

  // A newly-added account may need Facebook's encrypted-history PIN flow.
  // Keep that setup tab pristine: wrapping Fetch/XHR/WebSocket during Secure
  // Storage initialization can leave Facebook's dialog stuck on skeletons.
  // sessionStorage lasts only for this tab; the later normal "Kết nối
  // Facebook" launch receives the full interceptor as usual.
  try {
    const pendingFromUrl = new URL(window.location.href).searchParams.has('crm_pending_key');
    // Do not trust the session marker on its own: it survives extension
    // reloads and used to leave the network interceptor disabled until the
    // operator sent an outbound message. The setup URL is authoritative.
    if (pendingFromUrl) {
      console.log('[FB Interceptor] Skipped during new-account secure setup.');
      return;
    }
  } catch (_) {}

  window.__AUTOCHATBOT_INJECTED__ = true;

  console.log('[FB Interceptor] 🚀 MAIN World Interceptor initialized at document_start');

  function getCurrentUserId() {
    return document.cookie.match(/c_user=(\d+)/)?.[1] || null;
  }

  // Helper function to send message to Isolated World (content.js)
  function emitNetworkMessage(data) {
    if (!data || !data.thread_id || (!data.content && !data.media_url && !data.media_type)) return;
    const currentUserId = getCurrentUserId();
    const senderIdStr = data.sender_id ? String(data.sender_id) : null;
    const isOutgoing = (currentUserId && senderIdStr === String(currentUserId)) || !!data.is_outgoing;

    window.postMessage({
      type: 'FB_NETWORK_MESSAGE',
      data: {
        thread_id: String(data.thread_id),
        fb_message_id: data.fb_message_id || data.message_id || null,
        sender_id: senderIdStr,
        sender_name: data.sender_name || (isOutgoing ? 'Bạn' : null),
        content: data.content ? String(data.content).trim() : '',
        media_type: data.media_type || (data.media_url ? 'image' : 'text'),
        media_url: data.media_url || null,
        poster_url: data.poster_url || null,
        is_outgoing: isOutgoing,
        timestamp_ms: data.timestamp_ms || null,
        created_at: data.created_at || new Date().toISOString(),
        source: 'network_interceptor'
      }
    }, '*');
  }

  // 1. Intercept Fetch API
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      if (args[1]?.body) {
        const body = args[1].body;
        if (typeof body === 'string' && body.includes('fb_dtsg=')) {
          const m = body.match(/fb_dtsg=([^&]+)/);
          if (m && m[1]) {
            window.postMessage({ type: 'FB_TOKEN_DISCOVERED', fb_dtsg: decodeURIComponent(m[1]) }, '*');
          }
        }
      }
    } catch (_) {}
    const response = await originalFetch.apply(this, args);
    try {
      const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
      if (url && (url.includes('/api/graphql/') || url.includes('/ajax/messenger/'))) {
        const clone = response.clone();
        clone.text().then(text => parseNetworkResponseBody(text, url)).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // 2. Intercept XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        if (this._url && (this._url.includes('/api/graphql/') || this._url.includes('/ajax/messenger/'))) {
          parseNetworkResponseBody(this.responseText, this._url);
        }
      } catch (e) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // 3. Intercept WebSocket Frames (Facebook MQTT/Messenger WS)
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    try {
      ws.addEventListener('message', (event) => {
        try {
          parseWebSocketData(event.data);
        } catch (e) {}
      });
    } catch (e) {}
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // Parser function for HTTP GraphQL/Ajax response body
  function parseNetworkResponseBody(bodyText, url) {
    if (!bodyText || typeof bodyText !== 'string') return;

    // Handle multiline JSON lines returned by Facebook GraphQL (for stringified JSON lines)
    const lines = bodyText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        extractMessagesFromJSON(json);
      } catch (e) {}
    }
  }

  // ── MQTT binary frame parsing (Messenger realtime 'msgr' channel) ──
  // Facebook MQTT dùng header MQIsdp 0x82 (PUBLISH QoS1): [header][remaining
  // length varint][2B topic len][topic][2B packet id][payload]. Payload là
  // zlib/deflate chứa JSON có deltas - trong đó deltaReadReceipt mang
  // watermarkTimestampMs: chính là dữ liệu Facebook dùng để vẽ 'Đã xem'.
  function extractMqttPayload(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      if (!bytes || bytes.length < 6) return null;
      const first = bytes[0];
      const type = first & 0xF0;
      const isPublish = type === 0x30 || type === 0x80; // MQTT v3.1.1 / MQIsdp
      if (!isPublish) return null;
      let pos = 1;
      let remaining = 0;
      let mult = 1;
      for (let i = 0; i < 4 && pos < bytes.length; i++) {
        const b = bytes[pos++];
        remaining += (b & 0x7F) * mult;
        mult *= 128;
        if ((b & 0x80) === 0) break;
      }
      if (remaining <= 0 || pos + remaining > bytes.length) return null;
      const topicLen = (bytes[pos] << 8) | bytes[pos + 1];
      if (topicLen <= 0 || pos + 2 + topicLen > bytes.length) return null;
      let p = pos + 2 + topicLen;
      const qos = (first >> 1) & 0x03;
      if (qos > 0) p += 2; // packet identifier
      if (p >= bytes.length) return null;
      return bytes.slice(p);
    } catch (_) { return null; }
  }

  async function inflateMqttPayload(payload) {
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([payload]).stream().pipeThrough(ds);
        const out = await new Response(stream).arrayBuffer();
        return new TextDecoder('utf-8').decode(out);
      } catch (_) {}
    }
    return null;
  }

  async function handleBinaryFrame(buffer) {
    try {
      const mqttPayload = extractMqttPayload(buffer);
      if (mqttPayload && mqttPayload.length) {
        const inflated = await inflateMqttPayload(mqttPayload);
        if (inflated && inflated.length > 2) {
          try {
            const json = JSON.parse(inflated);
            extractMessagesFromJSON(json);
            return;
          } catch (_) {}
        }
      }
      // Fallback: frame không phải MQTT/nén - decode thẳng như text.
      const text = new TextDecoder('utf-8').decode(buffer);
      if (text && text[0] === '{') {
        try { extractMessagesFromJSON(JSON.parse(text)); return; } catch (_) {}
      }
      extractMessagesFromRawText(text);
    } catch (_) {}
  }

  // Parser function for WebSocket frames
  function parseWebSocketData(data) {
    if (!data) return;
    if (typeof data === 'string') {
      try {
        const json = JSON.parse(data);
        extractMessagesFromJSON(json);
      } catch (e) {
        // Raw text frame matching thread/message pattern
        extractMessagesFromRawText(data);
      }
    } else if (data instanceof ArrayBuffer) {
      handleBinaryFrame(data);
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Chrome delivers Facebook/Messenger realtime frames as Blob by
      // default. The old interceptor handled only string/ArrayBuffer, so
      // genuine customer messages on an already-open socket were silently
      // ignored until another action caused a HTTP/DOM refresh.
      data.arrayBuffer().then((buffer) => handleBinaryFrame(buffer)).catch(() => {});
    }
  }

  // ── Read receipt ('Đã xem') từ MQTT delta chính chủ của Facebook ──
  // deltaReadReceipt/tamReadReceipt mang watermarkTimestampMs = mốc khách đã
  // đọc tới. Bắt từ đây là bắt 'đã xem' chuẩn như Messenger, không phụ thuộc
  // DOM hay việc thread có đang mở không.
  const lastReadReceiptWatermark = new Map();
  function emitReadReceipt(threadId, watermarkMs, actor) {
    try {
      if (!threadId || !(watermarkMs > 0)) return;
      const uid = getCurrentUserId();
      // Operator tự đọc tin của khách cũng sinh read receipt - bỏ qua,
      // chỉ quan tâm KHÁCH đọc tin của mình.
      if (uid && actor && String(actor) === String(uid)) return;
      const prev = lastReadReceiptWatermark.get(String(threadId)) || 0;
      if (watermarkMs <= prev) return;
      lastReadReceiptWatermark.set(String(threadId), watermarkMs);
      console.log('[FB ReadReceipt] khách đã xem:', { thread: String(threadId), watermark: watermarkMs, actor: String(actor || '') });
      window.postMessage({
        type: 'FB_READ_RECEIPT',
        data: { thread_id: String(threadId), watermark_ms: watermarkMs, actor: actor ? String(actor) : '' }
      }, '*');
    } catch (_) {}
  }

  function extractThreadIdFromReceipt(receipt) {
    try {
      const keys = receipt && receipt.threadKeys;
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (!k || typeof k !== 'object') continue;
          const id = k.otherUserFbId || k.threadFbId || k.thread_fbid || k.threadId;
          if (id) return String(id);
        }
      }
      const tk = receipt && receipt.threadKey;
      if (tk && typeof tk === 'object') {
        const id = tk.otherUserFbId || tk.threadFbId || tk.thread_fbid || tk.threadId;
        if (id) return String(id);
      }
      const direct = receipt && (receipt.otherUserFbId || receipt.threadFbId || receipt.thread_fbid || receipt.threadId);
      return direct ? String(direct) : null;
    } catch (_) { return null; }
  }

  // Recursive extractor for JSON payloads
  function extractMessagesFromJSON(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;

    // Read receipt: watermark + thread key -> 'Đã xem' chuẩn của Facebook.
    if (obj.watermarkTimestampMs !== undefined || obj.watermark_ms !== undefined) {
      const wm = Number(obj.watermarkTimestampMs) || Number(obj.watermark_ms) || 0;
      if (wm > 0) {
        const tid = extractThreadIdFromReceipt(obj);
        if (tid) emitReadReceipt(tid, wm, obj.actor || obj.actorFbId || '');
      }
    }

    // Direct message node matching Facebook GraphQL schema
    const msgId = obj.message_id || obj.offline_threading_id || obj.messageId ||
      (typeof obj.id === 'string' && obj.id.startsWith('mid.') ? obj.id : null);

    if (msgId) {
      const threadId = obj.thread_id || obj.thread_fbid || obj.other_user_id || obj.threadKey?.thread_fbid || obj.thread_key?.thread_fbid;
      const content = obj.text || obj.body || obj.message?.text || '';
      const senderId = obj.sender_id || obj.sender_fbid || obj.author || obj.message_sender?.id;

      // Quét bóc tách link CDN video và poster thumbnail từ GraphQL payload
      let foundVid = null;
      let foundPoster = null;
      const scanVidObj = (o, d = 0) => {
        if (!o || typeof o !== 'object' || d > 5) return;
        const vKeys = [
          'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url', 'browser_native_sd_url',
          'video_direct_url', 'videoDirectUrl', 'playableUrl', 'playableUrlQualityHd',
          'hd_src', 'sd_src', 'streaming_url', 'download_url', 'downloadUrl', 'src', 'video_url', 'videoUrl'
        ];
        for (const vk of vKeys) {
          const val = o[vk];
          if (typeof val === 'string' && /^https?:\/\//i.test(val) && !val.includes('/rsrc.php')) {
            if (!foundVid) foundVid = val;
          }
        }
        const pKeys = [
          'preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl', 'poster_url', 'posterUrl',
          'large_preview', 'preview_image', 'thumbnail', 'image', 'photo_image', 'cover_image'
        ];
        for (const pk of pKeys) {
          const pv = o[pk];
          if (typeof pv === 'string' && /^https?:\/\//i.test(pv) && !pv.includes('/emoji.php') && !pv.includes('/rsrc.php')) {
            if (!foundPoster) foundPoster = pv;
          } else if (pv && typeof pv === 'object' && typeof pv.uri === 'string' && /^https?:\/\//i.test(pv.uri)) {
            if (!foundPoster && !pv.uri.includes('/emoji.php') && !pv.uri.includes('/rsrc.php')) foundPoster = pv.uri;
          }
        }
        const cKeys = [
          'attachment', 'attachments', 'blob_attachments', 'video_attachments',
          'extensible_attachment', 'story', 'media', 'video', 'video_delivery', 'message_attachments'
        ];
        for (const ck of cKeys) {
          const ch = o[ck];
          if (Array.isArray(ch)) {
            for (const it of ch) scanVidObj(it, d + 1);
          } else if (ch && typeof ch === 'object') {
            scanVidObj(ch, d + 1);
          }
        }
      };
      scanVidObj(obj);

      if (foundVid || foundPoster) {
        pageVideoCache.set(msgId, { videoUrl: foundVid, posterUrl: foundPoster });
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(msgId) : msgId;
        const msgNode = document.querySelector(`[data-message-id="${escaped}"]`) || document.querySelector(`[data-id="${escaped}"]`);
        if (msgNode) {
          applyResolvedVideoToDom(msgNode, foundVid, foundPoster);
        }
        window.postMessage({
          type: 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE',
          fb_message_id: msgId,
          videoUrl: foundVid,
          posterUrl: foundPoster
        }, '*');
      }

      if (threadId && (content || foundVid || foundPoster)) {
        emitNetworkMessage({
          thread_id: threadId,
          fb_message_id: msgId,
          sender_id: senderId,
          content: content,
          media_type: (foundVid || foundPoster) ? 'video' : 'text',
          media_url: foundVid || foundPoster || null,
          poster_url: foundPoster || null,
          is_outgoing: obj.is_outgoing || false,
          timestamp_ms: obj.timestamp_precise || obj.timestamp || null,
          created_at: obj.timestamp ? new Date(Number(obj.timestamp)).toISOString() : new Date().toISOString()
        });
      }
    }

    // Traverse arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) extractMessagesFromJSON(item, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (typeof value === 'object') {
          extractMessagesFromJSON(value, depth + 1);
        } else if (typeof value === 'string' && value.length > 1 && value.length < 100000
          && (value[0] === '{' || value[0] === '[')) {
          // MQTT/GraphQL envelopes commonly carry the actual message JSON in
          // a string-valued payload. Decode only JSON-looking bounded values
          // and retain the existing recursive depth guard.
          try { extractMessagesFromJSON(JSON.parse(value), depth + 1); } catch (_) {}
        }
      }
    }
  }

  // Text search fallback for WebSocket binary text frames
  function extractMessagesFromRawText(text) {
    if (!text || text.length < 20) return;
    
    // Look for JSON-like strings inside WebSocket frames
    const jsonMatches = text.match(/\{"thread_fbid":[^}]+\}/g) || text.match(/\{"message_id":[^}]+\}/g);
    if (jsonMatches) {
      for (const str of jsonMatches) {
        try {
          extractMessagesFromJSON(JSON.parse(str));
        } catch (e) {}
      }
    }
  }

  // =========================================================================
  // MAIN World React Fiber Resolver cho Video trên Meta Business Suite
  // =========================================================================
  const pageVideoCache = new Map();
  window.__AUTOCHATBOT_PAGE_VIDEO_CACHE__ = pageVideoCache;

  function extractVideoCdnFromReactNode(node) {
    if (!node) return { videoUrl: null, posterUrl: null };
    try {
      const keys = Object.keys(node);
      const reactKey = keys.find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$') || k.startsWith('__reactInternalInstance$'));
      if (!reactKey) return { videoUrl: null, posterUrl: null };

      let curr = node[reactKey];
      let depth = 0;
      let foundVideo = null;
      let foundPoster = null;

      function scanObject(obj, currentDepth = 0) {
        if (!obj || typeof obj !== 'object' || currentDepth > 6) return;

        const videoKeys = [
          'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url',
          'browser_native_sd_url', 'video_direct_url', 'videoDirectUrl', 'playableUrl',
          'playableUrlQualityHd', 'hd_src', 'sd_src', 'streaming_url', 'download_url',
          'downloadUrl', 'src', 'video_url', 'videoUrl'
        ];
        for (const vk of videoKeys) {
          const val = obj[vk];
          if (typeof val === 'string' && /^https?:\/\//i.test(val) && !val.includes('/rsrc.php')) {
            if (!foundVideo) foundVideo = val;
          }
        }

        const posterKeys = [
          'preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl',
          'poster_url', 'posterUrl', 'large_preview', 'preview_image',
          'thumbnail', 'image', 'photo_image', 'cover_image'
        ];
        for (const pk of posterKeys) {
          const pval = obj[pk];
          if (typeof pval === 'string' && /^https?:\/\//i.test(pval)) {
            if (!foundPoster && !pval.includes('/emoji.php') && !pval.includes('/rsrc.php')) foundPoster = pval;
          } else if (pval && typeof pval === 'object' && typeof pval.uri === 'string' && /^https?:\/\//i.test(pval.uri)) {
            if (!foundPoster && !pval.uri.includes('/emoji.php') && !pval.uri.includes('/rsrc.php')) foundPoster = pval.uri;
          }
        }

        const containers = [
          'attachment', 'attachments', 'blob_attachments', 'video_attachments',
          'extensible_attachment', 'story', 'media', 'video', 'video_delivery',
          'message_attachments', 'videoGrid', 'mediaMetadata'
        ];
        for (const ck of containers) {
          const child = obj[ck];
          if (Array.isArray(child)) {
            for (const item of child) scanObject(item, currentDepth + 1);
          } else if (child && typeof child === 'object') {
            scanObject(child, currentDepth + 1);
          }
        }
      }

      while (curr && depth < 50) {
        depth++;
        const props = curr.memoizedProps || curr.props || (depth === 1 ? curr : null);
        if (props) scanObject(props);
        const state = curr.memoizedState;
        if (state) scanObject(state);
        if (foundVideo) break;
        curr = curr.return || curr.child;
      }

      return { videoUrl: foundVideo || null, posterUrl: foundPoster || null };
    } catch (_) {
      return { videoUrl: null, posterUrl: null };
    }
  }

  function resolveVideoForMessageNode(msgNode) {
    if (!msgNode) return { videoUrl: null, posterUrl: null };
    const videoEl = msgNode.querySelector('video') || msgNode;
    const directSrc = (videoEl.currentSrc && /^https?:\/\//i.test(videoEl.currentSrc))
      ? videoEl.currentSrc
      : ((videoEl.src && /^https?:\/\//i.test(videoEl.src)) ? videoEl.src : (videoEl.getAttribute && videoEl.getAttribute('src') && /^https?:\/\//i.test(videoEl.getAttribute('src')) ? videoEl.getAttribute('src') : null));
    if (directSrc) {
      return { videoUrl: directSrc, posterUrl: videoEl.poster || videoEl.getAttribute?.('poster') || null };
    }

    let res = extractVideoCdnFromReactNode(videoEl);
    if (!res.videoUrl && videoEl !== msgNode) {
      const msgRes = extractVideoCdnFromReactNode(msgNode);
      if (msgRes.videoUrl) res.videoUrl = msgRes.videoUrl;
      if (msgRes.posterUrl && !res.posterUrl) res.posterUrl = msgRes.posterUrl;
    }

    // Fallback: Tìm ảnh thumbnail hoặc background-image trong msgNode
    if (!res.posterUrl && msgNode) {
      const thumbImg = msgNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
      if (thumbImg) {
        const src = thumbImg.currentSrc || thumbImg.getAttribute('src');
        if (src && /^https?:\/\//i.test(src)) res.posterUrl = src;
      }
      if (!res.posterUrl) {
        const bgEls = msgNode.querySelectorAll('[style*="background-image"]');
        for (const bg of bgEls) {
          const m = (bg.getAttribute('style') || '').match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
          if (m && /^https?:\/\//i.test(m[2])) {
            res.posterUrl = m[2];
            break;
          }
        }
      }
    }

    return res;
  }

  function applyResolvedVideoToDom(msgNode, videoUrl, posterUrl) {
    if (!msgNode) return;
    if (videoUrl) {
      msgNode.setAttribute('data-crm-video-url', videoUrl);
      const videoEl = msgNode.querySelector('video');
      if (videoEl) videoEl.setAttribute('data-crm-video-url', videoUrl);
    }
    if (posterUrl) {
      msgNode.setAttribute('data-crm-poster-url', posterUrl);
      const videoEl = msgNode.querySelector('video');
      if (videoEl) videoEl.setAttribute('data-crm-poster-url', posterUrl);
    }
  }

  function scanAndStampMountedVideos() {
    try {
      const videos = document.querySelectorAll('video, [aria-label*="video" i], [data-surface*="video"]');
      for (const v of videos) {
        const msgNode = v.closest('[data-message-id]') || v.closest('[data-id]') || v;
        const mid = msgNode?.getAttribute?.('data-message-id') || msgNode?.getAttribute?.('data-id');
        if (!mid) continue;

        let res = null;
        if (pageVideoCache.has(mid)) {
          res = pageVideoCache.get(mid);
        }
        if (!res?.videoUrl) {
          res = resolveVideoForMessageNode(msgNode);
          if ((res?.videoUrl || res?.posterUrl) && mid) {
            pageVideoCache.set(mid, res);
          }
        }
        if (res?.videoUrl || res?.posterUrl) {
          applyResolvedVideoToDom(msgNode, res.videoUrl, res.posterUrl);
          window.postMessage({
            type: 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE',
            fb_message_id: mid,
            videoUrl: res.videoUrl || null,
            posterUrl: res.posterUrl || null
          }, '*');
        }
      }
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'CRM_RESOLVE_PAGE_VIDEO_REQUEST') {
      const fbMessageId = event.data.fb_message_id;
      if (!fbMessageId) return;

      let cached = pageVideoCache.get(fbMessageId);
      let videoUrl = cached?.videoUrl || null;
      let posterUrl = cached?.posterUrl || null;

      if (!videoUrl) {
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(fbMessageId) : fbMessageId;
        const msgNode = document.querySelector(`[data-message-id="${escaped}"]`) ||
          document.querySelector(`[data-id="${escaped}"]`);
        if (msgNode) {
          const res = resolveVideoForMessageNode(msgNode);
          if (res.videoUrl || res.posterUrl) {
            videoUrl = res.videoUrl;
            posterUrl = res.posterUrl;
            applyResolvedVideoToDom(msgNode, videoUrl, posterUrl);
            pageVideoCache.set(fbMessageId, { videoUrl, posterUrl });
          }
        }
      }

      window.postMessage({
        type: 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE',
        fb_message_id: fbMessageId,
        videoUrl: videoUrl || null,
        posterUrl: posterUrl || null
      }, '*');
    }

    if (event.data?.type === 'CRM_EXTRACT_BIZ_SIDEBAR_REQUEST') {
      scanAndStampBizSidebarRows();
    }
  });

  // ── MAIN World React Fiber Extractor for Meta Business Suite Sidebar ──
  const BIZ_THREAD_ID_PROPS = [
    'threadID', 'threadId', 'thread_id', 'threadKey', 'thread_key',
    'threadFbid', 'thread_fbid', 'conversationID', 'conversation_id',
    'otherUserFbId', 'other_user_id', 'recipientId', 'selected_item_id', 'itemId'
  ];

  function findIdInValue(val, excludeId) {
    if (!val) return null;
    if (typeof val === 'string' || typeof val === 'number') {
      const s = String(val).trim();
      const m = s.match(/(\d{10,})/);
      if (m && m[1] && m[1] !== excludeId) return m[1];
      return null;
    }
    if (typeof val === 'object') {
      const subKeys = [
        'threadFbId', 'thread_fbid', 'threadFbid', 'otherUserFbId', 'other_user_id',
        'threadID', 'threadId', 'thread_id', 'id', 'itemId', 'item_id', 'key'
      ];
      for (const sk of subKeys) {
        try {
          const sv = val[sk];
          if (sv && (typeof sv === 'string' || typeof sv === 'number')) {
            const sm = String(sv).match(/(\d{10,})/);
            if (sm && sm[1] && sm[1] !== excludeId) return sm[1];
          }
        } catch (_) {}
      }
    }
    return null;
  }

  function findNameInValue(val) {
    if (!val) return null;
    if (typeof val === 'string') {
      const s = val.trim();
      if (s.length >= 2 && s.length <= 80 && !/^\d+$/.test(s) && !/^(?:Tất cả|Inbox|Hộp thư|Tin nhắn|Spam|Meta|Facebook|Bạn|You)$/i.test(s)) {
        return s;
      }
      return null;
    }
    if (typeof val === 'object') {
      const nameSubKeys = ['name', 'text', 'title', 'threadTitle', 'contactName', 'nameWithDefault', 'displayName'];
      for (const nsk of nameSubKeys) {
        try {
          const nv = val[nsk];
          if (typeof nv === 'string') {
            const s = nv.trim();
            if (s.length >= 2 && s.length <= 80 && !/^\d+$/.test(s) && !/^(?:Tất cả|Inbox|Hộp thư|Tin nhắn|Spam|Meta|Facebook|Bạn|You)$/i.test(s)) {
              return s;
            }
          }
        } catch (_) {}
      }
    }
    return null;
  }

  function extractBizThreadFromFiber(rootEl, excludeId) {
    if (!rootEl) return null;
    const candidates = [rootEl, ...Array.from(rootEl.querySelectorAll('*')).slice(0, 15)];
    for (const el of candidates) {
      let reactKey = null;
      try {
        reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      } catch (_) {}
      if (!reactKey) continue;
      let curr = el[reactKey];
      let depth = 0;
      let threadId = null;
      let contactName = null;

      while (curr && depth < 45) {
        depth++;
        const props = curr.memoizedProps || curr.props;
        if (props) {
          if (!threadId) {
            for (const p of BIZ_THREAD_ID_PROPS) {
              const tid = findIdInValue(props[p], excludeId);
              if (tid) {
                threadId = tid;
                break;
              }
            }
            if (!threadId) {
              const objProps = ['thread', 'item', 'conversation', 'node', 'threadKey', 'row', 'data'];
              for (const op of objProps) {
                const tid = findIdInValue(props[op], excludeId);
                if (tid) {
                  threadId = tid;
                  break;
                }
              }
            }
          }
          if (!contactName) {
            const nameProps = ['contactName', 'name', 'threadTitle', 'title', 'thread', 'item', 'conversation', 'node'];
            for (const np of nameProps) {
              const cname = findNameInValue(props[np]);
              if (cname) {
                contactName = cname;
                break;
              }
            }
          }
          if (threadId && contactName) break;
        }
        curr = curr.return;
      }
      if (threadId) return { threadId, contactName };
    }
    return null;
  }

  function findVisibleBizRowAncestor(marker) {
    let node = marker;
    while (node && node !== document.body) {
      const h = node.clientHeight || node.offsetHeight || 0;
      const w = node.clientWidth || node.offsetWidth || 0;
      if (h >= 30 && h <= 200 && w >= 120) return node;
      node = node.parentElement;
    }
    return marker;
  }

  function scanAndStampBizSidebarRows() {
    try {
      const isBizPage = window.location.hostname.includes('business.facebook.com')
        || window.location.href.includes('asset_id=')
        || window.location.href.includes('mailbox_id=')
        || window.location.href.includes('/biz/')
        || (window.location.hostname.includes('facebook.com') && (window.location.search.includes('asset_id=') || window.location.search.includes('mailbox_id=')));
      if (!isBizPage) return;

      const urlParams = new URLSearchParams(window.location.search);
      const pageId = urlParams.get('asset_id') || urlParams.get('mailbox_id') || null;

      const markers = Array.from(document.querySelectorAll('[data-surface*="thread_row"]'));
      const candidateElements = [];

      if (markers.length > 0) {
        for (const m of markers) {
          const rowContainer = findVisibleBizRowAncestor(m);
          candidateElements.push({ marker: m, container: rowContainer });
        }
      } else {
        const fallbackRows = Array.from(document.querySelectorAll('[role="row"], [role="listitem"], [data-surface*="thread"], div[tabindex="0"], div[tabindex="-1"]')).filter(el => {
          try {
            const rect = el.getBoundingClientRect();
            return rect.left >= 30 && rect.left <= 520 && rect.top >= 40 && rect.height >= 32 && rect.height <= 200 && rect.width >= 120 &&
              !el.closest('[data-message-id], [role="main"] header, form');
          } catch (_) { return false; }
        });
        for (const r of fallbackRows) {
          candidateElements.push({ marker: r, container: r });
        }
      }

      const stampedThreads = [];
      for (let i = 0; i < candidateElements.length; i++) {
        const { marker, container } = candidateElements[i];
        const res = extractBizThreadFromFiber(marker, pageId) || extractBizThreadFromFiber(container, pageId);
        if (res && res.threadId) {
          marker.setAttribute('data-crm-thread-id', res.threadId);
          if (container && container !== marker) {
            container.setAttribute('data-crm-thread-id', res.threadId);
          }
          if (res.contactName) {
            marker.setAttribute('data-crm-contact-name', res.contactName);
            if (container && container !== marker) {
              container.setAttribute('data-crm-contact-name', res.contactName);
            }
          }
          stampedThreads.push({
            index: i,
            threadId: res.threadId,
            contactName: res.contactName || null
          });
        }
      }

      if (stampedThreads.length > 0) {
        window.postMessage({
          type: 'CRM_EXTRACT_BIZ_SIDEBAR_RESPONSE',
          pageId,
          threads: stampedThreads
        }, '*');
      }
    } catch (_) {}
  }

  let bizStampDebounceTimer = null;
  function setupBizSidebarObserver() {
    try {
      const observer = new MutationObserver(() => {
        if (bizStampDebounceTimer) clearTimeout(bizStampDebounceTimer);
        bizStampDebounceTimer = setTimeout(scanAndStampBizSidebarRows, 300);
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }
  if (document.body) {
    setupBizSidebarObserver();
  } else {
    document.addEventListener('DOMContentLoaded', setupBizSidebarObserver);
  }

  setInterval(scanAndStampMountedVideos, 1000);
  setInterval(scanAndStampBizSidebarRows, 1500);
})();
