// Resolves paths to this app's READ-ONLY bundled resources - the Chrome
// extension source and the bundled Chrome-for-Testing binaries
// (bin/chrome-win, bin/chrome-mac, bin/chrome-linux).
//
// Dev (`npm start`, plain Node, no Electron): src/extension and bin/ sit
// directly under the repo root - identical to what ProcessManager.js
// hard-coded before, so dev behavior is unchanged.
//
// Packaged app: electron-builder's `extraResources` places these folders
// directly under resources/ (a SIBLING of app.asar, e.g. resources/extension,
// resources/bin/chrome-linux - see electron-builder.yml), flattened (no
// src/ prefix) and not inside the asar archive the server code itself runs
// from. A path built by navigating __dirname-relative from inside app.asar
// can never reach a sibling folder outside it (live-reproduced 2026-08-20:
// the extension path resolved to a nonexistent location inside app.asar) -
// this uses Electron's own process.resourcesPath instead, which always
// points at exactly that resources/ directory in a packaged app. The two
// modes have genuinely different relative layouts (dev nests extension
// under src/, packaged does not), so this exports resolved paths directly
// rather than a single generic "root" the caller would have to branch on.
const path = require('path');

function isPackaged() {
  try {
    const electron = require('electron');
    return !!(electron && electron.app && electron.app.isPackaged);
  } catch (_) {
    return false;
  }
}

const REPO_ROOT = path.join(__dirname, '../../..');

function resolveExtensionPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'extension') : path.join(REPO_ROOT, 'src', 'extension');
}

function resolveBinRoot() {
  return isPackaged() ? process.resourcesPath : REPO_ROOT;
}

module.exports = { resolveExtensionPath, resolveBinRoot };
