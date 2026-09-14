# Feature Plan: 056-page-video-sync

## 1. Architecture Overview

```
+-----------------------------------------------------------------------------------------+
|                                    OUTBOUND (CRM -> Page)                              |
|                                                                                         |
| CRM UI (MessageComposer)                                                                |
|      |                                                                                  |
|      v (Paperclip: .mp4 / .mov)                                                         |
| Server Outbox Queue (QueueWorker.js, media_type: 'video')                               |
|      |                                                                                  |
|      v WebSocket SEND_PAGE_MESSAGE                                                      |
| background.js -> pageVideoUploader.js                                                   |
|      |                                                                                  |
|      v CDP Page.setInterceptFileChooserDialog + DOM.setFileInputFiles                   |
| Meta Business Suite Composer -> Send Button                                             |
+-----------------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------------+
|                                    INBOUND (Page -> CRM)                               |
|                                                                                         |
| Meta Business Suite Chat DOM                                                            |
|      |                                                                                  |
|      v                                                                                  |
| page_content.js -> pageVideoDetector.js                                                 |
|      |                                                                                  |
|      v detectPageVideoMessage() -> { isVideo: true, mediaUrl, caption }                |
| WebSocket INBOX_SYNC_MESSAGES / NEW_MESSAGE                                             |
|      |                                                                                  |
|      v                                                                                  |
| SQLite Database (messages table: media_type = 'video', media_url = ...)                 |
|      |                                                                                  |
|      v                                                                                  |
| InboundMediaHydrationService.js + RobustMediaDownloader.js                              |
|      |                                                                                  |
|      v Download into data/media/inbound/<hash>.mp4                                      |
| SQLite Database (messages table: local_media_path = ...)                                |
|      |                                                                                  |
|      v Socket broadcast MESSAGE_UPDATED                                                 |
| CRM UI (MediaViewer.jsx -> <video controls>)                                            |
+-----------------------------------------------------------------------------------------+
```

## 2. File Modularity Breakdown

1. **`src/extension/pageVideoDetector.js` (NEW)**:
   - Module chuyên biệt trích xuất video từ DOM của Meta Business Suite.
   - Hàm `detectPageVideo(containerNode, cleanedText)`:
     - Thẻ `<video>` (`currentSrc`, `src`, `<source src>`, `poster`).
     - Thẻ `<a>` chứa link `/videos/`, `/watch/`, `/reel/`, `*.mp4`.
     - Thẻ ngữ nghĩa `[role="img"]` có nhãn video.
   - Trả về object `{ isVideo: boolean, mediaUrl: string|null, caption: string|null, posterUrl: string|null }`.
   - Đảm bảo tương thích cả Extension content script lẫn Node.js testing context.

2. **`src/extension/pageVideoUploader.js` (NEW)**:
   - Module chuyên biệt phục vụ staging và upload video cho Meta Business Suite.
   - Hàm `stageBusinessSuiteVideo(tabId, attachmentOrManifest, cdpContext)`:
     - Xác định `preferredKind = 'video'`.
     - Tìm tọa độ attach control hoặc input file thích hợp.
     - Kích hoạt CDP `Page.setInterceptFileChooserDialog`.
     - Gán file path qua `DOM.setFileInputFiles`.
     - Chờ video preview chip / readiness trên Facebook composer.

3. **`src/extension/page_content.js` (INTEGRATION - SAFE & MINIMAL)**:
   - Trong `resolveMessageContent`: gọi `FbPageVideoDetector.detectPageVideo` trước khi fallback.
   - Trong `collectMountedBatchMessages`: tôn trọng `unit.resolved.mediaType || 'image'` khi `isMedia === true`.
   - Trong `forwardResolvedMessage`: truyền `media_type = resolvedContent.mediaType || 'image'`.

4. **`src/extension/background.js` (INTEGRATION - SAFE & MINIMAL)**:
   - `importScripts('pageVideoUploader.js')`.
   - Cập nhật `stageBusinessSuiteAttachment` để sử dụng `preferredKind` chuẩn xác cho video (hoặc gọi qua `FbPageVideoUploader`).

5. **`src/extension/manifest.json`**:
   - Khai báo nạp `pageVideoDetector.js` trước `page_content.js`.

6. **`tests/unit/page_video_extraction.test.js` (NEW)**:
   - Suite kiểm thử độc lập cho `pageVideoDetector.js`.
