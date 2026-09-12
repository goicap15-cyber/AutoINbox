# Feature Specification: Chuẩn Hóa Thứ Tự Tin Nhắn Fanpage, Phân Tách Thời Gian Hiển Thị & Chặn Rác Toàn Diện

**Feature Branch**: `054-page-message-chronology-and-noise-guard`

**Created**: 2026-09-10

**Status**: Ready for Plan (Đã tích hợp đầy đủ các chuẩn hóa contract production, phân định generation/scan_id, state machine timeout và boundary evidence)

**Input**: Chuẩn hóa luồng đồng bộ tin nhắn Fanpage (Meta Business Suite), hợp nhất 2 pipeline (loại bỏ bắn lẻ `NEW_PAGE_MESSAGE_FROM_DOM` gán `max + 1`, chuyển sang Batch Sync), phân tách triệt để nguồn chân lý thứ tự (`sequence_order`) khỏi thời gian hiển thị (`timestamp_ms`), bảo vệ contract production (`media_type: 'voice'`, `direction_confidence: 'high'`), xử lý race condition Baseline vs Realtime bằng máy trạng thái có timeout/retry, và thiết lập script dọn rác dữ liệu an toàn có `--dry-run`.

---

## 1. User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem Lịch Sử Chat Fanpage Đúng Thứ Tự Thời Gian (Priority: P1)

Là nhân viên trực chat CRM, khi tôi mở một cuộc trò chuyện Fanpage và cuộn lên để xem tin nhắn cũ hơn, toàn bộ tin nhắn từ trước tới nay phải hiển thị đúng theo trật tự thời gian từ trên xuống dưới (tin cũ ở trên, tin mới ở dưới), tuyệt đối không bị đảo ngược, không bị nhảy lộn xộn xuống đáy chat, và các tin nhắn cũ vừa nạp không được làm sai lệch vị trí của thread trên danh sách sidebar.

**Why this priority**: Đây là chức năng cốt lõi của CRM. Nếu tin nhắn bị đảo lộn, nhân viên sẽ đọc sai tiến trình trao đổi với khách hàng, gây ra nhầm lẫn nghiêm trọng trong giao dịch.

**Independent Test**:
- Mở một cuộc hội thoại Fanpage có sẵn tin nhắn.
- Cuộn lên đầu khung chat để kích hoạt tải lịch sử cũ.
- Kiểm tra danh sách tin nhắn: các tin cũ vừa được nạp phải nằm ở trên cùng, các tin mới hơn giữ nguyên vị trí ở dưới, `sequence_order` liên tục từ `1..N`.
- Kiểm tra sidebar: thứ tự vị trí của hội thoại và số lượng tin chưa đọc không bị thay đổi bất thường do việc nạp lịch sử cũ.

**Acceptance Scenarios**:
1. **Given** một thread Fanpage có 20 tin nhắn đang hiển thị trên UI, **When** người dùng cuộn lên để nạp thêm 15 tin nhắn cũ hơn từ Business Suite có đủ bằng chứng biên (boundary/anchor), **Then** 15 tin cũ được chèn lên phía trên 20 tin hiện tại, không có tin cũ nào bị rớt xuống dưới cùng, và `unread_count` của thread không bị tăng lên.
2. **Given** 2 tin nhắn liên tiếp trong cùng một phút (không có timestamp chi tiết đến giây), **When** hệ thống trích xuất từ DOM, **Then** thứ tự vị trí tương đối trong DOM (`dom_order`) được bảo toàn tuyệt đối thông qua `sequence_order`.
3. **Given** 2 tin nhắn có cùng nội dung (ví dụ: khách gửi liên tiếp "alo"), **When** người dùng cuộn qua nhiều viewport khác nhau, **Then** hệ thống giữ nguyên cả 2 tin nhắn độc lập, không tự động gộp nhầm hoặc làm mất tin.
4. **Given** một batch cuộn lịch sử cũ không có anchor trùng và không có bằng chứng biên rõ ràng, **When** gửi lên backend, **Then** backend từ chối merge đoán mò, đưa vào trạng thái chờ xác thực (quarantine) và yêu cầu client quét lại an toàn.

