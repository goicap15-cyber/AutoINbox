export function collapseMessengerMediaCompanions(messages = []) {
  // Reconcile a local optimistic/temporary image with the persisted Facebook-confirmed
  // image. They can carry different client ids or attachment vs local path.
  const withoutOptimisticDuplicates = [];
  for (const message of messages) {
    const isOutgoingMedia = Boolean(message?.is_outgoing) && Boolean(
      message?.attachment_id || message?.local_media_path || message?.media_url ||
      (message?.media_type && message.media_type !== 'text')
    );
    if (!isOutgoingMedia) {
      withoutOptimisticDuplicates.push(message);
      continue;
    }

    const isDurable = message?.id != null && String(message?.fb_message_id || '').startsWith('mid.');
    const messageTime = Number(message?.timestamp_ms) || Date.parse(message?.created_at || '') || 0;

    const existingIndex = withoutOptimisticDuplicates.findIndex((existing) => {
      if (!existing?.is_outgoing) return false;
      const existingIsMedia = Boolean(
        existing?.attachment_id || existing?.local_media_path || existing?.media_url ||
        (existing?.media_type && existing?.media_type !== 'text')
      );
      if (!existingIsMedia) return false;

      // Match 1: same attachment_id
      if (message.attachment_id && existing.attachment_id && message.attachment_id === existing.attachment_id) {
        return true;
      }

      // Match 2: same client_message_id
      if (message.client_message_id && existing.client_message_id) {
        if (message.client_message_id === existing.client_message_id) return true;
        if (message.client_message_id.replace(/_media$/, '') === existing.client_message_id.replace(/_media$/, '')) return true;
      }

      // Match 3: One is durable (mid.*) and one is temporary (non-mid, pending_*, numeric temp ID), within 120s
      const existingDurable = existing?.id != null && String(existing?.fb_message_id || '').startsWith('mid.');
      if ((isDurable && !existingDurable) || (!isDurable && existingDurable)) {
        const existingTime = Number(existing?.timestamp_ms) || Date.parse(existing?.created_at || '') || 0;
        if (messageTime > 0 && existingTime > 0 && Math.abs(messageTime - existingTime) <= 120000) {
          return true;
        }
      }

      return false;
    });

    if (existingIndex === -1) {
      withoutOptimisticDuplicates.push(message);
    } else {
      const existing = withoutOptimisticDuplicates[existingIndex];
      const existingDurable = existing?.id != null && String(existing?.fb_message_id || '').startsWith('mid.');
      if (!existingDurable || isDurable) {
        withoutOptimisticDuplicates[existingIndex] = {
          ...existing,
          ...message,
          content: (message.content && String(message.content).trim()) ? message.content : (existing.content || ''),
          attachment_id: message.attachment_id || existing.attachment_id,
          client_message_id: message.client_message_id || existing.client_message_id,
          media_url: message.media_url || existing.media_url,
          local_media_path: message.local_media_path || existing.local_media_path
        };
      }
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
      content: (message.content && String(message.content).trim()) ? message.content : (companion.content || ''),
      media_type: companion.media_type || message.media_type,
      media_url: message.attachment_id ? message.media_url : (companion.media_url || message.media_url),
      local_media_path: message.local_media_path || companion.local_media_path
    }];
  });
}
