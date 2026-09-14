export function collapseMessengerMediaCompanions(messages = []) {
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

  return messages.flatMap((message) => {
    const facebookId = String(message?.fb_message_id || '');
    if (facebookId.endsWith('_media')) {
      const parentId = facebookId.slice(0, -'_media'.length);
      return byFacebookId.has(parentId) ? [] : [message];
    }

    const companion = byFacebookId.get(`${facebookId}_media`);
    if (!facebookId || !companion) return [message];
    return [{
      ...message,
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
