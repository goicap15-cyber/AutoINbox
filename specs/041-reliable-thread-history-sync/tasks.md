# Tasks: Reliable Thread History Sync & Auto-Retry

**Input**: `specs/041-reliable-thread-history-sync/spec.md`, `plan.md`

## Phase 0 — Research (done, see spec.md Background / Root Cause Analysis)

- [X] T001 Re-xác nhận 8 phát hiện trong `plan.md` Phase 0 vẫn đúng với source hiện tại trước khi bắt đầu code (đề phòng code đã đổi từ lúc viết spec tới lúc implement) — đối chiếu lại đúng số dòng `background.js:2221-2224`, `background.js:2515`, `background.js:2541-2556`, `server.js:1240-1249`, `server.js:1283-1308`, `server.js:1531-1536`. Tất cả khớp đúng, không có gì đổi giữa lúc viết spec và lúc implement.

---

## Phase 1 — Extension: round-budget đúng mode + báo cáo boundary (US1, nền tảng cho US2)

**Mục tiêu**: Crawler cuộn đủ sâu ở lần sync đầu tiên, và tự báo cáo trung thực đã chạm hết lịch sử hay chưa.

- [X] T002 [P] Trong `src/extension/background.js` (`loadOlderMessages`, quanh dòng 2221-2224): đổi round-budget map từ `{incremental:1, backfill:10, default:5}` sang khớp đúng 3 mode thực tế sẽ được server gửi: `{incremental:1, initial:8, deep_backfill:12}`. Xoá nhánh `'backfill'` không còn dùng tới (thay bằng `'deep_backfill'`).
- [X] T003 [US1] Trong cùng vòng lặp `loadOlderMessages`: khi phát hiện `spinner` đang hiển thị, KHÔNG tăng `roundsWithoutIncrease` ở vòng đó (FR-006) — tránh dừng sớm trong lúc Facebook đang tải chậm.
- [X] T004 [US1] Track lý do dừng vòng lặp (`stop_reason`): `'boundary_reached'` nếu gặp `boundaryId`, `'no_scroll_growth'` nếu dừng do `roundsWithoutIncrease >= 2`, `'max_rounds_hit'` nếu dừng do hết `maxRounds` mà không rơi vào 2 case trên (mặc định sau vòng lặp nếu chưa có `stopReason` nào được set).
- [X] T005 [US1] Trong hàm build kết quả trả về của DOM script: thêm `stop_reason` vào object trả về cùng `boundary_reached` đã có sẵn.
- [X] T006 [US1] Trong nơi build `newCursor` trước khi `sendToBackend('THREAD_MESSAGES_SYNCED', ...)`: copy `boundary_reached` và `stop_reason` từ `parsedResult` vào `newCursor` (checkpoint) gửi lên server.
- [X] T007 [P] [US1] Trích logic round-budget/stop-reason thành module thuần mới `src/extension/historySyncRoundBudget.js` (không thể `require()` được từ trong closure `chrome.scripting.executeScript` nên đây là bản mirror dùng riêng cho test, cùng convention với `textFilter.js` extension/server dual-copy — giá trị literal trong `background.js` phải giữ khớp tay). Unit test `tests/unit/historySyncRoundBudget.test.js` — 5 test, PASS.

**Checkpoint**: Extension gửi lên server đủ thông tin (`boundary_reached`, `stop_reason`) để server quyết định đúng `sync_status` ở Phase 2.

---

## Phase 2 — Server: quyết định đúng PARTIAL vs SYNCED (US2)

**Mục tiêu**: Không còn thread nào bị đánh dấu `SYNCED` sai trong khi lịch sử vẫn còn thiếu.

- [X] T008 [US2] Thêm `HistorySyncManager.resolveStatusFromCheckpoint(checkpoint)` (thay vì rẽ nhánh trực tiếp trong `server.js`, để logic quyết định testable độc lập) và dùng nó thay cho `updateSyncStatus(thread_id, 'SYNCED', checkpoint)` cứng trong nhánh `messages.length > 0`.
- [X] T009 [US2] Áp dụng đúng `resolveStatusFromCheckpoint` cho nhánh "empty messages nhưng không lỗi" — cùng một hàm dùng chung nên tự động nhất quán, không có logic rẽ nhánh trùng lặp.
- [X] T010 [US2] Tương thích ngược: `resolveStatusFromCheckpoint` trả `'SYNCED'` khi `checkpoint` null/không có `stop_reason` — không hạ cấp dữ liệu cũ.
- [X] T011 [P] [US2] Unit test `tests/unit/historySyncPartialStatus.test.js` gọi thẳng `HistorySyncManager.resolveStatusFromCheckpoint` (không cần mock DB vì hàm này thuần) — 4 test, PASS.

