#!/usr/bin/env node
/**
 * build-bytecode.js  (Task 5.1)
 * Copies src/server -> dist/server for packaging.
 *
 * NOT actually bytecode anymore - see the big comment below for why. Kept
 * the filename/output layout (dist/server/**\/*.js, same directory
 * structure) so electron-builder.yml and src/electron.js's
 * dist/server/index.js lookup didn't need to change.
 *
 * Cách dùng: node scripts/build-bytecode.js
 * Output:    dist/server/**\/*.js (plain copy, not compiled)
 */

// ── Why this doesn't compile to V8 bytecode anymore ─────────────────────
// This used to run every file through bytenode.compileFile({ electronMain:
// true, ... }) to protect the server source in the packaged app (see git
// history). Live-reproduced 2026-08-20 while testing the packaged AppImage:
// the app SEGFAULTED (not a catchable JS error - a native crash, exit code
// 139) as soon as db.js's `new Database(dbPath)` (better-sqlite3, a native
// addon) ran from inside bytenode-compiled code loaded in Electron's main
// process.
//
// Isolated with a minimal repro outside this codebase: a plain arrow
// function compiled the same way (electronMain: true) loads and runs fine;
// requiring better-sqlite3 without opening a database also loads fine;
// calling `new Database(...)` is exactly where it segfaults. This is a
// fundamental incompatibility between bytenode's V8-bytecode-only
// compilation and native Node addons that grab V8 Context/Isolate
// references at call time (not just at require time) - not something fixable
// from this codebase's side, and not specific to any one file here: nearly
// every server module transitively requires db.js, so there's no reasonably-
// sized subset of files that could still be bytecode-compiled without
// eventually touching better-sqlite3.
//
// Getting the packaged app to actually RUN matters more than hiding server
// source, so this step is now a plain copy. The Chrome extension's
// obfuscation (scripts/obfuscate-extension.js, javascript-obfuscator) is
// unaffected - it stays valid, readable-but-scrambled JS rather than V8
// bytecode, so it has no native-module interaction to break.

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '../src/server');
const OUT_DIR = path.join(__dirname, '../dist/server');

let copied = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(srcPath);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.sql')) {
      const rel = path.relative(SRC_DIR, srcPath);
      const outPath = path.join(OUT_DIR, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(srcPath, outPath);
      copied++;
      console.log(`[copy ]  ${rel}`);
    }
  }
}

console.log('=== dist/server copy (bytecode compilation disabled - see comment) ===');
console.log(`Source: ${SRC_DIR}`);
console.log(`Output: ${OUT_DIR}\n`);

if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true });
}
fs.mkdirSync(OUT_DIR, { recursive: true });

walk(SRC_DIR);

console.log(`\n=== Hoàn tất ===`);
console.log(`Đã copy: ${copied} file(s)`);
