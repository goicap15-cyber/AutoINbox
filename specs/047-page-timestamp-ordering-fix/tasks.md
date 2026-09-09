# Tasks: Sửa Lỗi Thứ Tự Tin Nhắn Bị Đảo Lộn (page_content.js)

**Input**: `specs/047-page-timestamp-ordering-fix/spec.md`

## Phase 0 — Điều tra + tự sửa giả thuyết sai

- [X] T001 Kiểm tra 7 dòng `timestamp_source='unknown'` thật trong DB (thread `100092115712908`) — phát hiện `fb_message_id` dùng prefix `pending_queue_*`, grep toàn `src/` xác nhận chuỗi này KHÔNG còn tồn tại trong code hiện tại (đã đổi sang `pending_<client_message_id>` từ lâu). **Rút lại giả thuyết "backlog window → timestamp_ms=0"** — đây là dữ liệu rác cũ, không phải bug đang sống. Xác nhận thêm: 6 dòng dùng đúng scheme `pending_` hiện tại đều có timestamp đúng, không kẹt ở 0.
- [X] T002 Tìm root cause THẬT bằng cách đối chiếu `created_at` (giờ chụp thật) với `timestamp_ms` (giờ gán) của tin nhắn id=125 — lệch gần 5 tiếng (`2026-08-19T04:41:47.489Z` gán cho tin chụp lúc `2026-08-19T09:33:00.355Z`). Đọc code `assignOrderedTimestamps()` (`page_content.js` dòng ~262-309) xác nhận cơ chế: extrapolate forward từ `lastKnownTs` không có giới hạn độ cũ.

## Phase 1 — Fix chính (FR-001, FR-002)

- [X] T003 Thêm hằng số `STALE_ANCHOR_MS = 5 * 60 * 1000` cạnh `ORDER_GAP_MS`/`THREAD_BACKLOG_WINDOW_MS`.
- [X] T004 [FR-001] Trong nhánh `else if (lastKnownTs !== null)` (extrapolate forward, không có `nextKnownTs`) của `assignOrderedTimestamps()`: nếu `Date.now() - assigned > STALE_ANCHOR_MS`, chuyển sang `assigned = Date.now() - ORDER_GAP_MS * (orderedIds.length - i)` (giống nhánh "không có anchor nào" có sẵn).
- [X] T005 [FR-002] KHÔNG đổi nhánh interpolate giữa 2 mốc và nhánh extrapolate backward (`nextKnownTs`, dùng cho cuộn lên xem lịch sử cũ) — xác nhận qua test không regression.
- [X] T006 Tạo `src/extension/orderedTimestampAssigner.js` (pure logic mirror, cùng pattern `historyRowSupport.js`/`domMessageDedup.js`) — nhận `now` injectable để test được, không phụ thuộc `Date.now()` thật.
- [X] T007 `tests/unit/orderedTimestampAssigner.test.js` — 5 test PASS: (a) đúng kịch bản bằng chứng thật (mốc cũ 5 tiếng) → gán ra gần `now`, không lùi về mốc cũ; (b) mốc mới (2 giây trước, trong ngưỡng) vẫn extrapolate bình thường — không regression; (c) extrapolate backward (lịch sử cũ) không bị đụng; (d) interpolate giữa 2 mốc không bị đụng; (e) không có anchor nào → fallback theo `now`, không đổi hành vi cũ.

## Phase 2 — Phát hiện phụ: dải phân cách ngày dạng ngắn (FR-003)

- [X] T008 Thêm pattern `/^(?:Thứ (?:Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|Hôm nay|Hôm qua|Today|Yesterday)$/i` vào `page_content.js` (chặn tại nguồn, cạnh pattern "20 Tháng 4" đã có) và cả 3 bản filter dùng chung (`src/extension/textFilter.js`, `src/server/utils/textFilter.js`, bản inline `background.js`).
- [X] T009 Test `textFilter.test.js` — thêm 1 test group 5 assertion PASS.

## Phase 3 — Validation + dọn dữ liệu cũ (FR-004)

- [X] T010 `node --check` PASS cho `page_content.js`, `background.js`, `textFilter.js` x2, `orderedTimestampAssigner.js`.
- [X] T011 `npm run test:persistence` — 374/374 PASS (368 cũ + 6 mới: 5 orderedTimestampAssigner + 1 textFilter group), không regression.
- [X] T012 [FR-004] Rà toàn DB tìm content khớp `Thứ Hai/Ba/Tư/Năm/Sáu/Bảy/Chủ Nhật/Hôm nay/Hôm qua` — tìm được đúng 2 dòng (id 1 "Thứ Ba", id 352 "Hôm nay", cùng thread `100092115712908`). Backup DB (`data/backups/database.pre-day-separator-cleanup.20260820T1400.db`), xin xác nhận qua AskUserQuestion → "Xoá luôn" → đã `DELETE FROM messages WHERE id IN (1,352);`.
- [X] T013 `graphify update .`.

## Chưa làm (ngoài phạm vi, theo spec.md)

- [ ] Test thật trên máy: mở lại thread `100092115712908` sau khi reload extension, gửi vài tin cách nhau vài giờ (hoặc đợi thật), xác nhận thứ tự hiển thị đúng theo thời gian thực. **Chưa chạy** — cần thời gian thực để tái hiện đúng kịch bản "mốc cũ hàng giờ".
- [ ] Cơ chế seeding/race (`seedTimestampAnchorsForThread` fire-and-forget) — cố ý không đụng, bằng chứng cho thấy fix staleness đã đủ giải quyết triệu chứng quan sát được.

## Dependencies

Phase 0 → Phase 1 → Phase 2 → Phase 3. Đã hoàn tất tất cả trừ test thật cần thời gian thực (đã ghi rõ giới hạn).
