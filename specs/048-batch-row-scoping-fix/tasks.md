# Tasks: Sửa Lỗi Gộp Nhiều Dòng Tin Nhắn Thành 1 (content.js)

**Input**: `specs/048-batch-row-scoping-fix/spec.md`

## Phase 0 — Điều tra

- [X] T001 Tra `fb_message_id` của 6 dòng bất thường trong thread `109426743817301` — xác nhận cả 6 dùng chung 1 `native_id` (`mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc`), chỉ khác `bubble_idx`. Đọc code `content.js` dòng ~442 xác nhận cơ chế: `messageRow = node.closest(...) || node` — khi Facebook chèn 1 khối lớn chứa nhiều dòng cùng lúc, `node` không nằm gọn trong 1 dòng, rơi vào fallback dùng cả khối làm "1 dòng".

## Phase 1 — Fix (FR-001, FR-002)

- [X] T002 [FR-001] Trước khi dùng `node` làm fallback, kiểm tra `node.querySelectorAll('div[role="article"], div[role="row"]').length > 1` — nếu đúng, đệ quy gọi `parseMessagesFromDOMNode` cho từng dòng riêng, gộp kết quả bằng `.concat()`, return sớm.
- [X] T003 [FR-002] Xác nhận không đổi hành vi khi `node` nằm trong đúng 1 dòng hoặc chứa 0-1 dòng lồng bên trong — do đệ quy chỉ kích hoạt khi `nestedRows.length > 1`, các trường hợp cũ đi thẳng qua nhánh `messageRow = directRowMatch || node` như trước.
- [X] T004 `node --check` PASS. `npm run test:persistence` — 374/374 PASS, không regression.
- [ ] T005 Test thật: mở lại 1 hội thoại có nhiều tin nhắn backlog trên profile Chrome mới, xác nhận không còn xuất hiện rác UI/trùng lặp sai chiều. **Chưa chạy** — cần môi trường thật (đã ghi trong spec.md phần "Ghi chú về test" lý do không viết unit test giả lập DOM cho hàm này).

## Phase 2 — Dọn dữ liệu cũ (FR-003)

- [X] T006 Rà 6 dòng bất thường trong thread `109426743817301` — phân loại lại cẩn thận: id 460 ("2,1K người theo dõi..."), 461 ("Video ca nhạc"), 462 ("Chi tiết cuộc trò chuyện") là rác UI thẻ giới thiệu trang, an toàn xoá. id 464 ("dâdad") trùng với id 55 đã có sẵn (cùng chiều). id 465 ("kckxc") trùng với id 56 đã có sẵn nhưng **SAI chiều** (id 56 đúng là incoming theo đúng giao diện Facebook thật đã đối chiếu, id 465 sai thành outgoing) — giữ id 56, xoá id 465.
- [X] T007 **Phát hiện quan trọng khi rà**: id 463 ("Xin chào, cảm ơn bạn đã liên hệ với chúng tôi...") tuy dính chung native_id lỗi với đám rác, nhưng nội dung là tin nhắn THẬT (auto-reply thật, không phải rác UI) — grep code xác nhận không phải template hardcode, có thể do người dùng tự gõ lúc test. **KHÔNG xoá**, chỉ xoá 5 dòng còn lại.
- [X] T008 Backup DB (`data/backups/database.pre-batch-row-cleanup.20260820T1500.db`), xin xác nhận qua AskUserQuestion → "Xoá luôn" → `DELETE FROM messages WHERE id IN (460,461,462,464,465);`. Xác nhận sau xoá: chỉ còn lại id 463.
- [X] T009 `graphify update .`.

## Dependencies

Phase 0 → Phase 1 → Phase 2. Đã hoàn tất tất cả trừ T005 (cần test thật trên máy).