---

### User Story 2 - Loại Bỏ Hoàn Toàn Thread Rác và Nội Dung Giao Diện Facebook (Priority: P1)

Là quản trị viên hệ thống, tôi muốn CRM không bao giờ tự ý tạo các thread rác như `UNKNOWN_THREAD` hoặc lưu các đoạn text menu của Meta Business Suite ("Quảng cáo", "Cài đặt", "Tất cả tin nhắn"...) thành tin nhắn của khách hàng.

**Why this priority**: Dữ liệu rác làm ô nhiễm cơ sở dữ liệu, sai lệch báo cáo số lượng khách hàng, và gây lỗi cho các pipeline đồng bộ tiếp theo.

**Independent Test**:
- Mở một tab Facebook Business Suite ở trang tổng quan hoặc khi khung chat chưa load xong.
- Kiểm tra database: không có bất kỳ record nào được tạo với `thread_id = 'UNKNOWN_THREAD'` hoặc `content` là các nhãn menu giao diện.

**Acceptance Scenarios**:
1. **Given** tab Business Suite đang tải hoặc đang ở màn hình chưa chọn hội thoại cụ thể, **When** hàm trích xuất không tìm thấy Thread ID hợp lệ, **Then** hàm trả về `null` và dừng toàn bộ tiến trình quét, không gửi bất kỳ message nào về backend.
2. **Given** một payload cố tình gửi `thread_id: "UNKNOWN_THREAD"` hoặc `thread_id: "unknown_dom"`, **When** đến backend API/Socket, **Then** backend từ chối xử lý và ghi log cảnh báo, không ghi vào database.

---

### User Story 3 - Hiển Thị Đúng Tên Khách Hàng, Không Bị Lặp Chuỗi Giao Diện (Priority: P2)

Là nhân viên trực chat, tôi muốn tên khách hàng trên danh sách hội thoại và tiêu đề chat hiển thị chính xác tên thật của khách (hoặc "Khách hàng"), không bao giờ bị dính chuỗi breadcrumb lặp lại như `"Tất cả tin nhắnTất cả tin nhắnTất cả tin nhắn"`.

**Why this priority**: Tránh làm xấu giao diện người dùng, tăng tính chuyên nghiệp và giúp nhân viên nhận diện đúng khách hàng.

**Independent Test**:
- Mở cuộc trò chuyện Fanpage mà trên giao diện Facebook có breadcrumb "Tất cả tin nhắn".
- Kiểm tra tên hiển thị trên CRM: hiển thị đúng tên khách hàng; nếu không lấy được tên thì hiển thị fallback chuẩn ("Khách hàng"), tuyệt đối không chứa cụm `"Tất cả tin nhắn"`.

**Acceptance Scenarios**:
1. **Given** phần tử header Facebook chứa các thẻ span lồng nhau tạo chuỗi `"Tất cả tin nhắnTất cả tin nhắn"`, **When** bộ trích xuất đọc tên khách hàng, **Then** bộ lọc loại bỏ hoàn toàn các chuỗi lặp này.
2. **Given** dữ liệu tên đi qua backend, **When** lưu vào bảng `threads`, **Then** backend kiểm tra lớp bảo vệ thứ 2 để đảm bảo tên đã được chuẩn hóa Unicode và loại trừ nhãn hệ thống trước khi ghi vào CSDL.

---

### User Story 4 - Nâng Cấp Thời Gian Hiển Thị Minh Bạch, Không Đánh Lừa Người Dùng Bằng `created_at` (Priority: P2)

Là nhân viên tư vấn, khi xem một tin nhắn, nếu tin nhắn đó có mốc thời gian gửi thực tế từ Facebook thì tôi muốn thấy giờ đó; nếu tin nhắn không có giờ thì hệ thống phải ẩn giờ hoặc ghi "Không rõ thời gian", tuyệt đối KHÔNG lấy thời điểm CRM nạp dữ liệu (`created_at`) để hiển thị thành giờ gửi tin nhắn của khách hàng.

