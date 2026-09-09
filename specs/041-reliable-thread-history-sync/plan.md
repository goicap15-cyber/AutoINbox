# Implementation Plan: Reliable Thread History Sync & Auto-Retry

**Branch**: `041-reliable-thread-history-sync` | **Date**: 2026-08-19 | **Spec**: `specs/041-reliable-thread-history-sync/spec.md`

**Input**: Feature specification from `specs/041-reliable-thread-history-sync/spec.md`

## Summary

Sync lịch sử tin nhắn hiện chỉ chạy đúng cho các thread người dùng từng mở tay, và ngay cả với những thread đó, lần đồng bộ đầu tiên có thể dừng giữa chừng (giới hạn vòng cuộn không khớp mode) mà vẫn bị đánh dấu `SYNCED` — nên phần lịch sử thiếu không bao giờ được lấy lại, và lỗi DOM tạm thời không tự phục hồi. Kế hoạch này sửa 3 điểm nối sai giữa extension và server (round-budget theo mode, cờ `PARTIAL` chưa từng dùng, không có retry) mà **không** đổi kiến trúc/schema hiện có, và **không** mở rộng sang auto-backfill toàn tài khoản (ngoài phạm vi, xem spec 007).

## Technical Context

**Language/Version**: Node.js (CommonJS) cho server & extension (Manifest V3 background service worker), React 19 cho client.

**Primary Dependencies**: Express, `ws`/Socket.IO, `better-sqlite3`, Chrome Extension `chrome.scripting.executeScript`/`chrome.runtime` messaging.

**Storage**: SQLite (`better-sqlite3`) — bảng `threads` đã có `sync_status`, `sync_cursor` (TEXT/JSON), `sync_error`. Không thêm cột mới.

**Testing**: `node --test` (`tests/unit/*.test.js`, `tests/integration/*.test.js`), theo `npm run test:persistence`.

**Target Platform**: Desktop Electron app; Chrome extension chạy trên tab Facebook/Messenger thật của người dùng.

**Project Type**: Desktop app (Electron) + Chrome extension + Node server, single repo — theo cấu trúc hiện có, không đổi.

**Performance Goals**: Không tăng chi phí cho thread đã `SYNCED` thật (vẫn 1 vòng `incremental`); round-budget cao hơn chỉ áp dụng cho `initial` và `deep_backfill`.

**Constraints**: Không được phá lại an toàn "không tự retry bằng timer để tránh điều hướng nhầm tab về thread cũ" (comment hiện có tại `server.js:1241-1244`) — mọi retry mới phải kiểm tra thread mục tiêu vẫn còn là thread được yêu cầu gần nhất trước khi bắn lại.

**Scale/Scope**: Ảnh hưởng luồng history-sync hiện có của mọi account/thread; không đổi luồng gửi tin (outbound), không đổi luồng realtime `NEW_MESSAGE`.

## Constitution Check

`/.specify/memory/constitution.md` hiện là template chưa điền (không có nguyên tắc cụ thể nào được ratify) → không có gate bắt buộc riêng ngoài `PROJECT_RULES.md`:

- ✅ Theo Spec Kit workflow (spec này) trước khi code.
- ✅ Sẽ chạy `graphify update .` sau khi code xong (Phase Implement, ngoài phạm vi plan này).
- ✅ Không đổi luồng outbound "trusted-send" (giữ nguyên theo FR-009 của spec 007).

## Project Structure

### Documentation (this feature)

```text
specs/041-reliable-thread-history-sync/
├── plan.md              # File này
├── spec.md              # Đã tạo
├── research.md          # Phase 0 output (dưới đây, inline vì không có unknown cần research riêng)
├── data-model.md         # Phase 1 output (dưới đây)
├── contracts/
│   └── ws-messages.md    # Phase 1 output (dưới đây)
└── tasks.md              # Phase 2 — tạo ở bước /speckit.tasks tiếp theo, CHƯA tạo trong plan này
```

### Source Code (repository root)

Không có cấu trúc mới — sửa trong các file đã tồn tại:

```text
src/extension/background.js         # loadOlderMessages(): round-budget theo mode, spinner-aware stop, trả boundary_reached + stop_reason
src/server/server.js                # THREAD_MESSAGES_SYNCED: set PARTIAL/SYNCED đúng; REQUEST_SYNC_THREAD_MESSAGES: chọn mode deep_backfill; retry scheduler cho reason tạm thời
src/server/services/HistorySyncManager.js   # (không đổi field, chỉ dùng đúng PARTIAL đã có sẵn trong VALID_STATUSES)
src/client/App.jsx                  # requestThreadNavigation / nút "Đồng bộ lại": không đổi call shape, server tự quyết định mode dựa trên sync_status
src/client/components/MessageList.jsx  # Phân biệt hiển thị LOCAL vs PARTIAL (FR-010)
tests/unit/                          # Unit test round-budget mapping, PARTIAL/SYNCED decision
tests/integration/                   # Integration test retry scheduler + resume sau "restart" giả lập
```

