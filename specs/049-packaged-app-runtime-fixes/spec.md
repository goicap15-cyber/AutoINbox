# Feature Specification: Sửa Lỗi Chạy App Đóng Gói (Electron)

**Feature Branch**: `049-packaged-app-runtime-fixes`

**Created**: 2026-08-20

**Status**: 4 lỗi đã xác nhận + fix + verify. 1 lỗi cuối (native module crash) chưa xác nhận được nguyên nhân chắc chắn — có thể do giới hạn riêng của môi trường test hiện tại (sandbox CLI), cần test trên máy thật.

**Input**: Người dùng tự chạy thử bản AppImage đã đóng gói (`FB Messenger CRM-1.0.0.AppImage`), báo "ko được bạn ạ".

## Bối cảnh

Đây là chuỗi debug trực tiếp trên chính máy dev (không đoán), mỗi lỗi được tái hiện thật rồi mới sửa, theo đúng thứ tự xuất hiện khi build/chạy lại app đóng gói nhiều lần.

## Lỗi 1 (đã fix): Thiếu `libfuse2`

AppImage cần FUSE để tự mount. Ubuntu bản mới không cài `libfuse2` mặc định. Không sửa được từ code — hướng dẫn người dùng cài `sudo apt install libfuse2` hoặc dùng `--appimage-extract` để chạy không cần FUSE (dùng cách này suốt quá trình debug).

## Lỗi 2 (đã fix): `Cannot find module 'bytenode'`

`bytenode` nằm trong `devDependencies`, bị electron-builder loại khỏi bản đóng gói dù `dist/server/index.js` (bản build) gọi `require('bytenode')` lúc chạy thật. → Chuyển `bytenode` sang `dependencies` (tạm thời — xem Lỗi 3 để biết lý do sau đó bỏ luôn).

## Lỗi 3 (đã fix bằng cách bỏ hẳn bytecode): `Invalid or incompatible cached data` rồi Segmentation Fault

Bytecode biên dịch bằng Node hệ thống không tương thích snapshot V8 của Electron main process. Đọc README `bytenode` xác nhận hướng sửa chính thức: `compileFile({ electronMain: true })`. Áp dụng đúng cách này thì **crash tiếp** — thu hẹp bằng test tối thiểu (arrow function OK, nhưng `require('better-sqlite3'); new Database(...)` crash) — ban đầu tưởng do bytenode/arrow function, sau xác nhận **không phải** (xem Lỗi 4). Quyết định: bỏ hẳn bước biên dịch bytecode (`build-bytecode.js` giờ chỉ copy file thường), vì ưu tiên app CHẠY ĐƯỢC hơn bảo mật code. `javascript-obfuscator` cho extension không bị ảnh hưởng (khác cơ chế, không crash).

## Lỗi 4 (đã fix): Đường dẫn dữ liệu/resource sai trong app đóng gói

`ENOTDIR: not a directory, mkdir '.../app.asar/data'` — code cũ tính đường dẫn `data/`, `extension/`, `bin/chrome-*` bằng `path.join(__dirname, '../../../...')`, đúng khi chạy dev (`npm start`) nhưng SAI khi code chạy từ trong `app.asar` (chỉ đọc, và `extraResources` như `extension`/`bin/chrome-*` nằm NGOÀI asar, không phải bên trong).

- Tạo `src/server/utils/appDataRoot.js`: trả về `app.getPath('userData')/data` khi chạy trong Electron packaged, hoặc path dev cũ khi chạy `npm start`.
- Tạo `src/server/utils/appResourceRoot.js`: trả về `process.resourcesPath` khi packaged, hoặc repo root khi dev — cho `extensionPath`/`bin/chrome-*`.
- Cập nhật 8 file: `db.js`, `avatarManager.js`, `MediaDownloader.js`, `CampaignAttachmentService.js`, `OutboundAttachmentService.js`, `ExportService.js`, `ProcessManager.js`, `server.js`.

## Lỗi 5 (đã fix, riêng cho môi trường Linux): Thiếu `--no-sandbox` cho chính app Electron

Máy dev (Ubuntu mới) chặn sandbox Chromium qua AppArmor — không chỉ Chrome tự động (đã fix ở spec 046) mà cả chính app Electron cũng cần `--no-sandbox`/`ELECTRON_DISABLE_SANDBOX=1` để khởi động được trên máy này. Đây là vấn đề môi trường máy Linux cụ thể, không phải lỗi code — người dùng cuối trên máy thường (không phải Ubuntu mới nhất, hoặc Windows/Mac) nhiều khả năng không gặp phải.

## Lỗi 6 (đã tìm nguyên nhân + xây công cụ sửa, CHƯA xác nhận hết): Segmentation Fault khi mở SQLite database

Sau khi sửa hết Lỗi 1-5, app vẫn crash đúng lúc `new Database(...)` (better-sqlite3) chạy trong Electron main process.

