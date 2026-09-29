## Kế hoạch sửa: Sync tin Page từ CRM bị chặn bởi "cổng xác minh danh tính" đọc nhầm (reproduce 2026-09-29)

### Chuỗi nguyên nhân — đã xác minh bằng log + code (không suy đoán)

| # | Lỗi | Vị trí |
|---|---|---|
| 1 | **Header reader nhặt label nút hành động làm "tên khách"**: `getVisibleBizContactNames` lấy mọi dòng text trong `[data-surface*="detail_column"]`, gồm cả "Chuyển đến thư mục Spam" (nút) — log: `thread_route_mismatch \| header="Chuyển đến thư mục Spam"` | `background.js:5928` |
| 2 | **Chờ quá ngắn cho hội thoại lạnh**: `verifyBizHeaderIdentity` poll chỉ 3.5s; thread chưa từng mở render tên trễ hơn → 3.5s hết trước khi tên xuất hiện | `background.js:5970` |
| 3 | **Đọc thread id từ URL/DOM thiếu tin cậy**: `getCurrentThreadIdInTab` đọc 1 lần duy nhất (URL `selected_item_id` → sidebar `aria-selected`); FB viết lại URL trễ → trả null/sai dù hội thoại đúng render | `background.js:5848` |
| 4 | **Cổng fail-closed**: cả 2 reader trượt → hủy quét có chủ đích ("Hủy sync để tránh ghi nhầm DB") → `thread_route_mismatch` → scanner không bao giờ chạy; observer lại đang bị tắt trong cửa sổ CRM-navigation → cả 2 đường đóng, tin mất sạch | `background.js:6415-6459` |
| 5 | **Server đóng cửa vĩnh viễn**: `thread_route_mismatch` / `extension_history_timeout` bị mark "lỗi vĩnh viễn, không tự retry" với cả thread msgs=0; click của user bị `defer=in_flight` khi lane bận; queue chảy 1 thread/120s | `server.js` (handler THREAD_MESSAGES_SYNCED) + InboxSyncScheduler |

Điều hướng + render KHÔNG phải vấn đề (user xác nhận tab tự chuyển đúng thread và render).

### Phase 1 — Sửa tầng xác minh danh tính (extension, `src/extension/background.js`)

| # | Việc | Chi tiết |
|---|---|---|
| 1.1 | Lọc label nút khỏi `getVisibleBizContactNames` | Loại candidate khớp `/^(chuyển đến thư mục|gán nhãn|đánh dấu|di chuyển|báo cáo|xóa|chỉnh sửa|gán|thêm)/i`; ưu tiên node `[role="heading"]`, `h1`, `h2` trong detail_column làm candidate đầu tiên |
| 1.2 | Kéo dài chờ hội thoại lạnh | `verifyBizHeaderIdentity` default 3500 → 10000ms (vẫn early-return khi match nên warm không chậm đi) |
| 1.3 | Retry đọc thread id | Block xác minh (~6415): đọc `getCurrentThreadIdInTab` tối đa 3 lần × 1s trước khi rơi xuống nhánh header (FB viết lại `selected_item_id` trễ) |
| 1.4 | Fail-open có kiểm soát (quyết định qua helper pure để test được) | `decidePageIdentityGate()`: (a) id khớp → OK; (b) id đọc ĐƯỢC nhưng khác → ABORT (giữ chống ghi nhầm); (c) id null + header có tên đọc được nhưng không khớp → ABORT; (d) id null + header chỉ toàn label nút/rỗng + `ensureTabOnThread` thành công → CHO QUÉT (fail-open). Case (d) chính là case đang chặn toàn bộ thread mới |
| 1.5 | Log đầy đủ khi ABORT/Fail-open | `route_detail` gửi kèm URL, extracted id, names thấy được — server log tự giải thích |

### Phase 2 — Server: mở cửa retry (src/server/server.js + InboxSyncScheduler)

| # | Việc |
|---|---|
| 2.1 | `thread_route_mismatch` / `extension_history_timeout` với thread **msgs=0** → KHÔNG mark vĩnh viễn; retry tối đa 3 lần, backoff 2 phút. Thread đã có dữ liệu giữ nguyên chính sách cũ |
| 2.2 | Nhận `PAGE_EXTENSION_READY` của page X → xả các item defer/failed của lane page:X |
| 2.3 | (sau khi 1.x làm extension fail nhanh) cân nhắc giảm timeout 120s → 60s |

### Phase 3 — Tự lành dữ liệu đã kẹt

- Restart server + reload extension → hàng đợi initial_sweep tự quét lại các thread msgs=0 (chính sách 2.1 cho phép retry).
- Acceptance: **Vung Vu Vuong (`61590080080135`) / Tuyến Thanh — bấm "Đồng bộ lại hội thoại" trong CRM → tin về trong ≤30s mà không cần bấm tay vào Business Suite**; thứ tự tin đúng (fix reconcile DOM 28/9 giữ nguyên); lane page:768 không còn chuỗi timeout 120s.

### Kiểm thử

1. Unit test mới cho `decidePageIdentityGate` (4 nhánh a-d) + filter label nút trong `getVisibleBizContactNames` (pure parts tách ra để test).
2. Full suite `node --test tests/unit/*.test.js` (579+ pass hiện tại) — không làm gãy gì.
3. Syntax check + reload extension + restart server.

### Files

`src/extension/background.js` (5928, 5970, 5848, 6415-6459), `src/server/services/InboxSyncScheduler.js` hoặc `src/server/server.js` (chính sách retry + drain), `tests/unit/` (test mới). **Không đụng**: fix reconcile DOM 28/9, WIP khác trên branch.

### Rủi ro & đường lùi

- Fail-open case (d) về lý thuyết có thể quét nhầm nếu CẢ id reader và header reader đều "mù" nhưng tab đang render sai thread — xác suất thấp (ensureTabOnThread đã kiểm URL trước đó); giảm thiểu bằng log đầy đủ + chỉ áp cho header "không đọc được", không áp cho header "đọc được nhưng khác tên".
- Đường lùi: fail-open đặt sau cờ bật/tắt (env var) để tắt tức thì nếu có sự cố.
- Không đụng DB, không đụng schema.