**Why this priority**: Nhân viên cần biết chính xác khách nhắn lúc nào (ví dụ khách nhắn từ đêm hôm trước hay vừa nhắn), tránh hiểu lầm rằng khách vừa mới gửi chỉ vì CRM vừa mới quét vào DB.

**Independent Test**:
- Nạp một tin nhắn lịch sử cũ không có timestamp hiển thị từ Facebook (`timestamp_ms = 0`, `timestamp_source = 'unknown'`).
- Kiểm tra UI: bong bóng chat không hiển thị giờ giả dựa trên `created_at`.
- Khi rê chuột hoặc Facebook render thêm `aria-label`/tooltip chứa giờ thật, hệ thống tự động cập nhật giờ thật lên UI mà không làm thay đổi vị trí của tin nhắn trong danh sách.

**Acceptance Scenarios**:
1. **Given** một tin nhắn có `timestamp_ms = 0` và `timestamp_source = 'unknown'`, **When** hiển thị trên `MessageBubble` và `MessageList`, **Then** UI ẩn mốc giờ hoặc hiển thị "Không rõ thời gian", không dùng `created_at` để phân nhóm ngày hay làm giờ gửi.
2. **Given** một tin nhắn đang lưu với `timestamp_source = 'dom_order'`, **When** lượt quét mới bắt được `facebook_label` (chứa ngày giờ cụ thể), **Then** hệ thống nâng cấp `timestamp_ms` và `timestamp_source`, giữ nguyên `created_at` ban đầu và giữ nguyên `sequence_order`.

---

## 2. Edge Cases & Xử Lý Tình Huống

1. **Cuộn trang nhanh & Xử lý khi không có Anchor (Boundary Evidence Requirement)**:
   - Khi người dùng cuộn nhanh qua vùng trống khiến batch không có tin nào trùng với DB (mất anchor):
     - **Không được merge đoán mò**. Phải kiểm tra **bằng chứng biên (boundary evidence)**:
       - Có cursor chứa `previous_oldest_message_id`.
       - Hoặc viewport có phần tử overlap / biên trên xác thực.
       - Hoặc crawler extension xác nhận vừa cuộn lên phía trên và DOM đã ổn định.
     - Nếu CÓ bằng chứng biên hợp lệ: prepend toàn bộ batch theo `dom_order` lên trước tin nhỏ nhất hiện tại, sau đó renumber toàn bộ `sequence_order` thành `1..N`.
     - Nếu KHÔNG CÓ anchor lẫn bằng chứng biên: đưa batch vào trạng thái cách ly (`quarantine_pending`), không ghi đè sequence và yêu cầu extension quét lại với bước nhảy cuộn nhỏ hơn.
2. **Máy trạng thái Baseline vs Realtime có Timeout & Retry Path**:
   - Trạng thái vòng đời phiên quét: `UNINITIALIZED -> BASELINING -> READY`.
   - Bổ sung nhánh lỗi: `BASELINING -> FAILED / TIMEOUT (sau 10s) -> RETRY (kèm generation mới)`.
   - Quy định an toàn buffer:
     - Trong lúc `BASELINING`, mọi sự kiện realtime delta được giữ trong `realtime_buffer` (tối đa 100 tin hoặc 30 giây).
     - Khi baseline hoàn tất: đối chiếu buffer theo ID/fingerprint; tin nào đã có thì bỏ qua, tin mới thì append vào đuôi.
     - Khi baseline thất bại hoặc timeout: **tuyệt đối không làm mất tin realtime trong buffer**; các tin này được chuyển tiếp sang `generation` mới hoặc giải phóng an toàn vào luồng realtime dự phòng.
   - Chuyển thread, reload tab hoặc đổi Page: reset ngay về `UNINITIALIZED` và tạo `generation` mới.
