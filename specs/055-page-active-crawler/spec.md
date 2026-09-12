# Feature Specification: Cơ Chế Cào Chủ Động (Active Crawler) An Toàn Cho Fanpage Meta Business Suite

**Feature Branch**: `055-page-active-crawler`

**Created**: 2026-09-11

**Status**: Ready for Plan & Implementation

**Input**: Kế thừa kỹ thuật cào chủ động từ Messenger cá nhân (chuỗi fallback `scrollBy`/`scrollTop` + `WheelEvent`, quan sát DOM growth, chờ loading spinner), kết hợp giải pháp phòng chống lỗi ảo hóa DOM (DOM Virtualization) của Meta Business Suite: tích lũy snapshot theo từng vòng (không chờ cuối), cuộn từng bước 70-85% viewport giữ neo overlap, khóa realtime leak guard, mutex coalescing chống race condition, tách riêng timeout Crawling vs ACK, và siết chặt boundary matching.

---

## 1. User Scenarios & Acceptance Criteria

### User Story 1 - Tải Trọn Vẹn Lịch Sử Tin Nhắn Cũ Của Fanpage Khi Cuộn Trên CRM (Priority: P1)

Là nhân viên trực chat CRM, khi tôi cuộn lên trên đỉnh khung chat của một hội thoại Fanpage, Extension trên tab Meta Business Suite phải chủ động cuộn ngược khung chat lên trên qua tối đa 3 vòng thích nghi, chờ Facebook tải dữ liệu cũ vào DOM, thu thập đầy đủ từng trang trung gian trước khi bị unmount, và gửi trọn vẹn về backend để hiển thị liên tục, không bị đứt đoạn hay mất tin.

**Acceptance Criteria**:
1. **Per-round Snapshot Accumulation**: Khi cuộn qua 3 vòng, mỗi vòng đều chụp snapshot ngay khi DOM vừa ổn định và đưa vào bộ tích lũy (`accumulator`). Ngay cả khi Facebook unmount các tin của trang 1 để mount trang 2, tất cả tin nhắn trung gian vẫn được lưu đầy đủ vào mảng kết quả cuối cùng.
2. **Safe Step-Scroll Overlap**: Mỗi bước cuộn chỉ lùi 70–85% chiều cao viewport (`0.75 * clientHeight`), không bao giờ nhảy thẳng về `scrollTop = 0`. Luôn giữ lại 2–4 tin nhắn phía dưới làm neo (overlap anchor) cho React Virtualizer.
3. **Adaptive Early Stop**: Nếu sau 1 vòng cuộn mà chiều cao `scrollHeight` không tăng VÀ ID của tin nhắn đầu tiên không thay đổi (không có dữ liệu mới), crawler dừng ngay lập tức, không cố cuộn tiếp các vòng thừa.
4. **Chạm Mốc Dừng (Boundary Reached)**: Nếu trong lúc cuộn phát hiện tin nhắn trùng với `cursor.oldest_message_id` đã lưu trong CRM, crawler dừng vòng lặp và hoàn tất batch.

---

### User Story 2 - Khóa Rò Rỉ Tin Lịch Sử Sang Realtime (Realtime Leak Guard) (Priority: P1)

Là lập trình viên hệ thống, tôi muốn khi Extension đang thực hiện cuộn chủ động kéo lịch sử cũ, vòng quét định kỳ 1 giây (`scanForMessages`) tuyệt đối KHÔNG được coi các tin lịch sử vừa xuất hiện là tin mới đến để bắn `NEW_PAGE_MESSAGE_FROM_DOM`.

**Acceptance Criteria**:
1. Khi bắt đầu crawl: bật cờ `crawlInProgress = true`.
2. Trong lúc `crawlInProgress === true`, mọi tin nhắn bóc tách từ DOM chỉ được đưa vào accumulator của batch lịch sử; cấm phát `NEW_PAGE_MESSAGE_FROM_DOM`.
3. Chỉ sau khi State Machine chuyển sang `READY`, cờ `crawlInProgress` được mở lại và chỉ các tin nhắn xuất hiện ở đáy chat sau mốc thời gian này mới được kích hoạt luồng realtime.

---

### User Story 3 - Chống Race Condition & Đổi Thread Giữa Chừng (Priority: P1)

Là người dùng thao tác nhanh, khi tôi cuộn liên tiếp nhiều lần hoặc bấm chuyển sang hội thoại khác ngay trong lúc Extension đang cuộn, hệ thống phải xử lý mượt mà, không bị xung đột tiến trình và không gửi nhầm tin của khách cũ sang khách mới.

**Acceptance Criteria**:
1. **Mutex / Coalescing**: Hai yêu cầu cuộn liên tiếp cho cùng một thread chỉ tạo một tiến trình crawler duy nhất.
2. **Emergency Cancel**: Trước và sau mỗi vòng cuộn, cũng như ngay trước khi gửi batch envelope: kiểm tra lại `resolveCurrentThreadId() === targetThreadId`. Nếu người dùng đã đổi sang thread khác hoặc iframe reload, hủy toàn bộ batch ngay lập tức, không gửi về backend.

---

### User Story 4 - Tách Biệt Timeout Crawling vs Awaiting ACK (Priority: P2)

Là hệ thống backend và client, thời gian crawler mất 1–2 giây để cuộn và đợi DOM không được tính vào thời gian timeout 10 giây chờ xác nhận ACK của State Machine.

**Acceptance Criteria**:
1. Thời gian tải DOM có timeout riêng cục bộ (tối đa 2.5s/vòng; spinner kẹt tối đa 3s).
2. Đồng hồ đếm ngược timeout 10 giây của State Machine CHỈ BẮT ĐẦU ĐẾM sau khi batch envelope đã được đóng gói và gửi qua socket/runtime.
