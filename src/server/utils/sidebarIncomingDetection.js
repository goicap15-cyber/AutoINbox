function isChangedIncomingSidebarPreview({
  previousThread,
  incomingThread,
  cleanLastMessage,
  isActivitySummary,
  hasRecentMatchingOutbound = false
}) {
  if (!previousThread || !cleanLastMessage || /^(?:Chưa có tin nhắn|ChÃ†°a cÃƒ° tin nháº¯n|No messages?)$/i.test(String(cleanLastMessage).trim())) return false;
  if (isActivitySummary) return false;
  if (String(previousThread.last_message || '').trim() === String(cleanLastMessage).trim()) return false;

  // An explicit self-preview must win over a stale unread marker.
  if (incomingThread?.preview_is_outgoing === true) return false;

  // Messenger can omit the self-prefix for one lazy-render tick. An exact
  // recent CRM outbound match is then an echo unless unread/Like provides
  // stronger evidence that the customer really sent a new message.
  const hasStrongIncomingSignal = Number(incomingThread?.is_unread) === 1
    || incomingThread?.is_like === true;
  if (hasRecentMatchingOutbound && !hasStrongIncomingSignal) return false;

  const hasIncomingSignal = hasStrongIncomingSignal
    // Hidden Messenger can mark a newly received conversation as read before
    // the CRM poll sees it. An explicit non-outgoing sidebar preview is still
    // safe evidence; undefined is deliberately not accepted.
    || incomingThread?.preview_is_outgoing === false;

  return hasIncomingSignal;
}

module.exports = { isChangedIncomingSidebarPreview };