3. **Phân biệt `generation`, `scan_id`, và `batch_sequence`**:
   - `generation`: Số nguyên tăng dần đại diện cho một phiên mở thread/Page. Khi có `generation` mới, các batch thuộc `generation` cũ hơn bị hủy bỏ (stale-drop).
   - `scan_id`: UUID duy nhất của từng batch gửi đi, dùng làm khóa chống xử lý lặp (idempotency key). Nếu nhận lại `scan_id` đã xử lý thì bỏ qua ngay.
   - `batch_sequence`: Số thứ tự của batch trong cùng một `generation`, giúp sắp hàng và serialize tuần tự trong cùng một phiên.
4. **Nhận diện trong Iframe của Meta Business Suite**:
   - Trong kiến trúc iframe của Meta, `asset_id` (Page ID) không phải lúc nào cũng xuất hiện trực tiếp trên URL của frame con.
   - Extension chỉ yêu cầu bắt buộc có `thread_id` hợp lệ. `page_id` sẽ được giải quyết qua: Top frame URL/DOM $\rightarrow$ Background service worker mapping (tabId -> active page) $\rightarrow$ Danh sách `inbox_sources`.
   - Chỉ dừng quét khi toàn bộ chuỗi tra cứu context Page/Account đều thất bại.
5. **Hai tin nhắn liên tiếp có cùng nội dung ("alo")**:
   - Tuyệt đối không dùng `index_in_group` làm fingerprint vì khi virtualized DOM thay đổi hoặc nạp thêm tin phía trên, index này sẽ bị lệch gây duplicate hoặc xóa nhầm.
   - Ưu tiên số 1 là `fb_message_id`. Nếu không có `fb_message_id`, tính fingerprint kết hợp: `[sender_direction]_[content_or_media_hash]_[bubble_time_label]_[rel_anchor_hash]` (vị trí tương đối so với anchor gần nhất có ID).
   - Nếu không có đủ bằng chứng phân biệt, giữ message ở trạng thái unverified, không tự động gộp hai tin nhắn có cùng nội dung.

---

## 3. Functional Requirements *(mandatory)*

### Nhóm 1: Chặn Rác, Khoanh Vùng Container & Giải Quyết Page ID
- **FR-001**: `resolveCurrentThreadId()` trong `page_content.js` PHẢI trả về `null` khi không tìm thấy Thread ID hợp lệ từ URL hoặc DOM container. Tuyệt đối KHÔNG trả về chuỗi sentinel giả như `"UNKNOWN_THREAD"`.
- **FR-002**: Extension PHẢI dừng toàn bộ chu trình quét và không gửi bất kỳ tin nhắn/metadata nào nếu chưa xác định được Thread ID hợp lệ.
- **FR-003**: Bộ quét tin nhắn Fanpage CHỈ ĐƯỢC PHÉP truy vấn bên trong container tin nhắn đã được xác thực (chat viewport/log container), KHÔNG ĐƯỢC quét trên phạm vi toàn document của Meta Business Suite.
- **FR-004**: Cơ chế nhận diện Page ID PHẢI có chuỗi fallback: URL frame con $\rightarrow$ Top frame DOM/URL $\rightarrow$ Background tabId mapping $\rightarrow$ Bảng `inbox_sources`. Hệ thống chỉ dừng xử lý khi toàn bộ chuỗi fallback không xác định được ngữ cảnh Page/Account.
- **FR-005**: Backend (`server.js` và `ConversationRepository`) PHẢI từ chối và bỏ qua mọi payload có `thread_id` thuộc danh sách đen: `UNKNOWN_THREAD`, `unknown_dom`, chuỗi rỗng hoặc sentinel không hợp lệ. Backend đồng thời xác minh Page thuộc đúng Account sở hữu trước khi lưu.

