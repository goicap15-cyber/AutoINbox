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

  // ── Debug kênh MQTT: relay qua content.js -> background -> server sink
  //    (composer-debug.log). Tạm thời, gỡ sau khi bắt được tin MQTT.
  let mqttDebugCount = 0;
  let mqttDebugWindowStart = Date.now();
  function mqttDebug(info, force) {
    try {
      if (Date.now() - mqttDebugWindowStart > 60000) { mqttDebugCount = 0; mqttDebugWindowStart = Date.now(); }
      // WS_DATA spam (hàng trăm ping/phút) từng ăn hết budget 80/m khiến các
      // stage quan trọng bị nuốt; stage force luôn được ghi.
      if (!force && mqttDebugCount++ > 80) return;
      window.postMessage({ type: 'CRM_MQTT_DEBUG', data: info }, '*');
    } catch (_) {}
  }

  // ── GraphQL template capture + replay (2026-09-30) ──
  // Bám delta tin nhắn qua WebSocket/MQTT thất bại: Facebook đẩy tin nhắn
  // xuống transport không nhìn thấy được từ trang (worker/gateway riêng).
  // Đường đáng tin hơn: ghi lại đúng body query GraphQL messenger.com dùng
  // khi MỞ thread (response chứa tin nhắn kèm URL media), rồi PHÁT LẠI query
  // đó cho thread khách vừa nhắn - sidebar đổi preview là fetch ngay, tin +
  // ảnh/video về trong ~1s mà không cần điều hướng tab.
  let latestDtsg = '';
  try { latestDtsg = document.querySelector('input[name="fb_dtsg"]')?.value || ''; } catch (_) {}
  let extractionHits = 0;
  const lastExtractionThreads = new Set();
  let crmCapturedQuery = null;
  let crmReplayBusy = false;
  const crmReplayQueue = [];

  function deepReplaceStrings(value, replacements) {
    if (typeof value === 'string') {
      return Object.prototype.hasOwnProperty.call(replacements, value) ? replacements[value] : value;
    }
    if (Array.isArray(value)) return value.map((item) => deepReplaceStrings(item, replacements));
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = deepReplaceStrings(value[key], replacements);
      return out;
    }
    return value;
  }

  function collectStringValues(value, out = new Set()) {
    if (typeof value === 'string') out.add(value);
    else if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStringValues(item, out));
    return out;
  }

  // Id thread trong variables GraphQL thường mang prefix ('threadKey:123') trong
  // khi delta MQTT/response trả id trần ('123'). Chuẩn hóa 2 bên để khớp slot.
  function normalizeSlotKey(s) {
    const str = String(s || '');
    const m = str.match(/^(?:threadKey|thread_key)[:](.+)$/i);
    if (m) return m[1];
    if (/^[0-9]{6,}$/.test(str)) return str;
    return '';
  }

  function slotReplacementValue(slot, targetId) {
    const m = String(slot).match(/^([^\d][^:]*)[:][^:]+$/);
    if (m && m[1] && m[1].length <= 40) return m[1] + ':' + targetId;
    return targetId;
  }

  function captureGraphqlTemplate(reqBody) {
    try {
      if (!reqBody || typeof reqBody !== 'string' || reqBody.length > 120000) return;
      if (extractionHits <= 0 || lastExtractionThreads.size === 0) return;
      // Chỉ ghi template trên trang Messenger: response list query Business
      // Suite cũng chứa node tin, nhưng replay list query không lấy được tin
      // của một thread đích.
      if (!/\/messages(\/|$|\?)/i.test(location.pathname)) {
        mqttDebug({ stage: 'CAPTURE_SKIP_PAGE', path: String(location.pathname).substring(0, 40), hits: extractionHits });
        return;
      }
      const params = new URLSearchParams(reqBody);
      const varsRaw = params.get('variables');
      const queriesRaw = params.get('queries');
      let docId = params.get('doc_id') || '';
      let variables = null;
      if (queriesRaw) {
        const batch = JSON.parse(queriesRaw);
        const first = Object.values(batch)[0];
        if (!first?.doc_id) return;
        docId = String(first.doc_id);
        const qv = first.query_params?.variables;
        variables = typeof qv === 'string' ? JSON.parse(qv) : (qv || null);
      } else if (docId && varsRaw) {
        variables = JSON.parse(varsRaw);
      } else {
        return;
      }
      if (!variables || typeof variables !== 'object' || !docId) return;
      const varStrings = collectStringValues(variables);
      const seenThreadKeys = new Set([...lastExtractionThreads].map(normalizeSlotKey).filter(Boolean));
      const slots = [];
      for (const vs of varStrings) {
        if (!vs || vs.length > 200) continue;
        const norm = normalizeSlotKey(vs);
        if ((norm && seenThreadKeys.has(norm)) || lastExtractionThreads.has(vs)) {
          if (!slots.includes(vs)) slots.push(vs);
        }
      }
      if (!slots.length) {
        mqttDebug({ stage: 'CAPTURE_MISS_SLOTS', doc_id: docId, threads: [...lastExtractionThreads].slice(0, 3).map((t) => String(t).substring(0, 24)), varSample: [...varStrings].filter((v) => v && v.length > 6 && v.length < 64).slice(0, 8) }, true);
        return;
      }
      crmCapturedQuery = { doc_id: docId, variables, slots, captured_at: Date.now(), page: String(location.host) };
      window.postMessage({ type: 'CRM_QUERY_TEMPLATE', data: crmCapturedQuery }, '*');
      mqttDebug({ stage: 'QUERY_TEMPLATE_CAPTURED', doc_id: docId, slots, hits: extractionHits }, true);
    } catch (_) {}
  }

  async function runCrmFetchThread(task) {
    if (!crmCapturedQuery) {
      window.postMessage({ type: 'CRM_FETCH_RESULT', data: { thread_id: task.thread_id, found: 0, reason: 'no_template' } }, '*');
      return;
    }
    crmReplayBusy = true;
    try {
      const replacements = {};
      for (const slot of crmCapturedQuery.slots) replacements[slot] = slotReplacementValue(slot, task.thread_id);
      const replayVars = deepReplaceStrings(crmCapturedQuery.variables, replacements);
      // Con trỏ phân trang cũ sẽ kéo về trang tin CŨ thay vì tin mới nhất.
      for (const key of Object.keys(replayVars)) {
        if (/cursor|before|after|until/i.test(key)) replayVars[key] = null;
      }
      const params = new URLSearchParams();
      params.set('doc_id', crmCapturedQuery.doc_id);
      params.set('variables', JSON.stringify(replayVars));
      params.set('server_timestamps', 'true');
      if (latestDtsg) params.set('fb_dtsg', latestDtsg);
      const av = getCurrentUserId();
      if (av) params.set('av', av);
      extractionHits = 0;
      lastExtractionThreads.clear();
      const response = await originalFetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const text = await response.text();
      parseNetworkResponseBody(text, 'replay');
      mqttDebug({ stage: 'REPLAY_DONE', thread_id: String(task.thread_id).substring(0, 20), http: response.status, found: extractionHits }, true);
      window.postMessage({ type: 'CRM_FETCH_RESULT', data: { thread_id: task.thread_id, found: extractionHits, http: response.status } }, '*');
    } catch (error) {
      mqttDebug({ stage: 'REPLAY_ERROR', thread_id: String(task.thread_id).substring(0, 20), error: String(error && error.message || error).substring(0, 80) }, true);
      window.postMessage({ type: 'CRM_FETCH_RESULT', data: { thread_id: task.thread_id, found: 0, reason: 'error' } }, '*');
    } finally {
      crmReplayBusy = false;
      if (crmReplayQueue.length) {
        const next = crmReplayQueue.shift();
        setTimeout(() => runCrmFetchThread(next), 150);
      }
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.type === 'CRM_QUERY_TEMPLATE_RESTORE' && data.data && !crmCapturedQuery) {
      const t = data.data;
      if (t && t.doc_id && t.variables && Array.isArray(t.slots) && t.slots.length) {
        crmCapturedQuery = { doc_id: String(t.doc_id), variables: t.variables, slots: t.slots, captured_at: Number(t.captured_at) || Date.now(), page: String(t.page || location.host) };
        mqttDebug({ stage: 'TEMPLATE_RESTORED', doc_id: crmCapturedQuery.doc_id, slots: crmCapturedQuery.slots }, true);
      }
      return;
    }
    if (data && data.type === 'CRM_FETCH_THREAD' && data.data) {
      const task = { thread_id: String(data.data.thread_id || '') };
      if (!task.thread_id) return;
      if (crmReplayBusy) {
        if (crmReplayQueue.length < 8) crmReplayQueue.push(task);
        return;
      }
      runCrmFetchThread(task);
    }
    if (data && data.type === 'CRM_FETCH_BLOB' && data.url) {
      // Video Messenger E2EE chỉ có src blob: - URL này chết ngoài trang nên
      // DOM scan không relay được. Đọc blob trong MAIN world, đổi thành
      // data-URL base64 (như ảnh) để row video render được trong CRM.
      (async () => {
        let dataUrl = null;
        try {
          const res = await fetch(String(data.url));
          const blob = await res.blob();
          if (blob && blob.size > 0 && blob.size <= 8 * 1024 * 1024) {
            dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
        } catch (_) {}
        try {
          window.postMessage({ type: 'CRM_BLOB_DATA', rid: data.rid, url: String(data.url), dataUrl }, '*');
        } catch (_) {}
      })();
    }
  });

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
            try { latestDtsg = decodeURIComponent(m[1]); } catch (_) { latestDtsg = m[1]; }
            window.postMessage({ type: 'FB_TOKEN_DISCOVERED', fb_dtsg: decodeURIComponent(m[1]) }, '*');
          }
        }
      }
    } catch (_) {}
    const response = await originalFetch.apply(this, args);
    try {
      const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
      if (url && (url.includes('/api/graphql/') || url.includes('/ajax/messenger/'))) {
        const reqBody = args[1]?.body;
        mqttDebug({ stage: 'GQL_REQ', via: 'fetch', bodyLen: typeof reqBody === 'string' ? reqBody.length : 0, doc: typeof reqBody === 'string' && reqBody.includes('doc_id'), queries: typeof reqBody === 'string' && reqBody.includes('queries=') });
        const clone = response.clone();
        clone.text().then(text => {
          parseNetworkResponseBody(text, url);
          captureGraphqlTemplate(typeof reqBody === 'string' ? reqBody : '');
        }).catch(() => {});
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
    const reqBody = typeof args[0] === 'string' ? args[0] : '';
    this.addEventListener('load', function() {
      try {
        if (this._url && (this._url.includes('/api/graphql/') || this._url.includes('/ajax/messenger/'))) {
          mqttDebug({ stage: 'GQL_REQ', via: 'xhr', rt: this.responseType || '(text)', bodyLen: reqBody.length, doc: reqBody.includes('doc_id'), queries: reqBody.includes('queries=') });
          // GraphQL của FB đi qua XHR với responseType KHÔNG phải 'text':
          // đọc this.responseText khi responseType='json'/'blob'/... văng
          // InvalidStateError và try/catch nuốt im lặng - vì vậy mọi response
          // GraphQL của messenger.com CHƯA TỪNG được parse. Xử lý đủ các loại.
          const finishParse = (respText) => {
            parseNetworkResponseBody(respText, this._url);
            captureGraphqlTemplate(reqBody);
          };
          let respText = '';
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              respText = this.responseText;
            } else if (this.responseType === 'json') {
              respText = this.response == null ? '' : JSON.stringify(this.response);
            } else if (this.responseType === 'arraybuffer') {
              respText = new TextDecoder('utf-8').decode(new Uint8Array(this.response));
            } else if (this.responseType === 'blob') {
              Promise.resolve(this.response).then((blob) => blob.text()).then(finishParse).catch(() => {});
              return;
            }
          } catch (respErr) {
            mqttDebug({ stage: 'GQL_RESP_ERR', rt: this.responseType, err: String(respErr && respErr.message || respErr).substring(0, 60) }, true);
            return;
          }
          finishParse(respText);
        }
      } catch (e) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // 3. Intercept WebSocket Frames (Facebook MQTT/Messenger WS)
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    mqttDebug({ stage: 'WS_NEW', url: String(url || '').substring(0, 90) });
    const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    try {
      ws.addEventListener('message', (event) => {
        try {
          const frameSize = event.data?.size ?? event.data?.byteLength ?? event.data?.length ?? 0;
          if (frameSize > 100) {
            mqttDebug({ stage: 'WS_DATA', size: frameSize });
          }
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

  // Tách các JSON object top-level nằm NỐI TIẾP nhau trong cùng body. GraphQL
  // của FB stream response dạng @defer/@stream: nhiều document '{"data":...}'
  // ghép thẳng (không xuống dòng) -> JSON.parse nguyên khối và line-split đều
  // fail, mọi node tin trong payload lớn (bootstrap_keywords 1.18MB,
  // thread messages) bị PARSE_MISS - đây là lý do capture template và URL
  // media không bao giờ có.
  function splitTopLevelJsonObjects(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' || ch === ']') {
        if (depth > 0) {
          depth--;
          if (depth === 0 && start >= 0) {
            out.push(text.slice(start, i + 1));
            start = -1;
          }
        }
      }
    }
    return out;
  }

  // Parser function for HTTP GraphQL/Ajax response body
  function parseNetworkResponseBody(bodyText, url) {
    if (!bodyText || typeof bodyText !== 'string') return;
    extractionHits = 0;
    lastExtractionThreads.clear();

    // Response /api/graphql/ mở đầu 'for (;;);' - JSON.parse từng dòng ném lỗi
    // cho toàn bộ body và im lặng bỏ qua MỌI tin nhắn GraphQL (reproduce
    // 2026-09-30: 643 response GQL_REQ parsed, 0 node). Cắt prefix trước.
    let text = bodyText.trim();
    const prefixMatch = text.match(/^(?:for\s*\(;;\);|while\s*\(1\);|while\s*\(true\);)+/i);
    if (prefixMatch) text = text.slice(prefixMatch[0].length);

    const chunks = [];
    let splitCount = 0;
    let firstFail = null;
    let pieceFail = null;
    const tryParse = (t, label) => {
      try { chunks.push(JSON.parse(t)); return true; } catch (err) {
        if (!firstFail && t.length > 100) {
          firstFail = { label, err: String(err && err.message || err).substring(0, 90), head: t.substring(0, 180) };
        }
        return false;
      }
    };
    if (!tryParse(text, 'whole')) {
      // Fallback: payload stream của FB trộn hai dạng - dòng JSON lẻ VÀ nhiều
      // document nối tiếp trong cùng dòng (@defer/@stream). Mỗi dòng fail phải
      // đi qua splitter, không được gate "đã có chunk" vì dòng nối tiếp chứa
      // đúng data thread/messages cần tách.
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (tryParse(t, 'line')) continue;
        for (const piece of splitTopLevelJsonObjects(t)) {
          let p = piece.trim();
          const pm = p.match(/^(?:for\s*\(;;\);|while\s*\(1\);|while\s*\(true\);)+/i);
          if (pm) p = p.slice(pm[0].length);
          try {
            chunks.push(JSON.parse(p));
            splitCount++;
          } catch (err) {
            if (!pieceFail && p.length > 100) {
              pieceFail = { err: String(err && err.message || err).substring(0, 90), len: p.length, head: p.substring(0, 180) };
            }
          }
        }
      }
    }
    for (const json of chunks) extractMessagesFromJSON(json);
    if (splitCount > 0) {
      mqttDebug({ stage: 'PARSE_SPLIT', chunks: chunks.length, split: splitCount, len: text.length });
    }
    if (pieceFail) {
      // Piece fail là chẩn đoán thật: mảnh đã tách vẫn không parse được.
      mqttDebug({ stage: 'PARSE_FAIL', err: pieceFail.err, piece_len: pieceFail.len, head: pieceFail.head }, true);
    } else if (chunks.length === 0 && firstFail && text.length > 1000) {
      mqttDebug({ stage: 'PARSE_FAIL', err: firstFail.err, via: firstFail.label, head: firstFail.head, len: text.length }, true);
    }
    if (extractionHits === 0 && text.length > 2000) {
      mqttDebug({ stage: 'PARSE_MISS', url: String(url || '').substring(0, 60), len: text.length, head: text.substring(0, 90) });
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
            mqttDebug({ stage: 'MQTT_FRAME_JSON', topKeys: Object.keys(json).slice(0, 10), deltas: Array.isArray(json.deltas) ? json.deltas.length : (Array.isArray(json) ? json.length : null), sample: JSON.stringify(json).substring(0, 400) });
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
    const msgId = obj.message_id || obj.offline_threading_id || obj.messageId
      || obj.metadata?.messageId || obj.messageMetadata?.messageId
      || (typeof obj.id === 'string' && obj.id.startsWith('mid.') ? obj.id : null);

    const msgMetaProbe = obj.messageMetadata || null;
    if (msgId || msgMetaProbe || obj.deltaNewMessage || obj.class === 'NewMessage') {
      mqttDebug({
        stage: 'MSG_NODE',
        msgId: String(msgId || msgMetaProbe?.id || '').substring(0, 40),
        hasMeta: Boolean(msgMetaProbe),
        metaKeys: msgMetaProbe ? Object.keys(msgMetaProbe).slice(0, 12) : null,
        metaThreadKey: msgMetaProbe?.threadKey ? JSON.stringify(msgMetaProbe.threadKey) : null,
        keys: Object.keys(obj).slice(0, 18),
        body: String(obj.body || obj.text || '').substring(0, 30),
        depth
      });
    }

    if (msgId) {
      // MQTT delta thật dùng messageMetadata (camelCase) chứa cả threadKey
      // lẫn actorFbId - field names dưới phải khớp shape này thì tin ĐẾN
      // trên socket mới được relay, không chỉ tin quét được từ DOM/history.
      const msgMeta = obj.messageMetadata || null;
      const threadId = obj.thread_id || obj.thread_fbid || obj.other_user_id || obj.threadFbId
        || obj.threadKey?.thread_fbid || obj.threadKey?.threadFbId || obj.threadKey?.otherUserFbId
        || obj.thread_key?.thread_fbid || obj.thread_key?.other_user_id || obj.metadata?.threadKey?.threadFbId
        || msgMeta?.threadKey?.threadFbId || msgMeta?.threadKey?.otherUserFbId
        || msgMeta?.thread_fbid || msgMeta?.threadFbId;
      const content = obj.text || obj.body || obj.message?.text || obj.snippet || '';
      const senderId = obj.sender_id || obj.sender_fbid || obj.author || obj.senderFbId
        || obj.actorFbId || obj.message_sender?.id || obj.sender?.id || obj.metadata?.actorFbId
        || msgMeta?.actorFbId || msgMeta?.senderFbId || msgMeta?.sender;

      // Quét bóc tách link CDN video/poster/ảnh từ GraphQL payload. Tin ĐẾN
      // cắm attachment dưới vô số tên key (imageMetadata, blob_attachments,
      // attaches...) và đôi khi CHƯA có URL (chỉ có id) - quét toàn bộ cây,
      // nhận URL theo hình dạng CDN + đánh dấu loại attachment để CRM vẫn
      // giữ chỗ tin ngay, history đổ URL vào sau qua cùng mid.
      let foundVid = null;
      let foundPoster = null;
      let sawVideoAttachment = false;
      let sawImageAttachment = false;
      const looksLikeVideoUrl = (u) => /\/o1\/v\/|video|\.mp4(\?|$)/i.test(u);
      const looksLikeImageUrl = (u) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) || /\/v\/t1\.|scontent/i.test(u);
      const scanVidObj = (o, d = 0) => {
        if (!o || typeof o !== 'object' || d > 6) return;
        for (const k of Object.keys(o)) {
          const kl = String(k).toLowerCase();
          const val = o[k];
          const hasPayload = Array.isArray(val) ? val.length > 0 : (val && typeof val === 'object');
          if (/video|movie/.test(kl) && hasPayload) sawVideoAttachment = true;
          else if (/image|photo|sticker|blob_attach|attach/.test(kl) && hasPayload) sawImageAttachment = true;
          if (val && typeof val === 'object') {
            const tn = String(val.__typename || '');
            if (/video/i.test(tn)) sawVideoAttachment = true;
            if (/image|photo|sticker/i.test(tn)) sawImageAttachment = true;
            scanVidObj(val, d + 1);
          } else if (typeof val === 'string') {
            // mimeType 'image/jpeg'/'video/mp4' tiết lộ loại attachment dù chưa
            // có URL CDN nào trong frame.
            if (/^image\//i.test(val)) sawImageAttachment = true;
            else if (/^video\//i.test(val)) sawVideoAttachment = true;
            if (/^https?:\/\//i.test(val) && !val.includes('/rsrc.php') && !val.includes('/emoji.php')) {
              // URL avatar người gửi phải bị loại để không thành ảnh tin nhắn.
              if (looksLikeVideoUrl(val)) {
                if (!foundVid) foundVid = val;
              } else if (looksLikeImageUrl(val) && !/profile|avatar/.test(kl) && !foundPoster) {
                foundPoster = val;
              }
            } else if (val.length > 1 && val.length < 100000 && (val[0] === '{' || val[0] === '[')) {
              try { scanVidObj(JSON.parse(val), d + 1); } catch (_) {}
            }
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

      const relayMediaType = foundVid ? 'video'
        : (foundPoster ? 'image'
          : (sawVideoAttachment ? 'video' : (sawImageAttachment ? 'image' : 'text')));
      if (threadId && (content || foundVid || foundPoster || relayMediaType !== 'text')) {
        extractionHits += 1;
        lastExtractionThreads.add(String(threadId));
        mqttDebug({ stage: 'EMIT', threadId: String(threadId), msgId: String(msgId).substring(0, 40), media_type: relayMediaType, hasUrl: Boolean(foundVid || foundPoster), sender: senderId ? String(senderId).substring(0, 20) : null, content: String(content).substring(0, 30) }, true);
        emitNetworkMessage({
          thread_id: threadId,
          fb_message_id: msgId,
          sender_id: senderId,
          content: content,
          media_type: relayMediaType,
          media_url: foundVid || foundPoster || null,
          poster_url: foundPoster || null,
          is_outgoing: obj.is_outgoing || false,
          timestamp_ms: obj.timestamp_precise || obj.timestamp || msgMeta?.timestamp
            || (msgMeta?.timestamp ? Number(msgMeta.timestamp) : null),
          created_at: obj.timestamp ? new Date(Number(obj.timestamp)).toISOString() : new Date().toISOString()
        });
      } else if (msgId) {
        mqttDebug({ stage: 'EMIT_BLOCKED', reason: threadId ? 'no-content-no-media' : 'no-thread-id', msgId: String(msgId).substring(0, 40), keys: Object.keys(obj).slice(0, 18) }, true);
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
