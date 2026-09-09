# Implementation Plan: Sync Reliability Under Service-Worker Churn

**Branch**: `042-sync-service-worker-churn-hardening` | **Date**: 2026-08-19 | **Spec**: `specs/042-sync-service-worker-churn-hardening/spec.md`

## Summary

Service worker Manifest V3 của extension bị Chrome tắt/khởi động lại liên tục do không có keepalive, khiến `REGISTER_ACCOUNT`→`SYNC_THREADS` dồn dập tranh chấp DOM với sync tin nhắn từng thread (spec 041). Đồng thời phát hiện độc lập: nút "Đồng bộ lại hội thoại" gọi nhầm sự kiện sidebar-refresh thay vì đồng bộ đúng hội thoại đang mở. Kế hoạch: (1) giảm tần suất restart bằng `chrome.alarms` keepalive, (2) thêm cooldown phía server để dispatch `SYNC_THREADS` không dồn dập dù restart vẫn xảy ra, (3) sửa nút bấm gọi đúng sự kiện.

## Technical Context

**Language/Version**: Chrome Extension Manifest V3 (service worker JS), Node.js server, React client — không đổi so với spec 041.

**Primary Dependencies**: `chrome.alarms` API (có sẵn trong Manifest V3, chỉ cần khai báo permission `"alarms"` trong `manifest.json` nếu chưa có).

**Storage**: Không thêm bảng/cột. Cooldown phía server là state trong bộ nhớ (giống `domReplaySuppressUntil` đã có trong `server.js`).

**Testing**: `node --test` cho phần server-side cooldown (mock timers như `HistorySyncRetryPolicy.test.js`). Phần `chrome.alarms` không unit-test được (API trình duyệt) — cần manual test theo `quickstart.md`.

**Constraints**: FR-004 không được phá vỡ phần rebind `extensionConnections` mỗi khi có kết nối WS mới — đây là hành vi bắt buộc phải giữ (khác với việc dispatch SYNC_THREADS, có thể bỏ qua).

**Scope**: Chỉ 3 điểm: alarm keepalive, server cooldown, sửa nút resync. Không đổi kiến trúc kết nối, không đổi luồng outbound.

## Constitution Check

Không có gate đặc thù (constitution vẫn là template rỗng). Theo `PROJECT_RULES.md`: spec này đi trước implement; `graphify update .` chạy sau khi code xong.

## Project Structure

```text
specs/042-sync-service-worker-churn-hardening/
├── plan.md              # File này
├── spec.md              # Đã tạo
├── contracts/
│   └── keepalive-and-cooldown.md   # Phase 1 output (dưới đây)
└── tasks.md              # Tạo ở bước /speckit.tasks tiếp theo — CHƯA tạo trong plan này

src/extension/background.js   # Thêm chrome.alarms.create + onAlarm listener no-op
src/extension/manifest.json   # Thêm permission "alarms" nếu chưa khai báo
src/server/server.js          # Thêm cooldown map lastSidebarSyncAt; sửa nhánh REGISTER_ACCOUNT dispatch SYNC_THREADS
src/client/App.jsx             # Sửa onSyncThread của MessageList: gọi thêm REQUEST_SYNC_THREAD_MESSAGES đúng thread đang mở
tests/unit/ hoặc tests/integration/   # Test cooldown logic (pure function, tách tương tự resolveStatusFromCheckpoint)
```

## Phase 0: Research (đã hoàn thành trong Background/Root Cause Analysis của spec.md)

Không có `NEEDS CLARIFICATION` — toàn bộ root cause đã xác định bằng đọc code + log thật, liệt kê đầy đủ trong spec.md mục Background.

**Quyết định thiết kế chính:**
- Alarm interval: 20 giây — dưới ngưỡng ~30s idle-kill phổ biến của Chrome, đồng thời không quá dày để tránh tốn tài nguyên không cần thiết.
- Alarm handler tuyệt đối no-op nghiệp vụ (chỉ `console.log` nhẹ nếu cần debug) — mọi tác dụng phụ đều là rủi ro không đáng, vì mục tiêu duy nhất là giữ SW "tỉnh".
- Cooldown server-side: dùng `Map<account_id, timestamp>` riêng, KHÔNG tái sử dụng biến `state.lastSidebarSyncAt` của `InboxSyncScheduler.js` (module đó vẫn là dead code, không đụng vào — tạo state cooldown ngay tại chỗ dispatch trong `server.js`, hoặc một hàm nhỏ độc lập nếu cần test).
- Sửa nút resync: gọi lại đúng route đã có (`REQUEST_SYNC_THREAD_MESSAGES`) bằng cách tái sử dụng phần thân của `requestThreadNavigation()` thay vì viết logic mới — tránh trôi lặp code.