### Nhóm 2: Hợp Nhất Bộ Lọc Tên & Phòng Thủ Hai Lớp
- **FR-006**: File `manifest.json` PHẢI nạp thư viện dùng chung `textFilter.js` trước `page_content.js` để đồng nhất logic lọc giữa Messenger cá nhân và Fanpage.
- **FR-007**: Loại bỏ hoàn toàn hàm lọc tên riêng lẻ `isInvalidName` inline trong `page_content.js`, thay thế bằng hàm chuẩn từ `textFilter.js`.
- **FR-008**: Bộ lọc tên PHẢI chuẩn hóa Unicode (NFC), chuẩn hóa khoảng trắng và chặn các chuỗi hệ thống bị lặp lại nhiều lần (ví dụ: `/(?:Tất cả tin nhắn\s*){2,}/i`, `/(?:All messages\s*){2,}/i`).
- **FR-009**: Backend PHẢI áp dụng hàm `cleanContactName()` trước khi insert/update tên liên hệ vào cơ sở dữ liệu như một lớp phòng thủ độc lập.

### Nhóm 3: Chuẩn Hóa Contract Production (Envelope, Direction, Media) & Bóc Tách Thời Gian
- **FR-010**: Dữ liệu gửi từ Extension lên Backend PHẢI đóng gói trong **Batch Envelope** chuẩn:
  ```json
  {
    "thread_id": "string",
    "account_id": "string | null",
    "page_id": "string | null",
    "session_epoch": "string (UUID sinh khi mở tab/thread)",
    "generation": 1,
    "scan_id": "string (UUID)",
    "batch_sequence": 1,
    "mode": "page_initial | page_scroll_older | page_realtime_reconcile",
    "boundary_evidence": {
      "previous_oldest_message_id": "string | null",
      "crawler_confirmed_scroll": true
    },
    "messages": [
      {
        "fb_message_id": "string | null",
        "client_message_id": "string | null",
        "content": "string | null",
        "media_type": "text | image | video | voice | file | call",
        "media_url": "string | null",
        "is_outgoing": false,
        "sender_id": "string",
        "sender_role": "customer | operator",
        "sender_name": "string | null",
        "avatar_url": "string | null",
        "direction_status": "confirmed | pending",
        "direction_source": "string",
        "direction_confidence": "high | medium | low | unknown",
        "dom_order": 0,
        "timestamp_ms": 0,
        "timestamp_source": "facebook_timestamp | facebook_label | separator_date_clock | realtime_delta | dom_order | unknown"
      }
    ]
  }
  ```
  *(Ghi chú chuẩn hóa bắt buộc tại Extension Boundary và Backend Persistence:
    1. `is_outgoing`: Trên transport cho phép `boolean | null`. Kiểm tra giá trị tường minh `val === true || val === 1` $\rightarrow$ `true`; `val === false || val === 0` $\rightarrow$ `false`; tuyệt đối KHÔNG dùng `Boolean(val)` (tránh lỗi `Boolean("false") === true`). Nếu không xác định được hình học thì gán `is_outgoing = null`, `direction_status = 'pending'`, `direction_confidence = 'unknown'`.
    2. Tại tầng lưu trữ SQLite: Vì cột `is_outgoing` có ràng buộc `NOT NULL`, khi lưu tin nhắn có `direction_status = 'pending'` và `is_outgoing = null`, backend sử dụng `is_outgoing = 0` làm storage placeholder tạm thời. Giao diện UI tuyệt đối không được coi placeholder này là tin đến của khách mà phải kiểm tra `direction_status === 'confirmed'` trước khi render hướng gửi.
    3. Tuyệt đối KHÔNG tự ý gán fallback `"high"` khi chưa có bằng chứng hình học hoặc class operator xác thực.
    4. `media_type`: Tuân thủ CHECK constraint SQLite `db.js:753` với `'voice'`, không dùng `'audio'`.)*

