# Architecture & Technical Plan: Feature 055 - Active Crawler Cho Fanpage Meta Business Suite

## 1. Kiến Trúc Tổng Thể

Hệ thống tách biệt hoàn toàn module logic cuộn chủ động thành một helper riêng: `src/extension/pageActiveScroller.js`.
File này tuân theo định dạng UMD/CommonJS để có thể:
1. Nhúng trực tiếp vào Chrome Extension content script (`manifest.json` và `page_content.js`).
2. Import trực tiếp vào Node.js test runner (`node --test`) để kiểm thử TDD tự động mà không cần cài thêm thư viện phụ thuộc.

```
+-------------------------------------------------------------+
|                      page_content.js                        |
|                                                             |
|  [REQUEST_PAGE_BATCH_SYNC]                                  |
|         |                                                   |
|         v                                                   |
|  [pageActiveScroller.executeAdaptiveCrawl]                  |
|    - Mutex check (requestId, threadId)                      |
|    - Lock scanForMessages (crawlInProgress = true)          |
|    - Loop 1..3:                                             |
|        * dispatchStepScroll (70-85% viewport)               |
|        * waitForDomSettle (spinner, growth)                 |
|        * snapshot & accumulate into Set/Map                 |
|        * check early exit (boundary, no_growth)             |
|    - Pack accumulated messages                              |
|         |                                                   |
|         v                                                   |
|  [Send PAGE_THREAD_MESSAGES_SYNCED_V1]                      |
|    - Start 10s ACK timeout HERE                             |
|    - Unlock crawlInProgress = false on finish               |
+-------------------------------------------------------------+
```

## 2. Các Module & Lớp Trách Nhiệm

1. **`src/extension/pageActiveScroller.js` (NEW)**:
   - `calculateStepDistance(clientHeight)`: tính bước cuộn an toàn (`0.75 * clientHeight`).
   - `createMessageAccumulator()`: quản lý danh sách tin nhắn tích lũy, dedupe theo `fb_message_id`, bảo toàn thứ tự xuất hiện.
   - `dispatchScrollGestures(scroller, stepDistance)`: thực hiện chuỗi fallback: `scroller.scrollBy`, `scroller.dispatchEvent(new Event('scroll'))`, `WheelEvent`.
   - `waitForDomSettle(scroller, options)`: quan sát `scrollHeight`, ID phần tử đầu tiên, và spinner loading.
   - `isMessageLogContainer(el)`: xác thực container hợp lệ, nằm trong `[role="main"]`, không phải `[role="navigation"]`.

2. **`src/extension/manifest.json` (MODIFY)**:
   - Thêm `pageActiveScroller.js` vào mảng `content_scripts` trước `page_content.js`.

3. **`src/extension/page_content.js` (MODIFY)**:
   - Tích hợp `crawlInProgress` khóa realtime emission trong `scanForMessages`.
   - Nâng cấp `REQUEST_PAGE_BATCH_SYNC` sử dụng `pageActiveScroller`.
   - Chống race condition với `activeCrawlToken`.

4. **`tests/unit/page_active_scroller.test.js` (NEW)**:
   - Bộ kiểm thử unit 7 kịch bản:
     1. Tích lũy snapshot qua các vòng unmount.
     2. Mutex coalescing 2 request đồng thời.
     3. Tự hủy khi đổi thread ID.
     4. Spinner treo tự thoát an toàn.
     5. Nhận diện tăng trưởng qua ID khi chiều cao giữ nguyên.
     6. Khóa tin lịch sử không lọt sang realtime.
     7. Đo đạc timeout tách biệt giữa Crawl và ACK.
