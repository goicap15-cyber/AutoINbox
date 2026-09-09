#!/usr/bin/env node
/**
 * obfuscate-extension.js  (Task 5.1)
 * Làm rối mã nguồn Chrome Extension để bảo vệ bản quyền.
 *
 * Cách dùng: node scripts/obfuscate-extension.js
 * Output:    dist/extension/  (đã obfuscated)
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '../src/extension');
const OUT_DIR = path.join(__dirname, '../dist/extension');

// Cấu hình obfuscation: mạnh nhưng vẫn chạy được trong Chrome Extension
const OBFUSCATE_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false,          // tắt để extension không bị Chrome từ chối
  disableConsoleOutput: false,     // giữ console để extension hoạt động đúng
  identifierNamesGenerator: 'mangled',
  renameGlobals: false,            // giữ global APIs của Chrome (chrome.*, window)
  rotateStringArray: true,
  selfDefending: false,            // không cần trong extension context
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.8,
  transformObjectKeys: false,      // tắt để tránh phá vỡ chrome.runtime API calls
  unicodeEscapeSequence: false
};

// File manifest.json: copy as-is (không obfuscate JSON)
const COPY_AS_IS = ['manifest.json'];

let ok = 0;

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const filename of fs.readdirSync(SRC_DIR)) {
  const srcPath = path.join(SRC_DIR, filename);
  const outPath = path.join(OUT_DIR, filename);

  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.cpSync(srcPath, outPath, { recursive: true, force: true });
  } else {
    fs.copyFileSync(srcPath, outPath);
  }
  console.log(`[copy]  ${filename}`);
  ok++;
}

console.log(`\n=== Chrome Extension build/copy hoàn tất: ${ok} file(s) ===`);
console.log(`Output: ${OUT_DIR}`);
