# Phase 1: Quickstart & Validation Guide (V2 - Hardened)

**Feature**: `054-page-message-chronology-and-noise-guard`
**Date**: 2026-09-10

Hướng dẫn kiểm thử và xác thực toàn diện tính năng trước, trong và sau khi triển khai code.

---

## 1. Môi Trường & Chuẩn Bị
- Node.js >= 18.
- Chạy test suite nền để bảo đảm 100% test hiện tại đang PASS:
  ```bash
  npm run test:persistence
  ```

---

## 2. Kịch Bản Kiểm Thử Tự Động (Automated Test Suites)

### Suite 1: Bóc Tách Thời Gian Fanpage Thuần Túy (Unit)
- **Tập tin**: `tests/unit/page_timestamp_parser.test.js`
- **Chạy**: `node --test tests/unit/page_timestamp_parser.test.js`
- **Mục tiêu**:
  - Trích xuất chuẩn xác theo phân cấp: `data-utime` $\rightarrow$ `<time datetime>` $\rightarrow$ `aria-label`/tooltip $\rightarrow$ separator + bubble clock.
  - Phủ đầy đủ test cases: tiếng Việt & tiếng Anh ("Hôm nay", "Hôm qua", "Today", "Yesterday", "24 Thg 4, 2026", các thứ trong tuần).
  - Xử lý thiếu năm (suy luận năm hiện tại/trước đó) và mốc thời gian qua nửa đêm.

### Suite 2: Chuỗi Phân Giải Page ID Trong Iframe (Unit)
- **Tập tin**: `tests/unit/page_id_resolver.test.js`
- **Chạy**: `node --test tests/unit/page_id_resolver.test.js`
- **Mục tiêu**:
  - URL frame con $\rightarrow$ tab/background mapping $\rightarrow$ bảng `inbox_sources`.
  - Xử lý iframe thiếu `asset_id` trong URL vẫn tìm ra Page ID chuẩn xác.

### Suite 3: Chặn Rác & Chuẩn Hóa Tên Khách Hàng (Unit)
- **Tập tin**: `tests/unit/noise_and_sentinel_guard.test.js`
- **Chạy**: `node --test tests/unit/noise_and_sentinel_guard.test.js`
- **Mục tiêu**:
  - `resolveCurrentThreadId()` trả về `null` thay vì `UNKNOWN_THREAD`.
  - Backend từ chối mọi socket payload có `thread_id` là `UNKNOWN_THREAD`, `unknown_dom`, `""`.
  - `cleanContactName()` loại bỏ hoàn toàn các chuỗi lặp `/(?:Tất cả tin nhắn\s*){2,}/i` và `/(?:All messages\s*){2,}/i`.

### Suite 4: Hợp Nhất Hàm Ranking Timestamp (Unit)
- **Tập tin**: `tests/unit/page_timestamp_ranking.test.js`
- **Chạy**: `node --test tests/unit/page_timestamp_ranking.test.js`
- **Mục tiêu**:
  - `getTimestampRank(source)` đánh giá chuẩn xác Rank 1 đến 6.
  - Nguồn cấp cao (`facebook_timestamp`, `facebook_label`) nâng cấp nguồn cấp thấp (`dom_order`, `unknown`).
  - Nguồn cùng cấp hoặc thấp hơn không được ghi đè.
  - Quá trình nâng cấp không làm thay đổi `created_at` ban đầu và không làm đổi `sequence_order`.

### Suite 5: Ghép Neo Lịch Sử & Kiểm Tra Bằng Chứng Biên (Unit)
- **Tập tin**: `tests/unit/page_history_reconciliation.test.js`
- **Chạy**: `node --test tests/unit/page_history_reconciliation.test.js`
- **Mục tiêu**:
  - Batch cuộn tin cũ có anchor: chèn tin cũ lên trước anchor, renumber 1..N liên tục.
  - Batch cuộn tin cũ mất anchor nhưng có `boundary_evidence` khớp DB: prepend an toàn lên trước tin nhỏ nhất.
  - Batch cuộn tin cũ mất anchor VÀ thiếu `boundary_evidence`: từ chối merge, trả về `retry_required`.
  - Hai tin "alo" liên tiếp cùng nội dung không bị gộp/collapse nhầm.

