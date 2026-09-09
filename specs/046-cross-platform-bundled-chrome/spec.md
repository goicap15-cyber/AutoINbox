# Feature Specification: Chrome Đóng Gói Sẵn Đa Nền Tảng (giới hạn ~600MB)

**Feature Branch**: `046-cross-platform-bundled-chrome`

**Created**: 2026-08-20

**Status**: Đã code + build thật + đo dung lượng thật cho Linux (xem `tasks.md`) — **AppImage = 207MB, đạt mục tiêu ~600MB với dư margin lớn**. Windows/Mac: code đã sẵn sàng, chưa build/đo được trên máy dev Linux hiện tại.

**Input**: User description: "nghiên cứu về chrome portable để tự tạo chrome, tự thêm extension để giảm thiểu bước thêm extension hoặc ít ra có thể dễ dàng mở chrome ở nhiều hệ điều hành" + "1 đi bạn [bundle Chrome-for-Testing theo OS]. nhưng cần có phương án hạ xuống để chỉ mất tầm 600mb thôi."

## Bối cảnh — đã đọc code thật, không đoán

- `src/server/services/ProcessManager.js`: `chromeExecutable = fs.existsSync(this.binChromePath) ? this.binChromePath : 'google-chrome'`, với `this.binChromePath` **hard-code cứng** `bin/chrome-win/chrome.exe`. Nghĩa là: trên Windows thiếu file này sẽ fallback về `'google-chrome'` (không tồn tại trên Windows) → lỗi; trên Mac/Linux path Windows không khớp, cũng fallback `'google-chrome'` — chỉ tình cờ chạy được trên Linux có cài sẵn Chrome hệ thống tên đúng lệnh này. **Đa nền tảng hiện tại đang hỏng thật, không chỉ "khó dùng".**
- `electron-builder.yml` đã có sẵn `extraResources: bin/chrome-win -> bin/chrome-win` (chỉ Windows) và cấu hình `mac`/`linux` targets đã tồn tại (dmg/AppImage) nhưng thiếu `bin/chrome-mac`, `bin/chrome-linux` tương ứng.
- **Root cause bloat #1 (đã đo)**: `files: node_modules/**/*` trong `electron-builder.yml` là 1 glob TƯỜNG MINH — theo tài liệu electron-builder, khi tự khai `files` bao gồm `node_modules/**/*`, cơ chế tự động loại `devDependencies` bị vô hiệu, mọi thứ nằm trong `node_modules/` (kể cả dev-only) đều bị đóng gói trừ khi có dấu `!` loại trừ tường minh — hiện KHÔNG có bất kỳ loại trừ nào cho devDependencies.
- **Root cause bloat #2 (đã đo)**: `lucide-react` (43MB), `emoji-picker-react` (34MB), `react`/`react-dom`/`react-colorful` nằm trong `dependencies` (không phải `devDependencies`) dù đây là thư viện **CHỈ dùng ở client React** — code thực tế dùng đã được Vite bundle/minify sẵn vào `dist/client/**/*`. Bản thân `node_modules/lucide-react` etc. không bao giờ được `require()` ở Node/Electron main process lúc runtime, nhưng đang bị đóng gói y nguyên vào bản cài do glob `node_modules/**/*` không phân biệt.
- Số đo thật (`du -sh node_modules/*`, máy dev): `electron` 264MB (dev unpacked, ước tính bản đóng gói/nén qua NSIS còn ~150-180MB theo baseline điện electron-builder), `lucide-react` 43MB, `emoji-picker-react` 34MB, `electron-winstaller` 32MB (transitive dep của `electron-builder`, chỉ dùng lúc BUILD, không cần lúc chạy), `better-sqlite3` 27MB (runtime thật, giữ lại), `exceljs` 23MB (runtime thật, giữ lại).
- Chưa có `@puppeteer/browsers` hay công cụ tải Chrome-for-Testing nào trong `devDependencies`/`dependencies` — cần thêm mới.

## Yêu cầu

