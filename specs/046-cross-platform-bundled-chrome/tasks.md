# Tasks: Chrome Đóng Gói Sẵn Đa Nền Tảng (giới hạn ~600MB)

**Input**: `specs/046-cross-platform-bundled-chrome/spec.md`, `plan.md`

## Yêu cầu bổ sung của người dùng khi duyệt

"tạo 1 forder riêng, file riêng để làm các vấn đề liên quan đến chrome tránh hỏng code đang chạy" — toàn bộ logic mới (fetch/prune/resolve path) được cô lập trong 1 thư mục riêng `chrome-bundling/` ở root repo, KHÔNG viết trực tiếp vào `ProcessManager.js` (chỉ thêm 1 dòng `require` + gọi hàm), để code đang chạy (spawn Chrome cho account thật) không bị đụng chạm ngoài 1 điểm nối tối thiểu.

## Phase 1 — Cô lập logic Chrome vào `chrome-bundling/` (FR-002)

- [X] T001 Tạo `chrome-bundling/resolveChromePath.js` — hàm thuần `resolveChromePath({ repoRoot, legacyBinChromePath })`, có fallback AN TOÀN: nếu bundle mới cho platform hiện tại chưa tồn tại (`bin/chrome-mac`, `bin/chrome-linux` chưa fetch), rơi về ĐÚNG hành vi cũ trước spec 046 (`legacyBinChromePath` rồi `'google-chrome'`) — hành vi Windows/Linux hiện tại không đổi cho tới khi thực sự fetch xong bundle mới.
- [X] T002 Sửa `src/server/services/ProcessManager.js`: thêm 1 dòng `require('../../../chrome-bundling/resolveChromePath')`, thay 2 chỗ `chromeExecutable = fs.existsSync(...) ? ... : 'google-chrome'` bằng gọi `resolveChromePath({ repoRoot: REPO_ROOT, legacyBinChromePath: this.binChromePath })`. Đây là TOÀN BỘ thay đổi trong file đang chạy — không sửa gì khác.
- [X] T003 `tests/unit/resolveChromePath.test.js` — 4 test PASS: dùng bundle mới khi có; fallback legacy khi thiếu bundle mới (không regression); fallback `'google-chrome'` khi thiếu cả 2 (giữ đúng hành vi trước spec 046); không throw khi thiếu tham số.
- [X] T004 `node --check` PASS cho cả 2 file mới + `ProcessManager.js`; `node -e "require(...)"` xác nhận `ProcessManager.js` vẫn load được bình thường.

## Phase 2 — Tải Chrome for Testing + đo dung lượng thật (FR-001, FR-006, FR-007)

