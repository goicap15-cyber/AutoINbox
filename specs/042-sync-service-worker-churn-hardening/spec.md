# Feature Specification: Sync Reliability Under Service-Worker Churn

**Feature Branch**: `042-sync-service-worker-churn-hardening`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Sau khi vá spec 041, log thực tế trên máy thật cho thấy nhiều thread vẫn fail sync (`no_rows`/`no_main_container`) kể cả khi retry. Điều tra cho thấy nguyên nhân là Chrome Manifest V3 service worker của extension bị tắt/khởi động lại liên tục, gây REGISTER_ACCOUNT/SYNC_THREADS dồn dập tranh chấp DOM với sync tin nhắn từng thread. Cần spec xử lý."

## Background / Root Cause Analysis

Điều tra trên log thật (phiên chạy `npm start` ngày 2026-08-19) và đọc code cho thấy đây là vấn đề kiến trúc, không phải lỗi logic đơn lẻ:

1. **Extension dùng Manifest V3 service worker (`manifest.json:28-30`)** — loại background này **không thường trực**: Chrome tự tắt nó sau khi rảnh (không có timer/event đang chờ) khoảng ~30 giây, và chạy lại toàn bộ `background.js` từ đầu khi có sự kiện mới. Codebase hiện **không có bất kỳ cơ chế keepalive nào** (`grep chrome.alarms` → không có kết quả).
2. **Mỗi lần restart xoá sạch state trong bộ nhớ**: `ws`, `user_id`, `fb_dtsg`, `pending_key`, `reconnectDelay`, `currentWsIndex`, `personalNavigationSequences` — toàn bộ là biến `let` cấp module (`background.js:4-10`), không có gì được persist ngoại trừ tab-role registry (đã vá ở spec trước đó, ghi trong `chrome.storage.session`).
3. **Content script tự "đánh thức" service worker mỗi 3 giây**: `content.js:771` — `extractFbTokensFromDOM(); setInterval(extractFbTokensFromDOM, 3000);` gửi `chrome.runtime.sendMessage({type:'FB_TOKENS_EXTRACTED', ...})` không điều kiện mỗi 3s. Vì content script sống trong tab (không bị SW-restart ảnh hưởng), nó liên tục gọi vào SW; nếu SW vừa chết, cuộc gọi này khởi động lại nó.
4. **So sánh token sai "dương tính giả" sau mỗi restart**: `background.js:183` so `newUserId !== user_id` — vì `user_id` vừa bị xoá về `null` sau restart, lần push token tiếp theo (tối đa 3s sau) luôn bị coi là "tokens mới" → tự động gửi lại `REGISTER_ACCOUNT` (`background.js:188`) dù không có gì thực sự thay đổi.
5. **Server không debounce REGISTER_ACCOUNT**: mỗi lần nhận `REGISTER_ACCOUNT`, `server.js:373-378` luôn lên lịch một `SYNC_THREADS` mới sau 1.5s — bất kể tài khoản đó vừa được đăng ký/sync giây trước.
6. **`SYNC_THREADS` quét lại toàn bộ sidebar trên cùng tab Messenger** đang được dùng chung cho việc sync tin nhắn từng thread (`handleSync100Threads()` trong `background.js`) — khi nó chạy đúng lúc `waitForThreadDomReady()` của một `SYNC_THREAD_MESSAGES` khác đang chờ DOM ổn định (timeout 8s), tab bị tranh chấp → `no_rows`/`no_main_container`.
7. **Chính codebase đã tự ghi nhận hiện tượng "REGISTER_ACCOUNT/SYNC_THREADS churn" từ trước** (comment tại `background.js:296-298`, viết cho spec tab-role-registry trước đó) nhưng chỉ vá triệu chứng phụ (tab-role phải đoán lại), chưa vá nguồn gốc.
8. **Phát hiện thêm, độc lập với chuỗi trên**: nút "Đồng bộ lại hội thoại" hiển thị khi một hội thoại rỗng (`MessageList.jsx`, dùng bởi FR-010 của spec 041) được `App.jsx:968` nối vào sự kiện **`REQUEST_SYNC_THREADS`** (đồng bộ lại toàn bộ **sidebar** của account) chứ **không phải `REQUEST_SYNC_THREAD_MESSAGES`** (đồng bộ tin nhắn của **chính hội thoại đang mở**). Xác nhận bằng `git diff HEAD -- src/client/App.jsx` không có gì thay đổi — đây là bug có từ trước, không phải do spec 041. Hệ quả: bấm nút này **không bao giờ** lấy thêm được tin nhắn cho hội thoại đang xem, dù người dùng bấm bao nhiêu lần (đúng như log thật cho thấy — nhiều dòng `Nhận yêu cầu đồng bộ lại hội thoại cho account` liên tiếp mà thread vẫn rỗng).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Giảm tần suất service worker bị khởi động lại (P1)

Service worker phải được giữ "sống" chủ động thay vì để Chrome tự ý tắt sau ~30 giây rảnh, để giảm tần suất mất state và giảm số lần `REGISTER_ACCOUNT` dồn dập.

