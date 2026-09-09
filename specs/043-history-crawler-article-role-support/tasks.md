# Tasks: History Crawler `role="article"` Support

**Input**: `specs/043-history-crawler-article-role-support/spec.md`, `plan.md`

## Phase 0 — Research (done)

- [X] T001 Re-xác nhận 4 vị trí `div[role="row"]` và vị trí `nativeIdEl`/`args` trong `handleSyncThreadMessages()` vẫn đúng số dòng trước khi sửa. Khớp đúng.

## Phase 1 — Selector + Native ID (US1, US2)

- [X] T002 [P] Thêm `div[role="article"]` vào 4 vị trí đang chỉ có `div[role="row"]` trong `background.js` (DOM-ready check dòng ~2184, boundary-scroll check dòng ~2232, final marker check dòng ~2283, danh sách row để parse dòng ~2425).
- [X] T003 [US2] Đổi thứ tự ưu tiên `nativeIdEl`: `[data-message-id]` trước, fallback `[data-id], [id^="mid."]` — áp dụng ở cả `hasNativeId` (dòng ~2438) và boundary-match trong `loadOlderMessages` (dòng ~2234).
- [X] T004 [US2] `nativeId` (dùng làm `fb_message_id`) đọc đúng thứ tự `data-message-id` → `data-id` → `id` → fallback `row.getAttribute('data-id')`.

## Phase 2 — Direction resolution mới (US3)

- [X] T005 [US3] Tạo `src/extension/historyRowSupport.js` (pure logic mirror): `resolveDirectionFromLabel(effectiveLabel, contactName)`.
- [X] T006 [US3] `args: [thread_id, mode, cursor, contact_name]` + chữ ký `func: async (targetThreadId, mode, cursor, contactName) => {...}`.
- [X] T007 [US3] Thay khối tính `isOutgoing`/`senderName` bằng logic 3 tầng: pattern cũ (không đổi) → pattern mới `Lúc <time>..., <tên>: <nội dung>` so khớp `contactName` (khớp = incoming, khác = outgoing do loại trừ 2 phía) → không xác định được thì bỏ qua bubble (`continue`) + log `[FB Engine] ⚠️ Bỏ qua tin nhắn...`.
- [X] T008 [P] [US3] `tests/unit/historyRowSupport.test.js` — 8 test, PASS. **Bắt được 1 bug thật khi viết test**: regex ban đầu `/^Lúc\s+.+?,\s*(.+?):\s*/i` dùng `.+?` (non-greedy) ở đoạn đầu nên dừng ở dấu phẩy ĐẦU TIÊN (trong cụm ngày tháng "29 Tháng 3, 2025,"), gộp nhầm "2025, " vào tên trích được (`"2025, Người dùng Facebook"` thay vì `"Người dùng Facebook"`). Sửa thành `.+` (greedy) để nuốt hết phần ngày tháng rồi lùi về đúng dấu phẩy cuối trước tên. Đã sửa đồng bộ ở cả `historyRowSupport.js` và bản inline trong `background.js`.

## Phase 3 — Validation

- [X] T009 `node --check` PASS trên `background.js`, `historyRowSupport.js`.
- [X] T010 `npm run test:persistence` — 338/338 PASS (8 test mới so với 330 của spec 042), không regression.
- [X] T011 `graphify update .` — 7726 nodes, 9093 edges, 651 communities.
- [ ] T012 Manual test thật: sync lại thread `636212466232285`, xác nhận `count >= 1`. **Chưa chạy** — cần bạn reload extension rồi bấm "Đồng bộ lại hội thoại" trên đúng thread đó để xác nhận trên dữ liệu thật.

## Phát hiện thêm sau khi vá lần 1 (2026-08-19, qua DOM inspection trực tiếp thêm 1 vòng nữa)

Test thật với tin nhắn tự gõ "anh ơi em test nha" vẫn không đồng bộ được sau bản vá đầu. Điều tra bằng script walk-ancestor đầy đủ (không đoán tên attribute) cho thấy: `aria-label` thật và `data-message-id` **không nằm trên chính `div[role="article"]`** mà nằm ở phần tử con sâu hơn 2 cấp, mang `data-scope="messages_table"` + `aria-roledescription="tin nhắn"`. Code cũ chỉ tìm con có `aria-label` chứa "Tin nhắn do"/"Message sent" (pattern cũ) nên bỏ lỡ hoàn toàn label dạng mới.

- [X] T013 [US1] Sửa `childMsgEl` lookup trong `background.js` (dòng ~2437-2444): thêm `row.querySelector('[data-scope="messages_table"][aria-label], [aria-roledescription="tin nhắn"][aria-label]')` làm ưu tiên đầu, giữ pattern cũ làm fallback.
- [X] T014 Thêm test `historyRowSupport.test.js` cho đúng label thật "Lúc 16:36 30 Tháng 7, 2026, Bạn: anh ơi em test nha " (self-sent, suy luận outgoing qua loại trừ) — 9 test, PASS.
- [X] T015 `npm run test:persistence` — 339/339 PASS. `graphify update .` — 7727 nodes.
- [ ] T016 Manual test thật lần 2: sau khi reload extension, gửi lại 1 tin test, xác nhận đồng bộ được và đúng chiều. **Chưa chạy.**

## Xác nhận từ người dùng (2026-08-19)

Đã hỏi và được xác nhận: tin nhắn VOCHER trong ảnh **do "Người dùng Facebook" gửi đến** (incoming), không phải do tài khoản CRM gửi đi. Khớp đúng với logic đã implement (tên trong aria-label mới trùng `contact_name` → incoming) — **không cần sửa gì thêm** cho quy tắc so khớp tên.

## Dependencies

Phase 1 → Phase 2 → Phase 3. Đã hoàn tất Phase 1-3 (trừ T012 cần máy thật).
