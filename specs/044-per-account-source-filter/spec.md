# Feature Specification: Per-Account Conversation Source Filter

**Feature Branch**: `044-per-account-source-filter`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Bộ lọc nguồn hội thoại phải lọc được theo từng tài khoản Facebook cá nhân đã thêm, giống cách Page đang được tách riêng từng cái. Tự cộng dồn/trừ đi khi thêm hoặc bớt tài khoản."

## Background

`ConversationFilterPopover.jsx:88` đã tách riêng từng Page thành 1 nút lọc (`source:<sourceId>`), tự động thêm/bớt theo `inboxSources` hiện có (`sanitizeFilters` loại bỏ key của Page không còn tồn tại). Nhưng tài khoản cá nhân chỉ có đúng 1 nút gộp chung "Cá nhân" (`SOURCE_TYPE_KEYS.PERSONAL`) — không tách theo từng `account_id`, vì:
- `ConversationFilterPopover` không nhận prop `accounts`.
- `conversationFilters.js` không có khái niệm key `account:<id>`, `matchesConversationFilters` không so `thread.account_id`.

## Requirements

- **FR-001**: Thêm kiểu key `account:<accountId>` trong `conversationFilters.js`, xử lý song song với `source:<sourceId>` đã có (`normalizeSourceKey`, `sanitizeFilters`).
- **FR-002**: `sanitizeFilters` MUST validate `account:` key theo danh sách `accounts` hiện tại được truyền vào — tự động loại bỏ key khi tài khoản không còn tồn tại (đối xứng với cách `source:` đã làm cho Page).
- **FR-003**: `matchesConversationFilters` MUST khớp `thread.account_id` với `account:<id>` khi filter có chọn key đó.
- **FR-004**: `ConversationFilterPopover` nhận thêm prop `accounts`, render mỗi tài khoản cá nhân thành 1 nút lọc riêng trong section "Nguồn hội thoại" (mirror đúng loop Page hiện có), nhãn hiển thị `account.name || account.id`.
- **FR-005**: `ConversationSidebar.jsx` truyền `accounts` (đã có sẵn như prop) xuống `ConversationFilterPopover`.
- **FR-006**: Không đổi hành vi 2 nút gộp "Cá nhân"/"Fanpage" đã có — chỉ bổ sung thêm lựa chọn chi tiết hơn bên cạnh, không bắt buộc phải bỏ chọn "Cá nhân" trước khi chọn theo từng account (giữ đúng logic OR hiện có của `sourceKeys`, giống cách Page + `type:page_messenger` đang cùng tồn tại).
- **FR-007**: Không đổi schema DB, không đổi API — thuần túy là logic phía client (threads đã có sẵn `account_id`).

## Implementation Notes (2026-08-20)

Đã vá xong toàn bộ FR-001 → FR-007:
- `conversationFilters.js`: thêm `account:<id>` vào `normalizeSourceKey`, `sanitizeFilters` (tham số mới `availableAccounts`), `matchesConversationFilters` (so `thread.account_id`).
- `ConversationFilterPopover.jsx`: nhận prop `accounts`, render 1 nút lọc/tài khoản trong section "Nguồn hội thoại" (mirror đúng loop Page).
- `ConversationSidebar.jsx`: truyền `accounts` (đã có sẵn) xuống popover.
- Test: `tests/unit/conversationFilters.test.js` thêm 2 test (sanitize bỏ account đã xoá, match đúng theo account_id). `npm run test:persistence`: 341/341 PASS, không regression. `vite build` PASS. `graphify update .` đã chạy.
- Chưa verify bằng mắt trên UI thật (cần bạn tự mở popup lọc để xác nhận hiển thị đúng).

### Cập nhật UX (2026-08-20, theo phản hồi thêm từ người dùng)

Ban đầu tất cả nút (Cá nhân/Fanpage + từng account + từng page) hiện phẳng cùng lúc, gây rối mắt. Đổi thành dạng dropdown: nút "Cá nhân"/"Fanpage" giờ chỉ là nút mở/đóng (kèm số đếm điều kiện đang chọn trong nhóm đó và mũi tên xoay), bấm vào mới hiện danh sách con tương ứng (tài khoản cá nhân hoặc Fanpage), có sẵn tuỳ chọn "Tất cả tài khoản cá nhân"/"Tất cả Fanpage" ở đầu mỗi danh sách để giữ nguyên hành vi lọc gộp cũ. Chỉ 1 dropdown mở tại 1 thời điểm. Không đổi logic `sourceKeys`/`sanitizeFilters`/`matchesConversationFilters` — chỉ đổi cách trình bày, nên không cần thêm test logic mới (341/341 test cũ vẫn pass, `vite build` PASS, `graphify update .` đã chạy).

## Success Criteria

- **SC-001**: Với N tài khoản cá nhân đã kết nối, popup lọc hiện đúng N nút riêng biệt, mỗi nút lọc đúng hội thoại của tài khoản đó.
- **SC-002**: Thêm/bớt tài khoản cá nhân → số nút lọc tự cập nhật theo, không cần reload; filter đang áp dụng cho tài khoản vừa bị gỡ tự động biến mất khỏi bộ lọc đang chọn (không còn ảnh hưởng kết quả lọc).
- **SC-003**: Không regression: bộ lọc theo Page, theo "Cá nhân"/"Fanpage" gộp, và mọi filter khác (tag, trạng thái...) vẫn hoạt động y hệt trước.