- **FR-011**: Thứ tự ưu tiên bóc tách thời gian trong DOM Business Suite:
  1. Thuộc tính `data-utime` hoặc thẻ `<time datetime="...">` $\rightarrow$ gán `timestamp_source = 'facebook_timestamp'`.
  2. Thuộc tính `aria-label`, `title`, `data-tooltip-content` trên bong bóng chat $\rightarrow$ gán `timestamp_source = 'facebook_label'`.
  3. Kết hợp nhãn ngày phân cách gần nhất (Date Separator: "Hôm nay", "Hôm qua", "DD Thg MM, YYYY") + mốc giờ hiển thị trên bong bóng chat $\rightarrow$ gán `timestamp_source = 'separator_date_clock'`.
  4. Nếu không có bất kỳ bằng chứng thời gian nào: đặt `timestamp_ms = 0`, gán `timestamp_source = 'unknown'`. Tuyệt đối KHÔNG gán giờ giả lập cách nhau 1 giây (`ORDER_GAP_MS`) làm thời gian thực tế.

### Nhóm 4: Tách Biệt Batch Lịch Sử & Realtime Delta (State Machine)
- **FR-012**: KHAI TỬ việc gửi từng tin nhắn đã có sẵn qua sự kiện đơn lẻ `NEW_PAGE_MESSAGE_FROM_DOM` khi mở hội thoại hoặc khi cuộn trang.
- **FR-013**: Quản lý vòng đời quét của từng thread theo máy trạng thái: `UNINITIALIZED -> BASELINING -> READY`, với đường lỗi `BASELINING -> TIMEOUT (10s) / OVERFLOW (100 tin hoặc 30s) -> RETRY (generation mới)`.
- **FR-014**: Khi mở hội thoại hoặc cuộn lên lấy tin cũ, extension PHẢI gửi danh sách tin nhắn theo batch envelope qua sự kiện độc quyền **`PAGE_THREAD_MESSAGES_SYNCED_V1`** (sự kiện cũ `THREAD_MESSAGES_SYNCED` giữ nguyên 100% dành riêng cho Messenger cá nhân).
- **FR-015**: Trong giai đoạn `BASELINING`, mọi tin nhắn phát sinh realtime được lưu vào `realtime_buffer` (tối đa 100 tin hoặc 30s). Sau khi baseline hoàn tất, đối chiếu buffer theo ID/fingerprint để append các tin mới vào cuối mà không gây trùng lặp. Nếu baseline lỗi/timeout/overflow, buffer được bảo toàn chuyển sang generation retry tiếp theo mà không gây rò rỉ bộ nhớ.
- **FR-016**: Khi chuyển thread, reload tab hoặc đổi Page, trạng thái quét phải được reset về `UNINITIALIZED` và sinh `session_epoch` mới.

### Nhóm 5: Tách Chân Lý Thứ Tự (`sequence_order`) Khỏi `timestamp_ms` & Anchor Reconciliation
- **FR-017**: Trường `sequence_order` trong cơ sở dữ liệu là **NGUỒN CHÂN LÝ DUY NHẤT** để xác định trật tự trước/sau khi hiển thị tin nhắn trên giao diện.
- **FR-018**: Quy tắc xử lý batch khi đối chiếu:
  - Nếu DB rỗng và `mode = 'page_initial'`: lưu toàn bộ theo `dom_order`, gán `sequence_order = 1..N`.
  - Nếu có tin trùng (anchor): chèn các tin nằm trước anchor đầu tiên lên phía trước, chèn các tin nằm giữa 2 anchor vào giữa chúng.
  - Nếu `mode = 'page_scroll_older'` không có anchor: CHỈ prepend khi `previous_oldest_message_id` thực sự tồn tại trong DB của thread đó và khớp với mốc biên hiện hành (cờ `crawler_confirmed_scroll` chỉ là bằng chứng phụ trợ, không thể tự làm căn cứ duy nhất); nếu không khớp thì từ chối ghi DB và trả về `status = 'retry_required'`.
  - Nếu `mode = 'page_realtime_reconcile'`: chỉ đối chiếu phần đáy, TUYỆT ĐỐI KHÔNG được tự ý prepend lịch sử.
  - Sau khi chèn ghép hợp lệ xong, renumber lại `sequence_order` từ `1..N` cho toàn bộ hội thoại.
- **FR-019**: Hàm `normalizeMessageSequence()` KHÔNG ĐƯỢC sắp xếp lại theo `timestamp_ms` nếu nguồn thời gian là `dom_order`, `unknown` hoặc không đáng tin cậy.

