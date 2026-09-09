#!/usr/bin/env node
// AutoChatbot - Download a pruned Chrome for Testing build into bin/chrome-<os>/
// (spec 046). Kept in this dedicated folder, separate from the rest of the
// codebase, so build/tooling changes here can't destabilize the live
// account-launching code path (ProcessManager.js only ever reads the
// resulting bin/chrome-<os>/ output via resolveChromePath.js).
//
// Usage: node chrome-bundling/fetchChromeForTesting.js <win64|mac|mac_arm|linux64>
//
// Chrome for Testing (not the "Google Chrome" branded build) is used
// deliberately - Google explicitly permits redistributing it for automation
// use, unlike the branded Chrome binary.

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  install,
  resolveBuildId,
  Browser,
  BrowserPlatform,
  ChromeReleaseChannel
} = require('@puppeteer/browsers');

const REPO_ROOT = path.join(__dirname, '..');

// CLI arg -> ({ @puppeteer/browsers platform enum, final flat bin/ dir name })
// mirrors resolveChromePath.js's BUNDLED_CHROME_RELATIVE_PATH keys (win32/darwin/linux).
const TARGETS = {
  win64: { platform: BrowserPlatform.WIN64, binDirName: 'chrome-win' },
  mac: { platform: BrowserPlatform.MAC, binDirName: 'chrome-mac' },
  mac_arm: { platform: BrowserPlatform.MAC_ARM, binDirName: 'chrome-mac' },
  linux64: { platform: BrowserPlatform.LINUX, binDirName: 'chrome-linux' }
};

// Locales to keep - the app only ever needs Vietnamese (customer-facing) and
// English (Chrome's own internal default). Every other locale .pak (found to
// be ~50MB of the ~390MB Linux build, live-measured 2026-08-20) is dead
// weight for a browser that's only ever pointed at facebook.com.
const KEEP_LOCALE_PREFIXES = ['vi', 'en-US'];

// DRM plugin (Netflix-style protected video playback) - this CRM only
// automates Facebook Messenger text/photo messages, never plays DRM content.
// ~21MB live-measured (2026-08-20), safe to drop entirely.
const PRUNABLE_DIRS = ['WidevineCdm'];

function pruneLocales(executableDir) {
  const localesDir = path.join(executableDir, 'locales');
  if (!fs.existsSync(localesDir)) return { keptFiles: 0, removedFiles: 0 };
  let removed = 0;
  let kept = 0;
  for (const file of fs.readdirSync(localesDir)) {
    const shouldKeep = KEEP_LOCALE_PREFIXES.some(prefix => file.startsWith(prefix));
    if (shouldKeep) {
      kept++;
    } else {
      fs.rmSync(path.join(localesDir, file), { force: true });
      removed++;
    }
  }
  return { keptFiles: kept, removedFiles: removed };
}

function pruneDirs(executableDir) {
  for (const dirName of PRUNABLE_DIRS) {
    const target = path.join(executableDir, dirName);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

async function main() {
  const arg = process.argv[2];
  const target = TARGETS[arg];
  if (!target) {
    console.error(`Usage: node chrome-bundling/fetchChromeForTesting.js <${Object.keys(TARGETS).join('|')}>`);
    process.exit(1);
  }

  const stagingDir = path.join(REPO_ROOT, 'bin', `.staging-${arg}`);
  const finalDir = path.join(REPO_ROOT, 'bin', target.binDirName);

  console.log(`[fetchChromeForTesting] Resolving latest stable Chrome for Testing build id for ${arg}...`);
  const buildId = await resolveBuildId(Browser.CHROME, target.platform, ChromeReleaseChannel.STABLE);
  console.log(`[fetchChromeForTesting] buildId=${buildId}`);

  console.log(`[fetchChromeForTesting] Downloading to staging dir ${stagingDir}...`);
  const installedBrowser = await install({
    cacheDir: stagingDir,
    browser: Browser.CHROME,
    buildId,
    platform: target.platform,
    downloadProgressCallback: 'default'
  });

  const sourceExecutableDir = path.dirname(installedBrowser.executablePath);

  const beforeBytes = dirSizeBytes(sourceExecutableDir);
  pruneLocales(sourceExecutableDir);
  pruneDirs(sourceExecutableDir);
  const afterBytes = dirSizeBytes(sourceExecutableDir);
  console.log(`[fetchChromeForTesting] Pruned ${((beforeBytes - afterBytes) / 1024 / 1024).toFixed(1)}MB (locales + WidevineCdm).`);

  // Flatten: move the pruned executable-dir CONTENTS up into bin/chrome-<os>/
  // directly (no version/arch-suffixed wrapper folder), matching the
  // pre-existing bin/chrome-win/chrome.exe convention this app already used
  // for Windows before spec 046.
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.mkdirSync(finalDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceExecutableDir)) {
    fs.renameSync(path.join(sourceExecutableDir, entry), path.join(finalDir, entry));
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });

  const finalBytes = dirSizeBytes(finalDir);
  console.log(`[fetchChromeForTesting] Done. ${finalDir} = ${(finalBytes / 1024 / 1024).toFixed(1)}MB`);
}

main().catch(err => {
  console.error('[fetchChromeForTesting] Failed:', err.message);
  process.exit(1);
});
