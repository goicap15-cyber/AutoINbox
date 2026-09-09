# Tasks: Ghost Duplicate Messages From Unstable Direction Detection

**Input**: `specs/045-ghost-duplicate-message-investigation/spec.md`

## Phase 1 — Root cause thứ 2 tìm thêm khi bắt tay vào code (FR-001)

Trước khi sửa hash, đọc lại toàn bộ `parseMessagesFromDOMNode` để hiểu vì sao `is_outgoing` lại đổi giữa 2 lần quét. Phát hiện: `is_outgoing`/`sender_name` được tính 100% từ `effectiveLabel` (aria-label) — KHÔNG phải đoán ngẫu nhiên. Vậy lý do nó "lật" là `effectiveLabel` chính nó KHÔNG ổn định giữa 2 lần quét (label hydrate trễ hơn 1 nhịp so với node được chèn — đúng như comment sẵn có ở dòng ~466-477 đã mô tả cho trường hợp ảnh). Đồng thời phát hiện `nativeIdEl` ở `content.js` (dòng ~498) CHƯA có fix `[data-message-id]` như spec 043 đã áp cho `background.js` — đây có thể là NGUYÊN NHÂN GỐC thật sự: `[data-message-id]` là attribute tĩnh gắn ngay lúc chèn node, còn aria-label hydrate sau; nếu ưu tiên nó, `native_id` sẽ ỔN ĐỊNH ngay từ lần quét đầu tiên, né được toàn bộ vấn đề thay vì chỉ giảm nhẹ nó qua hash fallback.

- [X] T001 Thêm `[data-message-id]` làm ưu tiên đầu trong `nativeIdEl` lookup (`content.js` ~dòng 498), mirror đúng fix đã áp ở spec 043 cho `background.js`. Áp dụng luôn cho cả 2 chỗ đọc `native_id` (nhánh ảnh dòng ~597 và nhánh text dòng ~630) để đọc đúng `data-message-id` trước `data-id`/`id`.
- [X] T002 [FR-001] Sửa `makeDomMessageId()` (`content.js` ~dòng 661): bỏ `is_outgoing`, `sender_name`, `effective_label` khỏi input hash fallback — chỉ giữ `thread_id|content`. `native_id` (khi có, nhờ T001 sẽ có ở phần lớn trường hợp) vẫn là stableId ưu tiên, không đổi.
- [X] T003 Quyết định KHÔNG sửa `domDedupeKey` (debounce 800ms ngắn hạn, dòng ~733) như spec.md bản đầu dự tính — giữ nguyên `is_outgoing` trong khoá này. Lý do (khác với bản nháp spec ban đầu): nếu bỏ `is_outgoing` khỏi khoá 800ms, 1 lần quét sửa đúng chiều đến SAU lần quét sai (rất có thể trong vòng 800ms vì đây là hydration race, không phải sự kiện cách nhau lâu) sẽ bị chính debounce này chặn luôn, khiến bản sửa chiều KHÔNG BAO GIỜ tới được tầng dedup dài hạn để kích hoạt hysteresis (T004). Giữ `is_outgoing` trong khoá ngắn hạn cho phép 1 lần quét khác chiều đi qua ngay lập tức.

## Phase 2 — Cho phép sửa chiều thay vì tạo bản ghi mới (FR-002)

- [X] T004 [FR-002] Đổi `lastObservedMessages` từ `Set<fbMessageId>` sang `Map<fbMessageId, is_outgoing>` (`content.js` ~dòng 371, 676-679, 741-743, 850). Chỉ bỏ qua (`return`) khi CẢ id VÀ direction đều trùng lần gửi gần nhất; nếu cùng id nhưng khác direction, vẫn gửi lên server (với đúng `fb_message_id` cũ) để `ConversationRepository.reconcileExistingMessage()` (spec 019, đã đọc lại code — kích hoạt khi `INSERT OR IGNORE` va UNIQUE(fb_message_id) → `wasNewMessage=false` → gọi reconcile, `server.js` dòng ~952-995) xử lý hysteresis, thay vì tạo dòng "bóng ma" mới hoặc bỏ lỡ silently.
- [X] T005 Xác nhận (đọc code, không đoán) đường đi server-side: `INSERT OR IGNORE` (dòng ~953) → nếu trùng `fb_message_id` (`changes=0`) → `reconcileExistingMessage` chạy hysteresis đúng cơ chế cũ, không cần sửa gì ở `server.js`/`ConversationRepository` cho spec này.

## Phase 3 — Test & Validation