**Checkpoint**: `sync_status` phản ánh đúng thực tế; thread thiếu dữ liệu ở trạng thái `PARTIAL`, sẵn sàng cho Phase 3 tiếp tục đào sâu.

---

## Phase 3 — Server: chọn `deep_backfill` cho thread PARTIAL/FAILED (US4)

**Mục tiêu**: Mở lại hoặc bấm "Đồng bộ lại hội thoại" trên thread thiếu dữ liệu phải thực sự lấy thêm được lịch sử.

- [X] T012 [US4] Đổi logic chọn `mode` trong `REQUEST_SYNC_THREAD_MESSAGES` thành 3 nhánh: không có cursor → `'initial'`; có cursor và `sync_status ∈ {PARTIAL, FAILED}` → `'deep_backfill'`; còn lại → `'incremental'` (FR-005).
- [X] T013 [US4] Xác nhận bằng đọc code: `mode` truyền nguyên vẹn qua payload `SYNC_THREAD_MESSAGES`, và `ROUND_BUDGET.deep_backfill = 12` từ Phase 1 áp dụng đúng.
- [ ] T014 [P] [US4] Manual test (theo `quickstart.md` bước 4): thread đang `PARTIAL`, mở lại trong CRM → xác nhận qua log `mode=deep_backfill`. **Chưa chạy** — cần tài khoản Facebook thật + Chrome extension reload, ngoài khả năng của môi trường hiện tại. Cần bạn tự kiểm tra trên máy thật.

**Checkpoint**: Vòng lặp mở lại → deep_backfill → (Phase 2 đánh giá lại PARTIAL/SYNCED) hoạt động khép kín, không cần thay đổi gì ở client.

---

## Phase 4 — Server: auto-retry cho lỗi tạm thời (US3)

**Mục tiêu**: Lỗi DOM tạm thời tự phục hồi, không cần người dùng bấm lại, mà không phá an toàn điều hướng đã có.

- [X] T015 [US3] Tạo `src/server/services/HistorySyncRetryPolicy.js`: `scheduleRetry(accountId, threadId, retryFn)` với backoff `[2000, 6000, 15000]` ms tối đa 3 lần, `cancelRetry(threadId)`, `noteManualRequest(accountId, threadId)` để huỷ retry của thread khác cùng account.
- [X] T016 [US3] Nhánh `reason` trong `THREAD_MESSAGES_SYNCED`: `marker_mismatch`/`sidebar_mismatch`/`no_rows`/`no_main_container` → `scheduleRetry` (tự build lại payload `SYNC_THREAD_MESSAGES` từ `threads.thread_url`/`contact_name` + `ConversationRepository.getThreadSource`); `error_screen` → giữ nguyên, không retry (FR-008).
- [X] T017 [US3] `REQUEST_SYNC_THREAD_MESSAGES` gọi `HistorySyncRetryPolicy.noteManualRequest(targetAccId, thread_id)` trước khi dispatch — huỷ retry của thread cũ khác + huỷ retry đang chờ của chính thread này nếu người dùng vừa bấm lại tay.
- [X] T018 [US3] Hết 3 lần retry vẫn lỗi → giữ `FAILED`, log `[HISTORY_SYNC_RETRY_EXHAUSTED]` (đã có sẵn trong `scheduleRetry`).
- [X] T019 [P] [US3] `tests/integration/historySyncRetryPolicy.test.js` dùng `node:test` mock timers (không chờ backoff thật) — 4 test, PASS. **Bắt được 1 bug thật trong lúc viết test**: điều kiện huỷ-khi-điều-hướng ban đầu so sánh `latestThreadByAccount.get(accId) || ''` nên khi chưa từng có `noteManualRequest` nào cho account đó, mọi retry đầu tiên đều bị coi là "đã điều hướng đi" và không bao giờ bắn — đã sửa thành chỉ huỷ khi `Map` thực sự có ghi nhận một thread KHÁC.
- **[SỰ CỐ THẬT khi chạy trên production]**: `server.js:1238` destructure `msg.data` thiếu field `cursor`, trong khi callback `scheduleRetry` (T016) lại dùng biến `cursor` ở dòng 1270 → `ReferenceError: cursor is not defined` bên trong `setTimeout` không có try/catch bọc ngoài → **crash chết cả tiến trình Node** khi retry đầu tiên bắn ra (log thực tế: `HISTORY_SYNC_RETRY_FIRE` rồi server thoát). Đã sửa: thêm `cursor` vào destructure. Đồng thời bọc `try/catch` quanh `retryFn()` trong `HistorySyncRetryPolicy.js` để một lỗi tương tự trong tương lai chỉ log `[HISTORY_SYNC_RETRY_ERROR]` thay vì crash toàn bộ server. Đã re-run `npm run test:persistence` (326/326 pass) sau fix.

