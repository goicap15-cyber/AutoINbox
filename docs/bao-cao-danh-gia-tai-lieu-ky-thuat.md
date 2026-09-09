# BÁO CÁO ĐÁNH GIÁ HIỆN TRẠNG TÀI LIỆU KỸ THUẬT

**Dự án:** FB Personal Messenger CRM  
**Ngày đánh giá:** 06/09/2026  
**Mục đích:** Đánh giá mức độ đầy đủ của tài liệu kỹ thuật phục vụ phát triển, vận hành và bàn giao dự án.

## 1. Tóm tắt điều hành

Dự án đã có nền tảng tài liệu tương đối phong phú theo từng tính năng, bao gồm tài liệu yêu cầu, kế hoạch triển khai, mô hình dữ liệu và hợp đồng kỹ thuật cục bộ. Tuy nhiên, tài liệu hiện phân tán tại nhiều thư mục và phần lớn phản ánh kế hoạch tại từng thời điểm, chưa hình thành một bộ tài liệu kiến trúc chuẩn hóa, cập nhật theo trạng thái code hiện tại.

Rủi ro lớn nhất không nằm ở việc thiếu mô tả tính năng, mà ở việc thiếu một nguồn thông tin thống nhất giúp thành viên mới nhanh chóng hiểu được kiến trúc đang vận hành, trách nhiệm của từng module, quan hệ dữ liệu và quy chuẩn giao tiếp giữa các thành phần.

## 2. Những tài liệu đã có

- Tài liệu tổng quan và hướng dẫn chạy cơ bản trong `README.md`.
- Tài liệu yêu cầu và kế hoạch tổng thể trong `spec.md`, `plan.md` và `implementation_plan.md`.
- Tài liệu chi tiết theo từng tính năng trong thư mục `specs/`.
- Các hợp đồng kỹ thuật cục bộ cho một số tính năng trong các thư mục `contracts/`.
- Schema SQLite và các thành phần truy cập dữ liệu trong `src/server/database/` và `src/server/repositories/`.
- Hệ thống unit test và integration test cho nhiều nghiệp vụ quan trọng.
- Tài liệu hệ thống giao diện trong `docs/design-system.md`.

## 3. Các nội dung còn thiếu hoặc chưa hoàn chỉnh

### 3.1. Sơ đồ kiến trúc tổng thể hiện tại — Mức ưu tiên: Rất cao

Cần một sơ đồ phản ánh đúng hệ thống đang chạy, bao gồm Electron Desktop, React UI, Express/Socket.IO Backend, SQLite, Process Manager, Chrome Profile, Chrome Extension và Facebook/Messenger.

Sơ đồ cần thể hiện rõ:

- Kênh giao tiếp giữa UI và Backend.
- Kênh WebSocket giữa Extension và Backend.
- Quan hệ giữa một tài khoản Facebook, Chrome profile và các tab chức năng.
- Cách Personal Messenger và Page Messenger được phân luồng.
- Các dịch vụ bên ngoài như License Server, AI Cloud và Ollama.

### 3.2. Danh mục module và trách nhiệm — Mức ưu tiên: Rất cao

Chưa có một tài liệu tập trung mô tả trách nhiệm, đầu vào, đầu ra và phụ thuộc của từng module. Tối thiểu cần bao phủ:

- ProcessManager, AccountService và InboxSyncScheduler.
- HistorySyncManager và HistorySyncRetryPolicy.
- QueueWorker, OutboundMessageService và các module xác nhận gửi.
- CampaignRunner và các dịch vụ Campaign.
- AIMediator, AutoReplyEngine và các AI Connector.
- EnterpriseAccessService và hệ thống phân quyền.
- Extension background.js, content.js và page_content.js.

### 3.3. ERD theo database thực tế — Mức ưu tiên: Rất cao

Các mô hình dữ liệu trong tài liệu kế hoạch chưa phản ánh đầy đủ schema hiện tại. Cần sinh ERD trực tiếp từ database/schema đang sử dụng và mô tả:

- Primary key, foreign key và unique constraint.
- Quan hệ 1–1, 1–n và n–n.
- Quy tắc cascade và vòng đời dữ liệu.
- Các index ảnh hưởng tới hiệu năng.
- Phân biệt ID nội bộ với ID do Facebook cung cấp.

### 3.4. Sequence diagram cho các luồng chính — Mức ưu tiên: Cao

Cần bổ sung sơ đồ tuần tự cho:

- Thêm và đăng ký tài khoản Facebook.
- Đồng bộ danh sách hội thoại và lịch sử tin nhắn.
- Nhận tin nhắn realtime.
- Gửi tin nhắn, gửi file và xác nhận trạng thái.
- Campaign, hàng đợi, worker và retry.
- Auto Reply/AI và cơ chế tạm dừng AI.
- Session hết hạn, checkpoint và reconnect.

### 3.5. Quy chuẩn giao tiếp giữa các thành phần — Mức ưu tiên: Rất cao

Hiện các hợp đồng nằm rải rác theo từng spec. Cần xây dựng một tài liệu canonical duy nhất liệt kê:

- REST API.
- Socket.IO event.
- Extension WebSocket message.
- Chrome runtime message.
- Payload đầu vào và đầu ra.
- Trường bắt buộc, trường tùy chọn và kiểu dữ liệu.
- Mã lỗi, timeout, retry và yêu cầu idempotency.

