# Phase 0: Research & Architectural Decisions (V2 - Hardened)

**Feature**: `054-page-message-chronology-and-noise-guard`
**Date**: 2026-09-10

---

## 1. Quyết Định: Tách Riêng Event `PAGE_THREAD_MESSAGES_SYNCED_V1`
- **Vấn đề**: `THREAD_MESSAGES_SYNCED` hiện đang phục vụ Personal Messenger với contract cũ. Nếu áp đặt validation envelope mới lên event này, toàn bộ luồng Personal Messenger sẽ bị gãy.
- **Giải pháp**: Tạo event chuyên biệt **`PAGE_THREAD_MESSAGES_SYNCED_V1`** dành riêng cho Fanpage.
- **Lợi ích**:
  - Personal Messenger giữ nguyên 100% luồng và contract cũ (Zero Regression).
  - Fanpage có schema envelope chặt chẽ (`generation`, `scan_id`, `batch_sequence`, `mode`, `boundary_evidence`).
  - Dễ dàng rollback độc lập nếu cần thiết.

---

## 2. Quyết Định: Luồng Phản Hồi Hai Chiều (Bidirectional ACK)
- **Vấn đề**: Hàm `sendToBackend()` trước đây là fire-and-forget qua WebSocket. Nếu `page_content.js` tự ý chuyển từ `BASELINING` sang `READY` ngay sau khi gửi, `realtimeBuffer` có thể được xả và append vào CSDL trước khi baseline batch kịp commit, gây race condition lộn xộn.
- **Giải pháp**:
  - Backend sau khi commit batch trong SQLite transaction sẽ phát lại WebSocket event:
    `PAGE_BATCH_ACK` kèm `{ thread_id, generation, scan_id, status: 'committed' | 'duplicate' | 'retry_required' | 'rejected', reason }`.
  - `background.js` nhận ACK và chuyển tiếp chính xác về tab/frame đang mở của thread đó (`chrome.tabs.sendMessage`).
  - `page_content.js` **chỉ chuyển sang trạng thái `READY` sau khi nhận `status === 'committed'` hoặc `'duplicate'`**.

---

## 3. Quyết Định: Một Owner Duy Nhất Cho DOM Extraction Của Page
- **Vấn đề**: `background.js:3157` có hàm `handleSyncThreadMessages` dùng `executeScript`, trong khi `page_content.js` cũng có extractor riêng $\rightarrow$ nguy cơ 2 crawler chạy chồng chéo trên cùng 1 tab.
- **Giải pháp**:
  - **`page_content.js` là owner duy nhất** cho toàn bộ việc trích xuất DOM và quan sát realtime trên Business Suite.
  - Khi `background.js` nhận yêu cầu sync thread Page từ CRM, nó gửi thông điệp nội bộ (`chrome.tabs.sendMessage(tabId, { action: 'REQUEST_PAGE_BATCH_SYNC', ... })`) tới `page_content.js` để thực thi, thay vì tự inject một crawler thứ hai.

---

## 4. Quyết Định: Tuyệt Đối Không Thay Đổi Schema CSDL
- **Vấn đề**: Trước đó đề xuất thêm cột `needs_resync` vào bảng `threads`, mâu thuẫn với cam kết "không sửa schema DDL". Bảng runtime thực tế là `messages`, không phải `messages_v55`.
- **Giải pháp**:
  - Bảng runtime là **`messages`** và **`threads`**.
  - Không thêm cột mới: Trạng thái yêu cầu đồng bộ lại của thread sử dụng cột sẵn có: `threads.sync_status = 'NEEDS_RESYNC'`.
  - Không lưu rác: Các batch thiếu bằng chứng biên (`quarantine`) không ghi vào DB mà trả về ACK `retry_required`.
  - Chống trùng lặp batch (`scan_id` idempotency): Quản lý bằng bộ nhớ đệm TTL LRU Cache trên backend (`Map<string, number>`), kết hợp cơ chế upsert message có sẵn.

---

## 5. Quyết Định: Bảo Toàn Toàn Bộ Side-Effects Của Luồng Realtime
- **Vấn đề**: Handler `NEW_MESSAGE_RECEIVED` trên backend đảm nhiệm rất nhiều nghiệp vụ quan trọng ngoài việc lưu tin: xác nhận outbound pending, rich-message, tải media, phone capture, cập nhật unread/sidebar. Nếu gộp realtime vào batch sync sẽ làm mất các tính năng này.
- **Giải pháp**:
  - **Batch Sync (`PAGE_THREAD_MESSAGES_SYNCED_V1`)**: Chỉ áp dụng cho `page_initial` và `page_scroll_older`. Xử lý lưu lịch sử, đánh số `sequence_order`, không tăng unread, không kích hoạt outbound pending và không đẩy thread lên đầu sidebar.
  - **Realtime Delta (`NEW_PAGE_MESSAGE_FROM_DOM`)**: Chỉ kích hoạt khi state machine đã ở trạng thái `READY` (tin mới phát sinh sau baseline). Giữ nguyên toàn bộ pipeline `NEW_MESSAGE_RECEIVED` và các side-effects nghiệp vụ.

---

## 6. Quyết Định: Chuẩn Hóa Tại Biên Extension (Boundary Normalization)
- Extension normalizer đảm bảo dữ liệu gửi lên backend luôn sạch:
  - `is_outgoing`: Ép `Boolean(val)` (`0/1 -> false/true`).
  - `sender_id`: Nếu thiếu, gán `'CONTACT'` (incoming) hoặc `'SYSTEM'` (outgoing).
  - `media_type`: Fallback `'text'`. Nếu là audio, bắt buộc gán `'voice'` (khớp CHECK constraint `db.js:753`).
  - `direction_confidence`: Chuỗi `'high' | 'medium' | 'low' | 'unknown'`.
- Backend xác thực `boundary_evidence` dựa trên cơ sở dữ liệu thật:
  - `previous_oldest_message_id` phải thực sự tồn tại trong DB của thread đó.
  - `generation` phải còn hiệu lực.
  - `batch_sequence` phải tuần tự.