**Checkpoint**: Lỗi tạm thời tự phục hồi trong giới hạn 3 lần; `error_screen` vẫn cần người dùng can thiệp như cũ.

---

## Phase 5 — Client: phân biệt hiển thị PARTIAL (FR-010)

**Mục tiêu**: Người dùng thấy tin nhắn đã có ngay cả khi thread còn đang lấy thêm lịch sử cũ, thay vì màn hình trắng gây hiểu lầm "chưa đồng bộ".

- [X] T020 [P] Xác nhận: `AssignmentManager.getThreadsByFilter` dùng `SELECT t.*` nên `sync_status` đã có sẵn trong response `/api/threads` — không cần sửa gì.
- [X] T021 [US2] Thêm banner "Đang tải thêm lịch sử cũ hơn…" trong `MessageList.jsx` khi `messages.length > 0 && activeThread?.sync_status === 'PARTIAL'`; màn hình rỗng (`LOCAL`, 0 tin) giữ nguyên như cũ.
- [ ] T022 [P] Manual test trong browser: thread PARTIAL có sẵn vài tin → xác nhận banner hiển thị đúng. **Chưa chạy** — cần dữ liệu Facebook thật; đã build `vite build` thành công để xác nhận JSX hợp lệ, nhưng chưa xác minh bằng mắt trên UI thật.

**Checkpoint**: UI không còn gây hiểu lầm giữa "chưa đồng bộ gì" và "đã có một phần, đang lấy thêm".

---

## Phase 6 — Validation & Regression

- [X] T023 `node --check` PASS trên toàn bộ file `.js` đã sửa. `MessageList.jsx` không check được bằng `node --check` (không parse JSX) — thay bằng `npx vite build` (PASS, chỉ có warning chunk-size không liên quan).
- [X] T024 `npm run test:persistence` — 326/326 test PASS, không regression.
- [ ] T025 Chạy lại `quickstart.md` bước 6 (no-regression check) trên dữ liệu Facebook thật. **Chưa chạy** — cần môi trường có Chrome extension + tài khoản thật; đã bao phủ phần logic bằng unit test `historySyncPartialStatus.test.js` (case cursor không có `stop_reason` → vẫn SYNCED) nhưng chưa test end-to-end thật.
- [X] T026 `graphify update .` — 7643 nodes, 9018 edges, 644 communities (đây cũng là lần đầu `graphify-out/` được tạo, trước đó thư mục này chưa tồn tại).

## Dependencies

- Phase 0 → Phase 1 → Phase 2 → Phase 3: tuần tự bắt buộc — Phase 2 cần dữ liệu (`boundary_reached`/`stop_reason`) do Phase 1 tạo ra; Phase 3 cần `sync_status` đáng tin cậy do Phase 2 tạo ra.
- Phase 4 (retry) độc lập với Phase 2/3 về mặt code (chạm nhánh `reason` khác nhánh `messages`), có thể làm song song với Phase 2/3 sau khi Phase 1 xong, nhưng T017 phụ thuộc T012 (Phase 3) đã tồn tại để gọi `cancelRetry` đúng chỗ.
- Phase 5 (UI) chỉ cần `sync_status` đã đúng từ Phase 2 — có thể làm song song với Phase 3/4.
- Phase 6 chạy sau cùng, sau khi mọi phase trên hoàn tất.
