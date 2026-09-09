# [Bug] SIGSEGV in Electron main process on `new Database(...)`, only when native module is compiled against Electron's own headers (works fine as system-Node prebuild)

## Environment

- OS: Ubuntu 24.04.4 LTS, kernel 6.17.0-35-generic, x86_64
- gcc: 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04.1)
- System Node.js: v24.19.0 (`process.versions.modules` = 137)
- better-sqlite3: 13.0.3
- node-addon-api: 8.9.2
- Electron: tested both 31.0.0 (Node 20.14.0, `process.versions.napi` = 9) and 34.5.8 — same crash on both

## Summary

`new Database(path)` segfaults immediately inside Electron's own process (main process, and also under `ELECTRON_RUN_AS_NODE=1`) whenever `better-sqlite3` is built specifically against Electron's headers/ABI (via `node-gyp rebuild --target=<electron-version> --dist-url=https://electronjs.org/headers --force_build=1`). The exact same code runs perfectly under plain system Node.js using the shipped `prebuilds/linux-x64.node` (built for the system Node ABI).

## Steps to reproduce

```sh
npm install better-sqlite3@13.0.3 electron@31.0.0 --save-dev

# Force a real from-source build against Electron's ABI (the shipped
# prebuild is for the system Node ABI and gets silently reused otherwise -
# node_modules/better-sqlite3/binding.gyp only compiles when
# force_build==1 or its own lib/binding.js reports no prebuild for the host
# platform+arch, and it does NOT check ABI when deciding that).
mv node_modules/better-sqlite3/prebuilds/linux-x64.node{,.bak}
rm -rf node_modules/better-sqlite3/build
npx node-gyp rebuild --target=31.0.0 --arch=x64 \
  --dist-url=https://electronjs.org/headers --force_build=1 \
  --directory=node_modules/better-sqlite3
```

`loader.js`:
```js
const { app } = require('electron');
app.whenReady().then(() => {
  const Database = require('better-sqlite3');   // OK
  const db = new Database('/tmp/test.db');       // SIGSEGV here
});
```

```sh
ELECTRON_DISABLE_SANDBOX=1 ./node_modules/.bin/electron --no-sandbox --disable-gpu loader.js
# Segmentation fault (core dumped)
```

## What was ruled out (each confirmed independently)

- **Not an ABI mismatch**: crash happens even with a binary correctly compiled against Electron's own headers/target version (confirmed the packaged app's `app.asar.unpacked` copy loads the rebuilt `build/Release/better_sqlite3.node`, not the shipped prebuild, via directory listing).
- **Not NAPI_VERSION 10 vs the host's supported 9** (Electron 31 / Node 20.14 reports `process.versions.napi = 9`; better-sqlite3's binding.gyp hardcodes `NAPI_VERSION=10`): rebuilt with `NAPI_VERSION=9`, same crash.
- **Not `-flto`**: rebuilt with all `-flto` flags stripped from binding.gyp, same crash, same faulting instruction address.
- **Not Electron-version-specific**: reproduced identically on Electron 31.0.0 and Electron 34.5.8 (rebuilt against each version's own headers/target).
- **Not Release-vs-Debug codegen**: `node-gyp rebuild --debug` produces the same crash.
- **Not `app.whenReady().then()` timing**: reproduced identically via `app.on('ready', ...)` and under `ELECTRON_RUN_AS_NODE=1` (Electron's own bundled Node runtime in plain-Node mode, no BrowserWindow/app lifecycle involved at all).
- **Not SQLite/system-level**: compiled the exact same bundled `deps/sqlite3/sqlite3.c` amalgamation as a standalone C program (no Node/V8/N-API at all) - opens, prepares, steps, and closes a database with no issue.
- **Not electron-builder's packaging**: reproduced with a bare `npx electron`/`electron-builder`-produced AppImage alike, and independently with the raw `node_modules/electron/dist/electron` binary directly.

## Crash signature

GDB backtrace (same instruction address `0x...a3ef`, regardless of which build variant above is loaded):

```
Thread 1 "electron" received signal SIGSEGV, Segmentation fault.
0x000055555f70a3ef in ?? ()
#0  0x000055555f70a3ef in ?? ()
#1  0x00000000000000a1 in ?? ()
...
#5  0x00007fff66c1da00 in ?? () from .../better-sqlite3/build/Release/better_sqlite3.node
```

Disassembly at the fault:
```asm
   0x...a417:	mov    %r13,%rsi
   0x...a41a:	call   *-0x490(%rbp)
=> 0x...a3ef:	mov    0x90(%r12),%r14d      ; r12 = 0x0 here -> null pointer deref
   0x...a3f7:	mov    0x94(%r12),%ebx
   0x...a3ff:	xorps  %xmm0,%xmm0
   0x...a402:	movups %xmm0,0x78(%r12)
   0x...a408:	movq   $0x0,0x88(%r12)
   0x...a414:	mov    %r12,%rdi
   ...
   0x...a420:	cmp    %r14d,0x90(%r12)
```

`r12` is `0x0` at the point of the fault. Frame #0 has no symbol and belongs to the Electron/Chromium main executable itself (not to `better_sqlite3.node`), reached via an indirect call from the addon (frame #5). The pattern (save a field before an indirect call, then compare it after) looks like V8/Node-API internal bookkeeping (e.g. a handle-scope or similar depth counter) operating on a null `Isolate*`/context pointer, but I don't have Electron debug symbols to confirm which function this is.

## Question

Is there a known, supported way to build `better-sqlite3` for use inside Electron's *main process* on Linux that doesn't hit this? Everything I found online assumes `electron-rebuild`/`@electron/rebuild` "just works", but in this case it silently no-ops (this package's own `binding.gyp` only recompiles when `force_build==1`, which neither `@electron/rebuild` nor `electron-builder`'s `buildDependenciesFromSource` config sets) - forcing a real rebuild reproduces this crash consistently.
