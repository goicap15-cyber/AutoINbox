# Feature Specification: History Crawler `role="article"` Support

**Feature Branch**: `043-history-crawler-article-role-support`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Xác nhận qua DevTools thật: tin nhắn có thật trên Facebook nhưng history crawler (background.js) trả về count=0. Console log cho thấy tin nhắn nằm trong `role='article'` bên trong `role='log'`, không phải `role='row'`. `content.js` (bắt tin nhắn realtime) đã tự vá việc này từ 2026-08-13 (`content.js:401-407`) và dùng `[data-message-id]` làm ID, nhưng `handleSyncThreadMessages` trong `background.js` (crawler lịch sử) chưa từng được vá theo. Cần spec xử lý."

## Background / Root Cause Analysis (đã xác minh bằng DOM thật, không suy đoán)

Bằng chứng thu thập trực tiếp qua Chrome DevTools trên tài khoản thật của người dùng (2026-08-19), thread `636212466232285` ("Người dùng Facebook"):

1. Tin nhắn thật tồn tại trên Facebook (ảnh chụp Messenger thật) nhưng CRM báo `THREAD_MESSAGES_SYNCED ... count=0` → `SYNCED (stop_reason=no_scroll_growth)` — không lỗi, chỉ đơn giản là không tìm thấy gì.
2. Console log (`el.closest`/ancestor walk từ bong bóng tin nhắn thật) cho thấy: phần tử chứa tin nhắn có `role: 'article'`, nằm trong container `role: 'log'` (`ariaLabel: 'Tin nhắn trong cuộc trò chuyện với Người dùng Facebook'`), nằm trong `role: 'main'`. **Không có bất kỳ phần tử tổ tiên nào mang `role="row"`.**
3. `aria-label` của phần tử `article` này là `"Lúc 14:38 29 Tháng 3, 2025, Người dùng Facebook: <nội dung tin nhắn>"` — khác hoàn toàn format `"Tin nhắn do X gửi lúc Y"` / `"Message sent by X at Y"` mà `background.js` đang tìm.
4. `content.js:401-407` (luồng bắt tin nhắn real-time, dùng MutationObserver) đã tự ghi nhận và vá đúng vấn đề này:
   ```js
   // Facebook đã chuyển message container từ role="row" sang role="article"
   // (xác nhận qua live DOM inspection 2026-08-13) ...
   const messageRow = node.closest?.('div[role="article"]') || node.closest?.('div[role="row"]') || node;
   ```
   và dùng `[data-message-id]` làm nguồn ID chính (`content.js:781-782`, cũng dùng lại ở `page_content.js`), **không phải** `[data-id]`/`[id^="mid."]`.
5. `background.js`'s `handleSyncThreadMessages()` (crawler lịch sử, dùng cho mọi `SYNC_THREAD_MESSAGES`/`deep_backfill`/`incremental`) **chưa từng được vá theo** — vẫn chỉ tìm `div[role="row"]` ở đúng 4 chỗ (dòng ~2184, ~2232, ~2283, ~2425) và tìm ID qua `[data-id], [id^="mid."]` (dòng ~2438) — hai attribute mà bằng chứng thực tế cho thấy không còn được Facebook dùng cho message container hiện tại.

**Hệ quả**: Bất kỳ thread nào Facebook render bằng cấu trúc `role="article"` (có vẻ đang trở thành cấu trúc phổ biến/mới) sẽ **luôn** trả về 0 tin nhắn từ crawler lịch sử, bất kể round-budget (spec 041), retry (spec 041), hay cooldown (spec 042) — ba spec trước hoàn toàn không chạm tới nguyên nhân này vì chúng nằm ở tầng khác (điều phối/trạng thái đồng bộ), không phải tầng chọn phần tử DOM để đọc.