- **FR-001**: Tải sẵn bản **Chrome for Testing** (không phải Chrome có thương hiệu Google — được phép redistribute tự do cho mục đích automation) cho cả 3 hệ điều hành (Windows x64, macOS x64+arm64, Linux x64) qua `@puppeteer/browsers`, lưu vào `bin/chrome-win/`, `bin/chrome-mac/`, `bin/chrome-linux/` tương ứng.
- **FR-002**: Sửa `ProcessManager.js` để chọn đúng path theo `process.platform` (`win32` → `bin/chrome-win/chrome.exe`, `darwin` → `bin/chrome-mac/.../Chromium.app/Contents/MacOS/Chromium` hoặc tên thật sau khi tải, `linux` → `bin/chrome-linux/chrome`), bỏ hẳn fallback `'google-chrome'` sai — nếu thiếu file thật sự, log lỗi rõ ràng thay vì spawn nhầm lệnh không tồn tại.
- **FR-003**: Cập nhật `electron-builder.yml`: thêm `extraResources` cho `bin/chrome-mac`, `bin/chrome-linux` (mirror đúng cấu trúc `bin/chrome-win` hiện có).
- **FR-004 (giảm size — root cause #1)**: Sửa `files` trong `electron-builder.yml` để loại trừ tường minh các gói chỉ dùng lúc build/dev: `electron-builder`, `electron-winstaller` và mọi transitive dep chỉ phục vụ đóng gói, KHÔNG bao giờ được `require()` ở runtime.
- **FR-005 (giảm size — root cause #2)**: Loại trừ tường minh `node_modules/lucide-react`, `node_modules/emoji-picker-react`, `node_modules/react`, `node_modules/react-dom`, `node_modules/react-colorful` khỏi `files` glob trong `electron-builder.yml` (giữ nguyên trong `dependencies` của `package.json` — chúng vẫn là dependency thật của app, chỉ là không cần bản `node_modules` vật lý trong gói cài vì Vite đã bundle sẵn code thực dùng vào `dist/client/**/*`).
- **FR-006 (giảm size — Chrome)**: Sau khi tải Chrome for Testing, chạy bước "prune" xoá các file ngôn ngữ (`.pak`) không cần thiết — chỉ giữ `vi` và `en-US` — trước khi đưa vào `bin/chrome-<os>/`.
- **FR-007**: Sau khi áp dụng FR-004/005/006, build thật (`npm run dist:win`, và tương tự cho mac/linux nếu máy CI hỗ trợ) và **đo dung lượng cài đặt thật** — không chỉ ước tính. Nếu vẫn vượt ~600MB dù đã prune, ghi nhận số đo thật + đề xuất phương án B (tải Chrome lúc chạy lần đầu thay vì đóng gói sẵn) làm phương án dự phòng cho riêng OS bị vượt ngưỡng, không áp dụng đại trà nếu không cần thiết.
- **FR-008**: Thêm script `dist:mac` vào `package.json` (hiện chỉ có `dist:win`, `dist:linux` dù `electron-builder.yml` đã có cấu hình `mac`).

## Success Criteria

- **SC-001**: `ProcessManager.js` mở được Chrome đúng trên cả 3 OS bằng file Chrome đóng gói sẵn, không phụ thuộc Chrome hệ thống đã cài hay chưa.
- **SC-002**: Dung lượng bản cài đặt (installer/dmg/AppImage) sau khi build thật ở mỗi OS ở mức **~600MB hoặc thấp hơn** — đo bằng file thật, không phải ước tính.
- **SC-003**: Không regression — app vẫn chạy đúng UI (react/lucide-react/emoji-picker-react vẫn hoạt động bình thường trong `dist/client`, chỉ khác là không còn bị nhân bản thừa trong `node_modules` đóng gói).

## Out of Scope

- Không đổi kiến trúc automation sang Electron `session.loadExtension()` (phương án 2 đã cân nhắc và bị loại vì rủi ro fingerprint/khoá tài khoản Facebook khách hàng cao hơn).
- Không publish extension lên Chrome Web Store (đã loại vì extension scrape DOM Facebook, rủi ro bị gỡ theo ToS).
- Không tự động hoá việc ký code (code signing) cho Mac/Windows installer — nằm ngoài phạm vi giảm dung lượng, để làm riêng nếu cần phát hành chính thức.
