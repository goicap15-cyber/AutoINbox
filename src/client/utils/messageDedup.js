// Provisional sidebar rows use the observation time, not the Facebook message
// time. Keep an hour of exact outbound context; a real incoming repeat is kept
// once native history replaces the provisional sidebar id.
// Facebook sidebar timestamps can be stale by many hours. A sidebar row is provisional, so an exact outgoing match wins.
const SIDEBAR_OUTBOUND_ECHO_WINDOW_MS = Number.POSITIVE_INFINITY;
const OUTGOING_MEDIA_ECHO_WINDOW_MS = 2 * 60 * 1000;

function messageTimeMs(message) {
  const timestampMs = Number(message?.timestamp_ms || message?.order_anchor_ms || 0);
  if (Number.isFinite(timestampMs) && timestampMs > 0) return timestampMs;
  const rawCreatedAt = String(message?.created_at || '').trim();
  if (!rawCreatedAt) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawCreatedAt)
    ? rawCreatedAt.replace(' ', 'T') + 'Z'
    : rawCreatedAt;
  return Date.parse(normalized) || 0;
}

// Optimistic attachment rows can inherit an old Facebook timeline timestamp.
// Their database creation time is the reliable correlation clock, while native
// Messenger rows retain their Facebook timestamp for normal history ordering.
function mediaObservationTimeMs(message) {
  const rawCreatedAt = String(message?.created_at || '').trim();
  if (rawCreatedAt) {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawCreatedAt)
      ? rawCreatedAt.replace(' ', 'T') + 'Z'
      : rawCreatedAt;
    const createdAtMs = Date.parse(normalized);
    if (Number.isFinite(createdAtMs) && createdAtMs > 0) return createdAtMs;
  }
  return messageTimeMs(message);
}
export function collapseSidebarOutboundEchoes(messages = []) {
  const outgoingByContent = new Map();
  for (const message of messages) {
    if (!(message?.is_outgoing === true || message?.is_outgoing === 1)) continue;
    const content = String(message?.content || '').trim();
    const timestampMs = messageTimeMs(message);
    if (!content) continue;
    const timestamps = outgoingByContent.get(content) || [];
    timestamps.push(timestampMs);
    outgoingByContent.set(content, timestamps);
  }

  return messages.filter((message) => {
    const isProvisionalIncoming = !(message?.is_outgoing === true || message?.is_outgoing === 1)
      && String(message?.fb_message_id || '').startsWith('sidebar_preview_');
    if (!isProvisionalIncoming) return true;
    const content = String(message?.content || '').trim();
    const timestampMs = messageTimeMs(message);
    if (!content) return true;
    return !(outgoingByContent.get(content) || []).some(
      (outgoingTimestampMs) => Math.abs(timestampMs - outgoingTimestampMs) <= SIDEBAR_OUTBOUND_ECHO_WINDOW_MS
    );
  });
}

