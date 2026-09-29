## Kế hoạch sửa: Tin Page lần đầu ingest bị dán "giờ hôm nay" thay vì giờ thật (lỗ 2)

### Nguyên nhân gốc — đã xác minh từng dòng (không phải suy đoán)

| # | Lỗi | Vị trí |
|---|---|---|
| 1 | **Tự vô hiệu hóa chính nó**: khi container hội thoại là `role="region"`, dòng lọc `el.closest('[role="region"]')` trong bộ dò separator loại bỏ **100% ứng viên** (mọi phần tử trong container đều nằm trong region đó) → mảng separator luôn rỗng → nhánh gán giờ theo separator không bao giờ chạy | `page_content.js:885` |
| 2 | **Thiếu định dạng VN**: `26/09/2026` (DD/MM/YYYY) không khớp bộ regex nhận diện nào và `parseDateSeparator` không có rule slash-date; `"Thứ 2"` dạng số bị regex chỉ nhận chữ (Hai/Ba/Tư...) chặn ngoài | `page_content.js:891-895`, `pageTimestampParser.js:116-234` |
| 3 | **Neo độc `Date.now()`**: không có separator → `assignOrderedTimestamps` rơi vào nhánh zero-anchor dùng `Date.now()` backfill và **ghi vĩnh viễn vào `knownMessageTimestamps`** (chỉ-set-khi-chưa-có) → mọi lần crawl sau dùng anchor sai làm chuẩn | `page_content.js:839, 1082-1084` |
| 4 | **Upgrade không tự chạy**: `UPGRADE_MESSAGE_TIMESTAMP` chỉ phát khi **hover chuột** — crawl tự động không bao giờ trigger | `page_content.js:381-419` |

Chuỗi nhân quả: separator rỗng (1) + thiếu format (2) → zero-anchor neo giờ-cào (3) → mọi tin crawl lần đầu dán `dom_order` + giờ hôm nay → server insert nguyên bản (tin mới chưa có existing — đúng thiết kế, lỗ này đã ghi rõ trong plan 24/9) → hiển thị cả cụm lịch sử thành "Hôm Nay".

Điểm quan trọng: **không cần đụng server** — rank `separator_date_clock` (4) > `dom_order` (2), server ĐÃ cho phép upgrade đường này sẵn. Chỉ cần crawler gửi đúng giờ.

---

### Phase 1 — Sửa tầng bóc timestamp (extension)

| # | Việc | File |
|---|---|---|
| 1.1 | Bỏ `[role="region"]` khỏi chuỗi `closest()` loại-trừ trong `findDateSeparatorsInContainer` (giữ video/player guards — vùng quét đã bị giới hạn trong container hội thoại nên an toàn) | `page_content.js:885` |
| 1.2 | Thêm 2 regex nhận diện separator: DD/MM/YYYY (`26/09/2026`) + `"Thứ 2"` dạng số | `page_content.js:891-895` |
| 1.3 | `parseDateSeparator`: thêm rule parse DD/MM/YYYY (kèm/không kèm giờ) + giờ tương đối (`N phút`, `N giờ`, `N ngày`) | `pageTimestampParser.js:116-234` |
| 1.4 | **Chữa lành anchor map**: nhánh separator (B) ghi đè `knownMessageTimestamps` vô điều kiện (thay giá trị giờ-cào); `assignOrderedTimestamps` nhánh zero-anchor **không ghi** vào map (chỉ tính cục bộ giữ thứ tự) — để lần quét sau có separator thì tự chữa. Đồng bộ mirror `orderedTimestampAssigner.js` (KHÔNG port rule stale-anchor→now của mirror — rule đó gây drift-to-now) | `page_content.js:839-850, 1082-1084` |

### Phase 2 — Tự lành dữ liệu đã hỏng

| # | Việc |
|---|---|
| 2.1 | Reset `history_completed=0` cho các thread còn row `dom_order` (1 lệnh SQL có backup; hoặc nút "Đồng bộ lại" từng thread — nút này đã có sẵn và có reset flag) |
| 2.2 | Kích hoạt resync → crawl mới chạy với separator đã sửa → gửi `separator_date_clock` (rank 4) → server **tự upgrade** row `dom_order` (rank 2, đã cho phép) → `normalizeMessageSequence` sắp lại đúng |
| 2.3 | Acceptance: thread Đặng Thanh Nhàn — tin "Chỉ xác nhận kết bạn zalo..." về nhóm 27/09 (khớp BS "14:53 T7"); không còn cả khối lịch sử nằm dưới "Hôm Nay"; 0 nghịch đảo thời gian |

### Kiểm thử

1. Unit test mới: `parseDateSeparator` với "26/09/2026", "26/09/2026 14:53", "14:53 T7" (regression — đã parse đúng), "Thứ 2", "Hôm Nay" (regression), "2 giờ"; finder nhận diện DD/MM/YYYY + Thứ-2-số; zero-anchor không ghi map; separator overwrite map.
2. Full suite `node --test tests/unit/*.test.js` (574+) + mirror `orderedTimestampAssigner` test vẫn pass.
3. Syntax check + reload extension + restart server để chạy thật.

### Files

`page_content.js` (finder + Branch B + zero-anchor), `pageTimestampParser.js` (DD/MM/YYYY + relative), `orderedTimestampAssigner.js` (mirror đồng bộ), `tests/unit/*` (test mới), 1 lệnh SQL reset `history_completed`.

### Rủi ro & đường lùi

- Bỏ `[role="region"]` exclusion: đã phân tích — các region khác (panel phải) nằm ngoài container quét nên không bị nhặt; banner quảng cáo trong hội thoại quá dài (>50 ký tự) để lọt qua filter độ dài.
- Zero-anchor không ghi map: tin mới lần đầu vẫn mang giờ-cào ở lần ingest đó (không tránh được — BS chưa kịp render separator), nhưng **không còn neo vĩnh viễn** — lần quét kế separator đã render sẽ tự sửa qua rank 4>2.
- Không đụng server, không đụng DB schema; dữ liệu hỏng tự lành qua crawl lại.