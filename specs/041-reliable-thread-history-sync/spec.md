# Feature Specification: Reliable Thread History Sync & Auto-Retry

**Feature Branch**: `041-reliable-thread-history-sync`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Đồng bộ chỉ hoạt động cho một vài hội thoại, một số hội thoại hiển thị thiếu tin nhắn hoặc nội dung không chuẩn. Cần: (1) tăng độ sâu/độ tin cậy khi load lịch sử, (2) tự động retry khi sync FAILED, (3) sau lần cào đầu tiên phải nhớ checkpoint và các lần sau chỉ lấy tin mới, checkpoint phải bền trên server chứ không phụ thuộc trạng thái trình duyệt/tab (có thể bị reset)."

## Background / Root Cause Analysis

Khảo sát code hiện tại (nhánh `dev`) cho thấy 3 lỗ hổng cụ thể, không phải do thiếu kiến trúc mà do triển khai chưa khớp giữa các lớp:

1. **Round-budget sai mode** — `src/extension/background.js:2221-2224` (`loadOlderMessages`) định nghĩa số vòng cuộn lazy-load theo `modeStr`: `incremental` → 1, `backfill` → 10, mặc định → 5. Nhưng server (`src/server/server.js:1533-1536`, hàm xử lý `REQUEST_SYNC_THREAD_MESSAGES`) **chỉ bao giờ gửi `mode: 'initial'` hoặc `mode: 'incremental'`** — không bao giờ gửi `'backfill'`. Kết quả: lần đồng bộ đầu tiên của MỌI hội thoại (`mode = 'initial'`, quan trọng nhất vì phải lấy nhiều lịch sử nhất) lại rơi vào nhánh mặc định chỉ 5 vòng cuộn, trong khi nhánh 10 vòng không bao giờ được dùng tới.
2. **`PARTIAL` được định nghĩa nhưng không bao giờ được set** — `HistorySyncManager.js:7` khai báo `sync_status` có thể là `PARTIAL`, nhưng trong toàn bộ codebase không có chỗ nào gọi `updateSyncStatus(..., 'PARTIAL', ...)`. DOM crawler (`background.js:2515`) đã tính sẵn `boundary_reached` (đã chạm điểm neo lịch sử cũ hay chưa) nhưng giá trị này **bị bỏ qua hoàn toàn** khi build `checkpoint` gửi lên server (`background.js:2541-2556`). Server luôn set `sync_status = 'SYNCED'` bất cứ khi nào có `checkpoint` (`server.js:1283-1285, 1306-1308`), kể cả khi crawl chỉ dừng vì hết vòng cuộn chứ chưa lấy hết lịch sử. Vì `SYNCED` khiến các lần mở thread sau đó luôn dùng `mode: 'incremental'` (1 vòng), phần lịch sử bị bỏ sót ở lần đầu **không bao giờ được lấy lại**.
3. **Không có retry tự động** — `server.js:1240-1249`: khi extension trả về `reason` lỗi (vd `marker_mismatch`, `sidebar_mismatch`, `no_rows`, `no_main_container`, `error_screen`), server set `sync_status = 'FAILED'` và chủ động **không** dùng timer retry (comment tại chỗ giải thích: một retry trễ có thể điều hướng nhầm tab Messenger về thread cũ nếu người dùng đã click sang thread khác — đây là hành vi đã được sửa có chủ đích trước đó, không được phá lại). Hệ quả phụ hiện tại: thread rơi vào `FAILED` sẽ đứng yên vĩnh viễn cho tới khi người dùng tự bấm "Đồng bộ lại hội thoại".
4. **Nút "Đồng bộ lại hội thoại" không thực sự đào sâu hơn** — nút này gọi lại đúng `REQUEST_SYNC_THREAD_MESSAGES` như một lần mở thread bình thường (`App.jsx:186-205`). Vì thread đã có `sync_cursor` (dù dữ liệu chưa đầy đủ), server chọn `mode: 'incremental'` (1 vòng cuộn) — tức là bấm nút "đồng bộ lại" cho một thread thiếu dữ liệu gần như không lấy thêm được gì.
5. **Checkpoint đã bền trên server (đúng như spec 003), không phải lỗi** — `threads.sync_cursor`/`sync_status`/`sync_error` đã là cột SQLite (`src/server/database/db.js:101-103`), được đọc lại từ DB mỗi lần trước khi dispatch (`server.js:1531-1536`), không phụ thuộc state cục bộ của tab/extension. Phần này **giữ nguyên**, chỉ bổ sung kiểm thử để đảm bảo không có nhánh mới nào vô tình phá nguyên tắc này.

