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
const { isSystemOrMetadataText, cleanMessageText, isSidebarActivitySummary, isInvalidContactName, cleanContactName } = require('./utils/textFilter');
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
const { isChangedIncomingSidebarPreview } = require('./utils/sidebarIncomingDetection');
const licenseChecker = require('./services/LicenseChecker');

// Remote License Server URL Ã¢â‚¬â€œ must match CentralAuthClient / LicenseChecker
const LICENSE_SERVER_BASE_URL = (process.env.LICENSE_SERVER_URL || 'https://genblackmmoonline.online/license_server').replace(/\/$/, '');

const app = express();
const followupService = new FollowupService(db);
const authService = new AuthService(db);
const centralAuthClient = new CentralAuthClient();
app.use(express.json());

function sendAuthError(res, error) {
  const status = error instanceof AuthError || error instanceof CentralAuthError ? error.status : 500;
  if (status === 500) console.error('[Auth]', error);
  res.status(status).json({
    success: false,
    code: error.code || 'AUTH_ERROR',
    message: status === 500 ? 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃ¡Â»Â­ lÃƒÂ½ yÃƒÂªu cÃ¡ÂºÂ§u Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p.' : error.message
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
    res.json({ success: true, message: data?.message || 'Ã„ÂÃ¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u thÃƒÂ nh cÃƒÂ´ng!' });
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
  if (!token) return res.status(400).json({ success: false, message: 'ThiÃ¡ÂºÂ¿u token' });
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
      <title>XÃƒÂ¡c thÃ¡Â»Â±c Google - FB Messenger CRM</title>
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
        <p>Vui lÃƒÂ²ng chÃ¡Â»Ân tÃƒÂ i khoÃ¡ÂºÂ£n Google Ã„â€˜Ã¡Â»Æ’ tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c sÃ¡Â»Â­ dÃ¡Â»Â¥ng Ã¡Â»Â©ng dÃ¡Â»Â¥ng Desktop.</p>
        <div class="btn-container">
          <div id="googleBtn"></div>
        </div>
        <div id="msg-success" class="success">Ã¢Å“â€œ Ã„ÂÃ„Æ’ng nhÃ¡ÂºÂ­p thÃƒÂ nh cÃƒÂ´ng! CÃ¡Â»Â­a sÃ¡Â»â€¢ nÃƒÂ y sÃ¡ÂºÂ½ tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng Ã„â€˜ÃƒÂ³ng...</div>
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
              errDiv.textContent = result.message || 'Ã„ÂÃ„Æ’ng nhÃ¡ÂºÂ­p bÃ¡ÂºÂ±ng Google thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i.';
              errDiv.style.display = 'block';
            }
          } catch(e) {
            errDiv.textContent = 'KhÃƒÂ´ng thÃ¡Â»Æ’ kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Ã„â€˜Ã¡ÂºÂ¿n mÃƒÂ¡y chÃ¡Â»Â§.';
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
    '/extension/reload'
  ];
  if (unauthenticatedPaymentPaths.some((pathPrefix) => req.path.startsWith(pathPrefix))) return next();
  return requireAuthenticatedApi(req, res, next);
});

// 1. API KiÃ¡Â»Æ’m tra trÃ¡ÂºÂ¡ng thÃƒÂ¡i bÃ¡ÂºÂ£n quyÃ¡Â»Ân cÃ¡Â»Â¥c bÃ¡Â»â„¢
app.get('/api/license/status', async (req, res) => {
  try {
    if (isLocalDevRequest(req, 'LOCAL_DEV_SKIP_LICENSE')) {
      return res.json({
        success: true,
        data: {
          isLicensed: true,
          reason: 'LOCAL_DEV',
          message: 'Ã„Âang dÃƒÂ¹ng chÃ¡ÂºÂ¿ Ã„â€˜Ã¡Â»â„¢ kiÃ¡Â»Æ’m thÃ¡Â»Â­ local.',
          key: 'LOCAL-DEV'
        }
      });
    }
    const user = authService.getRequestUser(req);
    const savedKey = licenseChecker.getSavedKey();

    // NÃ¡ÂºÂ¿u mÃƒÂ¡y nÃƒÂ y chÃ†Â°a/Ã„â€˜ÃƒÂ£ bÃ¡Â»â€¹ Ã„â€˜Ã„Æ’ng xuÃ¡ÂºÂ¥t Key (khÃƒÂ´ng cÃƒÂ³ savedKey) vÃƒÂ  khÃƒÂ´ng phÃ¡ÂºÂ£i tÃƒÂ i khoÃ¡ÂºÂ£n nhÃƒÂ¢n viÃƒÂªn
    if (!savedKey && user?.company_role !== 'EMPLOYEE') {
      return res.json({
        success: true,
        data: {
          isLicensed: false,
          reason: 'NO_KEY',
          message: 'MÃƒÂ¡y nÃƒÂ y chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t License Key.'
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
    res.json({ success: true, data: { isLicensed: false, reason: 'LICENSE_SERVER_UNAVAILABLE', message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ kiÃ¡Â»Æ’m tra gÃƒÂ³i tÃƒÂ i khoÃ¡ÂºÂ£n.' } });
  }
});

// 2. API KÃƒÂ­ch hoÃ¡ÂºÂ¡t Key mÃ¡Â»â€ºi
app.post('/api/license/activate', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'ThiÃ¡ÂºÂ¿u mÃƒÂ£ Key' });

    const normalizedKey = key.trim();
    const { getMachineId } = require('./utils/machineId');
    const machineId = getMachineId();

    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: normalizedKey,
        machineId,
        deviceName: 'MÃƒÂ¡y CRM Desktop',
        clientUsername: authService.getRequestUser(req).username
      })
    });
    const centralResult = await centralResponse.json();

    if (!centralResponse.ok || !centralResult.success) {
      return res.status(400).json({
        success: false,
        message: centralResult.message || centralResult.error || 'KhÃƒÂ´ng thÃ¡Â»Æ’ kÃƒÂ­ch hoÃ¡ÂºÂ¡t Key trÃƒÂªn License Server',
        data: centralResult
      });
    }

    licenseChecker.saveKey(normalizedKey);
    const status = await licenseChecker.verify();

    if (status.isLicensed) {
      res.json({ success: true, message: 'KÃƒÂ­ch hoÃ¡ÂºÂ¡t bÃ¡ÂºÂ£n quyÃ¡Â»Ân thÃƒÂ nh cÃƒÂ´ng!', data: status });
    } else {
      licenseChecker.removeKey();
      res.status(400).json({ success: false, message: status.message || 'MÃƒÂ£ Key khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡', data: status });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i License Server', error: e.message });
  }
});

