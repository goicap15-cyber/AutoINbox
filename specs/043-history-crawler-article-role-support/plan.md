# Implementation Plan: History Crawler `role="article"` Support

**Branch**: `043-history-crawler-article-role-support` | **Date**: 2026-08-19 | **Spec**: `specs/043-history-crawler-article-role-support/spec.md`

## Summary

`background.js`'s `handleSyncThreadMessages()` (crawler lịch sử) chỉ nhận diện `div[role="row"]` và ID qua `[data-id]`/`[id^="mid."]` — cấu trúc DOM cũ của Facebook Messenger. Bằng chứng DOM thật (console log 2026-08-19) xác nhận Facebook hiện dùng `div[role="article"]` + `[data-message-id]`, đúng như `content.js` đã tự vá từ 2026-08-13. Kế hoạch: mirror đúng pattern đã chứng minh hoạt động của `content.js` vào 4 vị trí trong `background.js`, cộng thêm logic suy luận chiều tin nhắn (in/out) cho format aria-label mới, với nguyên tắc an toàn "bỏ qua khi không chắc" thay vì đoán.

## Technical Context

Không đổi so với spec 041/042: cùng file `src/extension/background.js`, cùng cơ chế `chrome.scripting.executeScript`. Không thêm dependency.

**Testing**: Logic thuần (row-selector list, hasMessageLabel mới, direction-resolution) tách thành module `src/extension/historyRowSupport.js` (theo đúng convention dual-copy của `textFilter.js`/`historySyncRoundBudget.js` — closure injected không require() được, cần bản mirror để test).

## Constitution Check

Không có gate đặc thù. Theo `PROJECT_RULES.md`: spec trước, `graphify update .` sau khi code xong.

## Project Structure

```text
specs/043-history-crawler-article-role-support/
├── plan.md    # File này
├── spec.md    # Đã tạo
└── tasks.md   # Tiếp theo

src/extension/background.js          # 4 chỗ role="row" -> +role="article"; nativeId ưu tiên data-message-id; direction resolution mới; truyền contact_name vào args
src/extension/historyRowSupport.js   # (mới) pure logic mirror để test: resolveDirection(label, contactName)
tests/unit/historyRowSupport.test.js # (mới) unit test
```

## Phase 0: Research (đã xong — xem spec.md Background)

Không có `NEEDS CLARIFICATION`. 4 vị trí cần sửa đã liệt kê chính xác theo số dòng ở spec.md.

## Phase 1: Design

**Selector hợp nhất** (4 chỗ, thay `div[role="row"]` bằng):
```js
'div[role="row"], div[role="article"]'
// (2 chỗ đã có thêm ', div[data-scope="messages_table"] div[dir="auto"]' thì giữ nguyên phần đó, chỉ thêm role="article")
```

**Native ID** (dòng ~2438):
```js
// Trước: const nativeIdEl = row.querySelector('[data-id], [id^="mid."]');
// Sau:
const nativeIdEl = row.querySelector('[data-message-id]') || row.querySelector('[data-id], [id^="mid."]');
// ...và lấy giá trị ưu tiên đúng attribute đã tìm thấy (data-message-id trước, data-id/id sau) khi build nativeId ở dòng ~2490.
```

**Direction resolution mới** (`historyRowSupport.js`, hàm thuần):
```js
const OLD_LABEL_RE = /Tin nhắn do .+ gửi lúc|Message sent by/i;
const NEW_LABEL_RE = /^Lúc\s+.+?,\s*(.+?):\s*/i;

function resolveDirectionFromLabel(effectiveLabel, contactName) {
  // Trả về { matched: boolean, isOutgoing, senderName } - matched=false nghĩa là
  // "không xác định được", caller (background.js) phải bỏ qua message đó (FR-006)
  // thay vì tự áp default.
  if (!effectiveLabel) return { matched: false };

  if (/do Bạn gửi|Tin nhắn do Bạn gửi lúc|Bạn đã gửi|sent by you|You sent|Message sent by you/i.test(effectiveLabel)) {
    return { matched: true, isOutgoing: true, senderName: 'Bạn' };
  }
  const oldNameMatch = effectiveLabel.match(/Tin nhắn do ([^]+?) gửi lúc/i) || effectiveLabel.match(/Message sent by ([^]+?) at/i);
  if (oldNameMatch) {
    const rawSender = oldNameMatch[1].trim();
    if (/^(?:Bạn|You)$/i.test(rawSender)) return { matched: true, isOutgoing: true, senderName: 'Bạn' };
    return { matched: true, isOutgoing: false, senderName: rawSender };
  }

  const newNameMatch = effectiveLabel.match(NEW_LABEL_RE);
  if (newNameMatch) {
    const rawSender = newNameMatch[1].trim();
    if (contactName && rawSender.toLowerCase() === String(contactName).trim().toLowerCase()) {
      return { matched: true, isOutgoing: false, senderName: rawSender };
    }
    // Tên khác contact_name (hoặc không có contact_name để so) -> giả định là
    // chính tài khoản (thread chỉ có 2 phía: mình và contact_name đã biết).
    if (contactName) return { matched: true, isOutgoing: true, senderName: 'Bạn' };
    return { matched: false }; // không có contact_name để so -> không chắc, bỏ qua (FR-006)
  }

  return { matched: false };
}
```
Lưu ý: khi `contactName` tồn tại và tên trích được KHÁC nó, ta suy luận đó là chính mình (vì thread 1-1 chỉ có 2 phía) — đây là suy luận có cơ sở (loại trừ), không phải đoán mù, nên vẫn tính là `matched: true` theo đúng FR-005. Chỉ khi HOÀN TOÀN không có `contactName` để loại trừ mới rơi vào `matched:false` (FR-006).

**Trong `background.js`**: dùng `resolveDirectionFromLabel` INLINE (copy logic, vì injected closure không require() được) — thay cho khối `if/else` hiện tại ở dòng ~2468-2485. Nếu `matched=false`, `continue`/bỏ qua bubble đó, log 1 dòng `[FB Engine] ⚠️ Bỏ qua tin nhắn không xác định được chiều gửi`.

**Truyền `contact_name`**: sửa `args: [thread_id, mode, cursor]` thành `args: [thread_id, mode, cursor, contact_name]` và chữ ký `func: async (targetThreadId, mode, cursor, contactName) => {...}`.

## Phase 2: Validation Plan

- Unit test `historyRowSupport.js` (bản mirror) cho `resolveDirectionFromLabel`: pattern cũ (outgoing/incoming), pattern mới khớp contact_name (incoming), pattern mới khác contact_name (outgoing), pattern mới không có contact_name (không xác định), label rỗng/null.
- `node --check` toàn bộ file sửa.
- `npm run test:persistence` không regression.
- `graphify update .`.
- Manual test thật (T ghi lại trong tasks.md, cần môi trường thật): sync lại thread `636212466232285`.

## Out of Scope

- Sửa `content.js`/`page_content.js` (đã đúng).
- Sửa logic nghiệp vụ dùng `is_outgoing` (AutoReplyEngine, AIMediator...).
- Điều tra cấu trúc DOM riêng của Business Suite/Page messenger nếu khác thêm nữa (ghi nhận, không giả định trong bản vá này).