export function collapseNearbyOutgoingMediaEchoes(messages = []) {
  const mediaKind = (message) => {
    const kind = String(message?.media_type || '').toLowerCase();
    return kind === 'image' || kind === 'video' ? kind : null;
  };
  const isOutgoing = (message) => message?.is_outgoing === true || message?.is_outgoing === 1;
  const crmCandidates = messages.filter((message) =>
    isOutgoing(message)
    && mediaKind(message)
    && Boolean(message?.client_message_id || message?.attachment_id)
  );
  const nativeMedia = messages.filter((message) =>
    isOutgoing(message)
    && mediaKind(message)
    && !message?.client_message_id
    && !message?.attachment_id
    && String(message?.fb_message_id || '').startsWith('mid.')
    && Boolean(message?.media_url || message?.local_media_path)
  );

  return messages.filter((message) => {
    // Keep Messenger's durable media row: its native sequence/timestamp is the
    // source of truth for chat order. Hide only the one matching CRM bubble.
    if (!crmCandidates.includes(message)) return true;
    const candidateAt = mediaObservationTimeMs(message);
    if (!candidateAt) return true;
    const pairedNative = nativeMedia.find((native) => {
      if (mediaKind(native) !== mediaKind(message) || !mediaObservationTimeMs(native)) return false;
      if (Math.abs(candidateAt - mediaObservationTimeMs(native)) > OUTGOING_MEDIA_ECHO_WINDOW_MS) return false;
      // Never hide an intentional rapid second media send. The native row must
      // have exactly one CRM candidate in its creation-time window.
      const candidateCount = crmCandidates.filter((candidate) =>
        mediaKind(candidate) === mediaKind(native)
        && mediaObservationTimeMs(candidate)
        && Math.abs(mediaObservationTimeMs(candidate) - mediaObservationTimeMs(native)) <= OUTGOING_MEDIA_ECHO_WINDOW_MS
      ).length;
      return candidateCount === 1;
    });
    return !pairedNative;
  });
}
export function collapseMessengerMediaCompanions(messages = []) {
  // Hide only provisional sidebar rows that mirror a nearby outbound. Native
  // customer messages keep their Facebook id and are never filtered here.
  messages = collapseSidebarOutboundEchoes(messages);
  messages = collapseNearbyOutgoingMediaEchoes(messages);
  // Reconcile a local optimistic image with the persisted Facebook-confirmed
  // image. They can carry different client ids, but share the attachment/path.
  const mediaSlots = new Map();
  const withoutOptimisticDuplicates = [];
  for (const message of messages) {
    const isOutgoingMedia = Boolean(message?.is_outgoing) && Boolean(
      message?.attachment_id || message?.local_media_path || message?.media_url ||
      (message?.media_type && message.media_type !== 'text')
    );
    const mediaKey = message?.attachment_id
      ? `attachment:${message.attachment_id}`
      : message?.local_media_path
        ? `local:${message.local_media_path}`
        : null;
    if (!isOutgoingMedia || !mediaKey) {
      withoutOptimisticDuplicates.push(message);
      continue;
    }
    const existingIndex = mediaSlots.get(mediaKey);
    if (existingIndex == null) {
      mediaSlots.set(mediaKey, withoutOptimisticDuplicates.length);
      withoutOptimisticDuplicates.push(message);
      continue;
    }
    const existing = withoutOptimisticDuplicates[existingIndex];
    const existingDurable = existing?.id != null || String(existing?.fb_message_id || '').startsWith('mid.');
    const incomingDurable = message?.id != null || String(message?.fb_message_id || '').startsWith('mid.');
    if (!existingDurable || incomingDurable) {
      withoutOptimisticDuplicates[existingIndex] = {
        ...existing,
        ...message,
        client_message_id: existing.client_message_id || message.client_message_id,
        ui_render_key: existing.ui_render_key || message.ui_render_key,
        ui_position_locked: existing.ui_position_locked || message.ui_position_locked,
        order_anchor_ms: existing.order_anchor_ms || message.order_anchor_ms,
        sequence_order: existing.sequence_order ?? message.sequence_order
      };
    }
  }
  messages = withoutOptimisticDuplicates;

  const byFacebookId = new Map(
    messages
      .filter((message) => message?.fb_message_id)
      .map((message) => [String(message.fb_message_id), message])
  );

  // Filter out orphan placeholders with empty content, no media URL/path, and no call
  messages = messages.filter((msg) => {
    const hasText = Boolean(String(msg?.content ?? msg?.text_content ?? msg?.text ?? msg?.message ?? '').trim());
    const hasMediaUrl = Boolean(msg?.media_url || msg?.local_media_path || msg?.attachment?.preview_url || msg?.attachment?.media_url || msg?.attachment?.local_media_path);
    const isCall = Boolean(msg?.media_type === 'call');
    return hasText || hasMediaUrl || isCall;
  });

  return messages.flatMap((message) => {
    const facebookId = String(message?.fb_message_id || '');
    if (facebookId.endsWith('_media')) {
      const parentId = facebookId.slice(0, -'_media'.length);
      return byFacebookId.has(parentId) ? [] : [message];
    }
    // Messenger may emit a second `__bubble_1` text node for a media caption.
    // The parent media row is the canonical bubble, so never render the echo.
    const bubbleParentId = facebookId.replace(/__bubble_\d+$/, '');
    if (bubbleParentId !== facebookId) {
      const parent = byFacebookId.get(bubbleParentId);
      const parentHasMedia = Boolean(parent && (
        parent.media_url || parent.local_media_path || parent.attachment_id ||
        (parent.media_type && parent.media_type !== 'text')
      ));
      if (parentHasMedia) return [];
    }

    const companion = byFacebookId.get(`${facebookId}_media`);
    if (!facebookId || !companion) return [message];
    const isOutgoing = (companion.is_outgoing === 1 || companion.is_outgoing === true || message.is_outgoing === 1 || message.is_outgoing === true) ? 1 : 0;
    return [{
      ...message,
      is_outgoing: isOutgoing,
      sender_id: isOutgoing ? (companion.sender_id || message.sender_id || 'current_user') : message.sender_id,
      sender_role: isOutgoing ? 'operator' : message.sender_role,
      sender_name: isOutgoing ? (companion.sender_name || 'Bạn') : message.sender_name,
      ui_render_key: message.ui_render_key || companion.ui_render_key,
      ui_position_locked: message.ui_position_locked || companion.ui_position_locked,
      order_anchor_ms: message.order_anchor_ms || companion.order_anchor_ms,
      sequence_order: message.sequence_order ?? companion.sequence_order,
      media_type: companion.media_type || message.media_type,
      media_url: message.attachment_id ? message.media_url : (companion.media_url || message.media_url),
      local_media_path: message.local_media_path || companion.local_media_path
    }];
  });
}
