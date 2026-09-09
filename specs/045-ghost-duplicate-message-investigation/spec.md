# Feature Specification: Ghost Duplicate Messages From Unstable Direction Detection

**Feature Branch**: `045-ghost-duplicate-message-investigation`

**Created**: 2026-08-20

**Status**: Đã code fix + test + cleanup DB (FR-004) (xem `tasks.md`). Chỉ còn thiếu test thật trên máy để xác nhận cuối cùng.

**Input**: User description: "Soi DB thread 969878666067566 thấy mỗi tin nhắn thật đều có kèm 1-2 dòng 'bóng ma' trùng giờ, nội dung bị cắt cụt hoặc trùng y hệt nội dung thật, nhưng is_outgoing bị đảo ngược so với tin thật."

## Root Cause — xác nhận chắc chắn, không còn là giả thuyết

Đối chiếu `fb_message_id` của cả tin thật lẫn "bóng ma" trong DB (`sqlite3 data/database.db`), TẤT CẢ đều dùng chung 1 định dạng `dom_<thread_id>_<stableId>_<bubble_idx>` — nghĩa là **cả tin thật và bóng ma đến từ cùng một cơ chế duy nhất**: bộ quét DOM real-time trong `content.js` (`parseMessagesFromDOMNode` + `makeDomMessageId`), KHÔNG phải 2 pipeline khác nhau (crawler lịch sử dùng prefix `fb_sync_`, khác hẳn).

Đọc đúng code sinh ID và code chống trùng (`content.js:661-669` và `content.js:727-743`):

```js
// content.js:661-669 — is_outgoing nằm trong input của hash sinh ID
function makeDomMessageId(thread_id, parsed) {
  const strToHash = `${thread_id}|${parsed.is_outgoing}|${parsed.sender_name}|${parsed.content}|${parsed.effective_label}`;
  // ... hash strToHash ...
  return `dom_${thread_id}_${stableId}_${parsed.bubble_idx}`;
}

// content.js:733, 739-743 — CẢ 2 lớp chống trùng đều có is_outgoing trong key
const domDedupeKey = `${thread_id}:${parsed.content}:${parsed.is_outgoing}`;   // debounce 800ms
...
const fbMessageId = makeDomMessageId(thread_id, parsed);                      // dedup dài hạn
if (lastObservedMessages.has(fbMessageId)) return;
```

**Vấn đề**: `MutationObserver` có thể bắt cùng 1 tin nhắn thật **nhiều lần** (DOM render nhiều bước: node vừa chèn với layout/attribute chưa đầy đủ → sau đó ổn định; hoặc Facebook re-render/di chuyển node). Nếu ở 2 lần quét, `parsed.is_outgoing` tính ra **khác nhau** cho cùng 1 tin (chiều gửi bị "lật" giữa 2 lần quét) — thì **cả 2 lớp chống trùng đều không phát hiện được**, vì cả `domDedupeKey` lẫn `fbMessageId` đều tính `is_outgoing` vào trong khoá. Kết quả: 1 tin nhắn thật bị lưu thành **2 dòng khác nhau trong DB**, 1 dòng đúng chiều, 1 dòng "bóng ma" sai chiều — đúng khớp 100% với dữ liệu quan sát được (Dạng B, ví dụ id 98 ↔ 404).

Với Dạng A (nội dung bị cắt cụt kiểu `"56ch"`, `"41ch"`, `"20sáng"`) — cùng cơ chế, nhưng lần quét bị lỗi ĐỒNG THỜI cả `content` (đọc trúng 1 mảnh text khác, có vẻ là mảnh nhãn giờ "HH:MM sáng/chiều" bị cắt) lẫn `is_outgoing` — nên hash cũng khác, cũng lọt qua chống trùng.

## Vì sao ràng buộc UNIQUE(fb_message_id) không chặn được

Vì `is_outgoing` (và đôi khi `content`) là **input của chính hàm sinh ID**, hai lần quét cho "cùng một khoảnh khắc" nhưng khác chiều/khác content sẽ sinh ra **hai ID khác nhau ngay từ đầu** — UNIQUE constraint không có cơ hội phát huy tác dụng vì về mặt kỹ thuật đây là "2 bản ghi khác nhau", dù về bản chất là cùng 1 sự kiện.

## Yêu cầu cho bản vá (Requirements — thực hiện ở vòng implement tiếp theo)

