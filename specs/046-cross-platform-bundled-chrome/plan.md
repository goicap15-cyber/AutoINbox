# Implementation Plan: Chrome Đóng Gói Sẵn Đa Nền Tảng (giới hạn ~600MB)

**Branch**: `046-cross-platform-bundled-chrome` | **Date**: 2026-08-20 | **Spec**: `specs/046-cross-platform-bundled-chrome/spec.md`

## Summary

`ProcessManager.js` hiện chỉ có Chrome đóng gói sẵn cho Windows (`bin/chrome-win`), fallback `'google-chrome'` sai trên Mac/Windows-thiếu-file. Kế hoạch: dùng `@puppeteer/browsers` tải **Chrome for Testing** cho cả 3 OS, sửa `ProcessManager.js` chọn đúng path theo `process.platform`, cập nhật `electron-builder.yml` thêm `extraResources` cho mac/linux. Song song, xử lý 2 nguồn phình dung lượng đã đo được thật (glob `node_modules/**/*` không loại trừ devDependencies; các thư viện chỉ dùng ở client React như `lucide-react`/`emoji-picker-react` đang nằm nhầm trong `dependencies`) + prune locale thừa của Chrome for Testing, để hướng tới mục tiêu ~600MB/installer.

## Technical Context

- Thêm dependency mới: `@puppeteer/browsers` (devDependency — chỉ cần lúc build/tải Chrome, không cần lúc runtime của app đã đóng gói).
- Không đổi kiến trúc automation (vẫn spawn Chrome thật qua `child_process.spawn` + `--load-extension`, không chuyển sang Electron `session.loadExtension`).
- Cần môi trường build thật (Windows/Mac/Linux hoặc CI tương ứng) để tải bản Chrome-for-Testing đúng OS và đo dung lượng installer thật — không thể giả lập chính xác 100% trên 1 máy dev Linux.

## Constitution Check

Theo `PROJECT_RULES.md`: spec trước, `graphify update .` sau khi code xong. Không có gate đặc thù khác. Không đổi `dependencies`/`devDependencies` trong `package.json` (xem FR-005 đã sửa) — chỉ đổi `electron-builder.yml`'s `files` glob, nên rủi ro thấp; vẫn cần `npm run build:ui` + build thử để xác nhận UI không bị thiếu gì sau khi loại trừ khỏi gói cài.

## Project Structure

```text
specs/046-cross-platform-bundled-chrome/
├── plan.md    # File này
├── spec.md    # Đã tạo
└── tasks.md   # Tiếp theo

scripts/fetch-chrome-for-testing.js   # (mới) dùng @puppeteer/browsers tải + prune Chrome cho 1 OS, gọi qua npm script
src/server/services/ProcessManager.js # sửa resolveChromePath() theo process.platform
electron-builder.yml                  # thêm extraResources mac/linux; sửa files loại trừ devDependencies + lib client-only
package.json                          # thêm @puppeteer/browsers (devDep), script fetch-chrome:*, dist:mac; di chuyển 5 lib sang devDependencies
bin/chrome-win/, bin/chrome-mac/, bin/chrome-linux/  # (mới/giữ) chứa bản Chrome for Testing đã prune theo OS
```

## Phase 0: Research (đã xong — xem spec.md Bối cảnh)

Đã đo thật bằng `du -sh node_modules/*` và đọc `electron-builder.yml`/`ProcessManager.js`/`package.json`. Không có `NEEDS CLARIFICATION` về nguyên nhân bloat. **Có 1 điểm CHƯA đo được** (cần làm ở Phase 2, không đoán trước): dung lượng thật của Chrome-for-Testing đã prune trên từng OS, và dung lượng installer cuối cùng sau khi build thật — spec.md's FR-007 đã ghi rõ đây là bước đo bắt buộc, không cam kết số chính xác trước khi đo.

## Phase 1: Design

**1. `scripts/fetch-chrome-for-testing.js`** (mới, chạy qua `node scripts/fetch-chrome-for-testing.js <platform>`):
```js
const { install, Browser, BrowserPlatform } = require('@puppeteer/browsers');
// platform arg: 'win64' | 'mac_arm64' | 'mac_x64' | 'linux64' (theo enum của @puppeteer/browsers)
// Tải Chrome for Testing (KHÔNG phải Chrome thương hiệu Google) về bin/chrome-<os>/
// Sau khi tải xong: prune - xoá toàn bộ *.pak trong locales/ trừ vi.pak và en-US.pak,
// xoá *.pdb (Windows debug symbols) nếu có.
```

