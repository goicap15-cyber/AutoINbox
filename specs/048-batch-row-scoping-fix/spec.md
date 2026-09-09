# Feature Specification: Sửa Lỗi Gộp Nhiều Dòng Tin Nhắn Thành 1 (content.js)

**Feature Branch**: `048-batch-row-scoping-fix`

**Created**: 2026-08-20

**Status**: Root cause xác nhận bằng dữ liệu DB thật, đã code fix.

**Input**: User description: "cái thừa thãi và sai vị trí kia" — thread "Nhạc Phim Võ Thuật" hiển thị lẫn nội dung không phải tin nhắn thật (số người theo dõi trang, tên thể loại trang, nút "chi tiết cuộc trò chuyện") và tin nhắn thật bị lặp lại với chiều gửi sai.

## Root Cause — xác nhận bằng dữ liệu DB thật

Đối chiếu `fb_message_id` của 6 dòng bất thường trong thread `109426743817301`:

```
id 460  "2,1K người theo dõi Trang này"   -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_2
id 461  "Video ca nhạc"                    -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_3
id 462  "Chi tiết cuộc trò chuyện"         -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_4
id 463  "Xin chào, cảm ơn bạn..."          -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_8
id 464  "dâdad" (đã tồn tại từ trước)       -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_15
id 465  "kckxc" (đã tồn tại từ trước)       -> dom_109426743817301_mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc_17
```

Cả 6 dòng - hoàn toàn khác nhau về nội dung, một số là UI chrome (thẻ giới thiệu trang) chứ không phải tin nhắn - đều dùng chung **1 `native_id`** (`mid.$cAAA5cQuvqq2mRGiE_2gEyM0Lpipc`), chỉ khác nhau ở hậu tố `bubble_idx`. Cả 6 dòng cũng đều bị gán `is_outgoing=1` (sender_id = account tự thân), dù rõ ràng không phải tất cả đều do tài khoản tự gửi ("kckxc"/"dâdad" là tin nhắn CŨ đã có sẵn với chiều đúng ở id 55/56, nay bị đọc lại với chiều SAI).

Đọc đúng code (`content.js` dòng ~442, trước khi sửa):
```js
const messageRow = node.closest?.('div[role="article"]') || node.closest?.('div[role="row"]') || node;
```

Khi Facebook chèn 1 khối DOM lớn cùng lúc (mở hội thoại lần đầu trên profile Chrome mới — đúng tình huống đang test spec 046; về nguyên tắc cũng có thể xảy ra khi cuộn nhanh gây re-render lớn), `node` (phần tử MutationObserver báo thêm vào) có thể là **cả 1 khối chứa nhiều dòng tin nhắn**, không phải 1 dòng đơn lẻ. Khi đó `node.closest(...)` không tìm được ancestor `role="article"/row"` phù hợp (vì `node` NẰM TRÊN nhiều dòng, không nằm trong 1 dòng cụ thể), rơi vào fallback `|| node` — biến CẢ KHỐI LỚN thành "1 dòng" duy nhất. Từ đó:
- `nativeIdEl = messageRow.querySelector(...)` chỉ tìm thấy 1 phần tử ĐẦU TIÊN khớp trong cả khối, dùng làm `native_id` chung cho MỌI bubble bên trong.
- Toàn bộ nội dung `dir="auto"` trong khối (kể cả thẻ giới thiệu trang không phải tin nhắn) bị thu thập làm `leafBubbles`.
- Chiều gửi (`effectiveLabel`/`is_outgoing`) cũng chỉ tính 1 lần cho cả khối, áp dụng sai cho mọi bubble bên trong.

## Yêu cầu

- **FR-001**: Trước khi dùng `node` làm fallback "1 dòng" (khi không tìm được `.closest()` phù hợp), kiểm tra xem `node` có chứa **nhiều hơn 1** phần tử `[role="article"], [role="row"]` bên trong không. Nếu có, xử lý ĐỆ QUY từng dòng riêng biệt (gọi lại `parseMessagesFromDOMNode` cho từng dòng), gộp kết quả — thay vì gộp chung thành 1 dòng.
- **FR-002**: KHÔNG đổi hành vi khi `node` nằm trong đúng 1 dòng (tìm thấy qua `.closest()`) hoặc chứa 0-1 dòng lồng bên trong (trường hợp bình thường: 1 bubble/text-node được chèn riêng lẻ, ví dụ emoji tách thành nhiều span).
- **FR-003**: Dọn dữ liệu rác đã xác nhận trong thread `109426743817301` — 4 dòng UI-chrome-làm-tin-nhắn (id 460-463) + 2 dòng trùng lặp sai chiều (id 464, 465 — giữ lại tin gốc đúng chiều ở id 55/56).

## Success Criteria

- **SC-001**: Khi Facebook chèn 1 khối chứa nhiều dòng tin nhắn cùng lúc, mỗi dòng nhận đúng `native_id` và chiều gửi riêng của nó, không còn dùng chung `native_id`/chiều gửi với dòng khác.
- **SC-002**: Không regression — trường hợp 1 bubble/text-node đơn lẻ (không chứa nhiều dòng lồng nhau) vẫn hoạt động y như trước.

## Ghi chú về test

`parseMessagesFromDOMNode` phụ thuộc rất nhiều API DOM thật (`closest`, `querySelector`, `getBoundingClientRect`, `getComputedStyle`...) - theo đúng convention đã có của file này (không có unit test nào cho hàm này từ trước tới nay, kể cả trước spec 048), không viết unit test giả lập DOM đầy đủ cho lần sửa này vì chi phí mock không tương xứng với 1 thay đổi có phạm vi hẹp, được xác nhận bằng dữ liệu DB thật. Xác nhận qua: `node --check` PASS, `npm run test:persistence` không regression (374/374), và cần kiểm tra thật khi mở lại hội thoại có nhiều tin nhắn backlog.

## Out of Scope

- Không sửa `page_content.js` — chưa có bằng chứng thread Fanpage gặp đúng lỗi này (thread bị lỗi đang xét dùng `content.js`, xác nhận qua prefix `dom_` + native_id dạng `mid.$...`, không phải `page_content.js`'s pattern).