- **FR-001**: Input của `makeDomMessageId` KHÔNG được dùng `is_outgoing`/`sender_name`/`effective_label` làm một phần của khoá sinh ID dài hạn — chỉ dựa vào `(thread_id, content)` khi không có `native_id`. **Đã tinh chỉnh khi implement**: `domDedupeKey` (debounce 800ms ngắn hạn) CỐ Ý giữ nguyên `is_outgoing` trong khoá — xem lý do ở `tasks.md` T003 (nếu bỏ, 1 lần quét sửa đúng chiều đến trong vòng 800ms sau lần quét sai sẽ bị chính debounce này chặn, không tới được tầng dedup dài hạn để kích hoạt hysteresis). Đồng thời phát hiện thêm: `nativeIdEl` ở `content.js` thiếu ưu tiên `[data-message-id]` (đã có ở spec 043 cho `background.js`) — đây mới là nguyên nhân gốc khiến hash fallback phải dùng tới thường xuyên; đã bổ sung.
- **FR-002**: Khi phát hiện 2 lần quét cùng 1 "sự kiện" (theo khoá mới ở FR-001) nhưng `is_outgoing` khác nhau, hệ thống PHẢI coi đây là **cùng 1 tin nhắn cần xác nhận lại chiều**, không phải 2 tin nhắn — có thể áp dụng theo hướng "lần quét sau ổn định hơn thì được ưu tiên" (tương tự tinh thần spec cũ `019-direction-flip-hysteresis` đã có, cần đọc lại spec đó để không làm trùng/mâu thuẫn công sức cũ).
- **FR-003**: Không được phá vỡ khả năng phân biệt 2 tin nhắn TRÙNG NỘI DUNG thật sự khác thời điểm/khác chiều (ví dụ khách và mình cùng gõ "ok" ở 2 thời điểm khác nhau) — khoá chống trùng mới vẫn cần yếu tố thời gian đủ hẹp (giữ nguyên cửa sổ 800ms cho debounce ngắn hạn; với `lastObservedMessages` cần cân nhắc thêm mốc thời gian vào khoá thay vì chỉ bỏ `is_outgoing` trơ trọi).
- **FR-004**: Dọn dữ liệu — sau khi có bản vá, cần 1 script/one-off cleanup quét toàn bộ bảng `messages` tìm các cặp `(thread_id, content hoặc content rút gọn, cùng phút, is_outgoing khác nhau)` để xoá bóng ma còn sót lại từ trước khi vá (không tự động xoá ở spec này — cần review thủ công trước khi chạy trên dữ liệu thật, vì nguy cơ xoá nhầm nếu 2 người thực sự cùng gõ trùng nội dung).
- **FR-005**: Đã đọc `specs/019-direction-flip-hysteresis/` — spec đó xử lý đúng loại vấn đề "chiều bị lật", nhưng ở **tầng khác và tình huống khác**: `ConversationRepository.reconcileExistingMessage()` (server-side) chỉ chạy hysteresis khi 2 lần quét trả về **CÙNG MỘT `fb_message_id`** nhưng khác `is_outgoing`. Bug ở đây xảy ra **trước** bước đó — vì `is_outgoing` nằm trong input sinh `fb_message_id` (`content.js`), 2 lần quét khác chiều sinh ra **2 ID khác nhau ngay từ đầu**, nên không bao giờ chạm tới `reconcileExistingMessage` để hysteresis có cơ hội xử lý — mỗi ID được coi là tin nhắn mới hoàn toàn. Không được tưởng nhầm spec 019 đã che phủ trường hợp này — cần fix riêng ở `content.js` (loại `is_outgoing` khỏi khoá sinh ID/chống trùng, theo FR-001), việc CÒN LẠI (nếu vẫn có sai lệch chiều sau khi ID đã ổn định) mới nhường lại cho cơ chế hysteresis sẵn có xử lý tiếp.

## Success Criteria

- **SC-001**: Với 1 kịch bản giả lập "MutationObserver bắt cùng 1 message node 2 lần, lần 2 tính is_outgoing khác lần 1", hệ thống chỉ tạo **1** dòng `NEW_MESSAGE_FROM_FB` (hoặc dòng thứ 2 được xử lý như "sửa chiều" thay vì "tin mới").
- **SC-002**: Không regression: 2 tin nhắn có nội dung giống hệt nhau nhưng thời điểm/chiều thực sự khác nhau (không phải do 1 node bị quét 2 lần) vẫn được lưu thành 2 dòng riêng biệt.
- **SC-003**: Sau cleanup dữ liệu cũ (FR-004), thread `969878666067566` không còn dòng nào có content dạng `"NNch"/"NNsáng"` hay trùng y hệt nội dung thật nhưng đảo `is_outgoing`.

## Out of Scope (spec này)

- Chưa code fix — đây là kế hoạch/spec để duyệt trước.
- Chưa chạy cleanup dữ liệu cũ (FR-004) — cần làm sau khi fix xong và được duyệt riêng.
- Không đụng tới `page_content.js`/crawler lịch sử (`background.js`) — dựa trên bằng chứng ID prefix, bug này nằm gọn trong `content.js`'s DOM observer, không lan sang các cơ chế khác (dù về nguyên tắc nên rà soát `page_content.js` xem có cùng lỗi thiết kế hay không ở 1 vòng riêng, chưa nằm trong spec này).
