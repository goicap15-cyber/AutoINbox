# Tasks: 056-page-video-sync

- [x] T001: Tạo module `src/extension/pageVideoDetector.js` phục vụ nhận diện video trong DOM Meta Business Suite.
- [x] T002: Tạo module `src/extension/pageVideoUploader.js` phục vụ upload/staging video trên Meta Business Suite qua CDP.
- [x] T003: Đăng ký `pageVideoDetector.js` trong `src/extension/manifest.json`.
- [x] T004: Tích hợp `pageVideoDetector.js` vào `src/extension/page_content.js` an toàn, bảo toàn 100% logic Like / text / batch sync hiện hữu.
- [x] T005: Tích hợp `pageVideoUploader.js` vào `src/extension/background.js` an toàn.
- [x] T006: Tạo unit test `tests/unit/page_video_extraction.test.js` kiểm tra phát hiện video DOM và không nhận nhầm call/text/image.
- [x] T007: Chạy kiểm thử toàn bộ test suites (`npm test ...`, `npm run test:persistence`).
- [x] T008: Chạy `graphify update .` cập nhật Knowledge Graph theo đúng quy định bắt buộc.