### 3.6. Quy chuẩn định danh — Mức ưu tiên: Cao

Cần định nghĩa rõ nguồn gốc và phạm vi sử dụng của `thread_id`, `external_thread_id`, `account_id`, `page_id`, `message_id`, `fb_message_id`, `client_message_id`, `attempt_id` và `source_tab_id`.

### 3.7. Ma trận xử lý lỗi và phục hồi — Mức ưu tiên: Cao

Cần quy định rõ cách xử lý khi:

- Extension hoặc Chrome mất kết nối.
- Facebook logout, checkpoint hoặc thay đổi DOM/GraphQL.
- Tin nhắn gửi timeout, thất bại hoặc bị gửi trùng.
- Server dừng giữa quá trình chạy Campaign.
- SQLite bị khóa hoặc dữ liệu/file đính kèm bị thiếu.
- Socket.IO/WebSocket reconnect.

Mỗi trường hợp cần có module chịu trách nhiệm, trạng thái UI, số lần retry và hành động vận hành.

### 3.8. Tài liệu vận hành, build và phát hành — Mức ưu tiên: Cao

README hiện mới đáp ứng hướng dẫn cơ bản. Cần bổ sung:

- Phiên bản Node.js/Electron/Chrome được hỗ trợ.
- Cách chạy môi trường development.
- Danh sách biến môi trường và secret.
- Quy trình build UI, Extension và Windows installer.
- Quy trình rebuild native module `better-sqlite3`.
- Vị trí database, log, Chrome profile, thư mục `dist` và `release`.
- Backup/restore, nâng cấp phiên bản và rollback.

### 3.9. Quản lý migration database — Mức ưu tiên: Cao

Cần có schema version, danh sách migration, quy tắc chạy lặp an toàn, kế hoạch rollback và hướng dẫn nâng cấp dữ liệu từ phiên bản cũ.

### 3.10. Kiểm thử end-to-end — Mức ưu tiên: Cao

Dự án có nhiều unit/integration test nhưng cần checklist E2E trên ứng dụng đóng gói, bao gồm đăng nhập, thêm tài khoản, nhận/gửi tin nhắn thật, gửi file, reconnect, restart, Campaign và chạy nhiều tài khoản đồng thời.

### 3.11. CI/CD và kiểm soát chất lượng — Mức ưu tiên: Trung bình–cao

Cần pipeline tự động chạy test, kiểm tra cú pháp/lint, build UI/Extension, đóng gói installer, kiểm tra artifact, tạo changelog/version và phát hiện secret trước khi phát hành.

### 3.12. Tài liệu bảo mật — Mức ưu tiên: Rất cao

Cần mô tả cách lưu và mã hóa token/cookie, quyền của Extension, bảo vệ Chrome profile, phân quyền nhân viên, dữ liệu khách hàng trong log, kết nối License Server và quy trình thu hồi quyền truy cập.

## 4. Rủi ro nếu chưa bổ sung

- Thời gian onboarding thành viên mới kéo dài và phụ thuộc nhiều vào người viết code ban đầu.
- Dễ sửa sai module hoặc phá vỡ hợp đồng sự kiện giữa UI, Backend và Extension.
- Khó điều tra lỗi realtime, lỗi mất kết nối và lỗi gửi trùng.
- Database có nguy cơ lệch schema giữa các phiên bản cài đặt.
- Quy trình build/phát hành phụ thuộc vào máy và kinh nghiệm cá nhân.
- Khó đánh giá đầy đủ rủi ro bảo mật và phạm vi dữ liệu nhạy cảm.

## 5. Kế hoạch đề xuất

### Giai đoạn 1 — Tài liệu phục vụ bàn giao

1. Vẽ sơ đồ kiến trúc tổng thể hiện tại.
2. Lập bảng module, trách nhiệm và phụ thuộc.
3. Sinh ERD từ schema thực tế.
4. Tổng hợp toàn bộ API và event vào một tài liệu canonical.
5. Viết sequence diagram cho luồng nhận và gửi tin nhắn.

### Giai đoạn 2 — Tài liệu phục vụ vận hành

1. Hoàn thiện hướng dẫn chạy, debug, build và phát hành.
2. Xây dựng ma trận lỗi/retry/recovery.
3. Chuẩn hóa migration và backup/restore database.
4. Hoàn thiện E2E checklist trên máy sạch.

### Giai đoạn 3 — Chuẩn hóa dài hạn

1. Thiết lập CI/CD và quality gate.
2. Bổ sung threat model và security checklist.
3. Áp dụng ADR cho các quyết định kiến trúc quan trọng.
4. Quy định cập nhật tài liệu cùng mỗi thay đổi code hoặc release.

## 6. Kết luận

Dự án đã có nền tảng chức năng và tài liệu theo feature khá tốt. Việc cần ưu tiên tiếp theo là hợp nhất tài liệu thành một bộ kiến trúc phản ánh đúng code hiện tại. Năm đầu mục cần hoàn thành trước để phục vụ bàn giao gồm: sơ đồ kiến trúc, danh mục module, ERD, hợp đồng giao tiếp và sequence diagram cho các luồng chính.

Sau khi hoàn thiện các nội dung trên, dự án sẽ giảm đáng kể phụ thuộc vào kiến thức cá nhân, rút ngắn thời gian bàn giao và nâng cao khả năng vận hành, kiểm thử và phát triển lâu dài.
