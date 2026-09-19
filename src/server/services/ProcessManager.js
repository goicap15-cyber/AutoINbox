const { spawn, exec, execFile, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveChromePath } = require('../../../chrome-bundling/resolveChromePath');
const { resolveExtensionPath, resolveBinRoot } = require('../utils/appResourceRoot');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

// Older databases store Chrome profiles as repo-relative paths such as
// `data/profiles/<account>`. In a packaged Electron app, resolving those from
// __dirname points inside app.asar, which is a file rather than a writable
// directory and causes ENOTDIR. Keep valid absolute profiles intact and map
// legacy relative values onto the per-user application data directory.
function resolveAccountProfileDir(storedProfileDir, accountId) {
  const fallback = path.join(APP_DATA_ROOT, 'profiles', String(accountId));
  if (!storedProfileDir || typeof storedProfileDir !== 'string') return fallback;

  if (path.isAbsolute(storedProfileDir)) {
    const normalized = path.normalize(storedProfileDir);
    if (normalized.toLowerCase().includes(`${path.sep}app.asar${path.sep}`)) {
      return fallback;
    }
    // If the path root or parent directory does not exist on this machine, remap via profiles marker
    const normalizedSlash = storedProfileDir.replace(/\\/g, '/');
    const profileMarker = 'profiles/';
    const markerIndex = normalizedSlash.toLowerCase().indexOf(profileMarker);
    if (markerIndex >= 0) {
      const rootDir = path.parse(normalized).root;
      if (!fs.existsSync(rootDir) || !fs.existsSync(path.dirname(normalized))) {
        const profileSuffix = normalizedSlash.slice(markerIndex + profileMarker.length);
        return profileSuffix ? path.join(APP_DATA_ROOT, 'profiles', profileSuffix) : fallback;
      }
    }
    return normalized;
  }

  const normalizedRelative = storedProfileDir.replace(/\\/g, '/').replace(/^\.\//, '');
  const profileMarker = 'profiles/';
  const markerIndex = normalizedRelative.toLowerCase().indexOf(profileMarker);
  if (markerIndex >= 0) {
    const profileSuffix = normalizedRelative.slice(markerIndex + profileMarker.length);
    return profileSuffix ? path.join(APP_DATA_ROOT, 'profiles', profileSuffix) : fallback;
  }

  return fallback;
}

// puppeteer-core v25 is ESM. Load it through the supported CommonJS-to-ESM
// bridge only when a managed Chrome process is actually started.
let puppeteerPromise = null;
function getPuppeteer() {
  if (!puppeteerPromise) {
    puppeteerPromise = import('puppeteer-core').then((module) => module.default || module);
  }
  return puppeteerPromise;
}

// Ẩn cửa sổ Chrome khỏi màn hình và taskbar Windows bằng Win32 API
function hideFromTaskbar(pid, profileDir = '', delayMs = 2500, keepWindowOnScreen = false) {
  if (process.platform !== 'win32') return Promise.resolve({ success: true, platform: process.platform });
  const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinHelper {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}

'@ -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds ${delayMs}

$targetPids = @()
if (${pid || 0}) {
  $targetPids += ${pid}
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" -ErrorAction SilentlyContinue
  if ($children) { foreach ($c in $children) { $targetPids += $c.ProcessId } }
}

$profile = '${String(profileDir || '').replace(/'/g, "''").replace(/\\/g, '/')}'
if ($profile) {
  $profileProcs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -replace '\\','/') -like "*$profile*" }
  if ($profileProcs) { foreach ($c in $profileProcs) { $targetPids += $c.ProcessId } }
}

$allChrome = Get-Process -Name 'chrome' -ErrorAction SilentlyContinue
$processedCount = 0
foreach ($p in $allChrome) {
  if ($targetPids.Count -eq 0 -or $targetPids -contains $p.Id) {
    if ($p.MainWindowHandle -ne 0) {
      $hwnd = $p.MainWindowHandle
      $ex = [WinHelper]::GetWindowLong($hwnd, -20)
      $ex = ($ex -band -bnot 0x00040000) -bor 0x00000080
      [WinHelper]::SetWindowLong($hwnd, -20, $ex) | Out-Null
      # Keep Chrome's top-level window shown so Chromium continues rendering
      # Messenger DOM in background tabs. SW_HIDE made document visibility
      # hidden and caused request/history scrapes to return partial results.
      [WinHelper]::ShowWindow($hwnd, 4) | Out-Null
      ${keepWindowOnScreen ? '' : '[WinHelper]::SetWindowPos($hwnd, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0015) | Out-Null'}
      $processedCount++
    }
  }
}
if ($processedCount -eq 0) {
  [Console]::Error.WriteLine("NO_WINDOW_FOUND")
  exit 1
}
`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], (err, stdout, stderr) => {
      if (err) {
        const errorMsg = String(stderr || err.message || 'NO_WINDOW_FOUND').trim();
        console.error('[ProcessManager] Lỗi ẩn Chrome khỏi màn hình/taskbar:', errorMsg);
        resolve({ success: false, error: errorMsg });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// Keep Chrome as a normal taskbar application while minimizing its window.
// This is the two-minute sync presentation mode, distinct from BACKGROUND.
function minimizeToTaskbar(pid, profileDir = '') {
  if (process.platform !== 'win32') return;
  const profile = String(profileDir || '').replace(/'/g, "''").replace(/\\/g, '/');
  const psScript = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SyncWindowHelper { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v); }' -ErrorAction SilentlyContinue
$profile = '${profile}'
$targetPids = @(${pid || 0})
if ($profile) {
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -replace '\\','/') -like "*$profile*" } | ForEach-Object { $targetPids += $_.ProcessId }
}
Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $targetPids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $h = $_.MainWindowHandle
  $style = [SyncWindowHelper]::GetWindowLong($h, -20)
  $style = ($style -band -bnot 0x00000080) -bor 0x00040000
  [SyncWindowHelper]::SetWindowLong($h, -20, $style) | Out-Null
  [SyncWindowHelper]::ShowWindowAsync($h, 6) | Out-Null
}`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], () => {});
}