## Phase 1: Design

### contracts/keepalive-and-cooldown.md

**Alarm keepalive (extension, mới)**:
```js
// background.js, gần chỗ connectWebSocket() được gọi lần đầu
chrome.alarms.create('fb_engine_keepalive', { periodInMinutes: 20 / 60 }); // ~20s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fb_engine_keepalive') {
    // Cố ý không làm gì khác ngoài giữ service worker tỉnh (FR-002).
  }
});
```
`manifest.json` hiện chưa có quyền `"alarms"` trong mảng `permissions` (đã kiểm tra: `cookies, webRequest, declarativeNetRequest, tabs, storage, scripting, debugger`) — bắt buộc phải thêm `"alarms"` khi implement.

**Server cooldown (mới)**:
```js
// server.js, gần nơi khai báo domReplaySuppressUntil
const sidebarSyncCooldownUntil = new Map(); // account_id -> epoch ms

// Trong nhánh REGISTER_ACCOUNT, trước khi setTimeout gửi SYNC_THREADS:
const now = Date.now();
const cooldownUntil = sidebarSyncCooldownUntil.get(account_id) || 0;
if (now < cooldownUntil) {
  console.log(`[WS] Bỏ qua auto SYNC_THREADS sau REGISTER_ACCOUNT (cooldown còn ${cooldownUntil - now}ms): account=${account_id}`);
} else {
  sidebarSyncCooldownUntil.set(account_id, now + 15000);
  setTimeout(() => { /* gửi SYNC_THREADS như hiện tại */ }, 1500);
}
```
Lưu ý: `REQUEST_SYNC_THREADS` (người dùng bấm tay, socket.io handler riêng) KHÔNG đọc/ghi map này (FR-005) — cooldown chỉ áp cho nhánh tự động.

**Sửa nút "Đồng bộ lại hội thoại" (client)**:
Thay vì:
```js
onSyncThread={() => socket?.emit('REQUEST_SYNC_THREADS', { account_id: selectedThread?.account_id })}
```
Đổi thành gọi lại `requestThreadNavigation(selectedThread)` (hàm đã có sẵn ở `App.jsx:186-205`, đã emit đúng `REQUEST_SYNC_THREAD_MESSAGES` với đầy đủ `thread_id/thread_url/page_id/contact_name`) — giữ nguyên hoặc bỏ dòng `REQUEST_SYNC_THREADS` cũ tuỳ đánh giá lúc code (FR-007 cho phép giữ cả hai).

### quickstart.md (kịch bản test thủ công)

1. Cài bản vá, mở `chrome://extensions` → Service Worker → quan sát nhãn "Inactive"/"Active" trong 5 phút không thao tác gì — tần suất chuyển đổi phải giảm rõ so với trước.
2. Theo dõi log server trong cùng 5 phút — đếm số `REGISTER_ACCOUNT`, so với baseline (log thật ngày 2026-08-19 cho thấy hàng chục lần).
3. Mở một thread rỗng/`PARTIAL`, bấm "Đồng bộ lại hội thoại" → xác nhận log server có `Yêu cầu sync tin nhắn cho thread <id>` ngay sau, không chỉ có `Nhận yêu cầu đồng bộ lại hội thoại cho account`.
4. Ngắt kết nối mạng giả lập (tắt/bật lại profile Chrome) để buộc reconnect thật → xác nhận `extensionConnections` vẫn rebind đúng (không mất khả năng gửi/nhận tin) — no-regression cho spec 025.

## Complexity Tracking

Không có vi phạm cần biện minh — 3 thay đổi nhỏ, không thêm dependency, không thêm bảng DB.

## Out of Scope

- Loại bỏ hoàn toàn khả năng SW bị tắt (không khả thi trên Manifest V3, chỉ giảm thiểu).
- Nối lại `InboxSyncScheduler.js`.
- Sửa `no_rows`/`no_main_container` ở tầng phát hiện DOM (đã xử lý một phần bằng retry ở spec 041; spec này xử lý nguyên nhân gây tranh chấp DOM, không đổi cách phát hiện).

## Next Step

Chờ duyệt spec + plan này trước khi sang `/speckit.tasks`.
