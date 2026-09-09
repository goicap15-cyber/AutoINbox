// AutoChatbot - Extension Text Filter Utility

(function () {
  const SYSTEM_PATTERNS = [
    // E2EE & Security Notices
    /Tin nhắn và cuộc gọi (?:đang )?được bảo mật/i,
    /bảo mật bằng tính năng mã hóa/i,
    /bảo mật đầu cuối/i,

    // Footer, Privacy & Links
    /^Tìm hiểu thêm$/i,
    /^Xem thêm$/i,
    /^Quyền riêng tư/i,
    /^Cookie$/i,
    /^Facebook$/i,
    /^Messenger$/i,
    /^Meta$/i,
    /^Trang chủ$/i,
    /^Khôi phục ngay$/i,
    /^Khôi phục tin nhắn$/i,
    /^Restore now$/i,
    /^Restore messages$/i,
    /^Personal chats are secured with end-to-end encryption/i,
    /^Thiếu lịch sử chat/i,
    /^Thiếu tin nhắn\.?$/i,
    /^Không khôi phục được tin nhắn\.?$/i,
    /^Bạn đã tạo nhóm này/i,
    /^Chỉ những người tham gia/i,
    /^Bản quyền Meta/i,
    /^Thêm tin nhắn được cá nhân h(?:óa|oá)\.?$/i,

    // Right sidebar & header UI elements
    /^(?:Trang cá nhân|View profile)$/i,
    /^(?:Tắt thông báo|Mute notifications)$/i,
    /^(?:Tìm kiếm|Search)$/i,
    /^(?:Thông tin về đoạn chat|Conversation information|Chat info|Chi tiết cuộc trò chuyện)$/i,
    /^(?:Tùy chỉnh đoạn chat|Customize chat)$/i,
    /^(?:File phương tiện,? file và liên kết|Media,? files and links)$/i,
    /^(?:Quyền riêng tư và hỗ trợ|Privacy and support|Privacy & support)$/i,
    /^(?:Chủ đề|Theme)$/i,
    /^(?:Biểu tượng cảm xúc|Emoji)$/i,
    /^(?:Biệt danh|Nicknames)$/i,
    /^(?:Tạo nhóm|Create group)$/i,
    /^(?:Thành viên|Members)$/i,
    /^(?:Tên người dùng|Username)$/i,
    /^(?:Gỡ|Remove|Unsend)$/i,
    /^(?:Trả lời|Reply)$/i,
    /^(?:Chuyển tiếp|Forward)$/i,
    /^(?:Ghim|Pin)$/i,
    /^(?:Sao chép|Copy)$/i,

    // Status & Presence (exact standalone matches only)
    /^(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen)$/i,
  /^(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen)\s+\d+\s+(?:giây|phút|giờ|ngày|tuần|tháng|năm)\s+(?:trước|ago)$/i,
    /^(?:Đang hoạt động.*|Hoạt động(?:\s+\d+.*)?|Đã hoạt động.*|Active now|Active recently|Active \d+.*|Online|Offline)$/i,
    /^(?:Typing[.…]*|Đang nhập[.…]*|Đang gửi[.…]*|Sending[.…]*)$/i,
    /^(?:Đang tải|Loading)[.…]*$/i,

    // Accessibility / System standalone
    /^(?:Tin nhắn do|Message sent by) .+?(?:gửi lúc|at) .+?:\s*.*$/i,
    /^Nhấn Enter để gửi$/i,
    // Meta Business Suite lead-activity UI, not a message from the customer.
    /^Đã tự động tạo hoạt động về khách hàng tiềm năng cho bạn dựa trên cuộc trò chuyện này[.!…]*$/i,

    // Standalone Timestamps (e.g. 09:09, 16:36 T5, 18:00 T5, 12:30 AM, T5, CN)
    /^\d{1,2}:\d{2}(?:\s*(?:T[2-7]|CN|AM|PM))?$/i,
    /^(?:T[2-7]|CN)$/i,

    // Full date/time separator header Business Suite renders between message
    // groups (e.g. "13:52 6 Tháng 8, 2026") - mirrors the same addition in
    // src/server/utils/textFilter.js (keep both copies in sync).
    /^\d{1,2}:\d{2}\s+\d{1,2}\s+Tháng\s+\d{1,2},?\s+\d{4}$/i,
    // Short date-only separator, no time/year (e.g. "20 Tháng 4") - live
    // report (2026-08-20) found this leaking in as its own fake message row.
    /^\d{1,2}\s+Tháng\s+\d{1,2}(?:,?\s*\d{4})?$/i,
    // Short day-of-week / relative-day separator, same family (spec 047).
    /^(?:Thứ (?:Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|Hôm nay|Hôm qua|Today|Yesterday)$/i
  ];

  function isSystemOrMetadataText(text) {
    if (!text || typeof text !== 'string') return true;
    const trimmed = text.trim();
    if (!trimmed) return true;

    for (const pat of SYSTEM_PATTERNS) {
      if (pat.test(trimmed)) return true;
    }
    return false;
  }

  function cleanMessageText(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText.trim();
    if (!text) return '';

    // 1. Strip accessibility prefix (handling 'Tin nhắn do X gửi lúc Thứ Năm 18:00ch:', 'Tin nhắn do X gửi lúc 18:00:', etc.)
    text = text.replace(/^(?:Nhập,\s*)?Tin nhắn do [^\n]+? gửi lúc [^\n]*:\s*/i, '').trim();
    text = text.replace(/^(?:Nhập,\s*)?Message sent by [^\n]+? at [^\n]*:\s*/i, '').trim();
    text = text.replace(/^Nhập,\s*/i, '').trim();
    text = text.replace(/^[:\s]+/, '').trim();

    const sentEmojiMatch = text.match(/^[^,\n]{1,80}\s+(?:đã gửi|sent),\s*(.+)$/i);
    if (sentEmojiMatch) {
      const payload = sentEmojiMatch[1].trim();
      if (payload && !/[A-Za-zÀ-ỹ0-9]/.test(payload)) {
        text = payload;
      }
    }

    // 2. Strip delivery status ONLY if appended on a separate line or after multi-space metadata (never strip inside normal text like 'Đã gửi hàng rồi')
    text = text.replace(/(?:\n|\r|\s{2,})(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen|Nhấn Enter để gửi)\s*$/i, '').trim();

    // 3. Strip leading/trailing timestamps ONLY if isolated/standalone on line
    text = text.replace(/^\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?\s*$/i, '').replace(/(?:\n|\r)\s*\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?$/i, '').trim();
    text = text.replace(/^[:\s]+/, '').trim();

    if (!text) return '';

    if (isSystemOrMetadataText(text)) return '';

    return text;
  }

  const INVALID_CONTACT_NAME_PATTERNS = [
    /^(?:Tất cả tin nhắn|Tất cả|All messages|All)$/i,
    /^(?:Tin nhắn trực tiếp|Direct messages)$/i,
    /^(?:Hộp thư đến|Hộp thư|Inbox)$/i,
    /^(?:Chưa đọc|Unread)$/i,
    /^(?:Đã xong|Done)$/i,
    /^(?:Gắn dấu sao|Đã gắn dấu sao|Starred)$/i,
    /^(?:Spam|Thư rác)$/i,
    /^(?:Bình luận.*|Comments.*)$/i,
    /^(?:Thông báo|Notifications)$/i,
    /^(?:Đang hoạt động.*|Hoạt động(?:\s+\d+.*)?|Đã hoạt động.*|Active now|Active recently|Active \d+.*|Online|Offline)$/i,
    /^(?:Đang|Loading|Đang tải)[.…]*$/i,
    /^(?:Nhấn Enter để gửi|Press Enter to send)$/i,
    /^(?:Tin nhắn và cuộc gọi.*|bảo mật.*)$/i,
    /^(?:Facebook|Messenger|Meta)$/i
  ];

  function isInvalidContactName(name) {
    if (!name || typeof name !== 'string') return true;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) return true;
    for (const pat of INVALID_CONTACT_NAME_PATTERNS) {
      if (pat.test(trimmed)) return true;
    }
    return false;
  }

  function cleanContactName(rawName, fallback = 'Khách hàng') {
    if (!rawName || typeof rawName !== 'string') return fallback;
    const trimmed = rawName.trim();
    if (isInvalidContactName(trimmed)) return fallback;
    return trimmed;
  }

  globalThis.FbCrmTextFilter = {
    isSystemOrMetadataText,
    cleanMessageText,
    isInvalidContactName,
    cleanContactName
  };
})();
