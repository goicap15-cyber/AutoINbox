## Kế hoạch: Activate tab + sửa đồng hồ lệch khi quét tin Page (reproduce 2026-09-29, console SW)

### Chẩn đoán từ console service worker (bằng chứng trực tiếp)

- **Đường ống CÀO ĐƯỢC THẬT**: console SW chụp được `PAGE_THREAD_MESSAGES_SYNCED_V1` → `PAGE_BATCH_ACK {status:"committed", persisted_count:6}` cho thread 100010445624552 (page 1308, "Nguyen Tonga") — 6 tin đã vào CRM khi tab đang nền.
- **Nhưng chậm 20–40s/thread** vì tab quét là tab NỀN (`active:false`, pinned) — Chrome throttle render → deadline 18s của extension NỔ TRƯỚC khi xong, bắn `extension_history_timeout` **cho cả scan đang thành công** (log: deadline fire tại dòng 205-213 SAU khi batch commit ở 192-196) → server mark FAILED → retry thread trắng → quét lại → hàng đợi phình.
- **Thread user bấm (Nguyễn Thị Hòa, page 981)** chờ sau 4-5 item × 20-40s → server timeout 120s trước khi tới lượt → `crm_navigation_replay`.
- Không liên quan điều hướng sai hay scanner hỏng — tab đúng đã được điều hướng, batch đúng đã về.

### Phase 1 — Extension: activate tab của page trước khi quét (`background.js`)

- Trong `handleSyncThreadMessages`, sau khi lấy `tab` cho page thread và **trước `ensureTabOnThread`**:
  `chrome.tabs.update(tab.id, { active: true })` + `chrome.windows.update(tab.windowId, { focused: true })` (`.catch(()=>{})` cả hai, chỉ cho nhánh `page_id`).
- Mục đích: bỏ throttle render của tab nền → chu kỳ 20-40s xuống ~5-10s → mọi deadline dư dả. Như user đề xuất: "vừa chuyển tab vừa chuyển vô đúng cuộc hội thoại" (điều hướng hội thoại đã có sẵn trong `ensureTabOnThread`).
- Phạm vi: chỉ page thread (page_id có mặt). Messenger cá nhân giữ nguyên luồng cũ.

### Phase 2 — Extension: sửa đồng hồ lệch (`background.js`)

| # | Việc |
|---|---|
| 2.1 | `runPersonalHistoryWithDeadline`: timeout `initial` 18s → **45s**, `older` 30s → **60s** (vẫn < server 120s). Deadline là để nhả lane, không phải cắt scan |
| 2.2 | **Chống báo giả thất bại**: track `pageBatchSeenAt` (Map thread_id → timestamp) cập nhật tại nơi relay `PAGE_THREAD_MESSAGES_SYNCED_V1` (~1920s). Khi deadline nổ: nếu batch của thread này đã về trong khoảng từ lúc op start → **không gửi** `extension_history_timeout`, chỉ nhả lane im lặng (scan còn sống, batch tự hoàn tất) |
| 2.3 | Giữ nguyên mọi nhánh báo lỗi khác (route_mismatch, locked...) |

### Phase 3 — Server: ưu tiên click của user (`InboxSyncScheduler.js`)

- Khi enqueue item có reason `crm_navigation` / `crm_navigation_replay` → **chèn đầu hàng đợi lane** thay vì append (cần đọc cấu trúc queue trước khi vá — vùng 430-560).
- Hiệu quả: thread user bấm luôn xử lý trước đám initial_sweep; cùng với Phase 1+2, click → tin về trong ~10-30s.

### Kiểm thử & chấp nhận

1. Full suite `node --test tests/unit/*.test.js` (587 pass hiện tại) phải giữ xanh; syntax check cả 3 file.
2. Chấp nhận thật: bấm "Đồng bộ lại hội thoại" trên **Nguyễn Thị Hòa** (page 981) → tab BS tự nhảy sang page Dr Lê + mở đúng hội thoại → tin về CRM trong ≤30s; nhìn thấy tab nhảy là bình thường.
3. "Nguyen Tonga" (page 1308) đã có 6 tin — chứng nhận đường ống.

### Files

`src/extension/background.js` (activation ~6366-6380; deadline 221-239; relay batch ~1920s), `src/server/services/InboxSyncScheduler.js` (enqueue priority). Không đụng: reconcile DOM 28/9, identity gate + cold-retry 29/9 sáng, WIP khác.

### Rủi ro & đường lùi

- Màn hình nhảy tab khi quét — chấp nhận có chủ đích (user đề xuất); chỉ page-lane mới activate.
- Deadline dài hơn → lane kẹt thật bị giữ lâu hơn → server 120s vẫn chốt trên; guard 2.2 loại báo giả.
- Queue priority làm initial_sweep chậm hơn khi user click liên tục — đúng mong muốn (user first).
