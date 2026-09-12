# Phase 1: Data Model & Schema Specifications

**Feature**: `054-page-message-chronology-and-noise-guard`
**Date**: 2026-09-10

---

## 1. Nguyên Tắc Cốt Lõi: KHÔNG THAY ĐỔI SCHEMA DDL

Hệ thống sử dụng bảng runtime hiện tại là **`messages`** và **`threads`** trong CSDL SQLite cục bộ (WAL mode). **Tuyệt đối KHÔNG chạy lệnh `ALTER TABLE` hay sửa đổi DDL**. Mọi trạng thái đồng bộ mới được tái sử dụng các cột sẵn có:

- Trạng thái yêu cầu đồng bộ lại của thread: Sử dụng cột có sẵn `threads.sync_status = 'NEEDS_RESYNC'`.
- Quản lý Batch Idempotency (`scan_id`): Lưu trong bộ nhớ Backend bằng LRU/TTL Cache (`Map<string, number>`), kết hợp cơ chế `ON CONFLICT(fb_message_id) DO UPDATE` đã có sẵn.
- Trạng thái cách ly (`quarantine_pending`): Không ghi rác vào DB; backend trả phản hồi ACK `retry_required` để Extension quét lại.

---

## 2. Entity: PageMessage (Bảng `messages`)

Cấu trúc các trường runtime được sử dụng trong bảng `messages`:

```sql
-- Schema runtime hiện hành (bảng messages)
-- id INTEGER PRIMARY KEY AUTOINCREMENT
-- thread_id TEXT NOT NULL                     --> Chặn UNKNOWN_THREAD / rỗng / sentinel
-- fb_message_id TEXT UNIQUE                   --> ID Facebook hoặc stable fingerprint
-- client_message_id TEXT                      --> ID tạm từ CRM (nếu gửi đi)
-- sender_id TEXT NOT NULL                     --> Luôn normalized: 'CONTACT' hoặc account_id
-- content TEXT                                --> Nội dung tin nhắn
-- media_type TEXT CHECK(...) DEFAULT 'text'   --> 'text', 'image', 'video', 'voice', 'file', 'call' (KHÔNG dùng 'audio')
-- media_url TEXT
-- is_outgoing BOOLEAN NOT NULL DEFAULT 0      --> 0 hoặc 1 (normalized từ false/true)
-- sender_role TEXT NOT NULL DEFAULT 'customer'--> 'customer' hoặc 'operator'
-- sequence_order INTEGER                      --> NGUỒN CHÂN LÝ THỨ TỰ (1..N)
-- direction_status TEXT                       --> 'confirmed' hoặc 'pending'
-- timestamp_ms INTEGER                        --> 0 nếu không có giờ Facebook
-- timestamp_source TEXT                       --> Canonical Enum (Rank 1..6)
-- created_at TEXT                             --> BẢO LƯU THỜI ĐIỂM INGEST, KHÔNG ĐỔI KHI UPGRADE
```

### Validation & Normalization Rules tại Extension Boundary và Backend Persistence
1. `is_outgoing`:
   - Trên transport: cho phép `boolean | null`. Kiểm tra tường minh `val === true || val === 1` $\rightarrow$ `true`; `val === false || val === 0` $\rightarrow$ `false`; tuyệt đối KHÔNG dùng `Boolean(val)`. Nếu không rõ hình học/class $\rightarrow$ `is_outgoing = null`, `direction_status = 'pending'`, `direction_confidence = 'unknown'`.
   - Trong SQLite (`messages.is_outgoing` có ràng buộc `NOT NULL`): Backend lưu `is_outgoing = 0` làm storage placeholder tạm thời, đi kèm `direction_status = 'pending'`.
   - Quy tắc UI: Giao diện người dùng bắt buộc kiểm tra `direction_status === 'confirmed'` trước khi render hướng gửi; không bao giờ ngầm hiểu placeholder `0` là tin đến của khách hàng.
2. `sender_id`: Nếu rỗng hoặc null, tự động gán `'CONTACT'` (nếu incoming) hoặc `'SYSTEM'` (nếu outgoing).
3. `media_type`: Fallback về `'text'`. Nếu là âm thanh, bắt buộc dùng `'voice'`, cấm dùng `'audio'`.
4. `direction_confidence`: Chuỗi chuẩn `'high' | 'medium' | 'low' | 'unknown'`.
5. `direction_status`: `'confirmed'` khi `direction_confidence === 'high'`, ngược lại `'pending'`.
6. `thread_id`: Bắt buộc hợp lệ, không nằm trong danh sách đen (`['UNKNOWN_THREAD', 'unknown_dom', '', null]`).