**2. `ProcessManager.js`** — thay 2 chỗ `chromeExecutable = fs.existsSync(this.binChromePath) ? this.binChromePath : 'google-chrome'` bằng hàm dùng chung:
```js
function resolveBundledChromePath() {
  const map = {
    win32: path.join(__dirname, '../../../bin/chrome-win/chrome.exe'),
    darwin: path.join(__dirname, '../../../bin/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    linux: path.join(__dirname, '../../../bin/chrome-linux/chrome')
  };
  const p = map[process.platform];
  if (p && fs.existsSync(p)) return p;
  return null; // KHÔNG fallback 'google-chrome' sai nữa - null nghĩa là thiếu thật, caller phải báo lỗi rõ ràng
}
```
Tên thư mục/binary thật bên trong `.app`/`.zip` sau khi `@puppeteer/browsers` tải cần xác nhận lại (thường là `chrome-mac-x64/Google Chrome for Testing.app/...` — sẽ ghi lại tên chính xác vào `tasks.md` sau khi chạy `fetch-chrome-for-testing.js` thật, không đoán trước tên trong plan này).

**3. `electron-builder.yml`**:
```yaml
extraResources:
  - from: bin/chrome-win
    to: bin/chrome-win
    filter: "**/*"
  - from: bin/chrome-mac
    to: bin/chrome-mac
    filter: "**/*"
  - from: bin/chrome-linux
    to: bin/chrome-linux
    filter: "**/*"
  - from: dist/extension
    to: extension

files:
  - dist/server/**/*
  - dist/client/**/*
  - dist/extension/**/*
  - src/electron.js
  - data/.gitkeep
  - node_modules/**/*
  - package.json
  - "!node_modules/.cache"
  - "!**/*.map"
  - "!**/*.md"
  - "!scripts/**/*"
  - "!*.log"
  # FR-004: build/dev-only, không bao giờ require() lúc runtime
  - "!node_modules/electron-builder/**"
  - "!node_modules/electron-winstaller/**"
  - "!node_modules/app-builder-lib/**"
  # FR-005: chỉ Vite build-time cần, đã bundle sẵn vào dist/client
  - "!node_modules/lucide-react/**"
  - "!node_modules/emoji-picker-react/**"
  - "!node_modules/react/**"
  - "!node_modules/react-dom/**"
  - "!node_modules/react-colorful/**"
```
(Danh sách loại trừ build/dev-only cần rà thêm lúc implement — kiểm tra `du -sh node_modules/*` sau khi build thử để bắt các gói lớn còn sót, không chỉ dừng ở danh sách đã thấy hôm nay.)

**4. `package.json`**:
```json
"scripts": {
  "fetch-chrome:win": "node scripts/fetch-chrome-for-testing.js win64",
  "fetch-chrome:mac": "node scripts/fetch-chrome-for-testing.js mac",
  "fetch-chrome:linux": "node scripts/fetch-chrome-for-testing.js linux64",
  "dist:mac": "npm run build:all && electron-builder --mac"
},
"devDependencies": {
  // thêm: "@puppeteer/browsers": "^2.x"
}
```
`dependencies` giữ nguyên như hiện tại — `lucide-react`/`emoji-picker-react`/`react`/`react-dom`/`react-colorful` vẫn là dependency thật của app (đúng bản chất, dễ đọc cho người sau), chỉ loại trừ bản `node_modules` vật lý của chúng khỏi gói cài qua `files` glob ở bước 3 (FR-005 đã sửa lại theo hướng này thay vì đổi sang `devDependencies`, để không gây hiểu nhầm về đồ thị dependency thật).

## Phase 2: Validation Plan

- `npm run fetch-chrome:linux` chạy thật trên máy dev hiện tại (Linux) → xác nhận `@puppeteer/browsers` hoạt động, đo dung lượng Chrome-for-Testing trước/sau prune.
- `npm run build:ui` sau khi chuyển 5 lib sang `devDependencies` → xác nhận Vite build `dist/client` không lỗi (SC-003, không regression UI).
- `npm run dist:linux` build thật → `du -sh release/*.AppImage` đo dung lượng thật, so với mục tiêu 600MB (SC-002).
- Windows/Mac: cần máy/CI tương ứng — ghi lại trong `tasks.md` là "chưa đo được trên máy dev Linux hiện tại", không giả định số liệu.
- `node --check` cho `scripts/fetch-chrome-for-testing.js` và `ProcessManager.js`.
- `graphify update .`.

## Out of Scope

- Electron `session.loadExtension()` (đã loại ở bước nghiên cứu, rủi ro fingerprint Facebook).
- Chrome Web Store publish.
- Code signing Windows/Mac installer.
- Đo dung lượng thật trên Windows/Mac nếu máy dev hiện tại (Linux) không có sẵn Wine/CI tương ứng — sẽ ghi rõ giới hạn này trong `tasks.md`, không bịa số.
