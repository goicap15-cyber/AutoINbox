# Tasks: Packaged App Runtime Fixes

- [x] Reproduce the Windows packaged crash at `new Database(...)`.
- [x] Pin `better-sqlite3` to a release compatible with Electron 31.
- [x] Preserve and restore the host-Node native build around packaging.
- [x] Fail packaging when the Electron SQLite smoke test fails.
- [x] Move license and machine-ID persistence to `APP_DATA_ROOT`.
- [x] Include the Chrome path resolver required by packaged `ProcessManager`.
- [x] Embed `.env` in `app.asar` and load it through ASAR-aware `fs` before importing services.
- [x] Run persistence tests and production build.
- [x] Launch the packaged Windows executable and verify the UI/backend.