**Structure Decision**: Giữ nguyên layout single-repo hiện có (`src/{client,server,extension}`), không tạo package/service mới. Retry scheduler triển khai như state nội bộ trong `server.js` (hoặc một module nhỏ mới `src/server/services/HistorySyncRetryPolicy.js` nếu logic vượt quá vài chục dòng) — KHÔNG hồi sinh `InboxSyncScheduler.js` (giải quyết bài toán khác: polling nền chủ động cho toàn bộ thread, ngoài phạm vi theo Assumptions của spec 041).

## Phase 0: Research (inline — không có unknown cần điều tra thêm)

Toàn bộ root cause đã được xác định bằng đọc code trực tiếp (không có `NEEDS CLARIFICATION`):

| # | Phát hiện | Bằng chứng |
|---|---|---|
| 1 | `mode: 'backfill'` không bao giờ được server gửi; `mode: 'initial'` rơi vào default 5 vòng | `server.js:1533-1536` (chỉ gửi `initial`/`incremental`) vs `background.js:2221-2224` |
| 2 | `PARTIAL` được khai báo nhưng chưa từng được set | `HistorySyncManager.js:7` vs toàn bộ `grep updateSyncStatus` |
| 3 | `boundary_reached` được tính nhưng bị bỏ khi build checkpoint | `background.js:2515` (tính) vs `background.js:2541-2556` (checkpoint không mang field này) |
| 4 | Server luôn set `SYNCED` khi có `checkpoint`, bất kể crawl có hoàn tất hay không | `server.js:1283-1285`, `1306-1308` |
| 5 | Không có retry timer theo chủ đích (an toàn điều hướng) | Comment `server.js:1241-1244` |
| 6 | Nút "Đồng bộ lại hội thoại" chỉ gọi lại request bình thường → rơi vào `incremental` vì đã có cursor | `App.jsx:186-205`, `server.js:1533-1536` |
| 7 | `InboxSyncScheduler.js` là dead code (spec 007), không liên quan tới bug này | `grep -rn InboxSyncScheduler src/server/` → chỉ có định nghĩa, không có import |
| 8 | Checkpoint đã bền trên server (SQLite), không phải bug | `db.js:101-103` (cột), `server.js:1531-1536` (đọc lại từ DB mỗi request) |

**Quyết định thiết kế chính**:
- Thêm `stop_reason` (`max_rounds_hit` | `no_scroll_growth` | `boundary_reached`) và `boundary_reached` vào object checkpoint JSON (không thêm cột DB).
- Đổi round-budget map trong `loadOlderMessages` thành khớp đúng 3 mode thực tế: `initial`, `incremental`, `deep_backfill`.
- `deep_backfill` được server chọn khi `sync_status ∈ {PARTIAL, FAILED}` tại thời điểm `REQUEST_SYNC_THREAD_MESSAGES`.
- Retry transient lỗi: state nhẹ trong bộ nhớ server (map `thread_id → {attempts, latestRequestToken}`), không cần bền qua restart (nếu server restart giữa lúc retry, thread đơn giản quay về `FAILED`/`PARTIAL` và chờ người dùng mở lại — chấp nhận được, vì đây chỉ là tối ưu trải nghiệm, không phải nguồn sự thật dữ liệu).

## Phase 1: Design

### data-model.md (bổ sung cho spec 003, không thay thế)

`threads.sync_cursor` (JSON, không đổi cột) mở rộng thêm 2 field tuỳ chọn, tương thích ngược (cursor cũ không có field này vẫn hợp lệ, coi như `stop_reason` không xác định → xử lý như trước đây, tức `SYNCED`, để không tự hạ cấp trạng thái của dữ liệu cũ đã đồng bộ trước khi có bản vá này):

```
sync_cursor (JSON):
  ...(các field đã có theo spec 003: version, mode, newest/oldest timestamp+id, last_batch_id)
  boundary_reached: boolean   # mới — true nếu crawl chạm điểm neo lịch sử cũ nhất
  stop_reason: string         # mới — 'max_rounds_hit' | 'no_scroll_growth' | 'boundary_reached'
```

`threads.sync_status` — dùng lại đúng enum đã có (`LOCAL, SYNCING, PARTIAL, SYNCED, FAILED`), chỉ thay đổi **logic chọn giá trị**, không đổi enum.

### contracts/ws-messages.md (hợp đồng message WS thay đổi)

**`THREAD_MESSAGES_SYNCED`** (extension → server) — thêm field, các field cũ giữ nguyên:
```
{
  type: 'THREAD_MESSAGES_SYNCED',
  data: {
    account_id, thread_id, messages, mode,
    checkpoint: { ...cũ, boundary_reached, stop_reason },  // mới
    fetched_count, skipped_count,
    reason?  // giữ nguyên semantics cũ khi có lỗi transient/vĩnh viễn
  }
}
```