**Why this priority**: Đây là nguyên nhân gốc của toàn bộ chuỗi sự cố — sửa được sẽ giảm mọi triệu chứng phụ mà không cần vá từng điểm va chạm riêng lẻ.

**Independent Test**: Cài extension đã vá, mở DevTools → `chrome://extensions` → service worker log; để yên tab Facebook 5 phút không tương tác; đếm số lần service worker bị "Inactive" rồi "Active" lại trong log — phải giảm rõ rệt so với trước (baseline: quan sát log server thấy `REGISTER_ACCOUNT` lặp lại cỡ vài chục lần trong vài phút).

**Acceptance Scenarios**:

1. **Given** extension đã cài, **When** không có tương tác nào trong 5 phút, **Then** số lần `REGISTER_ACCOUNT` nhận được ở server trong khoảng đó giảm so với baseline chưa vá (đo qua log).
2. **Given** service worker vừa được giữ sống bằng alarm, **When** alarm fire, **Then** không có tác dụng phụ (không tự ý mở tab, không tự ý gửi lệnh sync nào ngoài việc giữ tiến trình chạy).

---

### User Story 2 — Server không tự ý quét lại sidebar nếu vừa quét gần đây (P1)

Kể cả khi restart vẫn còn xảy ra (do nguyên nhân khác ngoài tầm kiểm soát, ví dụ Chrome siết chặt hơn ở phiên bản sau), server không được phép dispatch `SYNC_THREADS` dồn dập gây tranh chấp DOM với sync tin nhắn đang chạy.

**Why this priority**: Đây là lưới an toàn thứ hai (defense-in-depth) — hoạt động độc lập với US1, vẫn có tác dụng nếu US1 không loại bỏ được 100% restart.

**Independent Test**: Giả lập gửi 5 `REGISTER_ACCOUNT` liên tiếp trong 2 giây cho cùng account; đếm số `SYNC_THREADS` thực sự được gửi xuống extension — phải là 1, không phải 5.

**Acceptance Scenarios**:

1. **Given** một `SYNC_THREADS` vừa được dispatch cho account X trong vòng N giây gần đây, **When** server nhận thêm `REGISTER_ACCOUNT` cho X, **Then** không dispatch thêm `SYNC_THREADS` mới (nhưng vẫn ACK đăng ký bình thường để rebind kết nối).
2. **Given** đã quá N giây kể từ lần `SYNC_THREADS` gần nhất, **When** nhận `REGISTER_ACCOUNT`, **Then** dispatch `SYNC_THREADS` bình thường như hiện tại (không hồi quy hành vi cũ).

---

### User Story 3 — Nút "Đồng bộ lại hội thoại" phải đồng bộ đúng hội thoại đang mở (P1)

Bấm nút này trên một hội thoại rỗng/thiếu dữ liệu phải gửi yêu cầu lấy tin nhắn của **chính hội thoại đó**, không phải chỉ làm mới danh sách sidebar.

**Why this priority**: Đây là điểm chạm trực tiếp nhất với báo cáo gốc của người dùng ("bấm đồng bộ lại mà vẫn không thấy gì") — sửa xong US1/US2 mà không sửa cái này thì nút bấm vẫn vô dụng.

**Independent Test**: Trên một thread đang rỗng, bấm nút; xác nhận server log ra `[Socket.io] Yêu cầu sync tin nhắn cho thread <id đúng>` (không phải chỉ `Nhận yêu cầu đồng bộ lại hội thoại cho account`).

**Acceptance Scenarios**:

1. **Given** hội thoại đang active bị rỗng/`PARTIAL`, **When** bấm "Đồng bộ lại hội thoại", **Then** client emit `REQUEST_SYNC_THREAD_MESSAGES` với đúng `thread_id` của hội thoại đang mở (tái dùng logic của `requestThreadNavigation`, theo đúng mode `initial`/`deep_backfill` mà spec 041 đã thiết lập).
2. **Given** bấm nút, **When** server nhận, **Then** hành vi sidebar-refresh cũ (`REQUEST_SYNC_THREADS`) vẫn có thể chạy kèm (không bắt buộc bỏ), miễn là tin nhắn của hội thoại đang mở cũng được yêu cầu.

### Edge Cases

