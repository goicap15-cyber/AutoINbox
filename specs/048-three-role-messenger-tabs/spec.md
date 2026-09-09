# Spec 048 - Three-role Messenger tabs

Mỗi tài khoản Facebook có ba vai trò tab độc lập:

- `interaction`: gửi/nhận realtime, file và cuộc gọi; là tab duy nhất phát sự kiện cuộc gọi.
- `discovery`: chỉ cuộn sidebar và thu thập danh sách hội thoại.
- `history`: chỉ điều hướng thread và đồng bộ lịch sử tin nhắn.

## Yêu cầu

1. Các tab được đăng ký theo `account_id + role` và sống qua service-worker restart.
2. Dedup không được đóng tab thuộc ba vai trò hợp lệ.
3. Tin realtime và cuộc gọi từ discovery/history không được forward về backend.
4. Discovery cộng dồn thread theo `thread_id`, cuộn chậm, dừng hữu hạn và khôi phục vị trí.
5. History không điều hướng tab interaction.
6. Gửi tin, file và gọi điện luôn dùng interaction.
7. CRM vẫn chỉ nhận một popup cuộc gọi.

## Tiêu chí thành công

- Người dùng chat/gọi trên interaction trong khi discovery cuộn mà tab interaction không đổi URL/vị trí.
- Discovery lấy được nhiều thread hơn số row đang render ban đầu.
- Một cuộc gọi đến chỉ tạo một popup CRM.
