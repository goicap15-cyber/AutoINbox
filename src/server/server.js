const path = require('path');
const fs = require('fs');
const { parseEnv } = require('util');
// Neither the plain `node src/server/index.js` entrypoint nor Electron's
// require(serverPath) load .env on their own (no dotenv dependency, no
// --env-file flag) - PAGE_TOKEN_SECRET/WEBHOOK_VERIFY_TOKEN/RICH_MESSAGE_*
// flags etc. were silently falling back to unset. Node 20.6+'s built-in
// loadEnvFile covers both launch paths without adding a dependency.
try {
  // fs.readFileSync is ASAR-aware, unlike process.loadEnvFile's native file
  // loader. This reads repo/.env in dev and app.asar/.env when packaged.
  const envPath = path.join(__dirname, '../../.env');
  const packagedEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(packagedEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch (_) {
  // Missing .env is fine (e.g. a fresh checkout) - env vars just stay unset.
}

const express = require('express');
const crypto = require('crypto');
const { isLoopbackAddress, isLocalDevRequest } = require('./utils/localDevAccess');
const { APP_DATA_ROOT } = require('./utils/appDataRoot');
const OutboundAttachmentRepository = require('./repositories/OutboundAttachmentRepository');
const OutboundAttemptRepository = require('./repositories/OutboundAttemptRepository');
const OutboundAttachmentService = require('./services/OutboundAttachmentService');
const RichMessageCapabilityService = require('./services/RichMessageCapabilityService');
const RichMessageService = require('./services/RichMessageService');
const OutboundConfirmationService = require('./services/OutboundConfirmationService');
const OutboundDomCorrelationService = require('./services/OutboundDomCorrelationService');
const InboundMediaHydrationService = require('./services/InboundMediaHydrationService');
const PhoneCaptureService = require('./services/PhoneCaptureService');
const CampaignPhoneCaptureService = require('./services/CampaignPhoneCaptureService');
const GlobalPhoneAutomationService = require('./services/GlobalPhoneAutomationService');
const HistorySyncRetryPolicy = require('./services/HistorySyncRetryPolicy');
const { DispatchStallWatchdog } = require('./services/DispatchStallWatchdog');
const SidebarSyncCooldown = require('./services/SidebarSyncCooldown');
const CallEventDeduplicator = require('./services/CallEventDeduplicator');
const { resolveInternalThreadId } = require('./utils/threadIdResolver');
const http = require('http');
const WebSocket = require('ws');
const { Server: SocketIOServer } = require('socket.io');
const db = require('./database/db');
const { AuthService, AuthError } = require('./services/AuthService');
const { CentralAuthClient, CentralAuthError } = require('./services/CentralAuthClient');
const processManager = require('./services/ProcessManager');
const { closeChromePidsGracefullySync } = processManager;
const mediaDownloader = require('./services/RobustMediaDownloader');
const assignmentManager = require('./services/AssignmentManager');
const enterpriseAccess = require('./services/EnterpriseAccessService');
const searchService = require('./services/SearchService');
const exportService = require('./services/ExportService');
const autoReplyEngine = require('./services/AutoReplyEngine');
const broadcastEngine = require('./services/BroadcastEngine');
const aiMediator = require('./services/AIMediator');
const { extractLeadInfo } = require('./utils/leadExtractor');
const { downloadAvatar, saveAvatarFromBase64OrUrl, serveAvatar } = require('./utils/avatarManager');
const LinkPreviewService = require('./services/LinkPreviewService');
// Link facebook share/p thiếu og:image (Facebook khóa sau login): đẩy nhiệm
// vụ sang extension - mở tab đọc og:image trong Chrome đã đăng nhập rồi trả về.
const linkImageSentAt = new Map();
LinkPreviewService.onImageNeeded = (urlHash, url) => {
  // Throttle: moi hash chi moi extension moi 10 phut mot lan
  const last = linkImageSentAt.get(urlHash) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  for (const extWs of extensionConnections.values()) {
    if (extWs.readyState === WebSocket.OPEN) {
      linkImageSentAt.set(urlHash, Date.now());
      extWs.send(JSON.stringify({ type: 'FETCH_LINK_IMAGE', data: { url_hash: urlHash, url } }));
      break;
    }
  }
};
const { isSystemOrMetadataText, isSystemConversationNotice, cleanMessageText, isSidebarActivitySummary, isInvalidContactName, cleanContactName } = require('./utils/textFilter');
const { sidebarShouldSkipSweep, isStaleThreadLastActivity } = require('./utils/sidebarCompare');
const { isKnownPageSystemNotice } = require('./utils/pageSystemNotice');
const { parsePageIdFromInput } = require('./utils/pageIdParser');
const ConversationRepository = require('./repositories/ConversationRepository');
const MessageQueueRepository = require('./repositories/MessageQueueRepository');
const queueWorker = require('./services/QueueWorker');
const CampaignRepository = require('./repositories/CampaignRepository');
const CampaignResponseStatsService = require('./services/CampaignResponseStatsService');
const CampaignService = require('./services/CampaignService');
const campaignRunner = require('./services/CampaignRunner');
const CampaignEventService = require('./services/CampaignEventService');
const CampaignEligibilityService = require('./services/CampaignEligibilityService');
const CampaignAttachmentService = require('./services/CampaignAttachmentService');
const CampaignRecoveryService = require('./services/CampaignRecoveryService');
const LeadStatusService = require('./services/LeadStatusService');
const ContactService = require('./services/ContactService');
const AccountService = require('./services/AccountService');
const FollowupService = require('./services/FollowupService');
const InboxSourceService = require('./services/InboxSourceService');
const InboxSyncScheduler = require('./services/InboxSyncScheduler');
const InitialMessageSweepService = require('./services/InitialMessageSweepService');
const { isChangedIncomingSidebarPreview, isFreshRowTimeText } = require('./utils/sidebarIncomingDetection');

// Dedupe media-hint theo thread: dòng thời gian sidebar giữ trạng thái "Bây
// giờ"/fresh ~1 phút và quét 2s vẫn thấy -> không cho bắn sync lặp.
const mediaHintLastSeen = new Map();
// threadKey -> row_time_text của lần quét TRƯỚC: phân biệt "Bây giờ" MỚI
// (tin vừa đến, row vừa chuyển sang fresh) với nhịp quét tiếp diễn của
// cùng message - không có cái này thì bump unread nổ lại mỗi 8s trong
// ~60s row còn "Bây giờ", badge hiện đi hiện lại sau khi operator đọc
// (báo lỗi 2026-10-02).
const rowTimePrevSeen = new Map();
const licenseChecker = require('./services/LicenseChecker');

// Remote License Server URL – must match CentralAuthClient / LicenseChecker
const LICENSE_SERVER_BASE_URL = (process.env.LICENSE_SERVER_URL || 'https://genblackmmoonline.online/license_server').replace(/\/$/, '');

const app = express();
const followupService = new FollowupService(db);
const authService = new AuthService(db);
const centralAuthClient = new CentralAuthClient();
app.use(express.json());

function sendAuthError(res, error) {
  const status = error instanceof AuthError || error instanceof CentralAuthError ? error.status : (error?.status || 500);
  if (status === 500) console.error('[Auth Error]', error);
  res.status(status).json({
    success: false,
    code: error?.code || 'AUTH_ERROR',
    message: error?.message || 'Không thể xử lý yêu cầu đăng nhập.'
  });
}

// Authentication comes before license activation: users sign in first, then
// the authenticated application checks or activates this machine's key.
app.post('/api/auth/register-otp', async (req, res) => {
  try {
    const data = await centralAuthClient.requestRegistrationOtp(req.body?.email);
    res.json({ success: true, data });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post('/api/auth/reset-password-otp', async (req, res) => {
  try {
    const data = await centralAuthClient.requestResetPasswordOtp(req.body?.email);
    res.json({ success: true, data });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const data = await centralAuthClient.resetPassword(req.body || {});
    res.json({ success: true, message: data?.message || 'Đặt lại mật khẩu thành công!' });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const user = await authService.registerManaged(req.body || {}, centralAuthClient);
    const session = authService.login(req.body || {});
    res.setHeader('Set-Cookie', authService.sessionCookie(session.token));
    res.status(201).json({ success: true, user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const session = isLocalDevRequest(req, 'LOCAL_DEV_AUTH')
      ? authService.login(req.body || {})
      : await authService.loginManaged(req.body || {}, centralAuthClient);
    res.setHeader('Set-Cookie', authService.sessionCookie(session.token));
    res.json({ success: true, user: session.user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

let latestLocalSession = null;

app.post('/api/auth/google', async (req, res) => {
  try {
    const session = await authService.loginGoogleManaged(req.body || {}, centralAuthClient);
    res.setHeader('Set-Cookie', authService.sessionCookie(session.token));
    latestLocalSession = { token: session.token, user: session.user, expiresAt: Date.now() + 60000 };
    io.emit('AUTH_SUCCESS', { user: session.user, token: session.token });
    res.json({ success: true, user: session.user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get('/api/auth/latest-local-session', (req, res) => {
  if (latestLocalSession && Date.now() < latestLocalSession.expiresAt) {
    const sessionData = latestLocalSession;
    latestLocalSession = null;
    res.setHeader('Set-Cookie', authService.sessionCookie(sessionData.token));
    return res.json({ success: true, user: sessionData.user, token: sessionData.token });
  }
  res.status(404).json({ success: false });
});

app.post('/api/auth/claim-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'Thiếu token' });
  res.setHeader('Set-Cookie', authService.sessionCookie(token));
  res.json({ success: true });
});

app.get('/google-auth-external', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Xác thực Google - FB Messenger CRM</title>
      <script src="https://accounts.google.com/gsi/client" async defer onload="initGoogle()"></script>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
        .card { background: white; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 90%; }
        h2 { margin-top: 0; color: #1e293b; font-size: 1.5rem; }
        p { color: #64748b; font-size: 0.95rem; margin-bottom: 1.5rem; line-height: 1.5; }
        .success { color: #16a34a; font-weight: 600; display: none; margin-top: 1.5rem; padding: 0.75rem; background: #f0fdf4; border-radius: 0.5rem; border: 1px solid #bbf7d0; }
        .error { color: #dc2626; font-weight: 500; display: none; margin-top: 1.5rem; padding: 0.75rem; background: #fef2f2; border-radius: 0.5rem; border: 1px solid #fecaca; font-size: 0.9rem; }
        .btn-container { display: flex; justify-content: center; margin-top: 1rem; min-height: 50px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>MISSPRICE CRM</h2>
        <p>Vui lòng chọn tài khoản Google để tiếp tục sử dụng ứng dụng Desktop.</p>
        <div class="btn-container">
          <div id="googleBtn"></div>
        </div>
        <div id="msg-success" class="success">✓ Đăng nhập thành công! Cửa sổ này sẽ tự động đóng...</div>
        <div id="msg-error" class="error"></div>
      </div>
      <script>
        function initGoogle() {
          if (!window.google?.accounts?.id) return;
          google.accounts.id.initialize({
            client_id: '436041288370-9v5egma47gmsbi2pgalj77un535j15r7.apps.googleusercontent.com',
            callback: handleCredentialResponse,
            ux_mode: 'popup',
            auto_select: false
          });
          google.accounts.id.renderButton(
            document.getElementById("googleBtn"),
            { theme: "outline", size: "large", width: 320, text: "signin_with", shape: "rectangular" }
          );
        }
        window.addEventListener('load', () => {
          if (window.google?.accounts?.id) initGoogle();
        });
        async function handleCredentialResponse(response) {
          const errDiv = document.getElementById('msg-error');
          const succDiv = document.getElementById('msg-success');
          errDiv.style.display = 'none';
          try {
            const res = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential: response.credential })
            });
            const result = await res.json();
            if (result.success) {
              succDiv.style.display = 'block';
              setTimeout(() => { try { window.close(); } catch(_) {} }, 1500);
            } else {
              errDiv.textContent = result.message || 'Đăng nhập bằng Google thất bại.';
              errDiv.style.display = 'block';
            }
          } catch(e) {
            errDiv.textContent = 'Không thể kết nối đến máy chủ.';
            errDiv.style.display = 'block';
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/api/auth/me', async (req, res) => {
  const user = authService.getRequestUser(req);
  if (!user) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  if (isLocalDevRequest(req, 'LOCAL_DEV_AUTH')) {
    return res.json({ success: true, user });
  }
  try {
    const status = await centralAuthClient.accountStatus(user.username);
    if (status?.data?.company_role && status.data.company_role !== user.company_role) {
      authService.db.prepare('UPDATE users SET company_role=? WHERE id=?').run(status.data.company_role, user.id);
      user.company_role = status.data.company_role;
    }
  } catch (error) {
    if (error instanceof CentralAuthError && ['USER_NOT_FOUND', 'ACCOUNT_BLOCKED'].includes(error.code)) {
      authService.revokeRequestSession(req);
      res.setHeader('Set-Cookie', authService.clearCookie());
      return res.status(401).json({ success: false, code: error.code, message: error.message });
    }
    // A temporary License Server outage must not destroy a valid local session.
  }
  res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  authService.revokeRequestSession(req);
  res.setHeader('Set-Cookie', authService.clearCookie());
  res.json({ success: true });
});

// Desktop startup probes this endpoint before a user session or license exists.
// Keep it ahead of both API protection middlewares so Electron can verify that
// it is talking to the backend process started by this exact app instance.
app.get('/api/health', (req, res) => res.json({
  status: 'OK', uptime: process.uptime(),
  db: 'SQLite WAL Mode', activeExtensions: extensionConnections.size,
  instance_token: process.env.CRM_INSTANCE_TOKEN || null,
  pid: process.pid
}));

const requireAuthenticatedApi = authService.middleware();
app.use('/api', (req, res, next) => {
  // Central payment callbacks and order polling must remain reachable before
  // a user session exists. License status/activation intentionally do not:
  // the product flow is authenticate first, then activate the workstation.
  const unauthenticatedPaymentPaths = [
    '/payment/sepay-webhook',
    '/orders/create',
    '/orders/status',
    '/extension/reload',
    '/avatars/'
  ];
  if (unauthenticatedPaymentPaths.some((pathPrefix) => req.path.startsWith(pathPrefix))) return next();
  return requireAuthenticatedApi(req, res, next);
});

// 1. API Kiểm tra trạng thái bản quyền cục bộ
app.get('/api/license/status', async (req, res) => {
  try {
    if (isLocalDevRequest(req, 'LOCAL_DEV_SKIP_LICENSE')) {
      return res.json({
        success: true,
        data: {
          isLicensed: true,
          reason: 'LOCAL_DEV',
          message: 'Đang dùng chế độ kiểm thử local.',
          key: 'LOCAL-DEV'
        }
      });
    }
    const user = authService.getRequestUser(req);
    const savedKey = licenseChecker.getSavedKey();

    // Nếu máy này chưa/đã bị đăng xuất Key (không có savedKey) và không phải tài khoản nhân viên
    if (!savedKey && user?.company_role !== 'EMPLOYEE') {
      return res.json({
        success: true,
        data: {
          isLicensed: false,
          reason: 'NO_KEY',
          message: 'Máy này chưa kích hoạt License Key.'
        }
      });
    }

    const { getMachineId } = require('./utils/machineId');
    const licenseAbortController = new AbortController();
    const licenseTimeout = setTimeout(() => licenseAbortController.abort(), 5000);
    const response = await fetch(`${LICENSE_SERVER_BASE_URL}/api/client-auth/license-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, key: savedKey, machineId: getMachineId() }),
      signal: licenseAbortController.signal
    }).finally(() => clearTimeout(licenseTimeout));
    const result = await response.json().catch(() => ({}));
    if (result.success && result.data?.valid && result.data?.key && savedKey) {
      if (licenseChecker.getSavedKey() !== result.data.key) {
        licenseChecker.saveKey(result.data.key);
      }
    }
    res.json({ success: true, data: { isLicensed: Boolean(result.data?.valid), ...result.data } });
  } catch (error) {
    res.json({ success: true, data: { isLicensed: false, reason: 'LICENSE_SERVER_UNAVAILABLE', message: 'Không thể kiểm tra gói tài khoản.' } });
  }
});

// 2. API Kích hoạt Key mới
app.post('/api/license/activate', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'Thiếu mã Key' });

    const normalizedKey = key.trim();
    const { getMachineId } = require('./utils/machineId');
    const machineId = getMachineId();

    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: normalizedKey,
        machineId,
        deviceName: 'Máy CRM Desktop',
        clientUsername: authService.getRequestUser(req).username
      })
    });
    const centralResult = await centralResponse.json();

    if (!centralResponse.ok || !centralResult.success) {
      return res.status(400).json({
        success: false,
        message: centralResult.message || centralResult.error || 'Không thể kích hoạt Key trên License Server',
        data: centralResult
      });
    }

    licenseChecker.saveKey(normalizedKey);
    const status = await licenseChecker.verify();

    if (status.isLicensed) {
      res.json({ success: true, message: 'Kích hoạt bản quyền thành công!', data: status });
    } else {
      licenseChecker.removeKey();
      res.status(400).json({ success: false, message: status.message || 'Mã Key không hợp lệ', data: status });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'Không thể kết nối License Server', error: e.message });
  }
});

// 2b. Lưu tên công ty cho chính Key đang được kích hoạt trên máy này
app.post('/api/license/company', async (req, res) => {
  try {
    const companyName = String(req.body?.companyName || '').trim().replace(/\s+/g, ' ');
    if (companyName.length < 2 || companyName.length > 120) {
      return res.status(400).json({ success: false, message: 'Tên công ty phải từ 2 đến 120 ký tự' });
    }

    const savedKey = licenseChecker.getSavedKey();
    if (!savedKey) {
      return res.status(400).json({ success: false, message: 'Máy chưa có License Key đã kích hoạt' });
    }

    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/license/company`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: savedKey, companyName })
    });
    const centralResult = await centralResponse.json();
    if (!centralResponse.ok || !centralResult.success) {
      return res.status(centralResponse.status || 400).json(centralResult);
    }
    res.json(centralResult);
  } catch (error) {
    res.status(502).json({ success: false, message: 'Không thể kết nối License Server để lưu tên công ty', error: error.message });
  }
});

// 3. API Đăng xuất Key
app.post('/api/license/deactivate', async (req, res) => {
  try {
    const key = licenseChecker.getSavedKey();
    if (key) {
      const { getMachineId } = require('./utils/machineId');
      const machineId = getMachineId();
      await fetch(`${LICENSE_SERVER_BASE_URL}/api/license/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, machineId })
      }).catch(() => {});
    }
    licenseChecker.removeKey();
    res.json({ success: true, message: 'Đã hủy đăng ký bản quyền trên máy này' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Proxy / Forward SePay Webhook sang Central License Server (Port 5055)
app.post('/api/payment/sepay-webhook', async (req, res) => {
  try {
    const fetchRes = await fetch(`${LICENSE_SERVER_BASE_URL}/api/sepay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const json = await fetchRes.json();
    res.status(fetchRes.status).json(json);
  } catch (err) {
    console.error('[Server 5050 Proxy SePay Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Áp dụng Middleware Bảo Vệ Khóa Backend cho tất cả các API CRM
app.use('/api', licenseChecker.middleware());

// Static: React Dashboard UI & Media files
const clientDistPath = path.join(__dirname, '../../dist/client');
app.use(express.static(clientDistPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') || filePath.endsWith('.png')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  } 
}));
app.use('/data/media', express.static(path.join(APP_DATA_ROOT, 'media')));
app.use('/data/exports', express.static(path.join(APP_DATA_ROOT, 'exports')));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });
io.use((socket, next) => {
  const user = authService.getRequestUser({ headers: socket.handshake.headers });
  if (!user) return next(new Error('AUTH_REQUIRED'));
  socket.user = user;
  next();
});
const wss = new WebSocket.Server({ noServer: true });
const extensionConnections = new Map();
// A Page runs in a separate Chrome profile but normally has the same Facebook
// c_user as Personal Messenger. Keep its WebSocket separate so Page startup
// never replaces the personal connection used for Inbox and Requests.
const pageExtensionConnections = new Map();
// Cache danh sách Fanpage phát hiện qua Auto-Discovery (In-memory)
// Key: accountId -> Value: { pages: Array, updatedAt: number }
const discoveredPagesByAccount = new Map();
const lastPageRefreshRequestedAt = new Map();
function pageConnectionKey(accountId, pageId) {
  return `${String(accountId || '')}:${String(pageId || '')}`;
}
function activePageSourcesForAccount(accountId) {
  return db.prepare(`
    SELECT external_id AS page_id FROM inbox_sources
    WHERE source_type = 'page_messenger' AND status = 'ACTIVE'
      AND owner_account_id = ? AND external_id IS NOT NULL
  `).all(String(accountId || '')).filter((row) => /^\d+$/.test(String(row.page_id || '')));
}
function dispatchPageSidebarSync(accountId, reason = 'manual') {
  const accountKey = String(accountId || '');
  if (!accountKey) return 0;
  let dispatched = 0;
  const isDeep = reason === 'manual' || reason === 'manual_crm_request' || reason === 'manual_sync_window' || reason === 'initial_deep';
  for (const source of activePageSourcesForAccount(accountKey)) {
    const pageId = String(source.page_id);
    const pageWs = pageExtensionConnections.get(pageConnectionKey(accountKey, pageId));
    if (pageWs?.readyState === WebSocket.OPEN) {
      pageWs.send(JSON.stringify({
        type: 'SYNC_PAGE_SIDEBAR',
        data: {
          account_id: accountKey,
          page_id: pageId,
          reason,
          deep: isDeep,
          max_rounds: isDeep ? 35 : 1
        }
      }));
      dispatched += 1;
    }
    // NOTE: Removed auto-spawn startPageProcess here. When pageWs is not
    // connected the user's own Chrome (with Meta Business Suite already
    // authenticated) will handle Page sync. Spawning a fresh, unauthenticated
    // Chrome profile just redirects to the Facebook login page.
  }
  return dispatched;
}
const messageRequestActionOwners = new Map();
const pendingAccountOwners = new Map();
// Pending-key setups that successfully promoted to a real account (this
// process only). The /api/facebook-setup/:key/status poll additionally treats
// an ACTIVE accounts row whose profile_dir contains the pending key as
// completed, so a backend restart between register and poll cannot strand the
// operator UI on "Đang chờ đăng nhập Facebook..." forever.
const completedPendingSetups = new Map();
// Single reader for the pending-profile owner marker. The marker is written
// as { owner_user_id } (see POST /api/accounts/new-session); older builds
// also wrote userId, so accept both spellings.
function markerOwnerUserId(pendingKey) {
  try {
    const markerPath = path.join(APP_DATA_ROOT, 'profiles', String(pendingKey), '.crm-pending-owner.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker.owner_user_id || marker.userId || null;
  } catch (_) {
    return null;
  }
}

// ─── Chrome profile cleanup ─────────────────────────────────────────────
// 1) deleteChromeProfileDir(): xóa tài khoản FB = xóa luôn thư mục profile
//    Chrome của nó (yêu cầu sản phẩm 2026-09-17; trước đây thư mục được giữ
//    lại để tái sử dụng Facebook trust). Chỉ nhận tên thư mục cuối cùng và
//    luôn giới hạn bên trong profiles/ để không bao giờ xóa ra ngoài.
// 2) sweepAbandonedPendingProfiles(): profile pending_* mà operator không bao
//    giờ đăng nhập (bấm nút rồi hủy/đóng Chrome) trước đây tồn tại vĩnh viễn
//    - 93 thư mục ~20GB tích tụ từ 2026-08-21. Sweep xóa những cái: không
//    được tham chiếu bởi accounts.profile_dir, không có process đang chạy,
//    và "già" hơn 6 giờ (marker hoặc thư mục - phiên đang nhập liệu có
//    mtime tươi nên không bao giờ bị xóa nhầm).
const PENDING_SWEEP_MIN_AGE_MS = 6 * 60 * 60 * 1000;
function deleteChromeProfileDir(dirName) {
  const base = path.basename(String(dirName || '').trim());
  if (!base || base === '.' || base === '..') return false;
  const target = path.join(APP_DATA_ROOT, 'profiles', base);
  if (!fs.existsSync(target)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    console.log(`[ProfileCleanup] Đã xóa thư mục Chrome profile: ${base}`);
    return true;
  } catch (error) {
    console.warn(`[ProfileCleanup] Chưa xóa được ${base} (Chrome có thể còn giữ file):`, error.message);
    return false;
  }
}
function sweepAbandonedPendingProfiles() {
  const profilesRoot = path.join(APP_DATA_ROOT, 'profiles');
  let referenced;
  try {
    referenced = new Set(db.prepare('SELECT profile_dir FROM accounts').all()
      .map((row) => path.basename(String(row.profile_dir || '')).toLowerCase()));
  } catch (_) { return; }
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('pending_')) continue;
      if (referenced.has(entry.name.toLowerCase())) continue;
      if (processManager.processes.has(entry.name)) continue;
      const dirPath = path.join(profilesRoot, entry.name);
      let ageMs = null;
      try { ageMs = Date.now() - fs.statSync(path.join(dirPath, '.crm-pending-owner.json')).mtimeMs; } catch (_) {}
      if (ageMs === null) {
        try { ageMs = Date.now() - fs.statSync(dirPath).mtimeMs; } catch (_) { continue; }
      }
      if (ageMs < PENDING_SWEEP_MIN_AGE_MS) continue;
      try {
        // Phiên bỏ hoang CÓ THỂ còn Chrome đang mở (cửa sổ BS/popup phiền) -
        // đóng nhẹ nhàng (WM_CLOSE) trước để taskbar gỡ nút sạch sẽ, chỉ
        // taskkill khi Chrome treo; xóa profile sau để tránh khóa file
        // (reproduced 2026-09-19).
        const findPs = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -replace '\\','/') -like '*${entry.name.replace(/'/g, "''")}*' } | ForEach-Object { Write-Output $_.ProcessId }`;
        const encodedFind = Buffer.from(findPs, 'utf16le').toString('base64');
        const found = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedFind], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
        const chromePids = String(found.stdout || '')
          .split(/\r?\n/)
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((p) => Number.isInteger(p) && p > 0);
        const stillAlive = closeChromePidsGracefullySync(chromePids, 3000);
        for (const pid of stillAlive) {
          spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); // sleep dong bo (ham khong async)
        fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        removed++;
        console.log(`[ProfileCleanup] Đã xóa profile pending bỏ hoang: ${entry.name}`);
      } catch (_) { /* file đang bị khóa - sweep lần sau sẽ thử lại */ }
    }
  } catch (_) {}
  if (removed) console.log(`[ProfileCleanup] Sweep hoàn tất: ${removed} profile pending rác.`);
}
setTimeout(sweepAbandonedPendingProfiles, 60 * 1000);
setInterval(sweepAbandonedPendingProfiles, 60 * 60 * 1000);
// Operator closed the setup Chrome without finishing registration: delete
// that pending profile right away (their request 2026-09-17: "ấn thêm tk fb
// mở chrome lên nhưng user k login cũng tự động xóa") and tell the waiting
// AccountManagerModal to stop spinning. The 6h sweep stays as the backstop
// for crashes/backend restarts this immediate path can't see.
processManager.onPendingSessionAbandoned = (pendingKey) => {
  const key = String(pendingKey || '');
  if (!/^pending_[a-zA-Z0-9_]+$/.test(key)) return;
  setTimeout(() => {
    // Registration can land between Chrome exit and this timer - never
    // delete a profile some account row still points at.
    try {
      if (db.prepare('SELECT 1 FROM accounts WHERE profile_dir LIKE ?').get(`%${key}%`)) return;
    } catch (_) { return; }
    pendingAccountOwners.delete(key);
    deleteChromeProfileDir(key);
    io.emit('ACCOUNT_LINK_FAILED', {
      pending_key: key,
      error: 'Đã đóng Chrome trước khi hoàn tất đăng nhập - phiên thêm tài khoản đã được dọn.'
    });
  }, 5000);
};
// Existing-account "Kết nối Facebook" launches should become background
// processes only after that account's extension has registered successfully.
// New-account pending sessions are intentionally excluded so the login window
// stays visible for the operator.
const backgroundAfterConnectRequests = new Map();
// A newly-added Facebook profile first registers with pending_key while the
// operator completes login/PIN. Its normal REGISTER_ACCOUNT arrives later.
// Keep a bounded bootstrap retry here so that account enters the same inbox +
// requests sync pipeline as the existing "Connect Facebook" action, even if
// the first scan races the three Messenger role tabs becoming ready.
const newAccountBootstrapSyncs = new Map();
// pageId -> lan cuoi yeu cau extension lay profile (ten/avatar) cua Page
const pageProfileFetchLastRequestedAt = new Map();
const domReplaySuppressUntil = new Map();
const callEventDeduplicator = new CallEventDeduplicator();
const historyBackfillJobs = new Map();
const bulkHistoryJobs = new Map();
// Diagnostic mode requested by the operator: keep managed Facebook Chrome
// visible after Connect Facebook so realtime/sync behaviour can be observed.
// Existing background-mode code remains intact and can be restored by setting
// this flag to false.
const KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE = false;
const backgroundAfterConnectTimers = new Map();

function enterBackgroundAfterSyncWindow(accountId, requestedAt, reason = 'sync_finished') {
  const key = String(accountId || '');
  if (!key || !Number.isFinite(requestedAt) || KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE) return;
  const existing = backgroundAfterConnectTimers.get(key);
  if (existing) clearTimeout(existing);
  const remaining = Math.max(0, 120000 - (Date.now() - requestedAt));
  const timer = setTimeout(async () => {
    backgroundAfterConnectTimers.delete(key);
    if (backgroundAfterConnectRequests.get(key) !== requestedAt) return;
    backgroundAfterConnectRequests.delete(key);
    const hideRes = await processManager.hideAccountProcess(key);
    if (hideRes?.success) {
      io.emit('ACCOUNT_DISPLAY_CHANGED', {
        account_id: key,
        chrome_display_mode: 'BACKGROUND',
        is_chrome_running: true
      });
    }
    console.log(`[BACKGROUND_AFTER_SYNC] account=${key} hidden=true reason=${reason} success=${!!hideRes?.success}`);
  }, remaining);
  backgroundAfterConnectTimers.set(key, timer);
  if (typeof timer.unref === 'function') timer.unref();
}

function scheduleNewAccountBootstrapSync(accountId) {
  const key = String(accountId || '');
  if (!key || newAccountBootstrapSyncs.has(key)) return;
  const state = { attempt: 0, timer: null };
  const delays = [4000, 18000, 45000];
  const dispatch = () => {
    if (!newAccountBootstrapSyncs.has(key)) return;
    const attempt = state.attempt++;
    const dispatched = InboxSyncScheduler.requestSidebarSync(key, 'new_account_bootstrap');
    console.log(`[NEW_ACCOUNT_BOOTSTRAP_SYNC] account=${key} attempt=${attempt + 1}/${delays.length} dispatched=${dispatched}`);
    if (state.attempt >= delays.length) {
      newAccountBootstrapSyncs.delete(key);
      return;
    }
    state.timer = setTimeout(dispatch, delays[state.attempt]);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  };
  newAccountBootstrapSyncs.set(key, state);
  state.timer = setTimeout(dispatch, delays[0]);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

function completeNewAccountBootstrapSync(accountId) {
  const key = String(accountId || '');
  const state = newAccountBootstrapSyncs.get(key);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  newAccountBootstrapSyncs.delete(key);
  console.log(`[NEW_ACCOUNT_BOOTSTRAP_SYNC] account=${key} completed`);
}

function sanitizeLog(str, maxLen = 120) {
  if (!str) return '';
  const cleaned = String(str).replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + '...' : cleaned;
}

// Đo từng chặng đường realtime hint (observer -> bg -> server) trong
// composer-debug.log để so latency với bgDebug/obsDebug phía extension.
function syncDebug(stage, data = {}) {
  try {
    fs.appendFileSync(
      path.join(APP_DATA_ROOT, 'composer-debug.log'),
      JSON.stringify({ at: new Date().toISOString(), source: 'SYNC_DEBUG', stage, ...data }) + '\n'
    );
  } catch (_) {}
}

const richContentSecret = crypto.randomBytes(32);

function requireLocalCrmRequest(req, res, next) {
  if (isLoopbackAddress(req.socket?.remoteAddress) === false) {
    return res.status(403).json({
      code: 'LOCAL_CRM_REQUIRED',
      error: 'Rich-message chỉ được phép từ CRM chạy trên máy này.'
    });
  }
  next();
}

function getLocalOperatorId() {
  return db.prepare(
    "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1"
  ).get()?.id || null;
}

function getRichMessageCapabilityOptions() {
  return {
    database: db,
    getConnection: (accountId) => extensionConnections.get(accountId)
  };
}

function createAttachmentContentToken(attachmentId, lifetimeMs = 60 * 60 * 1000) {
  const expires = Date.now() + lifetimeMs;
  const payload = String(attachmentId) + ':' + expires;
  const token = crypto.createHmac('sha256', richContentSecret).update(payload).digest('hex');
  return { expires, token };
}

function verifyAttachmentContentToken(attachmentId, expiresValue, tokenValue) {
  const expires = Number(expiresValue);
  const token = String(tokenValue || '');
  if (Number.isSafeInteger(expires) === false || expires < Date.now() || /^[a-f0-9]{64}$/.test(token) === false) {
    return false;
  }
  const expected = crypto.createHmac('sha256', richContentSecret)
    .update(String(attachmentId) + ':' + expires)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// Rich-message attachments require a signed URL per FR-023's "authenticated
// content access" - a stored, unsigned media_url would 403 (token missing)
// and a stored absolute filesystem path would 404 via the SPA catch-all
// (neither is web-servable as-is). Sign fresh on every read instead of at
// insert time, since createAttachmentContentToken()'s token has a lifetime.
function withAttachmentAccessUrl(message) {
  if (!message || !message.attachment_id) return message;
  const { expires, token } = createAttachmentContentToken(message.attachment_id);
  return {
    ...message,
    media_url: '/api/outbound-attachments/' + message.attachment_id + '/content' +
      '?expires=' + expires + '&token=' + token,
    local_media_path: null
  };
}

function hasMessageMediaPayload(message = {}) {
  return Boolean(
    message.media_url
    || message.local_media_path
    || message.attachment_id
    || message.attachment?.preview_url
    || message.attachment?.media_url
    || message.attachment?.local_media_path
    || message.attachment?.id
  );
}

function isRenderableStoredMessage(message = {}) {
  const cleaned = cleanMessageText(message.content ?? message.cleaned ?? message.text ?? '');
  const mediaType = String(message.media_type || 'text').toLowerCase();
  return Boolean(
    hasMessageMediaPayload(message)
    || mediaType === 'call'
    || (cleaned && !isSystemOrMetadataText(cleaned))
  );
}

function prepareMessagesForClient(rows = []) {
  const prepared = rows
    .map((row) => {
      const cleaned = cleanMessageText(row.content ?? row.cleaned ?? '');
      // System/DOM labels are never useful as a caption. Keep text only when
      // it survives cleaning; a real attachment remains renderable by itself.
      return withAttachmentAccessUrl({ ...row, content: cleaned || '' });
    })
    .filter(isRenderableStoredMessage)
    // Old malformed observer rows can already be in SQLite when an update is
    // installed. Hide an incoming echo of the operator's just-sent text here
    // too, not only at the WebSocket write boundary.
    .filter((row) => !isRecentOutgoingTextEcho(row.thread_id, row));
  LinkPreviewService.attachPreviews(prepared);
  return prepared;
}

function isRecentOutgoingTextEcho(threadId, message = {}, database = db) {
  const content = cleanMessageText(message.content ?? message.cleaned ?? '');
  if (!threadId || !content || hasMessageMediaPayload(message)) return false;
  const mediaType = String(message.media_type || 'text').toLowerCase();
  if (mediaType && mediaType !== 'text') return false;
  const isExplicitOutgoing = message.is_outgoing === true || message.is_outgoing === 1;
  if (isExplicitOutgoing) return false;
  // Synthetic DOM/history ids are the exact shape Facebook uses when it
  // replays an operator bubble as an incoming row. Match the durable outgoing
  // text across the history window so a late crawler cannot resurrect it.
  const isSyntheticObserverId = /^(?:dom_|history_|network_|websocket_|mercury_|xhr_)/i.test(String(message.fb_message_id || ''));
  return ConversationRepository.hasRecentMatchingOutgoing(threadId, content, database, {
    windowMs: isSyntheticObserverId ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000,
    futureToleranceMs: 60 * 1000
  });
}

// History rows can be collapsed from Facebook's temporary _media companion
// id into the durable parent row before the remote file finishes downloading.
// Hydrate by the durable SQLite row id so incoming photos/videos cannot lose
// their local path during that merge.
const inboundMediaHydration = new InboundMediaHydrationService({
  database: db,
  downloader: mediaDownloader,
  maxConcurrency: 4,
  onHydrated: (stored) => io.emit('THREAD_MESSAGES_UPDATED', {
    thread_id: String(stored.thread_id),
    messages: [withAttachmentAccessUrl(stored)]
  })
});

const resolvedPageVideos = new Map();

// Thống kê batch Page: log định kỳ để theo dõi tỉ lệ duplicate/rejected
// (batch trùng lặp hàng loạt là dấu hiệu state machine phía extension giật).
const pageBatchStats = { total: 0, committed: 0, duplicate: 0, stale_generation: 0, rejected: 0, other: 0 };

function sendRichMessageError(res, error) {
  const status = Number(error?.httpStatus) || 400;
  res.status(status).json({
    error: error?.message || 'Không thể xử lý rich-message.',
    code: error?.code || 'RICH_MESSAGE_ERROR',
    details: error?.details || null
  });
}

// Router HTTP Upgrade: phân định Socket.io vs Chrome Extension WebSocket
// Extension kết nối tại: ws://127.0.0.1:5050/extension
// Socket.IO kết nối tại: ws://localhost:5050/socket.io/...
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname.startsWith('/socket.io')) {
    // Socket.io tự xử lý upgrade của mình
    return;
  }

  // Chấp nhận /extension (Chrome Extension) hoặc / (legacy)
  if (pathname === '/extension' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // Từ chối các path không xác định
    socket.destroy();
  }
});

// ── Helper: gửi tin nhắn qua Extension WebSocket ──────────────────────────
function deleteOutboundMessageRows({ messageId = null, threadId = null, clientMessageId = null, failedOnly = false } = {}) {
  const clauses = [];
  const params = [];
  if (messageId != null) { clauses.push('id = ?'); params.push(messageId); }
  if (threadId != null) { clauses.push('thread_id = ?'); params.push(String(threadId)); }
  if (clientMessageId != null) { clauses.push('client_message_id = ?'); params.push(String(clientMessageId)); }
  if (!clauses.length) return 0;
  const failedClause = failedOnly ? " AND delivery_status = 'failed'" : '';
  const rows = db.prepare(`SELECT id FROM messages WHERE ${clauses.join(' AND ')}${failedClause}`).all(...params);
  if (!rows.length) return 0;
  return db.transaction((messageIds) => {
    const attempts = db.prepare(`SELECT id FROM outbound_attempts WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds);
    if (attempts.length) {
      const attemptIds = attempts.map((row) => row.id);
      const placeholders = attemptIds.map(() => '?').join(',');
      db.prepare(`UPDATE message_queue SET outbound_attempt_id = NULL WHERE outbound_attempt_id IN (${placeholders})`).run(...attemptIds);
      db.prepare(`UPDATE messages SET latest_attempt_id = NULL WHERE latest_attempt_id IN (${placeholders})`).run(...attemptIds);
      db.prepare(`DELETE FROM outbound_attempts WHERE id IN (${placeholders})`).run(...attemptIds);
    }
    return db.prepare(`DELETE FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')})`).run(...messageIds).changes;
  })(rows.map((row) => row.id));
}

function emitOutboundCleanupResolved(threadId, pendingRow, confirmedRow) {
  // The deleted row's optimistic bubble in the CRM is keyed by
  // client_message_id. Deleting silently left it spinning forever, so tell
  // the UI how the underlying send actually ended.
  const clientMessageId = String(pendingRow?.client_message_id || '');
  if (!clientMessageId.startsWith('client_') && !clientMessageId.startsWith('queue_')) return;
  io.emit('MESSAGE_SENT', {
    thread_id: String(threadId),
    client_message_id: clientMessageId,
    fb_message_id: confirmedRow?.fb_message_id || undefined,
    status: 'sent'
  });
}

function cleanupStalePendingOutbound(threadId) {
  if (!threadId) return 0;
  // A queue row whose attempt link was severed (its pending message row was
  // deleted by an earlier cleanup) can never leave 'processing' on its own.
  db.prepare(`
    UPDATE message_queue SET status = 'failed', error_reason = 'ATTEMPT_LOST'
    WHERE status = 'processing' AND outbound_attempt_id IS NULL
      AND processed_at IS NOT NULL AND processed_at < datetime('now', '-5 minutes')
  `).run();

  const confirmedOutgoing = db.prepare(`
    SELECT content, media_type, timestamp_ms, fb_message_id FROM messages
    WHERE thread_id = ? AND is_outgoing = 1 AND fb_message_id LIKE 'mid.%'
  `).all(String(threadId));
  if (!confirmedOutgoing.length) return 0;

  const confirmedContents = new Set(confirmedOutgoing.map(c => (c.content || '').trim()).filter(Boolean));
  // Carry the live attempt/queue status: an in-flight rich send owns a pending
  // row here while its video is still uploading, and must never look "stale"
  // just because an older media in the same thread was confirmed recently.
  const stalePending = db.prepare(`
    SELECT p.id, p.client_message_id, p.content, p.media_type, p.attachment_id, p.timestamp_ms,
           a.status AS attempt_status, aq.status AS queue_status
    FROM messages p
    LEFT JOIN outbound_attempts a ON a.id = p.latest_attempt_id
    LEFT JOIN message_queue aq ON aq.outbound_attempt_id = a.id
    WHERE p.thread_id = ? AND p.is_outgoing = 1 AND (p.fb_message_id LIKE 'pending_%' OR p.fb_message_id NOT LIKE 'mid.%')
  `).all(String(threadId));

  let deletedCount = 0;
  for (const pending of stalePending) {
    if (['queued', 'dispatching', 'awaiting_confirmation'].includes(String(pending.attempt_status || ''))) continue;
    if (['pending', 'processing'].includes(String(pending.queue_status || ''))) continue;
    const pContent = (pending.content || '').trim();
    if (pContent && confirmedContents.has(pContent)) {
      // Bảo vệ: Nếu tin nhắn pending có đính kèm media (video/ảnh/tệp),
      // không được xóa nó chỉ vì caption text trùng khớp với một tin nhắn text đồng hành trên Facebook!
      if (pending.attachment_id || (pending.media_type && pending.media_type !== 'text')) {
        continue;
      }
      const confirmedRow = confirmedOutgoing.find(c => (c.content || '').trim() === pContent);
      deleteOutboundMessageRows({ messageId: pending.id });
      emitOutboundCleanupResolved(threadId, pending, confirmedRow);
      deletedCount++;
      continue;
    }
    if (pending.attachment_id || (pending.media_type && pending.media_type !== 'text')) {
      const pTime = Number(pending.timestamp_ms) || 0;
      const matchingMidMedia = confirmedOutgoing.find(c =>
        c.media_type !== 'text' && pTime > 0 && Number(c.timestamp_ms) > 0 && Math.abs(pTime - Number(c.timestamp_ms)) <= 120000
      );
      if (matchingMidMedia) {
        deleteOutboundMessageRows({ messageId: pending.id });
        emitOutboundCleanupResolved(threadId, pending, matchingMidMedia);
        deletedCount++;
      }
    }
  }
  return deletedCount;
}

async function sendViaExtension(thread_id, text, client_message_id = null) {
  // Tìm account_id của thread
  const thread = db.prepare(
    'SELECT account_id, contact_name, thread_url FROM threads WHERE id = ?'
  ).get(thread_id);
  if (!thread) throw new Error(`Thread ${thread_id} không tồn tại`);

  // Match the stable project behaviour: a sleeping MV3 worker is allowed time
  // to reconnect, but a send operation must never restart its Chrome profile.
  let extWs = extensionConnections.get(thread.account_id);
  if (!extWs || extWs.readyState !== WebSocket.OPEN) {
    const startWait = Date.now();
    while ((!extWs || extWs.readyState !== WebSocket.OPEN) && Date.now() - startWait < 8000) {
      await new Promise(resolve => setTimeout(resolve, 500));
      extWs = extensionConnections.get(thread.account_id);
    }
  }
  if (!extWs || extWs.readyState !== WebSocket.OPEN) {
    throw new Error(`Extension cho tài khoản ${thread.account_id} không kết nối`);
  }

  // Route Page threads through the already-built queue pipeline (feature 009:
  // message_queue -> QueueWorker -> SEND_QUEUED_MESSAGE -> handleSendPageMessage,
  // CDP into Business Suite) instead of the generic personal-messenger dispatch
  // below. Personal threads (or any thread with no resolvable page source) keep
  // the exact existing behavior (feature 015).
  const { sourceType } = ConversationRepository.getThreadSource(thread_id);
  const isPageThread = sourceType === 'page_messenger';

  let clientMsgId;
  let queueId = null;
  if (isPageThread) {
    // client_message_id MUST match what handleSendQueuedMessage independently
    // derives ('queue_' + queue_id) so the existing SEND_MESSAGE_RESULT
    // correlation below finds this pending row - never the caller-supplied id.
    queueId = MessageQueueRepository.insert({ thread_id, account_id: thread.account_id, content: text });
    clientMsgId = `queue_${queueId}`;
  } else {
    clientMsgId = client_message_id || `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }
  const pendingFbId = `pending_${clientMsgId}`;
  const trace = (stage, extra = {}) => console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage, thread_id: String(thread_id), client_message_id: clientMsgId, route: isPageThread ? 'page_queue' : 'direct_extension', at: new Date().toISOString(), ...extra }));
  trace('BACKEND_SEND_REQUEST', queueId ? { queue_id: queueId } : {});

  const maxSeqRow = db.prepare('SELECT MAX(COALESCE(sequence_order, id)) AS max_seq FROM messages WHERE thread_id = ?').get(thread_id);
  const nextSeq = (Number.isFinite(Number(maxSeqRow?.max_seq)) && Number(maxSeqRow.max_seq) > 0) ? Number(maxSeqRow.max_seq) + 1 : 1;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Lưu tin nhắn outgoing dạng pending vào CSDL với timestamp và sequence_order chuẩn xác
  const result = db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status, sequence_order, timestamp_ms, timestamp_source, created_at)
    VALUES (?, ?, ?, 'SYSTEM', ?, 1, 'pending', ?, ?, 'client_submit', ?)
  `).run(thread_id, pendingFbId, clientMsgId, text, nextSeq, nowMs, nowIso);
  trace('BACKEND_PENDING_CREATED', { row_id: result.lastInsertRowid, sequence_order: nextSeq, timestamp_ms: nowMs });

  db.prepare(`
    UPDATE threads SET last_message = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?
  `).run(text, thread_id);

  if (isPageThread) {
    // QueueWorker (already running) picks this up and dispatches SEND_QUEUED_MESSAGE.
    trace('BACKEND_QUEUED_FOR_PAGE_SEND');
  } else {
    // Persist trước khi dispatch để DOM/network confirmation không chạy vào race
    // window và luôn tìm thấy bản ghi pending để ghép đúng client_message_id.
    extWs.send(JSON.stringify({
      type: 'SEND_MESSAGE',
      data: {
        account_id: thread.account_id,
        thread_id,
        thread_url: thread.thread_url || null,
        expected_contact_name: thread.contact_name || null,
        content: text,
        client_message_id: clientMsgId,
      }
    }));
    trace('BACKEND_DISPATCHED_EXTENSION');

    // Never leave the CRM bubble pending forever when an extension handler
    // stalls before returning SEND_MESSAGE_RESULT.
    setTimeout(() => {
      const pending = db.prepare(`
        SELECT id FROM messages
        WHERE client_message_id = ? AND delivery_status = 'pending'
      `).get(clientMsgId);
      if (!pending) return;
      const timeoutError = 'Extension không xác nhận kết quả gửi trong 30 giây';
      deleteOutboundMessageRows({ messageId: pending.id });
      io.emit('MESSAGE_SEND_FAILED', {
        thread_id,
        client_message_id: clientMsgId,
        success: false,
        status: 'failed',
        error: timeoutError,
        error_code: 'EXTENSION_ACK_TIMEOUT'
      });
    }, 30000);
  }

  io.emit('NEW_MESSAGE', {
    id: result.lastInsertRowid,
    thread_id,
    content: text,
    is_outgoing: true,
    status: 'pending',
    created_at: new Date().toISOString(),
    client_message_id: clientMsgId,
    // Feature 021: for Page threads, clientMsgId above is 'queue_' + queueId,
    // NOT the id the CRM's own optimistic local bubble was created with
    // (background.js/handleSendQueuedMessage independently re-derives that
    // same 'queue_' id later, so it can't be changed - see this feature's
    // spec). Carrying the original id lets the frontend reconcile its local
    // bubble to the server's id instead of rendering a second, orphaned one.
    original_client_message_id: client_message_id || clientMsgId
  });
}


function enqueueCampaignMessage({ campaign, recipient, attempt, content, attachment = null, manifest = null }) {
  const route = CampaignEligibilityService.revalidateSnapshotRecipient(recipient, db, {
    getConnection: (accId) => extensionConnections.get(accId),
    hasAttachment: Boolean(attachment) || Boolean(manifest),
    // A manifest (several files, or one folder ZIP) is always gated as a
    // file transport, regardless of any individual member's own media_type -
    // sending more than one attachment, or an archive, is a file-transport
    // operation even if one of the files happens to be an image.
    attachmentMediaType: manifest ? 'file' : (attachment?.media_type || null)
  });
  const effectiveSourceType = route.source_type;
  const effectiveSourceId = route.source_id;
  const pageId = effectiveSourceType === "page_messenger" ? route.source_external_id : null;

  const config = CampaignService.getConfig();
  if (config.testMode && effectiveSourceId && !config.testSourceIds.includes(String(effectiveSourceId))) {
    const error = new Error('Source không nằm trong CAMPAIGN_TEST_SOURCE_IDS');
    error.code = 'SOURCE_UNAVAILABLE';
    throw error;
  }
  if (CampaignRepository.countAccountSentToday(recipient.account_id, db, { excludeAttemptId: attempt?.id }) >= config.accountDailyCap) {
    const error = new Error("Tài khoản đã đạt giới hạn gửi trong ngày");
    error.code = "SEND_LIMIT_REACHED";
    throw error;
  }

  const { queueId, clientMessageId, messageId } = MessageQueueRepository.insertCampaignDispatch({
    thread_id: recipient.thread_id,
    account_id: recipient.account_id,
    source_id: effectiveSourceId,
    source_type: effectiveSourceType,
    page_id: pageId,
    content,
    attachment_id: attachment?.id || null,
    attachment_path: attachment?.storage_path || null,
    attachment_mime_type: attachment?.mime_type || null,
    attachment_name: attachment?.original_name || null,
    attachment_media_type: attachment?.media_type || null,
    attachment_byte_size: attachment?.byte_size || null,
    attachment_checksum: attachment?.checksum || null,
    manifest_id: manifest?.id || null,
    campaign_id: campaign.id,
    campaign_recipient_id: recipient.id,
    campaign_attempt_id: attempt.id,
    idempotency_key: attempt.idempotency_key
  }, db);
  io.emit("NEW_MESSAGE", {
    id: messageId,
    thread_id: recipient.thread_id,
    content,
    is_outgoing: true,
    status: "pending",
    created_at: new Date().toISOString(),
    client_message_id: clientMessageId,
    original_client_message_id: clientMessageId,
    campaign_id: campaign.id,
    campaign_recipient_id: recipient.id
  });
  return { queueId, clientMessageId };
}

function updateQueueStatusFromClientMessage(clientMessageId, status, errorReason = null) {
  if (typeof clientMessageId !== 'string' || !clientMessageId.startsWith('queue_')) return false;
  const queueId = clientMessageId.slice('queue_'.length);
  if (!queueId) return false;
  return MessageQueueRepository.updateStatus(queueId, status, errorReason);
}

function ensureThreadRecord({ threadId, accountId, contactName, pageId, initialLastMessage = 'Chưa có tin nhắn' }, database = db) {
  if (!threadId) return null;
  const tid = String(threadId);
  let existing = database.prepare('SELECT id, contact_name, source_id, account_id FROM threads WHERE id = ?').get(tid);
  if (!existing) {
    const cleanName = (contactName && !isInvalidContactName(contactName)) ? cleanContactName(contactName) : 'Khách hàng';
    ConversationRepository.upsertThread({
      id: tid,
      account_id: accountId,
      contact_name: cleanName,
      last_message: initialLastMessage,
      is_unread: 0,
      inbox_folder: 'INBOX'
    }, database);
    existing = database.prepare('SELECT id, contact_name, source_id, account_id FROM threads WHERE id = ?').get(tid);
    console.log(`[ensureThreadRecord] ✅ Tự động tạo bản ghi thread: ${tid} (account=${accountId}, name="${cleanName}")`);

    if (io) {
      io.emit('THREAD_CREATED', {
        thread_id: tid,
        account_id: accountId,
        source_id: pageId ? ('src_page_' + pageId) : null,
        contact_name: cleanName
      });
    }
  }
  if (pageId) {
    try {
      InboxSourceService.ensurePageSource({
        pageId: String(pageId),
        accountId: accountId || existing?.account_id,
        threadId: tid
      }, database);
    } catch (e) {
      console.warn('[ensureThreadRecord] ensurePageSource error:', e.message);
    }
  }
  return existing;
}

// ────────────────────────────────────────────────
// Extension WebSocket Handler
// ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] Extension connected from:', req.socket.remoteAddress);
  ws.lastHeartbeatAt = Date.now();

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[WS] 📨 Nhận message:', msg.type, '| WS ID:', req.socket.remoteAddress);

      switch (msg.type) {
        case 'HEARTBEAT':
          // WebSocket traffic keeps the Manifest V3 worker alive. Do not log
          // or trigger sync work for this lightweight liveness frame.
          ws.lastHeartbeatAt = Date.now();
          break;

        case 'COMMAND_PROBE_ACK': {
          // Phase C (2026-10-01): extension tra loi probe cua watchdog kenh
          // dispatch - kenh song 2 chieu, huy bo viec dong socket.
          const ackProbeId = String(msg.data?.probe_id || '');
          const ackProbe = pendingDispatchProbes.get(ackProbeId);
          if (ackProbe) {
            clearTimeout(ackProbe.timer);
            pendingDispatchProbes.delete(ackProbeId);
            dispatchStallWatchdog.noteProbeAck(ackProbe.account_id);
            console.log(`[WS] COMMAND_PROBE_ACK account=${ackProbe.account_id} probe=${ackProbeId} - dispatch channel alive`);
          }
          break;
        }

        case 'REGISTER_ACCOUNT': {
          const { account_id, name, pending_key, avatar_url } = msg.data;
          // Facebook sets c_user=0 as a placeholder while a page is mid-login;
          // extension-side already guards this (content.js sanitizeUserId), but
          // reject it here too so a stale/unpatched extension can never create
          // a bogus "FB Account (0)" row.
          if (!account_id || String(account_id).trim() === '0') {
            console.warn(`[WS] Bỏ qua REGISTER_ACCOUNT với account_id không hợp lệ: ${JSON.stringify(account_id)}`);
            break;
          }
          let ownerUserId = pending_key ? pendingAccountOwners.get(String(pending_key)) : null;
          if (pending_key && !ownerUserId) ownerUserId = markerOwnerUserId(pending_key);
          // Set when a removed account is re-added during an active add-account
          // session: the Chrome hosting this extension actually lives in that
          // pending profile, so registration must adopt it (see profileDir
          // resolution and post-insert cleanup below).
          let readdPendingKey = null;
          const removedAccount = db.prepare(
            'SELECT account_id FROM removed_accounts WHERE account_id = ?'
          ).get(String(account_id));
          if (removedAccount && !pending_key) {
            const activePendingKey = [...processManager.processes.entries()]
              .find(([key, proc]) => key.startsWith('pending_') && proc?.status === 'RUNNING')?.[0];
            if (activePendingKey) {
              // The operator deleted this account and is adding it back right
              // now. The fresh setup Chrome registers as soon as it sees the
              // login cookie - its storage may not carry the pending-key
              // capture (redirect timing), so this REGISTER arrives without
              // one. Rejecting here closed the socket and looped forever
              // while the UI waited on "Đang chờ đăng nhập Facebook..."
              // (reproduced 2026-09-17). Adopt the session instead: re-add
              // with the session owner and its pending profile dir.
              db.prepare('DELETE FROM removed_accounts WHERE account_id = ?').run(String(account_id));
              ownerUserId = pendingAccountOwners.get(activePendingKey) || markerOwnerUserId(activePendingKey) || ownerUserId;
              readdPendingKey = activePendingKey;
              console.log(`[WS] REGISTER_ACCOUNT: nhận lại tài khoản đã xóa ${account_id} trong phiên thêm mới ${activePendingKey}`);
            } else {
              console.warn(`[WS] Từ chối stale REGISTER_ACCOUNT của tài khoản đã xóa: ${account_id}`);
              ws.close(1000, 'ACCOUNT_REMOVED');
              break;
            }
          }
          if (pending_key) {
            db.prepare('DELETE FROM removed_accounts WHERE account_id = ?').run(String(account_id));
          }
          ws.lastRegisterAt = Date.now();
          const previousExtension = extensionConnections.get(account_id);
          // 2026-10-01 (Phase A - ke hoach ws-socket-adoption): LUON nhan socket
          // moi nhat. Truoc day socket moi bi tu choi khi socket cu van "OPEN"
          // phia server - nhung socket cu co the la zombie half-open sau khi
          // Chrome bi kill trong force-reload: close event khong bao gio den thi
          // readyState van OPEN mai -> server giu socket ma, ban
          // SYNC_THREAD_MESSAGES vao cho khong (reproduce 2026-10-01: 252
          // DISPATCHED / 0 THREAD_MESSAGES_SYNCED / SW console khong thay mot
          // log xu ly sync nao trong khi chieu nguoc van chay binh thuong).
          // Extension ngay nay chi co DUNG MOT WebSocket cho ca ca nhan + page
          // (page danh dau qua PAGE_CONTEXT_READY tren cung socket) nen khong
          // con kich ban nao can giu socket cu. Close cua socket cu den tre
          // cung khong xoa nham socket moi - close-handler co guard
          // `extensionConnections.get(ws.accountId) !== ws` (return som).
          if (previousExtension && previousExtension !== ws) {
            if (previousExtension.readyState === WebSocket.OPEN) {
              console.log(`[WS] REGISTER account=${account_id} socket replaced (previous still OPEN - zombie/superseded)`);
            } else {
              console.log(`[WS] REGISTER account=${account_id} socket replaced (previous was ${previousExtension.readyState})`);
            }
            try { previousExtension.close(1000, 'SUPERSEDED_CONNECTION'); } catch (_) {}
          }
          extensionConnections.set(account_id, ws);
          const isSameConnection = previousExtension === ws;
          ws.lastHeartbeatAt = Date.now();
          // Phase C (2026-10-01): socket moi = kenh tin cay moi, reset watchdog.
          dispatchStallWatchdog.noteRegistered(String(account_id));
          // A pending account is still inside Facebook's interactive login /
          // encrypted-history PIN setup. Do not start background sidebar
          // polling until the operator finishes setup and reconnects it as an
          // existing account (REGISTER_ACCOUNT without pending_key).
          if (!pending_key) {
            if (!isSameConnection || !InboxSyncScheduler.accounts.has(String(account_id))) {
              InboxSyncScheduler.registerAccount(account_id);
            }
          } else {
            newAccountBootstrapSyncs.set(String(account_id), { awaitingSetup: true, attempt: 0, timer: null });
          }
          // Only arm the replay-suppression window on a genuinely NEW socket.
          // Content scripts re-extract tokens (with rotating avatar CDN query
          // params) and re-register every few seconds on the SAME connection;
          // resetting the window each time kept the suppress gate permanently
          // active, silently eating outgoing confirmation echoes (measured
          // 2026-09-30: REGISTER_ACCOUNT every ~3s, 3000+ in one session).
          if (!isSameConnection) domReplaySuppressUntil.set(account_id, Date.now() + 8000);
          ws.accountId = account_id;

          // profileDir: use pending_key path (new account setup), or keep existing from DB,
          // or fallback to data/profiles/{account_id}.
          let profileDir = null;
          if (pending_key) {
            // New account just logged in via pending Chrome session
            profileDir = path.join(APP_DATA_ROOT, 'profiles', pending_key);
            if (processManager.processes.has(pending_key)) {
              const procData = processManager.processes.get(pending_key);
              processManager.promotePendingProcess(pending_key, account_id);
              profileDir = procData.profileDir || profileDir;
            }
          } else if (readdPendingKey) {
            // Re-add during an active session: same pending-Chrome adoption,
            // without the pending-key capture in the extension's storage.
            profileDir = path.join(APP_DATA_ROOT, 'profiles', readdPendingKey);
            if (processManager.processes.has(readdPendingKey)) {
              const procData = processManager.processes.get(readdPendingKey);
              processManager.promotePendingProcess(readdPendingKey, account_id);
              profileDir = procData.profileDir || profileDir;
            }
          } else {
            // Reconnect of an existing account - preserve whatever profile_dir is already in DB.
            // Only fall back to the default path if account is truly new (not in DB yet).
            const existingAcc = db.prepare('SELECT profile_dir FROM accounts WHERE id = ?').get(account_id);
            profileDir = existingAcc?.profile_dir || `data/profiles/${account_id}`;
          }

          const accName = name || `FB Account (${account_id})`;
          let accountAvatarFilename = null;
          if (typeof avatar_url === 'string' && avatar_url.startsWith('http')) {
            const cachedAccountAvatar = await saveAvatarFromBase64OrUrl(avatar_url, `account_${account_id}`);
            accountAvatarFilename = cachedAccountAvatar ? `/api/avatars/${cachedAccountAvatar}` : null;
          }

          db.prepare(`
            INSERT INTO accounts (id, name, profile_dir, status, owner_user_id, company_id, avatar_url)
            VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = COALESCE(excluded.name, accounts.name),
              profile_dir = CASE
                WHEN excluded.profile_dir LIKE '%/pending_%' THEN excluded.profile_dir
                ELSE COALESCE(accounts.profile_dir, excluded.profile_dir)
              END,
              status = 'ACTIVE',
              owner_user_id = COALESCE(excluded.owner_user_id, accounts.owner_user_id),
              company_id = COALESCE(excluded.company_id, accounts.company_id),
              avatar_url = COALESCE(excluded.avatar_url, accounts.avatar_url),
              last_broadcast_date = DATE('now')
          `).run(account_id, accName, profileDir, ownerUserId || null,
            ownerUserId ? db.prepare('SELECT company_id FROM users WHERE id=?').get(ownerUserId)?.company_id || ownerUserId : null,
            accountAvatarFilename);
          if (pending_key || readdPendingKey) {
            const setupKey = String(pending_key || readdPendingKey);
            completedPendingSetups.set(setupKey, { account_id: String(account_id), completed_at: Date.now() });
            pendingAccountOwners.delete(setupKey);
            try {
              fs.unlinkSync(path.join(APP_DATA_ROOT, 'profiles', setupKey, '.crm-pending-owner.json'));
            } catch (_) {}
          }

          console.log(`[WS] REGISTER_ACCOUNT thành công: account_id=${account_id}, profile_dir=${profileDir}`);
          try {
            InboxSourceService.createPersonalSource(account_id, accName, db);
          } catch (_) {}
          // Nguon personal hien ten + avatar that cua tai khoan (thay "FB Account (<id>)").
          try {
            db.prepare("UPDATE inbox_sources SET display_name = COALESCE(NULLIF(?, ''), display_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
              .run(accName, accountAvatarFilename, 'src_personal_' + account_id);
          } catch (_) {}
          io.emit('ACCOUNT_STATUS_CHANGED', { account_id, status: 'ACTIVE', avatar_url: accountAvatarFilename, pending_key: pending_key || readdPendingKey || null, name: accName });
          io.emit('INBOX_SOURCE_ADDED', { id: 'src_personal_' + account_id, source_type: 'personal_messenger', display_name: accName });
          io.emit('EXTENSION_CONNECTION_CHANGED', { account_id, is_connected: true });

          const backgroundRequestedAt = backgroundAfterConnectRequests.get(String(account_id));
          const backgroundRequestIsFresh = Number.isFinite(backgroundRequestedAt)
            && Date.now() - backgroundRequestedAt < 120000;
          if (!pending_key && backgroundRequestIsFresh && !KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE) {
            backgroundAfterConnectRequests.delete(String(account_id));
            if (backgroundAfterConnectTimers.has(String(account_id))) {
              clearTimeout(backgroundAfterConnectTimers.get(String(account_id)));
              backgroundAfterConnectTimers.delete(String(account_id));
            }
            const hideResult = await processManager.hideAccountProcess(account_id);
            if (hideResult?.success) {
              io.emit('ACCOUNT_DISPLAY_CHANGED', {
                account_id: String(account_id),
                chrome_display_mode: 'BACKGROUND',
                is_chrome_running: true
              });
            }
            console.log(`[BACKGROUND_SYNC] account=${account_id} hidden_immediately=true success=${!!hideResult?.success}`);
          }

          // Gửi ACK về Extension xác nhận đăng ký thành công
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'REGISTER_ACCOUNT_ACK',
              data: { account_id, status: 'SUCCESS', pending_key }
            }));
            if (!pending_key && !InboxSyncScheduler.isSyncWindowActive(account_id)) {
              // Profiles upgraded from older releases can still contain the two
              // dedicated polling tabs. Close them on registration while the
              // new opt-in sync window is off.
              ws.send(JSON.stringify({
                type: 'SET_SIDEBAR_SYNC_WINDOW',
                data: { account_id, enabled: false, reason: 'register_idle' }
              }));
            }
            const bootstrapState = newAccountBootstrapSyncs.get(String(account_id));
            if (!pending_key && bootstrapState?.awaitingSetup) {
              newAccountBootstrapSyncs.delete(String(account_id));
              scheduleNewAccountBootstrapSync(account_id);
            }
          }

          // Giao viec lay profile cho cac Page con ten generic / chua co
          // avatar - extension se mo tab profile Page va tra ket qua qua
          // UPDATE_PAGE_PROFILE. Cooldown 30 phut/page: khong mo lai tab
          // profile moi lan extension reconnect (moi lan reconnect truoc day
          // sinh them ca loat tab cho cung cac Page khong bao gio resolve).
          try {
            const pagesNeedProfile = db.prepare(`
              SELECT external_id FROM inbox_sources
              WHERE source_type = 'page_messenger' AND owner_account_id = ?
                AND (avatar_url IS NULL OR display_name = 'Page ' || external_id)
                AND external_id NOT GLOB '615[5-9]??????????'
            `).all(String(account_id));
            const now = Date.now();
            const pageIds = pagesNeedProfile.map((r) => String(r.external_id)).filter((id) => /^\d+$/.test(id))
              .filter((id) => now - (pageProfileFetchLastRequestedAt.get(id) || 0) > 30 * 60 * 1000);
            if (pageIds.length && ws.readyState === WebSocket.OPEN) {
              for (const id of pageIds) pageProfileFetchLastRequestedAt.set(id, now);
              ws.send(JSON.stringify({ type: 'FETCH_PAGE_PROFILES', data: { page_ids: pageIds } }));
              console.log(`[PAGE_SOURCE] Giao lay profile cho ${pageIds.length} Page:`, pageIds.join(','));
            }
          } catch (_) {}

          // InboxSyncScheduler.registerAccount() already starts the lightweight
          // background inbox loop. Do not dispatch a second full SYNC_THREADS
          // crawl here: it competes with realtime receive and manual sends.
          if (process.env.FB_CRM_DISABLE_INITIAL_SWEEP !== '1') {
            setTimeout(() => InitialMessageSweepService.start(account_id), 1500);
          }
          break;
        }

        case 'SEND_MESSAGE_RESULT': {
          const { thread_id, client_message_id, success, error, error_code, message_id, result: fbRes } = msg.data;
          const officialFbId = message_id || fbRes?.o0?.data?.message?.message_id || fbRes?.o0?.data?.message_id || fbRes?.data?.message_id;
          const resultQueueId = typeof client_message_id === 'string' && client_message_id.startsWith('queue_')
            ? client_message_id.slice('queue_'.length)
            : null;
          const richQueueResult = resultQueueId
            ? db.prepare('SELECT outbound_attempt_id, campaign_id FROM message_queue WHERE id = ?').get(resultQueueId)
            : null;
          if (richQueueResult?.outbound_attempt_id) {
            // Rich-message delivery is driven by QUEUED_MESSAGE_RESULT plus
            // bounded Facebook observation, never by this legacy result path.
            break;
          }

          // Campaign sends are owned by QUEUED_MESSAGE_RESULT. handleSendMessage
          // also emits this legacy result while probing the rendered bubble;
          // that probe can be negative after the composer already dispatched.
          // Keep the pending row so the later DOM observation can correlate it.
          if (richQueueResult?.campaign_id && !success && error_code !== 'COMPOSER_DISPATCHED') {
            console.log(`[WS] Ignoring non-authoritative SEND_MESSAGE_RESULT failure for campaign queue ${resultQueueId}`);
            console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'CAMPAIGN_LEGACY_FAILURE_IGNORED', thread_id: String(thread_id), client_message_id, queue_id: resultQueueId, error_code: error_code || null, at: new Date().toISOString() }));
            break;
          }
          
          console.log(`[WS] SEND_MESSAGE_RESULT: thread=${thread_id} client_msg_id=${client_message_id} success=${success} fb_msg_id=${officialFbId}`);
          console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_RESULT_RECEIVED', thread_id: String(thread_id), client_message_id, success: !!success, official_fb_id: !!officialFbId, error_code: error_code || null, error: error || null, at: new Date().toISOString() }));
          
          if (success && officialFbId) {
            db.prepare(`
              UPDATE messages 
              SET fb_message_id = ?, delivery_status = 'sent', delivery_error = NULL
              WHERE client_message_id = ? OR fb_message_id = ?
            `).run(officialFbId, client_message_id, `pending_${client_message_id}`);
            updateQueueStatusFromClientMessage(client_message_id, 'sent');

            io.emit('MESSAGE_SENT', { thread_id, client_message_id, success: true, fb_message_id: officialFbId, status: 'sent' });
          } else if (error_code === 'COMPOSER_DISPATCHED') {
            // Check if DOM/network confirmation already arrived before this result
            const existingRow = db.prepare(`SELECT id, fb_message_id, media_type, delivery_status, delivery_error FROM messages WHERE client_message_id = ? OR fb_message_id = ?`).get(client_message_id, `pending_${client_message_id}`);
            if (existingRow && existingRow.delivery_status === 'sent') {
              console.log(`[WS] COMPOSER_DISPATCHED arrived but row already sent for ${client_message_id}. No-op.`);
              updateQueueStatusFromClientMessage(client_message_id, 'sent');
              io.emit('MESSAGE_SENT', { thread_id, client_message_id, status: 'sent' });
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DISPATCHED_ALREADY_SENT', thread_id: String(thread_id), client_message_id, at: new Date().toISOString() }));
            } else if (existingRow && existingRow.delivery_status === 'failed') {
              console.log(`[WS] COMPOSER_DISPATCHED arrived but row already failed for ${client_message_id}. No-op.`);
              const failError = existingRow.delivery_error || 'Previously failed';
              io.emit('MESSAGE_SEND_FAILED', { thread_id, client_message_id, success: false, status: 'failed', error: failError });
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DISPATCHED_ALREADY_FAILED', thread_id: String(thread_id), client_message_id, at: new Date().toISOString() }));
            } else {
              console.log(`[WS] Composer đã dispatch tin; giữ pending chờ DOM/network confirmation: ${client_message_id}`);
              // A cleared text composer is a successful transport hand-off.
              // Persist the provisional sent state so the independent 30s ACK
              // watchdog cannot turn a real Messenger send into "Retry". The
              // late DOM observer still upgrades pending_* to the official mid.
              if (existingRow?.id) {
                db.prepare(`
                  UPDATE messages SET delivery_status = 'sent', delivery_error = NULL
                  WHERE id = ? AND is_outgoing = 1
                    AND attachment_id IS NULL
                    AND (media_type IS NULL OR media_type = 'text')
                `).run(existingRow.id);
                updateQueueStatusFromClientMessage(client_message_id, 'sent');
              }
              io.emit('MESSAGE_SENT', {
                thread_id,
                client_message_id,
                status: 'sent',
                provisional: true
              });
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_CONFIRMATION_GRACE', thread_id: String(thread_id), client_message_id, at: new Date().toISOString() }));
            }
          } else {
            // A composer dispatch can be acknowledged provisionally before the
            // rendered-bubble probe finishes. A late probe may time out although
            // Messenger already accepted the message. Never downgrade a sent row.
            const alreadySentRow = db.prepare(`
              SELECT id, fb_message_id, delivery_status
              FROM messages
              WHERE client_message_id = ? OR fb_message_id = ?
              ORDER BY id DESC
              LIMIT 1
            `).get(client_message_id, `pending_${client_message_id}`);
            if (alreadySentRow && ['sent', 'delivered', 'read'].includes(String(alreadySentRow.delivery_status || '').toLowerCase())) {
              console.log(`[WS] Ignoring late SEND_MESSAGE_RESULT failure for already-sent message ${client_message_id}`);
              updateQueueStatusFromClientMessage(client_message_id, 'sent');
              io.emit('MESSAGE_SENT', {
                thread_id,
                client_message_id,
                fb_message_id: alreadySentRow.fb_message_id || undefined,
                status: 'sent'
              });
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_LATE_FAILURE_IGNORED', thread_id: String(thread_id), client_message_id, error_code: error_code || null, at: new Date().toISOString() }));
              break;
            }
            console.error('[WS] ❌ SEND_MESSAGE_RESULT failed or missing fb_msg_id:', {
              thread_id,
              client_message_id,
              success,
              error,
              fbRes: JSON.stringify(fbRes)?.substring(0, 500)
            });

            const failureText = error || 'Facebook không xác nhận message_id';
            const canArriveLateFromComposer = /response rỗng|không nhận message_id|GraphQL/i.test(failureText);
            if (canArriveLateFromComposer) {
              // GraphQL có thể lỗi trước khi composer/DOM kịp xác nhận. Giữ pending
              // một grace window để event đến muộn vẫn ghép được đúng attempt.
              db.prepare(`
                UPDATE messages SET delivery_status = 'pending', delivery_error = ?
                WHERE (client_message_id = ? OR fb_message_id = ?) AND is_outgoing = 1
              `).run(failureText, client_message_id, `pending_${client_message_id}`);
              io.emit('MESSAGE_SEND_PENDING', { thread_id, client_message_id, status: 'pending', error: failureText, error_code: 'CONFIRMATION_GRACE' });
              setTimeout(() => {
                const stillPending = db.prepare(`SELECT id FROM messages WHERE client_message_id = ? AND delivery_status = 'pending'`).get(client_message_id);
                if (!stillPending) return;
              deleteOutboundMessageRows({ messageId: stillPending.id });
                io.emit('MESSAGE_SEND_FAILED', { thread_id, client_message_id, success: false, status: 'failed', error: failureText, error_code: error_code || 'CONFIRMATION_TIMEOUT' });
              }, 5000);
            } else {
              // Lỗi chắc chắn không thể gửi: giữ lịch sử nhưng chuyển failed ngay.
              db.prepare(`DELETE FROM messages
                WHERE (client_message_id = ? OR fb_message_id = ?) AND is_outgoing = 1
              `).run(client_message_id, `pending_${client_message_id}`);
              io.emit('MESSAGE_SEND_FAILED', { thread_id, client_message_id, success: false, status: 'failed', error: failureText, error_code });
            }
          }
          break;
        }

        case 'CONTENT_DEBUG': {
          // Temporary diagnostic sink for spec 040 T020 - page_content.js's
          // raw <img> inspection for a text+image message that didn't match
          // as media, relayed here since the extension's own console isn't
          // reachable during live debugging. Remove once T020 is closed.
          try {
            fs.appendFileSync(
              path.join(APP_DATA_ROOT, 'composer-debug.log'),
              JSON.stringify({ at: new Date().toISOString(), source: 'CONTENT_DEBUG', ...msg.data }) + '\n'
            );
          } catch (error) {
            console.error('[CONTENT_DEBUG] Ghi log thất bại:', error.message);
          }
          break;
        }

        case 'PAGE_SCROLLER_DEBUG': {
          const d = msg.data || {};
          if (d.stage === 'SCROLLER_FOUND') {
            console.log(`[PageScroller] 🎯 Đã tìm thấy khung chat Page: thread=${d.thread_id} | class="${d.class_name}" | height=${d.client_height}px / scrollHeight=${d.scroll_height}px | scrollTop ban đầu=${d.scroll_top}px`);
          } else if (d.stage === 'SCROLLED_TO_TOP') {
            console.log(`[PageScroller] 📜 Vòng ${d.round}: Đã cuộn dứt khoát lên đỉnh (0px) | scrollTop từ ${d.before_top}px -> ${d.after_top}px | scrollHeight=${d.scroll_height}px`);
          } else if (d.stage === 'DOM_SETTLED') {
            console.log(`[PageScroller] 🔄 Vòng ${d.round}: Facebook DOM settled | has_growth=${d.has_growth} | nạp thêm ${d.new_messages_count} tin mới | tổng tích lũy: ${d.total_accumulated} tin`);
          } else if (d.stage === 'SCROLLER_NOT_FOUND') {
            console.warn(`[PageScroller] ⚠️ Không tìm thấy khung cuộn tin nhắn hợp lệ trên trang Facebook cho thread=${d.thread_id}`);
          } else if (d.stage === 'TAB_DISCONNECTED') {
            console.warn(`[PageScroller] ⚠️ Tab Facebook bị mất kết nối (cần F5 lại tab Facebook): ${d.error}`);
          }
          break;
        }

        case 'COMPOSER_DEBUG': {
          // Temporary diagnostic sink for spec 040 T020 - the extension's
          // service worker console isn't reachable during live debugging, so
          // typeAndSubmitComposer relays its composer/send-button selection
          // here instead. Appended as one JSON line per event; remove once
          // T020 is confirmed fixed by a live send.
          try {
            fs.appendFileSync(
              path.join(APP_DATA_ROOT, 'composer-debug.log'),
              JSON.stringify({ at: new Date().toISOString(), ...msg.data }) + '\n'
            );
          } catch (error) {
            console.error('[COMPOSER_DEBUG] Ghi log thất bại:', error.message);
          }
          break;
        }

        case 'CHECKPOINT_DETECTED': {
          const { account_id } = msg.data;
          db.prepare("UPDATE accounts SET status='CHECKPOINT' WHERE id=?").run(account_id);
          const unhideRes = await processManager.unhideWindow(account_id);
          if (unhideRes?.success) {
            io.emit('ACCOUNT_DISPLAY_CHANGED', {
              account_id: String(account_id),
              chrome_display_mode: 'VISIBLE',
              is_chrome_running: true
            });
          }
          io.emit('ACCOUNT_STATUS_CHANGED', { account_id, status: 'CHECKPOINT' });
          break;
        }

        case 'THREAD_METADATA_UPDATED': {
          const { account_id, thread_id, contact_name, avatar_url, page_id, profile_url } = msg.data || {};
          const tidStr = String(thread_id || '');
          if (!tidStr) break;

          const targetAccountId = account_id || ws.accountId;
          ensureThreadRecord({
            threadId: tidStr,
            accountId: targetAccountId,
            contactName: contact_name,
            pageId: page_id
          }, db);

          let updatedName = null;
          let localAvatarPath = null;
          let updatedProfileUrl = null;

          if (contact_name && !isInvalidContactName(contact_name)) {
            const existingThread = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(tidStr);
            const otherThreadWithSameName = db.prepare('SELECT id FROM threads WHERE account_id = ? AND id != ? AND contact_name = ?').get(targetAccountId, tidStr, contact_name.trim());
            if (existingThread?.contact_name && !isInvalidContactName(existingThread.contact_name) && existingThread.contact_name !== 'Khách hàng' && otherThreadWithSameName) {
              console.warn(`[WS] ⚠️ Chặn ghi đè tráo tên: thread ${tidStr} (${existingThread.contact_name}) không bị đổi thành "${contact_name}" của thread ${otherThreadWithSameName.id}`);
            } else {
              updatedName = contact_name.trim();
              db.prepare('UPDATE threads SET contact_name = ? WHERE id = ?').run(updatedName, tidStr);
              db.prepare(`
                INSERT INTO contacts (thread_id, name)
                VALUES (?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                  name = excluded.name
              `).run(tidStr, updatedName);
            }
          }

          if (profile_url && typeof profile_url === 'string' && profile_url.startsWith('http')) {
            updatedProfileUrl = profile_url.trim();
            db.prepare(`
              INSERT INTO contacts (thread_id, name, profile_url)
              VALUES (?, ?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET
                profile_url = excluded.profile_url
            `).run(tidStr, updatedName || 'Khách hàng', updatedProfileUrl);
          }

          if (avatar_url && avatar_url.startsWith('http')) {
            try {
              localAvatarPath = await saveAvatarFromBase64OrUrl(avatar_url, tidStr);
              if (localAvatarPath) {
                // Chống tráo avatar: Kiểm tra nếu avatar vừa tải về có hash trùng khớp
                // với avatar của một thread khác thuộc cùng account mà tên 2 thread khác nhau
                const duplicateOther = db.prepare(`
                  SELECT c.thread_id, c.name, c.avatar_url
                  FROM contacts c
                  JOIN threads t ON t.id = c.thread_id
                  WHERE t.account_id = ? AND c.thread_id != ? AND c.avatar_url IS NOT NULL
                `).all(targetAccountId, tidStr);

                let isSuspiciousSwap = false;
                const avatarDir = path.join(APP_DATA_ROOT, 'avatars');
                const currentFilePath = path.join(avatarDir, localAvatarPath);

                if (fs.existsSync(currentFilePath)) {
                  const currentHash = crypto.createHash('md5').update(fs.readFileSync(currentFilePath)).digest('hex');
                  for (const other of duplicateOther) {
                    if (other.name && updatedName && other.name.trim().toLowerCase() !== updatedName.trim().toLowerCase() && other.avatar_url) {
                      const otherFilePath = path.join(avatarDir, other.avatar_url);
                      if (fs.existsSync(otherFilePath)) {
                        const otherHash = crypto.createHash('md5').update(fs.readFileSync(otherFilePath)).digest('hex');
                        if (currentHash === otherHash) {
                          isSuspiciousSwap = true;
                          console.warn(`[WS] ⚠️ Chặn ghi đè tráo avatar: thread ${tidStr} (${updatedName}) bị trùng file avatar với thread ${other.thread_id} (${other.name}).`);
                          break;
                        }
                      }
                    }
                  }
                }

                if (!isSuspiciousSwap) {
                  db.prepare(`
                    INSERT INTO contacts (thread_id, name, avatar_url)
                    VALUES (?, ?, ?)
                    ON CONFLICT(thread_id) DO UPDATE SET
                      avatar_url = excluded.avatar_url
                  `).run(tidStr, updatedName || 'Khách hàng', localAvatarPath);
                } else {
                  localAvatarPath = null;
                }
              }
            } catch (e) {
              console.warn('[WS] Avatar save failed:', e.message);
            }
          }

          io.emit('CONTACT_UPDATED', {
            thread_id: tidStr,
            ...(updatedName ? { name: updatedName } : {}),
            ...(localAvatarPath ? { avatar_url: localAvatarPath } : {}),
            ...(updatedProfileUrl ? { profile_url: updatedProfileUrl } : {})
          });
          break;
        }

        case 'NEW_MESSAGE_RECEIVED': {
          const m = msg.data;
          const threadId = String(m.thread_id || '');
          let realtimeMessageEmittedEarly = false;

          const t_server = Date.now();
          if (m?.telemetry?.t_dom) {
            m.telemetry.t_server = t_server;
            const dDomToSw = m.telemetry.t_sw ? (m.telemetry.t_sw - m.telemetry.t_dom) : 0;
            const dSwToSrv = m.telemetry.t_sw ? (t_server - m.telemetry.t_sw) : (t_server - m.telemetry.t_dom);
            console.log(`[TELEMETRY] ⚡ Latency for ${m.fb_message_id || 'msg'}: dom->sw=${dDomToSw}ms, sw->server=${dSwToSrv}ms, total=${t_server - m.telemetry.t_dom}ms`);
          }

          console.log(`[WS] 📩 Nhận NEW_MESSAGE_RECEIVED | Source: ${m.source || 'unknown'} | Thread: ${threadId} | FB Message ID: ${m.fb_message_id} | Content: "${sanitizeLog(m.content, 80)}"`);
          const { isBlacklistedThreadId } = require('./utils/threadGuard');
          if (!threadId || threadId === 'unknown_dom' || threadId.trim() === '' || isBlacklistedThreadId(threadId)) {
            console.warn(`[WS] ⚠️ Bỏ qua tin nhắn từ Thread ID không hợp lệ hoặc blacklist: "${threadId}"`);
            break;
          }
          const _rawContentLower = (m.content || '').toLowerCase();
          const isCallLog = _rawContentLower.includes('cuộc gọi') || _rawContentLower.includes('bỏ lỡ') || _rawContentLower.includes('đã nhỡ') || _rawContentLower.includes('nhỡ cuộc') || _rawContentLower.includes('chat video')
            || _rawContentLower.includes('audio call') || _rawContentLower.includes('video call') || _rawContentLower.includes('missed call')
            || _rawContentLower.includes('missed audio') || _rawContentLower.includes('missed video') || _rawContentLower.includes('call ended')
            || (m.media_type === 'call');
          if (isCallLog) {
            console.log(`[CALL_DEBUG] 📞 Backend nhận CALL LOG từ Extension: content="${sanitizeLog(m.content)}", thread=${threadId}, fb_id=${m.fb_message_id}, isCallLog=true`);
          }
          if (!threadId || threadId === 'unknown_dom') {
            console.warn(`[WS] ⚠️ Bỏ qua tin nhắn từ Thread ID không hợp lệ: "${threadId}"`);
            break;
          }
          const targetAccountId = m.account_id || ws.accountId || null;
          const canonicalThreadId = resolveInternalThreadId(db, targetAccountId, threadId, m.page_id || null);
          if (!canonicalThreadId) {
            console.warn(`[WS] Bỏ qua tin nhắn chưa ánh xạ được thread: raw=${threadId} account=${targetAccountId || 'unknown'}`);
          }
          // Preserve Facebook's raw id for diagnostics, but use the CRM's
          // canonical id throughout the existing persistence/UI pipeline.
          m.external_thread_id = m.external_thread_id || threadId;
          m.thread_id = canonicalThreadId || threadId;

          if (isCallLog && m.content && m.fb_message_id) {
            const callThreadId = canonicalThreadId || m.thread_id;
            const threadAccRow = db.prepare('SELECT account_id FROM threads WHERE id = ?').get(callThreadId);
            const targetAccountIdForCall = m.account_id || ws.accountId || threadAccRow?.account_id || null;
            const normalizedCallContent = String(m.content || '').toLocaleLowerCase('vi-VN');
            const isExplicitMissedIncoming = /(?:nhỡ|bỏ lỡ|missed)/i.test(normalizedCallContent);
            const hasRawAvatarEvidence = m.direction_evidence === 'call_article_avatar'
              && (m.has_row_avatar === true || m.has_row_avatar === false);
            const callIsOutgoing = isExplicitMissedIncoming
              ? 0
              : hasRawAvatarEvidence
                ? (m.has_row_avatar ? 0 : 1)
                : ((m.is_outgoing === true || m.is_outgoing === 1) ? 1 : 0);
            ConversationRepository.upsertThread({
              id: callThreadId,
              account_id: targetAccountIdForCall,
              contact_name: m.contact_name || 'Khách hàng',
              last_message: m.content,
              is_unread: !callIsOutgoing
            });
            const stableCallId = m.fb_message_id;
            const callTimestamp = Number(m.timestamp_ms) || Date.parse(m.created_at || '') || Date.now();
            // History sync thường đã lưu đúng dòng cuộc gọi dưới mid thật
            // (media_type='text'). Fallback này cũng khớp dòng text cùng nội
            // dung (có thể kèm hậu tố " • N giây") để gộp thay vì tạo bong
            // bóng thứ hai; ưu tiên dòng mang mid thật.
            const existingCall = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(stableCallId)
              || db.prepare(`
                SELECT id FROM messages
                WHERE thread_id = ? AND media_type IN ('call', 'text')
                  AND (content = ? OR content LIKE ? || ' • %' OR ? LIKE content || ' • %')
                  AND ABS(COALESCE(NULLIF(timestamp_ms, 0), ?) - ?) <= 60000
                ORDER BY CASE WHEN fb_message_id LIKE 'mid.%' THEN 0 ELSE 1 END, id DESC LIMIT 1
              `).get(callThreadId, m.content, m.content, m.content, callTimestamp, callTimestamp);
            const callSenderId = m.sender_id || (callIsOutgoing ? String(targetAccountIdForCall || 'STAFF') : 'CONTACT');
            console.log(`[CALL_DEBUG] 🧵 callThreadId=${callThreadId} | m.thread_id=${m.thread_id} | canonicalThreadId=${canonicalThreadId} | callIsOutgoing=${callIsOutgoing}`);
            if (!existingCall) {
              const insertCall = db.prepare(`
                INSERT OR IGNORE INTO messages
                  (thread_id, fb_message_id, sender_id, content, media_type, is_outgoing, direction_status, timestamp_ms, timestamp_source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                callThreadId, stableCallId,
                callSenderId,
                m.content, 'call', callIsOutgoing, 'confirmed',
                m.timestamp_ms || Date.now(),
                m.timestamp_source || 'realtime_fallback',
                m.created_at || new Date().toISOString()
              );
              if (insertCall.changes > 0) {
                console.log(`[CALL_DEBUG] ✅ Đã lưu call log vào DB: "${sanitizeLog(m.content)}" (id: ${stableCallId}) | thread: ${callThreadId} | is_outgoing: ${callIsOutgoing}`);
                const newMsg = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableCallId);
                if (newMsg) {
                  io.emit('NEW_MESSAGE', { ...newMsg, thread_id: callThreadId, account_id: targetAccountIdForCall });
                  io.emit('THREAD_MESSAGES_UPDATED', { thread_id: callThreadId, account_id: targetAccountIdForCall });
                }
              } else {
                // INSERT OR IGNORE bị ignore (trùng fb_message_id): patch media_type và is_outgoing nếu cần
                db.prepare(`UPDATE messages SET media_type = 'call', is_outgoing = ? WHERE fb_message_id = ?`).run(callIsOutgoing, stableCallId);
                const existingMsg = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableCallId);
                if (existingMsg) {
                  console.log(`[CALL_DEBUG] 🔄 Patch media_type='call' cho tin đã tồn tại: ${stableCallId}`);
                  io.emit('NEW_MESSAGE', { ...existingMsg, thread_id: callThreadId, account_id: targetAccountIdForCall });
                  io.emit('THREAD_MESSAGES_UPDATED', { thread_id: callThreadId, account_id: targetAccountIdForCall });
                }
              }
            } else {
              // existingCall tồn tại: patch media_type & is_outgoing rồi re-emit
              db.prepare(`UPDATE messages SET media_type = 'call', is_outgoing = ? WHERE id = ?`).run(callIsOutgoing, existingCall.id);
              const existingMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(existingCall.id);
              if (existingMsg) {
                console.log(`[CALL_DEBUG] 🔄 existingCall: patch + re-emit thread=${callThreadId}: ${stableCallId}`);
                io.emit('NEW_MESSAGE', { ...existingMsg, thread_id: callThreadId, account_id: targetAccountIdForCall });
                io.emit('THREAD_MESSAGES_UPDATED', { thread_id: callThreadId, account_id: targetAccountIdForCall });
              }
            }
            break;
          }


          const cleanedContent = cleanMessageText(m.content);
          const isDomObserverRow = m.source === 'dom_observer' || m.source === 'page_dom_observer';
          // Network interception is a fast path only. Facebook also returns
          // unrelated payload fragments with a `body` field; when those frames
          // have no actor or durable message id they look like an incoming
          // message and create the left-side ghost text after an operator send.
          // Let the DOM/history source handle such ambiguous frames instead.
          const isNetworkObserverRow = ['network_interceptor', 'websocket', 'mercury', 'network_xhr'].includes(String(m.source || ''));
          const networkMessageId = String(m.fb_message_id || '');
          const hasStableNetworkMessageId = networkMessageId.startsWith('mid.') || /(?:^|_)mid_/.test(networkMessageId);
          if (isNetworkObserverRow && (!m.sender_id || !hasStableNetworkMessageId)) {
            console.log(`[WS] Backend Guard: skip ambiguous network frame: source=${m.source} thread=${canonicalThreadId}`);
            break;
          }
          // A type alone is only a Messenger DOM shell. Treat media as real
          // only after its URL/path/attachment identity is available.
          const hasMediaPayload = !!(m.media_url || m.local_media_path || m.attachment_id);
          const isBareDomMediaShell = isDomObserverRow
            && String(m.fb_message_id || '').startsWith('dom_')
            && !hasMediaPayload
            && m.media_type && m.media_type !== 'text' && m.media_type !== 'call';
          if (isBareDomMediaShell) {
            console.log(`[WS] Backend Guard: skip unhydrated DOM media shell: ${sanitizeLog(cleanedContent, 60)}`);
            break;
          }

          // Before the junk/system-text guards below get a chance to drop this
          // event, check whether its RAW (pre-cleaning) text matches something
          // we ourselves are actively waiting to confirm in this exact thread.
          // cleanMessageText's final junk-pattern pass can null out a real
          // outgoing-confirmation scrape entirely (see the guard right below),
          // which used to leave an already-delivered send stuck at 'pending'
          // forever with zero trace, since the correlation logic further down
          // in this handler never got a chance to run once cleanedContent was
          // ''. Scoped tightly to that one failure mode - text-only DOM
          // observer events whose cleaning collapsed to nothing - so every
          // other event (the overwhelming majority) is unaffected.
          if (!hasMediaPayload && !cleanedContent && (m.source === 'dom_observer' || m.source === 'page_dom_observer')) {
            const rawContent = String(m.content || '').trim();
            if (rawContent) {
              const earlyInternalThreadId = canonicalThreadId;
              const pendingMatch = OutboundDomCorrelationService.matchPendingOutboundByRawContent(db, earlyInternalThreadId, rawContent);
              if (pendingMatch) {
                const confirmed = OutboundDomCorrelationService.confirmPendingOutbound(db, io, pendingMatch, {
                  fbMessageId: m.fb_message_id,
                  tsMs: m.timestamp_ms || 0,
                  tsSource: m.timestamp_source || 'unknown',
                  rawMessage: m
                });
                if (confirmed) {
                  console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_CORRELATED_EARLY', thread_id: String(earlyInternalThreadId), client_message_id: pendingMatch.client_message_id, at: new Date().toISOString() }));
                }
                break;
              }
            }
          }

          // Composer confirmations for attachment sends carry only the real
          // Facebook message id with EMPTY content - the file itself never
          // appears in the composer text. The junk guard below used to discard
          // that event, and with the DOM echo also suppressed during sync
          // windows the send got no confirmation at all: after 3 minutes the
          // attachment watchdog marked it failed and DELETED the CRM's own
          // bubble (reproduced 2026-09-30 - image + video sent from the
          // composer vanished minutes later, attachments stuck at
          // CONFIRMATION_TIMEOUT).
          if (m.source === 'composer_confirmation' && m.fb_message_id && !hasMediaPayload && !cleanedContent) {
            const pendingMedia = OutboundDomCorrelationService.matchPendingImageOutbound(db, canonicalThreadId, 'any');
            if (pendingMedia) {
              const confirmed = OutboundDomCorrelationService.confirmPendingOutbound(db, io, pendingMedia, {
                fbMessageId: m.fb_message_id,
                tsMs: m.timestamp_ms || 0,
                tsSource: m.timestamp_source || 'composer',
                rawMessage: m
              });
              console.log('[OUTBOUND_TRACE]', JSON.stringify({
                stage: confirmed ? 'BACKEND_COMPOSER_MEDIA_CONFIRMED' : 'BACKEND_COMPOSER_MEDIA_CONFIRM_CONFLICT',
                thread_id: String(canonicalThreadId),
                client_message_id: pendingMedia.client_message_id,
                fb_message_id: String(m.fb_message_id),
                at: new Date().toISOString()
              }));
            }
            break;
          }

          // Meta Page can inject this lead-activity notice repeatedly while a
          // thread reloads. It is never customer content, even when it arrives
          // without an FB message id, so reject it before persistence/capture.
// DOM rows often expose the sender heading as a standalone text node.
          // It is metadata, not a customer message; reject it before persistence.
          const knownContactName = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(canonicalThreadId)?.contact_name || '';
          const observedPersonLabels = [m.sender_name, m.contact_name, knownContactName]
            .map((value) => String(value || '').trim())
            .filter(Boolean);
          const normalizedObservedContent = String(cleanedContent || '').trim().toLocaleLowerCase('vi-VN');
          const senderLabelOnly = !hasMediaPayload
            && isDomObserverRow
            && normalizedObservedContent
            && observedPersonLabels.some((label) => normalizedObservedContent === label.toLocaleLowerCase('vi-VN'));
          if (senderLabelOnly) {
            console.log(`[WS] Backend Guard: bỏ qua tên người gửi bị parse thành nội dung: "${sanitizeLog(cleanedContent, 60)}"`);
            break;
          }
          if (!hasMediaPayload && isKnownPageSystemNotice(cleanedContent)) {
            console.log(`[WS] ℹ️ Backend Guard: Bỏ qua thông báo hệ thống Meta lặp lại từ thread ${threadId}`);
            break;
          }
          if (!hasMediaPayload && (!cleanedContent || isSystemOrMetadataText(cleanedContent))) {
            console.log(`[WS] ℹ️ Backend Guard: Bỏ qua tin nhắn rác/hệ thống: "${sanitizeLog(m.content, 40)}" từ thread ${threadId}`);
            break;
          }

          // Nếu raw content chứa chuỗi quá lớn (scrap rộng), reject ở backend
          if ((m.content || '').split('\n').length > 8 && isSystemOrMetadataText(m.content)) {
            console.log(`[WS] ℹ️ Backend Guard: Bỏ qua cụm text scrap rộng từ thread ${threadId}`);
            break;
          }

          m.content = cleanedContent;

          // 3. Fix backend fallback is_outgoing
          let finalIsOutgoing = 0;
          let threadAccountId = targetAccountId;

          // Lấy account_id của thread nếu có
          const existingThreadForAcct = db.prepare('SELECT account_id FROM threads WHERE id=?').get(threadId);
          if (existingThreadForAcct && existingThreadForAcct.account_id) {
            threadAccountId = existingThreadForAcct.account_id;
          }

          if (m.is_outgoing === true || m.is_outgoing === 1) {
            finalIsOutgoing = 1;
          } else if (m.sender_name === 'Bạn' || m.sender_name === 'BÃ¡ÂºÂ¡n') {
            finalIsOutgoing = 1;
          } else if (m.sender_id && targetAccountId && String(m.sender_id) === String(targetAccountId)) {
            finalIsOutgoing = 1;
          } else if (m.sender_id && threadAccountId && String(m.sender_id) === String(threadAccountId)) {
            finalIsOutgoing = 1;
          }

          // 2. Bổ sung log backend
          console.log(`[WS] 🔍 Debug Outgoing | Thread: ${threadId} | Source: ${m.source} | account_id: ${targetAccountId} | thread_account_id: ${threadAccountId} | sender_id: ${m.sender_id} | sender_name: ${m.sender_name} | raw is_outgoing: ${m.is_outgoing} | final is_outgoing: ${finalIsOutgoing}`);

          const isPageDomObservation = m.source === 'page_dom_observer';
          // Composer confirmations are the authoritative Facebook echo for a
          // CRM attachment send. Correlate them just like existing DOM echoes
          // instead of persisting a second image/video bubble.
          const isTrustedOutgoingObservation = m.source === 'dom_observer'
            || m.source === 'page_dom_observer'
            || m.source === 'composer_confirmation';
          const hasBooleanDirection = m.is_outgoing === true || m.is_outgoing === false
            || m.is_outgoing === 1 || m.is_outgoing === 0;
          // New Page events must carry an explicit high-confidence direction.
          // Older payloads and unknown geometry remain pending for safety.
          let directionStatus = isPageDomObservation
            && !(m.direction_status === 'confirmed' && m.direction_confidence === 'high' && hasBooleanDirection)
            ? 'pending'
            : 'confirmed';
          if (directionStatus === 'pending') finalIsOutgoing = 0;

          // Outbound media echo correlation guard:
          // During video/image upload/transcode, Facebook renders the media before
          // attaching the "Bạn đã gửi" label, causing DOM observers to report it as incoming.
          const isMediaObservation = !!(m.media_url || (m.media_type && m.media_type !== 'text') || hasMessageMediaPayload(m));
          const ambiguousDirectionEcho = !m.sender_id
            || String(m.sender_id) === String(threadAccountId || targetAccountId || '');

          if (finalIsOutgoing === 0 && isMediaObservation && ambiguousDirectionEcho && (m.source === 'dom_observer' || m.source === 'dom_history_sync' || m.source === 'page_dom_observer' || m.source === 'network_observer')) {
            const observedMediaKind = (m.media_type && m.media_type !== 'text')
              ? (String(m.media_type).startsWith('video') ? 'video' : 'image')
              : (m.media_url ? 'image' : 'any');

            // NEW: Check if the same media_url is already stored as outgoing in this thread.
            // A wide video's geometry often reads as incoming, but if we already own that
            // exact CDN URL as a sent item, this is our own echo — never create a duplicate.
            if (m.media_url) {
              // Identity compare only: an unqualified `local_media_path IS NOT
              // NULL` here matched ANY outgoing media that had a local file,
              // forcing genuine customer media to is_outgoing=1 (direction
              // flip, reproduced 2026-09-30 - "Blocked duplicate incoming
              // media" logged for a message the customer actually sent).
              const sameUrlOutgoing = db.prepare(`
                SELECT id, fb_message_id FROM messages
                WHERE thread_id = ? AND is_outgoing = 1
                  AND (media_url = ? OR (? IS NOT NULL AND local_media_path = ?))
                  AND (media_type IS NOT NULL AND media_type != 'text')
                LIMIT 1
              `).get(canonicalThreadId, m.media_url, m.local_media_path || null, m.local_media_path || null);
              if (sameUrlOutgoing) {
                console.log(`[WS] 🛡️ Blocked duplicate incoming media: same media_url already stored as outgoing #${sameUrlOutgoing.id} in thread ${canonicalThreadId}`);
                finalIsOutgoing = 1;
                directionStatus = 'confirmed';
              }
            }

            if (finalIsOutgoing === 0) {
              const matchingPendingMedia = OutboundDomCorrelationService.matchPendingImageOutbound(
                db, canonicalThreadId, observedMediaKind
              );
              if (matchingPendingMedia) {
                console.log(`[WS] 🎯 Correlating ambiguous incoming media observation with pending outbound media #${matchingPendingMedia.id} (${matchingPendingMedia.client_message_id}) in thread ${canonicalThreadId}`);
                finalIsOutgoing = 1;
                directionStatus = 'confirmed';
              } else {
                const mediaTypeClause = observedMediaKind === 'any'
                  ? ''
                  : "AND LOWER(COALESCE(media_type, '')) = ?";
                const params = observedMediaKind === 'any'
                  ? [canonicalThreadId]
                  : [canonicalThreadId, observedMediaKind];
                const recentSentMedia = db.prepare(`
                  SELECT id, fb_message_id, client_message_id
                  FROM messages
                  WHERE thread_id = ? AND is_outgoing = 1
                    AND (attachment_id IS NOT NULL OR (media_type IS NOT NULL AND media_type != 'text'))
                    AND datetime(created_at) >= datetime('now', '-60 seconds')
                    ${mediaTypeClause}
                  ORDER BY id DESC LIMIT 1
                `).get(...params);
                if (recentSentMedia) {
                  console.log(`[WS] 🎯 Correlating ambiguous incoming media observation with recently sent outbound media #${recentSentMedia.id} in thread ${canonicalThreadId}`);
                  finalIsOutgoing = 1;
                  directionStatus = 'confirmed';
                }
              }
            }
          }

          const isOutgoing = finalIsOutgoing;
          const isConfirmedIncoming = directionStatus === 'confirmed' && !isOutgoing;

          // A network/DOM observation with a conflicting incoming direction is
          // not authoritative for an operator send. The stored CRM outbound
          // row is authoritative, so discard the echo before it can become a
          // second left-side text bubble.
          if ((isDomObserverRow || isNetworkObserverRow) && isConfirmedIncoming
            && ambiguousDirectionEcho
            && isRecentOutgoingTextEcho(canonicalThreadId, m, db)) {
            console.log(`[WS] Backend Guard: skip CRM outbound text echo parsed as incoming: source=${m.source} thread=${canonicalThreadId} content="${sanitizeLog(m.content, 60)}"`);
            break;
          }

          // Startup/sync replay suppression only applies to the personal-messenger
          // dom_observer, which replays confirmations of messages the CRM itself
          // just sent. page_dom_observer passively scrapes Business Suite's
          // existing history and never has a corresponding pending row to match
          // against, so this gate would (and did) drop every real outgoing Page
          // message discovered during the ~8s window right after any reconnect.
          if (m.source === 'dom_observer' && isOutgoing) {
            const hasRecentPending = db.prepare(`
              SELECT id FROM messages
              WHERE thread_id = ? AND is_outgoing = 1 AND delivery_status = 'pending'
                AND datetime(created_at) >= datetime('now', '-10 seconds')
              LIMIT 1
            `).get(canonicalThreadId);
            const suppressUntil = domReplaySuppressUntil.get(targetAccountId) || 0;
            if (!hasRecentPending && Date.now() < suppressUntil) {
              console.log(`[WS] ℹ️ Suppress outgoing DOM replay during startup/sync window: thread=${threadId} content="${sanitizeLog(m.content, 40)}"`);
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_REPLAY_SUPPRESSED', thread_id: String(threadId), at: new Date().toISOString() }));
              break;
            }
          }

          // Tải media về local nếu tin mới có đính kèm
          // Persist/emit remote media immediately. Local hydration is queued
          // after the row exists so a slow video cannot block later messages.

          // FIX FOREIGN KEY: Đảm bảo thread tồn tại/được upsert TRƯỚC KHI insert message.
          // DOM observer replay lại tin cũ RẤT NHIỀU lần (log thực tế: cùng một
          // fb_message_id được gửi lại hàng trăm lần). Replay KHÔNG được đổi
          // trạng thái đọc/chưa đọc và không được xóa cờ đánh tay - nếu không
          // hội thoại sẽ nhảy lên nhảy xuống liên tục giữa replay và sync.
          const isReplayedObservation = m.fb_message_id
            ? Boolean(db.prepare('SELECT 1 FROM messages WHERE thread_id = ? AND fb_message_id = ?')
              .get(String(canonicalThreadId), String(m.fb_message_id)))
            : false;
          if (!isReplayedObservation) {
            if (!isOutgoing) {
              // Khách nhắn = khách đang trong hội thoại = mọi tin operator
              // GỬI TRƯỚC tin này đã xem. Phải so thời gian: chỉ lấy tin đi
              // cũ hơn tin khách vừa gửi - tin operator gửi SAU (khách chưa
              // kịp đọc) tuyệt đối không được dán 'Đã xem'.
              const incomingAt = Number(m.timestamp_ms) || Date.parse(m.created_at || '') || Date.now();
              const prevSeen = db.prepare('SELECT last_seen_message_id FROM threads WHERE id = ?').get(String(canonicalThreadId));
              const lastOut = db.prepare(`
                SELECT id FROM messages
                WHERE thread_id = ? AND is_outgoing = 1
                  AND COALESCE(timestamp_ms, 0) <= ?
                ORDER BY COALESCE(sequence_order, id) DESC LIMIT 1
              `).get(String(canonicalThreadId), incomingAt);
              if (lastOut && String(prevSeen?.last_seen_message_id || '') !== String(lastOut.id)) {
                db.prepare('UPDATE threads SET last_seen_message_id = ? WHERE id = ?').run(String(lastOut.id), String(canonicalThreadId));
                io.emit('THREAD_SEEN', { thread_id: String(canonicalThreadId), last_seen_message_id: String(lastOut.id) });
              }
            }
            if (isOutgoing) {
              // Operator trả lời = đã đọc hội thoại: gỡ mọi cờ đánh tay.
              db.prepare('UPDATE threads SET is_unread = 0, unread_manual = 0 WHERE id = ?').run(String(canonicalThreadId));
            } else {
              // Tin mới của khách: bật chưa đọc + GẮN CỜ DÍNH, vì tab Facebook
              // có thể đang đậu đúng thread này nên Facebook tự báo "đã đọc"
              // vài giây sau qua sync sidebar - không được để nó tắt nhắc.
              db.prepare('UPDATE threads SET is_unread = 1, unread_manual = 1 WHERE id = ?').run(String(canonicalThreadId));
              io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(canonicalThreadId), is_unread: 1 });
            }
          }
          ConversationRepository.upsertThread({
            id: m.thread_id,
            account_id: targetAccountId,
            contact_name: m.contact_name || 'Khách hàng',
            last_message: m.content,
            is_unread: isReplayedObservation ? undefined : !isOutgoing
          });

          // Auto-register Page source & rebind thread khi đến từ Business Suite
          if (m.source === 'page_dom_observer' && m.page_id) {
            try {
              const updatedSource = InboxSourceService.ensurePageSource({
                pageId: String(m.page_id),
                accountId: targetAccountId,
                threadId: m.thread_id,
                pageName: m.page_name || null
              }, db);
              if (updatedSource && m.page_name && updatedSource.display_name === m.page_name) {
                io.emit('INBOX_SOURCE_UPDATED', updatedSource);
                io.emit('THREAD_LIST_UPDATED');
              }
            } catch (pageSourceErr) {
              console.warn('[PAGE_SOURCE] Lỗi auto-register page source:', pageSourceErr.message);
            }
          }

          const tsMs = m.timestamp_ms || 0;
          const tsSource = m.timestamp_source || 'unknown';
          const createdAt = (m.created_at && !isNaN(Date.parse(m.created_at))) ? m.created_at : new Date().toISOString();

          const safeSenderId = m.sender_id || (isOutgoing ? String(targetAccountId) : 'CONTACT');
          // Messenger exposes a caption/base id and an `id_media` companion
          // for one logical image. Fold the media record into the base row.
          const mergedMediaCompanion = OutboundDomCorrelationService.mergeMediaCompanion(
            db, canonicalThreadId, m, isOutgoing
          );
          if (mergedMediaCompanion) {
            io.emit('NEW_MESSAGE', withAttachmentAccessUrl({
              ...mergedMediaCompanion,
              thread_id: canonicalThreadId,
              account_id: targetAccountId,
              status: mergedMediaCompanion.delivery_status || 'sent'
            }));
            break;
          }
          // Composer fallback không có official GraphQL ID; ghép confirmation DOM
          // vào bản pending gần nhất cùng thread/nội dung thay vì tạo bubble thứ hai.
          if (isOutgoing && isTrustedOutgoingObservation && (m.content || m.media_url || (m.media_type && m.media_type !== 'text'))) {
            console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_OUTGOING_RECEIVED', thread_id: String(threadId), fb_message_id: m.fb_message_id || null, at: new Date().toISOString() }));
            let skipPendingCorrelation = false;
            // Fix: Tránh crash UNIQUE constraint khi DOM observer gửi lại tin nhắn cũ có trùng content
            if (m.fb_message_id) {
               const existingFbId = db.prepare('SELECT id, is_outgoing, delivery_status FROM messages WHERE fb_message_id = ?').get(m.fb_message_id);
               if (existingFbId && existingFbId.is_outgoing === 1 && existingFbId.delivery_status === 'sent') {
                   console.log(`[WS] DOM observer sent an already known confirmed fb_message_id (${m.fb_message_id}). Bỏ qua event để tránh ghi đè pending.`);
                   // Do not skip yet: a replay of an already-persisted media
                   // id may still be the confirmation for a pending CRM upload.
               }
            }

            if (!skipPendingCorrelation) {
              // Rich-message sends (image/file, tracked via outbound_attempts)
              // are invisible to the legacy pending lookup below - it only
              // knows the messages table. Try the dedicated confirmation
              // service first; it's a safe no-op (NO_CANDIDATE) for every
              // plain-text send, since those never create an outbound_attempts
              // row, so this can never double-fire against the legacy path.
              const internalThreadId = canonicalThreadId;
              const richConfirmation = OutboundConfirmationService.confirmObservation({
                threadId: internalThreadId,
                fbMessageId: m.fb_message_id,
                isOutgoing: true,
                mediaType: m.media_type || 'text',
                content: m.content,
                observedAt: Number(m.timestamp_ms) || Date.parse(m.created_at || '') || Date.now(),
                confirmationSource: m.source === 'page_dom_observer' ? 'page_dom' : 'personal_dom'
              }, { database: db });

              if (richConfirmation.matched) {
                const updatedMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(richConfirmation.message_id);
                io.emit('MESSAGE_SENT', { thread_id: internalThreadId, client_message_id: richConfirmation.client_message_id, fb_message_id: richConfirmation.fb_message_id, status: 'sent' });
                io.emit('NEW_MESSAGE', withAttachmentAccessUrl({ ...updatedMessage, client_message_id: richConfirmation.client_message_id, status: 'sent' }));
                console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_RICH_CONFIRMED', thread_id: String(internalThreadId), client_message_id: richConfirmation.client_message_id, fb_message_id: richConfirmation.fb_message_id, at: new Date().toISOString() }));
                break;
              }

              // Rich recovery had first chance above. If this official id is
              // still already present, it is now a true duplicate and must
              // not fall through to another insert.
              if (m.fb_message_id) {
                const existingFbId = db.prepare('SELECT id, is_outgoing, delivery_status FROM messages WHERE fb_message_id = ?').get(m.fb_message_id);
                if (existingFbId && existingFbId.is_outgoing === 1 && existingFbId.delivery_status === 'sent') {
                  console.log(`[WS] Known confirmed fb_message_id (${m.fb_message_id}); pending recovery found no candidate.`);
                  break;
                }
              }

              const isMediaConfirmation = OutboundDomCorrelationService.isMediaConfirmationEvent(m);
              // Spec 039/040: a plain text-content match only proves the caption
              // rendered on Facebook, not that an attachment/manifest riding
              // alongside it actually attached and sent (live testing showed
              // Facebook can post just the caption while the file silently
              // fails to attach). Excluding queue rows with attachment_id/
              // manifest_id here forces such dispatches through the explicit
              // media-confirmation path instead, so they fail safe to
              // 'unknown' on timeout rather than falsely reporting 'sent'.
              const observedMediaKind = (m.media_type && m.media_type !== 'text')
                ? (String(m.media_type).startsWith('video') ? 'video' : 'image')
                : (m.media_url ? 'image' : 'any');

              let pending = isMediaConfirmation
                ? OutboundDomCorrelationService.matchPendingImageOutbound(db, internalThreadId, observedMediaKind)
                : db.prepare(`
                    SELECT outbound.id, outbound.client_message_id FROM messages outbound
                    LEFT JOIN outbound_attempts attempt ON outbound.latest_attempt_id = attempt.id
                    LEFT JOIN message_queue queued ON (
                      outbound.client_message_id = 'queue_' || queued.id
                      OR attempt.id = queued.outbound_attempt_id
                    )
                    WHERE outbound.thread_id = ? AND outbound.content = ? AND outbound.is_outgoing = 1
                      AND outbound.delivery_status = 'pending'
                      AND outbound.attachment_id IS NULL AND (outbound.media_type IS NULL OR outbound.media_type = 'text')
                      AND (queued.id IS NULL OR (queued.attachment_id IS NULL AND queued.manifest_id IS NULL))
                    ORDER BY outbound.id ASC LIMIT 1
                  `).get(internalThreadId, m.content);

              if (!pending) {
                pending = OutboundDomCorrelationService.matchPendingImageOutbound(db, internalThreadId, observedMediaKind);
              }
              if (pending) {
                const confirmed = OutboundDomCorrelationService.confirmPendingOutbound(db, io, pending, {
                  fbMessageId: m.fb_message_id,
                  tsMs,
                  tsSource,
                  rawMessage: { ...m, created_at: createdAt }
                });
                if (confirmed) {
                  console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_CORRELATED', thread_id: String(internalThreadId), client_message_id: pending.client_message_id, fb_message_id: m.fb_message_id || `dom_${pending.client_message_id}`, at: new Date().toISOString() }));
                  break;
                }
              }

              // Feature 020: Facebook sometimes assigns an outgoing message a
              // temporary, non-"mid.$" numeric fb_message_id first, then a
              // permanent "mid.$..." id on a later scan once fully confirmed.
              // The pending-match above only bridges the FIRST id-arrival (it
              // consumes the pending row, flipping it to 'sent'); the second
              // id-arrival finds no pending row left and no existing row
              // under its own id, so without this check it falls through to
              // a plain insert - a real duplicate row for the same send.
              // Recognize "already sent, same content, different id, very
              // recent" as an id upgrade and update in place instead.
               // Text rows carry a CRM client_message_id through their whole lifecycle.
               // Do not use content-based temporary-id upgrades for text:
               // two identical sends are two independent messages.
               const observedAsMedia = !!(m.media_url || (m.media_type && m.media_type !== 'text'));
               if (m.fb_message_id && observedAsMedia) {
                 const recentSent = OutboundDomCorrelationService.findTemporaryIdUpgrade(
                   db, canonicalThreadId, { ...m, timestamp_ms: tsMs, created_at: createdAt }, true
                 );
                if (recentSent) {
                  db.prepare('UPDATE messages SET fb_message_id = ? WHERE id = ?').run(m.fb_message_id, recentSent.id);
                  console.log(`[WS] Nâng cấp fb_message_id tạm ${recentSent.fb_message_id} -> ${m.fb_message_id} (id ${recentSent.id}), cùng 1 tin gửi đi`);
                  console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_ID_UPGRADED', thread_id: String(canonicalThreadId), from_fb_message_id: recentSent.fb_message_id, to_fb_message_id: m.fb_message_id, at: new Date().toISOString() }));
                  break;
                }
              }


              // Mismatch guard: exactly 1 pending in same thread within 10s, but content differs
              const recentPendings = db.prepare(`
                SELECT id, client_message_id, content FROM messages
                WHERE thread_id = ? AND is_outgoing = 1 AND delivery_status = 'pending'
                  AND datetime(created_at) >= datetime('now', '-10 seconds')
                ORDER BY id DESC
              `).all(canonicalThreadId);
              if (recentPendings.length === 1) {
                const mismatchPending = recentPendings[0];
                const pendingContent = String(mismatchPending.content || '').trim();
                const domContent = String(m.content || '').trim();
                // Only mark mismatch if DOM content looks related to the pending attempt
                // (e.g. "what" -> "whatwhat", "alo 123" -> "aloalo 123")
                // Unrelated old messages like "Long ngu" won't accidentally fail a pending "what"
                const looksLikeSameAttempt = pendingContent && domContent &&
                  (domContent.includes(pendingContent) || pendingContent.includes(domContent));
                if (looksLikeSameAttempt) {
                  console.warn(`[WS] ⚠️ COMPOSER_CONTENT_MISMATCH: pending content="${pendingContent.substring(0, 40)}" vs DOM content="${domContent.substring(0, 40)}" | thread=${canonicalThreadId}`);
                  console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_CONTENT_MISMATCH', thread_id: String(canonicalThreadId), client_message_id: mismatchPending.client_message_id, pending_len: pendingContent.length, dom_len: domContent.length, at: new Date().toISOString() }));
                  deleteOutboundMessageRows({ messageId: mismatchPending.id });
                  io.emit('MESSAGE_SEND_FAILED', { thread_id: canonicalThreadId, client_message_id: mismatchPending.client_message_id, success: false, status: 'failed', error: 'COMPOSER_CONTENT_MISMATCH', error_code: 'COMPOSER_CONTENT_MISMATCH' });
                  // Discard the mismatched DOM bubble entirely — do not insert it
                  break;
                }
              }
            }
          }
          // ===== ANTI-GHOST GUARD (chỉ áp dụng cho tin được xác nhận outgoing) =====
          // DOM observer đôi khi bắt lại tin nhắn do CRM gửi (đã có is_outgoing=1 trong DB).
          // Nếu để chạy tiếp sẽ tạo bubble ghost bên trái với is_outgoing=0.
          // Không được dùng một media outgoing bất kỳ trong 5 phút để loại một
          // media customer mới. Điều kiện cũ làm ảnh/video khách gửi biến mất
          // chỉ vì CRM vừa gửi ảnh/video trong cùng hội thoại.
          // Anti-ghost guard: (m.source === 'page_dom_observer') && isOutgoing)
          if (isTrustedOutgoingObservation && isOutgoing) {
            const isMedia = !!(m.media_url || (m.media_type && m.media_type !== 'text'));
            let outgoingMatch = null;

            if (isMedia) {
              outgoingMatch = db.prepare(`
                SELECT id, delivery_status, client_message_id, thread_id FROM messages
                WHERE thread_id = ? AND is_outgoing = 1
                  AND (attachment_id IS NOT NULL OR (media_type IS NOT NULL AND media_type != 'text'))
                  AND datetime(created_at) >= datetime('now', '-300 seconds')
                ORDER BY id DESC LIMIT 1
              `).get(canonicalThreadId);
            } else if (m.content) {
              outgoingMatch = db.prepare(`
                SELECT id, delivery_status, client_message_id, thread_id FROM messages
                WHERE thread_id = ? AND content = ? AND is_outgoing = 1
                  AND datetime(created_at) >= datetime('now', '-300 seconds')
                ORDER BY id DESC LIMIT 1
              `).get(canonicalThreadId, m.content);
            }

            if (outgoingMatch) {
              console.log(`[WS] 🚫 Anti-ghost FINAL: DOM observer bắt lại tin outgoing (id=${outgoingMatch.id}, status=${outgoingMatch.delivery_status}). Discard hoàn toàn.`);
              if (outgoingMatch.delivery_status === 'pending') {
                OutboundDomCorrelationService.confirmPendingOutbound(db, io, outgoingMatch, {
                  fbMessageId: m.fb_message_id,
                  tsMs,
                  tsSource,
                  rawMessage: { ...m, created_at: createdAt }
                });
              }
              break;
            }
          }


          // Lưu tin nhắn vào bảng messages
          let stableMessageId = m.fb_message_id || m.client_message_id || ConversationRepository.fingerprint(m.thread_id, m);
          if (!isOutgoing && m.fb_message_id) {
            const promotedPreview = ConversationRepository.promoteSidebarPreview({
              threadId: m.thread_id,
              fbMessageId: m.fb_message_id,
              content: m.content,
              isOutgoing: false,
              timestampMs: tsMs
            }, db);
            if (promotedPreview) stableMessageId = promotedPreview.fbMessageId;
          }
          const existingStableMessage = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(stableMessageId);
          const sequenceRow = db.prepare(`
            SELECT MAX(COALESCE(sequence_order, id)) AS max_sequence
            FROM messages WHERE thread_id = ?
          `).get(m.thread_id);
          let realtimeSequence = Number(sequenceRow?.max_sequence || 0) + 1;
          // Mutation callbacks may arrive in a different order from the visual
          // Messenger rows. Reserve the confirmed DOM slot before inserting so
          // both the live UI and later database snapshots keep the same order.
          if (!existingStableMessage && m.dom_position_confirmed) {
            const previousRow = m.dom_previous_message_id
              ? db.prepare('SELECT COALESCE(sequence_order, id) AS sequence_order FROM messages WHERE thread_id = ? AND fb_message_id = ?').get(m.thread_id, m.dom_previous_message_id)
              : null;
            const nextRow = m.dom_next_message_id
              ? db.prepare('SELECT COALESCE(sequence_order, id) AS sequence_order FROM messages WHERE thread_id = ? AND fb_message_id = ?').get(m.thread_id, m.dom_next_message_id)
              : null;
            let targetSequence = null;
            if (nextRow && Number.isFinite(Number(nextRow.sequence_order))) {
              targetSequence = Number(nextRow.sequence_order);
            } else if (previousRow && Number.isFinite(Number(previousRow.sequence_order))) {
              const followingRow = db.prepare(`
                SELECT MIN(COALESCE(sequence_order, id)) AS sequence_order
                FROM messages WHERE thread_id = ? AND COALESCE(sequence_order, id) > ?
              `).get(m.thread_id, Number(previousRow.sequence_order));
              targetSequence = Number.isFinite(Number(followingRow?.sequence_order))
                ? Number(followingRow.sequence_order)
                : Number(previousRow.sequence_order) + 1;
            }
            if (Number.isFinite(targetSequence) && targetSequence > 0) {
              db.prepare(`
                UPDATE messages SET sequence_order = COALESCE(sequence_order, id) + 1
                WHERE thread_id = ? AND COALESCE(sequence_order, id) >= ?
              `).run(m.thread_id, targetSequence);
              realtimeSequence = targetSequence;
            }
          }
          const insertMsgResult = db.prepare(`
            INSERT OR IGNORE INTO messages
              (thread_id, fb_message_id, sender_id, content, media_type, media_url, local_media_path, is_outgoing, direction_status, sequence_order, timestamp_ms, timestamp_source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(m.thread_id, stableMessageId, safeSenderId, m.content,
            m.media_type || 'text', m.media_url, m.local_media_path, isOutgoing, directionStatus, realtimeSequence, tsMs, tsSource, createdAt);

          let wasNewMessage = insertMsgResult.changes > 0;
          if (wasNewMessage && !String(stableMessageId).endsWith('_media')) {
            try {
              // A media companion can be observed before the base native row.
              // Collapse it immediately once the parent exists.
              OutboundDomCorrelationService.collapseStoredMediaCompanions(db, m.thread_id);
            } catch (collapseError) {
              console.warn('[WS] Deferred media companion collapse:', collapseError.message);
            }
          }
          if (wasNewMessage) {
            // Tin mới chèn theo anchor DOM có thể rơi sai ngày (tin 16/9 được
            // quét lại hôm nay bị gắn seq cuối thread). Chuẩn hóa lại ngay
            // theo timestamp để DB không giữ thứ tự sai tới lần GET tiếp theo.
            try {
              ConversationRepository.normalizeMessageSequence(m.thread_id, db);
            } catch (normalizeError) {
              console.warn('[WS] Normalize sequence sau insert thất bại:', normalizeError.message);
            }
          }
          let directionWasUpdated = false;

          let mediaWasUpdated = false;

          if (!wasNewMessage) {
            // Messenger often mounts a video row before its durable URL/poster
            // is hydrated. Enrich the same native id instead of discarding it.
            const existingMedia = db.prepare(
              'SELECT media_type, media_url, local_media_path, content FROM messages WHERE fb_message_id = ?'
            ).get(stableMessageId);
            const incomingMediaType = String(m.media_type || 'text');
            const hasIncomingMedia = incomingMediaType !== 'text';
            const hasRicherMedia = Boolean(existingMedia && hasIncomingMedia && (
              !existingMedia.media_type || existingMedia.media_type === 'text' ||
              (!existingMedia.media_url && m.media_url) ||
              (!existingMedia.local_media_path && m.local_media_path)
            ));
            if (hasRicherMedia) {
              const mediaUpdate = db.prepare(`
                UPDATE messages SET
                  media_type = ?,
                  media_url = COALESCE(NULLIF(?, ''), media_url),
                  local_media_path = COALESCE(NULLIF(?, ''), local_media_path),
                  content = CASE
                    WHEN COALESCE(content, '') = '' AND COALESCE(?, '') != '' THEN ?
                    ELSE content
                  END
                WHERE fb_message_id = ?
              `).run(incomingMediaType, m.media_url || null, m.local_media_path || null,
                m.content || null, m.content || null, stableMessageId);
              mediaWasUpdated = mediaUpdate.changes > 0;
            }
            // Tin đã tồn tại: nhờ ConversationRepository quyết định có cần nâng cấp
            // timestamp/is_outgoing không (logic dùng chung, có test riêng).
            const reconcile = ConversationRepository.reconcileExistingMessage(
              stableMessageId,
              {
                source: m.source,
                isOutgoing: directionStatus === 'pending' ? null : isOutgoing,
                direction_status: directionStatus,
                direction_confidence: m.direction_confidence,
                tsMs,
                tsSource,
                createdAt
              },
              db
            );
            if (reconcile.reason === 'not_found') {
              break; // Duplicate vì client_message_id hoặc lý do khác
            }
            if (!reconcile.updated && !mediaWasUpdated) {
              console.log(`[WS] Bỏ qua tin nhắn đã tồn tại (fb_message_id: ${m.fb_message_id})`);
              break;
            }
            if (reconcile.timestampUpdated) {
              console.log(`[WS] ⏳ Nâng cấp Timestamp Rank cho fb_message_id ${m.fb_message_id}: ${reconcile.previousTimestampSource} -> ${tsSource}`);
            }
            if (reconcile.directionUpdated) {
              directionWasUpdated = true;
              console.log('[WS] Direction updated for message ' + m.fb_message_id + ': ' + (reconcile.previousIsOutgoing ? 1 : 0) + ' -> ' + (isOutgoing ? 1 : 0));
            }
            // Direction promotion is emitted so an already-open CRM thread can
            // move the bubble without inserting a duplicate message.
          }

          if (wasNewMessage || directionWasUpdated || mediaWasUpdated) {
            const earlyPersistedMessage = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableMessageId);
            // Link share bi Messenger unfurl thanh tin media rieng (video/image
            // khong co noi dung) -> xoa tin link-text vua gui truoc do (cung
            // thread, <=3 phut, noi dung chi la URL) de khong hien 2 bong bong
            // cho cung mot noi dung (reproduced 2026-09-18).
            try {
              const newMt = String(earlyPersistedMessage.media_type || '').toLowerCase();
              const newContent = String(earlyPersistedMessage.content || '').trim();
              const newOutgoing = Number(earlyPersistedMessage.is_outgoing) === 1;
              if (newOutgoing && newMt === 'video' && !newContent) {
                // Tin unfurl gồm CẢ video row (rỗng content) LẪN image rows
                // mang content = link (media_type='image') - xóa TẤT CẢ tin
                // trước đó ≤3 phút có content là link, mọi media_type.
                const linkRows = db.prepare(`
                  SELECT id FROM messages
                  WHERE thread_id = ? AND is_outgoing = 1 AND content LIKE 'http%'
                    AND id != ?
                    AND datetime(created_at) >= datetime('now', '-3 minutes')
                  ORDER BY id DESC LIMIT 6
                `).all(earlyPersistedMessage.thread_id, earlyPersistedMessage.id);
                if (linkRows.length) {
                  // Chuyển URL của tin link vào tin media (bubble = ảnh/video +
                  // dòng link bấm được bên dưới), rồi xóa tin link trùng.
                  const keepUrl = String(linkRows[0].content || '').trim();
                  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(keepUrl, earlyPersistedMessage.id);
                  const delStmt = db.prepare('DELETE FROM messages WHERE id = ?');
                  for (const lr of linkRows) delStmt.run(lr.id);
                  io.emit('THREAD_MESSAGES_UPDATED', { thread_id: earlyPersistedMessage.thread_id, account_id: targetAccountId || threadAccountId || m.account_id || ws.accountId || null });
                  console.log(`[LINK_MERGE] Unfurl: đã gộp ${linkRows.length} tin link, chuyển URL vào media #${earlyPersistedMessage.id}`);
                }
              }
            } catch (_) {}
            const earlyThread = db.prepare(`
              SELECT t.id, t.external_thread_id, t.account_id, t.contact_name, c.avatar_url,
                     t.last_message, t.last_activity, t.is_unread, t.inbox_folder, t.source_id
              FROM threads t
              LEFT JOIN contacts c ON c.thread_id = t.id
              WHERE t.id = ?
            `).get(earlyPersistedMessage?.thread_id || canonicalThreadId || m.thread_id);
            if (earlyPersistedMessage) {
              io.emit('NEW_MESSAGE', {
                ...m,
                ...earlyPersistedMessage,
                account_id: targetAccountId || threadAccountId || m.account_id || ws.accountId || null,
                timestamp_ms: tsMs,
                timestamp_source: tsSource,
                created_at: createdAt,
                is_outgoing: !!isOutgoing,
                direction_status: directionStatus,
                thread_summary: earlyThread || null
              });
              realtimeMessageEmittedEarly = true;
            }
          }
          // Update contact name if provided and not yet properly set
          if (m.contact_name && !isInvalidContactName(m.contact_name)) {
            const cleanName = m.contact_name.trim();
            const existing = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(m.thread_id);
            if (!existing || isInvalidContactName(existing.contact_name) || (existing.contact_name || '').startsWith('Khách hàng')) {
              db.prepare('UPDATE threads SET contact_name = ? WHERE id = ?').run(cleanName, m.thread_id);
              db.prepare(`
                INSERT INTO contacts (thread_id, name)
                VALUES (?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET name = excluded.name
              `).run(m.thread_id, cleanName);
              io.emit('CONTACT_UPDATED', { thread_id: m.thread_id, name: cleanName });
            }
          }

          // Avatar backfill: apply regardless of whether this message is a brand-new
          // insert or a re-scan of an existing one, so a thread whose messages were
          // already stored before contact-avatar extraction existed still gets
          // corrected.
          const avatarData = m.avatar_base64 || m.avatar_url || m.contact_avatar || '';
          if (avatarData) {
            const existingContact = db.prepare('SELECT avatar_url FROM contacts WHERE thread_id = ?').get(m.thread_id);
            if (!existingContact || !existingContact.avatar_url) {
              try {
                const localAvatarPath = await saveAvatarFromBase64OrUrl(avatarData, m.thread_id);
                if (localAvatarPath) {
                  const avatarResult = ConversationRepository.setContactAvatarIfMissing(m.thread_id, m.contact_name, localAvatarPath, db);
                  if (avatarResult.updated) {
                    io.emit('CONTACT_UPDATED', { thread_id: m.thread_id, avatar_url: localAvatarPath });
                  }
                }
              } catch (err) {
                console.warn('[WS] Avatar save failed:', err.message);
              }
            }
          }

          if (!wasNewMessage && !directionWasUpdated && !mediaWasUpdated) break; // Ignore a replay with no persisted change.
          if (wasNewMessage) ConversationRepository.touchThread(m.thread_id, m.content);

          // Auto Lead Extraction (avatar handled above, applies regardless of wasNewMessage)
          if (wasNewMessage && isConfirmedIncoming && m.content) {
            const { emails } = extractLeadInfo(m.content);
            if (emails.length > 0) {
              db.prepare(`
                INSERT INTO contacts (thread_id, name, email)
                VALUES (?, ?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                  email = COALESCE(NULLIF(excluded.email,''), contacts.email)
              `).run(m.thread_id, m.contact_name || 'Khách hàng', emails[0] || null);
            }

            // Phone capture (spec 035): exact-prefix detection, immutable
            // evidence per candidate, fill-only contact phone (never
            // overwrites a manual/legacy/already-selected value). Runs
            // independently of email extraction above.
            const { threadId: capturedThreadId, createdCaptures } = PhoneCaptureService.processIncomingMessage({
              threadId: m.thread_id,
              accountId: targetAccountId,
              messageId: stableMessageId,
              content: m.content,
              messageTimestampMs: tsMs
            }, { database: db });

            if (emails.length > 0 || createdCaptures.length > 0) {
              // Kept additive/compatible with any existing LEAD_EXTRACTED
              // consumer - phones here are normalized capture values, not
              // raw regex matches.
              io.emit('LEAD_EXTRACTED', {
                thread_id: m.thread_id,
                phones: createdCaptures.map((c) => c.normalized_phone),
                emails
              });
            }
            if (createdCaptures.length > 0) {
              // Publish campaign phone statistics immediately after durable
              // capture. Campaign automation below may wait for Messenger
              // acknowledgement and must not hold the statistics UI hostage.
              const capturedMessage = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(stableMessageId);
              if (capturedMessage?.id) {
                const immediateCampaignResponse = CampaignResponseStatsService.recordIncomingResponse({
                  messageId: capturedMessage.id,
                  threadId: m.thread_id,
                  accountId: targetAccountId || threadAccountId || null,
                  observedAtMs: tsMs || Date.parse(createdAt) || Date.now()
                }, db);
                if (immediateCampaignResponse) {
                  io.emit('CAMPAIGN_RESPONSE_UPDATED', {
                    ...immediateCampaignResponse,
                    thread_id: m.thread_id,
                    phone_captured: true
                  });
                }
              }

              // Global CRM rule is opt-in and applies to every genuine incoming
              // capture. A configured campaign policy runs immediately after it
              // and is the explicit per-campaign override when it has a target.
              const globalPhoneAutomation = GlobalPhoneAutomationService.applyCaptures(capturedThreadId, createdCaptures, db);
              if (globalPhoneAutomation.applied) {
                console.log(`[PhoneCapture] Global automation applied status ${globalPhoneAutomation.settings.status_id} for ${capturedThreadId}`);
              }

              // Includes the fully-resolved contact phone view so the
              // frontend can merge it directly without a round-trip fetch -
              // it needs this regardless of which thread is active, so the
              // background cache stays correct for whenever the operator
              // switches to it (contracts/phone-capture.md's contact payload shape).
              const phoneView = PhoneCaptureService.getContactPhoneView(capturedThreadId, db);
              io.emit('PHONE_CAPTURED', {
                thread_id: capturedThreadId,
                captures: createdCaptures.map((c) => ({
                  id: c.id,
                  normalized_phone: c.normalized_phone,
                  raw_phone: c.raw_phone,
                  message_id: c.message_id,
                  message_timestamp_ms: c.message_timestamp_ms,
                  selection_state: c.selection_state
                })),
                phone: phoneView.phone,
                phone_source: phoneView.phone_source,
                phone_captured_at: phoneView.phone_captured_at,
                phone_capture: phoneView.phone_capture,
                phone_candidates: phoneView.phone_candidates
              });
              io.emit('CONTACT_UPDATED', { thread_id: capturedThreadId });

              // Campaign phone-capture policy (spec 035) - runs after the
              // capture is durably saved and broadcast, per the contract
              // ("invoke campaign reaction only after durable capture").
              // Awaited: thank_then_stop waits for its acknowledgement to
              // settle before stopping remaining work, so this can take up
              // to the poll timeout - acceptable here since it only runs for
              // the (rare) capture-bearing message, not every message.
              try {
                const affectedCampaignIds = await CampaignPhoneCaptureService.handleCaptures(capturedThreadId, createdCaptures, {
                  database: db,
                  capabilityOptions: getRichMessageCapabilityOptions()
                });
                for (const campaignId of affectedCampaignIds) {
                  CampaignEventService.emit(io, CampaignRepository.getCampaign(campaignId, db));
                }
                // Emit one authoritative post-policy view. The earlier
                // PHONE_CAPTURED event makes the number feel instant; this
                // complete patch is what makes every active panel, sidebar
                // chip and status filter converge after policy handling.
                const updatedContact = db.prepare(`
                  SELECT c.phone, c.phone_source, c.phone_captured_at,
                         c.status_id, ls.name AS status_name, ls.color AS status_color
                  FROM contacts c LEFT JOIN lead_statuses ls ON ls.id = c.status_id
                  WHERE c.thread_id = ?
                `).get(capturedThreadId);
                io.emit('CONTACT_UPDATED', { thread_id: capturedThreadId, ...updatedContact });
              } catch (err) {
                console.error('[PhoneCapture] Campaign policy application failed:', err.message);
              }
            }
          }

          if (wasNewMessage && isConfirmedIncoming) {
            followupService.restoreOnIncoming(m.thread_id);
          }

          // Emit payload đầy đủ lên frontend
          const persistedMessage = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableMessageId);
          if (wasNewMessage && isConfirmedIncoming && persistedMessage?.id) {
            const campaignResponse = CampaignResponseStatsService.recordIncomingResponse({
              messageId: persistedMessage.id,
              threadId: m.thread_id,
              accountId: targetAccountId || threadAccountId || null,
              observedAtMs: tsMs || Date.parse(createdAt) || Date.now()
            }, db);
            if (campaignResponse) {
              io.emit('CAMPAIGN_RESPONSE_UPDATED', {
                ...campaignResponse,
                thread_id: m.thread_id
              });
            }
          }
          const realtimeThread = db.prepare(`
            SELECT t.id, t.external_thread_id, t.account_id, t.contact_name, c.avatar_url,
                   t.last_message, t.last_activity, t.is_unread, t.inbox_folder, t.source_id
            FROM threads t
            LEFT JOIN contacts c ON c.thread_id = t.id
            WHERE t.id = ?
          `).get(persistedMessage?.thread_id || canonicalThreadId || m.thread_id);
          if (realtimeMessageEmittedEarly) {
            // The durable row was already published immediately after insert.
            // Keep the later enrichment/automation path from emitting it twice.
            if (msg.outbox_id && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'BACKEND_OUTBOX_ACK',
                data: { outbox_id: String(msg.outbox_id) }
              }));
            }
            break;
          }
          const msgPayload = {
            ...m,
            ...(persistedMessage || {}),
            account_id: targetAccountId || threadAccountId || m.account_id || ws.accountId || null,
            timestamp_ms: tsMs,
            timestamp_source: tsSource,
            created_at: createdAt,
            is_outgoing: !!isOutgoing,
            direction_status: directionStatus,
            thread_summary: realtimeThread || null
          };
          console.log(`[WS] Emitting NEW_MESSAGE to Socket.io clients:`, JSON.stringify(msgPayload).substring(0, 200));
          io.emit('NEW_MESSAGE', msgPayload);

          if (persistedMessage?.id && persistedMessage.media_url &&
              persistedMessage.media_type && persistedMessage.media_type !== 'text' &&
              !persistedMessage.local_media_path) {
            inboundMediaHydration.hydrateRow(persistedMessage);
          }

          // ACK only after SQLite persistence and realtime emission completed.
          // The extension keeps the durable outbox row until this arrives, so
          // a socket drop between ws.send() and DB commit cannot lose a message.
          if (msg.outbox_id && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'BACKEND_OUTBOX_ACK',
              data: { outbox_id: String(msg.outbox_id) }
            }));
          }

          // Auto-Reply & AI
          if (wasNewMessage && isConfirmedIncoming) {
            const replied = await autoReplyEngine.processIncoming(m, sendViaExtension);
            if (!replied) {
              await aiMediator.processIncoming(m, sendViaExtension);
            }
          }
          break;
        }

        case 'DISCOVERY_SYNC_DIAGNOSTIC': {
          const diagnostic = msg.data || {};
          console.log(`[DISCOVERY_DIAG] account=${diagnostic.account_id || ws.accountId || 'unknown'} stage=${diagnostic.stage || 'unknown'} data=${JSON.stringify(diagnostic)}`);
          break;
        }

        case 'INCOMING_CALL_RINGING': {
          const data = msg.data || {};
          const accountId = data.account_id || ws.accountId || null;
          // A detached Chrome tab can deliver one last queued frame after its
          // account was removed. Never surface that stale frame in the CRM.
          const liveAccount = accountId
            ? db.prepare('SELECT id FROM accounts WHERE id = ?').get(String(accountId))
            : null;
          if (!liveAccount || ws.accountId && String(ws.accountId) !== String(accountId)) {
            console.warn(`[WS] Skip stale incoming call for removed/invalid account=${accountId || 'unknown'}`);
            break;
          }

          // Keep the managed Chrome profile hidden. The desktop CRM popup is
          // sufficient; bringing Chrome forward interrupts the operator.
          const internalThreadId = data.thread_id ? resolveInternalThreadId(db, accountId, data.thread_id) : null;
          const knownThread = internalThreadId
            ? db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(internalThreadId)
            : null;
          const callerName = String(data.caller_name || knownThread?.contact_name || '').trim() || 'Khách hàng';
          io.emit('INCOMING_CALL_RINGING', { ...data, caller_name: callerName, thread_id: internalThreadId || data.thread_id || null, external_thread_id: data.thread_id || null, account_id: accountId });
          break;
        }

        case 'INCOMING_CALL_ENDED':
          io.emit('INCOMING_CALL_ENDED', msg.data || {});
          break;

        case 'ANSWER_INCOMING_CALL_RESULT':
          io.emit('ANSWER_INCOMING_CALL_RESULT', msg.data || {});
          break;

        case 'MESSAGE_REQUEST_ACTION_RESULT': {
          const result = msg.data || {};
          const requestId = String(result.request_id || '');
          const owner = messageRequestActionOwners.get(requestId);
          if (!owner) break;
          messageRequestActionOwners.delete(requestId);
          if (result.success && result.action !== 'query') {
            const threadId = String(owner.threadId);
            // "Continue" only expands Messenger's second-stage request
            // controls (Accept / Delete / Block). Keep the thread in the
            // request inbox until the operator chooses a terminal action.
            if (result.action === 'accept') {
              db.prepare("UPDATE threads SET inbox_folder = 'INBOX' WHERE id = ?").run(threadId);
              io.emit('THREAD_INBOX_FOLDER_CHANGED', { thread_id: threadId, inbox_folder: 'INBOX' });
            } else if (result.action === 'delete' || result.action === 'block') {
              db.prepare('UPDATE threads SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);
              io.emit('MESSAGE_REQUEST_REMOVED', { thread_id: threadId });
            }
          }
          owner.socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { ...result, thread_id: owner.threadId });
          break;
        }

        case 'THREAD_SEEN': {
          // Extension bắt được 'Đã xem' từ 2 nguồn:
          // - DOM watcher (alt avatar + bubble text) khi thread đang mở.
          // - MQTT read receipt (watermark_ms) - dữ liệu chuẩn của Facebook,
          //   về realtime kể cả khi thread không mở. Watermark khớp theo
          //   messages.timestamp_ms (đã xác nhận từ FB) nên không cần đoán.
          try {
            const seenAltRaw = String(msg.data?.alt || '');
            const seenBubbleRaw = String(msg.data?.bubble_text || '');
            const seenWatermarkMs = Number(msg.data?.watermark_ms) || 0;
            if (!seenAltRaw && !seenBubbleRaw && !(seenWatermarkMs > 0)) {
              // Bản content script cũ (chỉ gửi thread_id) - dữ liệu không đủ
              // để xác định tin, chấm mù sẽ gây false positive.
              break;
            }
            console.log(`[SEEN] Nhận: alt="${seenAltRaw.slice(0, 60)}" bubble="${seenBubbleRaw.slice(0, 60)}" watermark=${seenWatermarkMs} source=${msg.data?.source || 'dom'}`);
            const rawSeenId = String(msg.data?.thread_id || '');
            const seenAccountId = msg.data?.account_id ? String(msg.data.account_id) : String(ws.accountId || '');
            // Operator tự đọc tin của khách cũng sinh read receipt: actor
            // trùng tài khoản đang chạy thì bỏ qua, không đánh 'đã xem'.
            if (seenWatermarkMs > 0 && String(msg.data?.actor || '') && seenAccountId && String(msg.data.actor) === String(seenAccountId)) {
              console.log(`[SEEN] Bỏ qua: receipt của chính operator (actor=${msg.data.actor})`);
              break;
            }
            if (rawSeenId) {
              const canonicalSeenId = resolveInternalThreadId(db, seenAccountId, rawSeenId) || rawSeenId;
              const lastSeenOut = db.prepare(
                'SELECT id, created_at FROM messages WHERE thread_id = ? AND is_outgoing = 1 ORDER BY COALESCE(sequence_order, id) DESC LIMIT 1'
              ).get(canonicalSeenId);
              if (!lastSeenOut) break;
              const altText = String(msg.data?.alt || '');
              const bubbleText = String(msg.data?.bubble_text || '');
              const normSeen = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const nb = normSeen(bubbleText);
              let targetSeen = null;
              // Ưu tiên 0 (MQTT): watermark từ read receipt chính chủ - tin
              // outgoing cuối có timestamp_ms (giờ FB) ≤ watermark + dung sai
              // 5s. Đây là mốc khách đã đọc tới, chính xác nhất.
              if (seenWatermarkMs > 0) {
                targetSeen = db.prepare(
                  'SELECT id, content FROM messages WHERE thread_id = ? AND is_outgoing = 1 AND timestamp_ms > 0 AND timestamp_ms <= ? ORDER BY COALESCE(sequence_order, id) DESC LIMIT 1'
                ).get(canonicalSeenId, seenWatermarkMs + 5000) || null;
              }
              // Ưu tiên 1: khớp NỘI DUNG bubble nằm ngay trên avatar seen -
              // xác định chính xác khách đọc tới tin nào (không đoán giờ).
              if (!targetSeen && nb && nb !== 'đã gửi') {
                const recentOut = db.prepare(
                  'SELECT id, content FROM messages WHERE thread_id = ? AND is_outgoing = 1 ORDER BY COALESCE(sequence_order, id) DESC LIMIT 30'
                ).all(canonicalSeenId);
                targetSeen = recentOut.find((m) => {
                  const c = normSeen(m.content);
                  return c && c.length > 1 && (nb === c || nb.includes(c) || c.includes(nb));
                }) || null;
              }
              // Ưu tiên 2 (fallback): gate theo giờ trong alt so với tin cuối.
              if (!targetSeen) {
                const timeMatch = altText.match(/(?:lúc|at)\s+(\d{1,2}):(\d{2})/i);
                const sentAt = Date.parse(lastSeenOut.created_at);
                if (timeMatch && Number.isFinite(sentAt)) {
                  const seenAt = new Date();
                  seenAt.setHours(Number(timeMatch[1]) % 24, Number(timeMatch[2]), 0, 0);
                  if (seenAt.getTime() - sentAt > 12 * 3600 * 1000) seenAt.setTime(seenAt.getTime() - 24 * 3600 * 1000);
                  if (seenAt.getTime() + 120000 >= sentAt) targetSeen = lastSeenOut;
                }
              }
              if (!targetSeen) {
                console.log(`[SEEN] Bỏ qua (bubble "${bubbleText.slice(0, 40)}" không khớp tin nào, alt "${altText.slice(0, 50)}")`);
                break;
              }
              // Avatar chỉ tiến tới: mốc hiện tại mới hơn target thì không lùi.
              const prevSeenRow2 = db.prepare('SELECT last_seen_message_id FROM threads WHERE id = ?').get(canonicalSeenId);
              if (prevSeenRow2?.last_seen_message_id) {
                const cur = db.prepare('SELECT COALESCE(sequence_order, id) AS ord FROM messages WHERE id = ?').get(prevSeenRow2.last_seen_message_id);
                const tgt = db.prepare('SELECT COALESCE(sequence_order, id) AS ord FROM messages WHERE id = ?').get(targetSeen.id);
                if (cur && tgt && Number(tgt.ord) <= Number(cur.ord)) break;
              }
              db.prepare('UPDATE threads SET last_seen_message_id = ? WHERE id = ?').run(String(targetSeen.id), canonicalSeenId);
              io.emit('THREAD_SEEN', { thread_id: String(canonicalSeenId), last_seen_message_id: String(targetSeen.id) });
              console.log(`[SEEN] thread=${canonicalSeenId} seen tới tin ${targetSeen.id} (bubble: "${bubbleText.slice(0, 40)}")`);
            }
          } catch (seenErr) {
            console.warn('[SEEN] Lỗi xử lý THREAD_SEEN:', seenErr.message);
          }
          break;
        }

        case 'SYNC_THREADS_RESULT': {
          let { account_id, threads, partial, sync_status, checkpoint } = msg.data;
          if (!account_id && msg.data?.page_id) {
            const pageSrc = db.prepare('SELECT owner_account_id FROM inbox_sources WHERE source_type = "page_messenger" AND external_id = ?').get(String(msg.data.page_id));
            if (pageSrc?.owner_account_id) account_id = pageSrc.owner_account_id;
          }
          if (!account_id && ws.accountId) {
            account_id = ws.accountId;
          }
          const isRealtimeSidebarHint = sync_status === 'realtime_hint' || sync_status === 'realtime_requests';
          console.log(`[WS] Nhận ${threads?.length || 0} threads từ extension tài khoản: ${account_id}`);
          if (isRealtimeSidebarHint) {
            const observedAtMs = Number(msg.data?.observed_at || 0);
            syncDebug('REALTIME_HINT', {
              account: account_id,
              origin: msg.data?.origin || null,
              threads: threads?.length || 0,
              age_ms: observedAtMs ? Date.now() - observedAtMs : null
            });
          }
          // Progressive UI batches are not the end of the combined Inbox +
          // Requests scan. Only its final aggregate frame releases inFlight.
          if (partial !== true) {
            InboxSyncScheduler.markSidebarResult(account_id, threads?.length || 0);
            if (threads?.length) completeNewAccountBootstrapSync(account_id);
          }
          if (partial === true && (sync_status === 'paused' || sync_status === 'cancelled')) {
            InboxSyncScheduler.markSidebarResult(account_id, threads?.length || 0);
          }
          if (!isRealtimeSidebarHint) {
            io.emit('FACEBOOK_SYNC_STATUS', { account_id, status: sync_status || (partial ? 'running' : 'completed'), checkpoint: checkpoint || [], count: threads?.length || 0 });
            domReplaySuppressUntil.set(account_id, Date.now() + 5000);
          }
          if (threads?.length) {
            // Keep a small list of already-known conversations whose unread
            // sidebar preview actually changed.  The existing sidebar sync is
            // intentionally left untouched; this only fills the realtime gap
            // for conversations which are not currently open in the history
            // tab (Facebook does not mount their message DOM).
            const changedUnreadThreads = [];
            const txn = db.transaction((account_id, threads) => {
              for (const t of threads) {
                const threadId = t.thread_id || t.id;
                const { isBlacklistedThreadId } = require('./utils/threadGuard');
                if (!threadId || isBlacklistedThreadId(threadId)) continue;
                const threadPageId = t.page_id || msg.data?.page_id || null;
                const existingInternalThreadId = resolveInternalThreadId(db, account_id, threadId, threadPageId) || threadId;
                const previousThread = db.prepare(`
                  SELECT last_message, is_unread, thread_url, contact_name
                  FROM threads WHERE id = ?
                `).get(existingInternalThreadId);
                let name = cleanContactName(t.name || t.contact_name, null);
                const existing = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(existingInternalThreadId);
                let existingName = existing?.contact_name;
                if (isInvalidContactName(existingName)) existingName = null;

                // Chống tráo đổi tên: nếu thread đã có tên hợp lệ và tên mới bị trùng với thread khác, giữ tên hiện tại
                if (existingName && existingName !== 'Khách hàng') {
                  const isDuplicated = db.prepare('SELECT id FROM threads WHERE account_id = ? AND id != ? AND contact_name = ?').get(account_id, existingInternalThreadId, name);
                  if (isDuplicated) {
                    name = existingName;
                  }
                }

                if (!name || isInvalidContactName(name)) {
                  name = existingName || 'Khách hàng';
                }
                // Preview RAW từ sidebar trước khi bị thay bằng tin cũ trong DB:
                // tin ảnh/video thuần cho preview rỗng, cleanLastMsg dưới đây sẽ
                // lấy lại text cũ trong DB nên KHÔNG dùng được cho phát hiện media.
                const rawSidebarPreview = cleanMessageText(t.last_message);
                let cleanLastMsg = cleanMessageText(t.last_message);
                if (!cleanLastMsg || isSystemOrMetadataText(cleanLastMsg) || cleanLastMsg === 'Đang tải...') {
                  const dbMsgs = db.prepare(`
                    SELECT content, media_url FROM messages
                    WHERE thread_id = ?
                    ORDER BY timestamp_ms DESC, created_at DESC, id DESC
                    LIMIT 10
                  `).all(existingInternalThreadId);

                  // A media message with no caption is a valid "last message" too -
                  // preview it as [Ảnh] instead of falling through to an older text
                  // message or "Chưa có tin nhắn".
                  const validInDb = dbMsgs.find(m => {
                    if (m.media_url) return true;
                    const c = cleanMessageText(m.content);
                    return c && !isSystemOrMetadataText(c) && c !== 'Đang tải...';
                  });

                  cleanLastMsg = validInDb
                    ? (cleanMessageText(validInDb.content) || (validInDb.media_url ? '[Ảnh]' : ''))
                    : 'Chưa có tin nhắn';
                }

                // Phải tính TRƯỚC isChangedIncomingSidebarPreview: bypass
                // same-preview chỉ được nổ ở nhịp CHUYỂN ĐỔI sang "Bây giờ"
                // (rowFreshNew), nếu dùng raw fresh thì MỖI nhịp quét 2s
                // trong ~60s row còn "Bây giờ" đều tính là tin mới -> ngập
                // hàng đợi sync 177 sidebar_incoming/9 phút -> app lag, bắt
                // chậm (reproduce 2026-10-02 14:27-14:36).
                const rowFresh = isFreshRowTimeText(t.row_time_text);
                const rowTimeNow = String(t.row_time_text || '');
                const rowBumpKey = account_id + ':' + existingInternalThreadId;
                const rowTimePrev = rowTimePrevSeen.get(rowBumpKey) || '';
                rowTimePrevSeen.set(rowBumpKey, rowTimeNow);
                if (rowTimePrevSeen.size > 800) rowTimePrevSeen.clear();
                const rowFreshNew = rowFresh && !isFreshRowTimeText(rowTimePrev);
                const normalizedPreviousThread = previousThread
                  ? { ...previousThread, last_message: cleanMessageText(previousThread.last_message) }
                  : null;
                const isActivitySummary = isSidebarActivitySummary(t.last_message);
                const hasStrongIncomingSignal = Number(t.is_unread) === 1 || t.is_like === true;
                const needsOutboundEchoLookup = Boolean(
                  normalizedPreviousThread
                  && cleanLastMsg
                  && normalizedPreviousThread.last_message !== cleanLastMsg
                  && !isActivitySummary
                  && t.preview_is_outgoing !== true
                  && !hasStrongIncomingSignal
                );
                const hasRecentMatchingOutbound = needsOutboundEchoLookup
                  ? ConversationRepository.hasRecentMatchingOutgoing(existingInternalThreadId, cleanLastMsg, db, {
                      // Sidebar timestamps are synthetic. A hidden Messenger tab
                      // can expose an older self-preview many minutes later; hold
                      // that provisional echo until native history confirms it.
                      windowMs: 60 * 60 * 1000
                    })
                  : false;
                const incomingPreviewChanged = isChangedIncomingSidebarPreview({
                  previousThread: normalizedPreviousThread,
                  incomingThread: t,
                  cleanLastMessage: cleanLastMsg,
                  isActivitySummary,
                  hasRecentMatchingOutbound,
                  rowFreshNew
                });
                const pageSourceId = (threadPageId || t.source_type === 'page_messenger') ? ('src_page_' + (threadPageId || '')) : null;
                // Cờ đánh tay phải sống qua mọi lần sync, CẢ HAI CHIỀU:
                //  1  = user đánh chưa đọc -> FB báo đã đọc cũng giữ chưa đọc
                // -1  = user đánh đã đọc   -> FB vẫn treo chấm xanh cũng giữ đã đọc
                let syncUnread = t.is_unread;
                if (previousThread) {
                  const manualRow = db.prepare('SELECT unread_manual FROM threads WHERE id = ?').get(existingInternalThreadId);
                  const manual = Number(manualRow?.unread_manual || 0);
                  if (manual === 1) syncUnread = 1;
                  else if (manual === -1) syncUnread = 0;
                }
                // 2026-10-03: hội thoại hệ thống (kết nối/bạn bè/cuộc gọi) FB
                // tự treo chấm xanh -> bộ dò chấm xanh mới bắt cả chấm này và
                // PREVIEW_BUBBLE gắn unread cho thread rác, CRM ngập "chưa
                // đọc" sai. Thread hệ thống CHƯA có tin khách thật: bỏ unread
                // + reset cờ manual để tự heal các cờ rác ghi từ build trước.
                const systemNotice = isSystemConversationNotice(rawSidebarPreview);
                if (systemNotice) {
                  const hasRealIncoming = db.prepare(`
                    SELECT 1 FROM messages
                    WHERE thread_id = ? AND is_outgoing = 0
                      AND fb_message_id NOT LIKE 'sidebar_preview_%'
                    LIMIT 1
                  `).get(existingInternalThreadId);
                  if (!hasRealIncoming) {
                    syncUnread = 0;
                    db.prepare('UPDATE threads SET unread_manual = 0 WHERE id = ? AND unread_manual != 0').run(existingInternalThreadId);
                  }
                }
                const storedThread = ConversationRepository.upsertThread({
                  id: threadId,
                  external_thread_id: t.external_thread_id || threadId,
                  account_id: account_id,
                  source_id: pageSourceId,
                  thread_url: t.thread_url || null,
                  contact_name: name,
                  // Placeholder -> null để COALESCE giữ preview thật trong DB.
                  last_message: (!cleanLastMsg || cleanLastMsg === 'Chưa có tin nhắn') ? null : cleanLastMsg,
                  is_unread: syncUnread,
                  inbox_folder: t.inbox_folder || null,
                  inbox_folder_verified: t.inbox_folder_verified === true
                });
                const canonicalThreadId = String(storedThread?.id || existingInternalThreadId);

                // Page thread bắt buộc phải mang page_id vào job, nếu không
                // scheduler route nhầm sang lane cá nhân (tab Messenger cá
                // nhân không mở được hội thoại Page -> thread_route_mismatch
                // / page_locked_by_user_action lặp vô hạn, khách Page không
                // bao giờ sync - reproduce 2026-09-30).
                const boundPageSource = ConversationRepository.getThreadSource(canonicalThreadId);
                // rowFresh/rowFreshNew đã tính ở trên (trước bộ dò). Flip
                // unread 0->1/thread mới cũng là bằng chứng tin vừa đến;
                // cả hai gắn vào push để nhánh bubble biết phải bump thread
                // cả khi bong bóng provisional bị chặn.
                const unreadFlippedToIncoming = previousThread
                  ? Number(previousThread.is_unread) !== 1
                  : true;
                if (incomingPreviewChanged) {
                  changedUnreadThreads.push({
                    account_id,
                    thread_id: canonicalThreadId,
                    external_thread_id: t.external_thread_id || threadId,
                    thread_url: t.thread_url || previousThread?.thread_url || null,
                          contact_name: name || previousThread?.contact_name || null,
                    page_id: threadPageId || (boundPageSource?.pageId ?? null),
                    preview_content: cleanLastMsg,
                    preview_is_like: t.is_like === true,
                    row_fresh: rowFresh,
                    row_fresh_new: rowFreshNew,
                    unread_flipped: unreadFlippedToIncoming
                  });
                }

                // Ảnh/video thuần: sidebar chỉ hiện thumbnail (0 text preview)
                // nên isChangedIncomingSidebarPreview luôn false - nếu chỉ chạy
                // theo bubble thì history sync không bao giờ được enqueue và
                // media của khách chỉ vào CRM khi ai đó bấm vào hội thoại.
                // Unread flip + preview rỗng = khách vừa gửi media: vẫn đẩy vào
                // hàng sync (không tạo bubble text giả). Guard tin thật 90s chặn
                // re-enqueue sau khi media đã về DB; flip tự tắt khi is_unread=1
                // được ghi lại nên sweep không bắn lặp.
                // Thread đã unread sẵn thì không còn flip để bắt - dòng thời
                // gian "Bây giờ" trên row là bằng chứng tin vừa đến.
                const mediaHintKey = `${account_id}:${canonicalThreadId}`;
                const mediaHintLastAt = mediaHintLastSeen.get(mediaHintKey) || 0;
                if (mediaHintLastSeen.size > 600) mediaHintLastSeen.clear();
                if (!incomingPreviewChanged
                  && (!rawSidebarPreview || (isSystemOrMetadataText(rawSidebarPreview) && !systemNotice))
                  && t.preview_is_outgoing !== true
                  && (Number(t.is_unread) === 1 || t.is_like === true)
                  && (unreadFlippedToIncoming || rowFresh)
                  && Date.now() - mediaHintLastAt > 90 * 1000) {
                  const recentRealIncoming = db.prepare(`
                    SELECT 1 FROM messages
                    WHERE thread_id = ? AND is_outgoing = 0
                      AND fb_message_id NOT LIKE 'sidebar_preview_%'
                      AND timestamp_ms >= ?
                    LIMIT 1
                  `).get(existingInternalThreadId, Date.now() - 90 * 1000);
                  if (!recentRealIncoming) {
                    mediaHintLastSeen.set(mediaHintKey, Date.now());
                    changedUnreadThreads.push({
                      account_id,
                      thread_id: canonicalThreadId,
                      external_thread_id: t.external_thread_id || threadId,
                      thread_url: t.thread_url || previousThread?.thread_url || null,
                      contact_name: name || previousThread?.contact_name || null,
                      page_id: threadPageId || (boundPageSource?.pageId ?? null),
                      preview_content: '',
                      preview_is_like: t.is_like === true,
                      media_only_hint: true,
                      row_time_text: t.row_time_text || null,
                      row_fresh: rowFresh,
                      unread_flipped: unreadFlippedToIncoming
                    });
                  }
                }

                // Auto-bind Page source nếu thread đến từ Business Suite
                if (threadPageId || t.source_type === 'page_messenger') {
                  try {
                    InboxSourceService.ensurePageSource({
                      pageId: String(threadPageId || ''),
                      accountId: account_id,
                      threadId: canonicalThreadId,
                      canonicalThreadId,
                      pageName: t.page_name || null
                    }, db);
                    // Owner vừa được gắn/binding xác nhận -> mở gate READY cho
                    // lane Page (không phải chờ tab reload để bắn READY lại).
                    if (threadPageId) InboxSyncScheduler.markPageReady(String(threadPageId), account_id);
                  } catch (psErr) {
                    console.warn('[PAGE_SOURCE] Lỗi bind thread từ sync:', psErr.message);
                  }
                }
                
                const currentContact = db.prepare('SELECT avatar_url FROM contacts WHERE thread_id = ?').get(canonicalThreadId);
                let initialAvatar = currentContact?.avatar_url || null;
                if (t.avatar_url && typeof t.avatar_url === 'string' && t.avatar_url.startsWith('http')) {
                  initialAvatar = t.avatar_url;
                }
                db.prepare(`
                  INSERT INTO contacts (thread_id, name, avatar_url)
                  VALUES (?, ?, ?)
                  ON CONFLICT(thread_id) DO UPDATE SET
                    name = excluded.name,
                    avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url)
                `).run(canonicalThreadId, name, initialAvatar);
              }
            });
            txn(account_id, threads);
            syncDebug('PREVIEW_CHANGED', { status: sync_status || null, changed: changedUnreadThreads.length });

            // Render the trusted unread/sidebar-Like preview immediately.
            // The repository later promotes this sidebar_preview_* row to
            // Facebook's native id when history sync confirms the same text.
            for (const changed of changedUnreadThreads) {
              const previewContent = cleanMessageText(changed.preview_content);
              const canonicalThreadId = resolveInternalThreadId(db, changed.account_id, changed.thread_id, changed.page_id || null) || changed.thread_id;
              if (previewContent && !/^[\s\u00b7\u2022.\-|•·]+$/.test(previewContent)) {
                const previewTimestamp = Date.now();
                const previewHash = crypto.createHash('sha1')
                  .update(String(changed.account_id) + '|' + String(canonicalThreadId) + '|' + previewContent)
                  .digest('hex').slice(0, 16);
                // Stable per thread+content: repeated sidebar scans cannot
                // manufacture duplicate provisional bubbles from old previews.
                const previewId = 'sidebar_preview_' + previewHash;
                // Sau mỗi lần CRM gửi tin (text/video), last_message của thread
                // đổi sang tin outgoing nên preview cũ của khách (đã được bắt
                // bằng fb_message_id thật) lại nhìn "thay đổi" với bộ dò sidebar
                // và sinh bong bóng provisional trùng nội dung (reproduced
                // 2026-09-17: gửi video xong, tin cũ của khách hiện lại lần
                // nữa). Nếu thread đã có tin thật (không phải provisional) cùng
                // nội dung trong 24h thì bỏ qua - history sync vẫn chạy phía
                // dưới và sẽ confirm/promote row sẵn có thay vì tạo mới.
                const alreadyRealIncoming = db.prepare(`
                  SELECT 1 FROM messages
                  WHERE thread_id = ? AND is_outgoing = 0 AND content = ?
                    AND fb_message_id NOT LIKE 'sidebar_preview_%'
                    AND timestamp_ms >= ?
                  LIMIT 1
                `).get(canonicalThreadId, previewContent, previewTimestamp - 24 * 60 * 60 * 1000);
                // The sidebar scanner re-reports an OLD operator bubble as
                // fresh customer activity whenever the thread preview flips
                // back to it after a CRM send (reproduced 2026-09-30:
                // 'sldsldsldl' sent 2026-09-22 reappeared the same day as a
                // left-side bubble stamped now). Content that already exists
                // in this thread in ANY direction is never a new message.
                const contentAlreadyInThread = db.prepare(`
                  SELECT 1 FROM messages
                  WHERE thread_id = ? AND content = ?
                    AND fb_message_id NOT LIKE 'sidebar_preview_%'
                  LIMIT 1
                `).get(canonicalThreadId, previewContent);
                if (!alreadyRealIncoming && !contentAlreadyInThread) {
                const previewPersistence = ConversationRepository.saveMessagesTransaction(canonicalThreadId, [{
                  fb_message_id: previewId,
                  content: previewContent,
                  media_type: 'text',
                  timestamp_ms: previewTimestamp,
                  timestamp_source: 'realtime_fallback',
                  created_at: new Date(previewTimestamp).toISOString(),
                  is_outgoing: false,
                  sender_role: 'customer',
                  direction_status: 'confirmed',
                  source: 'sidebar_preview'
                }], db);
                if (previewPersistence.insertedIds.includes(previewId)) {
                  // CHỈ tin mới thật sự (chưa có trong DB) mới được gắn cờ dính
                  // chưa đọc + đẩy lên đầu. Tin cũ bị quét lại không được phép.
                  db.prepare('UPDATE threads SET last_activity = CURRENT_TIMESTAMP, is_unread = 1, unread_manual = 1 WHERE id = ?').run(String(canonicalThreadId));
                  io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(canonicalThreadId), is_unread: 1, last_activity: new Date().toISOString() });
                  const previewRow = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(previewId);
                  if (previewRow) {
                    io.emit('NEW_MESSAGE', { ...previewRow, account_id: changed.account_id, provisional: true });
                    io.emit('THREAD_MESSAGES_UPDATED', { thread_id: canonicalThreadId, account_id: changed.account_id });
                    syncDebug('PREVIEW_BUBBLE', {
                      thread: String(canonicalThreadId).substring(0, 24),
                      content: sanitizeLog(previewContent, 60),
                      status: sync_status || null,
                      latency_ms: msg.data?.observed_at ? Date.now() - Number(msg.data.observed_at) : null
                    });
                    const { threadId: capturedThreadId, createdCaptures } = PhoneCaptureService.processIncomingMessage({
                      threadId: canonicalThreadId,
                      accountId: changed.account_id,
                      messageId: previewId,
                      content: previewContent,
                      messageTimestampMs: previewTimestamp
                    }, { database: db });
                    if (createdCaptures.length > 0) {
                      const phoneView = PhoneCaptureService.getContactPhoneView(capturedThreadId, db);
                      io.emit('PHONE_CAPTURED', {
                        thread_id: capturedThreadId,
                        captures: createdCaptures,
                        phone: phoneView.phone,
                        phone_source: phoneView.phone_source,
                        phone_captured_at: phoneView.phone_captured_at,
                        phone_capture: phoneView.phone_capture,
                        phone_candidates: phoneView.phone_candidates
                      });
                    }
                    const campaignResponse = CampaignResponseStatsService.recordIncomingResponse({
                      messageId: previewRow.id,
                      threadId: canonicalThreadId,
                      accountId: changed.account_id,
                      observedAtMs: previewTimestamp
                    }, db);
                    if (campaignResponse) io.emit('CAMPAIGN_RESPONSE_UPDATED', {
                      ...campaignResponse,
                      thread_id: canonicalThreadId,
                      provisional: true,
                      phone_captured: createdCaptures.length > 0
                    });
                  }
                }
                } else if (changed.row_fresh_new || changed.unread_flipped) {
                  // Tin lặp nội dung cũ ("ok", "dạ") không được tạo bong bóng
                  // provisional, nhưng khi tin THẬT vừa đến thì thread vẫn
                  // phải nhảy + badge ngay (reproduce 2026-10-02: khách nhắn
                  // "ok" lần 2, CRM im lặng 1p47s).
                  // Chỉ bump khi thread còn unread trong DB, preview khác
                  // last_message đã lưu, HOẶC chấm chưa đọc vừa xuất hiện
                  // (unread_flipped). 2026-10-03: với bộ dò chấm xanh mới,
                  // khách nhắn lại đúng câu cũ ("ok", "dạ") trên thread đã
                  // đọc phải bump được - flip chỉ nổ đúng 1 lần khi chấm
                  // chuyển 0->1 nên không tái diễn "đọc rồi hiện lại" (45b).
                  const readState = db.prepare('SELECT is_unread, last_message FROM threads WHERE id = ?').get(String(canonicalThreadId));
                  const isUnreadNow = Number(readState?.is_unread) === 1;
                  const lastMsgMatches = cleanMessageText(readState?.last_message) === previewContent;
                  if (isUnreadNow || !lastMsgMatches || changed.unread_flipped) {
                    const bumpedAtIso = new Date().toISOString();
                    db.prepare('UPDATE threads SET last_activity = CURRENT_TIMESTAMP, is_unread = 1, unread_manual = 1 WHERE id = ?').run(String(canonicalThreadId));
                    io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(canonicalThreadId), is_unread: 1, last_activity: bumpedAtIso });
                    syncDebug('PREVIEW_BUMP_REPEAT', { thread: String(canonicalThreadId).substring(0, 24), content: sanitizeLog(previewContent, 40), status: sync_status || null });
                  }
                }

                if (!previewContent && changed.media_only_hint) {
                // Media-only: không có bubble để render, nhưng tin thật đã đến
                // - bump hội thoại lên đầu cột trái + gắn chưa đọc ngay.
                const bumpedAtIso = new Date().toISOString();
                db.prepare('UPDATE threads SET last_activity = CURRENT_TIMESTAMP, is_unread = 1, unread_manual = 1 WHERE id = ?').run(String(canonicalThreadId));
                io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(canonicalThreadId), is_unread: 1, last_activity: bumpedAtIso });
                syncDebug('MEDIA_HINT', { thread: String(canonicalThreadId).substring(0, 24), status: sync_status || null });
              }

              if (changed.page_id) {
                // 2026-10-03: chỉ job Page còn được điều hướng từ hint (lane
                // Page dùng tab Business Suite riêng). Job cá nhân bỏ hẳn - tab
                // history cá nhân chỉ di chuyển theo operator (click/kéo);
                // preview + bump đã chạy ở trên, nội dung đầy đủ sync khi click
                // (crm_navigation) hoặc khi hội thoại đang mở ở tab chat.
                InboxSyncScheduler.enqueueThreadSync({
                  ...changed,
                  thread_id: canonicalThreadId,
                  reason: 'sidebar_incoming',
                allow_navigation: true,
                priority: 'high',
                sync_mode: 'incremental'
                });
              }
            }
            }

            for (const t of threads) {
              const threadId = String(t.id || t.thread_id || '');
              if (!threadId) continue;
              const canonicalThreadId = resolveInternalThreadId(db, account_id, threadId, t.page_id || msg.data?.page_id || null) || threadId;
              const avatarData = t.avatar_base64 || t.avatar_url;
              if (avatarData) {
                saveAvatarFromBase64OrUrl(avatarData, canonicalThreadId).then(localFilename => {
                  if (localFilename) {
                    db.prepare('UPDATE contacts SET avatar_url = ? WHERE thread_id = ?').run(localFilename, canonicalThreadId);
                    io.emit('CONTACT_UPDATED', { thread_id: canonicalThreadId, avatar_url: localFilename });
                  }
                }).catch(() => {});
              }
            }
          }
          const allThreads = db.prepare(`
            SELECT t.*, c.phone, c.email, c.address, c.tags, c.lead_captured, c.avatar_url,
              c.status_id, ls.name AS status_name, ls.color AS status_color,
              r.due_at AS reminder_due_at, r.note AS reminder_note, r.status AS reminder_status,
              s.source_type, s.display_name AS source_name, s.status AS source_status,
              s.external_id AS source_external_id,
              CASE WHEN s.source_type = 'page_messenger' THEN s.external_id ELSE NULL END AS page_id
            FROM threads t
            LEFT JOIN contacts c ON c.thread_id = t.id
            LEFT JOIN lead_statuses ls ON ls.id = c.status_id
            LEFT JOIN conversation_reminders r ON r.thread_id = t.id AND r.status = 'active'
            LEFT JOIN inbox_sources s ON s.id = t.source_id
            WHERE t.account_id = ?
            ORDER BY julianday(t.last_activity) DESC, t.id DESC
          `).all(account_id);
          // Realtime jobs used to emit every stored conversation every 350ms.
          // That forced the entire chat view (including videos) to rerender
          // and visibly blink. Full/manual sync keeps the legacy full payload;
          // lightweight jobs emit only rows involved in this result.
          const syncedExternalIds = new Set((threads || []).map((thread) =>
            String(thread.external_thread_id || thread.thread_id || thread.id || '')
          ).filter(Boolean));
          const emittedThreads = isRealtimeSidebarHint
            ? allThreads.filter((thread) =>
                syncedExternalIds.has(String(thread.external_thread_id || thread.id || ''))
                || syncedExternalIds.has(String(thread.id || ''))
              )
            : allThreads;
          io.emit('THREADS_SYNCED', { account_id, threads: emittedThreads });
          console.log(`[WS] Đã emit THREADS_SYNCED lên frontend: ${allThreads.length} threads`);
          if (process.env.FB_CRM_DISABLE_INITIAL_SWEEP !== '1' && (partial !== true || Boolean(msg.data?.page_id))) {
            InitialMessageSweepService.start(account_id);
          }
          break;
        }

        case 'THREAD_MESSAGES_SYNCED': {
          const { account_id, thread_id, messages, reason, mode, cursor, checkpoint, fetched_count, scroll_delta, page_id } = msg.data;
          const routeDetail = msg.data?.route_detail ? ` | header="${String(msg.data.route_detail).slice(0, 80)}"` : '';
          console.log(`[WS] THREAD_MESSAGES_SYNCED: thread=${thread_id} mode=${mode||'full'} count=${messages?.length || 0}${reason ? ` reason=${reason}` : ''}${reason === 'thread_route_mismatch' ? routeDetail : ''}`);
          // Phase C (2026-10-01): ket qua ve = kenh dispatch song 2 chieu, reset
          // bo dem stall (ca count=0 deu tinh - diem quan trong la tin di va ve).
          dispatchStallWatchdog.noteResult(String(account_id || ws.accountId || ''));
          // 2026-10-03: ket qua thanh cong khong mang reason; terminal signal
          // that su nam o checkpoint. no_scroll_growth = vong cuon het ngan
          // sach ma DOM khong moc them; boundary_reached = cham het lich su.
          // Truoc day ca hai deu roi vao null -> scheduler replay vo han moi
          // ~2s (reproduce: crm_scroll_older_replay chay 90s lien, nghẽn CRM).
          const checkpointStopReason = checkpoint ? String(checkpoint.stop_reason || '') : '';
          const schedulerResultReason = reason
            || (checkpointStopReason === 'no_scroll_growth' ? 'no_scroll_growth' : null)
            || (checkpoint && checkpoint.boundary_reached ? 'reached_top' : null);
          InboxSyncScheduler.markThreadSyncResult(account_id, thread_id, schedulerResultReason, page_id || null);

          if (reason) {
            const HistorySyncManager = require('./services/HistorySyncManager');
            HistorySyncManager.updateSyncStatus(thread_id, 'FAILED', null, reason);
            console.log(`[WS] History sync failed for thread=${thread_id}; automatic retry is disabled.`);

            // Always finish the CRM request, even when Facebook navigation or
            // its virtualized DOM was not ready. Keep all persisted messages.
            const persistedRows = db.prepare(`
              SELECT * FROM messages WHERE thread_id = ?
              ORDER BY COALESCE(sequence_order, id) ASC, id ASC
            `).all(thread_id);
            io.emit('THREAD_MESSAGES_UPDATED', {
              thread_id,
              account_id,
              messages: prepareMessagesForClient(persistedRows),
              authoritative: true,
              sync_status: 'FAILED',
              sync_error: reason
            });
            // marker_mismatch/sidebar_mismatch/no_rows/no_main_container are DOM-timing
            // flukes that usually clear up on their own; error_screen means Facebook
            // itself is blocking the content, which is permanent and must not retry.
            const TRANSIENT_REASONS = new Set(['marker_mismatch', 'sidebar_mismatch', 'no_rows', 'no_main_container', 'url_mismatch', 'navigation_superseded']);
            // Navigation-lock rejections are temporary by design: the extension
            // holds the history/Business Suite tab on the thread the operator just
            // clicked for a 30s window. Retrying while that window is still open
            // is pointless, so these use a backoff that lands after it expires.
            const LOCK_WINDOW_REASONS = new Set(['navigation_locked_by_user_selection', 'page_locked_by_user_action']);
            const LOCK_WINDOW_BACKOFF_MS = [35000, 45000, 60000];
            // 2026-09-29: thread Page CHUA TUNG CO DU LIEU (msgs=0) that bai voi
            // thread_route_mismatch / extension_history_timeout khi xac minh
            // danh tinh hoi thoai lanh (chua tung mo) - mark vinh vien lam hoi
            // thoai moi treo trong mai (reproduce: Vung Vu Vuong page 768).
            // Chi 2 reason nay duoc retry khi thread con trong; thread da co
            // du lieu giu nguyen chinh sach cu de tranh tai quet vo ich.
            const COLD_RETRYABLE_REASONS = new Set(['thread_route_mismatch', 'extension_history_timeout']);
            const coldThreadNoMessages = COLD_RETRYABLE_REASONS.has(reason)
              && db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(thread_id).n === 0;
            if (TRANSIENT_REASONS.has(reason) || coldThreadNoMessages || LOCK_WINDOW_REASONS.has(reason)) {
              const scheduled = HistorySyncRetryPolicy.scheduleRetry(account_id, thread_id, () => {
                // A retry also performs tab navigation. Default transient retries
                // are cancelled when the operator has since clicked a different
                // thread (navigated_away guard). Lock-window retries bypass that
                // guard: the extension's own 30s navigation lock protects the
                // just-clicked thread, and their backoff lands after it expires.
                const extWs = extensionConnections.get(account_id);
                if (!extWs || extWs.readyState !== WebSocket.OPEN) {
                  console.warn(`[HISTORY_SYNC_RETRY_SKIPPED] thread=${thread_id} reason=extension_not_ready`);
                  return;
                }
                const threadRow = db.prepare('SELECT thread_url, contact_name FROM threads WHERE id = ?').get(thread_id);
                const pageSource = ConversationRepository.getThreadSource(thread_id);
                extWs.send(JSON.stringify({
                  type: 'SYNC_THREAD_MESSAGES',
                  data: {
                    account_id,
                    thread_id,
                    thread_url: threadRow?.thread_url || null,
                    page_id: pageSource?.pageId || null,
                    mode,
                    cursor,
                    contact_name: threadRow?.contact_name || null,
                    reason: 'history_retry',
                    allow_navigation: true
                  }
                }));
                console.log(`[WS] Retry sync tin nhắn cho thread ${thread_id} (account ${account_id}) mode=${mode}`);
              }, LOCK_WINDOW_REASONS.has(reason) ? LOCK_WINDOW_BACKOFF_MS : null, LOCK_WINDOW_REASONS.has(reason));
              if (!scheduled) {
                console.log(`[WS] Không retry điều hướng thread ${thread_id} (reason=${reason}, đã hết lượt); chờ click/yêu cầu mới.`);
              }
            } else {
              console.log(`[WS] Không retry điều hướng thread ${thread_id} (reason=${reason}, lỗi vĩnh viễn); chờ click/yêu cầu mới.`);
            }
            return; // Không ghi đè hoặc emit UI
          }

          HistorySyncRetryPolicy.cancelRetry(thread_id);

          const HistorySyncManager = require('./services/HistorySyncManager');
          let resolvedSyncStatus = null;
          
          if (Array.isArray(messages) && messages.length > 0) {
            let validMessages = messages.map(m => ({ ...m, content: cleanMessageText(m.content) }))
              .filter(m => {
                if (String(m.thread_id || thread_id) !== String(thread_id)) return false;
                if (!isRenderableStoredMessage(m)) return false;
                if (isRecentOutgoingTextEcho(thread_id, m, db)) {
                  console.log(`[WS] History Guard: skip CRM outbound text echo parsed as incoming: thread=${thread_id} content="${sanitizeLog(m.content, 60)}"`);
                  return false;
                }
                return true;
              });

            // A successful image/video send may first return through the
            // on-demand history scraper instead of the realtime observer.
            // Confirm the CRM-owned pending row here and do not persist a
            // second Facebook echo row; otherwise the timeout marks it failed
            // and a manual retry sends the same media again.
            validMessages = validMessages.filter((historyMessage) => {
              const mediaType = String(historyMessage.media_type || 'text').toLowerCase();
              if (!historyMessage.is_outgoing || !['image', 'video'].includes(mediaType) || !historyMessage.fb_message_id) {
                return true;
              }
              const observationTime = Number(historyMessage.timestamp_ms)
                || Date.parse(historyMessage.created_at || '')
                || Date.now();
              const confirmation = OutboundConfirmationService.confirmObservation({
                threadId: thread_id,
                fbMessageId: historyMessage.fb_message_id,
                isOutgoing: true,
                mediaType,
                content: historyMessage.content || '',
                observedAt: observationTime,
                confirmationSource: 'personal_dom'
              }, { database: db });
              if (confirmation.matched) {
                const confirmedMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(confirmation.message_id);
                io.emit('MESSAGE_SENT', {
                  thread_id,
                  client_message_id: confirmation.client_message_id,
                  fb_message_id: confirmation.fb_message_id,
                  status: 'sent'
                });
                if (confirmedMessage) io.emit('NEW_MESSAGE', withAttachmentAccessUrl({
                  ...confirmedMessage,
                  status: 'sent'
                }));
                console.log('[OUTBOUND_TRACE]', JSON.stringify({
                  stage: 'BACKEND_HISTORY_MEDIA_CONFIRMED',
                  thread_id: String(thread_id),
                  client_message_id: confirmation.client_message_id,
                  fb_message_id: confirmation.fb_message_id,
                  media_type: mediaType,
                  at: new Date().toISOString()
                }));
                return false;
              }
              return true;
            });

            const threadRow = db.prepare('SELECT id, account_id FROM threads WHERE id = ?').get(thread_id);
            if (!threadRow) {
              ConversationRepository.upsertThread({
                id: String(thread_id),
                account_id,
                contact_name: 'Khách hàng',
                is_unread: false
              });
            }
            
            const sequenceBounds = db.prepare(`
              SELECT MIN(COALESCE(sequence_order, id)) AS min_sequence,
                     MAX(COALESCE(sequence_order, id)) AS max_sequence
              FROM messages WHERE thread_id = ?
            `).get(thread_id);
            const existingSequences = new Map(db.prepare(
              'SELECT fb_message_id, COALESCE(sequence_order, id) AS sequence_order FROM messages WHERE thread_id = ?'
            ).all(thread_id).map((row) => [String(row.fb_message_id || ''), Number(row.sequence_order)]));
            let olderSequence = Number(sequenceBounds?.min_sequence || 0) - validMessages.length - 1;
            let newerSequence = Number(sequenceBounds?.max_sequence || 0);
            const { isOlderHistoryBatch } = require('./services/HistoryViewportDirection');
            const isOlderBatch = isOlderHistoryBatch(mode, scroll_delta);
            // Preserve the order of a partially mounted Facebook window. New
            // rows can sit between two messages already stored; appending all
            // of them after max_sequence is what previously moved incoming
            // messages to the wrong place. Fractional ranks are supported by
            // SQLite and let us insert between stable anchors without
            // rewriting any existing row.
            const nextKnownSequence = new Array(validMessages.length).fill(null);
            let upcomingKnown = null;
            for (let index = validMessages.length - 1; index >= 0; index--) {
              const known = existingSequences.get(String(validMessages[index].fb_message_id || ''));
              if (Number.isFinite(known)) upcomingKnown = known;
              nextKnownSequence[index] = upcomingKnown;
            }
            let previousKnown = null;
            const sequencedMessages = validMessages.map((message, index) => {
              const existingSequence = existingSequences.get(String(message.fb_message_id || ''));
              let sequenceOrder = existingSequence;
              if (Number.isFinite(existingSequence)) {
                previousKnown = existingSequence;
              } else {
                const nextKnown = nextKnownSequence[index];
                let segmentLength = 1;
                while (index + segmentLength < validMessages.length
                  && !Number.isFinite(existingSequences.get(String(validMessages[index + segmentLength].fb_message_id || '')))) {
                  segmentLength += 1;
                }
                if (Number.isFinite(previousKnown) && Number.isFinite(nextKnown) && nextKnown > previousKnown) {
                  sequenceOrder = previousKnown + (nextKnown - previousKnown) / (segmentLength + 1);
                  previousKnown = sequenceOrder;
                } else if (Number.isFinite(nextKnown)) {
                  sequenceOrder = nextKnown - segmentLength;
                  previousKnown = sequenceOrder;
                } else if (Number.isFinite(previousKnown)) {
                  sequenceOrder = previousKnown + 1;
                  previousKnown = sequenceOrder;
                  newerSequence = Math.max(newerSequence, sequenceOrder);
                } else {
                  sequenceOrder = isOlderBatch ? ++olderSequence : ++newerSequence;
                  previousKnown = sequenceOrder;
                }
              }
              return {
                ...message,
                account_id,
                sequence_order: sequenceOrder,
                timestamp_source: message.timestamp_source || 'fallback'
              };
            });
            const persistence = ConversationRepository.saveMessagesTransaction(thread_id, sequencedMessages);
            // History may arrive after realtime already confirmed the local
            // attachment row. Collapse the late Facebook base/_media echo in
            // the same sync window so the UI never renders two copies until
            // the next REST reload.
            // History is also the recovery path when the realtime observer is
            // starved during a campaign. Attribute each newly persisted
            // incoming row first; only an attributed current-campaign reply is
            // allowed to capture a phone, so old history cannot pollute CRM.
            const historyInsertedRows = persistence.insertedIds.length
              ? db.prepare(`
                  SELECT * FROM messages
                  WHERE thread_id = ? AND fb_message_id IN (${persistence.insertedIds.map(() => '?').join(',')})
                    AND is_outgoing = 0
                `).all(thread_id, ...persistence.insertedIds)
              : [];
            for (const incomingRow of historyInsertedRows) {
              const observedAtMs = Number(incomingRow.timestamp_ms) || Date.parse(incomingRow.created_at || '') || Date.now();
              const campaignResponse = CampaignResponseStatsService.recordIncomingResponse({
                messageId: incomingRow.id,
                threadId: thread_id,
                accountId: account_id,
                observedAtMs
              }, db);
              if (!campaignResponse) continue;
              const { threadId: capturedThreadId, createdCaptures } = PhoneCaptureService.processIncomingMessage({
                threadId: thread_id,
                accountId: account_id,
                messageId: incomingRow.fb_message_id,
                content: incomingRow.content,
                messageTimestampMs: observedAtMs
              }, { database: db });
              if (createdCaptures.length > 0) {
                const phoneView = PhoneCaptureService.getContactPhoneView(capturedThreadId, db);
                io.emit('PHONE_CAPTURED', {
                  thread_id: capturedThreadId,
                  captures: createdCaptures,
                  phone: phoneView.phone,
                  phone_source: phoneView.phone_source,
                  phone_captured_at: phoneView.phone_captured_at,
                  phone_capture: phoneView.phone_capture,
                  phone_candidates: phoneView.phone_candidates
                });
              }
              io.emit('CAMPAIGN_RESPONSE_UPDATED', {
                ...campaignResponse,
                thread_id,
                phone_captured: createdCaptures.length > 0,
                recovered_from_history: true
              });
            }
            // Tin khách VỪA nhắn (trong 10 phút) mà chỉ đến được qua sync lịch
            // sử - kênh realtime lỡ mất vì tab Facebook đang đậu đúng thread
            // đó nên Facebook tự đánh dấu đã đọc. Bật chưa đọc + phát socket
            // để hội thoại được đẩy lên đầu danh sách ngay.
            const hasRecentIncomingHistory = historyInsertedRows.some((r) => {
              const atMs = Number(r.timestamp_ms) || Date.parse(r.created_at || '') || 0;
              return atMs >= Date.now() - 10 * 60 * 1000;
            });
            if (hasRecentIncomingHistory) {
              const historyManualState = db.prepare('SELECT unread_manual FROM threads WHERE id = ?').get(thread_id);
              // Chỉ gắn chưa đọc khi user CHƯA từng đọc tay (manual = 0).
              // manual = -1 nghĩa là user vừa mở/đánh dấu đã đọc: history sync
              // chèn chính tin khách mà user đang đọc, nếu gắn lại is_unread
              // thì hội thoại đã đọc lại nhảy lên đầu đánh dấu chưa đọc sau
              // mỗi lần reload. manual = 1 thì cờ dính tin mới đã bật rồi.
              if (Number(historyManualState?.unread_manual || 0) === 0) {
                db.prepare('UPDATE threads SET is_unread = 1, unread_manual = 0 WHERE id = ?').run(thread_id);
                io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(thread_id), is_unread: 1 });
              }
            }
            const collapsedMediaCompanions = OutboundDomCorrelationService.collapseStoredMediaCompanions(db, thread_id);
            const collapsedTemporaryIds = OutboundDomCorrelationService.collapseStoredTemporaryIdUpgrades(db, thread_id);
            const reconciledDomRows = ConversationRepository.reconcileObservedDomSequence(thread_id, sequencedMessages, db);
            // A DOM page numbers its rows locally from zero. Merging multiple
            // pages and realtime rows otherwise leaves duplicate/gapped ranks,
            // which makes old messages appear below newer ones in the CRM.
            ConversationRepository.normalizeMessageSequence(thread_id, db);
            if (collapsedMediaCompanions || collapsedTemporaryIds) {
              console.log('[OUTBOUND_TRACE]', JSON.stringify({
                stage: 'BACKEND_HISTORY_MEDIA_ECHO_COLLAPSED',
                thread_id: String(thread_id),
                  media_companions: collapsedMediaCompanions,
                  temporary_ids: collapsedTemporaryIds,
                  reordered_dom_rows: reconciledDomRows,
                at: new Date().toISOString()
              }));
            }
            // Publish the snapshot immediately. Persisting Facebook media is
            // background work; a large or expired video URL must not block
            // history sync or the outbound composer.
            inboundMediaHydration.hydrateThread(thread_id);
            const deltaIds = [...persistence.insertedIds, ...persistence.updatedIds];
            const fetchedTotal = Number.isFinite(Number(fetched_count)) ? Number(fetched_count) : messages.length;
            const skippedTotal = Math.max(0, fetchedTotal - deltaIds.length);
            console.log(`[WS] Diagnostics thread=${thread_id}: fetched=${fetchedTotal} inserted=${persistence.insertedIds.length} updated=${persistence.updatedIds.length} skipped=${skippedTotal}`);

            if (checkpoint) {
              resolvedSyncStatus = HistorySyncManager.resolveStatusFromCheckpoint(checkpoint);
              HistorySyncManager.updateSyncStatus(thread_id, resolvedSyncStatus, checkpoint);
              console.log(`[WS] History sync status thread=${thread_id}: ${resolvedSyncStatus} (stop_reason=${checkpoint.stop_reason || 'n/a'})`);
            }

            const latest = validMessages.reduce((currentLatest, candidate) => {
              if (!currentLatest) return candidate;
              const candidateTime = Number(candidate.timestamp_ms) || new Date(candidate.created_at || 0).getTime();
              const latestTime = Number(currentLatest.timestamp_ms) || new Date(currentLatest.created_at || 0).getTime();
              return candidateTime >= latestTime ? candidate : currentLatest;
            }, null);
            if (latest) {
              const latestTimestamp = Number(latest.timestamp_ms) || new Date(latest.created_at || 0).getTime();
              ConversationRepository.touchThreadFromHistory(thread_id, latest.content, latestTimestamp);
            }

            if (deltaIds.length === 0) {
              // Overlapping virtual pages can contain only rows already in
              // SQLite. The checkpoint may still have advanced, so keep the
              // continuation state machine alive instead of leaving the
              // thread permanently PARTIAL/spinning.
              console.log(`[WS] History page contained no DB delta; continue checkpoint evaluation thread=${thread_id}`);
            }
            // Refresh the CRM from the authoritative DB snapshot after every
            // user-requested history page, including an overlap-only page.
            const syncedRows = db.prepare(`
              SELECT * FROM messages WHERE thread_id = ?
              ORDER BY COALESCE(sequence_order, id) ASC, id ASC
            `).all(thread_id);
            const cleanMsgs = prepareMessagesForClient(syncedRows);

            io.emit('THREAD_MESSAGES_UPDATED', {
              thread_id,
              messages: cleanMsgs,
              authoritative: true,
              sync_status: resolvedSyncStatus
            });
          } else {
             // Empty messages list but no error means we might have reached the end or just no new messages
             if (checkpoint) {
               resolvedSyncStatus = HistorySyncManager.resolveStatusFromCheckpoint(checkpoint);
               HistorySyncManager.updateSyncStatus(thread_id, resolvedSyncStatus, checkpoint);
               console.log(`[WS] History sync status thread=${thread_id}: ${resolvedSyncStatus} (stop_reason=${checkpoint.stop_reason || 'n/a'})`);
             }
             // A virtualized Messenger viewport can briefly expose zero rows
             // while React swaps pages. Zero newly parsed rows does not mean
             // the authoritative thread is empty. Re-emit the persisted
             // snapshot so the CRM never wipes or freezes its existing list.
             const persistedRows = db.prepare(`
               SELECT * FROM messages WHERE thread_id = ?
               ORDER BY COALESCE(sequence_order, id) ASC, id ASC
             `).all(thread_id);
             io.emit('THREAD_MESSAGES_UPDATED', {
               thread_id,
               messages: prepareMessagesForClient(persistedRows),
               authoritative: true,
               sync_status: resolvedSyncStatus
             });
          }

          const historyJobKey = String(account_id);
          const activeJob = historyBackfillJobs.get(historyJobKey);
          const isActiveProgressiveJob = activeJob && String(activeJob.threadId) === String(thread_id);
          const checkpointOldestId = String(checkpoint?.oldest_message_id || '');
          if (isActiveProgressiveJob) {
            if (checkpointOldestId && checkpointOldestId !== activeJob.lastOldestMessageId) {
              activeJob.lastOldestMessageId = checkpointOldestId;
              activeJob.stalledBatches = 0;
            } else {
              activeJob.stalledBatches = Number(activeJob.stalledBatches || 0) + 1;
            }
          }
          const transientNoGrowth = resolvedSyncStatus === 'SYNCED'
            && checkpoint?.stop_reason === 'no_scroll_growth'
            && Number(activeJob?.stalledBatches || 0) < 4;
          if ((resolvedSyncStatus === 'PARTIAL' || transientNoGrowth) && isActiveProgressiveJob) {
            const generation = activeJob.generation;
            activeJob.batches += 1;
            if (activeJob.batches <= 500) {
              setTimeout(() => {
                const latestJob = historyBackfillJobs.get(historyJobKey);
                if (!latestJob || latestJob.generation !== generation || String(latestJob.threadId) !== String(thread_id)) return;
                const extWs = extensionConnections.get(account_id);
                if (!extWs || extWs.readyState !== WebSocket.OPEN) return;
                const threadRow = db.prepare('SELECT thread_url, contact_name FROM threads WHERE id = ?').get(thread_id);
                const pageSource = ConversationRepository.getThreadSource(thread_id);
                extWs.send(JSON.stringify({
                  type: 'SYNC_THREAD_MESSAGES',
                  data: {
                    account_id,
                    thread_id,
                    thread_url: threadRow?.thread_url || null,
                    page_id: pageSource?.pageId || null,
                    mode: 'deep_backfill',
                    cursor: checkpoint,
                    contact_name: threadRow?.contact_name || null,
                    reason: 'crm_navigation',
                    allow_navigation: true
                  }
                }));
                console.log(`[WS] Continue deep-backfill batch ${latestJob.batches} for thread=${thread_id}`);
              }, 350);
            } else {
              HistorySyncManager.updateSyncStatus(thread_id, 'FAILED', checkpoint, 'BACKFILL_BATCH_LIMIT');
              historyBackfillJobs.delete(historyJobKey);
            }
          } else if (resolvedSyncStatus === 'SYNCED' && isActiveProgressiveJob) {
            historyBackfillJobs.delete(historyJobKey);
          }
          break;
        }
        case 'PAGE_NAME_DETECTED': {
          const pageId = String(msg.data?.page_id || '');
          const pageName = String(msg.data?.page_name || '').trim();
          if (pageId && pageName) {
            console.log(`[WS] 🏷️ Nhận PAGE_NAME_DETECTED: page=${pageId}, name="${pageName}"`);
            const updatedSource = InboxSourceService.updatePageDisplayName({ pageId, pageName }, db);
            if (updatedSource) {
              io.emit('INBOX_SOURCE_UPDATED', updatedSource);
              io.emit('THREAD_LIST_UPDATED');
            }
          }
          break;
        }
        case 'PAGE_EXTENSION_READY': {
          const pageId = String(msg.data?.page_id || '');
          const accountId = String(ws.accountId || msg.data?.account_id || '');
          const pageName = msg.data?.page_name ? String(msg.data.page_name).trim() : null;
          // Tab fallback /messages/t/<id-giả> (ID profile/delegate 6155xxx-6159xxx)
          // cũng bắn READY - chặn để không tái tạo source page rác.
          if (isSuspiciousPageId(pageId)) {
            console.warn(`[PageSync] Bỏ qua PAGE_EXTENSION_READY với ID profile/delegate ${pageId} (account=${accountId}).`);
            break;
          }
          if (pageId && pageName) {
            InboxSourceService.updatePageDisplayName({ pageId, pageName }, db);
          }
          let source = pageId && accountId ? db.prepare(`
            SELECT id FROM inbox_sources
            WHERE source_type = 'page_messenger' AND status = 'ACTIVE'
              AND external_id = ? AND owner_account_id = ?
          `).get(pageId, accountId) : null;
          if (!source && pageId && accountId) {
            // Page source chưa tồn tại hoặc chưa bind owner (row tự tạo bởi
            // scan Business Suite TRƯỚC khi page được kết nối). Business tab
            // này nằm trong Chrome của account đã đăng ký (ws.accountId) ->
            // tự đăng ký/gắn owner thay vì bỏ qua. Bỏ qua step này tạo deadlock:
            // gate READY chờ PAGE_EXTENSION_READY, mà READY bị từ chối,
            // owner chỉ được bind sau đó bởi sidebar sync -> không bao giờ mở.
            try {
              InboxSourceService.ensurePageSource({ pageId, accountId, pageName }, db);
              source = db.prepare(`
                SELECT id FROM inbox_sources
                WHERE source_type = 'page_messenger' AND status = 'ACTIVE'
                  AND external_id = ? AND owner_account_id = ?
              `).get(pageId, accountId);
              if (source) console.log(`[PageSync] Tự đăng ký/gắn owner page=${pageId} cho account=${accountId} lúc READY.`);
            } catch (regErr) {
              console.warn(`[PageSync] Tự đăng ký page=${pageId} thất bại:`, regErr.message);
            }
          }
          if (!source) {
            console.warn(`[PageSync] Ignored unregistered Page context account=${accountId} page=${pageId}`);
            break;
          }
          const key = pageConnectionKey(accountId, pageId);
          pageExtensionConnections.set(key, ws);
          ws.pageConnectionKeys = ws.pageConnectionKeys || new Set();
          ws.pageConnectionKeys.add(key);
          // Mở gate dispatch cho lane Page này (job đang chờ sẽ được đẩy đi).
          InboxSyncScheduler.markPageReady(pageId, accountId);
          console.log(`[PageSync] Page extension ready account=${accountId} page=${pageId}`);
          if (InboxSyncScheduler.isSyncWindowActive(accountId) && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'SYNC_PAGE_SIDEBAR', data: { account_id: accountId, page_id: pageId, reason: 'page_ready' } }));
          }
          break;
        }
        case 'ACCOUNT_PAGES_DISCOVERED': {
          const accountId = String(msg.data?.account_id || ws.accountId || '');
          const pages = Array.isArray(msg.data?.pages) ? msg.data.pages : [];
          if (!accountId) break;

          // Lọc bỏ tài khoản cá nhân + ID profile/delegate 6155xxx-6159xxx +
          // profile trùng tên chủ account (mở Business Suite bị chặn ngay).
          const accountName = getAccountName(accountId);
          const filteredPages = pages.filter(p => String(p.page_id) !== accountId
            && !isGenericPageName(p?.name)
            && !isSuspiciousPageId(p?.page_id)
            && !isOwnerSelfSourceName(p?.name, accountName));

          console.log(`[WS] 📄 Nhận ACCOUNT_PAGES_DISCOVERED cho account=${accountId}, số trang=${filteredPages.length}`);
          try {
            // Debug file: payload quet thuc te tu extension (raw + sau loc) -
            // dung truy vet page thieu / sai ID ma khong phai doan mo.
            const dump = (tag, list) => JSON.stringify({
              at: new Date().toISOString(),
              tag,
              account_id: accountId,
              count: list.length,
              pages: list.map(p => ({
                id: String(p?.page_id || ''),
                name: String(p?.name || '').slice(0, 90),
                id_source: p?.id_source || null,
                source_url: p?.source_url || null,
                context_id: p?.context_id || null,
                dropped: !!p?.dropped,
                drop_reason: p?.drop_reason || null,
                alias_ids: p?.alias_ids || null,
                url_params: p?.url_params || null,
                raw_fragment: String(p?.raw_fragment || '').slice(0, 1400) || null
              }))
            });
            fs.appendFileSync(path.join(APP_DATA_ROOT, 'discovery-debug.log'), dump('raw', pages) + '\n');
            fs.appendFileSync(path.join(APP_DATA_ROOT, 'discovery-debug.log'), dump('filtered', filteredPages) + '\n');
          } catch (_) {}
          discoveredPagesByAccount.set(accountId, {
            pages: filteredPages,
            updatedAt: Date.now()
          });

          // Tự động gắn owner cho các source NULL trùng page_id hoặc trùng display_name (tận dụng auto-bind)
          try {
            for (const p of filteredPages) {
              const pid = String(p.page_id || '');
              const pname = (p.name || '').trim();
              if (pid) {
                const updated = db.prepare(`
                  UPDATE inbox_sources
                  SET owner_account_id = ?
                  WHERE (external_id = ? OR (display_name = ? AND display_name != ''))
                    AND source_type = 'page_messenger' AND owner_account_id IS NULL
                `).run(accountId, pid, pname);
                if (updated.changes > 0) {
                  console.log(`[WS] 🔗 Đã tự động gắn owner=${accountId} cho page_source=${pid} (${pname})`);
                }
              }
            }
          } catch (bindErr) {
            console.warn('[WS] Lỗi khi auto-bind owner cho pages discovered:', bindErr.message);
          }

          io.emit('PAGES_DISCOVERED', {
            account_id: accountId,
            pages: filteredPages,
            updated_at: Date.now()
          });
          break;
        }
        case 'PAGE_URL_DEBUG': {
          // (Phase 0 debug) Kênh 2: cặp asset_id/mailbox_id thực tế trên URL
          // tab Business Suite - ghi thẳng vào discovery-debug.log.
          try {
            fs.appendFileSync(path.join(APP_DATA_ROOT, 'discovery-debug.log'), JSON.stringify({ at: new Date().toISOString(), tag: 'PAGE_URL_DEBUG', account_id: String(msg.data?.account_id || ws.accountId || ''), asset_id: String(msg.data?.asset_id || ''), mailbox_id: String(msg.data?.mailbox_id || ''), title: String(msg.data?.title || '').slice(0, 90), url: String(msg.data?.url || '').slice(0, 300) }) + '\n');
          } catch (_) {}
          break;
        }
        case 'UPDATE_LINK_PREVIEW_IMAGE': {
          try {
            const { url_hash, image_url, title } = msg.data || {};
            const hash = String(url_hash || '');
            if (!/^[0-9a-f]{40}$/.test(hash)) break;
            const safeTitle = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 200) : null;
            if ((!image_url || !/^https?:\/\//i.test(String(image_url))) && !safeTitle) break;
            // Tai anh ve local - URL lookaside/scontent cua FB la tam thoi
            let stored = String(image_url);
            try {
              const localFile = await saveAvatarFromBase64OrUrl(stored, 'link_' + hash);
              if (localFile) stored = '/api/avatars/' + localFile;
            } catch (_) {}
            db.prepare('UPDATE link_previews SET image_url = COALESCE(?, image_url), title = COALESCE(?, title) WHERE url_hash = ?')
              .run(stored, safeTitle, hash);
            console.log('[LINK_PREVIEW] Ảnh bổ sung từ extension cho hash ' + hash.slice(0, 10) + '…');
          } catch (_) {}
          break;
        }

        case 'UPDATE_PAGE_PROFILE': {
          // Extension mo tab profile Page va doc ten + avatar that ( cung co
          // che voi operator profile). Cap nhat inbox_sources: display_name
          // chi thay the ten generic "Page <id>"; avatar luu qua avatarManager.
          try {
            const { page_id, name, avatar_url } = msg.data || {};
            const pid = String(page_id || '').trim();
            if (!/^\d+$/.test(pid)) break;
            const safeName = (typeof name === 'string' ? name.trim() : '').slice(0, 120);
            const safeAvatar = (typeof avatar_url === 'string' && avatar_url.startsWith('https://')) ? avatar_url : null;
            let avatarFile = null;
            if (safeAvatar) {
              avatarFile = await saveAvatarFromBase64OrUrl(safeAvatar, 'page_' + pid);
            }
            const src = db.prepare("SELECT id, display_name FROM inbox_sources WHERE source_type = 'page_messenger' AND external_id = ?").get(pid);
            if (!src) break;
            const genericName = new RegExp('^Page ' + pid + '$', 'i');
            const nextName = safeName && (!src.display_name || genericName.test(src.display_name)) ? safeName : (safeName || src.display_name);
            db.prepare('UPDATE inbox_sources SET display_name = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?')
              .run(nextName || src.display_name, avatarFile ? '/api/avatars/' + avatarFile : null, src.id);
            io.emit('INBOX_SOURCES_UPDATED', { source_id: src.id, page_id: pid, display_name: nextName || src.display_name, avatar_url: avatarFile ? '/api/avatars/' + avatarFile : null });
            console.log(`[PAGE_SOURCE] Da cap nhat profile Page ${pid}: name="${nextName}", avatar=${avatarFile ? 'yes' : 'no'}`);
          } catch (e) {
            console.warn('[PAGE_SOURCE] UPDATE_PAGE_PROFILE loi:', e.message);
          }
          break;
        }

        case 'PAGE_THREAD_MESSAGES_SYNCED_V1': {
          const envelope = msg.data || {};
          const { verifyPageOwnership } = require('./utils/pageContextResolver');
          const pageThreadId = String(envelope.thread_id || '');
          const authenticatedAccountId = String(ws.accountId || '');
          const pageId = String(envelope.page_id || '');
          const ackBase = { thread_id: pageThreadId, session_epoch: envelope.session_epoch, generation: envelope.generation, scan_id: envelope.scan_id };
          if (!pageThreadId || !pageId || !authenticatedAccountId || (envelope.account_id && String(envelope.account_id) !== authenticatedAccountId)) {
            const ack = { ...ackBase, status: 'rejected', reason: 'invalid_authenticated_page_context' };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
            break;
          }
          try {
            if (!verifyPageOwnership(authenticatedAccountId, pageId, db)) {
              const ack = { ...ackBase, status: 'rejected', reason: 'unauthorized_page_ownership' };
              InboxSyncScheduler.markThreadSyncResult(authenticatedAccountId, pageThreadId, ack.reason);
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
              break;
            }
            const source = InboxSourceService.getSourceByExternalId('page_messenger', pageId, db);
            if (!source || String(source.owner_account_id || '') !== authenticatedAccountId) {
              const ack = { ...ackBase, status: 'rejected', reason: 'page_source_not_registered' };
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
              break;
            }
            // Batch hợp lệ từ tab Business của account -> page đang kết nối thật,
            // mở gate READY (phòng trường hợp READY bị nuốt trước đó).
            InboxSyncScheduler.markPageReady(pageId, authenticatedAccountId);
            const canonicalThreadId = resolveInternalThreadId(db, authenticatedAccountId, pageThreadId, pageId);

            if (envelope.page_name) {
              const updated = InboxSourceService.updatePageDisplayName({ pageId, pageName: envelope.page_name }, db);
              if (updated) {
                io.emit('INBOX_SOURCE_UPDATED', updated);
                io.emit('THREAD_LIST_UPDATED');
              }
            }
            let safePageContactName = cleanContactName(envelope.contact_name, null);
            if (isInvalidContactName(safePageContactName)) safePageContactName = null;
            const existingPageThread = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(canonicalThreadId);
            if (existingPageThread?.contact_name && !isInvalidContactName(existingPageThread.contact_name) && existingPageThread.contact_name !== 'Khách hàng') {
              safePageContactName = safePageContactName || existingPageThread.contact_name;
            }

            // Không bao giờ hạ cấp preview: batch rỗng/rác -> truyền null để
            // upsertThread COALESCE giữ nguyên last_message thật trong DB
            // (trước đây 'Chưa có tin nhắn' đè lên preview thật mỗi lần sync).
            const lastIncomingContent = Array.isArray(envelope.messages) && envelope.messages.length
              ? (cleanMessageText(envelope.messages[envelope.messages.length - 1].content) || null)
              : null;

            // Hard-code is_unread: 0 ở đây từng làm tin nhắn mới của khách
            // qua Page không bao giờ nổi lên (đè trạng thái chưa đọc ngay sau
            // khi kênh realtime bật). Giờ tôn trọng cờ đánh tay + tin mới
            // trong 10 phút qua Page mới bật chưa đọc; còn lại giữ nguyên.
            const pageManualState = db.prepare('SELECT unread_manual FROM threads WHERE id = ?').get(canonicalThreadId);
            const pageManual = Number(pageManualState?.unread_manual || 0);
            const hasRecentIncomingPage = Array.isArray(envelope.messages) && envelope.messages.some((pm) => {
              if (pm.is_outgoing === true || pm.is_outgoing === 1) return false;
              const atMs = Number(pm?.timestamp_ms) || Date.parse(pm?.created_at || '') || 0;
              return atMs >= Date.now() - 10 * 60 * 1000;
            });
            let pageUnreadState;
            if (pageManual === 1) pageUnreadState = 1;
            else if (pageManual === -1) pageUnreadState = 0;
            else pageUnreadState = hasRecentIncomingPage ? 1 : undefined;
            ConversationRepository.upsertThread({
              id: canonicalThreadId,
              external_thread_id: pageThreadId,
              account_id: authenticatedAccountId,
              source_id: source.id,
              contact_name: safePageContactName || 'Khách hàng',
              last_message: lastIncomingContent,
              is_unread: pageUnreadState,
              inbox_folder: 'INBOX'
            }, db);

            let pageAvatar = (envelope.avatar_url && typeof envelope.avatar_url === 'string' && envelope.avatar_url.startsWith('http')) ? envelope.avatar_url : null;
            if (safePageContactName || pageAvatar) {
              db.prepare(`
                INSERT INTO contacts (thread_id, name, avatar_url)
                VALUES (?, ?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                  name = COALESCE(excluded.name, contacts.name),
                  avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url)
              `).run(canonicalThreadId, safePageContactName, pageAvatar);
            }

            // Bổ sung link video đã giải mã từ Web Worker / DOM vào message batch
            if (Array.isArray(envelope.messages)) {
              for (const m of envelope.messages) {
                if (m.fb_message_id && resolvedPageVideos.has(m.fb_message_id)) {
                  const resolved = resolvedPageVideos.get(m.fb_message_id);
                  const vidUrl = resolved.video_url || resolved.media_url;
                  if (vidUrl && (!m.media_url || !m.media_url.startsWith('http')) && m.content !== '👍') {
                    m.media_url = vidUrl;
                    m.media_type = 'video';
                  }
                }
              }
            }

            const ack = ConversationRepository.processPageBatchEnvelope({
              ...envelope,
              thread_id: canonicalThreadId,
              account_id: authenticatedAccountId,
              page_id: pageId,
              source_id: source.id
            }, db);
            pageBatchStats.total += 1;
            if (ack.status === 'committed' || ack.status === 'duplicate' || ack.status === 'stale_generation') {
              pageBatchStats[ack.status] += 1;
            } else {
              pageBatchStats.other += 1;
            }
            if (pageBatchStats.total % 100 === 0) {
              console.log(`[PAGE_BATCH_STATS] total=${pageBatchStats.total} committed=${pageBatchStats.committed} duplicate=${pageBatchStats.duplicate} stale=${pageBatchStats.stale_generation} other=${pageBatchStats.other}`);
            }
            const syncReason = ack.reached_top ? 'reached_top' : (ack.status === 'committed' ? null : (ack.reason || 'page_batch_rejected'));
            InboxSyncScheduler.markThreadSyncResult(authenticatedAccountId, canonicalThreadId, syncReason, pageId);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: { ...ack, thread_id: pageThreadId } }));
            }
            if (ack.reached_top) {
              io.emit('THREAD_HISTORY_COMPLETED', { thread_id: canonicalThreadId, account_id: authenticatedAccountId });
            }
            const persistedRows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(sequence_order, id) ASC, id ASC').all(canonicalThreadId);
            const threadRow = db.prepare('SELECT history_completed FROM threads WHERE id = ?').get(canonicalThreadId);
            io.emit('THREAD_MESSAGES_UPDATED', {
              thread_id: canonicalThreadId,
              account_id: authenticatedAccountId,
              messages: prepareMessagesForClient(persistedRows),
              authoritative: true,
              sync_status: ack.status === 'committed' || ack.status === 'duplicate' ? 'SYNCED' : 'FAILED',
              sync_error: ack.reason || null,
              history_completed: threadRow?.history_completed || (ack.reached_top ? 1 : 0)
            });
          } catch (error) {
            console.error('[PAGE_BATCH] ingest failed:', error.message);
            const ack = { ...ackBase, status: 'retry_required', reason: 'page_batch_ingest_failed' };
            InboxSyncScheduler.markThreadSyncResult(authenticatedAccountId, pageThreadId, ack.reason, pageId);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
          }
          break;
        }

        case 'PAGE_MESSAGE_MEDIA_RESOLVED': {
          const { thread_id, fb_message_id, poster_url } = msg.data || {};
          const video_url = msg.data?.video_url || msg.data?.media_url;
          if (video_url) {
            if (fb_message_id) {
              resolvedPageVideos.set(fb_message_id, { video_url, media_url: video_url, poster_url, time: Date.now() });
              if (resolvedPageVideos.size > 200) {
                const oldestKey = resolvedPageVideos.keys().next().value;
                resolvedPageVideos.delete(oldestKey);
              }
            }

            let targetRow = null;
            if (fb_message_id) {
              targetRow = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(fb_message_id);
            }
            if (!targetRow && thread_id) {
              const canonicalId = resolveInternalThreadId(db, null, thread_id, msg.data?.page_id || null);
              targetRow = db.prepare(`
                SELECT * FROM messages
                WHERE (thread_id = ? OR thread_id = ?) AND media_type = 'video' AND (media_url IS NULL OR media_url NOT LIKE 'http%')
                ORDER BY timestamp_ms DESC, id DESC
                LIMIT 1
              `).get(canonicalId, thread_id);
            }

            if (targetRow) {
              let cleanedContent = targetRow.content || '';
              if (/^\s*\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}\s*$/i.test(cleanedContent) ||
                  /^\s*\d{1,2}:\d{2}\s*$/i.test(cleanedContent) ||
                  cleanedContent.trim().toLowerCase() === 'video') {
                cleanedContent = '';
              }

              db.prepare(`
                UPDATE messages
                SET media_url = ?,
                    media_type = 'video',
                    content = ?
                WHERE id = ?
              `).run(video_url, cleanedContent, targetRow.id);

              const updatedRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(targetRow.id);
              if (updatedRow) {
                console.log(`[WS] 🎥 Đã cập nhật video URL cho message ${updatedRow.fb_message_id || updatedRow.id}: ${video_url.substring(0, 60)}...`);
                io.emit('MESSAGE_UPDATED', {
                  thread_id: String(updatedRow.thread_id),
                  fb_message_id: updatedRow.fb_message_id,
                  message: withAttachmentAccessUrl(updatedRow)
                });
                io.emit('THREAD_MESSAGES_UPDATED', {
                  thread_id: String(updatedRow.thread_id),
                  messages: [withAttachmentAccessUrl(updatedRow)]
                });
                inboundMediaHydration.hydrateRow(updatedRow);
              }
            }
          }
          break;
        }

        case 'UPGRADE_MESSAGE_TIMESTAMP': {
          const { thread_id, fb_message_id, timestamp_ms, timestamp_source } = msg.data || {};
          if (thread_id && fb_message_id && timestamp_ms > 0) {
            const updatedMsg = ConversationRepository.upgradeMessageTimestamp(
              thread_id,
              fb_message_id,
              timestamp_ms,
              timestamp_source || 'facebook_label',
              db
            );
            if (updatedMsg) {
              console.log(`[WS] ⏱️ Đã nâng cấp timestamp cho message ${fb_message_id} -> ${new Date(timestamp_ms).toLocaleTimeString('vi-VN')} (${timestamp_source})`);
              io.emit('MESSAGE_UPDATED', {
                thread_id,
                fb_message_id,
                message: withAttachmentAccessUrl(updatedMsg)
              });
            }
          }
          break;
        }
        case 'BULK_HISTORY_SYNC_PROGRESS': {
          const progress = msg.data || {};
          const job = bulkHistoryJobs.get(String(progress.job_id || ''));
          if (!job) break;
          const accountKey = String(progress.account_id || ws.accountId || '');
          job.accounts.set(accountKey, {
            total: Number(progress.total || 0),
            completed: Number(progress.completed || 0),
            failed: Number(progress.failed || 0),
            status: progress.status || 'running',
            error: progress.error || null
          });
          const states = [...job.accounts.values()];
          const aggregate = states.reduce((sum, state) => ({
            total: sum.total + state.total,
            completed: sum.completed + state.completed,
            failed: sum.failed + state.failed
          }), { total: 0, completed: 0, failed: 0 });
          const allTerminal = states.length === job.expectedAccounts
            && states.every((state) => state.status === 'completed' || state.status === 'failed');
          io.emit('BULK_HISTORY_SYNC_PROGRESS', {
            job_id: job.id,
            status: allTerminal ? 'completed' : 'running',
            ...aggregate,
            error: progress.error || null
          });
          if (allTerminal) bulkHistoryJobs.delete(job.id);
          break;
        }

        case 'QUEUED_MESSAGE_RESULT': {
          // Previously missing entirely: handleSendQueuedMessage (background.js)
          // always sends this back after processing a queued Page send, but
          // with no case for it here it fell to `default: break` - silently
          // dropped. That's why every message_queue row, going back days, was
          // stuck at status='processing' forever, and any genuine send
          // failure left the CRM bubble hung in "Đang gửi" with no way to
          // ever learn it failed.
          const { queue_id, success, error, client_message_id, outcome } = msg.data;
          queueWorker.acknowledgeDispatch(queue_id);
          console.log(`[WS] QUEUED_MESSAGE_RESULT: queue_id=${queue_id} success=${success} error=${error || 'none'}`);
          const richQueue = db.prepare(
            'SELECT * FROM message_queue WHERE id = ? AND outbound_attempt_id IS NOT NULL'
          ).get(queue_id);
          if (richQueue) {
            const outcome = msg.data.outcome;
            const dispatched = outcome === 'dispatched' ||
              error === 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION' ||
              (outcome == null && success === true);
            if (dispatched) {
              OutboundAttemptRepository.transition(
                richQueue.outbound_attempt_id,
                ['queued', 'dispatching'],
                'awaiting_confirmation',
                {
                  dispatch_method: msg.data.adapter_version || 'rich-message-v1',
                  dispatched_at: new Date().toISOString()
                },
                db
              );
              const attempt = OutboundAttemptRepository.getById(
                richQueue.outbound_attempt_id,
                db
              );
              const message = attempt
                ? db.prepare('SELECT * FROM messages WHERE id = ?').get(attempt.message_id)
                : null;
              if (message) {
                io.emit('MESSAGE_SEND_STATUS', {
                  thread_id: message.thread_id,
                  client_message_id: message.client_message_id,
                  message_id: message.id,
                  attempt_id: attempt.id,
                  status: 'awaiting_confirmation',
                  fb_message_id: null,
                  confirmation_source: null,
                  error: null,
                  updated_at: new Date().toISOString()
                });
                // 'dispatched' chỉ được gửi sau khi waitForAttachmentDomConfirmation
                // đã thấy tin hiện thật trong khung chat Messenger - nghĩa là tin
                // ĐÃ tới người nhận. Đổi "sent" ngay thay vì chờ echo chính thức
                // (video Facebook xử lý/xuất echo rất lâu, có lần pending cả vài
                // phút trong khi khách đã nhận tin từ lâu). fb_message_id để null,
                // echo tới sau vẫn điền như cũ và không bị trùng vì dedup đọc
                // delivery_status='sent' như một merge point.
                if (message.delivery_status === 'pending') {
                  db.prepare(
                    "UPDATE messages SET delivery_status = 'sent', delivery_error = NULL WHERE id = ? AND delivery_status = 'pending'"
                  ).run(message.id);
                  io.emit('MESSAGE_SENT', {
                    thread_id: message.thread_id,
                    client_message_id: message.client_message_id,
                    success: true,
                    fb_message_id: null,
                    status: 'sent'
                  });
                }
              }

              // Auto-fail watchdog: if this attachment attempt is still stuck
              // in awaiting_confirmation after 3 minutes, fail it so the queue
              // is not blocked and the next text/image send can proceed.
              if (richQueue.attachment_id) {
                const watchdogAttemptId = richQueue.outbound_attempt_id;
                const watchdogQueueId = queue_id;
                const ATTACHMENT_CONFIRMATION_TIMEOUT_MS = 3 * 60 * 1000;
                setTimeout(() => {
                  try {
                    const liveAttempt = OutboundAttemptRepository.getById(watchdogAttemptId, db);
                    if (!liveAttempt || liveAttempt.status !== 'awaiting_confirmation') return;
                    console.warn(`[WS] Attachment confirmation watchdog: attempt ${watchdogAttemptId} still awaiting after 3min, failing.`);
                    const didFail = OutboundAttemptRepository.transition(
                      watchdogAttemptId,
                      ['awaiting_confirmation'],
                      'failed',
                      { error_code: 'CONFIRMATION_TIMEOUT', error_message: 'No Facebook message id received within 3 minutes' },
                      db
                    );
                    if (!didFail) return; // already resolved by DOM observation
                    OutboundAttachmentRepository.transition(
                      richQueue.attachment_id,
                      ['queued', 'sending'],
                      'failed',
                      { validation_error: 'CONFIRMATION_TIMEOUT' },
                      db
                    );
                    MessageQueueRepository.updateStatus(watchdogQueueId, 'failed', 'CONFIRMATION_TIMEOUT', db);
                    const timedOutMessage = liveAttempt.message_id
                      ? db.prepare('SELECT * FROM messages WHERE id = ?').get(liveAttempt.message_id)
                      : null;
                    if (timedOutMessage) {
                      db.prepare(`UPDATE messages SET delivery_status = 'failed', delivery_error = 'CONFIRMATION_TIMEOUT' WHERE id = ?`)
                        .run(timedOutMessage.id);
                      io.emit('MESSAGE_SEND_STATUS', {
                        thread_id: timedOutMessage.thread_id,
                        client_message_id: timedOutMessage.client_message_id,
                        message_id: timedOutMessage.id,
                        attempt_id: watchdogAttemptId,
                        status: 'failed',
                        fb_message_id: null,
                        error: { code: 'CONFIRMATION_TIMEOUT', message: 'Không nhận được xác nhận từ Facebook sau 3 phút' },
                        updated_at: new Date().toISOString()
                      });
                    }
                  } catch (watchdogError) {
                    console.error('[WS] Attachment confirmation watchdog error:', watchdogError.message);
                  }
                }, ATTACHMENT_CONFIRMATION_TIMEOUT_MS);
              }

              break;
            }

            const reason = msg.data.error_code || error || 'FACEBOOK_SEND_REJECTED';
            MessageQueueRepository.updateStatus(queue_id, 'failed', reason);
            OutboundAttemptRepository.transition(
              richQueue.outbound_attempt_id,
              ['queued', 'dispatching', 'awaiting_confirmation'],
              'failed',
              { error_code: reason, error_message: error || reason },
              db
            );
            if (richQueue.attachment_id) {
              OutboundAttachmentRepository.transition(
                richQueue.attachment_id,
                ['queued', 'sending'],
                'failed',
                { validation_error: reason },
                db
              );
            }
            const failedAttempt = OutboundAttemptRepository.getById(
              richQueue.outbound_attempt_id,
              db
            );
            if (failedAttempt) {
              const failedMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(
                failedAttempt.message_id
              );
              db.prepare(
                "UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?"
              ).run(error || reason, failedAttempt.message_id);
              if (failedMessage) {
                io.emit('MESSAGE_SEND_STATUS', {
                  thread_id: failedMessage.thread_id,
                  client_message_id: failedMessage.client_message_id,
                  message_id: failedMessage.id,
                  attempt_id: failedAttempt.id,
                  status: 'failed',
                  fb_message_id: null,
                  confirmation_source: null,
                  error: { code: reason, message: error || reason },
                  updated_at: new Date().toISOString()
                });
              }
            }
            break;
          }

          // For plain-text queue items (Page sends, Campaign text sends, Personal queued sends):
          const isDispatched = outcome === 'dispatched' ||
            error === 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION' ||
            (success === true && !error && !msg.data.error_code);

          if (isDispatched) {
            // CDP dispatch itself succeeded - not a real confirmation yet. The
            // actual delivery outcome is decided separately via DOM confirmation
            // (the pending-correlation / feature 020 temp-id-upgrade paths in
            // the NEW_MESSAGE_RECEIVED case above). Leave message_queue in
            // 'processing' until/unless a genuine DOM confirmation or failure follows.
            break;
          }

          // Genuine failure (extension not connected, composer never found
          // even after feature 016's poll+reload+poll, CDP dispatch itself
          // threw, contract invalid, etc.) - reuse the exact same failure path QueueWorker
          // already uses for its own EXTENSION_NOT_CONNECTED case, so both
          // failure sources behave identically.
          const failureReason = msg.data.error_code || error || 'SEND_FAILED';
          const queueRow = db.prepare('SELECT thread_id FROM message_queue WHERE id = ?').get(queue_id);
          MessageQueueRepository.updateStatus(queue_id, 'failed', failureReason);
          if (queueWorker.onQueueFail) {
            queueWorker.onQueueFail({ id: queue_id, thread_id: queueRow ? queueRow.thread_id : null }, failureReason);
          }
          break;
        }

        case 'MSG_UNSEND': {
          const { fb_message_id } = msg.data;
          db.prepare("UPDATE messages SET is_unsent=1 WHERE fb_message_id=?").run(fb_message_id);
          io.emit('MESSAGE_UNSENT', { fb_message_id });
          break;
        }

        case 'CALL_ENDED': {
          // Extension sends this when the call popup window closes.
          // We save a call log message to DB and emit it to CRM via Socket.io.
          const { thread_id: callThreadId, account_id: callAccountId, call_type: callCallType, call_label, duration_text, duration_ms, timestamp_ms: callTs } = msg.data || {};
          if (!callThreadId) break;

          const internalThreadId = resolveInternalThreadId(db, callAccountId || ws.accountId, callThreadId);
          if (!internalThreadId) {
            console.warn(`[WS] CALL_ENDED: Không tìm thấy thread ${callThreadId}`);
            break;
          }

          const callContent = call_label || (callCallType === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại');
          const callFbId = `call_ended_${internalThreadId}_${callTs || Date.now()}`;
          const callTsMs = callTs || Date.now();

          // Save to messages table
          try {
            db.prepare(`
              INSERT OR IGNORE INTO messages
                (thread_id, fb_message_id, sender_id, content, is_outgoing, direction_status, timestamp_ms, created_at)
              VALUES (?, ?, ?, ?, 1, 'confirmed', ?, CURRENT_TIMESTAMP)
            `).run(internalThreadId, callFbId, String(callAccountId || ws.accountId || 'CURRENT_USER'), callContent, callTsMs);
          } catch (dbErr) {
            console.warn('[WS] CALL_ENDED: Lỗi lưu DB:', dbErr.message);
          }

          console.log(`[WS] 📞 CALL_ENDED: ${callContent} (${duration_text || '?'}) thread=${callThreadId}`);

          const storedCallMessage = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(callFbId);
          // Emit to CRM immediately
          io.emit('NEW_MESSAGE', {
            ...(storedCallMessage || {}),
            thread_id: internalThreadId,
            account_id: String(callAccountId || ws.accountId || ''),
            fb_message_id: callFbId,
            content: callContent,
            is_outgoing: true,
            direction_status: 'confirmed',
            source: 'call_log',
            timestamp_ms: callTsMs,
            status: 'sent'
          });
          break;
        }

        default: break;
      }
    } catch (err) {
      console.error('[WS] Error:', err.message);
    }
  });

  ws.on('close', () => {
    for (const key of ws.pageConnectionKeys || []) {
      if (pageExtensionConnections.get(key) === ws) pageExtensionConnections.delete(key);
    }
    if (ws.accountId) {
      // REGISTER_ACCOUNT replaces an older socket before asking that old
      // socket to close. Its delayed close event must not delete the newer,
      // healthy connection that is already stored for the same account.
      if (extensionConnections.get(ws.accountId) !== ws) return;
      extensionConnections.delete(ws.accountId);
      InboxSyncScheduler.unregisterAccount(ws.accountId);
      domReplaySuppressUntil.delete(ws.accountId);
      db.prepare("UPDATE accounts SET status='DISCONNECTED' WHERE id=?").run(ws.accountId);
      io.emit('ACCOUNT_STATUS_CHANGED', { account_id: ws.accountId, status: 'DISCONNECTED' });
      io.emit('EXTENSION_CONNECTION_CHANGED', { account_id: ws.accountId, is_connected: false });
    }
  });
});

// ────────────────────────────────────────────────
// Socket.io: Nhân viên gửi tin nhắn → AI auto-pause 30 phút
// ────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('REQUEST_BULK_HISTORY_SYNC', ({ job_id, threads = [] } = {}) => {
    const requested = Array.isArray(threads) ? threads : [];
    const allowed = requested.filter((thread) =>
      thread?.thread_id && enterpriseAccess.canAccessThread(socket.user, thread.thread_id)
    );
    const groups = new Map();
    for (const thread of allowed) {
      const row = db.prepare('SELECT id, account_id, thread_url, contact_name, source_id FROM threads WHERE id = ?').get(thread.thread_id);
      if (!row?.account_id) continue;
      const source = ConversationRepository.getThreadSource(row.id);
      if (source?.sourceType === 'page_messenger') continue;
      const key = String(row.account_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        thread_id: String(row.id),
        thread_url: row.thread_url || thread.thread_url || null,
        contact_name: row.contact_name || thread.contact_name || null
      });
    }

    const id = String(job_id || require('crypto').randomUUID());
    const connectedGroups = [...groups.entries()].filter(([accountId]) => {
      const extWs = extensionConnections.get(accountId);
      return extWs && extWs.readyState === WebSocket.OPEN;
    });
    if (connectedGroups.length === 0) {
      socket.emit('BULK_HISTORY_SYNC_PROGRESS', { job_id: id, status: 'completed', total: 0, completed: 0, failed: allowed.length, error: 'EXTENSION_NOT_CONNECTED' });
      return;
    }

    bulkHistoryJobs.set(id, { id, expectedAccounts: connectedGroups.length, accounts: new Map() });
    socket.emit('BULK_HISTORY_SYNC_PROGRESS', { job_id: id, status: 'running', total: allowed.length, completed: 0, failed: 0 });
    for (const [accountId, accountThreads] of connectedGroups) {
      extensionConnections.get(accountId).send(JSON.stringify({
        type: 'BULK_HISTORY_SYNC',
        data: { job_id: id, account_id: accountId, threads: accountThreads }
      }));
    }
  });

  socket.on('SET_SIDEBAR_SYNC_WINDOW', ({ enabled, duration_ms = 60000, account_ids = [] } = {}) => {
    const requestedIds = Array.isArray(account_ids) && account_ids.length
      ? account_ids.map((id) => String(id || '')).filter(Boolean)
      : enterpriseAccess.listAccounts(socket.user).map((account) => String(account.id));
    const allowedIds = [...new Set(requestedIds)].filter((accountId) => enterpriseAccess.canAccessAccount(socket.user, accountId));
    const states = allowedIds.map((accountId) => {
      const state = enabled === true
        ? { account_id: accountId, ...InboxSyncScheduler.startSyncWindow(accountId, duration_ms) }
        : { account_id: accountId, ...InboxSyncScheduler.stopSyncWindow(accountId, 'operator_toggle') };
      if (enabled === true) dispatchPageSidebarSync(accountId, 'manual_sync_window');
      return state;
    });
    const expiresAt = states.reduce((latest, state) => Math.max(latest, Number(state.expires_at || 0)), 0);
    socket.emit('SIDEBAR_SYNC_WINDOW_STATE', {
      enabled: enabled === true && states.length > 0,
      expires_at: expiresAt,
      accounts: states
    });
  });

  socket.on('REQUEST_SYNC_THREADS', ({ account_id }) => {
    if (!account_id) return;
    dispatchPageSidebarSync(account_id, 'manual_crm_request');
    if (!InboxSyncScheduler.requestSidebarSync(account_id, 'crm_manual', { force: true })) {
      console.warn(`[Socket.io] Extension cho account ${account_id} chưa sẵn sàng WebSocket.`);
    }
  });

  socket.on('REQUEST_SYNC_MESSAGE_REQUESTS', ({ account_id } = {}) => {
    const accountId = String(account_id || '');
    if (!accountId || !enterpriseAccess.canAccessAccount(socket.user, accountId)) return;
    InboxSyncScheduler.requestMessageRequestsSync(accountId, 'crm_waiting_tab');
  });

  socket.on('MESSAGE_REQUEST_ACTION', ({ request_id, thread_id, action } = {}) => {
    const requestId = String(request_id || '');
    const threadId = String(thread_id || '');
    const requestedAction = String(action || 'query');
    if (!requestId || !threadId || !['query', 'accept', 'continue', 'delete', 'block'].includes(requestedAction)) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Yêu cầu không hợp lệ.' });
      return;
    }
    if (!enterpriseAccess.canAccessThread(socket.user, threadId)) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Không có quyền truy cập hội thoại.' });
      return;
    }
    const thread = db.prepare('SELECT id, external_thread_id, account_id, thread_url, contact_name, inbox_folder FROM threads WHERE id = ?').get(threadId);
    if (!thread?.account_id || !['MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(thread.inbox_folder)) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Hội thoại không còn ở Tin nhắn chờ.' });
      return;
    }
    const extension = extensionConnections.get(String(thread.account_id));
    if (!extension || extension.readyState !== WebSocket.OPEN) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Extension Facebook chưa kết nối.' });
      return;
    }
    messageRequestActionOwners.set(requestId, { socket, threadId, createdAt: Date.now() });
    setTimeout(() => {
      const pending = messageRequestActionOwners.get(requestId);
      if (!pending) return;
      messageRequestActionOwners.delete(requestId);
      pending.socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Messenger phản hồi quá thời gian.' });
    }, 15000).unref?.();
    extension.send(JSON.stringify({
      type: 'MESSAGE_REQUEST_ACTION',
      data: {
        request_id: requestId,
        thread_id: thread.id,
        external_thread_id: thread.external_thread_id || thread.id,
        account_id: thread.account_id,
        thread_url: thread.thread_url,
        contact_name: thread.contact_name,
        action: requestedAction
      }
    }));
  });

  socket.on('CONTINUE_FACEBOOK_SYNC', ({ account_id } = {}) => {
    const accountId = String(account_id || '');
    if (!accountId || !enterpriseAccess.canAccessAccount(socket.user, accountId)) return;
    backgroundAfterConnectRequests.set(accountId, Date.now());
    InboxSyncScheduler.requestSidebarSync(accountId, 'crm_continue', { force: true });
  });

  socket.on('CANCEL_FACEBOOK_SYNC', ({ account_id } = {}) => {
    const accountId = String(account_id || '');
    if (!accountId || !enterpriseAccess.canAccessAccount(socket.user, accountId)) return;
    const extension = extensionConnections.get(accountId);
    if (extension?.readyState === WebSocket.OPEN) {
      extension.send(JSON.stringify({ type: 'CANCEL_THREADS_SYNC', data: { account_id: accountId } }));
    }
  });

  socket.on('REQUEST_SYNC_THREAD_MESSAGES', async ({ thread_id, direction = 'initial', scroll_delta = 0 } = {}) => {
    const threadId = String(thread_id || '');
    if (!threadId || !enterpriseAccess.canAccessThread(socket.user, threadId)) return;
    const thread = db.prepare(`
      SELECT t.id, t.external_thread_id, t.account_id, t.thread_url, t.contact_name,
             t.sync_status, t.sync_cursor, t.history_completed,
             s.source_type, s.external_id AS page_id
      FROM threads t LEFT JOIN inbox_sources s ON s.id = t.source_id
      WHERE t.id = ?
    `).get(threadId);
    if (!thread?.account_id) return;

    if ((direction === 'older' || (direction === 'viewport' && Number(scroll_delta) < 0)) && Number(thread.history_completed) === 1) {
      console.log(`[REQUEST_SYNC_THREAD_MESSAGES] thread=${threadId} skip=history_completed`);
      return;
    }

    const interactionExtension = extensionConnections.get(String(thread.account_id));
    if (interactionExtension?.readyState === WebSocket.OPEN && thread.source_type !== 'page_messenger') {
      interactionExtension.send(JSON.stringify({
        type: 'PREPARE_CHAT_THREAD',
        data: {
          account_id: thread.account_id,
          thread_id: thread.id,
          external_thread_id: thread.external_thread_id || thread.id,
          thread_url: thread.thread_url,
          contact_name: thread.contact_name
        }
      }));
    }
    HistorySyncRetryPolicy.noteManualRequest(thread.account_id, threadId);
    const laneKey = (thread.source_type === 'page_messenger' && thread.page_id)
      ? ('page:' + thread.page_id)
      : ('personal:' + thread.account_id);
    InitialMessageSweepService.noteUserActivity(thread.account_id, laneKey);
    InboxSyncScheduler.clearQueuedThreadSyncs(thread.account_id, (job) => (
      ['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport'].some((prefix) => String(job.reason || '').startsWith(prefix))
      && String(job.thread_id) !== threadId
    ));
    InboxSyncScheduler.clearPendingThreadSyncs(thread.account_id, (job) => (
      ['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport'].some((prefix) => String(job.reason || '').startsWith(prefix))
      && String(job.thread_id) !== threadId
    ));
    // A manual conversation change must take ownership of the single history
    // tab immediately. The extension navigation token cancels the superseded
    // DOM pass; releasing only that old scheduler slot lets the new user run
    // without waiting for the previous scroll timeout.
    InboxSyncScheduler.preemptActiveThreadSync(thread.account_id, (job) => String(job.thread_id) !== threadId);
    // History is controlled only by the CRM operator. Opening a conversation
    // synchronizes the currently mounted viewport; subsequent Messenger
    // movement is requested exclusively by CRM viewport scroll events.
    // Cancel any old progressive job so selecting a user can never start an
    // unsolicited background crawl.
    const historyJobKey = String(thread.account_id);
    historyBackfillJobs.delete(historyJobKey);
    InboxSyncScheduler.enqueueThreadSync({
      account_id: thread.account_id,
      thread_id: thread.id,
      external_thread_id: thread.external_thread_id || thread.id,
      thread_url: thread.thread_url,
      page_id: thread.source_type === 'page_messenger' ? thread.page_id : null,
      contact_name: thread.contact_name,
      reason: (direction === 'older' || (direction === 'viewport' && Number(scroll_delta) < 0)) ? 'crm_scroll_older' : (direction === 'viewport' ? 'crm_scroll_viewport' : 'crm_navigation'),
      allow_navigation: true,
      priority: 'high',
      // Opening/switching user must never scroll Messenger. A saved PARTIAL
      // checkpoint is consumed only after an explicit CRM scroll-to-top event.
      sync_mode: (direction === 'older' || (direction === 'viewport' && Number(scroll_delta) < 0)) ? 'ondemand_older' : (direction === 'viewport' ? 'ondemand_viewport' : 'ondemand_initial'),
      // Preserve the operator's real upward wheel distance for older-page
      // requests. Dropping it here made the extension fall back to -1px,
      // which is too small to move Messenger's virtualized history scroller.
      scroll_delta: ['viewport', 'older'].includes(direction) ? Number(scroll_delta) || 0 : 0
    });
  });

  socket.on('TRIGGER_CALL', ({ thread_id, call_type = 'audio', account_id, call_request_id }) => {
    if (!enterpriseAccess.canAccessThread(socket.user, thread_id)) return socket.emit('CALL_ERROR', { error: 'Không có quyền sử dụng hội thoại này.' });
    let targetAccId = account_id;
    if (!targetAccId && thread_id) {
      const thread = db.prepare('SELECT account_id FROM threads WHERE id = ?').get(thread_id);
      if (thread?.account_id) targetAccId = thread.account_id;
    }
    if (!targetAccId && extensionConnections.size > 0) {
      targetAccId = extensionConnections.keys().next().value;
    }
    if (!targetAccId || !thread_id) {
      socket.emit('CALL_TRIGGER_RESPONSE', { success: false, error: 'Thiếu thông tin tài khoản hoặc hội thoại' });
      return;
    }

    if (!callEventDeduplicator.claimOutgoing({
      accountId: targetAccId,
      threadId: thread_id,
      callType: call_type
    })) {
      socket.emit('CALL_TRIGGER_RESPONSE', {
        success: false,
        error: 'Cuộc gọi này vừa được kích hoạt. Vui lòng chờ trong giây lát.'
      });
      return;
    }

    const requestId = String(call_request_id || require('crypto').randomUUID());
    const extWs = extensionConnections.get(targetAccId);
    if (extWs && extWs.readyState === WebSocket.OPEN) {
      console.log(`[Socket.io] 📞 Yêu cầu kích hoạt cuộc gọi Messenger ${call_type} cho thread ${thread_id} (account ${targetAccId})`);
      extWs.send(JSON.stringify({
        type: 'TRIGGER_MESSENGER_CALL',
        data: { account_id: targetAccId, thread_id, call_type, call_request_id: requestId }
      }));
      socket.emit('CALL_TRIGGER_RESPONSE', { success: true, message: 'Đã gửi lệnh kích hoạt cuộc gọi tới Extension' });
    } else {
      console.warn(`[Socket.io] Extension cho account ${targetAccId} chưa sẵn sàng WebSocket.`);
      socket.emit('CALL_TRIGGER_RESPONSE', { success: false, error: 'Extension Facebook chưa được kết nối' });
    }
  });

  socket.on('ANSWER_INCOMING_CALL', ({ action, thread_id, account_id, source_tab_id, source_frame_id, call_id } = {}) => {
    if (action !== 'accept' && action !== 'decline') {
      socket.emit('ANSWER_INCOMING_CALL_RESPONSE', { success: false, action, thread_id, error: 'Invalid call action' });
      return;
    }
    const targetAccount = account_id || extensionConnections.keys().next().value;
    const extension = targetAccount ? extensionConnections.get(targetAccount) : null;
    if (extension?.readyState === WebSocket.OPEN) {
      extension.send(JSON.stringify({ type: 'ANSWER_INCOMING_CALL', data: { action, thread_id, account_id: targetAccount, source_tab_id, source_frame_id, call_id } }));
      socket.emit('ANSWER_INCOMING_CALL_RESPONSE', { success: true, action, thread_id });
    } else {
      socket.emit('ANSWER_INCOMING_CALL_RESPONSE', { success: false, action, thread_id, error: 'Facebook extension is not connected' });
    }
  });

  socket.on('SEND_MESSAGE', async (payload = {}) => {
    const { thread_id, content, client_message_id, attachment_id, contract_version } = payload;
    const isRichMessage = Number(contract_version) === 2 || Boolean(attachment_id);
    if (!enterpriseAccess.canAccessThread(socket.user, thread_id)) {
      return socket.emit('SEND_ERROR', { client_message_id, code: 'ACCOUNT_NOT_ASSIGNED', error: 'Tài khoản Facebook chưa được Admin cấp cho bạn.' });
    }

    // Nhân viên gõ tay → tạm dừng AI 30 phút
    const pauseResult = aiMediator.pauseForThread(thread_id);
    io.emit('AI_PAUSED', { thread_id, until: pauseResult.until });

    const threadRow = db.prepare(`
      SELECT t.id, t.account_id, s.source_type, s.external_id AS page_id
      FROM threads t LEFT JOIN inbox_sources s ON s.id = t.source_id
      WHERE t.id = ?
    `).get(thread_id);
    if (threadRow?.account_id) {
      const laneKey = (threadRow.source_type === 'page_messenger' && threadRow.page_id)
        ? ('page:' + threadRow.page_id)
        : ('personal:' + threadRow.account_id);
      InitialMessageSweepService.noteUserActivity(threadRow.account_id, laneKey);
      InboxSyncScheduler.preemptActiveThreadSync(threadRow.account_id, (job) => String(job.thread_id) !== String(thread_id));
    }

    try {
      if (isRichMessage) {
        if (isLoopbackAddress(socket.handshake?.address) === false) {
          throw new RichMessageService.Error(
            'LOCAL_CRM_REQUIRED',
            'Rich-message chỉ được phép từ CRM chạy trên máy này.',
            403
          );
        }
        const forbiddenRoutingFields = ['account_id', 'source_id', 'source_type', 'page_id'];
        if (forbiddenRoutingFields.some((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
          throw new RichMessageService.Error(
            'ROUTING_FIELDS_FORBIDDEN',
            'CRM không được tự chỉ định tài khoản hoặc nguồn gửi.',
            400
          );
        }
        const richThread = db.prepare('SELECT account_id FROM threads WHERE id = ?').get(thread_id);
        if (!richThread?.account_id) {
          throw new RichMessageService.Error('THREAD_NOT_FOUND', 'Conversation was not found.', 404);
        }
        const accepted = RichMessageService.submit({
          threadId: thread_id,
          clientMessageId: client_message_id,
          // Preserve text caption alongside attachment
          content: content || '',
          attachmentId: attachment_id || null
        }, {
          database: db,
          capabilityOptions: getRichMessageCapabilityOptions()
        });
        const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(accepted.message_id);
        socket.emit('MESSAGE_SEND_ACCEPTED', accepted);
        io.emit('NEW_MESSAGE', withAttachmentAccessUrl({
          ...message,
          status: accepted.status,
          attempt_id: accepted.attempt_id,
          queue_id: accepted.queue_id,
          attachment: accepted.attachment
        }));
        return;
      }

      await sendViaExtension(thread_id, content, client_message_id);
    } catch (err) {
      console.error('[Socket] Lỗi gửi tin nhắn:', err.message);
      try {
        fs.appendFileSync(
          path.join(APP_DATA_ROOT, 'composer-debug.log'),
          JSON.stringify({
            at: new Date().toISOString(),
            stage: 'socket_send_error',
            thread_id: String(thread_id || ''),
            client_message_id: client_message_id || null,
            attachment_id: attachment_id || null,
            error_code: err.code || 'SEND_FAILED',
            error: err.message || String(err)
          }) + '\n'
        );
      } catch (_) { }
      socket.emit('SEND_ERROR', {
        error: err.message,
        code: err.code || 'SEND_FAILED',
        client_message_id
      });
      io.emit('MESSAGE_SEND_FAILED', {
        thread_id,
        client_message_id,
        success: false,
        error: err.message,
        error_code: err.code || 'SEND_FAILED'
      });
    }
  });

  socket.on('RETRY_MESSAGE', (payload = {}) => {
    try {
      if (!enterpriseAccess.canAccessThread(socket.user, payload.thread_id)) throw Object.assign(new Error('Tài khoản Facebook chưa được Admin cấp cho bạn.'), { code: 'ACCOUNT_NOT_ASSIGNED' });
      if (isLoopbackAddress(socket.handshake?.address) === false) {
        throw new RichMessageService.Error(
          'LOCAL_CRM_REQUIRED',
          'Rich-message chỉ được phép từ CRM chạy trên máy này.',
          403
        );
      }
      const accepted = RichMessageService.retry({
        threadId: payload.thread_id,
        messageId: payload.message_id,
        expectedLatestAttemptId: payload.expected_latest_attempt_id
      }, {
        database: db,
        capabilityOptions: getRichMessageCapabilityOptions()
      });
      socket.emit('MESSAGE_SEND_ACCEPTED', accepted);
      io.emit('MESSAGE_SEND_STATUS', {
        thread_id: accepted.thread_id,
        client_message_id: accepted.client_message_id,
        message_id: accepted.message_id,
        attempt_id: accepted.attempt_id,
        status: accepted.status,
        fb_message_id: null,
        confirmation_source: null,
        error: null,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      socket.emit('SEND_ERROR', {
        error: error.message,
        code: error.code || 'RETRY_FAILED',
        message_id: payload.message_id
      });
    }
  });
});

// ────────────────────────────────────────────────
// REST API
// ────────────────────────────────────────────────

function requireCompanyAdmin(req, res, next) {
  if (enterpriseAccess.isCompanyAdmin(req.user) || (req.user.role === 'ADMIN' && req.user.username === 'admin')) return next();
  return res.status(403).json({ success: false, error: 'Chỉ Admin doanh nghiệp được sử dụng chức năng này.' });
}

app.get('/api/company/employees', requireCompanyAdmin, (req, res) => {
  res.json({ success: true, employees: enterpriseAccess.listEmployees(req.user), assignments: enterpriseAccess.assignmentMap(req.user.company_id), accounts: enterpriseAccess.listAccounts(req.user) });
});

app.post('/api/company/employees', requireCompanyAdmin, async (req, res) => {
  try {
    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/client-auth/company-employees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminUsername: req.user.username, username: req.body?.username, password: req.body?.password })
    });
    const central = await centralResponse.json().catch(() => ({}));
    if (!centralResponse.ok || !central.success) return res.status(centralResponse.status).json({ success: false, error: central.message || 'License Server từ chối tạo nhân viên.' });
    const employee = enterpriseAccess.createEmployee(req.user, req.body || {});
    res.status(201).json({ success: true, employee });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Không thể tạo nhân viên.' });
  }
});

app.delete('/api/company/employees/:id', requireCompanyAdmin, async (req, res) => {
  const employee = db.prepare("SELECT username FROM users WHERE id=? AND company_id=? AND company_role='EMPLOYEE'").get(Number(req.params.id), req.user.company_id);
  if (!employee) return res.status(404).json({ success: false, error: 'Không tìm thấy nhân viên.' });
  try {
    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/client-auth/company-employees`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminUsername: req.user.username, username: employee.username })
    });
    if (!centralResponse.ok && centralResponse.status !== 404) throw new Error('Không thể xóa nhân viên trên License Server.');
    enterpriseAccess.deleteEmployee(req.user, req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

app.put('/api/company/employees/:id/accounts', requireCompanyAdmin, (req, res) => {
  try {
    const accountIds = enterpriseAccess.setAssignments(req.user, req.params.id, Array.isArray(req.body?.account_ids) ? req.body.account_ids : []);
    res.json({ success: true, account_ids: accountIds });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/accounts', (req, res) => {
  const accounts = enterpriseAccess.listAccounts(req.user);
  const result = accounts.map(acc => {
    const accIdStr = String(acc.id);
    const personalWs = extensionConnections.get(accIdStr) || extensionConnections.get(acc.id);
    const isPersonalConnected = Boolean(personalWs && personalWs.readyState === WebSocket.OPEN);
    let isPageConnected = false;
    for (const [key, pageWs] of pageExtensionConnections.entries()) {
      if (key.startsWith(accIdStr + ':') && pageWs?.readyState === WebSocket.OPEN) {
        isPageConnected = true;
        break;
      }
    }
    return {
      ...acc,
      is_extension_connected: isPersonalConnected || isPageConnected,
      is_chrome_running: processManager.getStatus(acc.id) === 'RUNNING',
      chrome_display_mode: processManager.getDisplayMode(acc.id)
    };
  });
  res.json(result);
});
app.post('/api/accounts/:id/start', async (req, res) => {
  const accountId = String(req.params.id);
  // Key dạng page:<ownerAcc>:<pageId> không phải tài khoản trong bảng accounts -
  // chính sách 1 Chrome/account: bảo đảm Chrome cá nhân chạy + mở tab Business.
  if (accountId.startsWith('page:')) {
    const parts = accountId.split(':');
    const ownerAccountId = parts[1];
    const pageId = parts[2];
    if (!ownerAccountId || !pageId) return res.status(400).json({ success: false, error: 'Key Page không hợp lệ' });
    if (isSuspiciousPageId(pageId)) {
      return res.status(400).json({ success: false, error: `ID ${pageId} là ID profile/delegate, không phải Fanpage - không mở tab.` });
    }
    const ok = await processManager.openBusinessTabForPage(pageId, ownerAccountId);
    return res.json({ success: ok });
  }
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const startInBackground = req.body?.background === true;
  if (startInBackground) {
    backgroundAfterConnectRequests.set(accountId, Date.now());
  } else {
    backgroundAfterConnectRequests.delete(accountId);
    if (backgroundAfterConnectTimers.has(accountId)) {
      clearTimeout(backgroundAfterConnectTimers.get(accountId));
      backgroundAfterConnectTimers.delete(accountId);
    }
  }

  const success = await processManager.startAccountProcess(accountId, null, { forceExtensionReload: true });
  if (!success) {
    backgroundAfterConnectRequests.delete(accountId);
    return res.json({ success: false });
  }

  // If extension is already connected and background requested, hide immediately
  if (startInBackground && extensionConnections.has(accountId)) {
    processManager.hideAccountProcess(accountId).then((result) => {
      if (result?.success) {
        io.emit('ACCOUNT_DISPLAY_CHANGED', {
          account_id: accountId,
          chrome_display_mode: 'BACKGROUND',
          is_chrome_running: true
        });
      }
    });
  }

  // Start every Page already connected to this Facebook account in its own
  // Chrome profile as part of Connect Facebook. This keeps Page and Personal
  // Messenger independent and does not modify either existing process.
  // Tuần tự hóa launch Page: chạy song song từng bị race startAccountProcess
  // (3 Page = 3 lần launch Chrome tranh nhau - reproduced 2026-09-19). Mỗi
  // Page vẫn mở Business Suite tab riêng trong CÙNG Chrome account.
  const pageSources = activePageSourcesForAccount(accountId);
  for (const source of pageSources) {
    try {
      await processManager.startPageProcess(source.page_id, accountId);
    } catch (error) {
      console.warn(`[PageSync] Could not launch Page ${source.page_id} on connect:`, error.message);
    }
  }

  res.json({ success: true, page_windows_requested: pageSources.length });
});
app.post('/api/accounts/:id/stop', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);
  backgroundAfterConnectRequests.delete(accountId);
  if (backgroundAfterConnectTimers.has(accountId)) {
    clearTimeout(backgroundAfterConnectTimers.get(accountId));
    backgroundAfterConnectTimers.delete(accountId);
  }
  const stopped = processManager.stopAccountProcess(accountId);
  if (stopped) {
    io.emit('ACCOUNT_DISPLAY_CHANGED', {
      account_id: accountId,
      chrome_display_mode: 'STOPPED',
      is_chrome_running: false
    });
  }
  res.json({ success: true, stopped });
});
app.post('/api/extension/reload', (req, res) => {
  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(JSON.stringify({ type: 'RELOAD_EXTENSION' }));
        count++;
      } catch (_) {}
    }
  });
  console.log(`[WS] 🔄 Đã gửi tín hiệu RELOAD_EXTENSION tới ${count} kết nối Extension WebSocket.`);
  res.json({ success: true, reloaded: count });
});
app.post('/api/accounts/:id/open', async (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);
  if (processManager.getStatus(accountId) !== 'RUNNING') {
    return res.status(409).json({ success: false, error: 'Hãy kết nối tài khoản Facebook trước khi bật hiển thị Chrome.' });
  }
  // Cancel any pending auto-hide requests/timers so Chrome doesn't get hidden again
  backgroundAfterConnectRequests.delete(accountId);
  if (backgroundAfterConnectTimers.has(accountId)) {
    clearTimeout(backgroundAfterConnectTimers.get(accountId));
    backgroundAfterConnectTimers.delete(accountId);
  }

  const result = await processManager.unhideWindow(accountId);
  if (result?.success) {
    io.emit('ACCOUNT_DISPLAY_CHANGED', {
      account_id: accountId,
      chrome_display_mode: 'VISIBLE',
      is_chrome_running: true
    });
  }
  res.json({ success: !!result?.success, error: result?.error });
});
app.post('/api/accounts/:id/background', async (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);
  if (processManager.getStatus(accountId) !== 'RUNNING') {
    return res.status(409).json({ success: false, error: 'Tài khoản Facebook chưa được kết nối.' });
  }
  const result = await processManager.hideAccountProcess(accountId);
  if (result?.success) {
    io.emit('ACCOUNT_DISPLAY_CHANGED', {
      account_id: accountId,
      chrome_display_mode: 'BACKGROUND',
      is_chrome_running: true
    });
  }
  res.json({ success: !!result?.success, error: result?.error });
});

// ────────────────────────────────────────────────
// Fanpage Auto-Discovery & Batch-Open Endpoints
// ────────────────────────────────────────────────
// Đồng bộ với GENERIC_EXCLUDE_REGEX trong src/extension/pageDiscovery.js:
// các chuỗi này là tiêu đề UI Facebook, không phải tên Page thật.
const GENERIC_PAGE_NAME_REGEX = /^(?:facebook|messenger|trang|page|trang cá nhân|profile|hộp thư|inbox|bảng tin|feed|thông báo|notifications|cài đặt|settings|xem tất cả|see all|quản lý|manage|quản lý trang|trang của bạn|trang bạn quản lý|trang của tôi|tất cả trang|your pages|pages you manage|manage pages|my pages)$/i;

function isGenericPageName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (GENERIC_PAGE_NAME_REGEX.test(trimmed)) return true;
  if (/^page \d+$/i.test(trimmed)) return true;
  return false;
}

// ID profile/delegate mới của Facebook có 14 chữ số bắt đầu 6155-6159
// (vd 61564781823946). Business Suite chặn asset_id dạng này với lỗi
// "nội dung này hiện không khả dụng" - chỉ ID page thật (11-16 chữ số
// hợp lệ) mới mở được inbox. Lọc bỏ 615[5-9]\d{10} (profile/delegate).
const SUSPICIOUS_PAGE_ID_REGEX = /^615[5-9]\d{10}$/;

function isSuspiciousPageId(id) {
  return SUSPICIOUS_PAGE_ID_REGEX.test(String(id || '').trim());
}

// Tên page trùng khớp tên chủ tài khoản (khác ID account) = profile cá nhân
// khác của chủ bị quét nhầm thành page.
function isOwnerSelfSourceName(name, accountName) {
  const n = (name || '').trim().toLowerCase();
  const a = (accountName || '').trim().toLowerCase();
  return !!n && !!a && n === a;
}

function getAccountName(accountId) {
  try {
    return db.prepare('SELECT name FROM accounts WHERE id = ?').get(String(accountId))?.name || '';
  } catch (_) {
    return '';
  }
}

app.get('/api/accounts/:id/pages', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);
  const accountName = getAccountName(accountId);
  // Tự dọn source rác đã lỡ tạo từ đợt quét buggy cũ: tên là tiêu đề UI
  // Facebook ("Quản lý trang") hoặc placeholder ("Page 123...") - mở tab
  // Business Suite cho chúng luôn bị chặn "nội dung không khả dụng".
  // Tương tự với ID profile/delegate 6155xxx-6159xxx (14 chữ số) và profile
  // cá nhân trùng tên chủ account.
  const junkSources = db.prepare(`
    SELECT id, external_id, display_name FROM inbox_sources
    WHERE source_type = 'page_messenger' AND owner_account_id = ?
  `).all(accountId).filter((s) => isGenericPageName(s.display_name)
    || isSuspiciousPageId(s.external_id)
    || isOwnerSelfSourceName(s.display_name, accountName));
  if (junkSources.length > 0) {
    const deleteSource = db.prepare('DELETE FROM inbox_sources WHERE id = ?');
    for (const junk of junkSources) deleteSource.run(junk.id);
    console.log(`[Pages] Đã dọn ${junkSources.length} source page rác của account ${accountId}: ${junkSources.map((j) => j.display_name).join(', ')}`);
  }
  const cached = discoveredPagesByAccount.get(accountId);
  // Loại bỏ tài khoản cá nhân ra khỏi danh sách quét được
  // + lọc luôn entry ID profile/delegate 6155xxx-6159xxx và profile trùng tên chủ
  const rawPages = (cached?.pages || []).filter(p => String(p.page_id) !== accountId
    && !isGenericPageName(p.name)
    && !isSuspiciousPageId(p.page_id)
    && !isOwnerSelfSourceName(p.name, accountName));

  // Lấy các source Page đã ACTIVE của account này trong database (bỏ qua personal profile)
  const activeSources = db.prepare(`
    SELECT external_id, display_name, avatar_url, status
    FROM inbox_sources
    WHERE source_type = 'page_messenger' AND owner_account_id = ? AND status = 'ACTIVE'
  `).all(accountId).filter(s => String(s.external_id) !== accountId
    && !isGenericPageName(s.display_name)
    && !isSuspiciousPageId(s.external_id)
    && !isOwnerSelfSourceName(s.display_name, accountName));

  const activeById = new Map();
  const activeByName = new Map();
  // 1 Page có thể bị discovery quét nhầm ID profile kiểu mới (10007...) thay vì
  // ID legacy mà Business Suite nhận. Map tên "lỏng" (bỏ dấu cách/ký tự) giữa
  // page quét được và mọi source ACTIVE để thay ID sai bằng ID chuẩn trong DB.
  const looseNameKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/g, '');
  const anyPageSources = db.prepare(`
    SELECT external_id, display_name, owner_account_id
    FROM inbox_sources
    WHERE source_type = 'page_messenger' AND status = 'ACTIVE'
  `).all();
  const activeByLooseName = new Map();
  const anyByLooseName = new Map();
  for (const s of anyPageSources) {
    const key = looseNameKey(s.display_name);
    if (!key) continue;
    if (!anyByLooseName.has(key)) anyByLooseName.set(key, s);
    if (String(s.owner_account_id) === String(accountId) && !activeByLooseName.has(key)) activeByLooseName.set(key, s);
  }
  for (const s of activeSources) {
    const extId = String(s.external_id);
    activeById.set(extId, s);
    const norm = (s.display_name || '').trim().toLowerCase();
    if (norm) {
      activeByName.set(norm, s);
    }
  }

  // Kết hợp danh sách:
  // Dùng normalizedName làm khóa để đảm bảo không bao giờ bị nhân đôi 2 Page cùng tên
  const combinedByName = new Map();

  for (const p of rawPages) {
    const pid = String(p.page_id);
    const norm = (p.name || '').trim().toLowerCase();
    const loose = looseNameKey(p.name);
    let effectivePid = pid;
    if (!activeById.has(pid)) {
      const cand = (loose && (activeByLooseName.get(loose) || anyByLooseName.get(loose))) || null;
      if (cand) effectivePid = String(cand.external_id);
    }
    const matchedSource = activeById.get(effectivePid)
      || (norm ? activeByName.get(norm) : null)
      || (loose ? activeByLooseName.get(loose) : null);
    const isConn = !!matchedSource;
    // Ưu tiên dùng ID từ database nếu đã kết nối (ID legacy 16 số chuẩn), nếu chưa có thì dùng pid quét được
    const effectiveId = matchedSource ? String(matchedSource.external_id) : effectivePid;
    const effectiveName = matchedSource?.display_name || p.name || ('Page ' + effectiveId);
    const key = norm || effectiveId;

    if (!combinedByName.has(key)) {
      combinedByName.set(key, {
        page_id: effectiveId,
        name: effectiveName,
        avatar_url: p.avatar_url || matchedSource?.avatar_url || `https://graph.facebook.com/${effectiveId}/picture?type=normal`,
        category: p.category || 'Trang Facebook',
        is_connected: isConn
      });
    }
  }

  // Bổ sung các page trong CSDL mà discovery chưa quét ra
  for (const s of activeSources) {
    const extId = String(s.external_id);
    const norm = (s.display_name || '').trim().toLowerCase();
    const key = norm || extId;
    if (!combinedByName.has(key)) {
      combinedByName.set(key, {
        page_id: extId,
        name: s.display_name || ('Page ' + extId),
        avatar_url: s.avatar_url || `https://graph.facebook.com/${extId}/picture?type=normal`,
        category: 'Trang Facebook',
        is_connected: true
      });
    }
  }

  // Bổ sung source page chưa rõ chủ (owner NULL, vd tạo từ thread cũ):
  // discovery không trả về chúng nên không bao giờ được auto-bind owner -
  // nếu không thêm vào đây thì modal thiếu page so với Business Suite.
  // User bấm "Mở" sẽ qua ensurePageSource -> tự gắn owner cho account này.
  // Page mồ côi (owner NULL, thường là page của account đã bị xóa) phải có
  // hội thoại thật mới được đề xuất kết nối - nếu không modal sẽ ngập page rác
  // của account khác (30 thay vì 18 page).
  const unownedSources = db.prepare(`
    SELECT s.external_id, s.display_name, s.avatar_url
    FROM inbox_sources s
    WHERE s.source_type = 'page_messenger' AND s.owner_account_id IS NULL AND s.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM threads t WHERE t.source_id = s.id)
  `).all().filter(s => String(s.external_id) !== accountId
    && !isGenericPageName(s.display_name)
    && !isSuspiciousPageId(s.external_id)
    && !isOwnerSelfSourceName(s.display_name, accountName));
  for (const s of unownedSources) {
    const extId = String(s.external_id);
    const norm = (s.display_name || '').trim().toLowerCase();
    const key = norm || extId;
    if (!combinedByName.has(key)) {
      combinedByName.set(key, {
        page_id: extId,
        name: s.display_name || ('Page ' + extId),
        avatar_url: s.avatar_url || `https://graph.facebook.com/${extId}/picture?type=normal`,
        category: 'Trang Facebook',
        is_connected: false
      });
    }
  }

  const pages = Array.from(combinedByName.values());
  try {
    fs.appendFileSync(path.join(APP_DATA_ROOT, 'discovery-debug.log'), JSON.stringify({ at: new Date().toISOString(), tag: 'GET_PAGES', account_id: accountId, count: pages.length, pages: pages.map(p => ({ id: String(p.page_id), name: String(p.name || '').slice(0, 90), conn: !!p.is_connected })) }) + '\n');
  } catch (_) {}
  res.json({
    success: true,
    account_id: accountId,
    pages,
    updated_at: cached?.updatedAt || null
  });
});

app.post('/api/accounts/:id/pages/refresh', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);

  // Rate-limiting / Throttle: 10 giây/lần
  const lastReq = lastPageRefreshRequestedAt.get(accountId) || 0;
  const now = Date.now();
  if (now - lastReq < 10000) {
    const waitSeconds = Math.ceil((10000 - (now - lastReq)) / 1000);
    return res.status(429).json({
      success: false,
      error: `Vui lòng đợi ${waitSeconds} giây trước khi quét lại.`
    });
  }
  lastPageRefreshRequestedAt.set(accountId, now);

  const personalWs = extensionConnections.get(accountId);
  if (!personalWs || personalWs.readyState !== WebSocket.OPEN) {
    return res.status(409).json({
      success: false,
      error: 'Chrome của tài khoản Facebook này chưa kết nối. Hãy khởi động Chrome trước.'
    });
  }

  personalWs.send(JSON.stringify({ type: 'REQ_REFRESH_PAGES' }));
  console.log(`[WS] 🔄 Đã gửi REQ_REFRESH_PAGES tới extension của account=${accountId}`);
  res.json({ success: true, message: 'Đã gửi yêu cầu quét lại Fanpage.' });
});

app.post('/api/accounts/:id/pages/batch-open', async (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
  }
  const accountId = String(req.params.id);
  const pageIds = Array.isArray(req.body?.page_ids) ? req.body.page_ids.map(String).filter(Boolean) : [];

  if (pageIds.length === 0) {
    return res.status(400).json({ success: false, error: 'Vui lòng chọn ít nhất 1 Page để mở.' });
  }

  const accountName = getAccountName(accountId);

  const cached = discoveredPagesByAccount.get(accountId);
  const cachedPages = cached?.pages || [];
  const cachedPageMap = new Map(cachedPages.map(p => [String(p.page_id), p]));

  // Lấy các source hiện tại để kiểm tra trùng tên trước khi tạo mới (tránh tạo 2 source kép cho 1 Page)
  // Bỏ qua source rác (ID profile/delegate, tên trùng chủ account) khỏi map trùng tên
  // để không bao giờ map 1 Page thật vào external_id giả.
  const existingSources = db.prepare(`
    SELECT id, external_id, display_name
    FROM inbox_sources
    WHERE source_type = 'page_messenger' AND owner_account_id = ?
  `).all(accountId).filter((s) => !isSuspiciousPageId(s.external_id) && !isOwnerSelfSourceName(s.display_name, accountName));

  const existingByName = new Map();
  for (const s of existingSources) {
    const norm = (s.display_name || '').trim().toLowerCase();
    if (norm) existingByName.set(norm, s);
  }

  const openedPages = [];
  const errors = [];

  for (const rawPageId of pageIds) {
    try {
      const pageInfo = cachedPageMap.get(rawPageId);

      // ID profile/delegate 6155xxx-6159xxx (14 chữ số): Business Suite luôn
      // chặn với "nội dung không khả dụng" -> không mở, không tạo source.
      if (isSuspiciousPageId(rawPageId)) {
        console.log(`[BatchOpen] Bỏ qua ID profile/delegate ${rawPageId} (không phải ID page thật).`);
        errors.push(`Đã bỏ qua ID ${rawPageId} - không phải Fanpage thật.`);
        continue;
      }

      // Tên quét được là tiêu đề UI Facebook ("Quản lý trang"...) -> ID giả,
      // mở tab Business Suite luôn bị chặn. Bỏ qua luôn, không tạo source.
      // Chỉ chặn khi có pageInfo thật (cache rỗng sau restart thì vẫn mở bình thường).
      if (pageInfo?.name && (isGenericPageName(pageInfo.name) || isOwnerSelfSourceName(pageInfo.name, accountName))) {
        console.log(`[BatchOpen] Bỏ qua Page giả "${pageInfo.name}" (${rawPageId}).`);
        errors.push(`Đã bỏ qua "${pageInfo.name}" - không phải Fanpage thật.`);
        continue;
      }

      const pageName = pageInfo?.name || ('Page ' + rawPageId);
      const norm = pageName.trim().toLowerCase();

      // Nếu đã có source cùng tên trong DB, ưu tiên dùng external_id sẵn có
      const existingMatch = norm ? existingByName.get(norm) : null;
      const pageId = existingMatch ? String(existingMatch.external_id) : rawPageId;

      // 1. Đảm bảo inbox source tồn tại và đã gắn owner_account_id (không cần token)
      const source = InboxSourceService.ensurePageSource({
        pageId,
        accountId,
        pageName: existingMatch?.display_name || pageName
      }, db);

      // 2. Mở tab Meta Business Suite trong Chrome của account này
      const ok = await processManager.openBusinessTabForPage(pageId, accountId);
      if (ok) {
        openedPages.push(pageId);
        if (source) {
          io.emit('INBOX_SOURCE_ADDED', {
            id: source.id,
            source_type: 'page_messenger',
            display_name: source.display_name,
            owner_account_id: accountId
          });
        }
      } else {
        errors.push(`Không thể mở tab cho Page ${pageId}`);
      }
    } catch (err) {
      console.warn(`[BatchOpen] Lỗi khi mở Page ${rawPageId}:`, err.message);
      errors.push(err.message);
    }
  }

  io.emit('THREAD_LIST_UPDATED');
  res.json({
    success: openedPages.length > 0,
    opened_count: openedPages.length,
    opened_page_ids: openedPages,
    error: openedPages.length === 0 && errors.length > 0 ? errors.join('; ') : undefined,
    errors: errors.length > 0 ? errors : undefined
  });
});

app.post('/api/accounts/new-session', async (req, res) => {
  if (!enterpriseAccess.isCompanyAdmin(req.user) && !(req.user.role === 'ADMIN' && req.user.username === 'admin')) {
    return res.status(403).json({ success: false, error: 'Chỉ Admin doanh nghiệp được thêm tài khoản Facebook.' });
  }
  // Reuse this operator's unfinished login window. A new pending profile on
  // every click loses Facebook's device cookies, makes each retry look like a
  // new browser, and leaves several heavy Chrome processes alive.
  for (const [existingPendingKey, ownerUserId] of pendingAccountOwners.entries()) {
    if (String(ownerUserId) !== String(req.user.id)) continue;
    if (processManager.getStatus(existingPendingKey) !== 'RUNNING') {
      pendingAccountOwners.delete(existingPendingKey);
      continue;
    }
    processManager.unhideWindow(existingPendingKey);
    console.log(`[API] Reuse unfinished Facebook login session: ${existingPendingKey}`);
    return res.json({ success: true, pending_key: existingPendingKey, reused: true });
  }
  // NOTE: the old on-disk recovery (scanning profiles/pending_* markers and
  // reviving the newest one after a backend restart) is intentionally gone.
  // A revived profile has no Puppeteer attachment, so the window it opens
  // carries whatever extension state a previous run left behind - in practice
  // an orphan Chrome with no working CRM extension, so nothing ever sent
  // REGISTER_ACCOUNT and the operator UI waited on "Đang chờ đăng nhập
  // Facebook..." forever (reproduced 2026-09-17). Every click now either
  // reuses an in-memory session THIS process launched (extension guaranteed
  // installed) or creates a fresh pending profile via startNewAccountProcess,
  // whose puppeteer launch installs the extension before Facebook opens.

  const now = new Date();
  const dateStr = now.toISOString().replace(/[-T:.Z]/g, '').substring(0, 14);
  const randomStr = Math.random().toString(36).substring(2, 7);
  const pendingKey = `pending_${dateStr}_${randomStr}`;
  pendingAccountOwners.set(pendingKey, req.user.id);

  const pendingProfileDir = path.join(APP_DATA_ROOT, 'profiles', pendingKey);
  fs.mkdirSync(pendingProfileDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingProfileDir, '.crm-pending-owner.json'),
    JSON.stringify({ owner_user_id: req.user.id, created_at: new Date().toISOString() })
  );

  console.log(`[API] Tạo phiên đăng ký tài khoản Facebook mới: ${pendingKey}`);
  const success = await processManager.startNewAccountProcess(pendingKey);
  if (!success) pendingAccountOwners.delete(pendingKey);
  res.json({ success, pending_key: pendingKey });
});
// The AccountManagerModal polls this every 1.5s while a setup session is
// open, as the fallback when the ACCOUNT_STATUS_CHANGED socket event is
// missed. Completed = REGISTER_ACCOUNT promoted this pending key, or an
// ACTIVE accounts row already points at the pending profile (covers a
// backend restart between register and poll).
app.get('/api/facebook-setup/:pendingKey/status', (req, res) => {
  const pendingKey = String(req.params.pendingKey || '').trim();
  if (!/^pending_[a-zA-Z0-9_]+$/.test(pendingKey)) {
    return res.status(400).json({ success: false, error: 'pending_key không hợp lệ.' });
  }
  const ownerUserId = pendingAccountOwners.get(pendingKey) || markerOwnerUserId(pendingKey);
  if (ownerUserId && String(ownerUserId) !== String(req.user.id)) {
    return res.status(403).json({ success: false, error: 'Phiên thêm tài khoản này thuộc người dùng khác.' });
  }
  let completion = completedPendingSetups.get(pendingKey);
  if (!completion) {
    const row = db.prepare("SELECT id FROM accounts WHERE profile_dir LIKE ? AND status = 'ACTIVE'").get(`%${pendingKey}%`);
    if (row) {
      completion = { account_id: String(row.id), completed_at: Date.now() };
      completedPendingSetups.set(pendingKey, completion);
    }
  }
  res.json({ success: true, completed: Boolean(completion), account_id: completion?.account_id || null });
});
app.delete('/api/accounts/:id', (req, res) => {
  try {
    const accountId = String(req.params.id || '').trim();
    completeNewAccountBootstrapSync(accountId);
    const account = enterpriseAccess.canAccessAccount(req.user, accountId)
      ? db.prepare('SELECT id, profile_dir FROM accounts WHERE id = ?').get(accountId) : null;
    if (!enterpriseAccess.isCompanyAdmin(req.user) && !(req.user.role === 'ADMIN' && req.user.username === 'admin')) {
      return res.status(403).json({ success: false, error: 'Chỉ Admin doanh nghiệp được xóa tài khoản Facebook.' });
    }
    if (!account) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản Facebook' });
    }

    // Block late REGISTER_ACCOUNT frames before terminating the detached
    // Chrome tree, otherwise the account can be recreated during deletion.
    processManager.stopAccountProcess(accountId);
    backgroundAfterConnectRequests.delete(accountId);
    const extension = extensionConnections.get(accountId);
    extensionConnections.delete(accountId);
    InboxSyncScheduler.unregisterAccount(accountId);
    domReplaySuppressUntil.delete(accountId);
    if (extension && extension.readyState === WebSocket.OPEN) {
      extension.close(1000, 'ACCOUNT_REMOVED');
    }

    const result = AccountService.removeAccount(accountId, db);
    // Xóa luôn thư mục profile Chrome của tài khoản (yêu cầu sản phẩm
    // 2026-09-17 - trước đây thư mục được cố tình giữ lại để tái sử dụng
    // Facebook trust). Chạy trễ 1.5s sau response để Chrome tree từ
    // stopAccountProcess kịp thoát và nhả file lock; rmSync có sẵn retry,
    // nếu vẫn khóa thì sweep định kỳ sẽ dọn nốt.
    const deletedAccountDir = String(account?.profile_dir || result?.profile_dir || '');
    if (deletedAccountDir) {
      setTimeout(() => { deleteChromeProfileDir(deletedAccountDir); }, 1500);
    }
    // Close a popup that may already be visible before clients remove the
    // account from their local list.
    io.emit('INCOMING_CALL_ENDED', { account_id: accountId, reason: 'ACCOUNT_REMOVED' });
    io.emit('ACCOUNT_REMOVED', { account_id: accountId });
    io.emit('INBOX_SOURCE_REMOVED', { id: 'src_personal_' + accountId });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[API] Không thể xóa tài khoản Facebook:', error);
    res.status(500).json({ success: false, error: 'Không thể xóa tài khoản Facebook', detail: error.message });
  }
});

// Threads
app.get('/api/threads/waiting-count', (req, res) => {
  try {
    // Count only Facebook accounts that this signed-in user can access. This
    // keeps the badge identical to the WAITING conversation list and ignores
    // stale or unassigned account data.
    const accessibleAccountIds = enterpriseAccess.listAccounts(req.user).map((account) => String(account.id));
    res.setHeader('Cache-Control', 'no-store');
    if (accessibleAccountIds.length === 0) return res.json({ count: 0 });
    const placeholders = accessibleAccountIds.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM threads t
      JOIN accounts a ON a.id = t.account_id
      WHERE COALESCE(t.inbox_folder, 'INBOX') IN ('MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE')
      AND t.archived_at IS NULL
      AND t.account_id IN (${placeholders})
    `).get(...accessibleAccountIds);
    res.json({ count: row?.count || 0 });
  } catch (error) {
    res.json({ count: 0 });
  }
});

app.get('/api/threads', (req, res) => {
  const { tab = 'ALL' } = req.query;
  const threads = assignmentManager.getThreadsByFilter(req.user.id, req.user.role, tab, 'all', req.user.company_id, req.user.company_role, req.user.username);
  res.json(threads);
});


function sendFollowupError(res, error) {
  return res.status(error.statusCode || 500).json({ error: error.message || 'Không thể cập nhật follow-up.' });
}

app.put('/api/threads/:id/reminder', (req, res) => {
  try {
    res.json(followupService.setReminder(req.params.id, req.body?.due_at, req.body?.note));
  } catch (error) {
    sendFollowupError(res, error);
  }
});
app.post('/api/threads/:id/reminder/complete', (req, res) => {
  try {
    res.json(followupService.completeReminder(req.params.id));
  } catch (error) {
    sendFollowupError(res, error);
  }
});
app.delete('/api/threads/:id/reminder', (req, res) => {
  try {
    res.json(followupService.cancelReminder(req.params.id));
  } catch (error) {
    sendFollowupError(res, error);
  }
});
app.post('/api/threads/:id/archive', (req, res) => {
  try {
    const result = followupService.archive(req.params.id);
    res.json({ success: true, archived_at: result.archived_at });
  } catch (error) {
    sendFollowupError(res, error);
  }
});
app.post('/api/threads/:id/restore', (req, res) => {
  try {
    followupService.restore(req.params.id);
    res.json({ success: true, archived_at: null });
  } catch (error) {
    sendFollowupError(res, error);
  }
});

// Đánh dấu chưa đọc / đã đọc bằng tay. Không gửi "unread" trong body = toggle.
app.post('/api/threads/:id/unread', (req, res) => {
  try {
    const id = req.params.id;
    const row = db.prepare('SELECT is_unread FROM threads WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });
    const desired = req.body && req.body.unread !== undefined ? Number(req.body.unread) : null;
    const next = desired === null ? (Number(row.is_unread) ? 0 : 1) : (desired ? 1 : 0);
    if (next !== Number(row.is_unread)) {
      // unread_manual 3 trạng thái: 1 = đánh tay CHƯA ĐỌC, -1 = đánh tay ĐÃ ĐỌC
      // (dính cả hai chiều, sync sidebar không được đè), 0 = tự động theo FB.
      db.prepare('UPDATE threads SET is_unread = ?, unread_manual = ? WHERE id = ?').run(next, next ? 1 : -1, id);
    }
    io.emit('THREAD_UNREAD_CHANGED', { thread_id: String(id), is_unread: next });
    res.json({ success: true, id: String(id), is_unread: next });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể cập nhật trạng thái chưa đọc.' });
  }
});

// Đánh dấu khách đã đọc: content script bắt 'Đã xem' trong DOM hội thoại
// đang mở trên tab Facebook rồi relay về đây.
app.post('/api/threads/:id/seen', (req, res) => {
  try {
    // Content script gửi BARE id từ URL (/messages/t/<psid>), còn DB lưu id
    // ghép '<account>:<psid>' cho hội thoại cá nhân - phải phân giải qua bộ
    // giải chuẩn như mọi luồng sync, không thì UPDATE không khớp hàng nào.
    const rawId = req.params.id;
    const accountId = req.body?.account_id || null;
    const canonicalId = resolveInternalThreadId(db, accountId, rawId) || rawId;
    const last = db.prepare(
      'SELECT id FROM messages WHERE thread_id = ? AND is_outgoing = 1 ORDER BY COALESCE(sequence_order, id) DESC LIMIT 1'
    ).get(canonicalId);
    if (!last) return res.json({ success: true, last_seen_message_id: null });
    const prev = db.prepare('SELECT last_seen_message_id FROM threads WHERE id = ?').get(canonicalId);
    if (String(prev?.last_seen_message_id || '') !== String(last.id)) {
      db.prepare('UPDATE threads SET last_seen_message_id = ? WHERE id = ?').run(String(last.id), canonicalId);
      io.emit('THREAD_SEEN', { thread_id: String(canonicalId), last_seen_message_id: String(last.id) });
    }
    res.json({ success: true, last_seen_message_id: String(last.id) });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể ghi nhận đã xem.' });
  }
});

// Ghim / bỏ ghim hội thoại. Không gửi "pinned" trong body = toggle.
app.post('/api/threads/:id/pin', (req, res) => {
  try {
    const id = req.params.id;
    const row = db.prepare('SELECT pinned FROM threads WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });
    const desired = req.body && req.body.pinned !== undefined ? Number(req.body.pinned) : null;
    const next = desired === null ? (Number(row.pinned) ? 0 : 1) : (desired ? 1 : 0);
    if (next !== Number(row.pinned)) {
      db.prepare('UPDATE threads SET pinned = ? WHERE id = ?').run(next, id);
    }
    io.emit('THREAD_PIN_CHANGED', { thread_id: String(id), pinned: next });
    res.json({ success: true, id: String(id), pinned: next });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể cập nhật trạng thái ghim.' });
  }
});

app.post('/api/threads/:id/assign', (req, res) => {
  const user_id = req.user.id;
  const result = assignmentManager.assignThread(req.params.id, user_id);
  if (result.success) io.emit('THREAD_ASSIGNED', { thread_id: req.params.id, user_id });
  res.json(result);
});

app.post('/api/threads/:id/complete', (req, res) => {
  const result = assignmentManager.completeThread(req.params.id);
  io.emit('THREAD_COMPLETED', { thread_id: req.params.id });
  res.json(result);
});

// Đặt lại trạng thái hoàn thành lịch sử và cho phép cào lại lịch sử
app.post('/api/threads/:id/resync', (req, res) => {
  try {
    const id = req.params.id;
    if (req.user && !enterpriseAccess.canAccessThread(req.user, id)) {
      return res.status(403).json({ error: 'Không có quyền truy cập hội thoại này.' });
    }
    const thread = db.prepare('SELECT id, account_id, history_completed FROM threads WHERE id = ?').get(id);
    if (!thread) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });

    db.prepare('UPDATE threads SET history_completed = 0 WHERE id = ?').run(id);
    InboxSyncScheduler.resetThreadHistoryCompleted(id, thread.account_id);
    io.emit('THREAD_HISTORY_RESET', { thread_id: String(id), account_id: thread.account_id });

    res.json({ success: true, id: String(id), history_completed: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể đặt lại trạng thái đồng bộ.' });
  }
});



// Contacts / Leads
// CRM one-to-one rich-message capabilities and thread-bound staging.
// This server has no user session layer yet, so new file operations fail
// closed outside loopback and content URLs additionally require a short-lived HMAC.
app.get(
  '/api/threads/:threadId/rich-message-capabilities',
  requireLocalCrmRequest,
  (req, res) => {
    try {
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });
      res.json(RichMessageCapabilityService.getForThread(
        req.params.threadId,
        getRichMessageCapabilityOptions()
      ));
    } catch (error) {
      sendRichMessageError(res, error);
    }
  }
);

app.post(
  '/api/threads/:threadId/outbound-attachments',
  requireLocalCrmRequest,
  express.raw({ type: 'multipart/form-data', limit: '105mb' }),
  (req, res) => {
    try {
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });
      const operatorId = req.user.id;
      if (operatorId == null) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'CRM chưa có operator hợp lệ.' });
      }
      const parsed = OutboundAttachmentService.parseMultipartBody(
        req.body,
        req.headers['content-type']
      );
      const attachment = OutboundAttachmentService.stageUpload({
        threadId: req.params.threadId,
        createdBy: operatorId,
        originalName: parsed.file.originalName,
        declaredMimeType: parsed.file.declaredMimeType,
        buffer: parsed.file.buffer
      }, {
        database: db,
        capabilityOptions: getRichMessageCapabilityOptions()
      });
      const access = createAttachmentContentToken(attachment.id);
      res.status(201).json({
        attachment: {
          ...attachment,
          preview_url: '/api/outbound-attachments/' + attachment.id +
            '/content?expires=' + access.expires + '&token=' + access.token
        }
      });
    } catch (error) {
      sendRichMessageError(res, error);
    }
  }
);

app.delete(
  '/api/threads/:threadId/outbound-attachments/:attachmentId',
  requireLocalCrmRequest,
  (req, res) => {
    try {
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'Không tìm thấy hội thoại.' });
      const operatorId = req.user.id;
      if (operatorId == null) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'CRM chưa có operator hợp lệ.' });
      }
      const discarded = OutboundAttachmentService.discard(
        req.params.threadId,
        req.params.attachmentId,
        operatorId,
        { database: db }
      );
      if (discarded === false) {
        return res.status(409).json({
          code: 'ATTACHMENT_NOT_DISCARDABLE',
          error: 'File không thuộc hội thoại này hoặc không còn ở trạng thái chờ gửi.'
        });
      }
      res.status(204).end();
    } catch (error) {
      sendRichMessageError(res, error);
    }
  }
);

// Serve campaign-attachment images for in-chat preview (local_media_path stores absolute path,
// but the browser can only fetch via HTTP - use a thin proxy route to pipe the file contents).
const CAMPAIGN_ATTACHMENTS_DIR = path.join(APP_DATA_ROOT, 'campaign-attachments');
app.get('/api/campaign-attachments/:filename', requireLocalCrmRequest, (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // strip any traversal
    const filePath = path.join(CAMPAIGN_ATTACHMENTS_DIR, filename);
    if (!filePath.startsWith(CAMPAIGN_ATTACHMENTS_DIR)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ error: 'File không tồn tại' });
  }
});

app.get(
  '/api/outbound-attachments/:attachmentId/content',
  requireLocalCrmRequest,
  (req, res) => {
    try {
      if (verifyAttachmentContentToken(
        req.params.attachmentId,
        req.query.expires,
        req.query.token
      ) === false) {
        return res.status(403).json({
          code: 'ATTACHMENT_TOKEN_INVALID',
          error: 'Liên kết file không hợp lệ hoặc đã hết hạn.'
        });
      }
      const attachment = OutboundAttachmentService.resolveContent(
        req.params.attachmentId,
        { database: db }
      );
      if (attachment == null) {
        return res.status(404).json({ code: 'ATTACHMENT_NOT_FOUND', error: 'Không tìm thấy file.' });
      }
      const disposition = (attachment.media_type === 'image' || attachment.media_type === 'video' || attachment.media_type === 'voice') ? 'inline' : 'attachment';
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', attachment.mime_type);
      res.set(
        'Content-Disposition',
        disposition + "; filename*=UTF-8''" + encodeURIComponent(attachment.safe_name)
      );
      res.sendFile(attachment.storage_path);
    } catch (error) {
      sendRichMessageError(res, error);
    }
  }
);

app.get('/api/contacts/:thread_id', (req, res) => {
  if (!enterpriseAccess.canAccessThread(req.user, req.params.thread_id)) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  const contact = db.prepare('SELECT * FROM contacts WHERE thread_id=?').get(req.params.thread_id) || {};
  const phoneView = PhoneCaptureService.getContactPhoneView(req.params.thread_id, db);
  res.json({ ...contact, phone_candidates: phoneView.phone_candidates, phone_capture: phoneView.phone_capture });
});

app.put('/api/contacts/:thread_id', (req, res) => {
  if (!enterpriseAccess.canAccessThread(req.user, req.params.thread_id)) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  let updatedContact;
  try {
    updatedContact = ContactService.update(req.params.thread_id, req.body, db);
  } catch (error) {
    if (error instanceof ContactService.PhoneCaptureNotFoundError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
  const phoneView = PhoneCaptureService.getContactPhoneView(req.params.thread_id, db);
  const status = updatedContact.status_id == null ? null : db.prepare(
    'SELECT name AS status_name, color AS status_color FROM lead_statuses WHERE id = ?'
  ).get(updatedContact.status_id);
  const contact = { ...updatedContact, ...phoneView, ...(status || {}) };
  io.emit('CONTACT_UPDATED', {
    thread_id: req.params.thread_id,
    phone: contact.phone,
    status_id: contact.status_id,
    status_name: contact.status_name || null,
    status_color: contact.status_color || null,
    phone_source: contact.phone_source,
    phone_captured_at: contact.phone_captured_at
  });
  res.json({ success: true, contact });
});

// Inbox Sources — Personal and Page connected sources
// Bộ lọc chi tiết ngày (2026-09-18): trả về các hội thoại có tin nhắn trong
// ngày được chọn (theo timestamp_ms của messages - nguồn ngày chuẩn khớp
// Messenger; last_activity bị trộn múi giờ nên không dùng).
app.get('/api/threads/active-on', (req, res) => {
  try {
    const dateStr = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ success: false, error: 'Thiếu/sai định dạng ngày (YYYY-MM-DD).' });
    }
    const start = new Date(dateStr + 'T00:00:00');
    if (isNaN(start.getTime())) return res.status(400).json({ success: false, error: 'Ngày không hợp lệ.' });
    const startMs = start.getTime();
    const endMs = startMs + 24 * 60 * 60 * 1000;
    // Scope bằng CÙNG logic với danh sách hội thoại đang hiển thị
    // (assignmentManager.getThreadsByFilter) - không dùng listAccounts vì
    // company_id của account có thể khác company của user (reproduced
    // 2026-09-19: filter ngày trả rỗng dù hội thoại hiển thị bình thường).
    const visible = assignmentManager.getThreadsByFilter(
      req.user.id, req.user.role, 'ALL', 'all', req.user.company_id, req.user.company_role, req.user.username
    );
    const visibleIds = new Set(visible.map((t) => String(t.id)));
    const rows = db.prepare(
      'SELECT DISTINCT thread_id AS id FROM messages WHERE timestamp_ms >= ? AND timestamp_ms < ?'
    ).all(startMs, endMs);
    const threadIds = rows.map((r) => String(r.id)).filter((id) => visibleIds.has(id));
    res.json({ success: true, date: dateStr, thread_ids: threadIds });
  } catch (error) {
    console.error('[API] active-on lỗi:', error.message);
    res.status(500).json({ success: false, error: 'Không thể lọc theo ngày.' });
  }
});

app.get('/api/inbox-sources', (req, res) => {
  try {
    const accountIds = enterpriseAccess.listAccounts(req.user).map(account => String(account.id));
    const sources = accountIds.length ? db.prepare(`
      SELECT id,source_type,owner_account_id,external_id,display_name,avatar_url,status,webhook_verify_token,created_at
      FROM inbox_sources WHERE owner_account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY created_at ASC
    `).all(...accountIds) : [];
    res.json(sources);
  } catch (error) {
    console.error('[InboxSource] Fetch failed:', error);
    res.status(500).json({ error: error.message || 'Không thể lấy danh sách nguồn hội thoại' });
  }
});

// Manual "Kết nối Page" flow (AccountManagerModal) — this only ever accepted a
// raw Page ID or a profile.php?id= link (per the UI's own placeholder text;
// no Graph API token is actually needed since the extension does DOM
// automation, not the Graph API), but no route ever backed the POST the
// frontend sends here — every submit 404'd and Express's default handler
// returned an HTML page, which broke on the client's res.json() with
// "Unexpected token '<' ... is not valid JSON". Reuses ensurePageSource(),
// the same idempotent upsert the automatic page_dom_observer path already
// uses, so a manually-added Page behaves identically to an auto-detected one.
app.post('/api/inbox-sources/page', (req, res) => {
  try {
    const raw = String(req.body?.page_access_token || '').trim();
    const requestedOwnerAccountId = req.body?.owner_account_id || null;
    const ownerAccountId = requestedOwnerAccountId && enterpriseAccess.canAccessAccount(req.user, requestedOwnerAccountId)
      ? String(requestedOwnerAccountId)
      : null;
    if (!raw) return res.status(400).json({ error: 'Thiếu Link Page hoặc ID Page' });

    const pageId = parsePageIdFromInput(raw);
    if (!pageId) {
      return res.status(400).json({ error: 'Không nhận diện được ID Page. Dùng ID số hoặc link dạng facebook.com/profile.php?id=...' });
    }

    if (!ownerAccountId) return res.status(403).json({ error: 'Tài khoản Facebook sở hữu Page không hợp lệ hoặc bạn không có quyền truy cập.' });
    const source = InboxSourceService.ensurePageSource({ pageId, accountId: ownerAccountId, pageName: null }, db);
    // Mở trực tiếp tab Hộp thư Meta Business Suite trên profile Chrome đã đăng nhập
    // của tài khoản sở hữu Page để extension đồng bộ tin nhắn ngay lập tức.
    processManager.openPageInboxInAccountChrome(ownerAccountId, pageId).catch((launchError) => {
      console.warn(`[InboxSource] Không thể mở Business Suite cho Page ${pageId}:`, launchError.message);
    });
    io.emit('INBOX_SOURCE_ADDED', { id: source.id, source_type: 'page_messenger', display_name: source.display_name });
    res.json(source);
  } catch (error) {
    console.error('[InboxSource] Kết nối Page thủ công thất bại:', error);
    res.status(500).json({ error: error.message || 'Không thể kết nối Page' });
  }
});

// Lead Statuses — staff-created, reusable, color-coded (feature 022)
// Quản lý màu nhãn khách hàng (2026-09-19): bảng lead_tags (name + color).
app.get('/api/lead-tags', (req, res) => {
  try {
    const tags = db.prepare('SELECT id, name, color, text_color FROM lead_tags ORDER BY name COLLATE NOCASE ASC').all();
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: 'Không thể tải danh sách nhãn.' });
  }
});
app.post('/api/lead-tags', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 50);
    const isHex = (s) => /^#[0-9a-fA-F]{6}$/.test(String(s || ''));
    const color = isHex(req.body?.color) ? req.body.color : '#6366F1';
    const textColor = isHex(req.body?.text_color) ? req.body.text_color : '#FFFFFF';
    if (!name) return res.status(400).json({ error: 'Tên nhãn không được để trống.' });
    const existing = db.prepare('SELECT id, name FROM lead_tags WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) {
      db.prepare('UPDATE lead_tags SET color = ?, text_color = ? WHERE id = ?').run(color, textColor, existing.id);
      return res.json({ id: existing.id, name: existing.name, color, text_color: textColor });
    }
    const r = db.prepare('INSERT INTO lead_tags (name, color, text_color) VALUES (?, ?, ?)').run(name, color, textColor);
    res.json({ id: Number(r.lastInsertRowid), name, color, text_color: textColor });
  } catch (error) {
    res.status(500).json({ error: 'Không thể lưu nhãn.' });
  }
});
app.delete('/api/lead-tags/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM lead_tags WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Không thể xóa nhãn.' });
  }
});
app.get('/api/lead-statuses', (req, res) => {
  res.json(db.prepare('SELECT id, name, color FROM lead_statuses ORDER BY id ASC').all());
});

app.post('/api/lead-statuses', (req, res) => {
  try {
    res.json(LeadStatusService.create(req.body, db));
  } catch (error) {
    if (error instanceof LeadStatusService.LeadStatusValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[LeadStatus] Create failed:', error);
    return res.status(500).json({ error: 'Không thể tạo trạng thái mới.' });
  }
});

app.delete('/api/lead-statuses/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id không hợp lệ' });
  const txn = db.transaction(() => {
    const { changes: unassignedCount } = db.prepare('UPDATE contacts SET status_id = NULL WHERE status_id = ?').run(id);
    // campaigns.phone_capture_status_id deliberately has no FK constraint
    // (spec 035, FR-012) - a campaign may keep pointing at a since-deleted
    // status; a capture arriving afterward reports phone_capture_status_unavailable
    // instead of silently losing the fact that a status was ever configured.
    db.prepare('DELETE FROM lead_statuses WHERE id = ?').run(id);
    return unassignedCount;
  });
  const unassignedCount = txn();
  res.json({ success: true, unassigned_count: unassignedCount });
});

// Quick Templates — staff-created canned responses saved in SQLite
app.get('/api/quick-templates', (req, res) => {
  try {
    const templates = db.prepare('SELECT id, title, content, sort_order, created_at FROM quick_templates ORDER BY sort_order ASC, id ASC').all();
    res.json(templates);
  } catch (error) {
    console.error('[QuickTemplates] Get all failed:', error);
    res.status(500).json({ error: 'Không thể lấy danh sách mẫu câu.' });
  }
});

app.post('/api/quick-templates', (req, res) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : null;
    if (!content) {
      return res.status(400).json({ error: 'Nội dung mẫu câu không được để trống.' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: 'Nội dung mẫu câu không được vượt quá 2000 ký tự.' });
    }
    const allTemplates = db.prepare('SELECT id, content FROM quick_templates').all();
    const normalizedNew = content.toLowerCase();
    const isDuplicate = allTemplates.some(t => String(t.content || '').trim().toLowerCase() === normalizedNew);
    if (isDuplicate) {
      return res.status(400).json({ error: 'Mẫu câu này đã tồn tại trong danh sách.' });
    }
    const maxOrderRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM quick_templates').get();
    const nextOrder = (maxOrderRow?.max_order || 0) + 1;
    const stmt = db.prepare('INSERT INTO quick_templates (title, content, sort_order) VALUES (?, ?, ?)');
    const info = stmt.run(title, content, nextOrder);
    const created = db.prepare('SELECT id, title, content, sort_order, created_at FROM quick_templates WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, template: created });
  } catch (error) {
    console.error('[QuickTemplates] Create failed:', error);
    res.status(500).json({ error: 'Không thể tạo mẫu câu mới.' });
  }
});

app.delete('/api/quick-templates/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id mẫu câu không hợp lệ' });
    }
    const result = db.prepare('DELETE FROM quick_templates WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy mẫu câu để xóa.' });
    }
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('[QuickTemplates] Delete failed:', error);
    res.status(500).json({ error: 'Không thể xóa mẫu câu.' });
  }
});

// Avatar serving - serves local avatar files
app.get('/api/avatars/:filename', serveAvatar);

// Search
app.get('/api/search', (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'Thiếu query q' });
  res.json(searchService.searchMessages(q, Number(limit) || 50));
});

// Leads export
app.get('/api/leads', (req, res) => res.json(searchService.getCapturedLeads()));
app.post('/api/leads/export/excel', async (req, res) => {
  try { res.download(await exportService.exportLeadsToExcel()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/leads/export/csv', (req, res) => {
  try { res.download(exportService.exportLeadsToCSV()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Task 4.1: Auto-Reply CRUD ──
app.get('/api/accounts/:id/auto-replies', (req, res) => {
  res.json(autoReplyEngine.getRules(req.params.id));
});
app.post('/api/accounts/:id/auto-replies', (req, res) => {
  const { trigger_keyword, response_template } = req.body;
  res.json(autoReplyEngine.createRule({
    account_id: req.params.id, trigger_keyword, response_template
  }));
});
app.patch('/api/auto-replies/:id/toggle', (req, res) => {
  res.json(autoReplyEngine.toggleRule(Number(req.params.id), req.body.is_active));
});
app.delete('/api/auto-replies/:id', (req, res) => {
  res.json(autoReplyEngine.deleteRule(Number(req.params.id)));
});


function sendCampaignError(res, error) {
  const statusByCode = {
    CAMPAIGN_NOT_FOUND: 404,
    CAMPAIGN_STATE_CONFLICT: 409,
    RECIPIENT_ALREADY_SENT: 409,
    ATTACHMENT_TOO_LARGE: 413
  };
  const status = statusByCode[error.code] || 400;
  return res.status(status).json({
    error: {
      code: error.code || "CAMPAIGN_ERROR",
      message: error.message || "Campaign request failed",
      details: error.details || null
    }
  });
}

function addOperatorCampaignAudit(campaignId, eventType, payload = {}, recipientId = null) {
  const campaign = db.prepare('SELECT created_by FROM campaigns WHERE id = ?').get(campaignId);
  return CampaignRepository.addAudit(
    campaignId,
    eventType,
    payload,
    recipientId,
    db,
    {
      actorUserId: campaign?.created_by || 1,
      actorType: 'operator'
    }
  );
}

app.get('/api/settings/phone-automation', (req, res) => {
  res.json(GlobalPhoneAutomationService.get(db));
});

app.put('/api/settings/phone-automation', (req, res) => {
  try {
    const settings = GlobalPhoneAutomationService.update(req.body || {}, db);
    io.emit('PHONE_AUTOMATION_SETTINGS_UPDATED', settings);
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code || 'PHONE_AUTOMATION_ERROR' });
  }
});

app.get('/api/campaigns/config', (req, res) => {
  const { testSourceIds, ...publicConfig } = CampaignService.getConfig();
  res.json({ ...publicConfig, testSourceCount: testSourceIds.length });
});

app.get("/api/campaigns", (req, res) => {
  res.json(CampaignRepository.listCampaigns(req.query.limit));
});

app.post("/api/campaigns", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const campaign = CampaignService.createDraft({ ...(req.body || {}), created_by: req.user.id }, db, {
      getConnection: (accountId) => extensionConnections.get(accountId)
    });
    res.status(201).json(campaign);
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.get("/api/campaigns/:id", (req, res) => {
  const campaign = CampaignRepository.getCampaign(req.params.id);
  if (!campaign) return sendCampaignError(res, { code: "CAMPAIGN_NOT_FOUND", message: "Không tìm thấy chiến dịch." });
  res.json(campaign);
});

app.get('/api/campaigns/:id/response-stats', (req, res) => {
  try {
    const statistics = CampaignResponseStatsService.get(req.params.id, db);
    if (!statistics) return sendCampaignError(res, { code: 'CAMPAIGN_NOT_FOUND', message: 'Không tìm thấy chiến dịch.' });
    res.json(statistics);
  } catch (error) {
    console.error('[Campaign response stats]', error);
    res.status(500).json({ error: { code: 'CAMPAIGN_STATS_ERROR', message: 'Không thể tải thống kê phản hồi.' } });
  }
});

app.patch('/api/campaigns/:id', (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const campaign = CampaignService.updateDraft(req.params.id, req.body || {});
    CampaignEventService.emit(io, campaign);
    res.json(campaign);
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.post("/api/campaigns/:id/preview", (req, res) => {
  try {
    res.json(CampaignService.preview(req.params.id));
  } catch (error) {
    sendCampaignError(res, error);
  }
});
app.post('/api/campaigns/:id/attachments', express.raw({ type: 'multipart/form-data', limit: '50mb' }), async (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const parsed = CampaignAttachmentService.parseMultipartBody(req.body, req.headers['content-type']);
    const config = CampaignService.getConfig();
    const files = parsed.files || [parsed.file];
    // Folder selections are sent with fields.kind='folder_zip' and each part's
    // declared filename carrying the browser's webkitRelativePath (set as the
    // File's third FormData.append argument client-side) instead of a bare
    // basename - see CampaignComposer.jsx.
    const isFolderUpload = parsed.fields.kind === 'folder_zip';
    const attachment = isFolderUpload
      ? await CampaignAttachmentService.saveFolderAsZip({
          campaignId: req.params.id,
          campaignMessageId: parsed.fields.campaign_message_id,
          archiveName: parsed.fields.archive_name || 'folder.zip',
          files: files.map((file) => ({
            relativePath: file.originalName,
            declaredMimeType: file.declaredMimeType,
            buffer: file.buffer
          }))
        }, {
          database: db,
          fileEnabled: config.fileEnabled,
          maxBytes: config.fileEnabled ? config.maxAttachmentBytes : CampaignAttachmentService.DEFAULT_MAX_FILE_BYTES
        })
      : CampaignAttachmentService.saveUploads({
          campaignId: req.params.id,
          campaignMessageId: parsed.fields.campaign_message_id,
          files
        }, {
          database: db,
          imageEnabled: config.imageEnabled,
          fileEnabled: config.fileEnabled,
          maxBytes: config.fileEnabled ? config.maxAttachmentBytes : CampaignAttachmentService.DEFAULT_MAX_IMAGE_BYTES,
          allowAnyFile: config.fileEnabled
        });
    const campaign = CampaignRepository.getCampaign(req.params.id);
    CampaignEventService.emit(io, campaign);
    res.status(201).json({ attachment: Array.isArray(attachment) && attachment.length === 1 ? attachment[0] : attachment, attachments: attachment, campaign });
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.delete('/api/campaigns/:id/attachments/:attachmentId', (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const removed = CampaignAttachmentService.removeAttachment(req.params.id, req.params.attachmentId, { database: db });
    const campaign = CampaignRepository.getCampaign(req.params.id);
    CampaignEventService.emit(io, campaign);
    res.json({ removed, campaign });
  } catch (error) {
    sendCampaignError(res, error);
  }
});


app.post("/api/campaigns/:id/start", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    CampaignService.validateReadyForStart(req.params.id);
    const transitioned = CampaignRepository.updateCampaignStatus(req.params.id, "ready", "running");
    if (!transitioned) {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Campaign đã được xử lý bởi yêu cầu khác.');
    }
    addOperatorCampaignAudit(req.params.id, 'started', { status: 'running' });
    campaignRunner.start(req.params.id);
    CampaignEventService.emit(io, CampaignRepository.getCampaign(req.params.id));
    res.json(CampaignRepository.getCampaign(req.params.id));
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.post("/api/campaigns/:id/pause", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const campaign = CampaignService.assertTransition(req.params.id, "pause");
    if (!CampaignRepository.updateCampaignStatus(req.params.id, "running", "pausing")) {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Yêu cầu pause bị trùng.');
    }
    addOperatorCampaignAudit(req.params.id, 'pause_requested', { status: 'pausing' });
    CampaignEventService.emit(io, CampaignRepository.getCampaign(req.params.id));
    res.json(CampaignRepository.getCampaign(req.params.id));
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.post("/api/campaigns/:id/resume", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const campaign = CampaignService.assertTransition(req.params.id, "resume");
    // Spec 038 FR-006/SC-003: a recipient whose route went bad while paused
    // must fail closed on its own, not block resume for the rest of the
    // campaign. enqueueCampaignMessage revalidates again right before that
    // recipient's own dispatch, so it still fails closed there if still invalid.
    campaign.recipients
      .filter((recipient) => recipient.status === 'pending')
      .forEach((recipient) => {
        try {
          CampaignEligibilityService.revalidateSnapshotRecipient(recipient, db, {
            getConnection: (accountId) => extensionConnections.get(accountId)
          });
        } catch (error) {
          // Ignored here by design - see comment above.
        }
      });
    if (!CampaignRepository.updateCampaignStatus(req.params.id, "paused", "running")) {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Yêu cầu resume bị trùng.');
    }
    addOperatorCampaignAudit(req.params.id, 'resumed', { status: 'running' });
    campaignRunner.start(req.params.id);
    CampaignEventService.emit(io, CampaignRepository.getCampaign(req.params.id));
    res.json(CampaignRepository.getCampaign(req.params.id));
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.post("/api/campaigns/:id/cancel", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    const campaign = CampaignService.assertTransition(req.params.id, "cancel");
    if (!CampaignRepository.updateCampaignStatus(req.params.id, campaign.status, "cancelling")) {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Yêu cầu cancel bị trùng.');
    }
    addOperatorCampaignAudit(req.params.id, 'cancel_requested', { status: 'cancelling' });
    campaignRunner.start(req.params.id);
    CampaignEventService.emit(io, CampaignRepository.getCampaign(req.params.id));
    res.json(CampaignRepository.getCampaign(req.params.id));
  } catch (error) {
    sendCampaignError(res, error);
  }
});

app.post("/api/campaigns/:id/recipients/:recipientId/retry", (req, res) => {
  try {
    CampaignService.assertFeatureEnabled();
    let campaign = CampaignRepository.getCampaign(req.params.id);
    if (!campaign) return sendCampaignError(res, { code: "CAMPAIGN_NOT_FOUND", message: "Không tìm thấy chiến dịch." });
    if (["running", "pausing", "cancelling"].includes(campaign.status)) {
      return sendCampaignError(res, { code: "CAMPAIGN_STATE_CONFLICT", message: "Hãy tạm dừng chiến dịch trước khi retry thủ công." });
    }
    const recipient = campaign.recipients.find((item) => item.id === req.params.recipientId);
    if (!recipient) {
      throw new CampaignService.CampaignError('INVALID_RECIPIENT', 'Recipient không thuộc campaign.');
    }
    if (recipient.status === 'sent') {
      throw new CampaignService.CampaignError('RECIPIENT_ALREADY_SENT', 'Recipient đã gửi thành công.');
    }
    if (recipient.status !== 'failed') {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Chỉ recipient failed mới có thể retry.');
    }
    CampaignEligibilityService.revalidateSnapshotRecipient(recipient, db, {
      getConnection: (accountId) => extensionConnections.get(accountId)
    });
    CampaignRepository.retryRecipient(req.params.id, req.params.recipientId);
    campaign = CampaignRepository.getCampaign(req.params.id);
    const shouldRun = ['completed_with_errors', 'failed', 'cancelled'].includes(campaign.status);
    if (shouldRun) {
      if (!CampaignRepository.updateCampaignStatus(req.params.id, campaign.status, 'ready')) {
        throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Retry đã được xử lý bởi yêu cầu khác.');
      }
      CampaignService.validateReadyForStart(req.params.id);
      if (!CampaignRepository.updateCampaignStatus(req.params.id, 'ready', 'running')) {
        throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Không thể khởi động retry.');
      }
    }
    addOperatorCampaignAudit(
      req.params.id,
      'recipient_retry_requested',
      { recipient_id: req.params.recipientId, status: shouldRun ? 'running' : campaign.status },
      req.params.recipientId
    );
    if (shouldRun) campaignRunner.start(req.params.id);
    const latest = CampaignRepository.getCampaign(req.params.id);
    CampaignEventService.emit(io, latest, latest.recipients.find((item) => item.id === req.params.recipientId));
    res.json(latest);
  } catch (error) {
    sendCampaignError(res, error);
  }
});


// ── Task 4.2: Broadcast ──
app.get('/api/accounts/:id/broadcast/quota', (req, res) => {
  res.json(broadcastEngine.getDailyQuota(req.params.id));
});

app.post('/api/accounts/:id/broadcast', async (req, res) => {
  const { thread_ids, message } = req.body;
  if (!thread_ids?.length || !message) {
    return res.status(400).json({ error: 'Thiếu thread_ids hoặc message' });
  }
  try {
    const campaignId = await broadcastEngine.startCampaign({
      account_id: req.params.id,
      thread_ids,
      message,
      sendFn: sendViaExtension,
      onProgress: (progress) => io.emit('BROADCAST_PROGRESS', progress)
    });
    res.json({ success: true, campaignId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/broadcast/:campaignId/cancel', (req, res) => {
  res.json(broadcastEngine.cancelCampaign(req.params.campaignId));
});

// ── Task 4.3: AI Config CRUD ──
app.get('/api/accounts/:id/ai-config', (req, res) => {
  const config = aiMediator.getConfig(req.params.id);
  // Mask API key trước khi trả về
  if (config?.api_key) config.api_key = config.api_key.slice(0, 8) + '***';
  res.json(config || {});
});

app.put('/api/accounts/:id/ai-config', (req, res) => {
  res.json(aiMediator.upsertConfig({ account_id: req.params.id, ...req.body }));
});

app.patch('/api/accounts/:id/ai-config/toggle', (req, res) => {
  res.json(aiMediator.toggleAI(req.params.id, req.body.is_active));
});

app.post('/api/threads/:id/ai/pause', (req, res) => {
  res.json(aiMediator.pauseForThread(req.params.id));
});

app.post('/api/threads/:id/ai/resume', (req, res) => {
  res.json(aiMediator.resumeForThread(req.params.id));
});

app.get('/api/ollama/health', async (req, res) => {
  const isOnline = await aiMediator.checkOllamaHealth();
  res.json({ online: isOnline });
});

// Messages REST API - With UI Guard Filter
app.get('/api/threads/:id/messages', async (req, res) => {
  if (!enterpriseAccess.canAccessThread(req.user, req.params.id)) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  try {
    OutboundDomCorrelationService.collapseStoredMediaCompanions(db, req.params.id);
    OutboundDomCorrelationService.collapseStoredTemporaryIdUpgrades(db, req.params.id);
  } catch (error) {
    console.warn('[MESSAGE_READ_REPAIR] Skipped unsafe legacy collapse:', error.message);
  }
  // Return Facebook media URLs immediately and persist them in the background.
  // Waiting for every old video here blocked polling and outbound file staging.
  inboundMediaHydration.hydrateThread(req.params.id);
  // A failed outbound attempt is terminal. Remove it before reading so an old
  // pending row can never reappear as a retry bubble after app startup.
  deleteOutboundMessageRows({ threadId: req.params.id, failedOnly: true });

  // Cleanup stale pending/temporary rows that were already confirmed via DOM / FB mid
  cleanupStalePendingOutbound(req.params.id);
  // Chuẩn hóa thứ tự sequence_order theo dòng thời gian trước khi trả về
  ConversationRepository.normalizeMessageSequence(req.params.id, db);

  // `id` is the durable per-database receive sequence. is_outgoing identifies
  // the side (0 = customer, 1 = operator); timestamps are display-only.
  const msgs = db.prepare(`
    SELECT * FROM messages WHERE thread_id=?
    ORDER BY COALESCE(sequence_order, id) ASC, id ASC
  `).all(req.params.id);
  res.json(prepareMessagesForClient(msgs));
});

// Lightweight sync-hint endpoint: fb_message_id + timestamp_ms only, no
// content/media - used by page_content.js/content.js to re-seed their
// client-side timestamp-anchor map after a script restart (feature 014).
app.get('/api/threads/:id/message-timestamps', (req, res) => {
  if (!enterpriseAccess.canAccessThread(req.user, req.params.id)) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  res.json(ConversationRepository.getMessageTimestamps(req.params.id));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// ────────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
function startServer() {
  const allowedProfileDirs = db.prepare('SELECT profile_dir FROM accounts WHERE profile_dir IS NOT NULL').all()
    .map(({ profile_dir }) => path.isAbsolute(profile_dir)
      ? profile_dir
      : path.resolve(__dirname, '../..', profile_dir));
  processManager.stopOrphanedManagedChromeProfiles(allowedProfileDirs);

  const listenPromise = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`[Server] http://localhost:${PORT}`);
      console.log(`[Server] WebSocket ws://localhost:${PORT}`);
      resolve({ port: Number(PORT), pid: process.pid });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '0.0.0.0');
  });

    // Dọn dẹp các tên rác hệ thống (ví dụ: "Tất cả tin nhắn", "Hộp thư đến", "Tin nhắn") đã lưu vào CSDL trước đây
  try {
    const dirtySystemNames = [
      'Tất cả tin nhắn', 'Tất cả', 'All messages', 'All',
      'Tin nhắn trực tiếp', 'Direct messages',
      'Tin nhắn', 'Messages',
      'Hộp thư đến', 'Hộp thư', 'Inbox',
      'Chưa đọc', 'Unread', 'Đã xong', 'Done',
      'Gắn dấu sao', 'Đã gắn dấu sao', 'Starred',
      'Spam', 'Thư rác', 'Đang', 'Facebook', 'Messenger', 'Meta'
    ];
    const placeholders = dirtySystemNames.map(() => '?').join(',');
    db.prepare(`
      UPDATE threads 
      SET contact_name = 'Khách hàng' 
      WHERE contact_name IN (${placeholders}) 
         OR contact_name LIKE 'Đang hoạt động%' 
         OR contact_name LIKE 'Hoạt động%'
    `).run(...dirtySystemNames);
    db.prepare(`
      UPDATE contacts 
      SET name = 'Khách hàng' 
      WHERE name IN (${placeholders}) 
         OR name LIKE 'Đang hoạt động%' 
         OR name LIKE 'Hoạt động%'
    `).run(...dirtySystemNames);

    // Dọn dẹp tin nhắn rác từ các nút menu Meta Business Suite & chuẩn hóa lại thứ tự tin nhắn
    db.prepare(`
      DELETE FROM messages 
      WHERE (content IN ('Meta Business Suite', 'Liên kết', 'Chỉnh sửa', 'Trợ giúp', 'Tùy chọn khác', 'Cài đặt') OR content LIKE '%Meta Business Suite%')
        AND (timestamp_ms IS NULL OR timestamp_ms <= 0)
    `).run();

    const activeThreads = db.prepare('SELECT DISTINCT thread_id FROM messages').all();
    for (const { thread_id } of activeThreads) {
      if (thread_id) ConversationRepository.normalizeMessageSequence(thread_id, db);
    }
  } catch (cleanErr) {
    console.warn('[DB] Lỗi dọn dẹp tên hệ thống / chuẩn hóa sequence:', cleanErr.message);
  }

  // Drains message_queue (Page-thread sends routed there by sendViaExtension,
  // feature 015) and dispatches SEND_QUEUED_MESSAGE to the right extension
  // connection. Was never wired up here before feature 015, so queued messages
  // had nothing to pop them.
  queueWorker.configure({
    database: db,
    getConnection: (accountId) => extensionConnections.get(accountId),
    campaignEnabled: () => CampaignService.getConfig().enabled,
    onQueueFail: (message, reason) => {
      if (message.outbound_attempt_id) {
        const attempt = OutboundAttemptRepository.getById(message.outbound_attempt_id, db);
        const richMessage = attempt
          ? db.prepare('SELECT * FROM messages WHERE id = ?').get(attempt.message_id)
          : null;
        if (richMessage) {
          db.prepare(
            "UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?"
          ).run(reason, richMessage.id);
          io.emit('MESSAGE_SEND_STATUS', {
            thread_id: richMessage.thread_id,
            client_message_id: richMessage.client_message_id,
            message_id: richMessage.id,
            attempt_id: message.outbound_attempt_id,
            status: 'failed',
            fb_message_id: null,
            confirmation_source: null,
            error: { code: reason, message: reason },
            updated_at: new Date().toISOString()
          });
        }
        return;
      }
      const clientMessageId = `queue_${message.id}`;
      db.prepare(`
        UPDATE messages SET delivery_status = 'failed', delivery_error = ?
        WHERE client_message_id = ?
      `).run(reason, clientMessageId);
      io.emit('MESSAGE_SEND_FAILED', { thread_id: message.thread_id, client_message_id: clientMessageId, success: false, status: 'failed', error: reason });
    }
  });
  const staleRichRecovery = queueWorker.recoverStaleRichDispatches();
  if (staleRichRecovery.dispatching || staleRichRecovery.awaiting_confirmation) {
    console.warn('[QueueWorker] Recovered stale rich-message sends:', staleRichRecovery);
  }
  campaignRunner.configure({
    enqueueMessage: enqueueCampaignMessage,
    emit: (campaign, recipient) => CampaignEventService.emit(io, campaign, recipient)
  });
  const recoverySummary = CampaignRecoveryService.reconcile({ database: db });
  console.log('[CampaignRecovery]', recoverySummary);
  queueWorker.start();
  if (CampaignService.getConfig().enabled) {
    setTimeout(() => campaignRunner.recover(), 1500);
  }

  // Tự kết nối lại mọi tài khoản Facebook khi mở lại app (yêu cầu 2026-09-29):
  // Chrome của account chết theo app nên trước đây phải bấm "Kết nối" thủ công.
  // Chạy cùng luồng với nút Kết nối: đăng ký ẩn nền sau khi extension kết nối,
  // khởi động Chrome + mở tab Business Suite cho từng Page (không bật sáng cửa
  // sổ), rồi chủ động ẩn Chrome khi extension đã đăng ký. Nối tiếp nhau để
  // tránh nhiều Chrome khởi động tranh nhau cùng lúc.
  const autoReconnectTimer = setTimeout(() => {
    (async () => {
      const accounts = db.prepare('SELECT id FROM accounts').all();
      for (const acc of accounts) {
        const accountId = String(acc.id);
        const requestedAt = Date.now();
        try {
          backgroundAfterConnectRequests.set(accountId, requestedAt);
          // 2026-09-30: Chrome do chính server vừa khởi tạo thì KHÔNG force-reload
          // (trước đây force=true kill Chrome mới launch 4s + mở lại 13 tab = spike
          // gấp đôi). Chỉ force khi Chrome là mồ côi từ run trước (extension cũ).
          const forceReload = !processManager.wasLaunchedByThisRun(accountId);
          const started = await processManager.startAccountProcess(accountId, null, { forceExtensionReload: forceReload });
          if (!started) {
            backgroundAfterConnectRequests.delete(accountId);
            continue;
          }
          const pageSources = activePageSourcesForAccount(accountId);
          for (const source of pageSources) {
            try { await processManager.startPageProcess(source.page_id, accountId, { skipUnhide: true }); } catch (_) {}
          }
          // Watchdog 2026-10-01: nhanh "reuse" (Chrome do server vua launch, khong
          // force-reload) khong co co che tu chua - neu service worker cua extension
          // khong bao gio noi duoc WS thi account nam im o "Chua ket noi" mai khong
          // he lay lai (reproduce 2026-10-01: 13 tab mo dung, Facebook dang nhap OK,
          // nhung khong co mot dong "[WS] Extension connected" nao trong log server).
          // Cho mot cua co han (env FB_CRM_EXTENSION_WATCHDOG_MS, mac dinh 45s);
          // het cua ma van chua thay extension dang ky thi force-reload extension
          // DUNG MOT LAN - dung luong cu tu-nhan-duoc cua kich ban 4s truoc day.
          // startAccountProcess(force) tu mo lai tab Messenger + cac tab Business
          // Suite theo dot nen khong can mo lai trang o day.
          if (!forceReload) {
            const watchdogMs = Number(process.env.FB_CRM_EXTENSION_WATCHDOG_MS || 45000);
            const watchdogDeadline = Date.now() + watchdogMs;
            while (Date.now() < watchdogDeadline
              && backgroundAfterConnectRequests.get(accountId) === requestedAt
              && !extensionConnections.has(accountId)) {
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            if (!extensionConnections.has(accountId)
              && backgroundAfterConnectRequests.get(accountId) === requestedAt) {
              console.warn(`[AUTO_RECONNECT] account=${accountId} extension chua dang ky sau ${watchdogMs}ms - force-reload extension 1 lan (watchdog).`);
              const reloaded = await processManager.startAccountProcess(accountId, null, { forceExtensionReload: true });
              if (reloaded) {
                console.log(`[AUTO_RECONNECT] account=${accountId} watchdog force-reload xong - cho extension dang ky lai.`);
              }
            }
          }
          // Ẩn Chrome chạy ngầm sau khi các tab Page đã mở xong (mở tab thủ công
          // unhide ngay, phải ẩn lại sau cùng). Retry nhiều nhịp phòng extension
          // đăng ký chậm; dừng khi user bấm Bật hiển thị / Kết nối thủ công
          // (xoá backgroundAfterConnectRequests) hoặc register-path đã tự ẩn.
          if (!KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE) {
            for (const delayMs of [6000, 20000, 60000, 150000]) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              if (backgroundAfterConnectRequests.get(accountId) !== requestedAt) break;
              if (!extensionConnections.has(accountId)) continue;
              const hideResult = await processManager.hideAccountProcess(accountId);
              if (hideResult?.success) {
                backgroundAfterConnectRequests.delete(accountId);
                io.emit('ACCOUNT_DISPLAY_CHANGED', {
                  account_id: accountId,
                  chrome_display_mode: 'BACKGROUND',
                  is_chrome_running: true
                });
                break;
              }
            }
          }
          // Phase 4 (2026-10-01): log nay truoc day in VO DIEU KIEN sau moi vong
          // lap - ke ca khi extension chua bao gio noi WS - gay hieu nham "da
          // ket noi" khi dang that (reproduce 2026-10-01: SW chet vi process.env
          // nhung log van bao "Da tu ket noi"). Chi bao thanh cong khi extension
          // that su da dang ky; nguoc lai in canh bao ro rang.
          if (extensionConnections.has(accountId)) {
            console.log(`[AUTO_RECONNECT] Đã tự kết nối account ${accountId} khi khởi động.`);
          } else {
            console.warn(`[AUTO_RECONNECT] account=${accountId} CHUA thay extension dang ky sau khoi dong - "Chưa kết nối" là đúng thực tế, xem log watchdog/force-reload phía trên.`);
          }
        } catch (err) {
          backgroundAfterConnectRequests.delete(accountId);
          console.warn(`[AUTO_RECONNECT] Lỗi tự kết nối account ${accountId}:`, err.message);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    })();
  }, 4000);

  return listenPromise;
}

InitialMessageSweepService.configure({
  listThreads: (accountId) => db.prepare(`
    SELECT t.id, t.external_thread_id, t.thread_url, t.contact_name,
           t.is_unread, t.last_activity, t.last_message,
           CASE WHEN s.source_type = 'page_messenger' THEN s.external_id ELSE NULL END AS page_id,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
           (SELECT MAX(m.timestamp_ms) FROM messages m WHERE m.thread_id = t.id) AS last_msg_ts
    FROM threads t
    LEFT JOIN inbox_sources s ON s.id = t.source_id
    WHERE t.account_id = ? AND t.archived_at IS NULL
      AND COALESCE(t.sync_status, 'LOCAL') <> 'SYNCED'
    ORDER BY
      CASE WHEN COALESCE(t.is_unread, 0) = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) = 0 THEN 0 ELSE 1 END ASC,
      t.last_activity DESC
  `).all(String(accountId)),
  // 2026-09-30 (Phase 1): bỏ qua sweep của thread không có gì mới - preview
  // sidebar (threads.last_message, cập nhật liên tục từ BS) trùng tin cuối đã
  // lưu. Tiết kiệm hàng trăm navigate cho thread cũ, máy 8GB hết bão CPU.
  shouldSkipSweep: (thread) => {
    try {
      const preview = String(thread?.last_message || '');
      if (!preview.trim()) return false;
      if (Number(thread?.is_unread) === 1) return false;
      // 2026-09-30 (Phase 2.3): thread lạnh - tin cuối cũ hơn 30 ngày mà
      // không unread -> defer (Tier 2 on-demand), ưu tiên thread đang hoạt
      // động. Cấu hình qua env FB_CRM_STALE_THREAD_DAYS.
      if (isStaleThreadLastActivity({
        lastMsgTs: thread?.last_msg_ts,
        staleDays: Number(process.env.FB_CRM_STALE_THREAD_DAYS || 30)
      })) {
        return true;
      }
      const last = db.prepare(`
        SELECT content FROM messages
        WHERE thread_id = ? AND content IS NOT NULL AND content <> ''
        ORDER BY timestamp_ms DESC, id DESC
        LIMIT 1`).get(String(thread?.id || ''));
      if (!last || !String(last.content || '').trim()) return false;
      return sidebarShouldSkipSweep({
        sidebarPreview: preview,
        storedContent: last.content,
        isUnread: thread.is_unread
      });
    } catch (_) { return false; }
  },
  enqueue: (job) => InboxSyncScheduler.enqueueThreadSync(job),
  isBusy: (laneKey, accountId) => InboxSyncScheduler.isLaneBusy(laneKey),
  isReady: (accountId) => {
    const connection = extensionConnections.get(String(accountId));
    return Boolean(connection && connection.readyState === WebSocket.OPEN);
  },
  emit: (progress) => io.emit('INITIAL_MESSAGE_SYNC_PROGRESS', progress)
});

// Phase 1 (ke hoach 2026-10-01): retry bi guard navigated_away chan thi
// re-queue ve DUOI hang doi quet thay vi huy mat trang - kho no initial_sweep
// tu roi dan khi operator ranh tay. Cap 3 lan/thread nam trong policy; thread
// da quet xong (loop terminator) thi bo qua. reason history_retry khong phai
// user-driven nen enqueueThreadSync tu xep cuoi hang doi lane.
HistorySyncRetryPolicy.configure({
  onNavigatedAwayRequeue: (accountId, threadId) => {
    try {
      const retryRow = db.prepare('SELECT thread_url, contact_name FROM threads WHERE id = ?').get(String(threadId));
      if (!retryRow) return;
      if (InboxSyncScheduler.isThreadHistoryCompleted(String(threadId), String(accountId))) return;
      const retrySource = ConversationRepository.getThreadSource(String(threadId));
      InboxSyncScheduler.enqueueThreadSync({
        account_id: String(accountId),
        thread_id: String(threadId),
        external_thread_id: String(threadId),
        thread_url: retryRow.thread_url || null,
        page_id: (retrySource && retrySource.sourceType === 'page_messenger') ? retrySource.pageId : null,
        contact_name: retryRow.contact_name || null,
        reason: 'history_retry',
        allow_navigation: true
      });
    } catch (requeueErr) {
      console.warn(`[HISTORY_SYNC_RETRY_REQUEUE_ERROR] thread=${threadId}:`, requeueErr.message);
    }
  }
});

// Phase C (ke hoach ws-socket-adoption 2026-10-01): watchdog kenh dispatch.
// Socket zombie thi ws.send van "thanh cong" nhung extension khong nhan - do
// so dispatch lien tiep khong co ket qua, vuot nguong thi COMMAND_PROBE;
// khong ACK trong 5s thi dong socket de extension tu dong ky lai.
const dispatchStallWatchdog = new DispatchStallWatchdog({
  stallLimit: Number(process.env.FB_CRM_DISPATCH_STALL_LIMIT || 20)
});
const pendingDispatchProbes = new Map(); // probe_id -> { account_id, timer }
function sendDispatchProbe(accountId, extWs) {
  const accId = String(accountId || '');
  if (!accId || !extWs || extWs.readyState !== WebSocket.OPEN) return;
  const probeId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const probeTimer = setTimeout(() => {
    pendingDispatchProbes.delete(probeId);
    dispatchStallWatchdog.probeTimedOut(accId);
    const suspectWs = extensionConnections.get(accId);
    if (suspectWs && suspectWs.readyState === WebSocket.OPEN) {
      console.warn(`[WS] Dispatch channel suspect account=${accId} probe=${probeId} no ACK in 5s - closing socket to force re-register`);
      try { suspectWs.close(4000, 'DISPATCH_CHANNEL_STALL'); } catch (_) {}
      if (extensionConnections.get(accId) === suspectWs) extensionConnections.delete(accId);
      io.emit('EXTENSION_CONNECTION_CHANGED', { account_id: accId, is_connected: false });
    }
  }, 5000);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
  pendingDispatchProbes.set(probeId, { account_id: accId, timer: probeTimer });
  console.warn(`[WS] Dispatch stall account=${accId} - ${dispatchStallWatchdog.stallLimit} dispatches without result, probing socket ${probeId}`);
  extWs.send(JSON.stringify({ type: 'COMMAND_PROBE', data: { probe_id: probeId } }));
}

InboxSyncScheduler.configure({
  getConnection: (accountId) => extensionConnections.get(String(accountId)),
  dispatchThreadMessagesSync: ({ account_id, thread_id, external_thread_id, thread_url, page_id, contact_name, reason, allow_navigation, sync_mode, scroll_delta }) => {
    const extWs = extensionConnections.get(String(account_id));
    if (!extWs || extWs.readyState !== WebSocket.OPEN) {
      syncDebug('SYNC_DISPATCH_FAIL', { thread: String(thread_id || '').substring(0, 20), reason: reason || null, why: 'no_extension_ws' });
      return false;
    }
    const syncState = require('./services/HistorySyncManager').getSyncState(thread_id);
    const pageSource = ConversationRepository.getThreadSource(thread_id);
    const persisted = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(thread_id);
    let mode = sync_mode || 'incremental';
    if (!sync_mode && (!syncState?.sync_cursor || Number(persisted?.count || 0) === 0)) mode = 'initial';
    else if (!sync_mode && (syncState.sync_status === 'PARTIAL' || syncState.sync_status === 'FAILED')) mode = 'deep_backfill';
    // Lưới an toàn định tuyến: row chưa bind source (source_id NULL) phải vẫn
    // được nhận diện là thread Page qua thread_url, nếu không sẽ bị điều hướng
    // sang tab Messenger cá nhân và tab Business Suite không bao giờ chuyển user.
    const threadUrlPageId = String(thread_url || '').match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1] || null;
    const resolvedPageId = pageSource?.sourceType === 'personal_messenger'
      ? null
      : (page_id || pageSource?.pageId || threadUrlPageId || null);
    const threadRow = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(thread_id);
    extWs.send(JSON.stringify({
      type: 'SYNC_THREAD_MESSAGES',
      data: {
        account_id,
        thread_id,
        external_thread_id: external_thread_id || thread_id,
        thread_url,
        page_id: resolvedPageId,
        mode,
        cursor: syncState?.sync_cursor || null,
        contact_name: contact_name || threadRow?.contact_name || null,
        reason,
        allow_navigation: allow_navigation === true,
        scroll_delta: Number(scroll_delta) || 0
      }
    }));
    syncDebug('SYNC_DISPATCH', { thread: String(thread_id || '').substring(0, 20), reason: reason || null, mode });
    // Phase C (2026-10-01): dem dispatch khong ket qua; cham nguong thi probe
    // socket (zombie thi ws.send van thanh cong nhung extension khong nhan).
    dispatchStallWatchdog.noteDispatch(String(account_id));
    if (dispatchStallWatchdog.shouldProbe(String(account_id)) && extensionConnections.get(String(account_id)) === extWs) {
      sendDispatchProbe(String(account_id), extWs);
    }
    return true;

    console.log(`[HISTORY_SYNC_DISABLED] Scheduler request ignored account=${account_id} thread=${thread_id}`);
    return false;
    /* Scheduler-based message history synchronization is intentionally disabled.
    const extWs = extensionConnections.get(String(account_id));
    if (!extWs || extWs.readyState !== WebSocket.OPEN) return false;
    const syncState = require('./services/HistorySyncManager').getSyncState(thread_id);
    const pageSource = ConversationRepository.getThreadSource(thread_id);
    const threadRow = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(thread_id);
    let mode = 'incremental';
    if (!syncState?.sync_cursor) mode = 'initial';
    else if (syncState.sync_status === 'PARTIAL' || syncState.sync_status === 'FAILED') mode = 'deep_backfill';
    extWs.send(JSON.stringify({
      type: 'SYNC_THREAD_MESSAGES',
      data: {
        account_id,
        thread_id,
        thread_url,
        page_id: page_id || pageSource?.pageId || null,
        mode,
        cursor: syncState?.sync_cursor || null,
        contact_name: contact_name || threadRow?.contact_name || null,
        reason,
        allow_navigation: allow_navigation === true
      }
    }));
    return true;
    */
  }
});

// Declared even though nothing currently assigns it: referencing an undeclared
// identifier here threw a ReferenceError that aborted stopManagedProcesses()
// before stopAllAccountProcesses() could run (Chrome outlived app quit).
let extensionHealthMonitor = null;
function stopManagedProcesses() {
  if (extensionHealthMonitor) {
    clearInterval(extensionHealthMonitor);
    extensionHealthMonitor = null;
  }
  return processManager.stopAllAccountProcesses();
}

module.exports = { app, server, startServer, stopManagedProcesses, extensionConnections, io };