> Ghi chú phạm vi: `src/server/services/InboxSyncScheduler.js` được viết theo spec `007-multi-account-background-sync` (đồng bộ nền cho *toàn bộ* tài khoản mà không cần thao tác) nhưng chưa từng được `require` ở bất kỳ đâu trong `server.js` — là dead code. Việc chủ động đồng bộ toàn bộ user không nằm trong yêu cầu lần này (người dùng chỉ chọn "tăng độ sâu/độ tin cậy" + "tự retry" + "checkpoint bền"), nên spec này **không** đụng tới việc nối lại `InboxSyncScheduler`. Ghi nhận làm việc tiềm năng riêng nếu sau này cần.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Lần đồng bộ đầu tiên phải đủ sâu (P1)

Khi một hội thoại được mở lần đầu tiên (chưa có `sync_cursor`), hệ thống phải cuộn đủ số vòng cần thiết để lấy được nhiều lịch sử nhất có thể trong một phiên, thay vì bị cắt ngang bởi giới hạn vòng cuộn không khớp với mode thực tế.

**Why this priority**: Đây là nguyên nhân trực tiếp của "hiển thị thiếu đoạn chat" mà người dùng báo cáo.

**Independent Test**: Mở một hội thoại có > 100 tin nhắn chưa từng đồng bộ; sau khi `THREAD_MESSAGES_SYNCED` hoàn tất, so số tin trong DB với số tin thực tế cuộn được thủ công trên Messenger trong cùng khoảng thời gian.

**Acceptance Scenarios**:

1. **Given** thread chưa có `sync_cursor`, **When** người dùng mở thread, **Then** crawler chạy với round-budget dành riêng cho lần đầu (không rơi vào nhánh mặc định do mode không khớp).
2. **Given** thread rất dài mà một phiên cuộn không thể lấy hết, **When** crawl dừng vì hết vòng, **Then** kết quả trả về phải mang cờ chưa hoàn tất (xem US2).

---

### User Story 2 — Trạng thái đồng bộ phải phản ánh đúng thực tế: PARTIAL vs SYNCED (P1)

Khi crawler dừng mà chưa chạm được điểm neo lịch sử cũ nhất (chưa "hết" hội thoại), thread phải được đánh dấu `PARTIAL`, không phải `SYNCED`.

**Why this priority**: Đây là nguyên nhân khiến phần lịch sử bị thiếu **không bao giờ được lấy lại** ở các lần mở sau — gốc rễ sâu nhất của toàn bộ vấn đề.

**Independent Test**: Giả lập một thread dài, giới hạn round-budget thấp để chắc chắn crawl không chạm boundary; kiểm tra `threads.sync_status` sau khi `THREAD_MESSAGES_SYNCED` xử lý xong phải là `PARTIAL`, và `sync_cursor` vẫn giữ đủ thông tin (oldest_message_id/oldest_timestamp_ms) để lần sau tiếp tục lùi xa hơn thay vì chỉ tiến tới tin mới.

**Acceptance Scenarios**:

1. **Given** `boundary_reached = false` khi crawl dừng do hết vòng/hết thời gian, **When** server nhận `THREAD_MESSAGES_SYNCED`, **Then** `sync_status` = `PARTIAL`.
2. **Given** `boundary_reached = true` (hoặc crawler xác nhận đã chạm đầu hội thoại thật), **When** server nhận kết quả, **Then** `sync_status` = `SYNCED`.
3. **Given** thread đang `PARTIAL`, **When** người dùng mở lại thread đó, **Then** server dispatch một round-budget "đào sâu" (không phải `incremental` 1 vòng) để tiếp tục lấy phần còn thiếu.