---

## 3. Entity: PageThread (Bảng `threads`)

### Validation & Side-effect Isolation
1. `sync_status`: Khi cleanup hoặc yêu cầu re-sync, đặt `sync_status = 'NEEDS_RESYNC'`.
2. `contact_name`: Luôn đi qua hàm `cleanContactName()` trước khi ghi DB (chuẩn hóa Unicode NFC, loại bỏ khoảng trắng thừa, chặn các chuỗi lặp `/(?:Tất cả tin nhắn\s*){2,}/i` và `/(?:All messages\s*){2,}/i`).
3. `last_activity`: Khi nhận batch lịch sử cũ (`PAGE_THREAD_MESSAGES_SYNCED_V1` mode `page_scroll_older`), **giữ nguyên `last_activity` hiện tại**, không được lùi về quá khứ.
4. `unread_count`: Batch lịch sử cũ **tuyệt đối không được tăng `unread_count`**.

---

## 4. Entity: ThreadScanStateMachine & Hai Chiều ACK

Máy trạng thái kiểm soát chu kỳ quét của từng thread trên Client Extension:

```typescript
type ThreadScanState = 'UNINITIALIZED' | 'BASELINING' | 'READY' | 'TIMEOUT' | 'FAILED';

interface ThreadScanContext {
  threadId: string;
  sessionEpoch: string; // UUID sinh mỗi khi mở tab / đổi thread
  generation: number;   // Số nguyên tăng dần (bắt đầu từ 1, tăng khi retry)
  scanId: string;       // UUID của từng batch gửi đi
  state: ThreadScanState;
  realtimeBuffer: NormalizedMessagePayload[]; // Giới hạn 100 tin hoặc 30 giây
  baseliningStartedAt: number;
  timeoutTimer: any;
}
```

### Chuyển Dịch Trạng Thái Có Xác Nhận ACK & Chính Sách Tràn Bộ Đệm (Buffer Overflow):
- `UNINITIALIZED` $\xrightarrow{\text{Mở thread Fanpage}}$ `BASELINING`:
  - Khởi tạo `sessionEpoch` mới (UUID), đặt `generation = 1`, sinh `scan_id` (UUID).
  - Thu thập batch baseline và gửi qua sự kiện `PAGE_THREAD_MESSAGES_SYNCED_V1`.
  - Khởi động timer timeout 10 giây.
  - Mọi tin nhắn realtime phát sinh trong lúc này được gom vào `realtimeBuffer`.
- `BASELINING` $\xrightarrow{\text{Nhận ACK: PAGE_BATCH_ACK (status: 'committed' | 'duplicate')}}$ `READY`:
  - **Chỉ chuyển `READY` khi nhận ACK khớp đúng `{ sessionEpoch, generation, scanId }`**.
  - Xả `realtimeBuffer`, đối chiếu ID với baseline: tin nào đã có thì bỏ qua, tin mới thật sự thì gửi qua luồng realtime `NEW_PAGE_MESSAGE_FROM_DOM` để kích hoạt đầy đủ side effects.
- `BASELINING` $\xrightarrow{\text{Timeout 10s hoặc ACK lỗi (retry_required / rejected)}}$ `FAILED / TIMEOUT` $\xrightarrow{\text{Retry}}$ `BASELINING`:
  - Tăng `generation += 1` trong cùng `sessionEpoch`.
  - Bảo toàn `realtimeBuffer` chuyển sang phiên quét mới.
- **Chính sách tràn bộ đệm (Buffer Overflow)**:
  - Nếu `realtimeBuffer` vượt quá 100 tin hoặc thời gian baselining vượt quá 30 giây: kích hoạt cơ chế fallback xả đệm sang hàng đợi realtime cục bộ, phát cảnh báo và không retry vô hạn để tránh rò rỉ bộ nhớ.
- Bất kỳ trạng thái $\xrightarrow{\text{Chuyển thread / Reload tab / Đổi Page}}$ `UNINITIALIZED`:
  - Hủy timer, giải phóng buffer an toàn.