**Vấn đề phụ phát sinh (không được suy đoán, cần quyết định rõ trong Requirements)**: `aria-label` mới không cho biết trực tiếp tin nhắn là gửi đi hay nhận vào theo cùng cách cũ (`"Tin nhắn do Bạn gửi lúc..."` → chắc chắn `isOutgoing=true`). Format mới `"Lúc <giờ> <ngày>, <tên>: <nội dung>"` chỉ cho một cái tên — cần so khớp với `contact_name` của thread (đã biết ở `handleSyncThreadMessages`'s tham số, nhưng hiện **chưa được truyền vào** DOM script qua `args`) để suy ra chiều tin nhắn. Sai chiều ở đây có rủi ro nghiệp vụ thật (vd: AutoReplyEngine/AIMediator có thể tưởng tin nhắn quảng cáo do chính tài khoản gửi là câu hỏi của khách rồi tự trả lời) — **không được đoán bừa khi không chắc**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Crawler nhận diện được message container `role="article"` (P1)

Crawler lịch sử phải tìm thấy tin nhắn nằm trong `div[role="article"]`, không chỉ `div[role="row"]`.

**Independent Test**: Chạy sync lịch sử (bất kỳ mode nào) trên thread `636212466232285` (hoặc thread tương tự có cấu trúc `role="article"`) — `THREAD_MESSAGES_SYNCED` phải trả về `count >= 1`, không còn `count=0` một cách âm thầm.

**Acceptance Scenarios**:

1. **Given** thread có tin nhắn render dưới `role="article"`, **When** crawler chạy (mọi mode), **Then** tin nhắn đó xuất hiện trong kết quả trả về.
2. **Given** thread có tin nhắn render dưới `role="row"` (cấu trúc cũ, các thread đã hoạt động tốt từ trước), **When** crawler chạy, **Then** hành vi không đổi — không regression.

---

### User Story 2 — Nhận diện ID tin nhắn qua `data-message-id` (P1)

Crawler phải ưu tiên `[data-message-id]` làm nguồn ID gốc, khớp với luồng real-time đã dùng, để cùng một tin nhắn từ 2 nguồn (crawler lịch sử + real-time observer) hội tụ về đúng 1 dòng trong DB (nguyên tắc dedup của spec 003 không được vỡ).

**Independent Test**: Một tin nhắn được cả real-time observer bắt được (khi tab đang mở) VÀ crawler lịch sử quét lại (khi mở thread) — kiểm tra trong DB chỉ có 1 row, `fb_message_id` giống nhau giữa 2 nguồn.

**Acceptance Scenarios**:

1. **Given** message container có `data-message-id`, **When** crawler đọc, **Then** `fb_message_id` dùng đúng giá trị này (không rơi về fallback hash).
2. **Given** message container có `data-id`/`id="mid.xxx"` (cấu trúc cũ) nhưng không có `data-message-id`, **When** crawler đọc, **Then** vẫn nhận diện được qua đường cũ — không regression.

---

### User Story 3 — Xác định đúng chiều tin nhắn (in/out) cho format aria-label mới, KHÔNG đoán khi không chắc (P1)

Khi gặp aria-label dạng `"Lúc <giờ> <ngày>, <tên>: <nội dung>"`, crawler phải so khớp `<tên>` với `contact_name` của thread để suy ra chiều, và phải có quy tắc rõ ràng khi không so khớp được — không được mặc định sai một cách im lặng.

**Why this priority**: Sai chiều tin nhắn có thể khiến AutoReplyEngine/AIMediator phản hồi nhầm vào chính tin quảng cáo do tài khoản tự gửi, hoặc làm sai lệch dữ liệu CRM (hiển thị tin của mình như tin của khách).

**Independent Test**: Với thread có `contact_name = "Người dùng Facebook"` và một tin nhắn có aria-label `"Lúc 14:38 29 Tháng 3, 2025, Người dùng Facebook: ..."` mà thực tế tin đó do tài khoản CRM tự gửi (outgoing) — xác nhận quy tắc mới không gán nhầm `is_outgoing=0`.

**Acceptance Scenarios**:

1. **Given** aria-label mới có tên KHÁC với `contact_name` của thread (hoặc là "Bạn"), **When** crawler xử lý, **Then** coi là outgoing.
2. **Given** aria-label mới có tên TRÙNG với `contact_name` của thread, **When** crawler xử lý, **Then** coi là incoming.
3. **Given** không thể xác định `contact_name` (null) VÀ không match được bất kỳ pattern cũ nào, **When** crawler xử lý, **Then** PHẢI bỏ qua tin nhắn đó (không lưu với chiều đoán bừa) và log rõ lý do — chấp nhận thiếu sót còn hơn sai dữ liệu.

### Edge Cases

- Cùng một `role="article"` chứa nhiều bubble con (multi-bubble message giống code hiện tại đã xử lý cho `role="row"`) — logic tách nhiều `leafBubbles` trong 1 row hiện có phải áp dụng y hệt cho `role="article"`.
- Thread có avatar/tên hiển thị dạng biệt danh khác `contact_name` lưu trong DB (đã đổi tên hiển thị) — so khớp tên nên chấp nhận sai khác nhỏ (khoảng trắng, hoa/thường) nhưng không cần xử lý fuzzy phức tạp ở bản vá này.
- Thread Business Suite (Page messenger) có thể có cấu trúc khác thread cá nhân — phạm vi bản vá này chỉ xác nhận cho luồng `handleSyncThreadMessages` dùng chung cho cả hai; nếu Business Suite dùng cấu trúc khác nữa thì cần điều tra riêng (ghi nhận, không giả định).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Cả 4 vị trí dùng `div[role="row"]` trong `handleSyncThreadMessages()` (DOM-ready check, boundary-scroll check, final marker check, danh sách row để parse) MUST được mở rộng thành `div[role="row"], div[role="article"]` (giữ nguyên phần `div[data-scope="messages_table"] div[dir="auto"]` đã có ở 3/4 vị trí).
- **FR-002**: Việc tìm ID gốc của message (`nativeIdEl`) MUST ưu tiên `[data-message-id]` trước, fallback về `[data-id], [id^="mid."]` nếu không có — khớp đúng thứ tự ưu tiên mà `content.js`/`page_content.js` đã dùng.
- **FR-003**: `handleSyncThreadMessages()` MUST truyền `contact_name` vào `args` của `chrome.scripting.executeScript` (hiện chưa truyền) để DOM script có thể so khớp tên trong aria-label mới.
- **FR-004**: Khi `effectiveLabel` không khớp pattern cũ (`Tin nhắn do .+ gửi lúc|Message sent by`) nhưng khớp pattern mới `/^Lúc\s+.+?,\s*(.+?):\s*/i` (hoặc tương đương), crawler MUST trích tên người gửi từ pattern mới và so khớp (không phân biệt hoa/thường, trim khoảng trắng) với `contact_name` được truyền vào để xác định `isOutgoing`.
- **FR-005**: Nếu tên trích được TRÙNG `contact_name` → `isOutgoing=false`, `senderName=<tên đó>`. Nếu KHÁC → `isOutgoing=true`, `senderName='Bạn'`.
- **FR-006**: Nếu không trích được tên từ pattern mới (regex không khớp) VÀ không khớp bất kỳ pattern cũ nào (`hasMessageLabel` cũ cũng false) VÀ không có `contact_name` để so sánh, message đó MUST bị bỏ qua (không thêm vào mảng `messages`) thay vì mặc định `isOutgoing=false` — tránh gán sai chiều một cách im lặng (FR-006 áp dụng khi hoàn toàn không có cơ sở nào để quyết định, không áp dụng cho case FR-004/FR-005 đã xác định được).
- **FR-007**: Không đổi bất kỳ pattern/selector nào trong `content.js`/`page_content.js` (đã đúng, không thuộc phạm vi vá).
- **FR-008**: Không thêm cột schema mới; không đổi format `fb_message_id`/`sync_cursor` đã có.
- **FR-009**: Log rõ khi một message bị bỏ qua theo FR-006, theo convention `[FB Engine]` đã có, để dễ phát hiện nếu case này xảy ra nhiều (dấu hiệu cần điều tra thêm).

## Success Criteria

- **SC-001**: Sync lại thread `636212466232285` → `THREAD_MESSAGES_SYNCED` trả về `count >= 1`, tin nhắn xuất hiện trong CRM.
- **SC-002**: Tin nhắn từ SC-001 được lưu với `is_outgoing=1` (đúng, vì đây là tin quảng cáo do tài khoản tự gửi) — không bị gán nhầm thành tin khách.
- **SC-003**: Không regression: 5 thread đã `SYNCED` đúng từ trước (cấu trúc `role="row"` cũ) khi mở lại vẫn cho kết quả y hệt, không tăng/giảm số tin nhắn bất thường.
- **SC-004**: `npm run test:persistence` không regression.

## Assumptions

- Facebook có thể đang chuyển dần toàn bộ Messenger sang cấu trúc `role="article"`; bản vá này hỗ trợ cả hai cấu trúc song song (không giả định cấu trúc cũ biến mất hoàn toàn) để an toàn.
- Việc so khớp tên (FR-004/005) là heuristic tốt nhất có thể suy ra được từ dữ liệu đã có (contact_name), chấp nhận có thể sai trong trường hợp hiếm (tên hiển thị đổi khác hẳn `contact_name` lưu trong DB) — ưu tiên "bỏ qua khi không chắc" (FR-006) hơn "đoán sai".
- Không mở rộng sang sửa `AutoReplyEngine`/`AIMediator` hay bất kỳ logic nghiệp vụ nào dùng `is_outgoing` — chỉ đảm bảo giá trị `is_outgoing` được tính đúng tại nguồn.
