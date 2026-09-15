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
    if (!data || !data.thread_id || !data.content) return;
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
        content: String(data.content).trim(),
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
      try {
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(data);
        extractMessagesFromRawText(text);
      } catch (e) {}
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Chrome delivers Facebook/Messenger realtime frames as Blob by
      // default. The old interceptor handled only string/ArrayBuffer, so
      // genuine customer messages on an already-open socket were silently
      // ignored until another action caused a HTTP/DOM refresh.
      data.arrayBuffer().then((buffer) => {
        try {
          const text = new TextDecoder('utf-8').decode(buffer);
          parseWebSocketData(text);
        } catch (_) {}
      }).catch(() => {});
    }
  }

  // Recursive extractor for JSON payloads
  function extractMessagesFromJSON(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;

    // Direct message node matching Facebook GraphQL schema
    if (obj.message_id || obj.offline_threading_id || obj.messageId) {
      const threadId = obj.thread_id || obj.thread_fbid || obj.other_user_id || obj.threadKey?.thread_fbid || obj.thread_key?.thread_fbid;
      const content = obj.text || obj.body || obj.message?.text;
      const senderId = obj.sender_id || obj.sender_fbid || obj.author || obj.message_sender?.id;
      const msgId = obj.message_id || obj.offline_threading_id || obj.messageId;

      if (threadId && content) {
        emitNetworkMessage({
          thread_id: threadId,
          fb_message_id: msgId,
          sender_id: senderId,
          content: content,
          is_outgoing: obj.is_outgoing || false,
          timestamp_ms: obj.timestamp_precise || obj.timestamp || null,
          created_at: obj.timestamp ? new Date(Number(obj.timestamp)).toISOString() : new Date().toISOString()
        });
      }

      // Quét bóc tách link CDN video từ GraphQL payload và lưu vào cache
      if (msgId) {
        let foundVid = null;
        let foundPoster = null;
        const scanVidObj = (o, d = 0) => {
          if (!o || typeof o !== 'object' || d > 4) return;
          const vKeys = ['playable_url', 'playable_url_quality_hd', 'browser_native_hd_url', 'browser_native_sd_url', 'video_direct_url', 'videoDirectUrl', 'playableUrl'];
          for (const vk of vKeys) {
            const val = o[vk];
            if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
              if (!foundVid) foundVid = val;
            }
          }
          const pKeys = ['preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl', 'poster_url', 'posterUrl', 'large_preview', 'preview_image', 'thumbnail', 'image'];
          for (const pk of pKeys) {
            const pv = o[pk];
            if (typeof pv === 'string' && /^https?:\/\//i.test(pv) && !pv.includes('/emoji.php') && !pv.includes('/rsrc.php')) {
              if (!foundPoster) foundPoster = pv;
            } else if (pv && typeof pv === 'object' && typeof pv.uri === 'string' && /^https?:\/\//i.test(pv.uri)) {
              if (!foundPoster && !pv.uri.includes('/emoji.php') && !pv.uri.includes('/rsrc.php')) foundPoster = pv.uri;
            }
          }
          const cKeys = ['attachment', 'attachments', 'blob_attachments', 'video_attachments', 'extensible_attachment', 'story', 'media', 'video', 'video_delivery'];
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
        if (foundVid) {
          pageVideoCache.set(msgId, { videoUrl: foundVid, posterUrl: foundPoster });
          window.postMessage({
            type: 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE',
            fb_message_id: msgId,
            videoUrl: foundVid,
            posterUrl: foundPoster
          }, '*');
        }
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
        if (!obj || typeof obj !== 'object' || currentDepth > 5) return;

        const videoKeys = [
          'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url',
          'browser_native_sd_url', 'video_direct_url', 'videoDirectUrl', 'playableUrl'
        ];
        for (const vk of videoKeys) {
          const val = obj[vk];
          if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
            if (!foundVideo) foundVideo = val;
          }
        }

        const posterKeys = [
          'preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl',
          'poster_url', 'posterUrl', 'large_preview', 'preview_image',
          'thumbnail', 'image'
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
          'extensible_attachment', 'story', 'media', 'video', 'video_delivery'
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

      while (curr && depth < 40) {
        depth++;
        const props = curr.memoizedProps || curr.props || (depth === 1 ? curr : null);
        if (props) {
          scanObject(props);
          if (foundVideo) break;
        }
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
    let res = extractVideoCdnFromReactNode(videoEl);
    if (!res.videoUrl && videoEl !== msgNode) {
      const msgRes = extractVideoCdnFromReactNode(msgNode);
      if (msgRes.videoUrl) res.videoUrl = msgRes.videoUrl;
      if (msgRes.posterUrl && !res.posterUrl) res.posterUrl = msgRes.posterUrl;
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
    }
  }

  function scanAndStampMountedVideos() {
    try {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (v.getAttribute('data-crm-video-url')) continue;
        const msgNode = v.closest('[data-message-id]') || v.closest('[data-id]') || v;
        const mid = msgNode?.getAttribute?.('data-message-id') || msgNode?.getAttribute?.('data-id');
        let res = null;
        if (mid && pageVideoCache.has(mid)) {
          res = pageVideoCache.get(mid);
        } else {
          res = resolveVideoForMessageNode(msgNode);
          if (res.videoUrl && mid) {
            pageVideoCache.set(mid, res);
          }
        }
        if (res?.videoUrl) {
          applyResolvedVideoToDom(msgNode, res.videoUrl, res.posterUrl);
          if (mid) {
            window.postMessage({
              type: 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE',
              fb_message_id: mid,
              videoUrl: res.videoUrl,
              posterUrl: res.posterUrl || null
            }, '*');
          }
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
          if (res.videoUrl) {
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
  });

  setInterval(scanAndStampMountedVideos, 1500);
})();