// Tự động cấp quyền (Micro, Camera, Popups, Notifications) cho Facebook trong Chrome Profile Preferences
function findBundledChromePidByProfile(profileDir, chromeExecutable) {
  if (process.platform !== 'win32' || !profileDir || !chromeExecutable) return null;
  const normalizedProfile = path.resolve(profileDir).replace(/\\/g, '/').replace(/'/g, "''");
  const normalizedExecutable = path.resolve(chromeExecutable).replace(/\\/g, '/').replace(/'/g, "''");
  const psScript = `
$profile = '${normalizedProfile}'
$expectedExecutable = '${normalizedExecutable}'
$profileProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { ($_.CommandLine -replace '\\','/') -like "*$profile*" }

# A regular/old Chrome process holding this CRM profile would make a new
# Chrome-for-Testing invocation hand the URL to that old process and exit.
# Stop only that profile's mismatched browser tree before launching CFT.
$mismatchedRoots = $profileProcesses | Where-Object {
  $_.ExecutablePath -and (($_.ExecutablePath -replace '\\','/') -ne $expectedExecutable)
}
foreach ($proc in $mismatchedRoots) {
  & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null
}

$match = $profileProcesses | Where-Object {
  $_.ExecutablePath -and (($_.ExecutablePath -replace '\\','/') -eq $expectedExecutable)
} | Select-Object -First 1 -ExpandProperty ProcessId
if ($match) { Write-Output $match }
`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ensureProfilePermissions(profileDir) {
  try {
    const defaultDir = path.join(profileDir, 'Default');
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    const prefPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefPath)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      } catch (e) {
        prefs = {};
      }
    }

    if (!prefs.profile) prefs.profile = {};
    if (!prefs.profile.content_settings) prefs.profile.content_settings = {};

    // 1. Chuyển mặc định Default behavior thành Allow (1) cho tất cả các trang
    if (!prefs.profile.content_settings.default_content_setting_values) {
      prefs.profile.content_settings.default_content_setting_values = {};
    }
    prefs.profile.content_settings.default_content_setting_values.popups = 1; // 1 = Allow popups
    prefs.profile.content_settings.default_content_setting_values.media_stream_mic = 1; // 1 = Allow mic
    prefs.profile.content_settings.default_content_setting_values.media_stream_camera = 1; // 1 = Allow camera
    prefs.profile.content_settings.default_content_setting_values.notifications = 2; // CRM owns notifications

    // 2. Kích hoạt Developer Mode cho Extensions
    if (!prefs.extensions) prefs.extensions = {};
    if (!prefs.extensions.ui) prefs.extensions.ui = {};
    prefs.extensions.ui.developer_mode = true;

    // 3. Thêm danh sách ngoại lệ Allow riêng cho Facebook & Messenger
    if (!prefs.profile.content_settings.exceptions) prefs.profile.content_settings.exceptions = {};

    const origins = [
      'https://www.facebook.com:443,*',
      'https://facebook.com:443,*',
      'https://*.facebook.com:443,*',
      'https://www.messenger.com:443,*',
      'https://messenger.com:443,*',
      'https://*.messenger.com:443,*'
    ];

    const settingTypes = ['popups', 'media_stream_mic', 'media_stream_camera', 'notifications', 'automatic_downloads'];

    settingTypes.forEach((type) => {
      if (!prefs.profile.content_settings.exceptions[type]) {
        prefs.profile.content_settings.exceptions[type] = {};
      }
      origins.forEach((origin) => {
        prefs.profile.content_settings.exceptions[type][origin] = { setting: type === 'notifications' ? 2 : 1 };
      });
    });

    fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2), 'utf8');
    console.log(`[ProcessManager] Đã tự động cấu hình Tiện ích (Extension) & Quyền cho Facebook trong profile ${profileDir}`);
  } catch (err) {
    console.error('[ProcessManager] Lỗi tự động ghi quyền Preferences Chrome:', err.message);
  }
}

class ProcessManager {
  constructor() {
    this.processes = new Map(); // Key: account_id -> { process, profileDir }
    this.hideTimers = new Map();
    this.displayOpTokens = new Map();
    this.displayOpQueues = new Map();
    this.extensionPath = resolveExtensionPath();
    this.binChromePath = path.join(resolveBinRoot(), 'bin', 'chrome-win', 'chrome.exe');
  }

