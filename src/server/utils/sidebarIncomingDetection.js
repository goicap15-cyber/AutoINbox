function isChangedIncomingSidebarPreview({ previousThread, incomingThread, cleanLastMessage, isActivitySummary }) {
  if (!previousThread || !cleanLastMessage || cleanLastMessage === 'Chưa có tin nhắn') return false;
  if (isActivitySummary) return false;
  if (String(previousThread.last_message || '').trim() === String(cleanLastMessage).trim()) return false;

  const hasIncomingSignal = Number(incomingThread?.is_unread) === 1
    || incomingThread?.is_like === true
    // Hidden Messenger can mark a newly received conversation as read before
    // the CRM poll sees it. An explicit non-outgoing sidebar preview is still
    // safe evidence; undefined is deliberately not accepted.
    || incomingThread?.preview_is_outgoing === false;

  return hasIncomingSignal;
}

module.exports = { isChangedIncomingSidebarPreview };