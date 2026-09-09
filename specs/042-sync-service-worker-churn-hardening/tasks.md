# Tasks: Sync Reliability Under Service-Worker Churn

**Input**: `specs/042-sync-service-worker-churn-hardening/spec.md`, `plan.md`

## Phase 0 — Research (done, see spec.md Background / Root Cause Analysis)

- [X] T001 Re-xác nhận root cause vẫn đúng với source hiện tại: `manifest.json` chưa có quyền `alarms`; `background.js:2756` gọi `connectWebSocket()` ở top-level; `content.js:771` push token mỗi 3s; `server.js` nhánh `REGISTER_ACCOUNT` dispatch `SYNC_THREADS` không cooldown; `App.jsx:968` nút resync gọi `REQUEST_SYNC_THREADS` thay vì `REQUEST_SYNC_THREAD_MESSAGES`. Tất cả khớp đúng.

---

## Phase 1 — Extension: chrome.alarms keepalive (US1)

**Mục tiêu**: Giảm tần suất Chrome tắt service worker.

- [X] T002 [P] Thêm `"alarms"` vào mảng `permissions` trong `src/extension/manifest.json`.
- [X] T003 [US1] Thêm `chrome.alarms.create('fb_engine_keepalive', { periodInMinutes: 20/60 })` ngay sau `connectWebSocket()` ở cuối `background.js`.
- [X] T004 [US1] Thêm `chrome.alarms.onAlarm.addListener(...)` — handler chỉ `console.log` một dòng chẩn đoán, không gửi lệnh sync/mở tab (FR-002).

**Checkpoint**: Extension tự đánh thức mỗi ~20s thay vì chờ Chrome quyết định.

---

## Phase 2 — Server: cooldown cho auto SYNC_THREADS sau REGISTER_ACCOUNT (US2)

**Mục tiêu**: Dù restart vẫn xảy ra, server không dồn dập quét lại sidebar.

- [X] T005 [US2] Tạo `src/server/services/SidebarSyncCooldown.js` thay vì Map inline trong `server.js` — để logic testable độc lập (cùng convention với `HistorySyncManager`/`HistorySyncRetryPolicy` đã làm ở spec 041): `isInCooldown(accountId, now)`, `markDispatched(accountId, now, cooldownMs=15000)`, `remainingMs(accountId, now)`.
- [X] T006 [US2] Nhánh `REGISTER_ACCOUNT` trong `server.js`: bọc `setTimeout(SYNC_THREADS)` sau điều kiện `SidebarSyncCooldown.isInCooldown(...)`; phần upsert DB/ACK/rebind `extensionConnections` phía trên KHÔNG bị ảnh hưởng (vẫn chạy trước, ngoài điều kiện cooldown).
- [X] T007 [US2] Xác nhận `socket.on('REQUEST_SYNC_THREADS', ...)` (dòng ~1563) không đọc/ghi `SidebarSyncCooldown` — đúng như spec, không cần sửa.
- [X] T008 [P] [US2] `tests/unit/sidebarSyncCooldown.test.js` — 4 test: chưa dispatch lần nào → không cooldown; dispatch rồi → cooldown đúng biên (14999ms còn, 15000ms hết); cooldown tính riêng theo từng account; `remainingMs` đúng giá trị. PASS.

**Checkpoint**: 5 `REGISTER_ACCOUNT` liên tiếp trong 2s cho cùng account → tối đa 1 `SYNC_THREADS` thực sự gửi đi (đảm bảo bằng unit test cho phần quyết định; hành vi dispatch thật cần verify bằng log máy thật, xem T014).

---

## Phase 3 — Client: sửa nút "Đồng bộ lại hội thoại" (US3)

**Mục tiêu**: Bấm nút phải thực sự yêu cầu tin nhắn của đúng hội thoại đang mở.

- [X] T009 [US3] `App.jsx:968`: đổi `onSyncThread={() => socket?.emit('REQUEST_SYNC_THREADS', ...)}` thành `onSyncThread={() => requestThreadNavigation(selectedThread)}` — tái dùng hàm đã có, emit đúng `REQUEST_SYNC_THREAD_MESSAGES` cho thread đang mở. Không giữ thêm `REQUEST_SYNC_THREADS` song song (đánh giá: không cần thiết — `requestThreadNavigation` đã đủ, giữ cả hai chỉ thêm 1 request thừa mỗi lần bấm).
- [ ] T010 [P] Manual test trong browser: mở thread rỗng, bấm nút, xác nhận log server xuất hiện `Yêu cầu sync tin nhắn cho thread <đúng id>`. **Chưa chạy** — cần môi trường thật, giống các manual test còn treo của spec 041.

**Checkpoint**: Nút resync có tác dụng thật cho đúng hội thoại đang xem (theo đọc code; chờ xác nhận bằng mắt trên máy thật).

---

## Phase 4 — Validation & Regression

- [X] T011 `node --check` PASS trên `background.js`, `server.js`, `SidebarSyncCooldown.js`; `manifest.json` valid JSON (kiểm bằng `python3 -m json.tool`).
- [X] T012 `npx vite build` PASS (App.jsx hợp lệ), chỉ warning chunk-size không liên quan.
- [X] T013 `npm run test:persistence` — 330/330 PASS (4 test mới so với 326 trước đó của spec 041), không regression.
- [X] T014 Boot thử `node src/server/index.js` (timeout 6s) — DB init, CampaignRecovery, QueueWorker, HTTP+WS listen đều chạy sạch, không lỗi require/cú pháp. **Lưu ý quan trọng**: server thật của bạn đã đứng yên từ lần crash `cursor is not defined` trước đó (port 5050 đang rảnh) — cần bạn tự chạy lại `npm start` để test tiếp trên dữ liệu thật; phần rebind `extensionConnections`/reconnect thật chưa verify được bằng E2E trong môi trường này.
- [X] T015 `graphify update .` — 7689 nodes, 9061 edges, 648 communities.

## Dependencies

- Phase 0 → Phase 1, Phase 2, Phase 3: 3 phase độc lập, đã làm cùng lúc vì không đụng chung file.
- Phase 4 chạy sau cùng.