- [X] T006 [P] Tạo `src/extension/domMessageDedup.js` (pure logic mirror, cùng pattern `historyRowSupport.js`/`historySyncRoundBudget.js`): export `makeDomMessageId` (đã bỏ is_outgoing/sender_name/effective_label) và `shouldSkipObservation(lastObservedMessages, id, isOutgoing)`.
- [X] T007 `tests/unit/domMessageDedup.test.js` — 6 test PASS: (a) SC-001 cùng 1 tin, 2 lần quét khác `is_outgoing` → CÙNG 1 id; (b) có `native_id` ổn định → id không phụ thuộc content/label; (c) SC-002 nội dung thật sự khác nhau → id khác nhau, không regression; (d)-(f) `shouldSkipObservation` đúng cho 3 tình huống (đã thấy id+direction giống hệt → skip; cùng id khác direction → KHÔNG skip; id chưa từng thấy → KHÔNG skip).
- [X] T008 `node --check src/extension/content.js` PASS.
- [X] T009 `npm run test:persistence` — 362/362 PASS (356 cũ + 6 mới), không regression.
- [X] T010 `graphify update .` chạy sau khi code ổn định.

## Phase 4 — FR-004 Cleanup dữ liệu cũ (2026-08-20, đã xin và được duyệt riêng)

Rà toàn bộ bảng `messages` (không chỉ thread đã báo cáo), đối chiếu cả `media_type`/`media_url`/`local_media_path` trước khi kết luận — **bắt được false-positive quan trọng**: nhiều dòng `content` rỗng ban đầu tưởng là bóng ma hoá ra là tin ẢNH hợp lệ (`media_type='image'`, không có caption, đúng thiết kế ở nhánh `isPhotoMessage` của `parseMessagesFromDOMNode`) — đã loại các dòng này ra, không xoá.

- [X] T012 [FR-004] Query Dạng A: `content REGEXP '^[0-9]{1,2}(ch|sáng|chiều|tối)$'` toàn DB → 9 dòng, tất cả ở thread `969878666067566`, tất cả `is_outgoing=0`. Đã xoá: id `393, 394, 395, 396, 397, 398, 399, 402, 403`.
- [X] T013 [FR-004] Query Dạng B: self-join `(thread_id, timestamp_ms, content)` trùng khớp nhưng `is_outgoing` khác nhau (không ràng buộc `media_type` vì 1 cặp có `media_type` lệch nhau do false-positive ảnh riêng — xem ghi chú dưới) → 6 cặp xác nhận. Theo đúng cơ chế bug (nhãn chưa hydrate luôn mặc định sai thành `is_outgoing=false`), giữ phía `is_outgoing=1` (thật), xoá phía `is_outgoing=0` (bóng ma): id `410` (ghost của 15 "âdadad"), `412` (ghost của 17), `411` (ghost của 100), `405` (ghost của 146 "bvbv bvbvb vbvb"), `406` (ghost của 168 "fsdfsdfd"), `408` (ghost của 340 "long béo").
- [X] T014 Loại KHÔNG xoá (đã kiểm tra, không đủ bằng chứng là bóng ma): 7 dòng content rỗng ở thread `100092115712908` — đều có `fb_message_id` dạng `mid.$...` (native thật của Facebook, khác hẳn prefix `dom_` của bug này) + có `media_url`/`local_media_path` thật → ảnh hợp lệ, không liên quan cơ chế bug. 1 dòng ở thread `100004449999465` (id 102) và id `413` ở thread test — không có cặp `is_outgoing=1` đối chứng cùng timestamp → không đủ bằng chứng, để nguyên.
- [X] T015 Backup `data/database.db` → `data/backups/database.pre-spec045-cleanup.20260820T040302Z.db` trước khi xoá.
- [X] T016 Xin xác nhận qua AskUserQuestion (đã trình bày rõ 15 id + phân loại) → xác nhận "Xoá luôn". Đã chạy `DELETE FROM messages WHERE id IN (393,394,395,396,397,398,399,402,403,405,406,408,410,411,412);` — xoá đúng 15 dòng, còn lại 160 dòng trong bảng `messages`.

## Chưa làm

- [ ] T017 Test thật trên máy: mở lại thread `969878666067566` (hoặc thread khác), gõ vài tin, xác nhận không còn xuất hiện dòng "bóng ma" khác chiều mới sau khi reload extension. **Chưa chạy** — cần bạn reload extension để xác nhận trên dữ liệu thật.
- [ ] Rà soát `page_content.js` xem có cùng lỗi thiết kế (is_outgoing/sender_name lẫn vào id sinh ra) hay không — ngoài phạm vi spec này (đã ghi rõ trong "Out of Scope" của spec.md), để làm ở 1 vòng riêng nếu cần.

## Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4. Đã hoàn tất Phase 1-4 (trừ T017 cần máy thật, và page_content.js cố ý để ngoài phạm vi).
