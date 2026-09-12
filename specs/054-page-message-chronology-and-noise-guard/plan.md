# Implementation Plan: Chuẩn Hóa Thứ Tự Tin Nhắn Fanpage, Phân Tách Thời Gian Hiển Thị & Chặn Rác Toàn Diện (V2 - Hardened)

**Branch**: `054-page-message-chronology-and-noise-guard` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/054-page-message-chronology-and-noise-guard/spec.md`

---

## Summary

Hiện tại, việc đồng bộ tin nhắn từ Fanpage (Meta Business Suite) đang gặp lỗi đảo lộn thứ tự thời gian do xung đột giữa 2 pipeline: `page_content.js` gửi lẻ từng tin nhắn qua `NEW_PAGE_MESSAGE_FROM_DOM` khiến backend gán `max(sequence_order) + 1` (khi cuộn tin cũ lên xem thì tin cũ đến sau và bị đẩy xuống đáy chat), đồng thời xuất hiện rác `UNKNOWN_THREAD`, tên liên hệ bị lặp 3 lần chuỗi giao diện (`"Tất cả tin nhắn..."`), và UI fallback nhầm `created_at` thành giờ gửi của khách.

Kế hoạch này triển khai giải pháp kiến trúc toàn diện gồm 6 trụ cột cốt lõi:
1. **Chặn rác & Khoanh vùng container**: `resolveCurrentThreadId()` trả về `null` thay vì `UNKNOWN_THREAD`; backend từ chối dứt khoát các sentinel; nạp `textFilter.js` vào Page context qua `manifest.json` và chuẩn hóa tên 2 lớp.
2. **Tách riêng Event Fanpage (`PAGE_THREAD_MESSAGES_SYNCED_V1`) & Bảo toàn Personal Messenger**: Tạo event WebSocket độc lập cho Page batch để **hoàn toàn không làm ảnh hưởng đến event `THREAD_MESSAGES_SYNCED` hiện có của Messenger cá nhân**.
3. **Phản hồi hai chiều (Bidirectional ACK)**: Backend gửi ACK (`PAGE_BATCH_ACK`) xác nhận đã commit thành công vào DB; `background.js` định tuyến ACK về đúng tab/frame; `page_content.js` chỉ chuyển `READY` sau khi có ACK.
4. **Một Owner Duy Nhất Cho DOM Extraction**: `page_content.js` là chủ sở hữu duy nhất của việc quét DOM và quan sát realtime; `background.js` điều phối bằng message nội bộ, không chạy crawler thứ hai.
5. **Phân tách Chân lý thứ tự (`sequence_order`) khỏi `timestamp_ms`**: Ghép neo (anchor matching) và bằng chứng biên (boundary evidence). Renumber `1..N` tuần tự. Hợp nhất bảng rank timestamp thành 1 hàm duy nhất; chỉ rank cao hơn mới được nâng cấp rank thấp hơn; không bao giờ dùng timestamp không tin cậy để re-sort sequence.
6. **Bảo Toàn Realtime Side-Effects & Script Dọn Rác An Toàn**: Tin mới phát sinh sau khi `READY` tiếp tục qua luồng realtime delta để kích hoạt đầy đủ outbound confirmation, media, phone capture và UI emit; sửa UI clock guard; script cleanup chạy an toàn với `--dry-run`, snapshot backup WAL và transaction an toàn.

---

## Technical Context

**Language/Version**: Node.js (CommonJS) cho backend & extension background service worker; React 19 (JSX) cho frontend client Electron; Vanilla JS cho extension content scripts.

**Primary Dependencies**: Express, Socket.IO, `ws`, `better-sqlite3`, Chrome Extension Manifest V3 (`chrome.runtime`, `chrome.scripting`).

**Storage**: SQLite (`better-sqlite3`) với chế độ WAL mode. Bảng runtime là **`messages`** và **`threads`**.
- **Tuyệt đối KHÔNG thay đổi schema DDL**.
- CHECK constraints hiện có: `media_type IN ('text', 'image', 'video', 'voice', 'file', 'call')` (dùng `'voice'`, cấm dùng `'audio'`).
- Tái sử dụng cột sẵn có: `threads.sync_status = 'NEEDS_RESYNC'`.
- Chống trùng lặp `scan_id`: Lưu trong bộ nhớ đệm TTL LRU Cache trên Backend (`Map<string, number>`).

**Testing**: `node --test` (`tests/unit/*.test.js`, `tests/integration/*.test.js`), `npm run test:persistence`.

**Target Platform**: Desktop Electron app (Windows) + Chrome Extension Manifest V3 chạy trên Meta Business Suite.

**Project Type**: Desktop app (Electron + React) + Chrome extension + Node.js backend.

**Performance Goals**: Xử lý backend transaction + renumber sequence + socket broadcast cho một batch 50 tin nhắn trên một thread đã có 5.000 đến 10.000 tin nhắn đạt **p95 < 300ms** trên máy chạy CSDL SQLite cục bộ.

**Constraints**:
- Tuyệt đối không làm gãy các test suite hiện có (`npm run test:persistence` 471/471 tests).
- Event `THREAD_MESSAGES_SYNCED` của Personal Messenger được giữ nguyên 100% không đổi.
- `direction_confidence` phải trả về chuỗi (`'high'`, v.v.) để thỏa mãn `server.js:1393`.
- Không thay đổi `created_at` ban đầu khi nâng cấp timestamp.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ⚠️ **Constitution Status**: Not configured (bản mẫu template `.specify/memory/constitution.md` chưa điền nguyên tắc ratify riêng).
- ✅ Tuân thủ nghiêm ngặt Spec-Driven Development theo `PROJECT_RULES.md`: Đã hoàn thành `spec.md`, `research.md`, `data-model.md`, `contracts/batch-envelope.contract.json`, `quickstart.md`.
- ✅ Test-First: Chuẩn bị 6 unit tests + 2 integration tests + 1 benchmark script trước khi can thiệp code.
- ✅ Kiến trúc bền vững: Tách bạch `sequence_order` (chân lý thứ tự) và `timestamp_ms` (thời gian hiển thị).
- ✅ Zero-Regression: Tách riêng event `PAGE_THREAD_MESSAGES_SYNCED_V1` để bảo vệ an toàn tuyệt đối cho Personal Messenger.

---

## Project Structure & File Layout

### Documentation (this feature)
```text
specs/054-page-message-chronology-and-noise-guard/
├── spec.md                                     # Feature Specification (Đã hoàn thành)
├── research.md                                 # Phase 0: Research & Quyết định kỹ thuật V2 (Đã cập nhật)
├── data-model.md                               # Phase 1: Data Model & Zero-DDL Rules (Đã cập nhật)
├── quickstart.md                               # Phase 1: Hướng dẫn 7 test suites & benchmark (Đã cập nhật)
├── contracts/
│   └── batch-envelope.contract.json            # Phase 1: Contract Schema Batch & ACK (Đã cập nhật)
├── plan.md                                     # Master Implementation Plan V2 (File này)
├── tasks.md                                    # Phase 3: Danh Sách 39 Nhiệm Vụ Chi Tiết
└── checklists/
    └── requirements.md                         # Quality Checklist
```

### Source Code Modifications (Implementation Scope)

```text
src/
├── shared/
│   └── pageTimestampParser.js                  # Helper thuần parser thời gian Page (data-utime, aria, separator+clock)
├── extension/
│   ├── manifest.json                           # Nạp textFilter.js trước page_content.js
│   ├── textFilter.js                           # Thêm regex chặn chuỗi lặp /(?:Tất cả tin nhắn\s*){2,}/i
│   ├── page_content.js                         # Sole DOM Owner, Normalizer tường minh, State Machine (ACK listener), iframe resolver
│   └── background.js                           # Điều phối: route Page sync tới page_content.js; route PAGE_BATCH_ACK về tab/frame
├── server/
│   ├── server.js                               # Chặn UNKNOWN_THREAD, handler PAGE_THREAD_MESSAGES_SYNCED_V1, emit PAGE_BATCH_ACK
│   ├── utils/
│   │   └── textFilter.js                       # Thêm regex chặn chuỗi lặp đồng bộ với extension
│   ├── repositories/
│   │   └── ConversationRepository.js           # getTimestampRank duy nhất, anchor & boundary merge, sequence renumber, TTL idempotency cache
│   └── database/
│       └── db.js                               # Giữ nguyên schema, xác nhận CHECK constraints
├── client/
│   ├── utils/
│   │   └── messageTimestampPresentation.js     # Helper thuần format thời gian UI (node --test testable)
│   └── components/
│       ├── MessageList.jsx                     # Dùng messageTimestampPresentation.js (không fallback created_at)
│       ├── MessageBubble.jsx                   # Dùng messageTimestampPresentation.js
│       └── ChatArea.jsx                        # Dùng messageTimestampPresentation.js
scripts/
├── cleanup_page_garbage.js                     # Script dọn rác an toàn (--dry-run, --apply, WAL backup, needs_resync)
└── benchmark_sequence_renumber.js              # Script đo benchmark renumber sequence trên 10k tin nhắn
tests/
├── unit/
│   ├── page_timestamp_parser.test.js           # Test parser thời gian Page (tiếng Việt/Anh, hôm nay/qua, qua nửa đêm)
│   ├── page_id_resolver.test.js                # Test resolve Page ID đa tầng trong iframe
│   ├── noise_and_sentinel_guard.test.js        # Test chặn UNKNOWN_THREAD & lọc tên lặp
│   ├── page_timestamp_ranking.test.js          # Test ma trận nâng cấp timestamp & getTimestampRank
│   ├── page_history_reconciliation.test.js     # Test ghép neo, bằng chứng biên & renumber sequence
│   ├── thread_scan_state_machine.test.js       # Test máy trạng thái, timeout 10s, ACK committed/retry & buffer
│   └── ui_timestamp_presentation.test.js       # Test helper hiển thị giờ UI không fallback created_at
└── integration/
    ├── page_batch_sync_pipeline.test.js        # Test pipeline Page batch, ACK, stale generation và hồi quy Messenger cá nhân
    └── cleanup_page_garbage.test.js            # Test script cleanup trên SQLite DB tạm
```

---

## Detailed Execution Steps (5 Phases)

### Bước 1: Thiết Lập Toàn Bộ Test Suites (TDD Guard)
- Xây dựng 7 unit test files:
  1. `tests/unit/page_timestamp_parser.test.js`: Kiểm thử parser thời gian Page (tiếng Việt/Anh, hôm nay/qua, thiếu năm, qua nửa đêm).
  2. `tests/unit/page_id_resolver.test.js`: Kiểm thử chuỗi resolve Page ID đa tầng trong iframe và ownership check.
  3. `tests/unit/noise_and_sentinel_guard.test.js`: Kiểm thử `resolveCurrentThreadId()`, `cleanContactName()`, và backend blacklist guard.
  4. `tests/unit/page_timestamp_ranking.test.js`: Kiểm thử `getTimestampRank(source)`, ma trận nâng cấp timestamp (bảo lưu `created_at` và `sequence_order`).
  5. `tests/unit/page_history_reconciliation.test.js`: Kiểm thử ghép batch có anchor, batch không anchor có `boundary_evidence` khớp DB, từ chối batch mơ hồ, và không gộp 2 tin "alo" liên tiếp.
  6. `tests/unit/thread_scan_state_machine.test.js`: Kiểm thử chuyển trạng thái `UNINITIALIZED -> BASELINING -> READY` khi có ACK, timeout 10s retry, buffer limit 100 tin/30s overflow fallback.
  7. `tests/unit/ui_timestamp_presentation.test.js`: Kiểm thử logic hiển thị giờ và gom nhóm ngày không fallback sang `created_at`.
- Xây dựng 2 integration test files:
  8. `tests/integration/page_batch_sync_pipeline.test.js`: Luồng `PAGE_THREAD_MESSAGES_SYNCED_V1`, ACK, idempotency, stale generation, và kiểm tra hồi quy đảm bảo `THREAD_MESSAGES_SYNCED` của Messenger cá nhân không bị ảnh hưởng.
  9. `tests/integration/cleanup_page_garbage.test.js`: Kiểm thử script cleanup với `--dry-run`, `--apply`, và backup an toàn trên DB tạm.
- Xây dựng 1 benchmark script:
  10. `scripts/benchmark_sequence_renumber.js`: Đo hiệu năng toàn diện: transaction + renumber + broadcast trên 10.000 records.

### Bước 2: Chặn Rác, Khoanh Vùng Container & Hợp Nhất Bộ Lọc Tên
- Trong `manifest.json`: thêm `src/extension/textFilter.js` và `src/extension/pageTimestampParser.js` vào `content_scripts` của Page trước `page_content.js`.
- Trong `page_content.js`:
  - `resolveCurrentThreadId()`: trả về `null` nếu không tìm thấy thread ID hợp lệ từ URL hoặc DOM container.
  - Ngắt chu trình scan ngay khi `threadId == null`.
  - Giới hạn phạm vi selector bên trong message container đã xác nhận (`chatContainer.querySelector...`), không dùng `document.querySelector...`.
  - Triển khai chuỗi resolve Page ID đa tầng: URL frame con $\rightarrow$ message `RESOLVE_PAGE_CONTEXT` tới background $\rightarrow$ background phối hợp tab mapping/top-frame URL $\rightarrow$ backend xác minh qua `inbox_sources` và kiểm tra account ownership.
  - Loại bỏ `isInvalidName` inline, dùng chung `textFilter.js` với regex chặn chuỗi lặp `/(?:Tất cả tin nhắn\s*){2,}/i` và `/(?:All messages\s*){2,}/i`.
- Trong `server.js` và `ConversationRepository.js`:
  - Từ chối dứt khoát `thread_id` thuộc blacklist (`UNKNOWN_THREAD`, `unknown_dom`, `""`).
  - Xác minh Page ID thuộc đúng Account sở hữu thread.
  - Gọi `cleanContactName()` trước khi ghi nhận tên vào bảng `threads`.

### Bước 3: Batch Envelope Riêng Biệt, Normalizer & State Machine Với Phản Hồi ACK
- Trong `page_content.js`:
  - Đóng vai trò **Owner duy nhất** của DOM extraction.
  - Khai tử việc bắn lẻ `NEW_PAGE_MESSAGE_FROM_DOM` đối với tin lịch sử cũ / backlog.
  - Thêm hàm Normalizer tại biên:
    - `is_outgoing`: Kiểm tra tường minh `val === true || val === 1` $\rightarrow$ `true`; `val === false || val === 0` $\rightarrow$ `false`; nếu không rõ $\rightarrow$ `is_outgoing = null`, `direction_status = 'pending'`, `direction_confidence = 'unknown'` (tuyệt đối không dùng `Boolean(val)` và không gán "high" giả).
    - `sender_id`: Fallback `'CONTACT'` / `'SYSTEM'`.
    - `media_type`: Fallback `'text'`, nếu audio thì gán `'voice'` (khớp CHECK constraint `db.js:753`).
  - Bóc tách thời gian qua `pageTimestampParser.js`: `data-utime` / `<time datetime>` $\rightarrow$ `aria-label`/tooltip $\rightarrow$ Date Separator + Bubble Clock $\rightarrow$ Fallback `timestamp_ms = 0`, `timestamp_source = 'unknown'`.
  - Đóng gói trong **Batch Envelope** (`session_epoch`, `generation`, `scan_id`, `batch_sequence`, `mode`, `boundary_evidence`, `messages`) gửi qua sự kiện độc quyền **`PAGE_THREAD_MESSAGES_SYNCED_V1`**.
  - Cài đặt `ThreadScanStateMachine`:
    - `UNINITIALIZED -> BASELINING`: Bật timeout 10s, gom realtime vào `realtimeBuffer` (giới hạn 100 tin hoặc 30s kèm overflow fallback).
    - Nhận `PAGE_BATCH_ACK` (status `'committed'` / `'duplicate'` khớp `{ session_epoch, generation, scan_id }`): chuyển `READY`, xả buffer và append tin mới qua `NEW_PAGE_MESSAGE_FROM_DOM`.
    - Timeout 10s hoặc nhận status `'retry_required'`: tăng generation và retry, bảo toàn buffer.
- Trong `background.js`:
  - Nhánh Page sync điều phối trực tiếp tới `page_content.js` qua `chrome.tabs.sendMessage` (loại bỏ crawler `executeScript` cho Page).
  - Giữ nguyên 100% crawler cho Messenger cá nhân.
  - Nhận `PAGE_BATCH_ACK` từ backend: chuyển tiếp về đúng tabId và frameId của `page_content.js`.

### Bước 4: Tái Cấu Trúc Backend Sequencer, Hợp Nhất Ranking & Phát ACK
- Trong `ConversationRepository.js`:
  - Hợp nhất các khai báo rank thành một hàm duy nhất `getTimestampRank(source)` đầy đủ canonical sources.
  - Tạo LRU/TTL Cache trong bộ nhớ để kiểm tra tính lũy biến của `scan_id` và phát hiện stale generation.
  - Persistence mapping cho NOT NULL SQLite: khi `is_outgoing === null` (pending), lưu `is_outgoing = 0` làm storage placeholder tạm thời kèm `direction_status = 'pending'`.
  - Trong transaction lưu batch tin nhắn:
    - Tìm anchor trùng khớp (`fb_message_id` hoặc stable fingerprint).
    - Nếu có anchor: chèn tin trước anchor lên trước, giữa anchor vào giữa.
    - Nếu không có anchor: xác thực `boundary_evidence` bắt buộc `previous_oldest_message_id` phải tồn tại trong DB cho thread đó và khớp biên; nếu không khớp thì từ chối ghi DB và trả về `status = 'retry_required'`.
    - Đánh số lại `sequence_order` từ `1..N` tuần tự.
    - Sắp xếp an toàn: `normalizeMessageSequence()` tuyệt đối không đảo lộn lại thứ tự bằng `timestamp_ms` nếu nguồn là `unknown` hoặc `dom_order`.
    - Nâng cấp timestamp: chỉ cập nhật `timestamp_ms` và `timestamp_source` khi rank mới > rank cũ; bảo lưu nguyên vẹn `created_at` ban đầu và `sequence_order`.
- Trong `server.js`:
  - Thêm socket handler cho **`PAGE_THREAD_MESSAGES_SYNCED_V1`**: validate session_epoch, generation, batch_sequence, xử lý batch, gọi Repository, và phát ngược lại **`PAGE_BATCH_ACK`**.
  - Giữ nguyên 100% logic handler `THREAD_MESSAGES_SYNCED` cho Personal Messenger.
  - Bảo vệ sidebar: khi nhận batch Page lịch sử cũ, không tăng `unread_count`, không lùi `last_activity` và không đẩy thread lên đầu danh sách.
  - Bảo toàn realtime: tin mới sau `READY` tiếp tục qua `NEW_PAGE_MESSAGE_FROM_DOM` / `NEW_MESSAGE_RECEIVED` kích hoạt đầy đủ side effects.

### Bước 5: Bảo Vệ Giao Diện (UI Clock Guard) & Script Dọn Rác An Toàn
- Tạo helper thuần `src/client/utils/messageTimestampPresentation.js` (không JSX, testable bằng `node --test`).
- Trong `src/client/components/MessageList.jsx`: Dùng helper, bỏ fallback `created_at`.
- Trong `src/client/components/MessageBubble.jsx`: Dùng helper, ẩn giờ hoặc hiển thị "Không rõ thời gian" khi `timestamp_ms <= 0`, chỉ render hướng gửi khi `direction_status === 'confirmed'`.
- Trong `src/client/components/ChatArea.jsx`: Dùng helper, gom nhóm ngày theo thời gian thực.
- Tạo script `scripts/cleanup_page_garbage.js`:
  - Hỗ trợ `--dry-run` (mặc định) và `--apply`.
  - Tự động tạo snapshot backup tương thích SQLite WAL: `data/backup_database_<timestamp>.db`.
  - Xóa bỏ `UNKNOWN_THREAD` và 36 message giao diện rác trong 1 Transaction có rollback.
  - Chuẩn hóa các tên bị lặp `"Tất cả tin nhắn"`.
  - Đánh dấu `sync_status = 'NEEDS_RESYNC'` cho các thread Page cũ để tự động kéo batch sạch khi mở lại.

---

## Verification & Quality Gates

1. **Unit & Integration Tests**:
   - Chạy toàn bộ 7 test suites mới:
     ```bash
     node --test tests/unit/noise_and_sentinel_guard.test.js
     node --test tests/unit/page_timestamp_ranking.test.js
     node --test tests/unit/page_history_reconciliation.test.js
     node --test tests/unit/thread_scan_state_machine.test.js
     node --test tests/unit/ui_timestamp_presentation.test.js
     node --test tests/integration/page_batch_sync_pipeline.test.js
     node --test tests/integration/cleanup_page_garbage.test.js
     ```
   - Tất cả 7 test suites đều phải PASS 100%.
2. **Regression Check**:
   - `npm run test:persistence` PASS toàn bộ 471/471 tests hiện có.
   - `npm run build:ui` thành công không lỗi cú pháp hoặc bundler.
3. **Hiệu năng & An toàn**:
   - Chạy `node scripts/benchmark_sequence_renumber.js`: xác nhận thời gian p95 < 300ms trên 10.000 messages.
   - Script cleanup chạy an toàn ở chế độ `--dry-run` trước khi áp dụng `--apply`.
