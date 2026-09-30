'use strict';

/* So sánh preview sidebar Business Suite với tin cuối đã lưu trong DB để
 * quyết định có cần sweep thread hay không (Phase 1 - plan 2026-09-30).
 *
 * Nguyên tắc an toàn: KHÔNG CHẮC CHẮN thì sync. Chỉ skip khi chắc chắn
 * thread không có gì mới:
 *  - thread KHÔNG unread (tin khách mới làm thread unread -> luôn quét),
 *  - preview đủ dài (>= 12 ký tự sau chuẩn hóa - "ok"/"dạ" lặp lại liên tục
 *    thì prefix-match không phân biệt được tin mới/tin cũ),
 *  - preview là prefix của tin đã lưu (hoặc ngược lại - BS cắt preview),
 *  - chuẩn hóa zero-width + whitespace + lowercase trước khi so.
 * Bỏ qua 1 thread chỉ nghĩa là không backfill lịch sử lần đó: tin khách mới
 * vẫn được bắt qua đường unread/preview-change và click của operator vẫn
 * syncForce từng thread.
 */

function normalizePreviewText(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi-VN');
}

const MIN_PREVIEW_CHARS = 12;

function sidebarShouldSkipSweep({ sidebarPreview, storedContent, isUnread } = {}) {
  // isUnread không xác định (undefined/null) -> không chắc trạng thái đọc
  // -> không skip (nguyên tắc: không chắc thì sync).
  if (isUnread === undefined || isUnread === null) return false;
  if (isUnread === true || Number(isUnread) === 1) return false;
  const preview = normalizePreviewText(sidebarPreview);
  if (!preview || preview.length < MIN_PREVIEW_CHARS) return false;
  const stored = normalizePreviewText(storedContent);
  if (!stored) return false;
  return stored.startsWith(preview) || preview.startsWith(stored);
}

module.exports = { normalizePreviewText, sidebarShouldSkipSweep, MIN_PREVIEW_CHARS };