- Alarm keepalive fire đúng lúc extension đang xử lý một thao tác nặng (đang gõ tin nhắn, đang crawl lịch sử) — không được làm gián đoạn thao tác đó.
- Nhiều tab Facebook cùng mở cho cùng một account — mỗi tab có content script riêng cùng gửi token mỗi 3s; cooldown ở US2 phải tính theo account, không theo tab, để không bị vô hiệu hoá bởi nhiều nguồn gửi.
- Người dùng bấm "Đồng bộ lại hội thoại" liên tục nhiều lần — phải tôn trọng cooldown/in-flight đã có ở `REQUEST_SYNC_THREAD_MESSAGES` (không đổi), không tạo thêm luồng song song.
- Chrome có thể vẫn tắt SW dù có alarm trong một số trường hợp hiếm (theo tài liệu Chrome, alarm chỉ đảm bảo SW được **đánh thức** đúng lịch, không đảm bảo **không bao giờ** bị tắt giữa hai lần alarm) — US2 vẫn phải hoạt động độc lập, không phụ thuộc US1 thành công tuyệt đối.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Extension MUST đăng ký một `chrome.alarms` lặp lại với chu kỳ ngắn hơn ngưỡng idle-kill của Chrome (đề xuất 20 giây) để giữ service worker được đánh thức đều đặn, giảm tần suất bị Chrome tự tắt.
- **FR-002**: Alarm handler MUST là no-op an toàn (không gửi lệnh sync, không mở tab, không có tác dụng phụ nghiệp vụ) — chỉ tồn tại để giữ tiến trình JS chạy.
- **FR-003**: Server MUST theo dõi thời điểm `SYNC_THREADS` gần nhất đã dispatch cho mỗi account (`lastSidebarSyncAt` theo account_id).
- **FR-004**: Server MUST bỏ qua việc dispatch `SYNC_THREADS` tự động sau `REGISTER_ACCOUNT` nếu đã dispatch cho account đó trong vòng cooldown (đề xuất 15 giây) — nhưng vẫn phải hoàn tất toàn bộ phần còn lại của REGISTER_ACCOUNT (upsert DB, ACK, cập nhật `extensionConnections` map để rebind kết nối WS mới) như hiện tại, không được bỏ sót phần rebind (đây là phần thực sự cần thiết mỗi lần WS mới kết nối).
- **FR-005**: Cooldown ở FR-004 KHÔNG được áp dụng cho `REQUEST_SYNC_THREADS` do người dùng bấm tay từ CRM UI (`socket.on('REQUEST_SYNC_THREADS', ...)`) — chỉ áp dụng cho nhánh tự động sau `REGISTER_ACCOUNT`.
- **FR-006**: Nút "Đồng bộ lại hội thoại" (`MessageList.jsx`, xử lý trong `App.jsx`) MUST gửi `REQUEST_SYNC_THREAD_MESSAGES` cho đúng `thread_id`/`account_id`/`thread_url`/`page_id` của hội thoại đang active — tái sử dụng cùng logic với `requestThreadNavigation()` thay vì gọi thẳng `REQUEST_SYNC_THREADS`.
- **FR-007**: Không bắt buộc loại bỏ hoàn toàn `REQUEST_SYNC_THREADS` khỏi nút này nếu giữ cả hai không gây hại — nhưng bắt buộc phải có `REQUEST_SYNC_THREAD_MESSAGES` cho đúng thread đang mở (đây là phần đang thiếu).
- **FR-008**: Không thêm cột schema SQLite mới; `lastSidebarSyncAt` ở FR-003 có thể là state trong bộ nhớ server (chấp nhận reset khi server restart, giống các cooldown khác đã có trong codebase như `domReplaySuppressUntil`).
- **FR-009**: Mọi thay đổi log MUST theo đúng convention đã có (`[INBOX_SYNC_*]`, `[WS]`, `[FB Engine]`) để chẩn đoán tiếp nếu vẫn còn churn.

## Success Criteria

- **SC-001**: Trong một phiên sử dụng thật kéo dài ≥ 5 phút, số lần `REGISTER_ACCOUNT` nhận được ở server giảm đáng kể so với baseline quan sát ngày 2026-08-19 (baseline: hàng chục lần trong vài phút).
- **SC-002**: Với 5 `REGISTER_ACCOUNT` liên tiếp trong 2 giây cho cùng account, chỉ có tối đa 1 `SYNC_THREADS` thực sự được gửi xuống extension.
- **SC-003**: Bấm "Đồng bộ lại hội thoại" trên thread rỗng → log server phải xuất hiện `Yêu cầu sync tin nhắn cho thread <đúng id>` ngay sau đó.
- **SC-004**: Không regression: REGISTER_ACCOUNT vẫn luôn rebind đúng kết nối WS mới vào `extensionConnections` (test lại kịch bản của spec 025 "WebSocket close identity check" không bị vỡ).
- **SC-005**: Không regression: hành vi sync tin nhắn theo click/60s-fallback của spec 041 không đổi.

## Assumptions

- `chrome.alarms` là API chính thức được Chrome khuyến nghị để giảm (không đảm bảo loại bỏ hoàn toàn) tần suất service worker bị tắt — đây là giảm thiểu (mitigation), không phải giải pháp tuyệt đối, nên US2 (server-side cooldown) là bắt buộc chạy song song, không phải tuỳ chọn.
- Cooldown 15 giây ở FR-004 và chu kỳ alarm 20 giây ở FR-001 là giá trị đề xuất, có thể tinh chỉnh ở bước implement dựa trên đo đạc thực tế (log `[INBOX_SYNC_*]`).
- Không nằm trong phạm vi: viết lại toàn bộ kiến trúc kết nối WS, chuyển sang non-persistent background page (không khả thi với Manifest V3), hay nối lại `InboxSyncScheduler.js` (vẫn ngoài phạm vi như spec 041 đã ghi).