**`SYNC_THREAD_MESSAGES`** (server → extension) — mở rộng enum `mode`:
```
{
  type: 'SYNC_THREAD_MESSAGES',
  data: {
    account_id, thread_id, thread_url, page_id,
    mode: 'initial' | 'incremental' | 'deep_backfill',  // thêm 'deep_backfill'
    cursor, contact_name
  }
}
```
Quy tắc chọn `mode` tại `REQUEST_SYNC_THREAD_MESSAGES` (server.js):
- Không có `sync_cursor` → `initial`.
- Có `sync_cursor` và `sync_status ∈ {PARTIAL, FAILED}` → `deep_backfill`.
- Có `sync_cursor` và `sync_status ∈ {SYNCED, SYNCING, LOCAL}` → `incremental` (giữ nguyên hành vi hiện tại).

**Round-budget đề xuất** (tinh chỉnh được ở bước implement, log để đo thực tế qua `[FB LazyLoad]`):
| mode | maxRounds hiện tại | maxRounds đề xuất |
|---|---|---|
| `incremental` | 1 | 1 (không đổi) |
| `initial` | 5 (default, sai) | 8 |
| `deep_backfill` (mới, thay `backfill` chết) | 10 (không dùng tới) | 12 |

**Retry policy (mới, chỉ server-side, không phải WS contract mới)**:
- Áp dụng cho `reason ∈ {marker_mismatch, sidebar_mismatch, no_rows, no_main_container}`.
- KHÔNG áp dụng cho `reason = 'error_screen'`.
- Tối đa 3 lần, backoff `[2000, 6000, 15000]` ms.
- Trước mỗi lần bắn lại: kiểm tra "token yêu cầu mới nhất" của thread đó (giống cơ chế `requestedSyncRef` phía client nhưng ở server) — nếu đã có `REQUEST_SYNC_THREAD_MESSAGES` khác cho thread khác đến sau, huỷ retry đang chờ, không bắn.

### quickstart.md (kịch bản kiểm thử thủ công, để implement sau tham chiếu)

1. Chọn 1 tài khoản test có ít nhất 1 hội thoại dài (>150 tin) chưa từng mở trong CRM.
2. Mở hội thoại đó lần đầu → quan sát log `[FB LazyLoad]` số vòng thực chạy và `stop_reason` cuối cùng.
3. Nếu `stop_reason = max_rounds_hit` → kiểm tra `threads.sync_status` phải là `PARTIAL`, không phải `SYNCED`.
4. Đóng CRM, mở lại, chọn lại đúng hội thoại đó → xác nhận request thứ 2 dùng `mode: deep_backfill`, số tin nhắn tăng thêm.
5. Giả lập lỗi tạm thời (vd DevTools chặn tạm response `messages` một lần) → xác nhận server tự retry theo log `[INBOX_SYNC_MESSAGES_RESULT]`/tương đương mà không cần bấm nút.
6. Với 1 hội thoại đã thực sự `SYNCED` (boundary_reached=true) từ trước bản vá → mở lại, xác nhận vẫn chỉ 1 vòng `incremental`, không có tin trùng/tin mới phát sinh (no regression, SC-005/SC-006 spec 003).

## Complexity Tracking

Không có vi phạm nguyên tắc nào cần biện minh — toàn bộ thay đổi tái sử dụng cột/enum/module đã có, không thêm project/service mới, không thêm dependency mới.

## Out of Scope (ghi rõ để tránh trôi phạm vi ở bước Tasks/Implement)

- Nối lại `InboxSyncScheduler.js` để chủ động đồng bộ nền toàn bộ thread/account (spec 007) — người dùng không chọn hướng này ở vòng trao đổi trước.
- Thay đổi cơ chế phát hiện direction (in/out) hay nội dung tin nhắn bị lọc sai bởi `textFilter.js` — nếu sau khi vá xong mà vẫn có báo cáo "nội dung chưa chuẩn" cụ thể (vd sai người gửi, sai thứ tự), cần một spec riêng kèm ví dụ thực tế để điều tra tiếp (textFilter/direction detection là code path khác, không liên quan trực tiếp tới round-budget/PARTIAL).
- Đổi UI/UX tổng thể khung chat — chỉ thêm 1 trạng thái hiển thị nhỏ cho `PARTIAL` (FR-010).

## Next Step

Sau khi spec+plan này được duyệt, bước tiếp theo theo đúng quy trình `PROJECT_RULES.md` là `/speckit.tasks` để sinh `tasks.md` chi tiết (chia theo file/US ở trên), rồi mới tới `/speckit.implement`. Plan này chưa bao gồm code.