// 2b. LÃ†Â°u tÃƒÂªn cÃƒÂ´ng ty cho chÃƒÂ­nh Key Ã„â€˜ang Ã„â€˜Ã†Â°Ã¡Â»Â£c kÃƒÂ­ch hoÃ¡ÂºÂ¡t trÃƒÂªn mÃƒÂ¡y nÃƒÂ y
app.post('/api/license/company', async (req, res) => {
  try {
    const companyName = String(req.body?.companyName || '').trim().replace(/\s+/g, ' ');
    if (companyName.length < 2 || companyName.length > 120) {
      return res.status(400).json({ success: false, message: 'TÃƒÂªn cÃƒÂ´ng ty phÃ¡ÂºÂ£i tÃ¡Â»Â« 2 Ã„â€˜Ã¡ÂºÂ¿n 120 kÃƒÂ½ tÃ¡Â»Â±' });
    }

    const savedKey = licenseChecker.getSavedKey();
    if (!savedKey) {
      return res.status(400).json({ success: false, message: 'MÃƒÂ¡y chÃ†Â°a cÃƒÂ³ License Key Ã„â€˜ÃƒÂ£ kÃƒÂ­ch hoÃ¡ÂºÂ¡t' });
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
    res.status(502).json({ success: false, message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i License Server Ã„â€˜Ã¡Â»Æ’ lÃ†Â°u tÃƒÂªn cÃƒÂ´ng ty', error: error.message });
  }
});

// 3. API Ã„ÂÃ„Æ’ng xuÃ¡ÂºÂ¥t Key
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
    res.json({ success: true, message: 'Ã„ÂÃƒÂ£ hÃ¡Â»Â§y Ã„â€˜Ã„Æ’ng kÃƒÂ½ bÃ¡ÂºÂ£n quyÃ¡Â»Ân trÃƒÂªn mÃƒÂ¡y nÃƒÂ y' });
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

// ÃƒÂp dÃ¡Â»Â¥ng Middleware BÃ¡ÂºÂ£o VÃ¡Â»â€¡ KhÃƒÂ³a Backend cho tÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ cÃƒÂ¡c API CRM
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
  for (const source of activePageSourcesForAccount(accountKey)) {
    const pageId = String(source.page_id);
    const pageWs = pageExtensionConnections.get(pageConnectionKey(accountKey, pageId));
    if (pageWs?.readyState === WebSocket.OPEN) {
      pageWs.send(JSON.stringify({ type: 'SYNC_PAGE_SIDEBAR', data: { account_id: accountKey, page_id: pageId, reason } }));
      dispatched += 1;
    } else {
      processManager.startPageProcess(pageId, accountKey).catch((error) => {
        console.warn(`[PageSync] Could not start Page ${pageId}:`, error.message);
      });
    }
  }
  return dispatched;
}
const messageRequestActionOwners = new Map();
const pendingAccountOwners = new Map();
// Existing-account "KÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Facebook" launches should become background
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
  const timer = setTimeout(() => {
    backgroundAfterConnectTimers.delete(key);
    if (backgroundAfterConnectRequests.get(key) !== requestedAt) return;
    backgroundAfterConnectRequests.delete(key);
    processManager.hideAccountProcess(key);
    console.log(`[BACKGROUND_AFTER_SYNC] account=${key} hidden=true reason=${reason}`);
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

const richContentSecret = crypto.randomBytes(32);

function requireLocalCrmRequest(req, res, next) {
  if (isLoopbackAddress(req.socket?.remoteAddress) === false) {
    return res.status(403).json({
      code: 'LOCAL_CRM_REQUIRED',
      error: 'Rich-message chÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p tÃ¡Â»Â« CRM chÃ¡ÂºÂ¡y trÃƒÂªn mÃƒÂ¡y nÃƒÂ y.'
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
  return rows
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
  const isObserverEcho = String(message.source || '').toLowerCase() === 'dom_observer'
    || !message.sender_id;
  const isSyntheticObserverId = isObserverEcho
    || /^(?:dom_|history_|network_|websocket_|mercury_|xhr_)/i.test(String(message.fb_message_id || ''));
  if (isObserverEcho && ConversationRepository.hasMatchingOutgoingText(threadId, content, database)) {
    return true;
  }
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
  onHydrated: (stored) => io.emit('THREAD_MESSAGES_UPDATED', {
    thread_id: String(stored.thread_id),
    messages: [withAttachmentAccessUrl(stored)]
  })
});

function sendRichMessageError(res, error) {
  const status = Number(error?.httpStatus) || 400;
  res.status(status).json({
    error: error?.message || 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃ¡Â»Â­ lÃƒÂ½ rich-message.',
    code: error?.code || 'RICH_MESSAGE_ERROR',
    details: error?.details || null
  });
}

// Router HTTP Upgrade: phÃƒÂ¢n Ã„â€˜Ã¡Â»â€¹nh Socket.io vs Chrome Extension WebSocket
// Extension kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i tÃ¡ÂºÂ¡i: ws://127.0.0.1:5050/extension
// Socket.IO kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i tÃ¡ÂºÂ¡i: ws://localhost:5050/socket.io/...
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname.startsWith('/socket.io')) {
    // Socket.io tÃ¡Â»Â± xÃ¡Â»Â­ lÃƒÂ½ upgrade cÃ¡Â»Â§a mÃƒÂ¬nh
    return;
  }

  // ChÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n /extension (Chrome Extension) hoÃ¡ÂºÂ·c / (legacy)
  if (pathname === '/extension' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // TÃ¡Â»Â« chÃ¡Â»â€˜i cÃƒÂ¡c path khÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh
    socket.destroy();
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: gÃ¡Â»Â­i tin nhÃ¡ÂºÂ¯n qua Extension WebSocket Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

async function sendViaExtension(thread_id, text, client_message_id = null) {
  // TÃƒÂ¬m account_id cÃ¡Â»Â§a thread
  const thread = db.prepare(
    'SELECT account_id, contact_name, thread_url FROM threads WHERE id = ?'
  ).get(thread_id);
  if (!thread) throw new Error(`Thread ${thread_id} khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i`);

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
    throw new Error(`Extension cho tÃƒÂ i khoÃ¡ÂºÂ£n ${thread.account_id} khÃƒÂ´ng kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i`);
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

  // LÃ†Â°u tin nhÃ¡ÂºÂ¯n outgoing dÃ¡ÂºÂ¡ng pending vÃƒÂ o CSDL
  const result = db.prepare(`
    INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, is_outgoing, delivery_status)
    VALUES (?, ?, ?, 'SYSTEM', ?, 1, 'pending')
  `).run(thread_id, pendingFbId, clientMsgId, text);
  trace('BACKEND_PENDING_CREATED', { row_id: result.lastInsertRowid });

  db.prepare(`
    UPDATE threads SET last_message = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?
  `).run(text, thread_id);

  if (isPageThread) {
    // QueueWorker (already running) picks this up and dispatches SEND_QUEUED_MESSAGE.
    trace('BACKEND_QUEUED_FOR_PAGE_SEND');
  } else {
    // Persist trÃ†Â°Ã¡Â»â€ºc khi dispatch Ã„â€˜Ã¡Â»Æ’ DOM/network confirmation khÃƒÂ´ng chÃ¡ÂºÂ¡y vÃƒÂ o race
    // window vÃƒÂ  luÃƒÂ´n tÃƒÂ¬m thÃ¡ÂºÂ¥y bÃ¡ÂºÂ£n ghi pending Ã„â€˜Ã¡Â»Æ’ ghÃƒÂ©p Ã„â€˜ÃƒÂºng client_message_id.
    extWs.send(JSON.stringify({
      type: 'SEND_MESSAGE',
      data: {
        account_id: thread.account_id,
        thread_id,
        thread_url: thread.thread_url || null,
        expected_contact_name: thread.contact_name || null,
        content: text,
        client_message_id: clientMsgId
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
      const timeoutError = 'Extension khÃƒÂ´ng xÃƒÂ¡c nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ gÃ¡Â»Â­i trong 30 giÃƒÂ¢y';
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
    const error = new Error('Source khÃƒÂ´ng nÃ¡ÂºÂ±m trong CAMPAIGN_TEST_SOURCE_IDS');
    error.code = 'SOURCE_UNAVAILABLE';
    throw error;
  }
  if (CampaignRepository.countAccountSentToday(recipient.account_id) >= config.accountDailyCap) {
    const error = new Error("TÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã¡ÂºÂ¡t giÃ¡Â»â€ºi hÃ¡ÂºÂ¡n gÃ¡Â»Â­i trong ngÃƒÂ y");
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Extension WebSocket Handler
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
wss.on('connection', (ws, req) => {
  console.log('[WS] Extension connected from:', req.socket.remoteAddress);
  ws.lastHeartbeatAt = Date.now();

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[WS] Ã°Å¸â€œÂ¨ NhÃ¡ÂºÂ­n message:', msg.type, '| WS ID:', req.socket.remoteAddress);

      switch (msg.type) {
        case 'HEARTBEAT':
          // WebSocket traffic keeps the Manifest V3 worker alive. Do not log
          // or trigger sync work for this lightweight liveness frame.
          ws.lastHeartbeatAt = Date.now();
          break;

        case 'REGISTER_ACCOUNT': {
          const { account_id, name, pending_key, avatar_url } = msg.data;
          // Facebook sets c_user=0 as a placeholder while a page is mid-login;
          // extension-side already guards this (content.js sanitizeUserId), but
          // reject it here too so a stale/unpatched extension can never create
          // a bogus "FB Account (0)" row.
          if (!account_id || String(account_id).trim() === '0') {
            console.warn(`[WS] BÃ¡Â»Â qua REGISTER_ACCOUNT vÃ¡Â»â€ºi account_id khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡: ${JSON.stringify(account_id)}`);
            break;
          }
          const removedAccount = db.prepare(
            'SELECT account_id FROM removed_accounts WHERE account_id = ?'
          ).get(String(account_id));
          if (removedAccount && !pending_key) {
            console.warn(`[WS] TÃ¡Â»Â« chÃ¡Â»â€˜i stale REGISTER_ACCOUNT cÃ¡Â»Â§a tÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ÃƒÂ£ xÃƒÂ³a: ${account_id}`);
            ws.close(1000, 'ACCOUNT_REMOVED');
            break;
          }
          if (pending_key) {
            db.prepare('DELETE FROM removed_accounts WHERE account_id = ?').run(String(account_id));
          }
          let ownerUserId = pending_key ? pendingAccountOwners.get(String(pending_key)) : null;
          if (pending_key && !ownerUserId) {
            try {
              const ownerFile = path.join(APP_DATA_ROOT, 'profiles', String(pending_key), '.crm-pending-owner.json');
              if (fs.existsSync(ownerFile)) {
                const ownerData = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
                ownerUserId = ownerData.userId || null;
              }
            } catch (_) {}
          }          const previousExtension = extensionConnections.get(account_id);
          // A Page Chrome has the same Facebook account id as Personal
          // Messenger. Preserve the personal socket instead of closing it;
          // Page identifies itself immediately afterwards with PAGE_CONTEXT_READY.
          if (!previousExtension || previousExtension.readyState !== WebSocket.OPEN) {
            extensionConnections.set(account_id, ws);
          }
          ws.lastHeartbeatAt = Date.now();
          // A pending account is still inside Facebook's interactive login /
          // encrypted-history PIN setup. Do not start background sidebar
          // polling until the operator finishes setup and reconnects it as an
          // existing account (REGISTER_ACCOUNT without pending_key).
          if (!pending_key) InboxSyncScheduler.registerAccount(account_id);
          else newAccountBootstrapSyncs.set(String(account_id), { awaitingSetup: true, attempt: 0, timer: null });
          domReplaySuppressUntil.set(account_id, Date.now() + 8000);
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
          if (pending_key) {
            pendingAccountOwners.delete(String(pending_key));
            try {
              fs.unlinkSync(path.join(APP_DATA_ROOT, 'profiles', String(pending_key), '.crm-pending-owner.json'));
            } catch (_) {}
          }

          console.log(`[WS] REGISTER_ACCOUNT thÃƒÂ nh cÃƒÂ´ng: account_id=${account_id}, profile_dir=${profileDir}`);
          try {
            InboxSourceService.createPersonalSource(account_id, accName, db);
          } catch (_) {}
          io.emit('ACCOUNT_STATUS_CHANGED', { account_id, status: 'ACTIVE', avatar_url: accountAvatarFilename });
          io.emit('INBOX_SOURCE_ADDED', { id: 'src_personal_' + account_id, source_type: 'personal_messenger', display_name: accName });
          io.emit('EXTENSION_CONNECTION_CHANGED', { account_id, is_connected: true });

          const backgroundRequestedAt = backgroundAfterConnectRequests.get(String(account_id));
          const backgroundRequestIsFresh = Number.isFinite(backgroundRequestedAt)
            && Date.now() - backgroundRequestedAt < 120000;
          if (!pending_key && backgroundRequestIsFresh && !KEEP_CONNECTED_FACEBOOK_CHROME_VISIBLE) {
            backgroundAfterConnectRequests.delete(String(account_id));
            processManager.hideAccountProcess(account_id);
            console.log(`[BACKGROUND_SYNC] account=${account_id} hidden_immediately=true`);
          }

          // GÃ¡Â»Â­i ACK vÃ¡Â»Â Extension xÃƒÂ¡c nhÃ¡ÂºÂ­n Ã„â€˜Ã„Æ’ng kÃƒÂ½ thÃƒÂ nh cÃƒÂ´ng
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

          // InboxSyncScheduler.registerAccount() already starts the lightweight
          // background inbox loop. Do not dispatch a second full SYNC_THREADS
          // crawl here: it competes with realtime receive and manual sends.
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
              console.log(`[WS] Composer Ã„â€˜ÃƒÂ£ dispatch tin; giÃ¡Â»Â¯ pending chÃ¡Â»Â DOM/network confirmation: ${client_message_id}`);
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
            console.error('[WS] Ã¢ÂÅ’ SEND_MESSAGE_RESULT failed or missing fb_msg_id:', {
              thread_id,
              client_message_id,
              success,
              error,
              fbRes: JSON.stringify(fbRes)?.substring(0, 500)
            });

            const failureText = error || 'Facebook khÃƒÂ´ng xÃƒÂ¡c nhÃ¡ÂºÂ­n message_id';
            const canArriveLateFromComposer = /response rÃ¡Â»â€”ng|khÃƒÂ´ng nhÃ¡ÂºÂ­n message_id|GraphQL/i.test(failureText);
            if (canArriveLateFromComposer) {
              // GraphQL cÃƒÂ³ thÃ¡Â»Æ’ lÃ¡Â»â€”i trÃ†Â°Ã¡Â»â€ºc khi composer/DOM kÃ¡Â»â€¹p xÃƒÂ¡c nhÃ¡ÂºÂ­n. GiÃ¡Â»Â¯ pending
              // mÃ¡Â»â„¢t grace window Ã„â€˜Ã¡Â»Æ’ event Ã„â€˜Ã¡ÂºÂ¿n muÃ¡Â»â„¢n vÃ¡ÂºÂ«n ghÃƒÂ©p Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜ÃƒÂºng attempt.
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
              // LÃ¡Â»â€”i chÃ¡ÂºÂ¯c chÃ¡ÂºÂ¯n khÃƒÂ´ng thÃ¡Â»Æ’ gÃ¡Â»Â­i: giÃ¡Â»Â¯ lÃ¡Â»â€¹ch sÃ¡Â»Â­ nhÃ†Â°ng chuyÃ¡Â»Æ’n failed ngay.
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
            console.error('[CONTENT_DEBUG] Ghi log thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i:', error.message);
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
            console.error('[COMPOSER_DEBUG] Ghi log thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i:', error.message);
          }
          break;
        }

        case 'CHECKPOINT_DETECTED': {
          const { account_id } = msg.data;
          db.prepare("UPDATE accounts SET status='CHECKPOINT' WHERE id=?").run(account_id);
          processManager.unhideWindow(account_id);
          io.emit('ACCOUNT_STATUS_CHANGED', { account_id, status: 'CHECKPOINT' });
          break;
        }

        case 'THREAD_METADATA_UPDATED': {
          const { account_id, thread_id, contact_name, avatar_url, page_id } = msg.data || {};
          const tidStr = String(thread_id || '');
          if (!tidStr) break;

          let updatedName = null;
          let localAvatarPath = null;

          if (contact_name && !isInvalidContactName(contact_name)) {
            updatedName = contact_name.trim();
            db.prepare('UPDATE threads SET contact_name = ? WHERE id = ?').run(updatedName, tidStr);
            db.prepare(`
              INSERT INTO contacts (thread_id, name)
              VALUES (?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET
                name = excluded.name
            `).run(tidStr, updatedName);
          }

          if (avatar_url && avatar_url.startsWith('http')) {
            try {
              localAvatarPath = await saveAvatarFromBase64OrUrl(avatar_url, tidStr);
              if (localAvatarPath) {
                db.prepare(`
                  INSERT INTO contacts (thread_id, name, avatar_url)
                  VALUES (?, ?, ?)
                  ON CONFLICT(thread_id) DO UPDATE SET
                    avatar_url = excluded.avatar_url
                `).run(tidStr, updatedName || 'KhÃƒÂ¡ch hÃƒÂ ng', localAvatarPath);
              }
            } catch (e) {
              console.warn('[WS] Avatar save failed:', e.message);
            }
          }

          io.emit('CONTACT_UPDATED', {
            thread_id: tidStr,
            ...(updatedName ? { name: updatedName } : {}),
            ...(localAvatarPath ? { avatar_url: localAvatarPath } : {})
          });
          break;
        }

        case 'NEW_MESSAGE_RECEIVED': {
          const m = msg.data;
          const threadId = String(m.thread_id || '');          // Emit the durable message as soon as SQLite accepts it. Contact
          // enrichment, avatar downloads and campaign/phone automation can be
          // slow on the first message of a thread; they must not delay the
          // chat bubble or make the first realtime event appear to be lost.
          let realtimeMessageEmittedEarly = false;
          console.log(`[WS] Ã°Å¸â€œÂ© NhÃ¡ÂºÂ­n NEW_MESSAGE_RECEIVED | Source: ${m.source || 'unknown'} | Thread: ${threadId} | FB Message ID: ${m.fb_message_id} | Content: "${sanitizeLog(m.content, 80)}"`);
          if (!threadId || threadId === 'unknown_dom' || threadId.trim() === '') {
            console.warn(`[WS] Ã¢Å¡Â Ã¯Â¸Â BÃ¡Â»Â qua tin nhÃ¡ÂºÂ¯n tÃ¡Â»Â« Thread ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡: "${threadId}"`);
            break;
          }
          const _rawContentLower = (m.content || '').toLowerCase();
          const isCallLog = _rawContentLower.includes('cuÃ¡Â»â„¢c gÃ¡Â»Âi') || _rawContentLower.includes('bÃ¡Â»Â lÃ¡Â»Â¡') || _rawContentLower.includes('Ã„â€˜ÃƒÂ£ nhÃ¡Â»Â¡') || _rawContentLower.includes('nhÃ¡Â»Â¡ cuÃ¡Â»â„¢c') || _rawContentLower.includes('chat video')
            || _rawContentLower.includes('audio call') || _rawContentLower.includes('video call') || _rawContentLower.includes('missed call')
            || _rawContentLower.includes('missed audio') || _rawContentLower.includes('missed video') || _rawContentLower.includes('call ended')
            || (m.media_type === 'call');
          if (isCallLog) {
            console.log(`[CALL_DEBUG] Ã°Å¸â€œÅ¾ Backend nhÃ¡ÂºÂ­n CALL LOG tÃ¡Â»Â« Extension: content="${sanitizeLog(m.content)}", thread=${threadId}, fb_id=${m.fb_message_id}, isCallLog=true`);
          }
          if (!threadId || threadId === 'unknown_dom') {
            console.warn(`[WS] Ã¢Å¡Â Ã¯Â¸Â BÃ¡Â»Â qua tin nhÃ¡ÂºÂ¯n tÃ¡Â»Â« Thread ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡: "${threadId}"`);
            break;
          }
          const targetAccountId = m.account_id || ws.accountId || null;
          const canonicalThreadId = resolveInternalThreadId(db, targetAccountId, threadId);
          if (!canonicalThreadId) {
            console.warn(`[WS] BÃ¡Â»Â qua tin nhÃ¡ÂºÂ¯n chÃ†Â°a ÃƒÂ¡nh xÃ¡ÂºÂ¡ Ã„â€˜Ã†Â°Ã¡Â»Â£c thread: raw=${threadId} account=${targetAccountId || 'unknown'}`);
          }
          // Preserve Facebook's raw id for diagnostics, but use the CRM's
          // canonical id throughout the existing persistence/UI pipeline.
          m.external_thread_id = m.external_thread_id || threadId;
          m.thread_id = canonicalThreadId || threadId;

          if (isCallLog && m.content && m.fb_message_id) {
            const callThreadId = canonicalThreadId || m.thread_id;
            const threadAccRow = db.prepare('SELECT account_id FROM threads WHERE id = ?').get(callThreadId);
            const targetAccountIdForCall = m.account_id || ws.accountId || threadAccRow?.account_id || null;
            ConversationRepository.upsertThread({
              id: callThreadId,
              account_id: targetAccountIdForCall,
              contact_name: m.contact_name || 'KhÃƒÂ¡ch hÃƒÂ ng',
              last_message: m.content,
              is_unread: true
            });
            const stableCallId = m.fb_message_id;
            const callTimestamp = Number(m.timestamp_ms) || Date.parse(m.created_at || '') || Date.now();
            const existingCall = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(stableCallId)
              || db.prepare(`
                SELECT id FROM messages
                WHERE thread_id = ? AND media_type = 'call' AND content = ?
                  AND ABS(COALESCE(NULLIF(timestamp_ms, 0), ?) - ?) <= 60000
                ORDER BY id DESC LIMIT 1
              `).get(callThreadId, m.content, callTimestamp, callTimestamp);
            const normalizedCallContent = String(m.content || '').toLocaleLowerCase('vi-VN');
            const isExplicitMissedIncoming = /(?:nhÃ¡Â»Â¡|bÃ¡Â»Â lÃ¡Â»Â¡|missed)/i.test(normalizedCallContent);
            const hasRawAvatarEvidence = m.direction_evidence === 'call_article_avatar'
              && (m.has_row_avatar === true || m.has_row_avatar === false);
            const callIsOutgoing = isExplicitMissedIncoming
              ? 0
              : hasRawAvatarEvidence
                ? (m.has_row_avatar ? 0 : 1)
                : ((m.is_outgoing === true || m.is_outgoing === 1) ? 1 : 0);
            const callSenderId = m.sender_id || (callIsOutgoing ? String(targetAccountIdForCall || 'STAFF') : 'CONTACT');
            console.log(`[CALL_DEBUG] Ã°Å¸Â§Âµ callThreadId=${callThreadId} | m.thread_id=${m.thread_id} | canonicalThreadId=${canonicalThreadId} | callIsOutgoing=${callIsOutgoing}`);
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
                console.log(`[CALL_DEBUG] Ã¢Å“â€¦ Ã„ÂÃƒÂ£ lÃ†Â°u call log vÃƒÂ o DB: "${sanitizeLog(m.content)}" (id: ${stableCallId}) | thread: ${callThreadId} | is_outgoing: ${callIsOutgoing}`);
                const newMsg = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableCallId);
                if (newMsg) {
                  io.emit('NEW_MESSAGE', { ...newMsg, thread_id: callThreadId, account_id: targetAccountIdForCall });
                  io.emit('THREAD_MESSAGES_UPDATED', { thread_id: callThreadId, account_id: targetAccountIdForCall });
                }
              } else {
                // INSERT OR IGNORE bÃ¡Â»â€¹ ignore (trÃƒÂ¹ng fb_message_id): patch media_type vÃƒÂ  is_outgoing nÃ¡ÂºÂ¿u cÃ¡ÂºÂ§n
                db.prepare(`UPDATE messages SET media_type = 'call', is_outgoing = ? WHERE fb_message_id = ?`).run(callIsOutgoing, stableCallId);
                const existingMsg = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(stableCallId);
                if (existingMsg) {
                  console.log(`[CALL_DEBUG] Ã°Å¸â€â€ž Patch media_type='call' cho tin Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i: ${stableCallId}`);
                  io.emit('NEW_MESSAGE', { ...existingMsg, thread_id: callThreadId, account_id: targetAccountIdForCall });
                  io.emit('THREAD_MESSAGES_UPDATED', { thread_id: callThreadId, account_id: targetAccountIdForCall });
                }
              }
            } else {
              // existingCall tÃ¡Â»â€œn tÃ¡ÂºÂ¡i: patch media_type & is_outgoing rÃ¡Â»â€œi re-emit
              db.prepare(`UPDATE messages SET media_type = 'call', is_outgoing = ? WHERE id = ?`).run(callIsOutgoing, existingCall.id);
              const existingMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(existingCall.id);
              if (existingMsg) {
                console.log(`[CALL_DEBUG] Ã°Å¸â€â€ž existingCall: patch + re-emit thread=${callThreadId}: ${stableCallId}`);
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
            console.log(`[WS] Backend Guard: bÃ¡Â»Â qua tÃƒÂªn ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i bÃ¡Â»â€¹ parse thÃƒÂ nh nÃ¡Â»â„¢i dung: "${sanitizeLog(cleanedContent, 60)}"`);
            break;
          }
          if (!hasMediaPayload && isKnownPageSystemNotice(cleanedContent)) {
            console.log(`[WS] Ã¢â€žÂ¹Ã¯Â¸Â Backend Guard: BÃ¡Â»Â qua thÃƒÂ´ng bÃƒÂ¡o hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Meta lÃ¡ÂºÂ·p lÃ¡ÂºÂ¡i tÃ¡Â»Â« thread ${threadId}`);
            break;
          }
          if (!hasMediaPayload && (!cleanedContent || isSystemOrMetadataText(cleanedContent))) {
            console.log(`[WS] Ã¢â€žÂ¹Ã¯Â¸Â Backend Guard: BÃ¡Â»Â qua tin nhÃ¡ÂºÂ¯n rÃƒÂ¡c/hÃ¡Â»â€¡ thÃ¡Â»â€˜ng: "${sanitizeLog(m.content, 40)}" tÃ¡Â»Â« thread ${threadId}`);
            break;
          }

          // NÃ¡ÂºÂ¿u raw content chÃ¡Â»Â©a chuÃ¡Â»â€”i quÃƒÂ¡ lÃ¡Â»â€ºn (scrap rÃ¡Â»â„¢ng), reject Ã¡Â»Å¸ backend
          if ((m.content || '').split('\n').length > 8 && isSystemOrMetadataText(m.content)) {
            console.log(`[WS] Ã¢â€žÂ¹Ã¯Â¸Â Backend Guard: BÃ¡Â»Â qua cÃ¡Â»Â¥m text scrap rÃ¡Â»â„¢ng tÃ¡Â»Â« thread ${threadId}`);
            break;
          }

          m.content = cleanedContent;

          // 3. Fix backend fallback is_outgoing
          let finalIsOutgoing = 0;
          let threadAccountId = targetAccountId;

          // LÃ¡ÂºÂ¥y account_id cÃ¡Â»Â§a thread nÃ¡ÂºÂ¿u cÃƒÂ³
          const existingThreadForAcct = db.prepare('SELECT account_id FROM threads WHERE id=?').get(threadId);
          if (existingThreadForAcct && existingThreadForAcct.account_id) {
            threadAccountId = existingThreadForAcct.account_id;
          }

          if (m.is_outgoing === true || m.is_outgoing === 1) {
            finalIsOutgoing = 1;
          } else if (m.sender_name === 'BÃ¡ÂºÂ¡n') {
            finalIsOutgoing = 1;
          } else if (m.sender_id && targetAccountId && String(m.sender_id) === String(targetAccountId)) {
            finalIsOutgoing = 1;
          } else if (m.sender_id && threadAccountId && String(m.sender_id) === String(threadAccountId)) {
            finalIsOutgoing = 1;
          }

          // 2. BÃ¡Â»â€¢ sung log backend
          console.log(`[WS] Ã°Å¸â€Â Debug Outgoing | Thread: ${threadId} | Source: ${m.source} | account_id: ${targetAccountId} | thread_account_id: ${threadAccountId} | sender_id: ${m.sender_id} | sender_name: ${m.sender_name} | raw is_outgoing: ${m.is_outgoing} | final is_outgoing: ${finalIsOutgoing}`);

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
          const directionStatus = isPageDomObservation
            && !(m.direction_status === 'confirmed' && m.direction_confidence === 'high' && hasBooleanDirection)
            ? 'pending'
            : 'confirmed';
          if (directionStatus === 'pending') finalIsOutgoing = 0;
          const isOutgoing = finalIsOutgoing;
          const isConfirmedIncoming = directionStatus === 'confirmed' && !isOutgoing;

          // A network/DOM observation with a conflicting incoming direction is
          // not authoritative for an operator send. The stored CRM outbound
          // row is authoritative, so discard the echo before it can become a
          // second left-side text bubble.
          const ambiguousDirectionEcho = !m.sender_id
            || String(m.sender_id) === String(threadAccountId || targetAccountId || '');
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
            `).get(threadId);
            const suppressUntil = domReplaySuppressUntil.get(targetAccountId) || 0;
            if (!hasRecentPending && Date.now() < suppressUntil) {
              console.log(`[WS] Ã¢â€žÂ¹Ã¯Â¸Â Suppress outgoing DOM replay during startup/sync window: thread=${threadId} content="${sanitizeLog(m.content, 40)}"`);
              console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_REPLAY_SUPPRESSED', thread_id: String(threadId), at: new Date().toISOString() }));
              break;
            }
          }

          // TÃ¡ÂºÂ£i media vÃ¡Â»Â local nÃ¡ÂºÂ¿u tin mÃ¡Â»â€ºi cÃƒÂ³ Ã„â€˜ÃƒÂ­nh kÃƒÂ¨m
          // Persist/emit remote media immediately. Local hydration is queued
          // after the row exists so a slow video cannot block later messages.

          // FIX FOREIGN KEY: Ã„ÂÃ¡ÂºÂ£m bÃ¡ÂºÂ£o thread tÃ¡Â»â€œn tÃ¡ÂºÂ¡i/Ã„â€˜Ã†Â°Ã¡Â»Â£c upsert TRÃ†Â¯Ã¡Â»Å¡C KHI insert message
          ConversationRepository.upsertThread({
            id: m.thread_id,
            account_id: targetAccountId,
            contact_name: m.contact_name || 'KhÃƒÂ¡ch hÃƒÂ ng',
            last_message: m.content,
            is_unread: true
          });

          // Auto-register Page source & rebind thread khi Ã„â€˜Ã¡ÂºÂ¿n tÃ¡Â»Â« Business Suite
          if (m.source === 'page_dom_observer' && m.page_id) {
            try {
              InboxSourceService.ensurePageSource({
                pageId: String(m.page_id),
                accountId: targetAccountId,
                threadId: m.thread_id,
                pageName: m.page_name || null
              }, db);
            } catch (pageSourceErr) {
              console.warn('[PAGE_SOURCE] LÃ¡Â»â€”i auto-register page source:', pageSourceErr.message);
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
          // Composer fallback khÃƒÂ´ng cÃƒÂ³ official GraphQL ID; ghÃƒÂ©p confirmation DOM
          // vÃƒÂ o bÃ¡ÂºÂ£n pending gÃ¡ÂºÂ§n nhÃ¡ÂºÂ¥t cÃƒÂ¹ng thread/nÃ¡Â»â„¢i dung thay vÃƒÂ¬ tÃ¡ÂºÂ¡o bubble thÃ¡Â»Â© hai.
          if (isOutgoing && isTrustedOutgoingObservation && (m.content || m.media_url || (m.media_type && m.media_type !== 'text'))) {
            console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_OUTGOING_RECEIVED', thread_id: String(threadId), fb_message_id: m.fb_message_id || null, at: new Date().toISOString() }));
            let skipPendingCorrelation = false;
            // Fix: TrÃƒÂ¡nh crash UNIQUE constraint khi DOM observer gÃ¡Â»Â­i lÃ¡ÂºÂ¡i tin nhÃ¡ÂºÂ¯n cÃ…Â© cÃƒÂ³ trÃƒÂ¹ng content
            if (m.fb_message_id) {
               const existingFbId = db.prepare('SELECT id, is_outgoing, delivery_status FROM messages WHERE fb_message_id = ?').get(m.fb_message_id);
               if (existingFbId && existingFbId.is_outgoing === 1 && existingFbId.delivery_status === 'sent') {
                   console.log(`[WS] DOM observer sent an already known confirmed fb_message_id (${m.fb_message_id}). BÃ¡Â»Â qua event Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh ghi Ã„â€˜ÃƒÂ¨ pending.`);
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
                  console.log(`[WS] NÃƒÂ¢ng cÃ¡ÂºÂ¥p fb_message_id tÃ¡ÂºÂ¡m ${recentSent.fb_message_id} -> ${m.fb_message_id} (id ${recentSent.id}), cÃƒÂ¹ng 1 tin gÃ¡Â»Â­i Ã„â€˜i`);
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
                  console.warn(`[WS] Ã¢Å¡Â Ã¯Â¸Â COMPOSER_CONTENT_MISMATCH: pending content="${pendingContent.substring(0, 40)}" vs DOM content="${domContent.substring(0, 40)}" | thread=${canonicalThreadId}`);
                  console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage: 'BACKEND_DOM_CONTENT_MISMATCH', thread_id: String(canonicalThreadId), client_message_id: mismatchPending.client_message_id, pending_len: pendingContent.length, dom_len: domContent.length, at: new Date().toISOString() }));
                  deleteOutboundMessageRows({ messageId: mismatchPending.id });
                  io.emit('MESSAGE_SEND_FAILED', { thread_id: canonicalThreadId, client_message_id: mismatchPending.client_message_id, success: false, status: 'failed', error: 'COMPOSER_CONTENT_MISMATCH', error_code: 'COMPOSER_CONTENT_MISMATCH' });
                  // Discard the mismatched DOM bubble entirely Ã¢â‚¬â€ do not insert it
                  break;
                }
              }
            }
          }
          // ===== ANTI-GHOST GUARD (chÃ¡Â»â€° ÃƒÂ¡p dÃ¡Â»Â¥ng cho tin Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ¡c nhÃ¡ÂºÂ­n outgoing) =====
          // DOM observer Ã„â€˜ÃƒÂ´i khi bÃ¡ÂºÂ¯t lÃ¡ÂºÂ¡i tin nhÃ¡ÂºÂ¯n do CRM gÃ¡Â»Â­i (Ã„â€˜ÃƒÂ£ cÃƒÂ³ is_outgoing=1 trong DB).
          // NÃ¡ÂºÂ¿u Ã„â€˜Ã¡Â»Æ’ chÃ¡ÂºÂ¡y tiÃ¡ÂºÂ¿p sÃ¡ÂºÂ½ tÃ¡ÂºÂ¡o bubble ghost bÃƒÂªn trÃƒÂ¡i vÃ¡Â»â€ºi is_outgoing=0.
          // KhÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c dÃƒÂ¹ng mÃ¡Â»â„¢t media outgoing bÃ¡ÂºÂ¥t kÃ¡Â»Â³ trong 5 phÃƒÂºt Ã„â€˜Ã¡Â»Æ’ loÃ¡ÂºÂ¡i mÃ¡Â»â„¢t
          // media customer mÃ¡Â»â€ºi. Ã„ÂiÃ¡Â»Âu kiÃ¡Â»â€¡n cÃ…Â© lÃƒÂ m Ã¡ÂºÂ£nh/video khÃƒÂ¡ch gÃ¡Â»Â­i biÃ¡ÂºÂ¿n mÃ¡ÂºÂ¥t
          // chÃ¡Â»â€° vÃƒÂ¬ CRM vÃ¡Â»Â«a gÃ¡Â»Â­i Ã¡ÂºÂ£nh/video trong cÃƒÂ¹ng hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.
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
              console.log(`[WS] Ã°Å¸Å¡Â« Anti-ghost FINAL: DOM observer bÃ¡ÂºÂ¯t lÃ¡ÂºÂ¡i tin outgoing (id=${outgoingMatch.id}, status=${outgoingMatch.delivery_status}). Discard hoÃƒÂ n toÃƒÂ n.`);
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


          // LÃ†Â°u tin nhÃ¡ÂºÂ¯n vÃƒÂ o bÃ¡ÂºÂ£ng messages
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
            // Tin Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i: nhÃ¡Â»Â ConversationRepository quyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh cÃƒÂ³ cÃ¡ÂºÂ§n nÃƒÂ¢ng cÃ¡ÂºÂ¥p
            // timestamp/is_outgoing khÃƒÂ´ng (logic dÃƒÂ¹ng chung, cÃƒÂ³ test riÃƒÂªng).
            const reconcile = ConversationRepository.reconcileExistingMessage(
              stableMessageId,
              {
                source: m.source,
                isOutgoing: directionStatus === 'pending' ? null : isOutgoing,
                direction_status: directionStatus,
            thread_summary: realtimeThread || null,
                direction_confidence: m.direction_confidence,
                tsMs,
                tsSource,
                createdAt
              },
              db
            );
            if (reconcile.reason === 'not_found') {
              break; // Duplicate vÃƒÂ¬ client_message_id hoÃ¡ÂºÂ·c lÃƒÂ½ do khÃƒÂ¡c
            }
            if (!reconcile.updated && !mediaWasUpdated) {
              console.log(`[WS] BÃ¡Â»Â qua tin nhÃ¡ÂºÂ¯n Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i (fb_message_id: ${m.fb_message_id})`);
              break;
            }
            if (reconcile.timestampUpdated) {
              console.log(`[WS] Ã¢ÂÂ³ NÃƒÂ¢ng cÃ¡ÂºÂ¥p Timestamp Rank cho fb_message_id ${m.fb_message_id}: ${reconcile.previousTimestampSource} -> ${tsSource}`);
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
            const earlyThread = db.prepare(`
              SELECT id, external_thread_id, account_id, contact_name, avatar_url,
                     last_message, last_activity, is_unread, inbox_folder, source_id
              FROM threads WHERE id = ?
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
            if (!existing || isInvalidContactName(existing.contact_name) || (existing.contact_name || '').startsWith('KhÃƒÂ¡ch hÃƒÂ ng')) {
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
              `).run(m.thread_id, m.contact_name || 'KhÃƒÂ¡ch hÃƒÂ ng', emails[0] || null);
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

          // Emit payload Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§ lÃƒÂªn frontend
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
            SELECT id, external_thread_id, account_id, contact_name, avatar_url,
                   last_message, last_activity, is_unread, inbox_folder, source_id
            FROM threads WHERE id = ?
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
          const callerName = String(data.caller_name || knownThread?.contact_name || '').trim() || 'KhÃƒÂ¡ch hÃƒÂ ng';
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

        case 'SYNC_THREADS_RESULT': {
          const { account_id, threads, partial, sync_status, checkpoint } = msg.data;
          const isRealtimeSidebarHint = sync_status === 'realtime_hint' || sync_status === 'realtime_requests';
          console.log(`[WS] NhÃ¡ÂºÂ­n ${threads?.length || 0} threads tÃ¡Â»Â« extension tÃƒÂ i khoÃ¡ÂºÂ£n: ${account_id}`);
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
                const threadId = String(t.id || t.thread_id || '');
                if (!threadId) continue;
                // The repository may namespace a Facebook thread id when the
                // same participant exists under another connected account.
                // Resolve that durable CRM id before reading previews/messages.
                const existingInternalThreadId = resolveInternalThreadId(db, account_id, threadId) || threadId;
                const previousThread = db.prepare(`
                  SELECT last_message, is_unread, thread_url, contact_name
                  FROM threads WHERE id = ?
                `).get(existingInternalThreadId);
                let name = cleanContactName(t.name || t.contact_name, null);
                if (!name || isInvalidContactName(name)) {
                  const existing = db.prepare('SELECT contact_name FROM threads WHERE id = ?').get(existingInternalThreadId);
                  let existingName = existing?.contact_name;
                  if (isInvalidContactName(existingName)) existingName = null;
                  name = existingName || 'KhÃƒÂ¡ch hÃƒÂ ng';
                }
                let cleanLastMsg = cleanMessageText(t.last_message);
                if (!cleanLastMsg || isSystemOrMetadataText(cleanLastMsg) || cleanLastMsg === 'Ã„Âang tÃ¡ÂºÂ£i...') {
                  const dbMsgs = db.prepare(`
                    SELECT content, media_url FROM messages
                    WHERE thread_id = ?
                    ORDER BY timestamp_ms DESC, created_at DESC, id DESC
                    LIMIT 10
                  `).all(existingInternalThreadId);

                  // A media message with no caption is a valid "last message" too -
                  // preview it as [Ã¡ÂºÂ¢nh] instead of falling through to an older text
                  // message or "ChÃ†Â°a cÃƒÂ³ tin nhÃ¡ÂºÂ¯n".
                  const validInDb = dbMsgs.find(m => {
                    if (m.media_url) return true;
                    const c = cleanMessageText(m.content);
                    return c && !isSystemOrMetadataText(c) && c !== 'Ã„Âang tÃ¡ÂºÂ£i...';
                  });

                  cleanLastMsg = validInDb
                    ? (cleanMessageText(validInDb.content) || (validInDb.media_url ? '[Ã¡ÂºÂ¢nh]' : ''))
                    : 'ChÃ†Â°a cÃƒÂ³ tin nhÃ¡ÂºÂ¯n';
                }

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
                  hasRecentMatchingOutbound
                });
                const storedThread = ConversationRepository.upsertThread({
                  id: threadId,
                  external_thread_id: t.external_thread_id || threadId,
                  account_id: account_id,
                              thread_url: t.thread_url || null,
                  contact_name: name,
                  last_message: cleanLastMsg,
                  is_unread: t.is_unread,
                  inbox_folder: t.inbox_folder || null,
                  inbox_folder_verified: t.inbox_folder_verified === true
                });
                const canonicalThreadId = String(storedThread?.id || existingInternalThreadId);

                if (incomingPreviewChanged) {
                  changedUnreadThreads.push({
                    account_id,
                    thread_id: canonicalThreadId,
                    external_thread_id: t.external_thread_id || threadId,
                    thread_url: t.thread_url || previousThread?.thread_url || null,
                          contact_name: name || previousThread?.contact_name || null,
                    preview_content: cleanLastMsg,
                    preview_is_like: t.is_like === true
                  });
                }

                // Auto-bind Page source nÃ¡ÂºÂ¿u thread Ã„â€˜Ã¡ÂºÂ¿n tÃ¡Â»Â« Business Suite
                if (t.page_id || t.source_type === 'page_messenger') {
                  try {
                    InboxSourceService.ensurePageSource({
                      pageId: String(t.page_id || ''),
                      accountId: account_id,
                      canonicalThreadId,
                      pageName: t.page_name || null
                    }, db);
                  } catch (psErr) {
                    console.warn('[PAGE_SOURCE] LÃ¡Â»â€”i bind thread tÃ¡Â»Â« sync:', psErr.message);
                  }
                }
                
                const currentContact = db.prepare('SELECT avatar_url FROM contacts WHERE thread_id = ?').get(canonicalThreadId);
                let initialAvatar = currentContact?.avatar_url || null;
                if (t.avatar_url && !t.avatar_url.startsWith('http')) {
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

            // Render the trusted unread/sidebar-Like preview immediately.
            // The repository later promotes this sidebar_preview_* row to
            // Facebook's native id when history sync confirms the same text.
            for (const changed of changedUnreadThreads) {
              const previewContent = cleanMessageText(changed.preview_content);
              const canonicalThreadId = resolveInternalThreadId(db, changed.account_id, changed.thread_id) || changed.thread_id;
              if (previewContent) {
                const previewTimestamp = Date.now();
                const previewHash = crypto.createHash('sha1')
                  .update(String(changed.account_id) + '|' + String(canonicalThreadId) + '|' + previewContent)
                  .digest('hex').slice(0, 16);
                // Stable per thread+content: repeated sidebar scans cannot
                // manufacture duplicate provisional bubbles from old previews.
                const previewId = 'sidebar_preview_' + previewHash;
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
                  const previewRow = db.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(previewId);
                  if (previewRow) {
                    io.emit('NEW_MESSAGE', { ...previewRow, account_id: changed.account_id, provisional: true });
                    io.emit('THREAD_MESSAGES_UPDATED', { thread_id: canonicalThreadId, account_id: changed.account_id });
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
              }

              InboxSyncScheduler.enqueueThreadSync({
                ...changed,
                thread_id: canonicalThreadId,
                reason: 'sidebar_incoming',
                allow_navigation: true,
                priority: 'high',
                sync_mode: 'incremental'
              });
            }

            for (const t of threads) {
              const threadId = String(t.id || t.thread_id || '');
              if (!threadId) continue;
              const canonicalThreadId = resolveInternalThreadId(db, account_id, threadId) || threadId;
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
          console.log(`[WS] Ã„ÂÃƒÂ£ emit THREADS_SYNCED lÃƒÂªn frontend: ${allThreads.length} threads`);
          // Keep the existing full sweep available as an opt-in fallback.
          // Normal operation synchronizes history only when CRM opens/scrolls a thread.
          if (process.env.FB_CRM_ENABLE_INITIAL_HISTORY_SWEEP === '1' && partial !== true) {
            InitialMessageSweepService.start(account_id);
          }
          break;
        }

        case 'THREAD_MESSAGES_SYNCED': {
          const { account_id, thread_id, messages, reason, mode, cursor, checkpoint, fetched_count, scroll_delta } = msg.data;
          console.log(`[WS] THREAD_MESSAGES_SYNCED: thread=${thread_id} mode=${mode||'full'} count=${messages?.length || 0}${reason ? ` reason=${reason}` : ''}`);
          InboxSyncScheduler.markThreadSyncResult(account_id, thread_id, reason || null);

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
            const TRANSIENT_REASONS = new Set(['marker_mismatch', 'sidebar_mismatch', 'no_rows', 'no_main_container', 'url_mismatch']);
            if (TRANSIENT_REASONS.has(reason)) {
              const scheduled = HistorySyncRetryPolicy.scheduleRetry(account_id, thread_id, () => {
                // A retry also performs tab navigation - if the operator has since
                // clicked a different thread, HistorySyncRetryPolicy already cancels
                // this before it fires, so reaching here means this thread is still
                // the one being looked at.
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
                console.log(`[WS] Retry sync tin nhÃ¡ÂºÂ¯n cho thread ${thread_id} (account ${account_id}) mode=${mode}`);
              });
              if (!scheduled) {
                console.log(`[WS] KhÃƒÂ´ng retry Ã„â€˜iÃ¡Â»Âu hÃ†Â°Ã¡Â»â€ºng thread ${thread_id} (reason=${reason}, Ã„â€˜ÃƒÂ£ hÃ¡ÂºÂ¿t lÃ†Â°Ã¡Â»Â£t); chÃ¡Â»Â click/yÃƒÂªu cÃ¡ÂºÂ§u mÃ¡Â»â€ºi.`);
              }
            } else {
              console.log(`[WS] KhÃƒÂ´ng retry Ã„â€˜iÃ¡Â»Âu hÃ†Â°Ã¡Â»â€ºng thread ${thread_id} (reason=${reason}, lÃ¡Â»â€”i vÃ„Â©nh viÃ¡Â»â€¦n); chÃ¡Â»Â click/yÃƒÂªu cÃ¡ÂºÂ§u mÃ¡Â»â€ºi.`);
            }
            return; // KhÃƒÂ´ng ghi Ã„â€˜ÃƒÂ¨ hoÃ¡ÂºÂ·c emit UI
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
                contact_name: 'KhÃƒÂ¡ch hÃƒÂ ng',
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
        case 'PAGE_EXTENSION_READY': {
          const pageId = String(msg.data?.page_id || '');
          const accountId = String(ws.accountId || msg.data?.account_id || '');
          const source = pageId && accountId ? db.prepare(`
            SELECT id FROM inbox_sources
            WHERE source_type = 'page_messenger' AND status = 'ACTIVE'
              AND external_id = ? AND owner_account_id = ?
          `).get(pageId, accountId) : null;
          if (!source) {
            console.warn(`[PageSync] Ignored unregistered Page context account=${accountId} page=${pageId}`);
            break;
          }
          const key = pageConnectionKey(accountId, pageId);
          // If this Page profile registered before its Business Suite content
          // script reported the Page context, it may have temporarily occupied
          // the normal account slot. Release that temporary slot now so the
          // personal Chrome connection remains authoritative.
          if (extensionConnections.get(accountId) === ws) {
            extensionConnections.delete(accountId);
            InboxSyncScheduler.unregisterAccount(accountId);
          }
          pageExtensionConnections.set(key, ws);
          ws.pageConnectionKeys = ws.pageConnectionKeys || new Set();
          ws.pageConnectionKeys.add(key);
          console.log(`[PageSync] Page extension ready account=${accountId} page=${pageId}`);
          if (InboxSyncScheduler.isSyncWindowActive(accountId) && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'SYNC_PAGE_SIDEBAR', data: { account_id: accountId, page_id: pageId, reason: 'page_ready' } }));
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
            ConversationRepository.upsertThread({
              id: pageThreadId,
              external_thread_id: pageThreadId,
              account_id: authenticatedAccountId,
              source_id: source.id,
              contact_name: envelope.contact_name || 'KhÃƒÂ¡ch hÃƒÂ ng',
              last_message: Array.isArray(envelope.messages) && envelope.messages.length ? (envelope.messages[envelope.messages.length - 1].content || 'ChÃ†Â°a cÃƒÂ³ tin nhÃ¡ÂºÂ¯n') : 'ChÃ†Â°a cÃƒÂ³ tin nhÃ¡ÂºÂ¯n',
              is_unread: 0,
              inbox_folder: 'INBOX'
            }, db);
            const ack = ConversationRepository.processPageBatchEnvelope({ ...envelope, account_id: authenticatedAccountId, page_id: pageId }, db);
            InboxSyncScheduler.markThreadSyncResult(authenticatedAccountId, pageThreadId, ack.status === 'committed' ? null : (ack.reason || 'page_batch_rejected'));
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
            const persistedRows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(sequence_order, id) ASC, id ASC').all(pageThreadId);
            io.emit('THREAD_MESSAGES_UPDATED', { thread_id: pageThreadId, account_id: authenticatedAccountId, messages: prepareMessagesForClient(persistedRows), authoritative: true, sync_status: ack.status === 'committed' || ack.status === 'duplicate' ? 'SYNCED' : 'FAILED', sync_error: ack.reason || null });
          } catch (error) {
            console.error('[PAGE_BATCH] ingest failed:', error.message);
            const ack = { ...ackBase, status: 'retry_required', reason: 'page_batch_ingest_failed' };
            InboxSyncScheduler.markThreadSyncResult(authenticatedAccountId, pageThreadId, ack.reason);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PAGE_BATCH_ACK', data: ack }));
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
          // failure left the CRM bubble hung in "Ã„Âang gÃ¡Â»Â­i" with no way to
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
                        error: { code: 'CONFIRMATION_TIMEOUT', message: 'KhÃƒÂ´ng nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ¡c nhÃ¡ÂºÂ­n tÃ¡Â»Â« Facebook sau 3 phÃƒÂºt' },
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
            console.warn(`[WS] CALL_ENDED: KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thread ${callThreadId}`);
            break;
          }

          const callContent = call_label || (callCallType === 'video' ? 'CuÃ¡Â»â„¢c gÃ¡Â»Âi video' : 'CuÃ¡Â»â„¢c gÃ¡Â»Âi thoÃ¡ÂºÂ¡i');
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
            console.warn('[WS] CALL_ENDED: LÃ¡Â»â€”i lÃ†Â°u DB:', dbErr.message);
          }

          console.log(`[WS] Ã°Å¸â€œÅ¾ CALL_ENDED: ${callContent} (${duration_text || '?'}) thread=${callThreadId}`);

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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Socket.io: NhÃƒÂ¢n viÃƒÂªn gÃ¡Â»Â­i tin nhÃ¡ÂºÂ¯n Ã¢â€ â€™ AI auto-pause 30 phÃƒÂºt
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    if (!InboxSyncScheduler.requestSidebarSync(account_id, 'crm_manual', { force: true })) {
      console.warn(`[Socket.io] Extension cho account ${account_id} chÃ†Â°a sÃ¡ÂºÂµn sÃƒÂ ng WebSocket.`);
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
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'YÃƒÂªu cÃ¡ÂºÂ§u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
      return;
    }
    if (!enterpriseAccess.canAccessThread(socket.user, threadId)) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân truy cÃ¡ÂºÂ­p hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.' });
      return;
    }
    const thread = db.prepare('SELECT id, external_thread_id, account_id, thread_url, contact_name, inbox_folder FROM threads WHERE id = ?').get(threadId);
    if (!thread?.account_id || !['MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(thread.inbox_folder)) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'HÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i khÃƒÂ´ng cÃƒÂ²n Ã¡Â»Å¸ Tin nhÃ¡ÂºÂ¯n chÃ¡Â»Â.' });
      return;
    }
    const extension = extensionConnections.get(String(thread.account_id));
    if (!extension || extension.readyState !== WebSocket.OPEN) {
      socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Extension Facebook chÃ†Â°a kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i.' });
      return;
    }
    messageRequestActionOwners.set(requestId, { socket, threadId, createdAt: Date.now() });
    setTimeout(() => {
      const pending = messageRequestActionOwners.get(requestId);
      if (!pending) return;
      messageRequestActionOwners.delete(requestId);
      pending.socket.emit('MESSAGE_REQUEST_ACTION_RESULT', { request_id: requestId, thread_id: threadId, action: requestedAction, success: false, error: 'Messenger phÃ¡ÂºÂ£n hÃ¡Â»â€œi quÃƒÂ¡ thÃ¡Â»Âi gian.' });
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
             t.sync_status, t.sync_cursor,
             s.source_type, s.external_id AS page_id
      FROM threads t LEFT JOIN inbox_sources s ON s.id = t.source_id
      WHERE t.id = ?
    `).get(threadId);
    if (!thread?.account_id) return;

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
    InitialMessageSweepService.noteUserActivity(thread.account_id);
    InboxSyncScheduler.clearQueuedThreadSyncs(thread.account_id, (job) => String(job.reason || '').startsWith('initial_sweep'));
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
      reason: direction === 'viewport' ? 'crm_scroll_viewport' : (direction === 'older' ? 'crm_scroll_older' : 'crm_navigation'),
      allow_navigation: true,
      priority: 'high',
      // Opening/switching user must never scroll Messenger. A saved PARTIAL
      // checkpoint is consumed only after an explicit CRM scroll-to-top event.
      sync_mode: direction === 'viewport' ? 'ondemand_viewport' : (direction === 'older' ? 'ondemand_older' : 'ondemand_initial'),
      // Preserve the operator's real upward wheel distance for older-page
      // requests. Dropping it here made the extension fall back to -1px,
      // which is too small to move Messenger's virtualized history scroller.
      scroll_delta: ['viewport', 'older'].includes(direction) ? Number(scroll_delta) || 0 : 0
    });
  });

  socket.on('TRIGGER_CALL', ({ thread_id, call_type = 'audio', account_id, call_request_id }) => {
    if (!enterpriseAccess.canAccessThread(socket.user, thread_id)) return socket.emit('CALL_ERROR', { error: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân sÃ¡Â»Â­ dÃ¡Â»Â¥ng hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i nÃƒÂ y.' });
    let targetAccId = account_id;
    if (!targetAccId && thread_id) {
      const thread = db.prepare('SELECT account_id FROM threads WHERE id = ?').get(thread_id);
      if (thread?.account_id) targetAccId = thread.account_id;
    }
    if (!targetAccId && extensionConnections.size > 0) {
      targetAccId = extensionConnections.keys().next().value;
    }
    if (!targetAccId || !thread_id) {
      socket.emit('CALL_TRIGGER_RESPONSE', { success: false, error: 'ThiÃ¡ÂºÂ¿u thÃƒÂ´ng tin tÃƒÂ i khoÃ¡ÂºÂ£n hoÃ¡ÂºÂ·c hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
      return;
    }

    if (!callEventDeduplicator.claimOutgoing({
      accountId: targetAccId,
      threadId: thread_id,
      callType: call_type
    })) {
      socket.emit('CALL_TRIGGER_RESPONSE', {
        success: false,
        error: 'CuÃ¡Â»â„¢c gÃ¡Â»Âi nÃƒÂ y vÃ¡Â»Â«a Ã„â€˜Ã†Â°Ã¡Â»Â£c kÃƒÂ­ch hoÃ¡ÂºÂ¡t. Vui lÃƒÂ²ng chÃ¡Â»Â trong giÃƒÂ¢y lÃƒÂ¡t.'
      });
      return;
    }

    const requestId = String(call_request_id || require('crypto').randomUUID());
    const extWs = extensionConnections.get(targetAccId);
    if (extWs && extWs.readyState === WebSocket.OPEN) {
      console.log(`[Socket.io] Ã°Å¸â€œÅ¾ YÃƒÂªu cÃ¡ÂºÂ§u kÃƒÂ­ch hoÃ¡ÂºÂ¡t cuÃ¡Â»â„¢c gÃ¡Â»Âi Messenger ${call_type} cho thread ${thread_id} (account ${targetAccId})`);
      extWs.send(JSON.stringify({
        type: 'TRIGGER_MESSENGER_CALL',
        data: { account_id: targetAccId, thread_id, call_type, call_request_id: requestId }
      }));
      socket.emit('CALL_TRIGGER_RESPONSE', { success: true, message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i lÃ¡Â»â€¡nh kÃƒÂ­ch hoÃ¡ÂºÂ¡t cuÃ¡Â»â„¢c gÃ¡Â»Âi tÃ¡Â»â€ºi Extension' });
    } else {
      console.warn(`[Socket.io] Extension cho account ${targetAccId} chÃ†Â°a sÃ¡ÂºÂµn sÃƒÂ ng WebSocket.`);
      socket.emit('CALL_TRIGGER_RESPONSE', { success: false, error: 'Extension Facebook chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i' });
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
      return socket.emit('SEND_ERROR', { client_message_id, code: 'ACCOUNT_NOT_ASSIGNED', error: 'TÃƒÂ i khoÃ¡ÂºÂ£n Facebook chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c Admin cÃ¡ÂºÂ¥p cho bÃ¡ÂºÂ¡n.' });
    }

    // NhÃƒÂ¢n viÃƒÂªn gÃƒÂµ tay Ã¢â€ â€™ tÃ¡ÂºÂ¡m dÃ¡Â»Â«ng AI 30 phÃƒÂºt
    const pauseResult = aiMediator.pauseForThread(thread_id);
    io.emit('AI_PAUSED', { thread_id, until: pauseResult.until });

    try {
      if (isRichMessage) {
        if (isLoopbackAddress(socket.handshake?.address) === false) {
          throw new RichMessageService.Error(
            'LOCAL_CRM_REQUIRED',
            'Rich-message chÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p tÃ¡Â»Â« CRM chÃ¡ÂºÂ¡y trÃƒÂªn mÃƒÂ¡y nÃƒÂ y.',
            403
          );
        }
        const forbiddenRoutingFields = ['account_id', 'source_id', 'source_type', 'page_id'];
        if (forbiddenRoutingFields.some((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
          throw new RichMessageService.Error(
            'ROUTING_FIELDS_FORBIDDEN',
            'CRM khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c tÃ¡Â»Â± chÃ¡Â»â€° Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i khoÃ¡ÂºÂ£n hoÃ¡ÂºÂ·c nguÃ¡Â»â€œn gÃ¡Â»Â­i.',
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
          // Rich attachments own a media bubble; ignore any stale composer
          // text so a video/image cannot also create a second text message.
          content: attachment_id ? '' : content,
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
      console.error('[Socket] LÃ¡Â»â€”i gÃ¡Â»Â­i tin nhÃ¡ÂºÂ¯n:', err.message);
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
      if (!enterpriseAccess.canAccessThread(socket.user, payload.thread_id)) throw Object.assign(new Error('TÃƒÂ i khoÃ¡ÂºÂ£n Facebook chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c Admin cÃ¡ÂºÂ¥p cho bÃ¡ÂºÂ¡n.'), { code: 'ACCOUNT_NOT_ASSIGNED' });
      if (isLoopbackAddress(socket.handshake?.address) === false) {
        throw new RichMessageService.Error(
          'LOCAL_CRM_REQUIRED',
          'Rich-message chÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p tÃ¡Â»Â« CRM chÃ¡ÂºÂ¡y trÃƒÂªn mÃƒÂ¡y nÃƒÂ y.',
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// REST API
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function requireCompanyAdmin(req, res, next) {
  if (enterpriseAccess.isCompanyAdmin(req.user) || (req.user.role === 'ADMIN' && req.user.username === 'admin')) return next();
  return res.status(403).json({ success: false, error: 'ChÃ¡Â»â€° Admin doanh nghiÃ¡Â»â€¡p Ã„â€˜Ã†Â°Ã¡Â»Â£c sÃ¡Â»Â­ dÃ¡Â»Â¥ng chÃ¡Â»Â©c nÃ„Æ’ng nÃƒÂ y.' });
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
    if (!centralResponse.ok || !central.success) return res.status(centralResponse.status).json({ success: false, error: central.message || 'License Server tÃ¡Â»Â« chÃ¡Â»â€˜i tÃ¡ÂºÂ¡o nhÃƒÂ¢n viÃƒÂªn.' });
    const employee = enterpriseAccess.createEmployee(req.user, req.body || {});
    res.status(201).json({ success: true, employee });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'KhÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡ÂºÂ¡o nhÃƒÂ¢n viÃƒÂªn.' });
  }
});

app.delete('/api/company/employees/:id', requireCompanyAdmin, async (req, res) => {
  const employee = db.prepare("SELECT username FROM users WHERE id=? AND company_id=? AND company_role='EMPLOYEE'").get(Number(req.params.id), req.user.company_id);
  if (!employee) return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y nhÃƒÂ¢n viÃƒÂªn.' });
  try {
    const centralResponse = await fetch(`${LICENSE_SERVER_BASE_URL}/api/client-auth/company-employees`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminUsername: req.user.username, username: employee.username })
    });
    if (!centralResponse.ok && centralResponse.status !== 404) throw new Error('KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a nhÃƒÂ¢n viÃƒÂªn trÃƒÂªn License Server.');
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

// Accounts
app.get('/api/accounts', (req, res) => {
  const accounts = enterpriseAccess.listAccounts(req.user);
  const result = accounts.map(acc => ({
    ...acc,
    is_extension_connected: extensionConnections.has(acc.id) && extensionConnections.get(acc.id).readyState === WebSocket.OPEN,
    is_chrome_running: processManager.getStatus(acc.id) === 'RUNNING',
    chrome_display_mode: processManager.getDisplayMode(acc.id)
  }));
  res.json(result);
});
app.post('/api/accounts/:id/start', async (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n Facebook' });
  }
  const accountId = String(req.params.id);
  backgroundAfterConnectRequests.set(accountId, Date.now());
  const success = await processManager.startAccountProcess(accountId, null, { forceExtensionReload: true });
  if (!success) {
    backgroundAfterConnectRequests.delete(accountId);
    return res.json({ success: false });
  }

  // Start every Page already connected to this Facebook account in its own
  // Chrome profile as part of Connect Facebook. This keeps Page and Personal
  // Messenger independent and does not modify either existing process.
  const pageLaunches = activePageSourcesForAccount(accountId).map((source) =>
    processManager.startPageProcess(source.page_id, accountId).catch((error) => {
      console.warn(`[PageSync] Could not launch Page ${source.page_id} on connect:`, error.message);
      return false;
    })
  );
  await Promise.all(pageLaunches);

  // Chrome remains visible until the initial combined sidebar result arrives.
  // The final SYNC_THREADS_RESULT frame moves it to background; keeping the
  // request marker here also covers an already-connected extension.
  res.json({ success: true, page_windows_requested: pageLaunches.length });
});
app.post('/api/accounts/:id/stop', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n Facebook' });
  }
  backgroundAfterConnectRequests.delete(String(req.params.id));
  const stopped = processManager.stopAccountProcess(req.params.id);
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
  console.log(`[WS] Ã°Å¸â€â€ž Ã„ÂÃƒÂ£ gÃ¡Â»Â­i tÃƒÂ­n hiÃ¡Â»â€¡u RELOAD_EXTENSION tÃ¡Â»â€ºi ${count} kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Extension WebSocket.`);
  res.json({ success: true, reloaded: count });
});
app.post('/api/accounts/:id/open', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n Facebook' });
  }
  if (processManager.getStatus(req.params.id) !== 'RUNNING') {
    return res.status(409).json({ success: false, error: 'HÃƒÂ£y kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i tÃƒÂ i khoÃ¡ÂºÂ£n Facebook trÃ†Â°Ã¡Â»â€ºc khi bÃ¡ÂºÂ­t hiÃ¡Â»Æ’n thÃ¡Â»â€¹ Chrome.' });
  }
  const visible = processManager.unhideWindow(req.params.id);
  res.json({ success: visible });
});
app.post('/api/accounts/:id/background', (req, res) => {
  if (!enterpriseAccess.canAccessAccount(req.user, req.params.id)) {
    return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n Facebook' });
  }
  if (processManager.getStatus(req.params.id) !== 'RUNNING') {
    return res.status(409).json({ success: false, error: 'TÃƒÂ i khoÃ¡ÂºÂ£n Facebook chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i.' });
  }
  const hidden = processManager.hideAccountProcess(req.params.id);
  res.json({ success: hidden });
});
app.post('/api/accounts/new-session', async (req, res) => {
  if (!enterpriseAccess.isCompanyAdmin(req.user) && !(req.user.role === 'ADMIN' && req.user.username === 'admin')) {
    return res.status(403).json({ success: false, error: 'ChÃ¡Â»â€° Admin doanh nghiÃ¡Â»â€¡p Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃƒÂªm tÃƒÂ i khoÃ¡ÂºÂ£n Facebook.' });
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
  // Recover an unfinished login owned by this operator after a backend
  // restart. Without this durable marker every click created another cold
  // Chrome profile, losing Facebook device trust/cache and making login slow.
  const profilesRoot = path.join(APP_DATA_ROOT, 'profiles');
  try {
    const reusable = fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('pending_'))
      .map((entry) => {
        const markerPath = path.join(profilesRoot, entry.name, '.crm-pending-owner.json');
        try {
          const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
          const stat = fs.statSync(markerPath);
          return String(marker.owner_user_id) === String(req.user.id)
            ? { pendingKey: entry.name, modifiedMs: stat.mtimeMs }
            : null;
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.modifiedMs - a.modifiedMs)[0];
    if (reusable) {
      pendingAccountOwners.set(reusable.pendingKey, req.user.id);
      const success = await processManager.startNewAccountProcess(reusable.pendingKey);
      if (success) {
        console.log(`[API] Recovered unfinished Facebook login profile: ${reusable.pendingKey}`);
        return res.json({ success: true, pending_key: reusable.pendingKey, reused: true });
      }
      pendingAccountOwners.delete(reusable.pendingKey);
    }
  } catch (_) {}

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

  console.log(`[API] TÃ¡ÂºÂ¡o phiÃƒÂªn Ã„â€˜Ã„Æ’ng kÃƒÂ½ tÃƒÂ i khoÃ¡ÂºÂ£n Facebook mÃ¡Â»â€ºi: ${pendingKey}`);
  const success = await processManager.startNewAccountProcess(pendingKey);
  if (!success) pendingAccountOwners.delete(pendingKey);
  res.json({ success, pending_key: pendingKey });
});
app.delete('/api/accounts/:id', (req, res) => {
  try {
    const accountId = String(req.params.id || '').trim();
    completeNewAccountBootstrapSync(accountId);
    const account = enterpriseAccess.canAccessAccount(req.user, accountId)
      ? db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId) : null;
    if (!enterpriseAccess.isCompanyAdmin(req.user) && !(req.user.role === 'ADMIN' && req.user.username === 'admin')) {
      return res.status(403).json({ success: false, error: 'ChÃ¡Â»â€° Admin doanh nghiÃ¡Â»â€¡p Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n Facebook.' });
    }
    if (!account) {
      return res.status(404).json({ success: false, error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n Facebook' });
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
    // Close a popup that may already be visible before clients remove the
    // account from their local list.
    io.emit('INCOMING_CALL_ENDED', { account_id: accountId, reason: 'ACCOUNT_REMOVED' });
    io.emit('ACCOUNT_REMOVED', { account_id: accountId });
    io.emit('INBOX_SOURCE_REMOVED', { id: 'src_personal_' + accountId });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[API] KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n Facebook:', error);
    res.status(500).json({ success: false, error: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n Facebook', detail: error.message });
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
  return res.status(error.statusCode || 500).json({ error: error.message || 'KhÃƒÂ´ng thÃ¡Â»Æ’ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t follow-up.' });
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



// Contacts / Leads
// CRM one-to-one rich-message capabilities and thread-bound staging.
// This server has no user session layer yet, so new file operations fail
// closed outside loopback and content URLs additionally require a short-lived HMAC.
app.get(
  '/api/threads/:threadId/rich-message-capabilities',
  requireLocalCrmRequest,
  (req, res) => {
    try {
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.' });
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
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.' });
      const operatorId = req.user.id;
      if (operatorId == null) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'CRM chÃ†Â°a cÃƒÂ³ operator hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
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
      if (!enterpriseAccess.canAccessThread(req.user, req.params.threadId)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.' });
      const operatorId = req.user.id;
      if (operatorId == null) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'CRM chÃ†Â°a cÃƒÂ³ operator hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
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
          error: 'File khÃƒÂ´ng thuÃ¡Â»â„¢c hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i nÃƒÂ y hoÃ¡ÂºÂ·c khÃƒÂ´ng cÃƒÂ²n Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i chÃ¡Â»Â gÃ¡Â»Â­i.'
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
    res.status(404).json({ error: 'File khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
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
          error: 'LiÃƒÂªn kÃ¡ÂºÂ¿t file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c Ã„â€˜ÃƒÂ£ hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n.'
        });
      }
      const attachment = OutboundAttachmentService.resolveContent(
        req.params.attachmentId,
        { database: db }
      );
      if (attachment == null) {
        return res.status(404).json({ code: 'ATTACHMENT_NOT_FOUND', error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y file.' });
      }
      const disposition = attachment.media_type === 'image' ? 'inline' : 'attachment';
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
  if (!enterpriseAccess.canAccessThread(req.user, req.params.thread_id)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
  const contact = db.prepare('SELECT * FROM contacts WHERE thread_id=?').get(req.params.thread_id) || {};
  const phoneView = PhoneCaptureService.getContactPhoneView(req.params.thread_id, db);
  res.json({ ...contact, phone_candidates: phoneView.phone_candidates, phone_capture: phoneView.phone_capture });
});

app.put('/api/contacts/:thread_id', (req, res) => {
  if (!enterpriseAccess.canAccessThread(req.user, req.params.thread_id)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
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

// Inbox Sources Ã¢â‚¬â€ Personal and Page connected sources
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
    res.status(500).json({ error: error.message || 'KhÃƒÂ´ng thÃ¡Â»Æ’ lÃ¡ÂºÂ¥y danh sÃƒÂ¡ch nguÃ¡Â»â€œn hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
  }
});

// Manual "KÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Page" flow (AccountManagerModal) Ã¢â‚¬â€ this only ever accepted a
// raw Page ID or a profile.php?id= link (per the UI's own placeholder text;
// no Graph API token is actually needed since the extension does DOM
// automation, not the Graph API), but no route ever backed the POST the
// frontend sends here Ã¢â‚¬â€ every submit 404'd and Express's default handler
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
    if (!raw) return res.status(400).json({ error: 'ThiÃ¡ÂºÂ¿u Link Page hoÃ¡ÂºÂ·c ID Page' });

    const pageId = parsePageIdFromInput(raw);
    if (!pageId) {
      return res.status(400).json({ error: 'KhÃƒÂ´ng nhÃ¡ÂºÂ­n diÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c ID Page. DÃƒÂ¹ng ID sÃ¡Â»â€˜ hoÃ¡ÂºÂ·c link dÃ¡ÂºÂ¡ng facebook.com/profile.php?id=...' });
    }

    if (!ownerAccountId) return res.status(403).json({ error: 'TÃƒÂ i khoÃ¡ÂºÂ£n Facebook sÃ¡Â»Å¸ hÃ¡Â»Â¯u Page khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c bÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân truy cÃ¡ÂºÂ­p.' });
    const source = InboxSourceService.ensurePageSource({ pageId, accountId: ownerAccountId, pageName: null }, db);
    // Launch asynchronously after the source is persisted. Personal Messenger
    // keeps its existing Chrome process; Page receives a separate profile/window
    // with the extension installed and opens Business Suite for this page.
    processManager.startPageProcess(pageId, ownerAccountId).catch((launchError) => {
      console.warn(`[InboxSource] KhÃƒÂ´ng thÃ¡Â»Æ’ mÃ¡Â»Å¸ Chrome riÃƒÂªng cho Page ${pageId}:`, launchError.message);
    });
    io.emit('INBOX_SOURCE_ADDED', { id: source.id, source_type: 'page_messenger', display_name: source.display_name });
    res.json(source);
  } catch (error) {
    console.error('[InboxSource] KÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Page thÃ¡Â»Â§ cÃƒÂ´ng thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i:', error);
    res.status(500).json({ error: error.message || 'KhÃƒÂ´ng thÃ¡Â»Æ’ kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i Page' });
  }
});

// Lead Statuses Ã¢â‚¬â€ staff-created, reusable, color-coded (feature 022)
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
    return res.status(500).json({ error: 'KhÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡ÂºÂ¡o trÃ¡ÂºÂ¡ng thÃƒÂ¡i mÃ¡Â»â€ºi.' });
  }
});

app.delete('/api/lead-statuses/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
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

// Avatar serving - serves local avatar files
app.get('/api/avatars/:filename', serveAvatar);

// Search
app.get('/api/search', (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'ThiÃ¡ÂºÂ¿u query q' });
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Task 4.1: Auto-Reply CRUD Ã¢â€â‚¬Ã¢â€â‚¬
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
  if (!campaign) return sendCampaignError(res, { code: "CAMPAIGN_NOT_FOUND", message: "KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y chiÃ¡ÂºÂ¿n dÃ¡Â»â€¹ch." });
  res.json(campaign);
});

app.get('/api/campaigns/:id/response-stats', (req, res) => {
  try {
    const statistics = CampaignResponseStatsService.get(req.params.id, db);
    if (!statistics) return sendCampaignError(res, { code: 'CAMPAIGN_NOT_FOUND', message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y chiÃ¡ÂºÂ¿n dÃ¡Â»â€¹ch.' });
    res.json(statistics);
  } catch (error) {
    console.error('[Campaign response stats]', error);
    res.status(500).json({ error: { code: 'CAMPAIGN_STATS_ERROR', message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡ÂºÂ£i thÃ¡Â»â€˜ng kÃƒÂª phÃ¡ÂºÂ£n hÃ¡Â»â€œi.' } });
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
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Campaign Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃ¡Â»Â­ lÃƒÂ½ bÃ¡Â»Å¸i yÃƒÂªu cÃ¡ÂºÂ§u khÃƒÂ¡c.');
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
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'YÃƒÂªu cÃ¡ÂºÂ§u pause bÃ¡Â»â€¹ trÃƒÂ¹ng.');
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
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'YÃƒÂªu cÃ¡ÂºÂ§u resume bÃ¡Â»â€¹ trÃƒÂ¹ng.');
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
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'YÃƒÂªu cÃ¡ÂºÂ§u cancel bÃ¡Â»â€¹ trÃƒÂ¹ng.');
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
    if (!campaign) return sendCampaignError(res, { code: "CAMPAIGN_NOT_FOUND", message: "KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y chiÃ¡ÂºÂ¿n dÃ¡Â»â€¹ch." });
    if (["running", "pausing", "cancelling"].includes(campaign.status)) {
      return sendCampaignError(res, { code: "CAMPAIGN_STATE_CONFLICT", message: "HÃƒÂ£y tÃ¡ÂºÂ¡m dÃ¡Â»Â«ng chiÃ¡ÂºÂ¿n dÃ¡Â»â€¹ch trÃ†Â°Ã¡Â»â€ºc khi retry thÃ¡Â»Â§ cÃƒÂ´ng." });
    }
    const recipient = campaign.recipients.find((item) => item.id === req.params.recipientId);
    if (!recipient) {
      throw new CampaignService.CampaignError('INVALID_RECIPIENT', 'Recipient khÃƒÂ´ng thuÃ¡Â»â„¢c campaign.');
    }
    if (recipient.status === 'sent') {
      throw new CampaignService.CampaignError('RECIPIENT_ALREADY_SENT', 'Recipient Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i thÃƒÂ nh cÃƒÂ´ng.');
    }
    if (recipient.status !== 'failed') {
      throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'ChÃ¡Â»â€° recipient failed mÃ¡Â»â€ºi cÃƒÂ³ thÃ¡Â»Æ’ retry.');
    }
    CampaignEligibilityService.revalidateSnapshotRecipient(recipient, db, {
      getConnection: (accountId) => extensionConnections.get(accountId)
    });
    CampaignRepository.retryRecipient(req.params.id, req.params.recipientId);
    campaign = CampaignRepository.getCampaign(req.params.id);
    const shouldRun = ['completed_with_errors', 'failed', 'cancelled'].includes(campaign.status);
    if (shouldRun) {
      if (!CampaignRepository.updateCampaignStatus(req.params.id, campaign.status, 'ready')) {
        throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'Retry Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃ¡Â»Â­ lÃƒÂ½ bÃ¡Â»Å¸i yÃƒÂªu cÃ¡ÂºÂ§u khÃƒÂ¡c.');
      }
      CampaignService.validateReadyForStart(req.params.id);
      if (!CampaignRepository.updateCampaignStatus(req.params.id, 'ready', 'running')) {
        throw new CampaignService.CampaignError('CAMPAIGN_STATE_CONFLICT', 'KhÃƒÂ´ng thÃ¡Â»Æ’ khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng retry.');
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


// Ã¢â€â‚¬Ã¢â€â‚¬ Task 4.2: Broadcast Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/api/accounts/:id/broadcast/quota', (req, res) => {
  res.json(broadcastEngine.getDailyQuota(req.params.id));
});

app.post('/api/accounts/:id/broadcast', async (req, res) => {
  const { thread_ids, message } = req.body;
  if (!thread_ids?.length || !message) {
    return res.status(400).json({ error: 'ThiÃ¡ÂºÂ¿u thread_ids hoÃ¡ÂºÂ·c message' });
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Task 4.3: AI Config CRUD Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/api/accounts/:id/ai-config', (req, res) => {
  const config = aiMediator.getConfig(req.params.id);
  // Mask API key trÃ†Â°Ã¡Â»â€ºc khi trÃ¡ÂºÂ£ vÃ¡Â»Â
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
  if (!enterpriseAccess.canAccessThread(req.user, req.params.id)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
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
  if (!enterpriseAccess.canAccessThread(req.user, req.params.id)) return res.status(404).json({ error: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i' });
  res.json(ConversationRepository.getMessageTimestamps(req.params.id));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  // DÃ¡Â»Ân dÃ¡ÂºÂ¹p cÃƒÂ¡c tÃƒÂªn rÃƒÂ¡c hÃ¡Â»â€¡ thÃ¡Â»â€˜ng (vÃƒÂ­ dÃ¡Â»Â¥: "TÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ tin nhÃ¡ÂºÂ¯n", "HÃ¡Â»â„¢p thÃ†Â° Ã„â€˜Ã¡ÂºÂ¿n") Ã„â€˜ÃƒÂ£ lÃ†Â°u vÃƒÂ o CSDL trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y
  try {
    const dirtySystemNames = [
      'TÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ tin nhÃ¡ÂºÂ¯n', 'TÃ¡ÂºÂ¥t cÃ¡ÂºÂ£', 'All messages', 'All',
      'Tin nhÃ¡ÂºÂ¯n trÃ¡Â»Â±c tiÃ¡ÂºÂ¿p', 'Direct messages',
      'HÃ¡Â»â„¢p thÃ†Â° Ã„â€˜Ã¡ÂºÂ¿n', 'HÃ¡Â»â„¢p thÃ†Â°', 'Inbox',
      'ChÃ†Â°a Ã„â€˜Ã¡Â»Âc', 'Unread', 'Ã„ÂÃƒÂ£ xong', 'Done',
      'GÃ¡ÂºÂ¯n dÃ¡ÂºÂ¥u sao', 'Ã„ÂÃƒÂ£ gÃ¡ÂºÂ¯n dÃ¡ÂºÂ¥u sao', 'Starred',
      'Spam', 'ThÃ†Â° rÃƒÂ¡c', 'Ã„Âang', 'Facebook', 'Messenger', 'Meta'
    ];
    const placeholders = dirtySystemNames.map(() => '?').join(',');
    db.prepare(`
      UPDATE threads 
      SET contact_name = 'KhÃƒÂ¡ch hÃƒÂ ng' 
      WHERE contact_name IN (${placeholders}) 
         OR contact_name LIKE 'Ã„Âang hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng%' 
         OR contact_name LIKE 'HoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng%'
    `).run(...dirtySystemNames);
    db.prepare(`
      UPDATE contacts 
      SET name = 'KhÃƒÂ¡ch hÃƒÂ ng' 
      WHERE name IN (${placeholders}) 
         OR name LIKE 'Ã„Âang hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng%' 
         OR name LIKE 'HoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng%'
    `).run(...dirtySystemNames);

  } catch (cleanErr) {
    console.warn('[DB] LÃ¡Â»â€”i dÃ¡Â»Ân dÃ¡ÂºÂ¹p tÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng:', cleanErr.message);
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

  return listenPromise;
}

InitialMessageSweepService.configure({
  listThreads: (accountId) => db.prepare(`
    SELECT t.id, t.external_thread_id, t.thread_url, t.contact_name,
           CASE WHEN s.source_type = 'page_messenger' THEN s.external_id ELSE NULL END AS page_id
    FROM threads t
    LEFT JOIN inbox_sources s ON s.id = t.source_id
    WHERE t.account_id = ? AND t.archived_at IS NULL
      AND COALESCE(t.sync_status, 'LOCAL') <> 'SYNCED'
    ORDER BY t.last_activity DESC
  `).all(String(accountId)),
  enqueue: (job) => InboxSyncScheduler.enqueueThreadSync(job),
  isBusy: (accountId) => InboxSyncScheduler.isAccountThreadBusy(accountId),
  isReady: (accountId) => {
    const connection = extensionConnections.get(String(accountId));
    return Boolean(connection && connection.readyState === WebSocket.OPEN);
  },
  emit: (progress) => io.emit('INITIAL_MESSAGE_SYNC_PROGRESS', progress)
});

InboxSyncScheduler.configure({
  getConnection: (accountId) => extensionConnections.get(String(accountId)),
  dispatchThreadMessagesSync: ({ account_id, thread_id, external_thread_id, thread_url, page_id, contact_name, reason, allow_navigation, sync_mode, scroll_delta }) => {
    const extWs = extensionConnections.get(String(account_id));
    if (!extWs || extWs.readyState !== WebSocket.OPEN) return false;
    const syncState = require('./services/HistorySyncManager').getSyncState(thread_id);
    const pageSource = ConversationRepository.getThreadSource(thread_id);
    const persisted = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(thread_id);
    let mode = sync_mode || 'incremental';
    if (!sync_mode && (!syncState?.sync_cursor || Number(persisted?.count || 0) === 0)) mode = 'initial';
    else if (!sync_mode && (syncState.sync_status === 'PARTIAL' || syncState.sync_status === 'FAILED')) mode = 'deep_backfill';
    extWs.send(JSON.stringify({
      type: 'SYNC_THREAD_MESSAGES',
      data: {
        account_id,
        thread_id,
        external_thread_id: external_thread_id || thread_id,
        thread_url,
        page_id: pageSource?.sourceType === 'personal_messenger' ? null : (page_id || pageSource?.pageId || null),
        mode,
        cursor: syncState?.sync_cursor || null,
        contact_name,
        reason,
        allow_navigation: allow_navigation === true,
        scroll_delta: Number(scroll_delta) || 0
      }
    }));
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

function stopManagedProcesses() {
  if (extensionHealthMonitor) {
    clearInterval(extensionHealthMonitor);
    extensionHealthMonitor = null;
  }
  return processManager.stopAllAccountProcesses();
}

module.exports = { app, server, startServer, stopManagedProcesses, extensionConnections, io };
