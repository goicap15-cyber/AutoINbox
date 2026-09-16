/**
 * leadExtractor.js
 * Trích xuất Email và số điện thoại di động từ nội dung tin nhắn. Số điện
 * thoại được ủy quyền cho vietnamPhone.js (spec 035) - danh sách đầu số
 * chính xác thay vì regex phỏng đoán theo thập phân - nên các giá trị trả
 * về đã là dạng normalized (10 số, không phải chuỗi gốc regex khớp được).
 * server.js's own inbound pipeline dùng PhoneCaptureService trực tiếp để
 * lưu bằng chứng/provenance; export này giữ lại cho bất kỳ nơi nào khác chỉ
 * cần quét nhanh phones/emails.
 */
const { findPhoneNumbers } = require('./vietnamPhone');

// Regex Email chu?n RFC
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Trích xuất danh sách SĐT (normalized) & Email từ chuỗi nội dung tin nhắn
 * @param {string} content - Nội dung tin nhắn cần phân tích
 * @returns {{ phones: string[], emails: string[] }}
 */
function extractLeadInfo(content) {
  if (!content || typeof content !== 'string') {
    return { phones: [], emails: [] };
  }

  const phones = [...new Set(findPhoneNumbers(content).map((match) => match.normalized))];
  const emails = [...new Set([...content.matchAll(EMAIL_REGEX)].map((m) => m[0]))];

  return { phones, emails };
}

module.exports = { extractLeadInfo };