---

### User Story 3 — Tự động thử lại khi gặp lỗi tạm thời (P2)

Các lỗi DOM tạm thời (`marker_mismatch`, `sidebar_mismatch`, `no_rows`, `no_main_container`) phải được server tự lên lịch thử lại có giới hạn số lần, thay vì đứng yên ở `FAILED` chờ thao tác tay — nhưng KHÔNG được phá lại hành vi an toàn đã có (không điều hướng nhầm tab về thread cũ khi người dùng đã chuyển sang thread khác).

**Why this priority**: Giảm số hội thoại bị kẹt vĩnh viễn ở trạng thái lỗi do timing tạm thời (Facebook DOM tải chậm, sidebar chưa kịp active).

**Independent Test**: Giả lập extension trả `reason: 'marker_mismatch'` 2 lần liên tiếp rồi thành công ở lần 3, không có request `REQUEST_SYNC_THREAD_MESSAGES` nào khác xen giữa cho thread khác; xác nhận thread đạt `SYNCED`/`PARTIAL` mà không cần người dùng bấm lại.

**Acceptance Scenarios**:

1. **Given** thread nhận `reason` thuộc nhóm lỗi tạm thời, **When** chưa vượt số lần retry tối đa, **Then** server tự lên lịch một `SYNC_THREAD_MESSAGES` mới sau khoảng backoff tăng dần.
2. **Given** một `REQUEST_SYNC_THREAD_MESSAGES` mới cho **thread khác** đến trong lúc đang chờ retry, **When** retry cũ đến hạn, **Then** retry cũ bị hủy — không được điều hướng tab về thread cũ.
3. **Given** `reason = 'error_screen'` (Facebook chặn nội dung — lỗi vĩnh viễn), **When** server nhận, **Then** KHÔNG tự động retry — giữ nguyên hành vi hiện tại (chờ người dùng).
4. **Given** đã hết số lần retry tối đa mà vẫn lỗi, **When** retry cuối cùng thất bại, **Then** thread giữ `FAILED` như hiện tại (không retry vô hạn).

---

### User Story 4 — "Đồng bộ lại hội thoại" phải luôn có tác dụng thật (P2)

Khi người dùng bấm nút "Đồng bộ lại hội thoại" trên một thread đang `PARTIAL` hoặc `FAILED`, hệ thống phải chạy một lượt đào sâu hơn (round-budget cao hơn `incremental`), không lặp lại đúng kết quả cũ.

**Independent Test**: Trên thread `PARTIAL`, bấm nút; xác nhận request gửi xuống extension có round-budget/mode khác với luồng mở thread bình thường của thread `SYNCED`.

**Acceptance Scenarios**:

1. **Given** thread đang `PARTIAL`/`FAILED`, **When** người dùng bấm "Đồng bộ lại hội thoại", **Then** request tới extension dùng round-budget đào sâu, không phải `incremental` 1 vòng.
2. **Given** thread đang `SYNCED` thật sự, **When** người dùng mở lại bình thường, **Then** vẫn chỉ chạy `incremental` 1 vòng như hiện nay — không tăng chi phí cho case đã ổn.

---

### User Story 5 — Checkpoint vẫn bền trên server, có kiểm thử xác nhận (P3)

Xác nhận bằng test tự động rằng cursor/trạng thái đồng bộ luôn đọc/ghi từ SQLite phía server trước mỗi lần dispatch, không có nhánh nào dùng state cục bộ của tab/extension làm nguồn sự thật — để nguyên tắc "restart không mất dữ liệu" của spec 003 không bị các thay đổi ở US1–US4 làm hỏng.

**Independent Test**: Restart giả lập tiến trình server giữa hai lần đồng bộ của cùng một thread; xác nhận lần sau vẫn đọc đúng `sync_cursor` cũ từ DB và tiếp tục đúng vị trí, kể cả khi thread đang ở trạng thái `PARTIAL` mới (không chỉ `SYNCED`/`LOCAL` như test cũ của spec 003).

**Acceptance Scenarios**:

1. **Given** server restart giữa chừng, **When** thread ở trạng thái `PARTIAL`, **Then** lần dispatch tiếp theo vẫn dùng đúng `sync_cursor` đã lưu, không crawl lại từ đầu.

### Edge Cases

- Hội thoại cực dài (hàng nghìn tin) không bao giờ thực sự chạm được điểm neo lịch sử cũ nhất trong giới hạn Messenger cho phép cuộn — chấp nhận `PARTIAL` kéo dài, tiếp tục đào sâu dần qua nhiều lần mở, không cần đạt `SYNCED` tuyệt đối.
- Người dùng đóng CRM/mất kết nối WebSocket giữa lúc đang retry — retry đang chờ phải tự hủy khi không còn socket/connection tương ứng.
- Nhiều thread của cùng một account đều `PARTIAL`/`FAILED` cùng lúc — retry của từng thread độc lập, không throttle chéo nhau ngoài cơ chế cooldown/in-flight đã có.
- `boundary_reached=false` nhưng thực ra đã hết tin thật (Facebook trả trang rỗng) — cần phân biệt "hết vòng do giới hạn" với "hết vòng do không còn gì để tải" (dựa vào `roundsWithoutIncrease` đã đạt ngưỡng dừng tự nhiên, không phải do chạm `maxRounds`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Extension MUST trả `boundary_reached` (đã tính sẵn ở `background.js:2515`) trong payload `THREAD_MESSAGES_SYNCED` gửi lên server, cùng với lý do dừng vòng cuộn (`max_rounds_hit` | `no_scroll_growth` | `boundary_reached`).
- **FR-002**: Server MUST set `sync_status = 'PARTIAL'` khi dừng vòng cuộn mà `boundary_reached = false` do `max_rounds_hit`, và giữ nguyên `sync_cursor` (đặc biệt `oldest_message_id`/`oldest_timestamp_ms`) để có thể tiếp tục lùi xa hơn.
- **FR-003**: Server MUST chỉ set `sync_status = 'SYNCED'` khi `boundary_reached = true` hoặc dừng do `no_scroll_growth` (đã thực sự hết nội dung để tải, không phải do hết ngân sách vòng).
- **FR-004**: Round-budget cho `loadOlderMessages` MUST được định nghĩa khớp đúng với tập mode thực tế mà server có thể gửi: `initial`, `incremental`, `deep_backfill` (mode mới, xem FR-005). Bỏ nhánh `'backfill'` không dùng tới hoặc đổi tên cho khớp.
- **FR-005**: Khi `REQUEST_SYNC_THREAD_MESSAGES` được gọi cho thread có `sync_status` hiện tại là `PARTIAL` hoặc `FAILED`, server MUST dispatch với `mode: 'deep_backfill'` (round-budget cao hơn `incremental`) thay vì mặc định `incremental` chỉ vì đã tồn tại `sync_cursor`.
- **FR-006**: Vòng lặp `loadOlderMessages` MUST không tính một vòng là "không tăng scrollHeight" (`roundsWithoutIncrease`) nếu tại vòng đó phát hiện spinner loading đang hiển thị — tránh dừng sớm khi Facebook đang tải chậm chứ chưa phải hết nội dung.
- **FR-007**: Khi nhận `THREAD_MESSAGES_SYNCED` với `reason` thuộc nhóm lỗi tạm thời (`marker_mismatch`, `sidebar_mismatch`, `no_rows`, `no_main_container`), server MUST tự lên lịch tối đa **3** lần retry với backoff tăng dần (vd 2s/6s/15s), MUST hủy retry đang chờ nếu có `REQUEST_SYNC_THREAD_MESSAGES` mới cho **thread khác** cùng account đến trước.
- **FR-008**: `reason = 'error_screen'` MUST KHÔNG được tự động retry (giữ nguyên hành vi hiện tại — lỗi vĩnh viễn cần người dùng can thiệp).
- **FR-009**: Sau khi hết số lần retry tối đa mà vẫn lỗi, thread MUST giữ `sync_status = 'FAILED'` như hiện tại (không retry vô hạn, không đổi hành vi hiển thị nút "Đồng bộ lại hội thoại").
- **FR-010**: UI (`MessageList.jsx` và luồng liên quan) MUST phân biệt hiển thị `LOCAL` (chưa từng đồng bộ — màn hình rỗng hiện tại) với `PARTIAL` (đã có một phần tin nhắn, đang lấy thêm — hiển thị tin đã có kèm chỉ báo "đang tải thêm lịch sử cũ hơn" thay vì màn hình rỗng).
- **FR-011**: Không thêm cột schema SQLite mới — mọi dữ liệu bổ sung (`boundary_reached`, lý do dừng) MUST nằm trong JSON `sync_cursor` đã có, giữ tương thích ngược với spec 003 (FR-001, Assumptions của spec 003).
- **FR-012**: Mọi ngưỡng/giới hạn mới (round-budget theo mode, số lần retry, backoff) MUST được log theo đúng convention diagnostics đã có (`[FB LazyLoad]`, `[WS]`, `[INBOX_SYNC_*]`) để chẩn đoán tiếp nếu vẫn còn thiếu dữ liệu.
- **FR-013**: Cơ chế checkpoint bền trên server (đọc/ghi `threads.sync_cursor`/`sync_status`/`sync_error` từ SQLite trước mỗi lần dispatch) của spec 003 MUST được giữ nguyên hành vi; các thay đổi ở FR-001–FR-010 chỉ mở rộng dữ liệu trong cursor, không đổi nguồn sự thật.

## Success Criteria

- **SC-001**: Với một thread test có > 200 tin nhắn, lần sync đầu tiên phải đạt số tin nhắn lấy được nhiều hơn baseline hiện tại (5 vòng cuộn) một cách đo được, hoặc kết thúc ở `PARTIAL` với cursor hợp lệ để tiếp tục — không bao giờ set `SYNCED` khi `boundary_reached=false` do hết vòng.
- **SC-002**: Thread `PARTIAL` được mở lại tối đa 3 lần liên tiếp (không cần biết khái niệm "đồng bộ lại") phải tự tiến triển tới `SYNCED` hoặc lấy thêm tin nhắn cũ hơn ở mỗi lần mở.
- **SC-003**: ≥ 2/3 lỗi transient tự phục hồi trong vòng 3 lần retry tự động, đo qua log `[INBOX_SYNC_MESSAGES_RESULT]` / trạng thái cuối cùng của thread, không cần thao tác tay.
- **SC-004**: Bấm "Đồng bộ lại hội thoại" trên thread `PARTIAL` luôn tăng số tin nhắn đã lưu so với trước khi bấm (trừ khi đã thực sự `boundary_reached=true`).
- **SC-005**: Không có regression: 5 lần mở liên tiếp một thread đã `SYNCED` thật (đã chạm boundary) vẫn tạo 0 tin nhắn mới và vẫn chỉ chạy 1 vòng `incremental` — giữ nguyên SC-001 của spec 003.
- **SC-006**: Restart server giữa hai lần sync của một thread `PARTIAL` không làm mất `sync_cursor`, tiếp tục đúng vị trí — mở rộng SC-003 của spec 003 sang trạng thái `PARTIAL`.

## Assumptions

- Cấu trúc DOM Facebook Messenger không đổi ngoài phần đã biết trong `background.js` hiện tại.
- Với một số thread cực dài, có thể không bao giờ chạm "đầu hội thoại" thật trong giới hạn Messenger cho phép cuộn liên tục — hệ thống chấp nhận `PARTIAL` kéo dài, tiếp tục đào sâu dần qua nhiều lần mở/nhiều lần bấm "đồng bộ lại", không bắt buộc đạt `SYNCED` tuyệt đối trong một phiên.
- Không mở rộng sang đồng bộ nền chủ động cho toàn bộ tài khoản/thread chưa từng mở (đó là phạm vi của spec 007 / việc nối `InboxSyncScheduler`, ngoài phạm vi lần này).
- Số vòng cuộn cụ thể cho từng mode (`initial`, `deep_backfill`) và số lần retry/backoff là tham số cấu hình được, giá trị đề xuất trong Requirements có thể tinh chỉnh ở giai đoạn implement dựa trên đo đạc thực tế.