- [X] T005 Cài `@puppeteer/browsers@3.2.1` (devDependency).
- [X] T006 Đọc mã nguồn `node_modules/@puppeteer/browsers/lib/browser-data/chrome.js` để lấy CHÍNH XÁC layout thư mục sau khi tải (không đoán): Linux → `chrome-linux64/chrome`, Windows → `chrome-win64/chrome.exe`, Mac → `chrome-mac-x64|chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
- [X] T007 Tạo `chrome-bundling/fetchChromeForTesting.js` — tải Chrome for Testing (KHÔNG phải Chrome thương hiệu Google) qua `@puppeteer/browsers`, sau đó "làm phẳng" (flatten) thư mục có version/arch trong tên xuống còn `bin/chrome-<os>/` cố định, khớp đúng convention cũ `bin/chrome-win/chrome.exe` đã có sẵn trước spec 046.
- [X] T008 [FR-006] Prune sau khi tải: xoá toàn bộ `locales/*.pak` trừ `vi*`/`en-US*`, xoá thư mục `WidevineCdm/` (DRM plugin, CRM không cần phát video DRM).
- [X] T009 Chạy thật `npm run fetch-chrome:linux` trên máy dev (Linux) — **đo được số thật**: tải về 391MB (Linux Chrome for Testing 152.0.7977.54) → sau prune còn **321MB** (tiết kiệm 68.4MB: 47MB locales + 21MB WidevineCdm).
- [X] T010 Smoke test: `bin/chrome-linux/chrome --version` chạy được, in đúng version; chạy `--headless=new --load-extension=src/extension --remote-debugging-port` thật, xác nhận process sống, trả lời đúng CDP `/json/version`, log sạch không lỗi liên quan extension.
- [ ] Windows/Mac: **chưa fetch/đo được** trên máy dev Linux hiện tại — `npm run fetch-chrome:win`/`fetch-chrome:mac` chỉ TẢI file (không cần chạy trên đúng OS vì đây chỉ là download+giải nén), nhưng **chưa smoke-test chạy thật** được vì thiếu máy Windows/Mac. Cần làm ở máy/CI tương ứng trước khi phát hành chính thức.

## Phase 3 — Giảm dung lượng gói cài (FR-003, FR-004, FR-005)

- [X] T011 [FR-003] `electron-builder.yml`: thêm `extraResources` cho `bin/chrome-mac`/`bin/chrome-linux` — **đặt SCOPED vào từng platform section** (`win:`/`mac:`/`linux:`), KHÔNG đặt chung ở top-level `extraResources` — lý do: nếu đặt chung, build cho 1 OS sẽ lỗi ngay khi thiếu bundle của 2 OS còn lại trên máy dev.
- [X] T012 [FR-004] Loại trừ `node_modules/electron-builder/**`, `electron-winstaller/**`, `app-builder-lib/**`, `@puppeteer/**` khỏi `files` — các gói này chỉ dùng lúc build, không bao giờ `require()` lúc runtime.
- [X] T013 [FR-005] Loại trừ `node_modules/lucide-react/**`, `emoji-picker-react/**`, `react/**`, `react-dom/**`, `react-colorful/**` khỏi `files` — giữ nguyên trong `dependencies` của `package.json` (không đổi sang devDependencies, tránh hiểu nhầm đồ thị phụ thuộc thật) vì code thực dùng đã được Vite bundle sẵn vào `dist/client/**/*`.
- [X] T014 `.gitignore`: thêm `bin/chrome-win/*`, `bin/chrome-mac/*`, `bin/chrome-linux/*` (giữ `.gitkeep`) — phát hiện thêm: trước spec 046, `bin/` HOÀN TOÀN không có trong `.gitignore`, nghĩa là nếu ai đó lỡ `git add` sau khi fetch sẽ commit nhầm ~300MB/OS vào repo. Đã xác nhận `bin/chrome-win/chrome.exe` chưa từng tồn tại thật trên máy dev (chỉ có `.gitkeep`).

## Phase 4 — Build thật + đo dung lượng thật (FR-007, SC-002)

- [X] T015 `npm run build:all` (ui + bytecode + extension) PASS.
- [X] T016 `npx electron-builder --linux` build thật PASS. **Kết quả đo được (không phải ước tính)**:
  - `resources/app.asar` = 17MB (code + node_modules thật cần dùng, xác nhận `lucide-react`/`emoji-picker-react`/`electron-builder`/`electron-winstaller` đã bị loại đúng qua `npx asar list` — không xuất hiện)
  - `resources/app.asar.unpacked` = 28MB (native module `better-sqlite3` compiled binary)
  - `resources/bin/chrome-linux/chrome` = 291MB (nguyên vẹn, đã prune)
  - `resources/extension` = 324KB
  - Tổng unpacked (`release/linux-unpacked`) = 625MB
  - **`FB Messenger CRM-1.0.0.AppImage` (file cài đặt cuối cùng, đã nén squashfs) = 207MB** — thấp hơn NHIỀU so với mục tiêu 600MB (SC-002 ĐẠT, dư margin lớn cho Windows/Mac dù compression của NSIS/DMG có thể khác AppImage).
- [X] T017 `npm run test:persistence` — 368/368 PASS (364 cũ + 4 test `resolveChromePath` mới), không regression.
- [X] T018 `graphify update .`.
- [ ] T019 Build thật cho Windows (`npm run fetch-chrome:win` rồi `npx electron-builder --win`) và Mac (`npm run fetch-chrome:mac`/`fetch-chrome:mac-arm` rồi `npx electron-builder --mac`) để đo dung lượng thật trên 2 OS còn lại — **chưa làm được trên máy dev Linux hiện tại**, cần máy Windows/Mac thật hoặc CI tương ứng (electron-builder có thể cross-build 1 phần nhưng DMG code-signing/notarization cần máy Mac thật). Do AppImage nén rất tốt (625MB → 207MB, ~3 lần), NSIS (đã bật `compression: maximum`) nhiều khả năng cũng đạt kết quả tương tự hoặc tốt hơn; DMG (bzip2) có thể nén kém hơn AppImage — cần đo thật, không giả định.

## Phase 5 — Tự động cấp quyền mic/camera cho cuộc gọi (yêu cầu bổ sung, 2026-08-20)

Người dùng hỏi thêm sau khi duyệt xong Phase 1-4: hiện đang phải bấm tay cho phép mic/camera mỗi khi có cuộc gọi FB, hỏi có tự động hoá được không.

- [X] T020 Thêm `--use-fake-ui-for-media-stream` vào `args` ở CẢ 2 chỗ spawn Chrome trong `ProcessManager.js` (`startAccountProcess`, `startNewAccountProcess`) — flag chuẩn của Chromium cho automation, chỉ tự động bấm "Cho phép" ở popup xin quyền, thiết bị mic/camera vẫn là THẬT (khác `--use-fake-device-for-media-stream` là giả luôn thiết bị — không dùng vì cần nghe/gọi thật).
- [X] T021 Smoke test: bundled Chrome (Linux) khởi chạy bình thường với flag mới, không lỗi, `--remote-debugging-port` phản hồi đúng.
- [X] T022 `npm run test:persistence` — 368/368 PASS, không regression. `node --check` PASS.

## Phase 6 — Fix crash thật khi test trên máy người dùng (2026-08-20)

Người dùng bấm "Mở Chrome" thật trên CRM sau khi build xong Phase 1-5 — log cho thấy Chrome khởi chạy (PID có) rồi thoát ngay lập tức ("đã thoát - bỏ theo dõi"), không mở được cửa sổ nào.

- [X] T023 Tái hiện CHÍNH XÁC bằng cách chạy tay đúng bộ args thật của `ProcessManager.js` (không headless, không `--no-sandbox` — khác với smoke test trước đó ở Phase 2 vốn LUÔN có `--no-sandbox`/`--headless`, nên chưa từng bắt được lỗi này). Chrome in lỗi rõ ràng: `FATAL: No usable sandbox!` — bản Chrome for Testing tải qua `@puppeteer/browsers` chỉ là giải nén thô, `chrome_sandbox` không có quyền setuid-root cần thiết; Ubuntu 23.10+ mặc định chặn user namespace không đặc quyền qua AppArmor nên sandbox kiểu cũ cũng không dùng được.
- [X] T024 Thêm `--no-sandbox` vào `args` ở CẢ 2 chỗ spawn Chrome trong `ProcessManager.js` — cách làm chuẩn, phổ biến cho mọi công cụ tự động hoá trình duyệt trên Linux (Puppeteer/Selenium/Playwright đều khuyến nghị mặc định này cho CI/container); mỗi account vẫn chạy profile/process riêng nên không mất tính cách ly giữa các tài khoản.
- [X] T025 Test lại đúng qua `ProcessManager.startAccountProcess()` (không chạy tay Chrome nữa) — xác nhận `status` = `RUNNING` sau 4 giây, không còn thoát ngay.
- [X] T026 `npm run test:persistence` — 374/374 PASS. `node --check` PASS.

**Bài học rút ra**: smoke test ở Phase 2 (T010) dùng `--headless=new --no-sandbox` nên KHÔNG bắt được lỗi sandbox này — đây là 1 khoảng trống trong việc test, chỉ lộ ra khi người dùng test bằng đúng luồng thật (không headless, không no-sandbox). Đã sửa để lần sau validate bằng đúng bộ args thật thay vì bộ args "an toàn" riêng cho smoke test.

## Success Criteria — đối chiếu

- **SC-001** (Chrome chạy đúng cả 3 OS không phụ thuộc Chrome hệ thống): ĐẠT cho Linux (đã smoke-test thật). Windows/Mac: code đã sẵn sàng (`resolveChromePath.js` đã map đúng theo tài liệu Puppeteer), nhưng CHƯA chạy thật được trên máy dev hiện tại.
- **SC-002** (~600MB hoặc thấp hơn): ĐẠT cho Linux với số đo thật **207MB** (dư margin lớn). Windows/Mac cần đo riêng (T019).
- **SC-003** (không regression UI): ĐẠT — `npm run test:persistence` 368/368 PASS; `npx asar list` xác nhận code thật của `lucide-react`/`react`/... vẫn nằm trong `dist/client/**/*` đã đóng gói vào `app.asar`, chỉ loại bỏ bản `node_modules` vật lý dư thừa.

## Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4. Đã hoàn tất Phase 1-4 cho Linux; Windows/Mac (T019) cần máy/CI tương ứng, đã ghi rõ giới hạn thay vì bịa số.