### Nhóm 6: Hợp Nhất Hàm Ranking & Ma Trận Nâng Cấp Timestamp
- **FR-020**: Hợp nhất các khai báo rank rải rác trong `ConversationRepository.js` thành **MỘT HÀM/HẰNG SỐ DUY NHẤT** `getTimestampRank(source)`:
  $$\text{Rank 6: facebook\_payload, facebook\_timestamp (Level 5)}$$
  $$\text{Rank 5: facebook\_label, facebook\_dom (Level 4)}$$
  $$\text{Rank 4: separator\_date\_clock, dom\_clock_order (Level 3)}$$
  $$\text{Rank 3: realtime\_delta, client\_submit, composer\_confirmation, realtime\_fallback, sync (Level 2)}$$
  $$\text{Rank 2: dom\_order (Level 1)}$$
  $$\text{Rank 1: unknown, fallback (Level 0)}$$
- **FR-021**: Quy tắc ghi đè:
  - Nguồn có rank cao hơn ĐƯỢC PHÉP nâng cấp `timestamp_ms` và `timestamp_source` của nguồn có rank thấp hơn.
  - Nguồn có rank bằng hoặc thấp hơn: **Mặc định KHÔNG ghi đè**. Chỉ cho phép cập nhật cùng nguồn khi đó là bản sửa đổi chuẩn hóa (canonical correction) có bằng chứng xác thực.
  - Quá trình nâng cấp timestamp BẢO LƯU nguyên vẹn `created_at` ban đầu và `sequence_order`.

### Nhóm 7: Bảo Vệ Giao Diện (UI Clock & Sidebar Guard)
- **FR-022**: Sửa đổi các component UI (`MessageList.jsx`, `MessageBubble.jsx`, `ChatArea.jsx`):
  - `created_at` chỉ đại diện cho thời điểm CRM ghi nhận bản ghi vào CSDL cục bộ, KHÔNG PHẢI thời gian gửi tin.
  - Với các tin có `timestamp_ms <= 0` hoặc `timestamp_source` là `unknown`/`dom_order`: KHÔNG fallback sang `created_at` để hiển thị giờ hoặc nhóm ngày. Ẩn giờ hoặc hiển thị nhãn "Không rõ thời gian".
- **FR-023**: Bảo vệ danh sách Sidebar:
  - Việc nạp batch lịch sử cũ (`page_scroll_older`) KHÔNG ĐƯỢC tăng biến đếm `unread_count` của thread.
  - KHÔNG ĐƯỢC đưa thread lên đầu sidebar vì `created_at` mới của các tin cũ.
  - KHÔNG ĐƯỢC làm lùi `last_activity` của thread về quá khứ.
  - Chỉ có tin nhắn realtime mới thật sự mới được phép cập nhật `unread_count` và thời gian hoạt động mới nhất.

### Nhóm 8: Dọn Dẹp Dữ Liệu An Toàn & Quy Trình Phục Hồi Dữ Liệu Cũ
- **FR-024**: Cung cấp script dọn dẹp dữ liệu độc lập với các nguyên tắc an toàn:
  - Mặc định chạy ở chế độ `--dry-run`: in danh sách chi tiết các dòng sẽ bị tác động (số lượng thread rác, số message rác, danh sách contact_name bị lỗi).
  - Chỉ thực hiện xóa/sửa khi có cờ tường minh `--apply`.
  - Tự động tạo bản sao lưu an toàn theo timestamp `data/backup_database_<YYYYMMDD_HHMMSS>.db` (sử dụng phương thức an toàn tương thích SQLite WAL).
  - Xử lý toàn bộ thao tác trong một Transaction duy nhất có khả năng Rollback khi gặp sự cố.
  - Xóa sạch các thread rác thoả mãn điều kiện blacklist (`UNKNOWN_THREAD`, sentinel) và các message giao diện tương ứng.
  - Chuẩn hóa lại các tên hội thoại bị lỗi chuỗi lặp `"Tất cả tin nhắn"` về `"Khách hàng"` hoặc tên sạch.
