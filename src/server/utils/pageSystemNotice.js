const AUTOMATIC_LEAD_ACTIVITY = 'Đã tự động tạo hoạt động về khách hàng tiềm năng cho bạn dựa trên cuộc trò chuyện này';
// 2026-09-29: thông báo handover của AI agent trong Business Suite từng bị
// orphan harvester nhặt thành tin nhắn (reproduce: Dũng Trần #7264).
const AI_AGENT_HANDOVER = 'Tác nhân AI đã chuyển đoạn chat này cho bạn';

const KNOWN_PAGE_SYSTEM_NOTICES = [AUTOMATIC_LEAD_ACTIVITY, AI_AGENT_HANDOVER];

function normalizeNotice(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!…]+$/u, '')
    .toLocaleLowerCase('vi-VN');
}

function isKnownPageSystemNotice(value) {
  const normalized = normalizeNotice(value);
  return KNOWN_PAGE_SYSTEM_NOTICES.some((notice) => normalizeNotice(notice) === normalized);
}

module.exports = { AUTOMATIC_LEAD_ACTIVITY, AI_AGENT_HANDOVER, isKnownPageSystemNotice, normalizeNotice };