  getChromeExecutable() {
    if (process.platform === 'win32') {
      if (!fs.existsSync(this.binChromePath)) {
        throw new Error(`Không tìm thấy Chrome for Testing được đóng gói: ${this.binChromePath}`);
      }
      return this.binChromePath;
    }
    return resolveChromePath({ repoRoot: resolveBinRoot(), legacyBinChromePath: this.binChromePath });
  }

  getInteractiveSetupChromeExecutable() {
    // Facebook's encrypted-history/PIN setup has been observed hanging in the
    // bundled Chrome for Testing 152 while the installed Stable browser loads
    // it normally. Both account setup and later background connections use
    // Stable; Puppeteer installs the extension through the debugging pipe.
    return resolveChromePath({
      repoRoot: resolveBinRoot(),
      legacyBinChromePath: this.binChromePath,
      preferSystemChrome: true
    });
  }

  cancelScheduledHides(accountId) {
    const timers = this.hideTimers.get(String(accountId)) || [];
    timers.forEach((timer) => clearTimeout(timer));
    this.hideTimers.delete(String(accountId));
  }

  scheduleHide(accountId, pid, delayMs) {
    const key = String(accountId);
    const timer = setTimeout(() => {
      const current = this.processes.get(accountId);
      if (current?.pid === pid && current.displayMode === 'BACKGROUND') {
        hideFromTaskbar(pid, current.profileDir, 0);
      }
      const remaining = (this.hideTimers.get(key) || []).filter((item) => item !== timer);
      if (remaining.length) this.hideTimers.set(key, remaining);
      else this.hideTimers.delete(key);
    }, delayMs);
    this.hideTimers.set(key, [...(this.hideTimers.get(key) || []), timer]);
  }

