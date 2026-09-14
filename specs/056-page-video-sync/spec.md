# Feature Specification: Đồng Bộ Video Hai Chiều Cho Fanpage (Meta Business Suite)

**Feature Branch**: `056-page-video-sync`  
**Created**: 2026-09-14  
**Status**: Ready for Implementation  

---

## 1. User Scenarios & Testing

### User Story 1 - Xem Trực Tiếp Video Khách Gửi Trên Fanpage Tại CRM (Inbound) (Priority: P1)
Là nhân viên trực chat CRM, khi khách hàng gửi video (hoặc chia sẻ reel/video clip) trên Fanpage Facebook (Meta Business Suite), CRM phải thu thập được video đó, tự động tải về lưu trữ cục bộ và hiển thị trình phát video (`<video controls>`) trực tiếp trong khung chat CRM mà không bị lỗi ảnh trắng, không bị coi là text rỗng, và không làm gián đoạn luồng chat.

**Acceptance Scenarios**:
1. **Given** khách hàng gửi video trên Fanpage, **When** Meta Business Suite render thẻ `<video>` hoặc liên kết video, **Then** `pageVideoDetector.js` nhận diện chính xác `media_type: 'video'`, trích xuất `media_url` hoặc poster.
2. **Given** tin nhắn video được lưu vào DB với `media_type: 'video'`, **When** `InboundMediaHydrationService` chạy, **Then** video được tải về `data/media/inbound/<hash>.mp4` và trường `local_media_path` được cập nhật.
3. **Given** tin nhắn video đã tải xong hoặc có URL hợp lệ, **When** hiển thị trên UI CRM, **Then** `MediaViewer.jsx` render thẻ `<video controls>` cho phép nhân viên bấm play xem ngay trong CRM.

---

### User Story 2 - Gửi Video Từ CRM Lên Khách Hàng Trên Fanpage (Outbound) (Priority: P1)
Là nhân viên trực chat CRM, khi tôi chọn đính kèm file video (`.mp4`, `.mov`...) và bấm gửi tới khách hàng Fanpage, hệ thống phải tự động điều phối qua Chrome extension, chọn đúng nút đính kèm của Meta Business Suite, đưa file video vào composer qua CDP FileChooser, và gửi thành công tin nhắn video tới khách hàng.

**Acceptance Scenarios**:
1. **Given** nhân viên đính kèm file video (.mp4) trong khung soạn thảo CRM của hội thoại Fanpage, **When** bấm gửi, **Then** tin nhắn được xếp hàng vào outbox với `media_type: 'video'`.
2. **Given** extension nhận nhiệm vụ gửi video cho Page, **When** `stageBusinessSuiteAttachment` được gọi, **Then** `pageVideoUploader.js` tìm nút đính kèm với `preferredKind: 'video'`, kích hoạt CDP `Page.setInterceptFileChooserDialog`, và gán đường dẫn file video vào `DOM.setFileInputFiles`.
3. **Given** file video đã được gán vào composer của Business Suite, **When** Facebook hiển thị video chip / preview sẵn sàng, **Then** extension kích hoạt gửi tin nhắn và cập nhật trạng thái tin nhắn trên CRM thành `sent`/`delivered`.

---

### User Story 3 - Bảo Tồn Tính Toàn Vẹn Của Mã Nguồn Cũ (Safety & Isolation) (Priority: P1)
Là lập trình viên, toàn bộ logic nhận diện video và staging video cho Page phải được đặt trong các module riêng biệt (`pageVideoDetector.js`, `pageVideoUploader.js`), tuyệt đối không làm gãy các tính năng hiện tại của Fanpage như nút Like Thumbs Up vàng, sắp xếp chronology, hoặc gửi ảnh/text thông thường.

---

## 2. Requirements & Non-Functional Constraints
1. **Module Tách Biệt**:
   - `src/extension/pageVideoDetector.js`: Phát hiện video trong DOM của Page.
   - `src/extension/pageVideoUploader.js`: Staging và kiểm tra video upload trên Business Suite.
2. **Không phá vỡ `content.js` hoặc `page_content.js`**:
   - Các logic cũ về văn bản, like, emoji, ảnh vẫn được giữ nguyên.
3. **Độ trễ & Tài nguyên**:
   - Video tải ngầm không khóa luồng socket hoặc UI.
