## Kế hoạch sửa: Re-stamp giờ cào lên tin cũ + mất caption media Page

### Chẩn đoán đã xác minh (file:line)

**Bug 1 — Tin cũ bị re-stamp giờ cào rồi trôi xuống cuối thread:**
- `shouldUpgradeTimestamp` (`ConversationRepository.js:847`): chỉ chặn drift cho `realtime_fallback/realtime_delta`; **`dom_order → dom_order` chênh ≥30s vẫn được phép upgrade** (đúng logic dòng 861-864: `Math.abs(newTs-oldTs) >= 30000 → true`). Crawl mới lúc 02:19-02:21 24/09 đã ghi đè giờ thật của tin 19/09 → sort đưa xuống cuối.
- `sequence_order = excluded.sequence_order` (dòng ~1148, mệnh đề ON CONFLICT của page batch) — ghi đè **vô điều kiện**, không gate theo canUpgrade (timestamp thì có gate ✅).

**Bug 2 — Caption "ảnh"/"video" mất:**
- Extension **có** gửi caption: `collectMountedBatchMessages` dòng 1087 `text = isMedia ? resolved.caption : resolved.text` — caption chảy vào content ✅.
- **Server tự tay xóa**: `ConversationRepository.js` ~dòng 1169-1174 — content video mà `=== 'video'` (chữ thường) → **null**! Giết chết caption hợp lệ mang tên "video". Kèm bộ GLOC duration ở mệnh đề ON CONFLICT 1130-1140 có thể xóa thêm.
- Ảnh: caption đi qua `cleanMessageText` (extension) — cần verify "ảnh" có bị coi là junk không; nếu container ảnh không bọc caption (caption là element sibling ngoài `[data-message-id]`) thì rawText không chứa caption → content rỗng.

**Dữ liệu hỏng**: 8 row media (seq 96-103, `dom_order`, stamp 02:19-02:21 24/09) — mid cho biết đây là tin test 19/09, giờ thật không thể phục hồi từ DB (đã drift qua nhiều lần crawl). **Giả thuyết có khả năng cao: timestamp thật được nhúng trong payload base64 của `mid.$`** (cần verify lúc implement — plan mode chặn chạy test).

---

### Fix 1 — Chặn drift `dom_order` (server, `ConversationRepository.js`)
- `shouldUpgradeTimestamp`: thêm `dom_order` vào nhóm cấm-drift (như `realtime_fallback/delta`) — `dom_order` **không bao giờ upgrade** timestamp đã tồn tại (kể cả cùng rank, kể cả chênh >30s). Vẫn cho phép: existing `unknown`/0 → nhận `dom_order`; existing rank thấp hơn → rank cao hơn (tooltip/separator) upgrade bình thường.
- Gate `sequence_order` theo canUpgrade: khi `canUpgrade = 0` → `sequence_order = messages.sequence_order` (giữ chỗ cũ), tránh xáo trộn giữa 2 lần normalize.

### Fix 2 — Cứu caption (2 tầng)
- **Server**: bỏ điều kiện `content.trim().toLowerCase() === 'video'` → null (giữ lại duration-GLOB vì đó là rác thật: "0:00 / 0:19"); đảm bảo caption "video"/"ảnh" được lưu vào content của media.
- **Extension**: verify `cleanMessageText("ảnh")` không bị strip (nếu bị, thêm allowlist cho caption); nếu caption là sibling nằm NGOÀI `[data-message-id]` container — mở rộng `resolveMessageContent` đọc caption element liền kề dưới media (giới hạn 1 element kế tiếp, cùng parent) và gán vào caption thay vì bỏ qua.
- Unit test: content "video"/"ảnh" sống sót qua ingest; duration "0:19" vẫn bị lọc.

### Fix 3 — Repair dữ liệu đã hỏng (mở rộng `scripts/repair-thread-sequence.js`)
- **Bước verify-first**: viết mid-decoder (decode base64 payload, quét epoch 4-byte) — **chỉ tin nếu** ≥80% các row có timestamp tin cậy cao (tooltip/separator) khớp với mid-decoded (±24h). Nếu đạt → re-stamp toàn bộ row `dom_order` bằng giờ mid-decoded (nguồn giờ thật của Facebook!).
- Nếu verify KHÔNG đạt → fallback: chỉ re-normalize thứ tự theo giờ hiện có + log cảnh báo các row drift không phục hồi được.
- Chạy repair trên **bản sao DB** trước, đối chiếu acceptance (5-block thread Phạm Hùng + 0 inversion + media 96-103 quay về đúng vị trí giữa hội thoại), rồi mới chạy trên DB thật (server STOP).

### Thứ tự triển khai & kiểm thử
1. Fix 1 + Fix 2 (code) → unit tests → `node --test tests/unit/*.test.js` (564+) → `build:ui` không cần (không đụng client).
2. Repair trên bản sao → verify → backup DB thật → repair thật → query acceptance cuối.
3. `graphify update .`

### Files
`ConversationRepository.js` (shouldUpgradeTimestamp + ON CONFLICT + caption null-out), `page_content.js` (caption sibling, nếu cần), `textFilter.js` extension (nếu "ảnh" bị strip), `scripts/repair-thread-sequence.js` (mid-decode + re-stamp), `tests/unit/*` (2-3 test mới).

### Rủi ro & đường lùi
- Fix 1 có thể làm tin mới (chưa từng có) vẫn nhận giờ cào ban đầu — chấp nhận được vì lần ingest sau khi tooltip khả dụng sẽ upgrade lên (rank cao hơn vẫn được phép).
- Repair mid-decode có verify-first: không đạt thì không đụng dữ liệu.
- Backup DB + dry-run bản sao như mọi lần.