  // Khởi chạy Chrome Portable hiển thị cho tài khoản FB
  async startAccountProcess(accountId, customProfileDir = null, options = {}) {
    const forceExtensionReload = options?.forceExtensionReload === true;
    if (this.processes.has(accountId)) {
      const existing = this.processes.get(accountId);
      const isAlive = existing.pid &&
        (() => { try { process.kill(existing.pid, 0); return true; } catch { return false; } })();
      if (isAlive && forceExtensionReload) {
        console.log(`[ProcessManager] Extension account ${accountId} offline; restarting its managed Chrome to reload the extension.`);
        this.stopAccountProcess(accountId);
      } else if (isAlive) {
        existing.displayMode = 'VISIBLE';
        this.unhideWindow(accountId);
        console.log(`[ProcessManager] Tài khoản ${accountId} đã đang chạy (PID ${existing.pid}).`);
        return true;
      } else {
        console.log(`[ProcessManager] Phát hiện entry cũ của ${accountId} đã chết (PID ${existing.pid}). Xóa để khởi động lại.`);
        this.processes.delete(accountId);
      }
    }

    let profileDir = customProfileDir;
    if (!profileDir) {
      try {
        const db = require('../database/db');
        const acc = db.prepare('SELECT profile_dir FROM accounts WHERE id = ?').get(accountId);
        if (acc?.profile_dir) {
          profileDir = resolveAccountProfileDir(acc.profile_dir, accountId);
        }
      } catch (e) {}
    }

    profileDir = resolveAccountProfileDir(profileDir, accountId);

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    ensureProfilePermissions(profileDir);

    const chromeExecutable = this.getInteractiveSetupChromeExecutable();
    const absExtPath = path.resolve(this.extensionPath).replace(/\\/g, '/');
    const absProfileDir = path.resolve(profileDir).replace(/\\/g, '/');

    const runningProfilePid = findBundledChromePidByProfile(absProfileDir, chromeExecutable);
    if (runningProfilePid && forceExtensionReload) {
      console.log(`[ProcessManager] Chrome profile ${accountId} is alive but its extension is offline; stopping PID ${runningProfilePid}.`);
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(runningProfilePid), '/T', '/F'], {
          windowsHide: true,
          encoding: 'utf8'
        });
        if (result.error || (result.status !== 0 && result.status !== 128)) {
          console.error(`[ProcessManager] Could not restart Chrome profile ${accountId}:`, result.error?.message || result.stderr || result.stdout);
          return false;
        }
      }
    } else if (runningProfilePid) {
      this.processes.set(accountId, {
        process: null,
        profileDir: absProfileDir,
        pid: runningProfilePid,
        status: 'RUNNING',
        displayMode: 'VISIBLE'
      });
      this.unhideWindow(accountId);
      console.log(`[ProcessManager] Dùng lại Chrome đang chạy cho account ${accountId} (PID ${runningProfilePid}).`);
      return true;
    }

    console.log(`[ProcessManager] Khởi chạy Chrome Stable + tự cài extension cho account ${accountId} (Profile: ${absProfileDir})...`);
    try {
      const puppeteer = await getPuppeteer();
      const browser = await puppeteer.launch({
        executablePath: chromeExecutable,
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        userDataDir: absProfileDir,
        defaultViewport: null,
        enableExtensions: true,
        args: [
          '--start-maximized',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-mode',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
          '--disable-popup-blocking',
          '--disable-notifications',
          '--autoplay-policy=no-user-gesture-required'
        ]
      });
      await browser.installExtension(absExtPath);
      const child = browser.process();
      if (!child?.pid) throw new Error('Puppeteer không trả về PID Chrome');

      browser.on('disconnected', () => {
        const entry = this.processes.get(accountId);
        if (entry && entry.pid === child.pid) {
          console.log(`[ProcessManager] Chrome Stable [PID ${child.pid}] cho account ${accountId} đã tắt.`);
          this.processes.delete(accountId);
        }
      });

      this.processes.set(accountId, {
        process: child,
        browser,
        profileDir: absProfileDir,
        pid: child.pid,
        status: 'RUNNING',
        displayMode: 'VISIBLE'
      });

      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      await page.goto('https://www.facebook.com/messages/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Chính sách "1 account = 1 Chrome": mở thêm tab Business Suite cho từng
      // Page ACTIVE của account ngay trong Chrome này (không còn Chrome riêng
      // cho từng Page - đã gỡ 2026-09-19).
      if (!String(accountId || '').startsWith('pending_')) {
        const activePageIds = this.getActivePageIdsForAccount(accountId);
        for (const pid of activePageIds) {
          try { await this.openBusinessTabForPage(pid, accountId); } catch (_) {}
        }
      }

      console.log(`[ProcessManager] Chrome Stable [PID ${child.pid}] đã tự cài extension cho account ${accountId}.`);
      return true;
    } catch (err) {
      console.error(`[ProcessManager] Lỗi khởi chạy Chrome cho ${accountId}:`, err.message);
      return false;
    }
  }

  // Danh sách Page ACTIVE đang sở hữu bởi account (nguồn sự thật: inbox_sources).
  getActivePageIdsForAccount(accountId) {
    try {
      return db.prepare(`
        SELECT external_id FROM inbox_sources
        WHERE source_type = 'page_messenger' AND owner_account_id = ? AND status = 'ACTIVE'
      `).all(String(accountId || '')).map((r) => String(r.external_id)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  // Mở (hoặc kích hoạt) tab Business Suite cho 1 Page TRONG Chrome cá nhân của
  // account - chính sách "1 account = 1 Chrome". Không còn spawn Chrome riêng
  // cho từng Page (đã gỡ 2026-09-19).
  async openBusinessTabForPage(pageId, accountId) {
    const safePageId = String(pageId || '').trim();
    const safeAccountId = String(accountId || '').trim();
    if (!/^\d+$/.test(safePageId) || !safeAccountId) return false;
    const targetUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(safePageId)}&mailbox_id=${encodeURIComponent(safePageId)}&thread_type=FB_MESSAGE`;

    let entry = this.processes.get(safeAccountId);
    if (!entry?.browser?.connected) {
      // Chrome cá nhân chưa chạy -> khởi động nó trước (tự mở tab Messenger).
      await this.startAccountProcess(safeAccountId, null, {});
      entry = this.processes.get(safeAccountId);
    }

    try {
      this.unhideWindow(safeAccountId);
      if (entry?.browser?.connected) {
        // Đã có tab business cho page này -> kích hoạt lại, không mở trùng.
        const openPages = await entry.browser.pages();
        const existing = openPages.find((p) => String(p.url() || '').includes(`asset_id=${safePageId}`));
        if (existing) {
          await existing.bringToFront().catch(() => {});
          console.log(`[ProcessManager] Tab Business Suite cho Page ${safePageId} đã tồn tại - kích hoạt lại.`);
          return true;
        }
        const bizPage = await entry.browser.newPage();
        await bizPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[ProcessManager] Đã mở tab Business Suite cho Page ${safePageId} trong Chrome account ${safeAccountId}.`);
        return true;
      }

      // Puppeteer không điều khiển được (Chrome mở ngoài) -> spawn thêm tab trên profile đã có.
      const profileDir = entry?.profileDir
        || db.prepare('SELECT profile_dir FROM accounts WHERE id = ?').get(safeAccountId)?.profile_dir
        || path.join(APP_DATA_ROOT, `profiles/${safeAccountId}`);
      const absProfileDir = path.isAbsolute(profileDir) ? profileDir : path.resolve(APP_DATA_ROOT, profileDir);
      const chromeExecutable = this.getInteractiveSetupChromeExecutable();
      spawn(chromeExecutable, [`--user-data-dir=${absProfileDir}`, targetUrl], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      console.log(`[ProcessManager] Đã gửi lệnh mở Business Suite cho Page ${safePageId} trên profile ${absProfileDir}.`);
      return true;
    } catch (error) {
      console.warn(`[ProcessManager] Không thể mở Business Suite cho Page ${safePageId}:`, error.message);
      return false;
    }
  }

  // DEPRECATED (2026-09-19): trước đây mỗi Page có Chrome riêng (profile
  // page-profiles/<acc>_<page>). Giờ Page chạy dạng TAB trong Chrome cá nhân.
  async startPageProcess(pageId, accountId) {
    return this.openBusinessTabForPage(pageId, accountId);
  }

  // (Đã gỡ launcher "mỗi Page 1 Chrome riêng" - Page giờ chạy dạng tab trong
  // Chrome cá nhân qua openBusinessTabForPage / startPageProcess ở trên.)

  // Alias tương thích: mở tab Business Suite cho Page trong Chrome account.
  async openPageInboxInAccountChrome(accountId, pageId) {
    return this.openBusinessTabForPage(pageId, accountId);
  }

  // Khởi chạy Chrome Portable cho phiên thêm tài khoản mới (pending session)
  async startNewAccountProcess(pendingKey) {
    const setupUrl = `https://www.facebook.com/messages/?crm_pending_key=${encodeURIComponent(pendingKey)}`;
    if (this.processes.has(pendingKey)) {
      console.log(`[ProcessManager] Phiên pending ${pendingKey} đã đang chạy.`);
      const existing = this.processes.get(pendingKey);
      try {
        if (existing?.browser?.connected) {
          const page = await existing.browser.newPage();
          await page.goto(setupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          spawn(this.getInteractiveSetupChromeExecutable(), [
            `--user-data-dir=${path.resolve(existing?.profileDir || path.join(APP_DATA_ROOT, `profiles/${pendingKey}`))}`,
            setupUrl
          ], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        }
      } catch (error) {
        console.warn(`[ProcessManager] Không thể mở lại URL liên kết cho ${pendingKey}:`, error.message);
      }
      this.unhideWindow(pendingKey);
      return true;
    }

    const profileDir = path.join(APP_DATA_ROOT, `profiles/${pendingKey}`);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    ensureProfilePermissions(profileDir);

    const chromeExecutable = this.getInteractiveSetupChromeExecutable();
    const absExtPath = path.resolve(this.extensionPath).replace(/\\/g, '/');
    const absProfileDir = path.resolve(profileDir).replace(/\\/g, '/');

    // The backend can restart while the operator is still completing login.
    // Re-attach the in-memory registry to that exact Chrome/profile instead
    // of launching another browser against the same user-data directory.
    const runningProfilePid = findBundledChromePidByProfile(absProfileDir, chromeExecutable);
    if (runningProfilePid) {
      this.processes.set(pendingKey, {
        process: null,
        browser: null,
        profileDir: absProfileDir,
        pid: runningProfilePid,
        status: 'RUNNING',
        displayMode: 'VISIBLE'
      });
      this.unhideWindow(pendingKey);
      // Chrome can outlive the backend. Reopening the exact setup URL lets
      // the extension capture the ownership token again after a restart.
      try {
        spawn(chromeExecutable, [
          `--user-data-dir=${absProfileDir}`,
          setupUrl
        ], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } catch (error) {
        console.warn(`[ProcessManager] Không thể khôi phục URL liên kết cho ${pendingKey}:`, error.message);
      }
      console.log(`[ProcessManager] Reused pending Chrome ${pendingKey} (PID ${runningProfilePid}).`);
      return true;
    }

    console.log(`[ProcessManager] Khởi chạy Chrome Stable + tự cài extension cho phiên [${pendingKey}]: ${chromeExecutable}`);
    try {
      const puppeteer = await getPuppeteer();
      const browser = await puppeteer.launch({
        executablePath: chromeExecutable,
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        userDataDir: absProfileDir,
        defaultViewport: null,
        enableExtensions: true,
        args: [
          '--start-maximized',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-mode',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
          '--disable-popup-blocking',
          '--disable-notifications',
          '--autoplay-policy=no-user-gesture-required'
        ]
      });
      await browser.installExtension(absExtPath);
      const child = browser.process();
      if (!child?.pid) throw new Error('Puppeteer không trả về PID Chrome');

      browser.on('disconnected', () => {
        const entry = this.processes.get(pendingKey);
        // Entry still sitting under pendingKey with this PID = the Chrome was
        // closed BEFORE promotePendingProcess() moved it to a real account id,
        // i.e. the operator abandoned the setup without completing login.
        if (entry && entry.pid === child.pid) {
          console.log(`[ProcessManager] Chrome setup [PID ${child.pid}] cho ${pendingKey} đã đóng.`);
          this.processes.delete(pendingKey);
          if (typeof this.onPendingSessionAbandoned === 'function') {
            try { this.onPendingSessionAbandoned(pendingKey); } catch (_) {}
          }
        }
      });

      this.processes.set(pendingKey, {
        process: child,
        browser,
        profileDir,
        pid: child.pid,
        status: 'RUNNING'
      });

      // launch() installs the extension first; only then open Facebook so the
      // pending-key capture runs on the first Facebook document.
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      await page.goto(setupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      console.log(`[ProcessManager] Chrome Stable [PID ${child.pid}] đã tự cài extension và mở Facebook.`);
      return true;
    } catch (err) {
      console.error(`[ProcessManager] Lỗi khởi chạy Chrome cho phiên ${pendingKey}:`, err.message);
      return false;
    }
  }

  _enqueueDisplayOp(accountId, opFn) {
    if (!this.displayOpTokens) this.displayOpTokens = new Map();
    if (!this.displayOpQueues) this.displayOpQueues = new Map();
    const accId = String(accountId);
    const token = (this.displayOpTokens.get(accId) || 0) + 1;
    this.displayOpTokens.set(accId, token);

    const prevPromise = this.displayOpQueues.get(accId) || Promise.resolve();
    const runOp = async () => {
      try {
        await prevPromise;
      } catch (_) {}

      // If a newer operation was scheduled while waiting in queue, abort early
      if (this.displayOpTokens.get(accId) !== token) {
        return { success: false, error: 'OPERATION_SUPERSEDED' };
      }

      const result = await opFn(token);

      // If a newer operation arrived during execution, discard result
      if (this.displayOpTokens.get(accId) !== token) {
        return { success: false, error: 'OPERATION_SUPERSEDED' };
      }

      return result;
    };

    const currentPromise = runOp();
    this.displayOpQueues.set(
      accId,
      currentPromise.catch(() => {}).finally(() => {
        if (this.displayOpQueues.get(accId) === currentPromise) {
          this.displayOpQueues.delete(accId);
        }
      })
    );

    return currentPromise;
  }

  // Tự động ẩn cửa sổ Chrome ngầm khỏi Taskbar khi vừa hoàn tất đăng ký
  async hideAccountProcess(accountId) {
    const accId = String(accountId);
    const procInfo = this.processes.get(accId);
    if (!procInfo?.pid) return { success: false, error: 'CHROME_NOT_RUNNING' };
    if (!this.isProcessAlive(procInfo.pid)) {
      this.processes.delete(accId);
      return { success: false, error: 'CHROME_PROCESS_DEAD' };
    }
    this.cancelScheduledHides(accId);

    return this._enqueueDisplayOp(accId, async (opToken) => {
      const currentProc = this.processes.get(accId);
      if (!currentProc?.pid || !this.isProcessAlive(currentProc.pid)) {
        this.processes.delete(accId);
        return { success: false, error: 'CHROME_PROCESS_DEAD' };
      }
      const result = await hideFromTaskbar(currentProc.pid, currentProc.profileDir, 0, false);
      if (result?.success && this.displayOpTokens.get(accId) === opToken) {
        currentProc.displayMode = 'BACKGROUND';
        console.log(`[ProcessManager] Tự động ẩn Chrome của account ${accId} khỏi Taskbar.`);
      }
      return result;
    });
  }

  // Bật sáng cửa sổ Chrome GUI khi gặp Checkpoint / OTP 2FA / Session Expired / Cuộc gọi
  async unhideWindow(accountId) {
    const accId = String(accountId);
    console.log(`[ProcessManager] Bật sáng cửa sổ Chrome cho account ${accId}!`);
    const procInfo = this.processes.get(accId);
    if (!procInfo?.pid) return { success: false, error: 'CHROME_NOT_RUNNING' };
    if (!this.isProcessAlive(procInfo.pid)) {
      this.processes.delete(accId);
      return { success: false, error: 'CHROME_PROCESS_DEAD' };
    }
    this.cancelScheduledHides(accId);

    return this._enqueueDisplayOp(accId, async (opToken) => {
      const currentProc = this.processes.get(accId);
      if (!currentProc?.pid || !this.isProcessAlive(currentProc.pid)) {
        this.processes.delete(accId);
        return { success: false, error: 'CHROME_PROCESS_DEAD' };
      }
      const pid = currentProc.pid;
      const escapedProfileDir = String(currentProc.profileDir || '').replace(/'/g, "''").replace(/\\/g, '/');
      const chromeExecutable = this.getInteractiveSetupChromeExecutable();
      const escapedChromeExecutable = String(chromeExecutable).replace(/'/g, "''");

      if (process.platform === 'win32') {
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win32UnhideHelper {
  public delegate bool EnumDesktopProc(string lpszDesktop, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern bool EnumDesktops(IntPtr hwinsta, EnumDesktopProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpfn, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int m);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int m);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

  public static List<IntPtr> FindWindows(int[] pids) {
    var found = new List<IntPtr>();
    var pidSet = new HashSet<uint>();
    if (pids != null) {
      foreach (var p in pids) { if (p > 0) pidSet.Add((uint)p); }
    }
    var seen = new HashSet<IntPtr>();

    Action<IntPtr> inspectHwnd = (hWnd) => {
      if (seen.Contains(hWnd)) return;
      seen.Add(hWnd);
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pidSet.Contains(pid)) {
        var cls = new System.Text.StringBuilder(128);
        GetClassName(hWnd, cls, 128);
        string className = cls.ToString();
        int style = GetWindowLong(hWnd, -16);
        if ((style & 0x40000000) == 0 && (className == "Chrome_WidgetWin_1" || className.StartsWith("Chrome_WidgetWin"))) {
          found.Add(hWnd);
        }
      }
    };

    try {
      EnumWindows((hWnd, lp) => { inspectHwnd(hWnd); return true; }, IntPtr.Zero);
    } catch {}

    try {
      IntPtr hInput = OpenInputDesktop(0, false, 0x01FF);
      if (hInput != IntPtr.Zero) {
        EnumDesktopWindows(hInput, (hWnd, lp) => { inspectHwnd(hWnd); return true; }, IntPtr.Zero);
        CloseDesktop(hInput);
      }
    } catch {}

    try {
      IntPtr hwinsta = GetProcessWindowStation();
      if (hwinsta != IntPtr.Zero) {
        EnumDesktops(hwinsta, (deskName, lp) => {
          IntPtr hD = OpenDesktop(deskName, 0, false, 0x01FF);
          if (hD != IntPtr.Zero) {
            EnumDesktopWindows(hD, (hWnd, lpp) => { inspectHwnd(hWnd); return true; }, IntPtr.Zero);
            CloseDesktop(hD);
          }
          return true;
        }, IntPtr.Zero);
      }
    } catch {}

    return found;
  }
}
'@ -ErrorAction SilentlyContinue

$targetPids = @(${pid || 0})
$profile = '${escapedProfileDir}'
if ($profile) {
  $profileProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -replace '\\','/') -like "*$profile*" }
  foreach ($processInfo in $profileProcesses) { $targetPids += $processInfo.ProcessId }
}

$handles = [Win32UnhideHelper]::FindWindows([int[]]$targetPids)
$processedCount = 0
foreach ($handle in $handles) {
  $style = [Win32UnhideHelper]::GetWindowLong($handle, -20)
  $style = ($style -band -bnot 0x00000080) -bor 0x00040000
  [Win32UnhideHelper]::SetWindowLong($handle, -20, $style) | Out-Null
  [Win32UnhideHelper]::ShowWindow($handle, 9) | Out-Null
  try {
    $workingArea = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
    [Win32UnhideHelper]::SetWindowPos($handle, [IntPtr]::Zero, $workingArea.X, $workingArea.Y, $workingArea.Width, $workingArea.Height, 0x0044) | Out-Null
  } catch {
    [Win32UnhideHelper]::SetWindowPos($handle, [IntPtr]::Zero, 80, 80, 1200, 800, 0x0040) | Out-Null
  }
  [Win32UnhideHelper]::ShowWindow($handle, 3) | Out-Null
  [Win32UnhideHelper]::SetForegroundWindow($handle) | Out-Null
  $processedCount++
}

if ($processedCount -eq 0) {
  $apps = Get-Process -Name 'chrome' -ErrorAction SilentlyContinue | Where-Object { $targetPids -contains $_.Id -and $_.MainWindowHandle -ne 0 }
  foreach ($app in $apps) {
    $handle = $app.MainWindowHandle
    $style = [Win32UnhideHelper]::GetWindowLong($handle, -20)
    $style = ($style -band -bnot 0x00000080) -bor 0x00040000
    [Win32UnhideHelper]::SetWindowLong($handle, -20, $style) | Out-Null
    [Win32UnhideHelper]::SetWindowPos($handle, [IntPtr]::Zero, 80, 80, 1200, 800, 0x0040) | Out-Null
    [Win32UnhideHelper]::ShowWindowAsync($handle, 9) | Out-Null
    [Win32UnhideHelper]::SetForegroundWindow($handle) | Out-Null
    $processedCount++
  }
}

if ($processedCount -eq 0 -and $profile) {
  Start-Process -FilePath '${escapedChromeExecutable}' -ArgumentList @("--user-data-dir=$profile", '--new-window', 'https://www.facebook.com/messages')
  $processedCount++
}
if ($processedCount -eq 0) {
  [Console]::Error.WriteLine("NO_WINDOW_FOUND")
  exit 1
}`;

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        const result = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], (err, stdout, stderr) => {
            if (err) {
              const errorMsg = String(stderr || err.message || 'NO_WINDOW_FOUND').trim();
              console.error('[ProcessManager] Lỗi đưa cửa sổ Chrome lên foreground:', errorMsg);
              resolve({ success: false, error: errorMsg });
            } else {
              resolve({ success: true });
            }
          });
        });
        if (result?.success && this.displayOpTokens.get(accId) === opToken) {
          currentProc.displayMode = 'VISIBLE';
        }
        return result;
      } else {
        console.log(`[ProcessManager] (Linux/macOS) Vui lòng kiểm tra cửa sổ Chrome PID ${pid || 'unknown'}`);
        if (this.displayOpTokens.get(accId) === opToken) {
          currentProc.displayMode = 'VISIBLE';
        }
        return { success: true };
      }
    });
  }

  // Dừng tiến trình Chrome Portable
  stopAccountProcess(accountId) {
    const accId = String(accountId);
    this.cancelScheduledHides(accId);
    if (this.displayOpTokens) {
      const nextToken = (this.displayOpTokens.get(accId) || 0) + 1;
      this.displayOpTokens.set(accId, nextToken);
    }
    if (this.displayOpQueues) {
      this.displayOpQueues.delete(accId);
    }
    const procInfo = this.processes.get(accId);
    if (!procInfo?.pid) return false;

    for (const [key, entry] of this.processes) {
      if (entry?.pid === procInfo.pid) this.processes.delete(key);
    }
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(procInfo.pid), '/T', '/F'], {
          windowsHide: true,
          encoding: 'utf8'
        });
        if (result.error) throw result.error;
        if (result.status !== 0 && result.status !== 128) {
          throw new Error(String(result.stderr || result.stdout || `taskkill exit ${result.status}`).trim());
        }
      } else {
        try { process.kill(-procInfo.pid, 'SIGTERM'); }
        catch (_) { procInfo.process?.kill('SIGTERM'); }
      }
      console.log(`[ProcessManager] Đã dừng toàn bộ Chrome process tree account ${accId} (PID ${procInfo.pid}).`);
      return true;
    } catch (err) {
      console.error(`[ProcessManager] Lỗi dừng process tree ${accId}:`, err.message);
      return false;
    }
  }

  isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  getStatus(accountId) {
    const procInfo = this.processes.get(accountId);
    if (!procInfo) return 'STOPPED';
    if (procInfo.pid && !this.isProcessAlive(procInfo.pid)) {
      this.processes.delete(accountId);
      return 'STOPPED';
    }
    return procInfo.status || 'STOPPED';
  }

  hideAccountFromTaskbarForSync(accountId) {
    const procInfo = this.processes.get(accountId);
    if (!procInfo?.pid) return false;
    this.cancelScheduledHides(accountId);
    procInfo.displayMode = 'VISIBLE';
    hideFromTaskbar(procInfo.pid, procInfo.profileDir, 0, true);
    console.log(`[ProcessManager] Chrome account ${accountId} remains visible for sync but is removed from taskbar.`);
    return true;
  }

  minimizeAccountForSync(accountId) {
    const procInfo = this.processes.get(accountId);
    if (!procInfo?.pid) return false;
    if (!this.isProcessAlive(procInfo.pid)) {
      this.processes.delete(accountId);
      return false;
    }
    if (procInfo.displayMode === 'BACKGROUND') {
      return true;
    }
    this.cancelScheduledHides(accountId);
    procInfo.displayMode = 'SYNC_MINIMIZED';
    minimizeToTaskbar(procInfo.pid, procInfo.profileDir);
    console.log(`[ProcessManager] Chrome account ${accountId} minimized to taskbar for the two-minute sync window.`);
    return true;
  }

  getDisplayMode(accountId) {
    const procInfo = this.processes.get(accountId);
    if (!procInfo) return 'STOPPED';
    if (procInfo.pid && !this.isProcessAlive(procInfo.pid)) {
      this.processes.delete(accountId);
      return 'STOPPED';
    }
    return procInfo.displayMode || 'STOPPED';
  }

  stopAllAccountProcesses() {
    const accountIds = [...new Set(this.processes.keys())];
    let stopped = 0;
    for (const accountId of accountIds) {
      if (this.stopAccountProcess(accountId)) stopped += 1;
    }
    console.log(`[ProcessManager] Stopped ${stopped}/${accountIds.length} managed Chrome process trees.`);
    return stopped;
  }

  stopOrphanedManagedChromeProfiles(allowedProfileDirs = []) {
    if (process.platform !== 'win32') return 0;
    const profilesRoot = path.resolve(APP_DATA_ROOT, 'profiles');
    const allowed = allowedProfileDirs
      .filter(Boolean)
      .map((profileDir) => path.resolve(profileDir));
    const escapePs = (value) => String(value).replace(/'/g, "''");
    const allowedLiteral = allowed.map((profileDir) => `'${escapePs(profileDir)}'`).join(',');
    const chromeExecutable = this.getInteractiveSetupChromeExecutable();
    const psScript = `
$profilesRoot = [IO.Path]::GetFullPath('${escapePs(profilesRoot)}').TrimEnd('\\') + '\\'
$managedChrome = [IO.Path]::GetFullPath('${escapePs(chromeExecutable)}')
$allowed = @(${allowedLiteral}) | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\\') }
$roots = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $managedChrome -and $_.CommandLine -match '--user-data-dir='
}
foreach ($proc in $roots) {
  $match = [regex]::Match($proc.CommandLine, '--user-data-dir=(?:"([^"]+)"|([^ ]+))')
  if (-not $match.Success) { continue }
  $rawProfile = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  $profile = [IO.Path]::GetFullPath($rawProfile).TrimEnd('\\')
  $insideManagedRoot = ($profile + '\\').StartsWith($profilesRoot, [StringComparison]::OrdinalIgnoreCase)
  $isAllowed = $allowed | Where-Object { $_.Equals($profile, [StringComparison]::OrdinalIgnoreCase) }
  if ($insideManagedRoot -and -not $isAllowed) {
    & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null
    Write-Output $proc.ProcessId
  }
}`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000
    });
    const stopped = String(result.stdout || '').split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim())).length;
    if (result.error) console.warn('[ProcessManager] Could not clean orphaned managed Chrome profiles:', result.error.message);
    if (stopped) console.log(`[ProcessManager] Stopped ${stopped} orphaned managed Chrome profile(s).`);
    return stopped;
  }

  promotePendingProcess(pendingKey, accountId) {
    const pending = this.processes.get(pendingKey);
    if (!pending) return false;

    const existing = this.processes.get(accountId);
    if (existing?.pid && existing.pid !== pending.pid) {
      this.stopAccountProcess(accountId);
    }

    for (const [key, entry] of this.processes) {
      if (entry?.pid === pending.pid) this.processes.delete(key);
    }
    this.processes.set(accountId, pending);
    return true;
  }
}

module.exports = new ProcessManager();
module.exports.ProcessManager = ProcessManager;
module.exports.hideFromTaskbar = hideFromTaskbar;
