# Feature Specification: Sửa Lỗi Thứ Tự Tin Nhắn Bị Đảo Lộn (page_content.js)

**Feature Branch**: `047-page-timestamp-ordering-fix`

**Created**: 2026-08-20

**Status**: Root cause xác nhận bằng số liệu thật, đã code fix.

**Input**: User description: "tin nhắn hiển thị sai vị trí, có thể sẽ bị đảo lộn vị trí của tin mới và tin cũ" + "Thứ tự tin nhắn bên trong 1 hội thoại" (chat qua Fanpage/Business Suite, dùng `page_content.js`).

## Root Cause — đã tự sửa lại 1 giả thuyết sai trước khi chốt

**Giả thuyết ban đầu (SAI, đã rút lại)**: nghi ngờ tin nhắn "backlog" (mới mở hội thoại) bị gán `timestamp_ms=0` vĩnh viễn. Kiểm tra kỹ 7 dòng `timestamp_source='unknown'` thật trong DB thì thấy `fb_message_id` của chúng có prefix `pending_queue_*` — 1 CƠ CHẾ HÀNG ĐỢI CŨ, grep toàn bộ `src/` xác nhận chuỗi này **không còn tồn tại trong code hiện tại** (đã bị thay bằng `pending_<client_message_id>` từ lâu). Đây là dữ liệu rác còn sót từ code cũ, không phải bug đang sống — đã kiểm tra 6 dòng dùng đúng scheme `pending_` hiện tại thì timestamp đều đúng, không bị kẹt ở 0.

**Root cause THẬT (đã xác nhận bằng số liệu, không phải suy đoán)**: `assignOrderedTimestamps()` trong `page_content.js` (dòng ~262-309) gán "giờ giả" cho tin nhắn không có mốc thời gian rõ ràng, bằng cách neo (extrapolate) theo mốc giờ ĐÃ BIẾT gần nhất (`lastKnownTs + ORDER_GAP_MS * khoảng_cách`), nhưng **không có giới hạn "đừng lùi quá xa so với giờ thật hiện tại"**. Bằng chứng thật từ DB (thread `100092115712908`):

```
Tin nhắn id=125, content="alolaol đây là test lần 2"
- created_at (giờ chụp THẬT)     : 2026-08-19T09:33:00.355Z
- timestamp_ms được gán (giờ GIẢ) : 1787114507489 = 2026-08-19T04:41:47.489Z
→ lệch gần 5 TIẾNG so với giờ chụp thật
```

Cơ chế: khi hội thoại được mở lại sau nhiều giờ, mốc `knownMessageTimestamps` (bộ nhớ tạm trong session) chỉ còn giữ 1 mốc CŨ (từ ~04:42, lần cuối có anchor thật). Tin nhắn mới (thật sự xảy ra lúc 09:33) không có mốc `nextKnownTs` nào ở phía sau (vì đây là tin mới nhất, đứng cuối `orderedIds`), nên code rơi vào nhánh `assigned = lastKnownTs + ORDER_GAP_MS * (i - lastKnownIdx)` — **neo theo mốc CŨ đã 5 tiếng tuổi** thay vì nhận ra mốc đó đã quá cũ và nên dùng `Date.now()` làm nền. Do nhiều tin nhắn khác nhau, chụp ở các session cách nhau hàng giờ, cùng neo theo 1 mốc cũ như nhau → timestamp giả của chúng chồng lấn/lộn xộn lẫn nhau → khi `ORDER BY timestamp_ms ASC` hiển thị, thứ tự tin nhắn thật bị đảo lộn đúng như người dùng báo cáo.

## Phát hiện phụ (cùng lớp lỗi với "20 Tháng 4"/"cá nhân hóa" đã fix trước đó)

Trong lúc điều tra, thấy thêm 2 dòng rác dạng dải phân cách ngày chưa được lọc: `"Thứ Ba"` (thứ trong tuần) và `"Hôm nay"` (nhãn ngày tương đối) — cùng họ với `"20 Tháng 4"` đã fix ở spec trước, chỉ khác định dạng. Vá luôn trong spec này vì cùng cơ chế fix, chi phí thấp.

## Yêu cầu

- **FR-001**: Trong `assignOrderedTimestamps()`, khi extrapolate FORWARD từ `lastKnownTs` mà KHÔNG có `nextKnownTs` phía sau (tức đây là các tin gần cuối/tin mới nhất đang hiển thị), nếu `lastKnownTs` đã cũ hơn 1 ngưỡng hợp lý so với `Date.now()` (đề xuất: 5 phút — đủ dài để không đụng vào tin nhắn thật sự đến dồn dập, đủ ngắn để bắt được đúng trường hợp "mốc cũ hàng giờ"), chuyển sang neo theo `Date.now()` thay vì mốc cũ.
- **FR-002**: KHÔNG đổi nhánh extrapolate BACKWARD (từ `nextKnownTs`, dùng cho tin nhắn cuộn lên xem lịch sử cũ) và nhánh interpolate GIỮA 2 mốc đã biết — 2 nhánh này giữ đúng thứ tự tương đối dù giá trị tuyệt đối có thể chưa hoàn hảo, không có bằng chứng chúng gây lỗi.
- **FR-003**: Thêm pattern lọc `"Thứ Hai/Ba/Tư/Năm/Sáu/Bảy"`, `"Chủ Nhật"`, `"Hôm nay"`, `"Hôm qua"`, `"Today"`, `"Yesterday"` (dải phân cách ngày dạng ngắn) vào `page_content.js` (chặn tại nguồn, giống fix "20 Tháng 4") và cả 3 bản filter dùng chung (`textFilter.js` x2, `background.js` inline).
- **FR-004**: Dọn dữ liệu rác cũ đã xác nhận — xoá 2 dòng "Thứ Ba"/"Hôm nay" đã lưu sẵn trong DB (sau khi người dùng xác nhận riêng, theo đúng thông lệ dự án).

## Success Criteria

- **SC-001**: Tin nhắn mới chụp trong vòng 5 phút gần đây không bao giờ được gán timestamp giả lùi quá 5 phút so với `Date.now()` khi không có mốc `nextKnownTs`.
- **SC-002**: Test đơn vị mô phỏng đúng kịch bản bằng chứng thật (mốc cũ 5 tiếng, tin mới đến) xác nhận timestamp gán ra nằm gần `Date.now()`, không lùi về mốc cũ.
- **SC-003**: Không regression — tin nhắn cuộn lên xem lịch sử cũ (extrapolate backward) vẫn giữ nguyên hành vi.

## Out of Scope

- Không sửa cơ chế seeding/race (`seedTimestampAnchorsForThread` fire-and-forget) — bằng chứng cho thấy lỗi staleness tự nó đã đủ giải thích triệu chứng quan sát được, không cần đổi thêm phần này.
- Không đụng `content.js` (Messenger cá nhân) — cơ chế timestamp ở đó khác hẳn (dựa vào label giờ Facebook hiển thị, không dùng `dom_order`/`ORDER_GAP_MS`).