- **FR-025**: Quy trình phục hồi dữ liệu Page cũ:
  - Tuyệt đối không tự đoán mò thứ tự từ dữ liệu đang sai lệch trong DB.
  - Đánh dấu thread Page cũ cột `sync_status = 'NEEDS_RESYNC'` (sử dụng cột sẵn có trong bảng `threads`, không tạo cột mới).
  - Thu thập batch sạch từ Extension khi thread được mở lại trên Business Suite.
  - Chỉ resequence khi nhận được batch sạch có DOM order/anchors đủ tin cậy. Nếu chưa lấy được batch sạch thì giữ nguyên trạng thái cũ để tránh phá hỏng thêm.

---

## 4. Key Entities

- **PageThread**: Cuộc trò chuyện Fanpage với khách hàng, định danh bởi `thread_id` hợp lệ và `page_id` đã được xác thực thuộc tài khoản sở hữu.
- **PageMessage**: Bản ghi tin nhắn trong bảng `messages`, có `sequence_order` (thứ tự hiển thị chân lý), `timestamp_ms` (thời gian hiển thị), `timestamp_source` (nguồn gốc độ tin cậy thời gian theo Canonical Enum), `media_type` ('text', 'image', 'video', 'voice', 'file', 'call'), `direction_confidence` ('high', 'medium', 'low', 'unknown') và `created_at` (thời điểm ghi nhận vào CRM).
- **BatchEnvelope**: Cấu trúc bao gói toàn bộ đợt đồng bộ (`generation`, `scan_id`, `batch_sequence`, `mode`, `boundary_evidence`, `messages`).
- **ThreadScanStateMachine**: Máy trạng thái kiểm soát chu kỳ quét của từng thread (`UNINITIALIZED`, `BASELINING`, `READY`, `TIMEOUT/FAILED`) kèm bộ đệm `realtime_buffer`.

---

## 5. Success Criteria *(mandatory)*

### Measurable Outcomes
- **SC-001**: 100% tin nhắn đã được commit khi có đủ bằng chứng thứ tự (anchor hoặc boundary) hiển thị đúng trật tự thời gian từ trên xuống dưới; các batch mơ hồ bị từ chối thay vì đoán mò.
- **SC-002**: 0 record nào được tạo mới trong DB có `thread_id` là `UNKNOWN_THREAD` hoặc chứa chuỗi rác hệ thống trong quá trình sử dụng.
- **SC-003**: 100% tên khách hàng trên Fanpage không còn chứa chuỗi lặp `"Tất cả tin nhắn"`.
- **SC-004**: 0 trường hợp tin nhắn không có timestamp hiển thị bị gán giờ gửi giả bằng `created_at` trên giao diện người dùng (`MessageBubble`, `MessageList`, `ChatArea`).
- **SC-005**: Hiệu năng xử lý: Thời gian xử lý backend transaction + renumber sequence + socket broadcast cho một batch 50 tin nhắn trên một thread đã có 5.000 đến 10.000 tin nhắn đạt **p95 < 300ms** trên môi trường CSDL SQLite cục bộ.
- **SC-006**: 100% test suite hiện tại và các test suite mới cho Page chronology, State Machine, Boundary Validation và Timestamp Ranking đều PASS (zero regression).

---

## 6. Assumptions & Dependencies

- Meta Business Suite duy trì hiển thị danh sách tin nhắn theo cấu trúc cây DOM chuẩn từ trên xuống dưới (tin cũ ở trên, tin mới ở dưới).
- Các mốc ngày phân cách ("Hôm nay", "Hôm qua", "DD Thg MM, YYYY") và giờ bong bóng chat tiếp tục được hiển thị trong DOM tiếng Việt/tiếng Anh của Facebook.
- Việc chạy script dọn dẹp dữ liệu cũ yêu cầu hệ thống tạo bản sao lưu snapshot trước khi áp dụng `--apply`.
