// AutoChatbot - Cross-platform bundled Chrome path resolution.
//
// Isolated on purpose (spec 046): ProcessManager.js only ever calls
// resolveChromePath() - the platform/fallback logic itself lives entirely in
// this file so the Chrome-bundling work (spec 046) can't destabilize the
// live account-launching code path it plugs into.
//
// Safe-by-construction fallback: if a platform's bundled Chrome for Testing
// hasn't been fetched yet (bin/chrome-mac, bin/chrome-linux don't exist
// until `npm run fetch-chrome:*` is run), this falls back to the EXACT
// pre-spec-046 behavior (legacyBinChromePath, then 'google-chrome') - so
// today's Windows/Linux behavior is unchanged until the new binaries are
// actually in place, and Mac is no worse than it was before (still relies on
// a system 'google-chrome' command, which doesn't exist on Mac - a
// pre-existing gap this resolver only fixes once bin/chrome-mac is fetched).

const fs = require('fs');
const path = require('path');

// Per-platform relative path to the bundled Chrome for Testing executable,
// relative to the repo root. @puppeteer/browsers itself nests the executable
// one level deeper (e.g. chrome-linux64/chrome, chrome-win64/chrome.exe) -
// fetchChromeForTesting.js flattens that wrapper folder away on purpose so
// this map (and the pre-existing bin/chrome-win/chrome.exe convention) stays
// a single flat, version-independent path per OS.
const BUNDLED_CHROME_RELATIVE_PATH = {
  win32: path.join('bin', 'chrome-win', 'chrome.exe'),
  darwin: path.join('bin', 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  linux: path.join('bin', 'chrome-linux', 'chrome')
};

/**
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute path to the repo root (bin/ lives directly under it).
 * @param {string} [opts.legacyBinChromePath] - ProcessManager's pre-spec-046 hardcoded
 *   Windows-only path, passed through so the fallback below is byte-for-byte
 *   identical to the old behavior when the new bundled path isn't present yet.
 * @returns {string} an executable path or command name to spawn - never throws,
 *   never returns null (callers historically spawn this value unconditionally).
 */
function findSystemChromePath() {
  if (process.platform !== 'win32') return null;
  const sysWinPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google\\Chrome\\Application\\chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe') : null
  ].filter(Boolean);
  return sysWinPaths.find((sysPath) => fs.existsSync(sysPath)) || null;
}

function resolveChromePath({ repoRoot, legacyBinChromePath, preferSystemChrome = false }) {
  const systemChrome = findSystemChromePath();
  if (preferSystemChrome && systemChrome) return systemChrome;

  const relative = BUNDLED_CHROME_RELATIVE_PATH[process.platform];
  if (relative) {
    const bundled = path.join(repoRoot, relative);
    if (fs.existsSync(bundled)) return bundled;
  }

  if (legacyBinChromePath && fs.existsSync(legacyBinChromePath)) return legacyBinChromePath;

  if (systemChrome) return systemChrome;

  return 'google-chrome';
}

module.exports = { resolveChromePath, findSystemChromePath, BUNDLED_CHROME_RELATIVE_PATH };
