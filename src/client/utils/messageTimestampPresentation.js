/**
 * messageTimestampPresentation.js
 * Tiện ích hiển thị thời gian và hướng tin nhắn trên giao diện CRM (Client-side helper).
 * TUYỆT ĐỐI không fallback sang created_at khi timestamp_ms <= 0 để tránh hiển thị giờ giả.
 */

function getValidTimestampMs(message) {
  if (!message) return null;
  const ts = Number(message.timestamp_ms);
  if (Number.isFinite(ts) && ts > 0) {
    return ts;
  }
  return null;
}

function getMessageDisplayTime(message) {
  const ts = getValidTimestampMs(message);
  if (!ts) return '';
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getMessageDateKey(message) {
  const ts = getValidTimestampMs(message);
  if (!ts) return null;
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateSeparatorLabel(message) {
  const ts = getValidTimestampMs(message);
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();

  // So sánh ngày hôm nay / hôm qua
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return 'Hôm nay';
  if (isYesterday) return 'Hôm qua';

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function isConfirmedOutgoing(message) {
  if (!message) return false;
  const isOut = message.is_outgoing === true || message.is_outgoing === 1;
  const isConfirmed = message.direction_status === 'confirmed';
  return isOut && isConfirmed;
}

export {
  getValidTimestampMs,
  getMessageDisplayTime,
  getMessageDateKey,
  formatDateSeparatorLabel,
  isConfirmedOutgoing
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getValidTimestampMs,
    getMessageDisplayTime,
    getMessageDateKey,
    formatDateSeparatorLabel,
    isConfirmedOutgoing
  };
}
