function isChangedIncomingSidebarPreview({
  previousThread,
  incomingThread,
  cleanLastMessage,
  isActivitySummary,
  hasRecentMatchingOutbound = false,
  rowFreshNew = false
}) {
  if (!previousThread || !cleanLastMessage || /^(?:Chưa có tin nhắn|ChÃ†Â°a cÃƒÂ° tin nhÃ¡ÂºÂ¯n|No messages?)$/i.test(String(cleanLastMessage).trim())) return false;
  if (isActivitySummary) return false;
  // Preview lặp lại đúng chuỗi cũ vẫn phải được bắt khi row VỪA chuyển sang
  // "Bây giờ" VÀ đang dính chấm chưa đọc/Like - khách nhắn lại đúng câu cũ
  // ("ok", "dạ") không được bị coi là "không đổi". Phải dùng rowFreshNew
  // (nhịp chuyển đổi) chứ KHÔNG dùng raw fresh: raw fresh đúng ở MỌI nhịp
  // quét trong ~60s -> ngập job sync (reproduce 2026-10-02: 177
  // sidebar_incoming/9 phút, app lag). Tự echo của CRM (không unread)
  // vẫn bị chặn như cũ tại đây.
  const samePreview = String(previousThread.last_message || '').trim() === String(cleanLastMessage).trim();
  if (samePreview
    && !(rowFreshNew === true
      && (Number(incomingThread?.is_unread) === 1 || incomingThread?.is_like === true))) return false;

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

// Dòng thời gian trên row sidebar ("Bây giờ"/"Just now"/"vài giây trước")
// là bằng chứng một tin VỪA đến - dùng để phát hiện media thuần trên thread
// ĐÃ unread sẵn (không còn flip unread để bắt, reproduce 2026-10-01: gửi ảnh
// vào thread chưa đọc thì không ai nhận ra).
function isFreshRowTimeText(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 24) return false;
  return /(?:bây giờ|just now|vừa xong|vài giây|giây trước|seconds? ago|^\d{1,2}\s*giây)/i.test(s);
}

module.exports = { isChangedIncomingSidebarPreview, isFreshRowTimeText };