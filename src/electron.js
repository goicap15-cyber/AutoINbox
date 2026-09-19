const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const instanceToken = crypto.randomUUID();
process.env.CRM_INSTANCE_TOKEN = instanceToken;
// Do not rely on Electron's cross-build singleton mutex. After an old build is
// force-closed on Windows that mutex can outlive the visible process briefly,
// causing a newly installed build to exit before it can even write a log. The
// backend instance token + exclusive port binding below provide deterministic
// ownership and a useful EADDRINUSE error instead.
const hasSingleInstanceLock = true;

let mainWindow = null;
let backendRuntime = null;
let cleanupStarted = false;
let startupError = null;

function appendDesktopLog(message) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'desktop.log'),
      `${new Date().toISOString()} ${message}\n`,
      'utf8'
    );
  } catch (_) { /* Logging must never prevent the app from starting. */ }
}

function waitForBackend(url, expectedInstanceToken, timeoutMs = 45000) {
  if (startupError) return Promise.reject(startupError);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            if (response.statusCode === 200 && health.instance_token === expectedInstanceToken) return resolve();
          } catch (_) {}
          retry();
        });
      });
      request.setTimeout(1500, () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(startupError || new Error(`Backend did not become ready within ${timeoutMs}ms`));
        return;
      }
      setTimeout(probe, 300);
    };
    probe();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    title: 'FB Messenger CRM',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Set standard Chrome User-Agent for popup windows (Google OAuth GIS)
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Mọi liên kết http/https (link Facebook share, Spotify...) mở bằng
    // trình duyệt hệ thống của người dùng - nơi họ đã đăng nhập Facebook,
    // cần cho các link share/v/... Yêu cầu 2026-09-18: link trong chat phải
    // bấm được. Chặn popup nội bộ trong cửa sổ CRM.
    if (/^https?:\/\//i.test(url)) {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) appendDesktopLog(`[renderer] did-fail-load code=${code} url=${validatedURL} ${description}`);
  });

  try {
    await waitForBackend('http://127.0.0.1:5050/api/health', instanceToken);
    appendDesktopLog('[startup] Backend ready; loading CRM UI.');
    await mainWindow.loadURL('http://127.0.0.1:5050?desktop=1');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  } catch (err) {
    const message = err?.stack || err?.message || String(err);
    appendDesktopLog(`[startup] Failed: ${message}`);
    dialog.showErrorBox(
      'Không thể khởi động FB Messenger CRM',
      `Backend không khởi động được.\n\n${err?.message || err}\n\nLog: ${path.join(app.getPath('userData'), 'logs', 'desktop.log')}`
    );
    app.quit();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: clear all session cookies then reload → proper logout in Electron
ipcMain.handle('crm-logout', async () => {
  try {
    const ses = session.defaultSession;
    await ses.clearStorageData({ storages: ['cookies'] });
  } catch (_) { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.userAgentFallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 FB-CRM-Desktop';
  appendDesktopLog(`[startup] app=${app.getVersion()} packaged=${app.isPackaged} resources=${process.resourcesPath}`);
  // Start Backend Express/WebSocket Server
  try {
    const distServer = path.join(__dirname, '../dist/server/index.js');
    const srcServer = path.join(__dirname, 'server/index.js');

    if (fs.existsSync(distServer)) {
      console.log('[Electron] Loading compiled server from dist/server/index.js');
      backendRuntime = require(distServer);
    } else if (fs.existsSync(srcServer)) {
      console.log('[Electron] Loading server from src/server/index.js');
      backendRuntime = require(srcServer);
    }
  } catch (err) {
    startupError = err;
    appendDesktopLog(`[backend] ${err?.stack || err?.message || err}`);
    console.error('[Electron] Error starting backend server:', err.message);
  }

  if (!startupError && backendRuntime?.startupPromise) {
    try {
      await backendRuntime.startupPromise;
    } catch (err) {
      startupError = err;
      appendDesktopLog(`[backend-listen] ${err?.stack || err?.message || err}`);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on('uncaughtException', (err) => {
  startupError = err;
  appendDesktopLog(`[uncaughtException] ${err?.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
  startupError = reason instanceof Error ? reason : new Error(String(reason));
  appendDesktopLog(`[unhandledRejection] ${startupError.stack || startupError}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try {
    backendRuntime?.stopManagedProcesses?.();
  } catch (err) {
    console.error('[Electron] Error stopping managed Chrome processes:', err.message);
  }
});