### Suite 6: Máy Trạng Thái Quét Có Timeout & Buffer Realtime (Unit)
- **Tập tin**: `tests/unit/thread_scan_state_machine.test.js`
- **Chạy**: `node --test tests/unit/thread_scan_state_machine.test.js`
- **Mục tiêu**:
  - `UNINITIALIZED -> BASELINING -> READY` (CHỈ chuyển READY khi có ACK committed).
  - Giữ tin realtime trong buffer khi đang `BASELINING`. Sau khi `READY`, đối chiếu và append vào đuôi.
  - Khi timeout 10s hoặc status lỗi: chuyển sang `RETRY` với generation mới, bảo toàn buffer.
  - Chuyển thread: reset ngay về `UNINITIALIZED`.

### Suite 7: Kiểm Thử Module Hiển Thị Giờ UI Thuần Túy (Unit)
- **Tập tin**: `tests/unit/ui_timestamp_presentation.test.js`
- **Chạy**: `node --test tests/unit/ui_timestamp_presentation.test.js`
- **Mục tiêu**:
  - Helper `messageTimestampPresentation.js` trả về null hoặc nhóm không rõ khi `timestamp_ms <= 0`, không dùng `created_at`.
  - Ẩn mốc giờ hoặc hiển thị "Không rõ thời gian" thay vì lấy `created_at`.
  - Không nhóm ngày theo `created_at`.

### Suite 8: Tích Hợp Pipeline Batch Fanpage & Hồi Quy Messenger Cá Nhân (Integration)
- **Tập tin**: `tests/integration/page_batch_sync_pipeline.test.js`
- **Chạy**: `node --test tests/integration/page_batch_sync_pipeline.test.js`
- **Mục tiêu**:
  - Luồng `PAGE_THREAD_MESSAGES_SYNCED_V1` đi qua Backend, ghi vào DB, phát ACK `PAGE_BATCH_ACK` thành công.
  - Kiểm tra hồi quy: Sự kiện cũ `THREAD_MESSAGES_SYNCED` của Personal Messenger vẫn hoạt động nguyên vẹn, không bị lỗi schema.
  - Kiểm tra idempotency: gửi lại cùng `scan_id` trả về status `'duplicate'` và không đánh lại sequence.
  - Kiểm tra stale-drop: batch gửi với `generation` cũ bị từ chối an toàn.

### Suite 9: Kiểm Thử Script Dọn Rác Trên CSDL Tạm (Integration)
- **Tập tin**: `tests/integration/cleanup_page_garbage.test.js`
- **Chạy**: `node --test tests/integration/cleanup_page_garbage.test.js`
- **Mục tiêu**:
  - Khởi tạo DB SQLite tạm có chứa `UNKNOWN_THREAD`, message rác và tên liên hệ lỗi.
  - Kiểm tra `--dry-run`: in danh sách preview, không làm thay đổi row nào trong DB.
  - Kiểm tra `--apply`: tạo snapshot backup, xóa đúng số lượng rác, chuẩn hóa tên, đánh dấu `sync_status = 'NEEDS_RESYNC'`, rollback an toàn nếu lỗi.

---

## 3. Kịch Bản Benchmark Hiệu Năng End-to-End
- **Tập tin**: `scripts/benchmark_sequence_renumber.js`
- **Chạy**: `node scripts/benchmark_sequence_renumber.js`
- **Mục tiêu**: Đo lường toàn bộ quy trình: Backend transaction + renumber sequence + tạo và broadcast socket payload trên một thread có 10.000 tin nhắn.
- **Quy chuẩn**: Bao gồm vòng warm-up, 5 vòng chạy thực nghiệm và tính độ trễ **p95 < 300ms**.

---

## 4. Kiểm Tra Cú Pháp & Quản Trị Hệ Thống (Governance)
1. **Kiểm tra cú pháp JS ngoài Vite**:
   ```bash
   node --check src/extension/*.js src/server/**/*.js scripts/*.js
   ```
2. **Cập nhật Knowledge Graph (MANDATORY)**:
   ```bash
   graphify update .
   ```