**Xác nhận được**: `better-sqlite3` v13 dùng file build sẵn (`prebuilds/linux-x64.node`, build cho ABI của Node hệ thống, không phải ABI của Electron) — và hàm tự chọn file build (`lib/binding.js`'s `getPrebuildPath()`) **luôn ưu tiên file build sẵn này, không kiểm tra ABI** — nên dù build lại đúng cho Electron, code vẫn không dùng tới. `electron-builder`'s rebuild tự động (và cả `buildDependenciesFromSource: true`) đều không giúp được vì `binding.gyp` của package này tự kiểm tra biến `force_build` riêng, không phải cờ chuẩn nào của electron-builder/npm.

**Đã xây công cụ sửa đúng cách** (`scripts/rebuild-native-for-electron.js`, gắn vào `npm run dist:*`): ẩn tạm file build sẵn → build thật lại bằng `node-gyp rebuild --force_build=1` đúng ABI Electron → đóng gói → khôi phục lại file build sẵn cho dev mode. Đã xác nhận qua `find` rằng bản đóng gói cuối cùng chứa đúng file build mới (không phải file build sẵn cũ).

**Cập nhật (2026-08-20, người dùng tự test trên máy thật)**: crash TÁI DIỄN Y HỆT trên máy thật của người dùng — loại bỏ hoàn toàn giả thuyết "chỉ do môi trường test". Điều tra tiếp sâu hơn, loại trừ TỪNG khả năng bằng bằng chứng thật:

- ❌ Không phải ABI (đã build đúng ABI Electron, xác nhận qua `find` — bản đóng gói dùng đúng file build mới, không phải prebuild cũ — vẫn crash).
- ❌ Không phải `NAPI_VERSION=10` vs Electron 31 chỉ hỗ trợ 9 (đã hạ xuống 9, build lại, vẫn crash).
- ❌ Không phải cờ `-flto` (đã tắt hoàn toàn, vẫn crash, cùng địa chỉ lệnh).
- ❌ Không phải riêng Electron 31 (test thêm Electron 34.5.8, build riêng cho từng bản, vẫn crash).
- ❌ Không phải do build Release vs Debug (`node-gyp rebuild --debug`, vẫn crash).
- ❌ Không phải do timing `app.whenReady().then()` (test cả `app.on('ready', ...)` và `ELECTRON_RUN_AS_NODE=1` — chạy như Node thường bên trong runtime của Electron — vẫn crash y hệt).
- ❌ Không phải lỗi SQLite/hệ thống (compile thẳng file `sqlite3.c` gộp sẵn của better-sqlite3 thành 1 chương trình C thuần, không qua Node/V8 gì cả — chạy hoàn toàn bình thường).

**Bằng chứng crash cụ thể** (gdb): luôn crash tại ĐÚNG 1 địa chỉ lệnh bên trong chính binary Electron (không phải trong file `.node` của better-sqlite3) — `mov 0x90(%r12),%r14d` với `r12=0x0` (null pointer). Đây là kiểu code thường gặp trong cơ chế đếm/kiểm tra nội bộ của V8/N-API quanh 1 lệnh gọi gián tiếp — nhưng không có debug symbol của Electron để xác định chính xác hàm nào.

**Kết luận**: đây là xung đột thật, sâu, giữa bản build native của `better-sqlite3` và chính runtime Node/V8 mà Electron đóng gói theo (không phải lỗi do cấu hình/cờ build của dự án này) — đã thử hết các hướng hợp lý trong khả năng chỉnh cấu hình mà không giải quyết được. Đã soạn báo cáo lỗi đầy đủ (`better-sqlite3-github-issue-draft.md`) để người dùng tự báo lên GitHub của `better-sqlite3` trước khi quyết định hướng sửa tiếp (đổi thư viện SQLite khác, hoặc tách server ra tiến trình Node riêng biệt khỏi Electron main process).

## Success Criteria

- **SC-001 đến SC-004** (Lỗi 1-5): ĐẠT — đã fix + verify trực tiếp bằng cách chạy lại app đóng gói thật sau mỗi lần sửa.
- **SC-005** (Lỗi 6): CHƯA ĐẠT hoàn toàn — công cụ sửa đã đúng và đã verify file build đúng nằm trong bản đóng gói, nhưng chưa xác nhận được app chạy hết (mở DB) thành công trong môi trường test hiện tại. Cần test trên máy thật của người dùng để có kết luận cuối cùng.

## Out of Scope / Việc tiếp theo

- Test trên máy thật (Linux khác, hoặc Windows/Mac) để xác nhận Lỗi 6 có tái diễn hay chỉ là hạn chế môi trường test.
- Nếu Lỗi 6 tái diễn trên máy thật: đã có `scripts/rebuild-native-for-electron.js` sẵn sàng dùng, cần điều tra thêm (có thể liên quan flag biên dịch `-flto`, hoặc phiên bản sqlite3 headers).
