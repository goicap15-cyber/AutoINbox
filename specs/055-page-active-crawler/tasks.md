# Tasks: Feature 055 - Active Crawler Cho Fanpage Meta Business Suite

**Status**: Ready for Implementation (TDD approach: Viết test assertions trước, triển khai module mới sau)

## Phase 1: Test Scaffolding (TDD)
- [x] T001 Tạo bộ unit test toàn diện trong `tests/unit/page_active_scroller.test.js` kiểm tra 7 kịch bản: (1) gom snapshot chống mất tin khi DOM unmount, (2) mutex coalescing request đồng thời, (3) hủy crawl khi đổi thread, (4) timeout spinner treo, (5) tăng trưởng khi chiều cao giữ nguyên nhưng ID đổi, (6) khóa realtime leak guard, (7) tách biệt timeout crawl và timeout ACK.

## Phase 2: Core Helper Module
- [x] T002 Triển khai file mới `src/extension/pageActiveScroller.js` (UMD/CommonJS) chứa:
  - `calculateStepDistance(clientHeight)`
  - `createMessageAccumulator()`
  - `dispatchScrollGestures(scroller, stepDistance)`
  - `waitForDomSettle(scroller, options)`
  - `isMessageLogContainer(el)`
- [x] T003 Cấu hình `src/extension/manifest.json` đưa `pageActiveScroller.js` vào `content_scripts` nạp trước `page_content.js`.
- [x] T004 Chạy kiểm thử `node --test tests/unit/page_active_scroller.test.js` đảm bảo 100% tests PASS.

## Phase 3: Integration into Extension Content Script
- [x] T005 Nâng cấp `findScrollableMessageContainer()` trong `src/extension/page_content.js` sử dụng `isMessageLogContainer()` để loại trừ triệt để sidebar `[role="navigation"]`.
- [x] T006 Tích hợp `crawlInProgress` khóa luồng realtime emission trong hàm `scanForMessages()` tại `src/extension/page_content.js`.
- [x] T007 Cài đặt quản lý `activeCrawlToken` và hàm điều phối adaptive crawl (tối đa 3 vòng cho older, gom snapshot theo từng vòng) trong `src/extension/page_content.js`.
- [x] T008 Cập nhật handler `REQUEST_PAGE_BATCH_SYNC` kích hoạt crawler chủ động, đóng gói danh sách tích lũy từ accumulator vào `PAGE_THREAD_MESSAGES_SYNCED_V1`, và chỉ kích hoạt ACK timeout 10s sau khi gửi envelope.
- [x] T009 Dọn dẹp hàm `scrollBackForHistory()` cũ trong `src/extension/page_content.js`.

## Phase 4: Verification & Regression
- [x] T010 Chạy lại toàn bộ test suite: unit tests và integration tests (357 unit tests PASS, 2 integration tests PASS).
- [x] T011 Chạy `npm run build:ui` và kiểm tra cú pháp JS toàn bộ dự án (`node --check`) (ALL SYNTAX OK, UI build 5.00s).
- [x] T012 Cập nhật Knowledge Graph: `graphify update .` (8869 nodes, 751 communities).
