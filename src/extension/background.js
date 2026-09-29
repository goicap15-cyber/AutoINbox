// AutoChatbot FB Engine - Service Worker Background Script
importScripts('tabCreationCoordinator.js', 'queueEnvelopeValidation.js', 'callTabDeduplicator.js', 'messengerTabDeduplicator.js', 'messengerTabRoles.js', 'pageVideoUploader.js', 'pageNameExtractor.js', 'pageDiscovery.js', 'pageIdentityGate.js');
const tabCreationCoordinator = self.FbCrmTabCreationCoordinator.createTabCreationCoordinator();

async function blockFacebookNativeNotifications() {
  if (!chrome?.contentSettings?.notifications) return;
  const patterns = [
    'https://[*.]facebook.com/*',
    'https://[*.]messenger.com/*'
  ];
  for (const primaryPattern of patterns) {
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'block',
        scope: 'regular'
      });
    } catch (_) {}
  }
}

blockFacebookNativeNotifications();
let ws = null;
const BACKEND_OUTBOX_STORAGE_KEY = 'fb_engine_realtime_outbox_v1';
const QUEUED_BACKEND_TYPES = new Set(['NEW_MESSAGE_RECEIVED', 'PAGE_NAME_DETECTED', 'PAGE_EXTENSION_READY']);
let backendOutbox = [];
let backendOutboxLoaded = null;
let backendOutboxFlushInFlight = false;
let backendAccountRegistered = false;
let backendOutboxAckTimer = null;

function backendOutboxIdentity(entry) {
  const data = entry?.data || {};
  return [
    entry?.type || '', data.account_id || '', data.thread_id || '',
    data.fb_message_id || data.client_message_id || '', data.source || '',
    data.media_type || 'text', data.timestamp_ms || data.created_at || '',
    data.content || ''
  ].join('|');
}

function loadBackendOutbox() {
  if (!backendOutboxLoaded) {
    backendOutboxLoaded = chrome.storage.local.get([BACKEND_OUTBOX_STORAGE_KEY])
      .then((stored) => {
        const persisted = Array.isArray(stored?.[BACKEND_OUTBOX_STORAGE_KEY])
          ? stored[BACKEND_OUTBOX_STORAGE_KEY]
          : [];
        const combined = [...persisted, ...backendOutbox];
        const seen = new Set();
        backendOutbox = combined.filter((entry) => {
          const identity = backendOutboxIdentity(entry);
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        }).slice(-500);
        return backendOutbox;
      })
      .catch(() => backendOutbox);
  }
  return backendOutboxLoaded;
}

function persistBackendOutbox() {
  return chrome.storage.local.set({ [BACKEND_OUTBOX_STORAGE_KEY]: backendOutbox.slice(-500) }).catch(() => {});
}

function enqueueBackendPayload(type, data) {
  const entry = {
    type, data, queued_at: Date.now(),
    outbox_id: (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`)
  };
  loadBackendOutbox().then(() => {
    const identity = backendOutboxIdentity(entry);
    if (!backendOutbox.some((candidate) => backendOutboxIdentity(candidate) === identity)) {
      backendOutbox.push(entry);
      if (backendOutbox.length > 500) backendOutbox.splice(0, backendOutbox.length - 500);
    }
    return persistBackendOutbox();
  }).catch(() => {});
}

async function flushBackendOutbox() {
  // Keep queued incoming messages until the server has bound this socket to
  // the Facebook account. A socket can be open before registration is ready.
  if (backendOutboxFlushInFlight || !backendAccountRegistered || !ws || ws.readyState !== WebSocket.OPEN) return;
  backendOutboxFlushInFlight = true;
  try {
    await loadBackendOutbox();
    const entry = backendOutbox[0];
    if (!entry) return;
    const data = entry?.data || {};
    if (!data.account_id && !user_id) return;
    if (!entry.outbox_id) {
      entry.outbox_id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`);
      await persistBackendOutbox();
    }
    ws.send(JSON.stringify({
      type: entry.type,
      outbox_id: entry.outbox_id,
      data: { ...data, account_id: data.account_id || user_id }
    }));
    clearTimeout(backendOutboxAckTimer);
    backendOutboxAckTimer = setTimeout(() => {
      backendOutboxFlushInFlight = false;
      flushBackendOutbox().catch(() => {});
    }, 5000);
  } catch (error) {
    console.warn('[FB Engine] Không thể phát lại realtime outbox:', error?.message || error);
  } finally {
    if (!backendOutbox.length) backendOutboxFlushInFlight = false;
  }
}
const pendingSetupRegistrationAccounts = new Set();

function waitForPendingSetupCompletion(accountId, attempt = 0) {
  const accountKey = String(accountId || '');
  if (!accountKey || pendingSetupRegistrationAccounts.has(accountKey)) return;
  pendingSetupRegistrationAccounts.add(accountKey);

  const check = async () => {
    try {
      const tab = await getFacebookTab(accountKey);
      if (!tab?.id) throw new Error('MESSENGER_TAB_NOT_READY');
      await assertMessengerRecoveryDialogResolved(tab.id);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => sessionStorage.removeItem('crm_pending_account_setup')
      }).catch(() => {});
      const reloadComplete = waitForTabComplete(tab.id, 15000);
      await chrome.tabs.reload(tab.id);
      await Promise.race([reloadComplete, delay(5000)]);
      await delay(1000);
      pendingSetupRegistrationAccounts.delete(accountKey);
      sendToBackend('REGISTER_ACCOUNT', {
        account_id: accountKey,
        fb_dtsg: fb_dtsg || '',
        pending_key: null,
        name: account_name || null, avatar_url: account_avatar_url || null
      });
      console.log(`[FB Engine] Setup/PIN completed; normal sync enabled for account=${accountKey}`);
    } catch (_) {
      pendingSetupRegistrationAccounts.delete(accountKey);
      if (attempt < 120) {
        setTimeout(() => waitForPendingSetupCompletion(accountKey, attempt + 1), 5000);
      }
    }
  };

  setTimeout(check, attempt === 0 ? 8000 : 0);
}
let fb_dtsg = null;
const TRUSTED_SEND_ADAPTER_VERSION = "trusted-send-v1";
let user_id = null;
let account_name = null;
let account_avatar_url = null;
let lastMessengerTabDedupAt = 0;
let pending_key = null;
let reconnectTimer = null;
let reconnectDelay = 3000;

// Personal Messenger navigation is latest-click-wins per account. A slow
// navigation/sync for an older click must never move the tab back after the
// user has already selected another conversation.
const personalNavigationSequences = new Map();
// A single Messenger composer cannot process overlapping text/media sends.
// Keep one promise chain per Facebook account so repeated image/video sends
// finish in order instead of stealing each other's tab, focus or file input.
const personalSendChains = new Map();
// A queue envelope can be replayed after reconnect before the backend receives
// its acknowledgement. Dispatch each outbound attempt only once; a real retry
// receives a new outbound_attempt_id and is therefore still allowed.
const recentQueuedDispatchAttempts = new Map();
const QUEUED_DISPATCH_IDEMPOTENCY_MS = 10 * 60 * 1000;
// History navigation uses the same Messenger surface. Serialize requests per
// account so repeated wheel events wait for the active scrape instead of
// invalidating its navigation token and returning navigation_superseded.
const personalHistoryChains = new Map();
// A failed upload can leave Messenger's hidden attachment draft mounted in
// Track active Page tab navigation locks so background sweeps do not navigate
// the single Business Suite tab away while the user is chatting or sending messages.
const pageNavigationLockThreadId = new Map(); // page_id -> thread_id
const pageNavigationLockUntil = new Map();    // page_id -> timestamp ms

function extractBareThreadId(threadId) {
  if (!threadId) return '';
  const str = String(threadId).trim();
  const parts = str.split(':').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : str;
}

const dirtyAttachmentDraftTabs = new Set();
function runPersonalSendSerialized(accountId, operation) {
  const key = String(accountId || user_id || 'default');
  const previous = personalSendChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  personalSendChains.set(key, current);
  current.finally(() => {
    if (personalSendChains.get(key) === current) personalSendChains.delete(key);
  }).catch(() => {});
  return current;
}
function runPersonalHistorySerialized(accountId, operation, isPriority = false) {
  const key = String(accountId || user_id || 'default');
  if (isPriority) {
    personalHistoryChains.delete(key);
  }
  const previous = personalHistoryChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  personalHistoryChains.set(key, current);
  current.finally(() => {
    if (personalHistoryChains.get(key) === current) personalHistoryChains.delete(key);
  }).catch(() => {});
  return current;
}

// A Chrome scripting/navigation promise can occasionally never settle while
// Messenger remounts its virtualized tree. Release the serialized history lane
// after a bounded wait and invalidate the old navigation token so realtime
// customer replies are not trapped behind it for one or two minutes.
const pageBatchSeenAt = new Map(); // thread_id -> last PAGE_THREAD_MESSAGES_SYNCED_V1 relay time
function runPersonalHistoryWithDeadline(historyKey, data, operation) {
  const mode = String(data?.mode || 'initial');
  // 2026-09-29: page scans took 20-40s per thread (background tabs render
  // throttled), so the 18s deadline fired mid-scan and reported successful
  // syncs as extension_history_timeout - the SW console caught a batch
  // committing AFTER its own deadline had already failed it. Tab activation
  // shrinks the cycle; keep the deadline above the real one - it releases
  // the lane, it must not cut a working scan. The server's 120s timeout
  // still bounds genuinely stuck operations.
  const timeoutMs = mode === 'older' ? 60000 : 45000;
  const startedAt = Date.now();
  let timeout = null;
  const timedOperation = Promise.resolve().then(operation);
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => {
      beginPersonalNavigation(historyKey);
      const batchAt = data?.thread_id ? pageBatchSeenAt.get(String(data.thread_id)) || 0 : 0;
      if (batchAt > startedAt) {
        // 2026-09-29: batches for THIS thread arrived while we waited - the
        // scan is alive and delivering. Reporting a failure here marked
        // successful syncs as FAILED and triggered duplicate rescans.
        console.log(`[FB Engine] [HISTORY] Deadline reached but batches are flowing for thread=${data?.thread_id} - not reporting failure`);
        resolve({ timed_out: true });
        return;
      }
      sendToBackend('THREAD_MESSAGES_SYNCED', {
        account_id: data?.account_id || user_id,
        thread_id: data?.thread_id,
        messages: [],
        reason: 'extension_history_timeout',
        mode: data?.mode || 'initial',
        cursor: data?.cursor || null
      });
      console.warn('[FB Engine] [HISTORY] Released stalled sync lane:', historyKey, data?.thread_id);
      resolve({ timed_out: true });
    }, timeoutMs);
  });
  return Promise.race([timedOperation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
// While CRM deliberately navigates/scrolls the visible Messenger tab, its
// MutationObserver must be treated as history replay, not realtime input.
const manualHistoryTabOwners = new Map();
// The Messenger URL changes before React always replaces the virtualized rows.
// Keep the last CRM-owned conversation per tab so a request for another person
// gets a clean viewport instead of scrolling the previous person's row cache.
const crmHistoryThreadByTab = new Map();
function beginPersonalNavigation(accountId) {
  const key = String(accountId || 'default');
  const next = (personalNavigationSequences.get(key) || 0) + 1;
  personalNavigationSequences.set(key, next);
  return { key, sequence: next };
}
function isPersonalNavigationCurrent(token) {
  return !token || personalNavigationSequences.get(token.key) === token.sequence;
}

async function dispatchTrustedEnter(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, error_code: 'CDP_ENTER_FAILED' };
  } finally {
    try { await chrome.debugger.detach(target); } catch (error) {}
  }
}

// Ensures the message composer box has focus before a trusted Enter is
// dispatched via CDP. After chrome.debugger.detach() the browser can
// silently move keyboard focus to whatever element is "next" in tab order –
// which on Messenger is often the 👍 Like button sitting beside the text
// input.  Firing Enter on that element sends a Like reaction instead of
// submitting the typed message.  Re-focusing here prevents that.
async function dispatchTrustedPointerClick(tabId, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { success: false, error: 'Invalid trusted-click coordinates', error_code: 'CDP_CLICK_POINT_INVALID' };
  }
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, error_code: 'CDP_POINTER_CLICK_FAILED' };
  } finally {
    try { await chrome.debugger.detach(target); } catch (error) {}
  }
}

async function dispatchTrustedHistoryWheel(tabId, point, deltaY) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { success: false, error_code: 'CDP_WHEEL_POINT_INVALID' };
  }
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: Number(deltaY) || -900,
      modifiers: 0,
      pointerType: 'mouse'
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, error_code: 'CDP_HISTORY_WHEEL_FAILED' };
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}
async function resetFailedMessengerComposerDraft(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const visible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const textboxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .filter((element) => {
            if (!visible(element)) return false;
            const label = String(element.getAttribute('aria-label') || '').toLowerCase();
            return !label.includes('search') && !label.includes('tìm kiếm');
          })
          .sort((left, right) => {
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return (b.width * b.height) - (a.width * a.height);
          });
        const composer = textboxes[0] || null;
        if (composer) {
          composer.focus();
          try {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
          } catch (_) {}
          composer.textContent = '';
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        }
        const composerRect = composer?.getBoundingClientRect?.() || { top: window.innerHeight * 0.65 };
        const removalPattern = /(?:gỡ|xóa|xoá|remove|delete|discard).*(?:file|tệp|ảnh|hình|video|attachment|photo)|(?:file|tệp|ảnh|hình|video|attachment|photo).*(?:gỡ|xóa|xoá|remove|delete|discard)/i;
        const controls = [...document.querySelectorAll('button, [role="button"]')]
          .filter((element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            if (rect.top < composerRect.top - 600) return false;
            const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
            return removalPattern.test(label);
          });
        controls.forEach((element) => element.click());
        await new Promise((resolve) => setTimeout(resolve, 350));
        const staleSendControl = [...document.querySelectorAll(
          'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], button[aria-label="Send"], [role="button"][aria-label="Send"]'
        )].some(visible);
        return { success: Boolean(composer) && !staleSendControl, removed_controls: controls.length, composer_found: Boolean(composer), stale_send_control: staleSendControl };
      }
    });
    let cleaned = result?.[0]?.result || { success: false };
    if (!cleaned.success) {
      await chrome.tabs.reload(tabId).catch(() => null);
      await Promise.race([waitForTabComplete(tabId, 10000), delay(2500)]);
      cleaned = { ...cleaned, success: true, reloaded: true };
    }
    sendToBackend('COMPOSER_DEBUG', { stage: 'failed_media_draft_cleanup', ...cleaned });
    return cleaned;
  } catch (error) {
    const failed = { success: false, error: error?.message || 'Unable to clean failed media draft' };
    sendToBackend('COMPOSER_DEBUG', { stage: 'failed_media_draft_cleanup', ...failed });
    return failed;
  }
}

async function isolateFailedMediaDraftBeforeSend(tabId) {
  const mustClean = dirtyAttachmentDraftTabs.has(tabId);
  // A normal empty Messenger composer can still expose a visible Send control.
  // Treating that control alone as a stale attachment draft reloads/clears the
  // composer before the next plain-text send and can turn a valid text into a
  // false retry. Only a media attempt that actually failed marks this tab dirty.
  if (!mustClean) return { success: true, cleaned: false };
  const cleanup = await resetFailedMessengerComposerDraft(tabId);
  if (!cleanup?.success) {
    const error = new Error(cleanup?.error || 'Unable to isolate failed media draft');
    error.code = 'STALE_MEDIA_DRAFT_CLEANUP_FAILED';
    throw error;
  }
  dirtyAttachmentDraftTabs.delete(tabId);
  return { ...cleanup, cleaned: true };
}

async function resetFailedBusinessSuiteComposerDraft(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Boolean(r && r.width > 0 && r.height > 0);
        };

        // 1. Clear any stuck text inside contenteditable composer
        const textboxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .filter((el) => {
            if (!visible(el)) return false;
            const label = String(el.getAttribute('aria-label') || '').toLowerCase();
            return !label.includes('search') && !label.includes('tìm kiếm');
          });
        for (const box of textboxes) {
          if (box.innerText && box.innerText.trim()) {
            box.focus();
            try {
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
            } catch (_) {}
            box.textContent = '';
            box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          }
        }

        // 2. Dismiss or remove any suggested reply / draft chips / attachment chips
        const dismissButtons = [...document.querySelectorAll('button, [role="button"]')]
          .filter((el) => {
            if (!visible(el)) return false;
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const text = (el.textContent || '').trim().toLowerCase();
            const combined = `${label} ${title} ${text}`;
            return /^(?:đóng|close|xóa|gỡ|remove|dismiss|huỷ|hủy)$/i.test(combined) ||
                   /(?:gỡ|xóa|xoá|remove|delete|discard).*(?:file|tệp|ảnh|hình|video|attachment|gợi ý|draft)/i.test(combined);
          });

        let clickedCount = 0;
        for (const btn of dismissButtons) {
          const r = btn.getBoundingClientRect();
          if (r.top > window.innerHeight * 0.4) {
            btn.click();
            clickedCount++;
          }
        }

        return { success: true, cleared_boxes: textboxes.length, dismissed_buttons: clickedCount };
      }
    });
    const cleaned = result?.[0]?.result || { success: false };
    sendToBackend('COMPOSER_DEBUG', { stage: 'business_suite_draft_cleanup', ...cleaned });
    return cleaned;
  } catch (error) {
    return { success: false, error: error.message };
  }
}


async function waitForMessengerAttachmentReady(tabId, attachmentOrManifest) {
  const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
  const hasVideo = items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').startsWith('video/'));
  const byteSize = items.reduce((sum, item) => sum + Number(item?.byte_size || 0), 0);
  // Ảnh trước đây cứng 30s - upload xong nhưng DOM ready chưa thỏa trong khung
  // này là văng ATTACHMENT_UPLOAD_TIMEOUT dù file đã nằm trong composer. Giờ ảnh
  // co giãn theo dung lượng (min 45s, trần 120s).
  // Video: Facebook xử lý phía server rất lâu (bandicam 9MB thực tế vượt
  // trần 120s cũ) - co giãn chậm hơn theo dung lượng, tối đa 5 phút.
  const timeoutMs = hasVideo
    ? Math.min(300000, Math.max(60000, 30000 + Math.ceil(byteSize / (100 * 1024)) * 1000))
    : Math.min(120000, Math.max(45000, 12000 + Math.ceil(byteSize / (256 * 1024)) * 1000));
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let readyStreak = 0;
  const probeReady = () => chrome.scripting.executeScript({
      target: { tabId },
      func: (expectVideo) => {
        const visible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const composer = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .filter((element) => {
            if (!visible(element)) return false;
            const label = String(element.getAttribute('aria-label') || '').toLowerCase();
            return !label.includes('search') && !label.includes('tìm kiếm');
          })
          .sort((left, right) => {
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return (b.width * b.height) - (a.width * a.height);
          })[0] || null;
        const composerRect = composer?.getBoundingClientRect?.() || null;
        const nearComposer = (element) => {
          if (!visible(element)) return false;
          if (!composerRect) return true;
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          return rect.bottom >= composerRect.top - 650 &&
            rect.top <= composerRect.bottom + 120 &&
            centerX >= composerRect.left - 120 &&
            centerX <= composerRect.right + 120;
        };
        const selector = 'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], ' +
          'button[aria-label="Gửi"], [role="button"][aria-label="Gửi"], ' +
          'button[aria-label="Send"], [role="button"][aria-label="Send"], ' +
          'button[aria-label="Gửi tin nhắn"], [role="button"][aria-label="Gửi tin nhắn"]';
        let sendButton = [...document.querySelectorAll(selector)].find((element) =>
          visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
        );
        if (!sendButton) {
          sendButton = [...document.querySelectorAll('button, [role="button"]')].find((el) =>
            visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
            /^(Gửi|Send)$/i.test((el.textContent || '').trim())
          );
        }
        const busy = [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].filter(nearComposer).length;
        const uploadLabels = [...document.querySelectorAll('[aria-label]')]
          .filter((element) => nearComposer(element) && /đang (?:tải|gửi)|uploading|processing video/i.test(element.getAttribute('aria-label') || '')).length;
        const stagedVideoInput = expectVideo && [...document.querySelectorAll('input[type="file"]')].some((input) =>
          [...(input.files || [])].some((file) => String(file?.type || '').startsWith('video/'))
        );
        // The enabled composer Send control is Facebook's authoritative ready
        // signal. Old media/history nodes can retain an "uploading" label, so
        // uploadLabels is diagnostic only. Video still needs four consecutive
        // ready polls in the caller before it is submitted.
        return {
          ready: (Boolean(sendButton) || stagedVideoInput) && busy === 0 && (!expectVideo || uploadLabels === 0),
          send_found: Boolean(sendButton),
          staged_video_input: Boolean(stagedVideoInput),
          busy,
          upload_labels: uploadLabels
        };
      },
      args: [hasVideo]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);

  let firstReadyAt = 0;
  while (Date.now() < deadline) {
    lastState = await probeReady();
    readyStreak = lastState?.ready ? readyStreak + 1 : 0;
    if (lastState?.ready && !firstReadyAt) firstReadyAt = Date.now();
    if (!lastState?.ready) firstReadyAt = 0;
    // Video: nút Gửi bật SỚM ngay khi file vừa staged, trong khi Facebook còn
    // xử lý phía server (thanh tiến trình mount trễ hơn ~1-2s). Submit lúc đó
    // là mất video. Yêu cầu trạng thái sẵn sàng TRỤ ĐỨNG 8s liên tục: đủ lâu
    // để progressbar kịp hiện rồi biến mất = upload thật sự hoàn tất.
    const dwellOk = !hasVideo || (firstReadyAt && Date.now() - firstReadyAt >= 8000);
    if (readyStreak >= (hasVideo ? 2 : 1) && dwellOk) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_ready', dwell_ms: firstReadyAt ? Date.now() - firstReadyAt : 0, timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...lastState });
      return lastState;
    }
    await delay(hasVideo ? 150 : 100);
  }

  // Hết hạn lần 1: thăm dò lại một nhịp 10s với điều kiện nới lỏng - CHỈ cho
  // ảnh. Nút Gửi của video có lúc bật sớm trong lúc Facebook còn xử lý, submit
  // lúc đó là mất tin; video phải chờ đủ chỉ báo sẵn sàng trong ngân sách dài.
  if (!hasVideo) {
  sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_ready_first_timeout', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...(lastState || {}) });
  const reprobeDeadline = Date.now() + 10000;
  while (Date.now() < reprobeDeadline) {
    lastState = await probeReady();
    if (lastState?.send_found) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_ready_after_reprobe', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...lastState });
      return lastState;
    }
    await delay(200);
  }
  }

  const error = new Error('Messenger chưa tải xong file đính kèm để gửi');
  error.code = 'ATTACHMENT_UPLOAD_TIMEOUT';
  sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_ready_timeout', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...(lastState || {}) });
  throw error;
}

async function waitForBusinessSuiteAttachmentReady(tabId, attachmentOrManifest) {
  if (!attachmentOrManifest) return null;
  const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
  const hasVideo = items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').toLowerCase().startsWith('video/'));
  const byteSize = items.reduce((sum, item) => sum + Number(item?.byte_size || 0), 0);
  // Ảnh co giãn theo dung lượng (min 45s, trần 120s); video chậm hơn và tối
  // đa 5 phút - Facebook xử lý video phía server lâu (thực tế bandicam 9MB
  // vượt trần 120s cũ).
  const timeoutMs = hasVideo
    ? Math.min(300000, Math.max(60000, 30000 + Math.ceil(byteSize / (100 * 1024)) * 1000))
    : Math.min(120000, Math.max(45000, 15000 + Math.ceil(byteSize / (256 * 1024)) * 1000));
  const deadline = Date.now() + timeoutMs;
  const basenames = items.map((i) => (i?.local_path || i?.name || '').split(/[\\/]/).pop()).filter(Boolean);
  let lastState = null;
  let readyStreak = 0;
  let firstReadyAt = 0;

  while (Date.now() < deadline) {
    lastState = await chrome.scripting.executeScript({
      target: { tabId },
      func: (searchNames, expectVideo) => {
        const uploader = typeof FbPageVideoUploader !== 'undefined' ? FbPageVideoUploader : null;
        if (uploader && typeof uploader.evaluateBusinessSuiteUploadState === 'function') {
          return uploader.evaluateBusinessSuiteUploadState(document, searchNames, expectVideo);
        }

        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return Boolean(r && r.width > 0 && r.height > 0);
        };
        const composerCandidates = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')];
        const composer = composerCandidates
          .filter((el) => {
            if (!visible(el)) return false;
            const label = String(el.getAttribute('aria-label') || '').toLowerCase();
            return !label.includes('search') && !label.includes('tìm kiếm');
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
          })[0] || null;

        const scope = (composer && typeof composer.closest === 'function')
          ? (composer.closest('[role="main"], form, [data-surface*="composer"], footer') || document.body)
          : document.body;

        const SEND_SELECTOR = 'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], ' +
          'button[aria-label="Gửi"], [role="button"][aria-label="Gửi"], ' +
          'button[aria-label="Send"], [role="button"][aria-label="Send"], ' +
          'button[aria-label="Gửi tin nhắn"], [role="button"][aria-label="Gửi tin nhắn"]';

        const isNotLikeButton = (el) => {
          if (!el) return false;
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          return !/thích|like|cảm xúc|sticker|emoji|thả tim|biểu tượng|nhãn dán|icon|thumbs/i.test(label + ' ' + title);
        };

        const isReadySendButton = (el) => el && visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isNotLikeButton(el);

        let sendButton = [...scope.querySelectorAll(SEND_SELECTOR)].find(isReadySendButton);
        if (!sendButton) {
          sendButton = [...scope.querySelectorAll('button, [role="button"]')].find((el) =>
            isReadySendButton(el) && /^(Gửi|Send)$/i.test((el.textContent || '').trim())
          );
        }

        const busyElements = [...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].filter(visible);
        const uploadLabels = [...scope.querySelectorAll('[aria-label]')].filter((el) =>
          visible(el) && /đang (?:tải|gửi|xử lý)|uploading|processing/i.test(el.getAttribute('aria-label') || '')
        );
        const spinnerElements = [...scope.querySelectorAll('svg circle[stroke-dasharray], [class*="loading" i], [class*="spinner" i]')].filter(visible);
        const totalBusy = busyElements.length + uploadLabels.length + spinnerElements.length;

        const videos = scope.querySelectorAll('video, [role="img"][aria-label*="video" i]');
        const blobImages = scope.querySelectorAll('img[src^="blob:"]');
        const stagedFileInput = [...scope.querySelectorAll('input[type="file"]')].some((inp) =>
          [...(inp.files || [])].length > 0
        );

        const names = (searchNames || []).filter(Boolean);
        const haystacks = [scope.innerText || ''];
        scope.querySelectorAll('[aria-label]').forEach((el) => haystacks.push(el.getAttribute('aria-label') || ''));
        const text = haystacks.join('\n');
        const matchedNames = names.filter((name) => text.includes(name));

        const hasStagedMedia = videos.length > 0 || blobImages.length > 0 || stagedFileInput || matchedNames.length > 0;
        const ready = Boolean(sendButton) && totalBusy === 0 && (hasStagedMedia || Boolean(sendButton));

        return {
          ready,
          send_found: Boolean(sendButton),
          has_staged_media: hasStagedMedia,
          busy: totalBusy,
          matched_names: matchedNames
        };
      },
      args: [basenames, hasVideo]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);

    readyStreak = lastState?.ready ? readyStreak + 1 : 0;
    if (lastState?.ready && !firstReadyAt) firstReadyAt = Date.now();
    if (!lastState?.ready) firstReadyAt = 0;
    // Video: chờ trụ 8s liên tục như bản Messenger tab (nút Gửi bật sớm).
    const dwellOk = !hasVideo || (firstReadyAt && Date.now() - firstReadyAt >= 8000);
    if (readyStreak >= (hasVideo ? 2 : 1) && dwellOk) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'page_attachment_ready', dwell_ms: firstReadyAt ? Date.now() - firstReadyAt : 0, timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...lastState });
      return lastState;
    }
    await delay(hasVideo ? 250 : 150);
  }

  // Thăm dò lại một nhịp 10s với điều kiện nới lỏng (nút Gửi đã bật là đủ) -
  // CHỈ cho ảnh: nút Gửi của video bật sớm khi Facebook còn xử lý.
  if (!hasVideo) {
  sendToBackend('COMPOSER_DEBUG', { stage: 'page_attachment_ready_first_timeout', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...(lastState || {}) });
  const bsReprobeDeadline = Date.now() + 10000;
  while (Date.now() < bsReprobeDeadline) {
    lastState = await chrome.scripting.executeScript({
      target: { tabId },
      func: (searchNames, expectVideo) => {
        const visible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const composer = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .filter(visible)
          .sort((left, right) => {
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return b.width * b.height - a.width * a.height;
          })[0] || null;
        const nearComposer = (element) => {
          if (!composer || !element) return true;
          const a = composer.getBoundingClientRect();
          const b = element.getBoundingClientRect();
          return Math.abs(a.bottom - b.bottom) < 260;
        };
        const sendButton = [...document.querySelectorAll('[role="button"], button')]
          .filter(nearComposer)
          .find((element) => /^(Gửi|Send)$/i.test(String(element.getAttribute('aria-label') || element.textContent || '').trim()));
        return { send_found: Boolean(sendButton) };
      },
      args: [basenames, hasVideo]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);
    if (lastState?.send_found) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'page_attachment_ready_after_reprobe', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...lastState });
      return lastState;
    }
    await delay(250);
  }
  }

  const error = new Error('Business Suite chưa tải xong file đính kèm để gửi');
  error.code = 'ATTACHMENT_UPLOAD_TIMEOUT';
  sendToBackend('COMPOSER_DEBUG', { stage: 'page_attachment_ready_timeout', timeout_ms: timeoutMs, byte_size: byteSize, has_video: hasVideo, ...(lastState || {}) });
  throw error;
}

async function refocusComposer(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const candidates = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const isSearch = label.includes('search') || label.includes('tìm kiếm');
            const isContentEditable = el.getAttribute('contenteditable') === 'true';
            return { el, rect, isSearch, isContentEditable, area: rect.width * rect.height };
          })
          .filter((candidate) => candidate.rect.width > 0 && candidate.rect.height > 0 && !candidate.isSearch);
        if (!candidates.length) return { success: false, error: 'Không tìm thấy ô soạn tin đang hiển thị' };
        const contentEditableCandidates = candidates.filter((candidate) => candidate.isContentEditable);
        const pool = contentEditableCandidates.length ? contentEditableCandidates : candidates;
        pool.sort((left, right) => right.area - left.area);
        const box = pool[0].el;
        box.focus();
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(box);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { success: document.activeElement === box, candidateCount: candidates.length, chosenArea: pool[0].area };
      }
    });
    const focused = result?.[0]?.result || { success: false, error: 'Không có kết quả focus' };
    sendToBackend('COMPOSER_DEBUG', { stage: 'refocus_before_enter', ...focused });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return focused;
  } catch (error) {
    const failure = { success: false, error: error?.message || 'Lỗi focus composer' };
    sendToBackend('COMPOSER_DEBUG', { stage: 'refocus_before_enter', ...failure });
    return failure;
  }
}
async function dispatchTrustedText(tabId, text) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, error_code: 'CDP_INSERT_TEXT_FAILED' };
  } finally {
    try { await chrome.debugger.detach(target); } catch (error) {}
  }
}

const WS_URLS = ['ws://127.0.0.1:5050/extension', 'ws://localhost:5050/extension'];
let currentWsIndex = 0;

// Was previously declared INSIDE connectWebSocket() - since that function
// runs again on every reconnect, each reconnect registered a brand new
// chrome.cookies.onChanged listener and a brand new setInterval on top of
// whichever ones were already running, so the number of live 2-second
// timers (each capable of firing REGISTER_ACCOUNT) only ever grew. Moved out
// here so this is set up exactly once for the service worker's lifetime.
// Also: the REGISTER_ACCOUNT send below was unconditional on every 2-second
// tick regardless of whether the user actually changed - together with the
// duplicate-timer bug this is what flooded the server with REGISTER_ACCOUNT
// (and everything it broadcasts) roughly once a second.
// Lấy tên + avatar của chính tài khoản đang đăng nhập (operator). Server lưu
// qua COALESCE nên chỉ điền chỗ còn trống/thay thế tên generic. Chạy tối đa
// một lần cho mỗi user mỗi phiên service worker; thất bại thì cho thử lại.
const ownProfileFetchedFor = new Set();
// Đặt true khi profile đã lấy được nhưng backend chưa sẵn sàng nhận (race với
// REGISTER_ACCOUNT đầu tiên) - vòng cookie-check 2s sẽ gửi lại khi đủ điều kiện.
let ownProfileSendPending = false;
function decodeFbHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2?7;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
// fetch() trong service worker chi nhan duoc HTML shell truoc hydration
// (khong co ten/avatar - reproduced 2026-09-18). Chien luoc moi: mo tab den
// trang profile cua chinh operator (co marker crm_own_profile=1), CONTENT
// SCRIPT trong tab (song doc lap voi service worker - khong bao gio bi
// "ngu" nhu MV3 SW) doc ten + avatar sau khi Facebook hydrate xong roi gui
// lai qua chrome.runtime.sendMessage. Message tu dong danh thuc SW neu no
// dang ngu -> khong con race mat ket qua. Tab duoc dong trong handler.
async function fetchOwnProfileViaTab(accountId) {
  try {
    await closeOrphanMarkerTabs();
    const created = await openMarkerTabInMessengerWindow('https://www.facebook.com/profile.php?id=' + encodeURIComponent(String(accountId)) + '&crm_own_profile=1');
    if (created?.id != null) trackMarkerTab(created.id, String(accountId));
  } catch (_) {}
  return null;
}

async function fetchAndApplyOwnFbProfile(accountId) {
  const key = String(accountId || '');
  if (!key || ownProfileFetchedFor.has(key)) return;
  ownProfileFetchedFor.add(key);
  try {
    const res = await fetch('https://www.facebook.com/profile.php?id=' + encodeURIComponent(key), { credentials: 'include' });
    if (!res.ok) {
      ownProfileFetchedFor.delete(key);
      return;
    }
    const html = await res.text();
    const nameMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)
      || html.match(/<meta\s+content="([^"]*)"\s+property="og:title"/i);
    const imgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)
      || html.match(/<meta\s+content="([^"]*)"\s+property="og:image"/i);
    const titleFallback = !nameMatch ? html.match(/<title[^>]*>([^<]+)<\/title>/i) : null;
    let fetchedName = nameMatch ? decodeFbHtmlEntities(nameMatch[1]).trim() : (titleFallback ? decodeFbHtmlEntities(titleFallback[1]).replace(/\s*[|\-–]\s*Facebook\s*$/i, '').trim() : '');
    const fetchedAvatar = imgMatch ? decodeFbHtmlEntities(imgMatch[1]).trim() : '';
    const genericProfileMissedHtml = !fetchedName && !fetchedAvatar;
    const genericName = /^(?:facebook|messenger|trang cá nhân|profile|người dùng facebook)\s*(?:\|.*)?$/i;
    if (fetchedName && genericName.test(fetchedName)) fetchedName = '';
    if (fetchedName && fetchedName !== account_name) account_name = fetchedName;
    if (fetchedAvatar && /^https?:\/\//.test(fetchedAvatar) && fetchedAvatar !== account_avatar_url) account_avatar_url = fetchedAvatar;
    if (genericProfileMissedHtml) {
      // HTML shell khong co og-tag: lay qua tab that (DOM sau hydration).
      const viaTab = await fetchOwnProfileViaTab(key);
      if (viaTab) {
        if (viaTab.name && viaTab.name !== account_name) account_name = viaTab.name;
        if (viaTab.avatar && /^https?:\/\//.test(viaTab.avatar) && viaTab.avatar !== account_avatar_url) account_avatar_url = viaTab.avatar;
      }
    }
    if (account_name || account_avatar_url) {
      if (ws && ws.readyState === WebSocket.OPEN && backendAccountRegistered) {
        console.log('[FB Engine] 🙋 Gửi REGISTER_ACCOUNT kèm profile operator:', { name: account_name, has_avatar: Boolean(account_avatar_url) });
        sendToBackend('REGISTER_ACCOUNT', { account_id: key, fb_dtsg: fb_dtsg || '', pending_key: null, name: account_name || null, avatar_url: account_avatar_url || null });
        ownProfileSendPending = false;
      } else {
        // Backend chưa nhận đăng ký lần đầu - vòng cookie-check sẽ gửi lại.
        ownProfileSendPending = true;
      }
    }
  } catch (_) {
    ownProfileFetchedFor.delete(key);
  }
}

// Nhan ten + avatar operator tu content script trong tab profile (tab co
// marker crm_own_profile=1). Content script doc DOM sau hydration - tin cay
// hon bat ky luc SW con song hay vua du danh thuc.
// Hang doi profile Page cho WS san sang (mẫu ownProfileSendPending).
let pendingPageProfileQueue = [];
const linkImageFetchedFor = new Set();
const pageProfileFetchedFor = new Set();
function flushPendingPageProfiles() {
  if (!pendingPageProfileQueue.length) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const batch = pendingPageProfileQueue.splice(0, pendingPageProfileQueue.length);
  for (const item of batch) {
    console.log('[FB Engine] 📄 Gui UPDATE_PAGE_PROFILE:', { page_id: item.pageId, name: item.data && item.data.name });
    sendToBackend('UPDATE_PAGE_PROFILE', {
      page_id: item.pageId,
      name: (item.data && item.data.name) || null,
      avatar_url: (item.data && item.data.avatar) || null
    });
  }
}
// Tab phu (profile/link-image) phai nam TRONG cua so Messenger ca nhan -
// tao ngoai windowId khi moi cua so dang an/parked thi Chrome sinh mot cua
// so rieng nho (133x38) o goc - chinh la "2 cai gi do" user thay.
//
// Theo doi tab marker bang id (khong dua vao URL): Facebook redirect
// profile.php?id=X&crm_page_profile=X sang URL vanity cua Page lam mat
// marker, content script khong con biet de gui ket qua -> tab mo coi nam lai
// vinh vien. TTL 90s: qua han ma chua co ket qua la dong tab (ke ca khi URL
// da mat marker).
const markerTabIds = new Map(); // tabId -> { openedAt, pageId }
const MARKER_TAB_TTL_MS = 90 * 1000;

function trackMarkerTab(tabId, pageId) {
  if (tabId == null) return;
  markerTabIds.set(Number(tabId), { openedAt: Date.now(), pageId: String(pageId || '') });
}
function untrackMarkerTab(tabId) {
  if (tabId == null) return;
  markerTabIds.delete(Number(tabId));
}

async function openMarkerTabInMessengerWindow(url) {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const target = wins.find((w) => (w.tabs || []).some((t) => /facebook\.com\/(messages|business\.facebook)/.test(t.url || '')));
    return await chrome.tabs.create({ url, active: false, pinned: true, windowId: target ? target.id : undefined });
  } catch (_) {
    return null;
  }
}
// Quet don tab marker mo coi (mat ket noi SW luc content script gui ket qua,
// hoac redirect lam handler khong chay) - goi khi SW thuc day va truoc khi
// mo tab marker moi.
async function closeOrphanMarkerTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://www.facebook.com/*'] });
    const now = Date.now();
    for (const t of tabs) {
      if (t.id == null) continue;
      const info = markerTabIds.get(t.id);
      const hasMarker = /crm_link_img=|crm_page_profile=|crm_own_profile=/.test(t.url || '');
      const timedOut = Boolean(info) && now - info.openedAt >= MARKER_TAB_TTL_MS;
      if (hasMarker || timedOut) {
        markerTabIds.delete(t.id);
        try { await chrome.tabs.remove(t.id); } catch (_) {}
      }
    }
  } catch (_) {}
}
async function fetchPageProfileViaTab(pageId) {
  try {
    const pid = String(pageId);
    await closeOrphanMarkerTabs();
    // Khong mo them tab neu da co tab profile cung page con dang mo (ke ca
    // tab cu da bi redirect mat marker) - tranh don dong tab trung lap.
    const existing = await chrome.tabs.query({ url: ['*://www.facebook.com/*'] });
    const dup = existing.find((t) => {
      const u = String(t.url || '');
      return u.includes('profile.php') && u.includes('id=' + pid)
        && !u.includes('crm_page_profile=')
        && t.pinned && !t.active;
    });
    if (dup && dup.id != null) {
      trackMarkerTab(dup.id, pid);
      return;
    }
    const created = await openMarkerTabInMessengerWindow('https://www.facebook.com/profile.php?id=' + encodeURIComponent(pid) + '&crm_page_profile=' + encodeURIComponent(pid));
    if (created?.id != null) trackMarkerTab(created.id, pid);
  } catch (_) {}
}

let isPageDiscoveryRunning = false;
let lastPageDiscoveryAt = 0;

async function triggerPageDiscovery(accountId, force = false) {
  if (!accountId) return;
  const now = Date.now();
  if (!force && now - lastPageDiscoveryAt < 60000) {
    console.log('[FB Engine] ⏱️ Bỏ qua auto-discovery vì vừa quét trong vòng 60s');
    return;
  }
  if (isPageDiscoveryRunning) {
    console.log('[FB Engine] ⏳ Quá trình discovery đang chạy, bỏ qua request trùng');
    return;
  }
  isPageDiscoveryRunning = true;
  lastPageDiscoveryAt = now;
  try {
    console.log('[FB Engine] 🔍 Bắt đầu quét danh sách Fanpage cho account:', accountId);
    const discovery = self.FbPageDiscovery || (typeof require !== 'undefined' ? require('./pageDiscovery') : null);
    if (!discovery || typeof discovery.discoverPages !== 'function') {
      console.warn('[FB Engine] Không tìm thấy helper FbPageDiscovery.discoverPages');
      return;
    }
    const pages = await discovery.discoverPages(accountId);
    console.log(`[FB Engine] 📄 Đã phát hiện ${pages.length} Fanpage cho account ${accountId}`);
    sendToBackend('ACCOUNT_PAGES_DISCOVERED', {
      account_id: String(accountId),
      pages: pages
    });
  } catch (err) {
    console.warn('[FB Engine] Lỗi khi quét Fanpage:', err?.message || err);
  } finally {
    isPageDiscoveryRunning = false;
  }
}

closeOrphanMarkerTabs();
chrome.runtime.onMessage.addListener((msg, sender) => {
  try {
    if (msg && msg.type === 'CRM_READ_RECEIPT' && msg.thread_id && msg.watermark_ms > 0) {
      // Read receipt MQTT (deltaReadReceipt) - 'Đã xem' chuẩn của Facebook.
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendToBackend('THREAD_SEEN', {
          thread_id: String(msg.thread_id),
          account_id: user_id || null,
          watermark_ms: Number(msg.watermark_ms) || 0,
          actor: msg.actor || '',
          alt: '',
          bubble_text: '',
          source: 'mqtt_read_receipt',
        });
      }
      return;
    }
    if (msg && msg.type === 'CRM_THREAD_SEEN' && msg.thread_id) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendToBackend('THREAD_SEEN', {
          thread_id: String(msg.thread_id),
          account_id: user_id || null,
          alt: msg.alt || '',
          bubble_text: msg.bubble_text || '',
        });
      }
      return;
    }
    if (msg && msg.type === 'CRM_LINK_IMAGE' && msg.hash && /^[0-9a-f]{40}$/.test(String(msg.hash))) {
      if (msg.image && /^https?:\/\//.test(String(msg.image)) && ws && ws.readyState === WebSocket.OPEN) {
        sendToBackend('UPDATE_LINK_PREVIEW_IMAGE', { url_hash: msg.hash, image_url: msg.image });
      }
      if (sender && sender.tab && sender.tab.id != null) {
        untrackMarkerTab(sender.tab.id);
        try { chrome.tabs.remove(sender.tab.id).catch(() => {}); } catch (_) {}
      }
      return;
    }
    if (msg && msg.type === 'CRM_PAGE_PROFILE' && msg.pageId && /^\d+$/.test(String(msg.pageId))) {
      pendingPageProfileQueue.push({ pageId: String(msg.pageId), data: msg.data || {} });
      flushPendingPageProfiles();
      if (sender && sender.tab && sender.tab.id != null) {
        untrackMarkerTab(sender.tab.id);
        try { chrome.tabs.remove(sender.tab.id).catch(() => {}); } catch (_) {}
      }
      return;
    }
    if (!msg || msg.type !== 'CRM_OPERATOR_PROFILE' || !sender || !sender.tab || sender.tab.id == null) return;
    const data = msg.data || {};
    let changed = false;
    if (data.name && data.name !== account_name) { account_name = data.name; changed = true; }
    if (data.avatar && /^https?:\/\//.test(data.avatar) && data.avatar !== account_avatar_url) { account_avatar_url = data.avatar; changed = true; }
    untrackMarkerTab(sender.tab.id);
    try { chrome.tabs.remove(sender.tab.id).catch(() => {}); } catch (_) {}
    if (changed && user_id) {
      if (ws && ws.readyState === WebSocket.OPEN && backendAccountRegistered) {
        console.log('[FB Engine] 🙋 Gửi REGISTER_ACCOUNT kèm profile operator (từ tab):', { name: account_name, has_avatar: Boolean(account_avatar_url) });
        sendToBackend('REGISTER_ACCOUNT', { account_id: user_id, fb_dtsg: fb_dtsg || '', pending_key: null, name: account_name || null, avatar_url: account_avatar_url || null });
        ownProfileSendPending = false;
      } else {
        ownProfileSendPending = true;
      }
    }
  } catch (_) {}
});

async function checkFacebookCookiesAndRegister() {
  try {
    if (!chrome?.cookies) return;
    const cookie = await chrome.cookies.get({ url: 'https://www.facebook.com', name: 'c_user' });
    if (cookie && cookie.value) {
      // Persist immediately: waiting for content.js lets Facebook redirects or
      // a browser close leave the next launch at the one-tap Continue screen.
      await persistFacebookSessionCookies();
      const newUserId = String(cookie.value).trim();
      if (newUserId && newUserId !== '0' && /^\d+$/.test(newUserId)) {
        const hadUser = Boolean(user_id);
        const userChanged = newUserId !== user_id;
        user_id = newUserId;
        // Ten + avatar that cua operator (thay vi "FB Account (<id>)"): lay tu
        // profile.php?id=<id> khi Chrome da dang nhap, roi gui lai
        // REGISTER_ACCOUNT de server COALESCE dien vao accounts.
        if (!account_name || !account_avatar_url) {
          fetchAndApplyOwnFbProfile(newUserId);
        }
        enforceSingleMessengerTabThrottled(user_id).then(async (tab) => {
          if (!tab?.id) return;
          await registerTab(FbCrmMessengerTabRoles.roleKey(user_id, 'chat'), tab.id);
          await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(user_id), tab.id);
        }).catch(() => {});
        if (!pending_key && chrome?.storage?.local) {
          const stored = await chrome.storage.local.get(['crm_pending_key']);
          pending_key = stored?.crm_pending_key || null;
        }
        flushPendingPageProfiles();
        if (ownProfileSendPending && backendAccountRegistered && ws && ws.readyState === WebSocket.OPEN) {
          ownProfileSendPending = false;
          console.log('[FB Engine] 🙋 Gửi lại REGISTER_ACCOUNT kèm profile operator (delayed):', { name: account_name });
          sendToBackend('REGISTER_ACCOUNT', { account_id: user_id, fb_dtsg: fb_dtsg || '', pending_key: null, name: account_name || null, avatar_url: account_avatar_url || null });
        }
        if (!hadUser || userChanged || !backendAccountRegistered) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('[FB Engine] 📤 Gửi REGISTER_ACCOUNT (từ cookie check):', { account_id: user_id, pending_key });
            sendToBackend('REGISTER_ACCOUNT', { account_id: user_id, fb_dtsg: fb_dtsg || '', pending_key, name: account_name || null, avatar_url: account_avatar_url || null });
          } else {
            connectWebSocket();
          }
        }
      }
    }
  } catch (err) {
    console.warn('[FB Engine] Cookie check error:', err);
  }
}

if (chrome?.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    if (changeInfo?.cookie?.name === 'c_user' && !changeInfo.removed && changeInfo.cookie.value) {
      console.log('[FB Engine] 🍪 c_user cookie changed/set:', changeInfo.cookie.value);
      checkFacebookCookiesAndRegister();
    }
  });
}

// xs may be written after c_user. Catch that second write too so both login
// cookies are durable even when the setup page redirects immediately.
if (chrome?.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    if (changeInfo?.cookie?.name === 'xs' && !changeInfo.removed && changeInfo.cookie.value) {
      persistFacebookSessionCookies().catch(() => {});
    }
  });
}

setInterval(checkFacebookCookiesAndRegister, 2000);

const realtimeObserverHeartbeats = new Map();
function startRealtimeObserverHeartbeat(accountId) {
  const key = String(accountId || '');
  if (!key) return;
  const previous = realtimeObserverHeartbeats.get(key);
  if (previous) clearInterval(previous);
  const timer = setInterval(async () => {
    try {
      const tab = await ensureRoleMessengerTab(key, 'interaction');
      if (tab?.id) await ensureRealtimeObserver(tab.id);
    } catch (error) {
      console.warn('[FB Engine] Realtime observer heartbeat failed:', error?.message || error);
    }
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  realtimeObserverHeartbeats.set(key, timer);
}
async function ensureRealtimeObserver(tabId) {
  if (!tabId) return false;
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'FB_CRM_HEALTH_CHECK' })
    .then((result) => Boolean(result?.success))
    .catch(() => false);
  if (alive) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['textFilter.js', 'callDirection.js', 'sidebarActivityObserver.js', 'content.js']
    });
    console.log(`[FB Engine] Restored realtime observer in tab ${tabId}`);
    return true;
  } catch (error) {
    console.warn('[FB Engine] Unable to restore realtime observer:', error.message);
    return false;
  }
}

async function detectAndReportOpenPageTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://business.facebook.com/*', '*://*.facebook.com/*'] });
    for (const tab of tabs || []) {
      const url = String(tab.url || '');
      const isBiz = url.includes('business.facebook.com') || url.includes('asset_id=') || url.includes('mailbox_id=');
      if (!isBiz) continue;

      const pId = url.match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1];
      if (!pId) continue;

      // (Phase 0 debug) Gửi CẶP param asset_id/mailbox_id tách riêng (không
      // first-match) để server log - kênh 2 truy vết ID thật vs mailbox.
      const assetParam = url.match(/[?&]asset_id=(\d+)/)?.[1] || null;
      const mailboxParam = url.match(/[?&]mailbox_id=(\d+)/)?.[1] || null;
      if (assetParam || mailboxParam) {
        sendToBackend('PAGE_URL_DEBUG', {
          account_id: user_id,
          asset_id: assetParam,
          mailbox_id: mailboxParam,
          url: url.slice(0, 300),
          title: tab?.title || null
        });
      }

      let detectedName = null;
      if (tab.id) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (pageId) => {
              const ext = window.FbPageNameExtractor;
              if (ext && typeof ext.detectPageName === 'function') {
                return ext.detectPageName({ document, pageId, title: document.title });
              }
              return null;
            },
            args: [pId]
          });
          detectedName = results?.[0]?.result || null;
        } catch (_) {}
      }

      if (!detectedName && self.FbPageNameExtractor && tab.title) {
        detectedName = self.FbPageNameExtractor.detectPageName({ title: tab.title, pageId: pId });
      }

      console.log(`[FB Engine] 🏷️ Quét tab Page ${pId}: name="${detectedName || 'null'}" (tab=${tab.id})`);
      sendToBackend('PAGE_EXTENSION_READY', {
        account_id: user_id,
        page_id: pId,
        page_name: detectedName || null
      });
      if (detectedName) {
        sendToBackend('PAGE_NAME_DETECTED', {
          account_id: user_id,
          page_id: pId,
          page_name: detectedName
        });
      }
    }
  } catch (err) {
    console.warn('[FB Engine] detectAndReportOpenPageTabs error:', err?.message || err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.title) {
    const url = String(tab?.url || '');
    if (url.includes('business.facebook.com') || url.includes('asset_id=') || url.includes('mailbox_id=')) {
      // (Phase 0 debug) Kênh 2: log cặp asset_id/mailbox_id riêng biệt mỗi
      // khi tab Business Suite load xong (B.S. hay tự redirect URL).
      const assetParam = url.match(/[?&]asset_id=(\d+)/)?.[1] || null;
      const mailboxParam = url.match(/[?&]mailbox_id=(\d+)/)?.[1] || null;
      if (assetParam || mailboxParam) {
        sendToBackend('PAGE_URL_DEBUG', {
          account_id: user_id,
          asset_id: assetParam,
          mailbox_id: mailboxParam,
          url: url.slice(0, 300),
          title: tab?.title || null
        });
      }
      const pId = url.match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1];
      if (pId && tabId) {
        chrome.scripting.executeScript({
          target: { tabId },
          func: (pageId) => {
            const ext = window.FbPageNameExtractor;
            if (ext && typeof ext.detectPageName === 'function') {
              return ext.detectPageName({ document, pageId, title: document.title });
            }
            return null;
          },
          args: [pId]
        }).then((results) => {
          const name = results?.[0]?.result;
          if (name) {
            console.log(`[FB Engine] 🏷️ Tab ${tabId} cập nhật -> Page ${pId}: "${name}"`);
            sendToBackend('PAGE_NAME_DETECTED', {
              account_id: user_id,
              page_id: pId,
              page_name: name
            });
          }
        }).catch(() => {});
      }
    }
  }
});

let wsConnectingTimer = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(wsConnectingTimer);
  const targetWsUrl = WS_URLS[currentWsIndex % WS_URLS.length];
  console.log('[FB Engine] Đang kết nối WebSocket Backend:', targetWsUrl);

  let socket = null;
  try {
    socket = new WebSocket(targetWsUrl);
    ws = socket;
  } catch (e) {
    console.error('[FB Engine] Không thể tạo WebSocket:', e.message);
    currentWsIndex++;
    scheduleReconnect();
    return;
  }

  wsConnectingTimer = setTimeout(() => {
    if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
      console.warn('[FB Engine] ⚠️ WebSocket CONNECTING timeout (5s). Đóng socket treo & kết nối lại...');
      try { socket.close(); } catch (_) {}
      ws = null;
      currentWsIndex++;
      scheduleReconnect();
    }
  }, 5000);

  socket.onopen = async () => {
    if (ws !== socket) {
      try { socket.close(1000, 'SUPERSEDED_CONNECTION'); } catch (_) {}
      return;
    }
    clearTimeout(wsConnectingTimer);
    wsConnectingTimer = null;
    backendAccountRegistered = false;
    console.log('[FB Engine] ✅ WebSocket Backend đã kết nối thành công.');
    console.log('[FB Engine] 🔍 WS readyState:', ws.readyState, '(1=OPEN)');
    console.log('[FB Engine] 🔍 fb_dtsg:', fb_dtsg ? 'có' : 'null', '| user_id:', user_id, '| pending_key:', pending_key);
    reconnectDelay = 3000; // reset delay
    if (user_id) {
      console.log('[FB Engine] 📤 Gửi REGISTER_ACCOUNT (tại onopen):', { account_id: user_id, pending_key });
      sendToBackend('REGISTER_ACCOUNT', { account_id: user_id, fb_dtsg: fb_dtsg || '', pending_key, name: account_name || null, avatar_url: account_avatar_url || null });
    } else {
      await checkFacebookCookiesAndRegister();
    }
    detectAndReportOpenPageTabs().catch(() => {});
  };

  socket.onmessage = async (event) => {
    if (ws !== socket) return;
    try {
      const message = JSON.parse(event.data);
      console.log('[FB Engine] 📩 Nhận từ Backend:', message.type, '| raw:', event.data.substring(0, 300));

      switch (message.type) {
        case 'COMMAND_PROBE':
          sendToBackend('COMMAND_PROBE_ACK', { probe_id: message.data?.probe_id || null, at: Date.now() });
          break;
        case 'RELOAD_EXTENSION': {
          console.warn('[FB Engine] Backend requested worker recovery:', message.data || {});
          try { ws?.close(1012, 'WORKER_RECOVERY'); } catch (_) {}
          setTimeout(() => chrome.runtime.reload(), 50);
          break;
        }
        case 'BACKEND_OUTBOX_ACK': {
          const ackId = String(message.data?.outbox_id || '');
          const headId = String(backendOutbox[0]?.outbox_id || '');
          if (ackId && ackId === headId) {
            clearTimeout(backendOutboxAckTimer);
            backendOutbox.shift();
            await persistBackendOutbox();
            backendOutboxFlushInFlight = false;
            await flushBackendOutbox();
          }
          break;
        }
        case 'FETCH_LINK_IMAGE': {
          // Server nhờ đọc og:image của link facebook share trong Chrome đã
          // đăng nhập (fetch server-side bị chặn og cho link ảnh). Tab nền
          // tự đóng sau khi content script gửi CRM_LINK_IMAGE.
          try {
            const payload = message.data || {};
            const hash = String(payload.url_hash || '');
            const linkUrl = String(payload.url || '');
            if (!/^[0-9a-f]{40}$/.test(hash) || !/^https?:\/\//i.test(linkUrl)) break;
            if (linkImageFetchedFor.has(hash)) break;
            linkImageFetchedFor.add(hash);
            // Gửi cho content script trong tab Messenger có sẵn (fetch
            // same-origin trong đó) — KHÔNG mở tab/window mới nữa.
            const msgTabsL = await chrome.tabs.query({ url: ['*://www.facebook.com/messages/*', '*://web.facebook.com/messages/*'] });
            const liveTabL = (msgTabsL || []).find((t) => t.id != null);
            if (liveTabL) {
              chrome.tabs.sendMessage(liveTabL.id, { type: 'CRM_FETCH_LINK_PREVIEW', url: linkUrl, hash }).catch(() => {});
            }
          } catch (_) {}
          break;
        }
        case 'FETCH_PAGE_PROFILES': {
          // Server giao viec lay profile (ten + avatar) cho cac Page con ten
          // generic / chua co avatar. Mo tab profile cho tung Page; content
          // script doc xong se gui CRM_PAGE_PROFILE ve (queue + flush).
          try {
            const ids = (message.data && message.data.page_ids) || [];
            for (const pid of ids) {
              const idStr = String(pid);
              if (/^\d+$/.test(idStr) && !pageProfileFetchedFor.has(idStr)) {
                pageProfileFetchedFor.add(idStr);
                fetchPageProfileViaTab(idStr);
              }
            }
          } catch (_) {}
          break;
        }
        case 'REGISTER_ACCOUNT_ACK': {
          const ackAccountId = String(message.data?.account_id || '');
          if (user_id && ackAccountId && ackAccountId !== String(user_id)) {
            console.warn('[FB Engine] Ignore stale REGISTER_ACCOUNT_ACK:', ackAccountId, 'expected:', user_id);
            backendAccountRegistered = false;
            break;
          }
          backendAccountRegistered = true;
          console.log('[FB Engine] ✅ Backend ACK đăng ký tài khoản thành công:', message.data);
          const setupPendingKey = message.data?.pending_key || pending_key;
          pending_key = null;
          try {
            if (chrome?.storage?.local) {
              chrome.storage.local.remove(['crm_pending_key']);
            }
            chrome.tabs.query({ url: ['*://*.facebook.com/*', '*://*.messenger.com/*'] }, (tabs) => {
              tabs.forEach(tab => {
                if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_PENDING_KEY' }).catch(() => {});
              });
            });
          } catch (e) {}
          if (setupPendingKey && user_id) waitForPendingSetupCompletion(user_id);
          await flushBackendOutbox();
          if (!setupPendingKey && user_id) {
            // Establish the Messenger interaction surface immediately after
            // registration. Receiving realtime messages must not depend on the
            // operator sending the first outbound message.
            ensureRoleMessengerTab(user_id, 'interaction').then(async (interactionTab) => {
              await ensureRealtimeObserver(interactionTab?.id);
              startRealtimeObserverHeartbeat(user_id);
              // The socket can open before REGISTER_ACCOUNT is accepted.
              // Replay customer messages only after the backend confirms the
              // account so cold-start text/image/video events are not lost.
              await flushBackendOutbox();
            }).catch((error) => {
              console.warn('[FB Engine] Không thể khởi tạo tab nhận realtime:', error.message);
            });
          }
          if (user_id) {
            triggerPageDiscovery(user_id, false);
          }
          break;
        }
        case 'REQ_REFRESH_PAGES': {
          console.log('[FB Engine] 🔄 Nhận lệnh REQ_REFRESH_PAGES từ backend cho account:', user_id);
          if (user_id) {
            triggerPageDiscovery(user_id, true);
          }
          break;
        }
        case 'PREPARE_CHAT_THREAD': {
          // Best-effort pre-navigation must never enter the authoritative send
          // chain. A Messenger SPA navigation can remain unresolved while its
          // React tree remounts; when queued here it blocks every real
          // text/image/video command behind it. handleSendMessage already
          // validates and opens the exact destination before dispatch, so the
          // safe behavior is to skip this optional optimization.
          console.log('[SEND_PREWARM] Skipped; the send command owns navigation.');
          break;
        }
        case 'SEND_MESSAGE':
          // Cold Messenger navigation can take longer than 24 seconds. Reloading
          // the MV3 worker here destroys the command channel and the send.
          await handleSendMessage(message.data);
          break;
        case 'SEND_QUEUED_MESSAGE':
          await handleSendQueuedMessage(message.data);
          break;
        case 'SYNC_PAGE_SIDEBAR': {
          const pageId = String(message.data?.page_id || '');
          const tabs = await chrome.tabs.query({ url: ['*://business.facebook.com/*'] });
          for (const tab of tabs) {
            if (!tab?.id || (pageId && !String(tab.url || '').includes(`asset_id=${pageId}`))) continue;
            chrome.tabs.sendMessage(tab.id, {
              type: 'SCAN_PAGE_SIDEBAR',
              data: {
                page_id: pageId,
                deep: Boolean(message.data?.deep),
                max_rounds: Number(message.data?.max_rounds || 35)
              }
            }).catch(() => {});
          }
          break;
        }
        case 'SYNC_THREADS':
          console.log("[FB Engine] Sync threads sidebar:", message.data);
          await handleSync100Threads(message.data);
          break;
        case 'CANCEL_THREADS_SYNC':
          discoverySyncCancelledAccounts.add(String(message.data?.account_id || user_id || ''));
          console.log('[FB Engine] [DISCOVERY] Cancel requested for account:', message.data?.account_id || user_id);
          break;
        case 'SET_SIDEBAR_SYNC_WINDOW':
          if (message.data?.enabled === false) {
            const syncAccountKey = String(message.data?.account_id || user_id || '');
            discoverySyncCancelledAccounts.add(syncAccountKey);
            pendingDiscoveryScans.delete(syncAccountKey);
            await closeSidebarSyncTabs(syncAccountKey);
          }
          break;
        case 'SYNC_THREAD_MESSAGES':
          console.log("[FB Engine] 🔄 Đang sync lịch sử tin nhắn thread:", message.data);
          {
            const isUserClick = ['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport'].includes(String(message.data?.reason || ''));
            if (isUserClick) {
              if (message.data?.page_id) {
                const pid = String(message.data.page_id);
                const tid = String(message.data?.thread_id || '');
                pageNavigationLockThreadId.set(pid, tid);
                pageNavigationLockUntil.set(pid, Date.now() + 30000);
                console.log(`[FB Engine] [PAGE_NAV_LOCK] Business Suite tab for page=${pid} locked to thread=${tid}`);
              } else {
                // Lock the personal history tab to the thread the user just clicked.
                // Background sync for any other personal thread is now blocked.
                userNavigationLockThreadId = String(message.data?.thread_id || '');
                if (bulkHistorySyncInFlight) {
                  bulkHistorySyncAbortRequested = true;
                  console.log('[FB Engine] [BULK_HISTORY] Abort requested by user-click navigation.');
                }
                console.log('[FB Engine] [NAV_LOCK] History tab locked to thread:', userNavigationLockThreadId);
              }
            }
            const laneKey = message.data?.page_id
              ? `page:${message.data.page_id}`
              : `${message.data?.account_id || user_id}:history`;
            await runPersonalHistorySerialized(
              laneKey,
              () => runPersonalHistoryWithDeadline(laneKey, message.data, () => handleSyncThreadMessages(message.data)),
              isUserClick
            );
          }
          break;
        case 'PAGE_BATCH_ACK': {
          console.log('[FB Engine] 📩 Nhận PAGE_BATCH_ACK từ backend:', message.data);
          chrome.tabs.query({ url: ['*://business.facebook.com/*', '*://*.facebook.com/*'] }, (tabs) => {
            tabs.forEach(tab => {
              if (tab?.id) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'PAGE_BATCH_ACK',
                  data: message.data
                }).catch(() => {});
              }
            });
          });
          break;
        }
        case 'BULK_HISTORY_SYNC':
          console.log('[FB Engine] Starting bulk history sync:', message.data);
          await handleBulkHistorySync(message.data);
          break;
        case 'TRIGGER_MESSENGER_CALL':
          console.log("[FB Engine] 📞 Nhận lệnh kích hoạt cuộc gọi Messenger:", message.data);
          await handleTriggerMessengerCall(message.data);
          break;
        case 'ANSWER_INCOMING_CALL':
          await handleAnswerIncomingCall(message.data || {});
          break;
        case 'MESSAGE_REQUEST_ACTION':
          await handleMessageRequestAction(message.data || {});
          break;
        default:
          console.log('[FB Engine] Không có handler cho message type:', message.type);
          break;
      }
    } catch (err) {
      console.error('[FB Engine] Lỗi xử lý WS message:', err);
    }
  };

  socket.onerror = (err) => {
    if (ws !== socket) return;
    clearTimeout(wsConnectingTimer);
    wsConnectingTimer = null;
    console.warn('[FB Engine] ⚠️ WebSocket lỗi kết nối. Đang đổi sang địa chỉ WebSocket dự phòng...');
    currentWsIndex++;
  };

  socket.onclose = (event) => {
    // A delayed close from an older connection must never clear a newer
    // socket or schedule another reconnect over it.
    if (ws !== socket) return;
    clearTimeout(wsConnectingTimer);
    wsConnectingTimer = null;
    console.log(`[FB Engine] WebSocket đóng (code=${event.code}). Thử lại sau ${reconnectDelay / 1000}s...`);
    ws = null;
    backendAccountRegistered = false;
    scheduleReconnect();
  };
}

// Facebook can issue c_user/xs (the actual login-session cookies) as
// session-only (no expirationDate) for browsers it scores as automated -
// Chrome deletes session cookies on every full browser close, which is why a
// Chrome Portable profile that logged in successfully still shows a login
// screen on the next launch even though non-session cookies like datr/fr
// (confirmed via direct inspection of the Cookies sqlite db) survive fine.
// The "cookies" permission lets the extension read the cookie right after a
// real login and rewrite it locally with a long expirationDate - Chrome then
// treats it as persistent for future launches regardless of how Facebook
// originally flagged it, since this is a local browser-side rewrite, not
// something Facebook needs to agree to.
const FB_SESSION_COOKIE_NAMES = ['c_user', 'xs'];
const FB_COOKIE_URL = 'https://www.facebook.com/';

async function persistFacebookSessionCookies() {
  if (!chrome?.cookies) return;
  for (const name of FB_SESSION_COOKIE_NAMES) {
    try {
      const cookie = await chrome.cookies.get({ url: FB_COOKIE_URL, name });
      if (!cookie || !cookie.session) continue; // missing, or already persistent - nothing to do
      const oneYearFromNowSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
      await chrome.cookies.set({
        url: FB_COOKIE_URL,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: oneYearFromNowSeconds
      });
      console.log(`[FB Engine] 🍪 Đã ép cookie "${name}" từ session-only thành bền (sống sót qua restart).`);
    } catch (err) {
      console.warn(`[FB Engine] Không thể ép cookie "${name}" thành bền:`, err.message);
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
}

function sendToBackend(type, data) {
  if (QUEUED_BACKEND_TYPES.has(type) && !backendAccountRegistered) {
    enqueueBackendPayload(type, data);
    connectWebSocket();
    checkFacebookCookiesAndRegister().catch(() => {});
    return true;
  }
  console.log('[FB Engine] 🔍 sendToBackend:', type, '| WS readyState:', ws?.readyState, '| WS null?:', ws === null);
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({ type, data });
    console.log('[FB Engine] 📤 Gửi payload:', payload.substring(0, 200));
    try {
      ws.send(payload);
      console.log('[FB Engine] ✅ Đã gửi thành công:', type);
      return true;
    } catch (error) {
      if (QUEUED_BACKEND_TYPES.has(type)) enqueueBackendPayload(type, data);
      connectWebSocket();
      return QUEUED_BACKEND_TYPES.has(type);
    }
  } else {
    if (QUEUED_BACKEND_TYPES.has(type)) {
      enqueueBackendPayload(type, data);
      console.warn('[FB Engine] WebSocket chưa sẵn sàng; đã xếp hàng realtime:', type);
      connectWebSocket();
      checkFacebookCookiesAndRegister().catch(() => {});
      return true;
    }
    console.error('[FB Engine] ❌ Chưa kết nối backend, KHÔNG GỬI ĐƯỢC:', type, '| WS readyState:', ws?.readyState);
    return false;
  }
}

// Event-driven sidebar fallback. It runs beside the existing scheduled
// SYNC_THREADS pipeline and never navigates or scrolls a Messenger tab.
// Fingerprint dedupe keeps React mutation bursts to one lightweight scrape.
const sidebarActivityHints = new Map();

async function isRealtimeSidebarTab(tab) {
  if (!tab?.id || !user_id) return false;
  await loadTabRegistry();
  let role = FbCrmMessengerTabRoles.roleForTab([...tabRegistry.entries()], user_id, tab.id);
  const url = String(tab.url || tab.pendingUrl || '');
  if (!role && /facebook\.com\/messages|messenger\.com/i.test(url)) {
    role = 'chat';
    await registerTab(FbCrmMessengerTabRoles.roleKey(user_id, 'chat'), tab.id);
    await registerTab(FbCrmMessengerTabRoles.roleKey(user_id, 'interaction'), tab.id);
    await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(user_id), tab.id);
  }
  return FbCrmMessengerTabRoles.canForwardRealtime(role);
}

function scheduleSidebarActivitySync(tab, fingerprint, observedThreads = []) {
  if (!tab?.id || !fingerprint) return false;
  const key = String(tab.id);
  const previous = sidebarActivityHints.get(key) || {};
  if (previous.fingerprint === fingerprint) return false;
  if (previous.timer) clearTimeout(previous.timer);
  const state = { ...previous, fingerprint };
  state.timer = setTimeout(async () => {
    state.timer = null;
    try {
      if (!await isRealtimeSidebarTab(tab)) return;
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeFacebookSidebar
      });
      const parsedThreads = Array.isArray(result?.[0]?.result) ? result[0].result : [];
      // Messenger virtualizes sidebar rows aggressively. If the row that
      // triggered the mutation disappeared before executeScript ran, consume
      // the content-script snapshot captured at mutation time.
      const threads = parsedThreads.length
        ? parsedThreads
        : (Array.isArray(observedThreads) ? observedThreads : []);
      if (!threads.length) return;
      const lightweightThreads = threads.map((thread) => ({
        id: thread.thread_id,
        thread_id: thread.thread_id,
        contact_name: thread.name || thread.contact_name,
        name: thread.name || thread.contact_name,
        last_message: thread.last_message,
        is_unread: thread.is_unread,
        is_like: thread.is_like === true,
        preview_is_outgoing: thread.preview_is_outgoing === true,
        avatar_url: thread.avatar_url || null,
        avatar_base64: null,
        thread_url: thread.thread_url || null,
        is_e2ee: Boolean(thread.is_e2ee),
        source_type: 'personal_messenger',
        inbox_folder: 'INBOX'
      }));
      sendToBackend('SYNC_THREADS_RESULT', {
        account_id: user_id,
        threads: lightweightThreads,
        partial: true,
        sync_status: 'realtime_hint',
        origin: 'sidebar_activity_observer'
      });
    } catch (error) {
      console.warn('[FB Engine] Sidebar activity fallback failed:', error?.message || error);
    }
  }, 180);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  sidebarActivityHints.set(key, state);
  return true;
}

// ── Phục hồi tab Business Suite bị trắng ────────────────────────────────────
// Tab inbox trắng (không render) thì không thao tác/đồng bộ được gì. page_content
// phát PAGE_TAB_BLANK_DETECTED; ở đây mở tab mới cùng page (hoặc dùng tab healthy
// sẵn có) và đóng tab trắng khi tab mới báo PAGE_CONTEXT_READY — hoặc sau 25s
// dự phòng. Giới hạn 3 lần/15 phút + tối thiểu cách nhau 60s để không rơi vào
// vòng lặp tạo tab khi mạng/cookie có vấn đề.
const blankTabRecoveryState = { lastAt: 0, attempts: [], pending: new Map() };

async function handleBlankBizTabPage(data, oldTabId) {
  try {
    const pageId = String(
      data?.page_id
      || String(data?.url || '').match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1]
      || ''
    );
    if (!pageId) {
      console.warn('[FB Engine] Bỏ qua phục hồi tab trắng: không xác định được page_id.');
      return;
    }
    const now = Date.now();
    blankTabRecoveryState.attempts = blankTabRecoveryState.attempts.filter((t) => now - t < 15 * 60 * 1000);
    if (blankTabRecoveryState.attempts.length >= 3) {
      console.warn('[FB Engine] 🏳️ Bỏ qua phục hồi tab trắng: đã thử 3 lần trong 15 phút.');
      return;
    }
    if (now - blankTabRecoveryState.lastAt < 60 * 1000) {
      console.log('[FB Engine] 🏳️ Bỏ qua phục hồi tab trắng: vừa phục hồi cách đây chưa đầy 1 phút.');
      return;
    }
    blankTabRecoveryState.lastAt = now;
    blankTabRecoveryState.attempts.push(now);

    // Đã có tab business khác cho cùng page -> đánh thức nó, bỏ tab trắng
    const bizTabs = await new Promise((resolve) => chrome.tabs.query({ url: '*://business.facebook.com/*' }, (tabs) => resolve(tabs || [])));
    const healthyOther = bizTabs.find((t) => String(t.id) !== String(oldTabId)
      && String(t.url || '').match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1] === pageId);

    let replacementTab = null;
    if (healthyOther?.id) {
      console.log(`[FB Engine] 🏳️ Tab trắng #${oldTabId} (page ${pageId}): đã có tab business #${healthyOther.id} — đánh thức thay vì tạo mới.`);
      replacementTab = healthyOther;
      try { await chrome.tabs.update(healthyOther.id, { active: true }); } catch (_) {}
    } else {
      const inboxUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(pageId)}&mailbox_id=${encodeURIComponent(pageId)}&thread_type=FB_MESSAGE`;
      replacementTab = await chrome.tabs.create({ url: inboxUrl, active: true }).catch(() => null);
      console.log(`[FB Engine] 🏳️ Tab Business Suite trắng (tab #${oldTabId}, page ${pageId}) -> đã mở tab mới #${replacementTab?.id}.`);
    }
    if (!replacementTab?.id || !oldTabId || String(replacementTab.id) === String(oldTabId)) return;

    const closeOldTab = async (reason) => {
      blankTabRecoveryState.pending.delete(String(oldTabId));
      try {
        const t = await chrome.tabs.get(Number(oldTabId)).catch(() => null);
        if (t) {
          await chrome.tabs.remove(Number(oldTabId));
          console.log(`[FB Engine] Đã đóng tab trắng cũ #${oldTabId} (${reason}).`);
        }
      } catch (_) {}
    };
    const timer = setTimeout(() => closeOldTab('fallback 25s'), 25000);
    blankTabRecoveryState.pending.set(String(oldTabId), { newTabId: replacementTab.id, pageId, closeOldTab, timer });
  } catch (err) {
    console.warn('[FB Engine] Lỗi phục hồi tab trắng:', err?.message || err);
  }
}

// Bắt events từ content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[FB Engine] 📥 onMessage received from content:', message.type, JSON.stringify(message).substring(0, 300));

  // Helper to ensure tabRegistry is loaded and auto-register active Messenger tabs
  // allowAnyFbTab=true: bat ky tab facebook.com nao cung duoc coi la interaction (cho call events)
  async function resolveSenderTabRole(senderTab, allowAnyFbTab, allowIncomingRealtime = false) {
    await loadTabRegistry();
    if (senderTab?.id && manualHistoryTabOwners.has(senderTab.id)) return 'history';
    let senderRole = FbCrmMessengerTabRoles.roleForTab([...tabRegistry.entries()], user_id, senderTab?.id);
    if (!senderRole && senderTab?.id) {
      var tabUrl = senderTab.url || senderTab.pendingUrl || '';
      var isMessagesUrl = /(^|\.)(facebook\.com\/messages|messenger\.com)/i.test(tabUrl);
      // Call popup co the xuat hien tren bat ky tab facebook.com nao
      var isAnyFbUrl = !!allowAnyFbTab && /(^|\.)facebook\.com/i.test(tabUrl);
      if (isMessagesUrl || isAnyFbUrl || !user_id) {
        if (user_id) {
          const interactionKey = FbCrmMessengerTabRoles.roleKey(user_id, 'chat');
          await registerTab(interactionKey, senderTab.id);
          await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(user_id), senderTab.id);
        }
        senderRole = 'chat';
      }
    }
    return senderRole;
  }

  if (message.type === 'SIDEBAR_ACTIVITY_HINT') {
    scheduleSidebarActivitySync(
      sender?.tab,
      String(message.data?.fingerprint || ''),
      Array.isArray(message.data?.threads) ? message.data.threads : []
    );
    return true;
  }

  if (message.type === 'FB_TOKENS_EXTRACTED') {
    const newUserId = message.data.user_id;
    const newDtsg = message.data.fb_dtsg;
    const incomingPendingKey = message.data.pending_key;
    const incomingAccountName = typeof message.data.name === 'string' ? message.data.name.trim() : '';
    const incomingAccountAvatarUrl = typeof message.data.avatar_url === 'string' ? message.data.avatar_url.trim() : '';
    if (incomingPendingKey && !pending_key) pending_key = incomingPendingKey;

    const hadUser = Boolean(user_id && fb_dtsg);
    const userChanged = newUserId !== user_id;
    const accountNameChanged = Boolean(incomingAccountName && incomingAccountName !== account_name);
    const accountAvatarChanged = Boolean(incomingAccountAvatarUrl && incomingAccountAvatarUrl !== account_avatar_url);
    fb_dtsg = newDtsg;
    user_id = newUserId;
    if (incomingAccountName) account_name = incomingAccountName;
    if (incomingAccountAvatarUrl) account_avatar_url = incomingAccountAvatarUrl;

    console.log('[FB Engine] ✅ Đã lấy tokens cho user:', user_id, '| pending_key:', pending_key);
    persistFacebookSessionCookies().catch(() => {});
    if (ws && ws.readyState === WebSocket.OPEN) {
      const isNewPendingKey = Boolean(incomingPendingKey && incomingPendingKey !== pending_key);
      if (!hadUser || userChanged || !backendAccountRegistered || isNewPendingKey || accountNameChanged || accountAvatarChanged) {
        // Do not flush realtime messages under the previous WebSocket account
        // while this profile is being rebound to a newly detected Facebook user.
        backendAccountRegistered = false;
        console.log('[FB Engine] 📤 Gửi REGISTER_ACCOUNT từ onMessage:', { account_id: user_id, pending_key });
        sendToBackend('REGISTER_ACCOUNT', { account_id: user_id, fb_dtsg, pending_key, name: account_name || null, avatar_url: account_avatar_url || null });
      }
    } else {
      console.log('[FB Engine] ⚠️ WS chưa mở, đang kết nối...');
      connectWebSocket();
    }
  }

  // Forward tin nhắn Facebook đến backend CRM
  if (message.type === 'NEW_MESSAGE_FROM_FB') {
    (async () => {
      const isExplicitIncoming = message.data?.is_outgoing === false || message.data?.is_outgoing === 0;
      const senderRole = await resolveSenderTabRole(sender?.tab, false, isExplicitIncoming);
      const isCallLog = /cu\u1ed9c g\u1ecdi|g\u1ecdi tho\u1ea1i|g\u1ecdi video|missed call|voice call|video call/i.test(String(message.data?.content || ''));
      // History navigation mounts old call rows as if they were newly added
      // DOM nodes. Never let that surface feed the realtime call scanner: the
      // canonical history pass below persists those rows with Facebook IDs.
      const mayForward = isCallLog
        ? FbCrmMessengerTabRoles.canForwardCallRealtime(senderRole)
        : (FbCrmMessengerTabRoles.canForwardRealtime(senderRole)
          || (isExplicitIncoming && FbCrmMessengerTabRoles.canForwardIncomingRealtime?.(senderRole)));
      if (!mayForward) {
        console.log(`[FB Engine] Skip NEW_MESSAGE_FROM_FB from role=${senderRole || 'unregistered'} tab=${sender?.tab?.id || 'unknown'}`);
        return;
      }
      let msgData = message.data;      const isPlainOutgoingDomEcho = Boolean(
        msgData?.is_outgoing
        && String(msgData?.source || '') === 'dom_observer'
        && !msgData?.media_url
        && (!msgData?.media_type || msgData.media_type === 'text')
      );
      if (isPlainOutgoingDomEcho) {
        console.log('[FB Engine] Skip duplicate plain outgoing DOM text; composer/network confirmation owns it.');
        return;
      }
      const messageThreadKey = String(msgData?.thread_id || '').split(':').pop();
      const recentOutgoingCallAt = recentOutgoingCallThreads.get(messageThreadKey) || 0;
      if (isCallLog && Date.now() - recentOutgoingCallAt < 5 * 60 * 1000 && msgData?.is_outgoing) {
        console.log(`[FB Engine] Skip duplicate outgoing DOM call log for thread=${messageThreadKey}`);
        return;
      }
      if (false && isCallLog && Date.now() - recentOutgoingCallAt < 5 * 60 * 1000) {
        msgData = { ...msgData, is_outgoing: true, sender_id: user_id, sender_name: 'Bạn' };
      }
      console.log('[FB Engine] 📨 NEW_MESSAGE_FROM_FB từ content:', JSON.stringify(msgData).substring(0, 300));
      console.log('[FB Engine] 🔍 user_id hiện tại:', user_id);
      // Đính kèm account_id cho backend biết tài khoản nào nhận tin
      sendToBackend('NEW_MESSAGE_RECEIVED', {
        ...msgData,
        account_id: user_id
      });
      console.log(`[FB Engine] 📤 Forward tin nhắn → Backend: "${(msgData.content || '').substring(0, 50)}"`);
    })();
    return true;
  }

  // Temporary diagnostic (spec 040 T020) - relays page_content.js's raw
  // <img> inspection for a text+image message that didn't match as media.
  if (message.type === 'CONTENT_DEBUG') {
    sendToBackend('CONTENT_DEBUG', message.data);
  }

  if (message.type === 'PAGE_SCROLLER_DEBUG') {
    sendToBackend('PAGE_SCROLLER_DEBUG', message.data);
  }

  // Crawler từ chối thu thập vì khung chat đang mở KHÁC thread được yêu cầu.
  // Relay về server để markThreadSyncResult nhả in-flight lock của lane.
  if (message.type === 'PAGE_THREAD_ROUTE_MISMATCH') {
    const msgData = message.data || {};
    console.warn(`[FB Engine] 🚫 PAGE_THREAD_ROUTE_MISMATCH thread=${msgData.thread_id} expected=${msgData.expected_bare_id || 'unknown'} current=${msgData.current_thread_id || 'unknown'}`);
    sendToBackend('THREAD_MESSAGES_SYNCED', {
      account_id: user_id || msgData.account_id,
      thread_id: msgData.thread_id,
      page_id: msgData.page_id || null,
      messages: [],
      reason: 'thread_route_mismatch',
      mode: 'page_sync'
    });
  }

  if (message.type === 'NEW_PAGE_MESSAGE_FROM_DOM') {
    const msgData = message.data;
    console.log('[FB Engine] 📨 NEW_PAGE_MESSAGE_FROM_DOM từ page_content:', JSON.stringify(msgData).substring(0, 300));
    sendToBackend('NEW_MESSAGE_RECEIVED', {
      ...msgData,
      account_id: user_id || msgData.account_id,
      source_type: 'page_messenger',
      telemetry: {
        ...(msgData?.telemetry || {}),
        t_sw: Date.now()
      }
    });
  }

  if (message.type === 'PAGE_TAB_BLANK_DETECTED') {
    handleBlankBizTabPage(message.data, sender?.tab?.id || null);
  }

  if (message.type === 'PAGE_CONTEXT_READY') {
    const msgData = message.data || {};
    if (msgData.page_id) {
      sendToBackend('PAGE_EXTENSION_READY', {
        account_id: user_id || msgData.account_id,
        page_id: String(msgData.page_id),
        page_name: msgData.page_name ? String(msgData.page_name) : null
      });
    }
    // Phục hồi tab trắng: tab thay thế vừa báo sẵn sàng -> đóng tab trắng cũ sớm
    for (const entry of blankTabRecoveryState.pending.values()) {
      if (String(entry.newTabId) === String(sender?.tab?.id || '') && String(entry.pageId) === String(msgData.page_id || '')) {
        try { clearTimeout(entry.timer); } catch (_) {}
        entry.closeOldTab?.('new tab ready');
      }
    }
  }

  if (message.type === 'PAGE_NAME_DETECTED') {
    const msgData = message.data || {};
    if (msgData.page_id && msgData.page_name) {
      console.log(`[FB Engine] 🏷️ PAGE_NAME_DETECTED: page=${msgData.page_id}, name="${msgData.page_name}"`);
      sendToBackend('PAGE_NAME_DETECTED', {
        account_id: user_id || msgData.account_id,
        page_id: String(msgData.page_id),
        page_name: String(msgData.page_name)
      });
      // Lay ten + avatar that cua Page (thay vi "Page <id>"): mo tab profile
      // Page (marker crm_page_profile=<id>), content script doc DOM roi gui
      // CRM_PAGE_PROFILE ve. Moi Page mot lan moi phien SW.
      const pid = String(msgData.page_id);
      if (/^\d+$/.test(pid) && !pageProfileFetchedFor.has(pid)) {
        pageProfileFetchedFor.add(pid);
        fetchPageProfileViaTab(pid);
      }
    }
  }

  if (message.type === 'PAGE_THREAD_MESSAGES_SYNCED_V1') {
    const msgData = message.data || {};
    if (msgData.thread_id) {
      pageBatchSeenAt.set(String(msgData.thread_id), Date.now());
      if (pageBatchSeenAt.size > 500) pageBatchSeenAt.clear();
    }
    sendToBackend('PAGE_THREAD_MESSAGES_SYNCED_V1', {
      ...msgData,
      account_id: user_id || msgData.account_id,
      source_type: 'page_messenger',
      reached_top: Boolean(msgData.reached_top)
    });
  }

  if (message.type === 'PAGE_MESSAGE_MEDIA_RESOLVED') {
    const msgData = message.data;
    console.log('[FB Engine] 🎬 PAGE_MESSAGE_MEDIA_RESOLVED từ page_content:', JSON.stringify(msgData));
    sendToBackend('PAGE_MESSAGE_MEDIA_RESOLVED', {
      ...msgData,
      account_id: user_id || msgData?.account_id,
      source_type: 'page_messenger'
    });
  }

  // Relay Business Suite sidebar threads through the existing backend sync.
  // Server-side source binding remains responsible for separating Page rows.
  if (message.type === 'PAGE_SIDEBAR_THREADS_DISCOVERED') {
    const msgData = message.data || {};
    const pageId = String(msgData.page_id || '');
    const threads = Array.isArray(msgData.threads) ? msgData.threads : [];
    if (!pageId || !threads.length) return false;
    sendToBackend('SYNC_THREADS_RESULT', {
      account_id: user_id || msgData.account_id,
      partial: true,
      source_type: 'page_messenger',
      page_id: pageId,
      threads: threads.map((thread) => ({
        ...thread,
        page_id: thread?.page_id || pageId,
        source_type: 'page_messenger'
      }))
    });
    console.log(`[FB Engine] Relayed ${threads.length} Page sidebar threads for page=${pageId}`);
  }

  if (message.type === 'UPGRADE_MESSAGE_TIMESTAMP') {
    const msgData = message.data;
    sendToBackend('UPGRADE_MESSAGE_TIMESTAMP', {
      ...msgData,
      account_id: user_id || msgData?.account_id
    });
  }

  if (message.type === 'UPDATE_THREAD_METADATA') {
    const msgData = message.data;
    console.log('[FB Engine] 👤 UPDATE_THREAD_METADATA từ page_content:', JSON.stringify(msgData));
    sendToBackend('THREAD_METADATA_UPDATED', {
      ...msgData,
      account_id: user_id || msgData.account_id,
      source_type: 'page_messenger'
    });
  }

  if (message.type === 'INCOMING_CALL_RINGING' || message.type === 'INCOMING_CALL_ENDED') {
    sendToBackend(message.type, { ...(message.data || {}), account_id: user_id, source_tab_id: sender?.tab?.id || null, source_frame_id: Number.isInteger(sender?.frameId) ? sender.frameId : 0 });
  }



  // Lets a content script re-seed its client-side timestamp-anchor map after
  // a restart from the backend's persistent record (feature 014) - fixes
  // messages that are genuinely new to the backend getting stamped with "now"
  // when the content script's in-memory anchors were just wiped by a reload.
  if (message.type === 'GET_THREAD_TIMESTAMPS') {
    const { threadId } = message.data || {};
    fetchThreadTimestamps(threadId).then((timestamps) => sendResponse({ timestamps }));
    return true; // keep the message channel open for the async sendResponse above
  }

  return false;
});

function getBackendHttpBase() {
  try {
    if (ws && ws.url) {
      const u = new URL(ws.url);
      return `http://${u.host}`;
    }
  } catch (e) {}
  return 'http://127.0.0.1:5050';
}

// Never throws and never hangs the caller: resolves to [] on any failure or
// timeout, so a missing/slow backend degrades gracefully instead of blocking
// message capture (FR-003).
async function fetchThreadTimestamps(threadId, timeoutMs = 2000) {
  if (!threadId) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getBackendHttpBase()}/api/threads/${encodeURIComponent(threadId)}/message-timestamps`, { signal: controller.signal });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Tab role registry (personal:<accountId> / page:<pageId> -> tabId) ──────
// The extension serves two independent flows (personal messenger + per-Page
// inbox) from the same Chrome install. Re-discovering "the right tab" by
// query/cookie-matching on every sync is what let a Business Suite tab get
// misidentified as the personal-messenger tab (same login cookie, no other
// personal tab open) and forcibly redirected away from the Page inbox the
// user was actively using. Once a tab is confirmed for a role, remember it
// here instead of re-guessing. Persisted in chrome.storage.session so it
// survives Manifest V3 service worker restarts, which happen often (visible
// as repeated REGISTER_ACCOUNT/SYNC_THREADS churn in the backend logs) and
// would otherwise force the flawed discovery path to run again on every wake.
const TAB_REGISTRY_STORAGE_KEY = 'fb_engine_tab_registry';
let tabRegistry = new Map();
let tabRegistryLoaded = null;

function loadTabRegistry() {
  if (!tabRegistryLoaded) {
    tabRegistryLoaded = new Promise((resolve) => {
      chrome.storage.session.get([TAB_REGISTRY_STORAGE_KEY], (result) => {
        const stored = result?.[TAB_REGISTRY_STORAGE_KEY];
        if (stored && typeof stored === 'object') {
          tabRegistry = new Map(Object.entries(stored));
        }
        resolve();
      });
    });
  }
  return tabRegistryLoaded;
}

function persistTabRegistry() {
  // Returned so callers can await it - the service worker may be suspended
  // immediately after this call returns, and a fire-and-forget write could
  // be lost before it reaches disk.
  return chrome.storage.session.set({ [TAB_REGISTRY_STORAGE_KEY]: Object.fromEntries(tabRegistry) });
}

async function registerTab(role, tabId) {
  if (!tabId) return;
  await loadTabRegistry();
  tabRegistry.set(role, tabId);
  await persistTabRegistry();
}

async function unregisterTab(role) {
  await loadTabRegistry();
  if (tabRegistry.delete(role)) await persistTabRegistry();
}

// Returns the registered tab for a role only if it still exists; evicts a
// stale entry (tab was closed) so the caller falls back to fresh discovery.
async function getRegisteredTab(role) {
  await loadTabRegistry();
  const tabId = tabRegistry.get(role);
  if (!tabId) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    await unregisterTab(role);
    return null;
  }
}

// The operator-controlled one-minute sync window owns only these two costly
// Messenger surfaces. Closing them while idle releases their React/DOM memory;
// interaction, campaign and history tabs are intentionally left untouched.
async function closeSidebarSyncTabs(accountId) {
  const accountKey = String(accountId || user_id || '');
  if (!accountKey) return 0;
  let closed = 0;
  for (const roleName of ['discovery', 'requests']) {
    const role = FbCrmMessengerTabRoles.roleKey(accountKey, roleName);
    const tab = await getRegisteredTab(role);
    await unregisterTab(role);
    if (!tab?.id) continue;
    try {
      await chrome.tabs.remove(tab.id);
      closed += 1;
    } catch (_) {}
  }
  console.log('[FB Engine] [SYNC_WINDOW] Closed sidebar tabs account=' + accountKey + ' count=' + closed);
  return closed;
}

chrome.tabs.onRemoved.addListener((closedTabId) => {
  untrackMarkerTab(closedTabId);
  loadTabRegistry().then(async () => {
    let changed = false;
    for (const [role, tabId] of tabRegistry.entries()) {
      if (tabId === closedTabId) {
        tabRegistry.delete(role);
        changed = true;
      }
    }
    if (changed) await persistTabRegistry();
  });
});

function isBusinessSuiteUrl(url) {
  try {
    return new URL(String(url || '')).hostname === 'business.facebook.com';
  } catch (e) {
    return false;
  }
}

async function assertMessengerRecoveryDialogResolved(tabId) {
  // Never click, remove, or otherwise mutate Facebook's encrypted-history
  // recovery/PIN dialog. Removing React-owned dialog nodes leaves Facebook's
  // overlay mounted in a permanent loading-skeleton state and prevents the
  // operator from entering their PIN. While the dialog is visible, fail the
  // automated send safely and let the operator resolve it in Facebook.
  let state = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
      const recoveryPattern = /kh\u00f4i ph\u1ee5c|restore (?:chat|message)|m\u00e3 pin|\bpin\b|secure storage/i;
      const visibleDialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
        .filter((dialog) => {
          const rect = dialog.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const recoveryDialogOpen = visibleDialogs.some((dialog) => {
        const text = `${dialog.innerText || ''} ${dialog.getAttribute('aria-label') || ''}`;
        return recoveryPattern.test(text);
      });
      const composerAvailable = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
        .some((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
        });
        return { recoveryDialogOpen, composerAvailable };
      }
    }).then((rows) => rows?.[0]?.result || {}).catch(() => ({}));
    if (state.recoveryDialogOpen || state.composerAvailable) break;
    await delay(250);
  }
  if (state.recoveryDialogOpen) {
    const error = new Error('Messenger recovery dialog is blocking the composer');
    error.code = 'MESSENGER_RECOVERY_DIALOG_BLOCKED';
    throw error;
  }
  if (!state.composerAvailable) {
    const error = new Error('Messenger composer is not ready');
    error.code = 'MESSENGER_COMPOSER_NOT_READY';
    throw error;
  }
  return true;
}

async function enforceSingleMessengerTab(accountId, preferredTabId = null) {
  const tabs = await chrome.tabs.query({});
  const messageTabs = tabs.filter((candidate) =>
    MessengerTabDeduplicator.isMessagesUrl(candidate.url || candidate.pendingUrl)
  );
  const ownedTabs = [];
  for (const candidate of messageTabs) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: candidate.id },
        func: () => document.cookie.match(/c_user=(\d+)/)?.[1] || null
      });
      if (String(result?.[0]?.result || '') === String(accountId || '')) ownedTabs.push(candidate);
    } catch (_) {}
  }

  // Spec 048: several Messenger tabs are intentional (interaction,
  // discovery, history). Never close an owned Messenger tab merely because
  // another owned tab exists. Prefer the requested tab and keep the old
  // fallback for profiles created before the role registry existed.
  return ownedTabs.find((tab) => String(tab.id) === String(preferredTabId)) || ownedTabs[0] || null;
}

async function enforceSingleMessengerTabThrottled(accountId, preferredTabId = null, force = false) {
  if (!accountId) return null;
  const now = Date.now();
  if (!force && now - lastMessengerTabDedupAt < 5000) return null;
  lastMessengerTabDedupAt = now;
  return enforceSingleMessengerTab(accountId, preferredTabId);
}

// Dedicated automation surfaces must never be adopted as the operator's chat
// tab. During account registration discovery and interaction initialization
// can race; getFacebookTab previously selected whichever /messages tab was
// visible first and registered the discovery tab under both roles.
const DEDICATED_MESSENGER_ROLES = new Set([
  'campaign', 'discovery', 'history', 'requests', 'request_action'
]);
async function isDedicatedMessengerRoleTab(accountId, tabId) {
  if (tabId == null) return false;
  await loadTabRegistry();
  const targetTabId = String(tabId);
  return [...tabRegistry.entries()].some(([key, value]) => {
    if (String(value) !== targetTabId) return false;
    const prefix = `personal:${String(accountId)}:`;
    if (!String(key).startsWith(prefix)) return false;
    return DEDICATED_MESSENGER_ROLES.has(String(key).slice(prefix.length));
  });
}

// ── Tab-creation cooldown (personal <-> Page shared-identity conflict) ────
// Facebook ties "which surface /messages resolves to" to a single active
// identity per login session (personal profile vs. a managed Page). Since
// personal-messenger sync and Page/Business-Suite sync for the same account
// share one Chrome profile/cookie jar, using one surface can flip the other's
// already-registered tab to the wrong hostname out from under us - not a
// genuine "no tab exists" case. Without a cooldown, getFacebookTab's exclusion
// of business.facebook.com tabs (feature 013, FR-001) makes
// ensureFacebookMessagesTab treat every flip as "missing" and spin up a
// replacement tab every sync cycle, which itself gets flipped, piling up
// orphaned tabs forever. This cooldown stops that: after a detected flip, wait
// before trying to create another tab for that role, giving Facebook's
// identity state a chance to settle back on its own first.
const TAB_COOLDOWN_STORAGE_KEY = 'fb_engine_tab_cooldowns';
const TAB_CREATION_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
let tabCreationCooldowns = new Map(); // role -> timestamp when cooldown ends
let tabCooldownsLoaded = null;

function loadTabCooldowns() {
  if (!tabCooldownsLoaded) {
    tabCooldownsLoaded = new Promise((resolve) => {
      chrome.storage.session.get([TAB_COOLDOWN_STORAGE_KEY], (result) => {
        const stored = result?.[TAB_COOLDOWN_STORAGE_KEY];
        if (stored && typeof stored === 'object') {
          tabCreationCooldowns = new Map(Object.entries(stored));
        }
        resolve();
      });
    });
  }
  return tabCooldownsLoaded;
}

function persistTabCooldowns() {
  return chrome.storage.session.set({ [TAB_COOLDOWN_STORAGE_KEY]: Object.fromEntries(tabCreationCooldowns) });
}

async function startTabCreationCooldown(role) {
  await loadTabCooldowns();
  tabCreationCooldowns.set(role, Date.now() + TAB_CREATION_COOLDOWN_MS);
  await persistTabCooldowns();
}

async function isTabCreationOnCooldown(role) {
  await loadTabCooldowns();
  const until = tabCreationCooldowns.get(role);
  if (!until) return false;
  if (Date.now() >= until) {
    tabCreationCooldowns.delete(role);
    await persistTabCooldowns();
    return false;
  }
  return true;
}

// ── Lấy tab Facebook tương ứng với account_id (khớp c_user cookie) ─────────
// Never returns a business.facebook.com tab: that host is exclusively for
// Page inboxes (see getBusinessSuiteTab) and must never be treated as "the"
// personal-messenger tab, even if it happens to share the same login cookie.
async function getFacebookTab(accountId) {
  const role = `personal:${accountId}`;
  const registered = await getRegisteredTab(role);
  const registeredIsDedicated = registered?.id
    ? await isDedicatedMessengerRoleTab(accountId, registered.id)
    : false;
  if (registered && !isBusinessSuiteUrl(registered.url) && !registeredIsDedicated) {
    const singleton = await enforceSingleMessengerTab(accountId, registered.id);
    return singleton || registered;
  }
  if (registeredIsDedicated) {
    // Remove only the accidental interaction aliases. The dedicated role
    // entry remains intact and continues owning this tab.
    await unregisterTab(role);
    await unregisterTab(FbCrmMessengerTabRoles.roleKey(accountId, 'chat'));
    await unregisterTab(FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'));
  }
  if (registered) {
    // The tab we previously registered as "personal" now resolves to
    // business.facebook.com. This is Facebook's shared-identity session
    // flipping it, not a stale/closed-tab case - start a cooldown so the
    // caller doesn't immediately spin up a replacement that just gets
    // flipped again (see cooldown block above getFacebookTab).
    await unregisterTab(role);
    await startTabCreationCooldown(role);
  }

  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['*://*.facebook.com/*', '*://*.messenger.com/*'] }, async (tabs) => {
      const candidates = (tabs || []).filter(t => !isBusinessSuiteUrl(t.url));
      if (candidates.length === 0) return resolve(null);

      const matchingTabs = [];
      for (const tab of candidates) {
        if (tab.discarded || !tab.id) continue;
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.cookie.match(/c_user=(\d+)/)?.[1] || null
          });
          const tabUserId = res?.[0]?.result;
          if (accountId && String(tabUserId) === String(accountId)) {
            matchingTabs.push(tab);
          }
        } catch (e) {}
      }

      // No fallback to "any" Facebook/Messenger tab here: with multiple
      // accounts (or Facebook's own multi-profile switcher) open in the same
      // Chrome instance, a tab that doesn't match this account's c_user
      // cookie could belong to a completely different account. Reporting
      // "not found" and letting the caller open/redirect a fresh tab is
      // safe; silently reusing a mismatched tab could sync or send under
      // the wrong account.
      let resolved = null;
      if (matchingTabs.length > 0) {
        const interactionCandidates = [];
        for (const candidate of matchingTabs) {
          if (!await isDedicatedMessengerRoleTab(accountId, candidate.id)) {
            interactionCandidates.push(candidate);
          }
        }
        const messagesTab = interactionCandidates.find(t => /\/messages(?:\/|$|\?)/.test(String(t.url || '')));
        resolved = messagesTab || interactionCandidates[0] || null;
      }

      if (resolved?.id) {
        resolved = await enforceSingleMessengerTab(accountId, resolved.id) || resolved;
        await registerTab(role, resolved.id);
        await registerTab(FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'), resolved.id);
      }
      resolve(resolved);
    });
  });
}
async function ensureFacebookMessagesTab(accountId, reason = 'background_sync') {
  const role = `personal:${accountId}`;
  let tab = await getFacebookTab(accountId);
  if (!tab) {
    if (await isTabCreationOnCooldown(role)) {
      console.log(`[FB Engine] [BACKGROUND_TAB] account=${accountId} đang trong cooldown sau khi bị Facebook chuyển identity sang Page. Bỏ qua tạo tab lần này. reason=${reason}`);
      return null;
    }
    console.log(`[FB Engine] [BACKGROUND_TAB] Không có tab Messenger cho account=${accountId}. Tạo tab nền. reason=${reason}`);
    tab = await tabCreationCoordinator.run(
      role,
      () => getFacebookTab(accountId),
      async () => {
        const created = await new Promise((resolve) => {
          chrome.tabs.create({ url: 'https://www.facebook.com/messages', active: false }, resolve);
        });
        if (created?.id) {
          await registerTab(role, created.id);
          await Promise.race([waitForTabComplete(created.id, 12000), delay(4000)]);
          await delay(1200);
          try {
            const settled = await chrome.tabs.get(created.id);
            if (isBusinessSuiteUrl(settled.url)) {
              console.log(`[FB Engine] [BACKGROUND_TAB] Tab mới cho account=${accountId} bị Facebook chuyển sang Business Suite ngay sau khi mở (identity dùng chung). Bắt đầu cooldown.`);
              await unregisterTab(role);
              await startTabCreationCooldown(role);
            }
          } catch (e) {}
        }
        return await enforceSingleMessengerTabThrottled(accountId, created?.id, true) || created || null;
      }
    );
    return tab || null;
  }

  if (!/\/messages(?:\/|$|\?)/.test(String(tab.url || ''))) {
    console.log(`[FB Engine] [BACKGROUND_TAB] Tab account=${accountId} không ở Messenger, chuyển sang /messages. reason=${reason}`);
    try {
      const loadPromise = waitForTabComplete(tab.id, 10000);
      await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/messages' });
      await Promise.race([loadPromise, delay(3500)]);
      await delay(1000);
      tab = await chrome.tabs.get(tab.id);
    } catch (e) {
      console.warn(`[FB Engine] [BACKGROUND_TAB] Không thể chuyển tab sang Messenger: ${e.message}`);
    }
  }

  return await enforceSingleMessengerTabThrottled(accountId, tab?.id, true) || tab;
}

async function ensureRoleMessengerTab(accountId, role) {
  if (role === 'interaction' || role === 'chat') {
    const interaction = await ensureFacebookMessagesTab(accountId, 'interaction');
    if (interaction?.id) {
      await registerTab(FbCrmMessengerTabRoles.roleKey(accountId, 'chat'), interaction.id);
      await registerTab(FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'), interaction.id);
      await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(accountId), interaction.id);
    }
    return interaction;
  }

  const normalizedRole = role;
  const roleKey = FbCrmMessengerTabRoles.roleKey(accountId, normalizedRole);
  const allowedAliases = new Set(normalizedRole === 'chat' ? [
    roleKey,
    FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'),
    FbCrmMessengerTabRoles.legacyInteractionKey(accountId)
  ] : [roleKey]);
  const isReservedByAnotherRole = async (tabId) => {
    await loadTabRegistry();
    return [...tabRegistry.entries()].some(([key, value]) => (
      String(value) === String(tabId) && key.startsWith(`personal:${String(accountId)}`) && !allowedAliases.has(key)
    ));
  };

  let tab = await getRegisteredTab(roleKey);
  if (!tab && normalizedRole === 'chat') {
    tab = await getRegisteredTab(FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'))
      || await getRegisteredTab(FbCrmMessengerTabRoles.legacyInteractionKey(accountId));
  }
  if (tab && (isBusinessSuiteUrl(tab.url) || await isReservedByAnotherRole(tab.id))) {
    tab = null;
  }

  tab = tab || await tabCreationCoordinator.run(
    roleKey,
    async () => {
      const existing = await getRegisteredTab(roleKey);
      return existing && !isBusinessSuiteUrl(existing.url) && !(await isReservedByAnotherRole(existing.id))
        ? existing
        : null;
    },
    async () => {
      const created = await new Promise((resolve) => {
        chrome.tabs.create({
          url: `https://www.facebook.com/messages?crm_tab_role=${encodeURIComponent(normalizedRole)}`,
          active: false
        }, resolve);
      });
      if (!created?.id) return null;
      await registerTab(roleKey, created.id);
      await Promise.race([waitForTabComplete(created.id, 12000), delay(4000)]);
      await delay(900);
      return chrome.tabs.get(created.id).catch(() => created);
    }
  );

  if (tab?.id) {
    await registerTab(roleKey, tab.id);
    if (normalizedRole === 'chat') {
      await registerTab(FbCrmMessengerTabRoles.roleKey(accountId, 'interaction'), tab.id);
      await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(accountId), tab.id);
    }
  }
  return tab || null;
}

async function selectAttachmentCapableMessengerTab(accountId, role = 'interaction') {
  let primary = await ensureRoleMessengerTab(accountId, role);
  if (primary?.id && await isDedicatedMessengerRoleTab(accountId, primary.id)) {
    if (role === 'campaign') {
      // Tab campaign là tab riêng ĐỂ GỬI chiến dịch - dùng trực tiếp, không
      // được loại nó vì "dedicated" (trước đây hàm này tự tạo tab campaign
      // xong lại từ chối chính tab đó -> FACEBOOK_TAB_NOT_FOUND triệt để).
      return primary;
    }
    // Tab đang chạy role dedicated (history/discovery...) - trả null ngay sẽ
    // thành FACEBOOK_TAB_NOT_FOUND khi tab duy nhất cũng là tab sync. Thử tìm
    // tab messenger thường khác trước, chưa có thì tạo tab nền mới để gửi.
    console.warn(`[FB Engine] Tab ${primary.id} đang giữ role dedicated; tìm/tạo tab thường để gửi đính kèm.`);
    primary = null;
    try {
      const all = await chrome.tabs.query({ url: ['*://www.facebook.com/*'] });
      for (const t of all) {
        if (!/\/messages(?:\/|$|\?)/.test(String(t.url || ''))) continue;
        if (await isDedicatedMessengerRoleTab(accountId, t.id)) continue;
        primary = t;
        break;
      }
    } catch (e) {}
    if (!primary?.id) {
      const created = await new Promise((resolve) => {
        chrome.tabs.create({ url: 'https://www.facebook.com/messages', active: false }, resolve);
      });
      if (created?.id) {
        await Promise.race([waitForTabComplete(created.id, 12000), delay(4000)]).catch(() => null);
        await delay(800);
        try {
          const settled = await chrome.tabs.get(created.id);
          // Facebook chuyển identity sang Business -> tab này không dùng được.
          if (!isBusinessSuiteUrl(settled.url)) primary = settled;
        } catch (e) {}
      }
    }
  }
  if (!primary?.id) return primary || null;
  const capable = await chrome.scripting.executeScript({
    target: { tabId: primary.id },
    func: () => Boolean(
      [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }) && document.querySelector('input[type="file"]')
    )
  }).then((rows) => Boolean(rows?.[0]?.result)).catch(() => false);
  if (!capable) console.log(`[FB Engine] Dedicated ${role} tab has no mounted file input yet; attachment staging will wait for its composer.`);
  return primary;
}
// ── Gửi tin nhắn qua Facebook GraphQL API ──────────────────────────────────
// Attachments never use the GraphQL text mutation below (it has no media
// parameter) - they always go through the composer, staged via the same
// CDP file-chooser mechanism as the Page adapter, then submitted through
// typeAndSubmitComposer (DOM click on the real send control, CDP Enter
// fallback).
async function snapshotPersonalOutgoingMediaIds(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => [...document.querySelectorAll('[data-message-id]')]
      .filter((element) => {
        const row = element.closest('[role="row"], [role="article"]') || element;
        const label = `${row.getAttribute('aria-label') || ''} ${element.getAttribute('aria-label') || ''}`;
        return /(?:Bạn|You)(?::|\s|$)/i.test(label) && Boolean(row.querySelector('img, video'));
      })
      .map((element) => String(element.getAttribute('data-message-id') || ''))
      .filter(Boolean)
  }).then((rows) => rows?.[0]?.result || []).catch(() => []);
}

async function confirmPersonalAttachmentFromRenderedBubble({ tabId, threadId, accountId, clientMessageId, mediaType, idsBefore = [] }) {
  const knownIds = new Set((idsBefore || []).map(String));
  const deadline = Date.now() + (mediaType === 'video' ? 20000 : 10000);
  while (Date.now() < deadline) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expectedType, excludedIds, rememberSeen) => {
        const excluded = new Set(excludedIds || []);
        if (rememberSeen && !window.__crmSeenAttachmentIds) {
          window.__crmSeenAttachmentIds = new Set(excluded);
        }
        const seen = window.__crmSeenAttachmentIds;
        const candidates = [...document.querySelectorAll('[role="row"], [role="article"]')].reverse();
        for (const row of candidates) {
          const idElement = row.matches?.('[data-message-id]') ? row : row.querySelector('[data-message-id]');
          const messageId = String(idElement?.getAttribute('data-message-id') || '');
          if (!messageId || excluded.has(messageId) || messageId.startsWith('pending_')) continue;
          // An id Facebook assigned before this send started belongs to an
          // older bubble still in the viewport (observed live: a mid.$..._media
          // id confirmed two video sends 49 minutes apart). It must never be
          // reported as this send's confirmation; wait for a genuinely new id.
          if (seen && seen.has(messageId)) continue;
          const label = `${row.getAttribute('aria-label') || ''} ${idElement?.getAttribute('aria-label') || ''}`;
          if (!/(?:Bạn|You)(?::|\s|$)/i.test(label)) continue;
          const hasVideo = Boolean(row.querySelector('video'));
          const hasImage = Boolean(row.querySelector('img'));
          if (expectedType === 'video' ? !hasVideo : !hasImage || hasVideo) continue;
          if (seen) seen.add(messageId);
          return { message_id: messageId, media_type: expectedType };
        }
        return null;
      },
      args: [mediaType, [...knownIds], true]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);
    if (result?.message_id) {
      sendToBackend('NEW_MESSAGE_RECEIVED', {
        account_id: accountId,
        thread_id: threadId,
        sender_id: accountId,
        sender_name: 'Bạn',
        content: '',
        is_outgoing: true,
        sender_role: 'operator',
        fb_message_id: result.message_id,
        media_type: result.media_type,
        media_url: null,
        timestamp_ms: Date.now(),
        timestamp_source: 'composer_confirmation',
        created_at: new Date().toISOString(),
        source: 'composer_confirmation'
      });
      sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_dom_confirmed', client_message_id: clientMessageId, media_type: result.media_type, fb_message_id: result.message_id });
      return result;
    }
    await delay(250);
  }
  sendToBackend('COMPOSER_DEBUG', { stage: 'attachment_dom_confirmation_timeout', client_message_id: clientMessageId, media_type: mediaType });
  return null;
}
function resolvePersonalRecipientThreadId(threadId, explicitRecipientThreadId = null) {
  const explicit = String(explicitRecipientThreadId || '').trim();
  if (explicit) return explicit;
  const parts = String(threadId || '').split(':').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function assertCampaignRecipientIdentity(expectedContactName, visibleContactName, strictRecipientIdentity, stage, routeVerified = false) {
  if (!strictRecipientIdentity) return true;
  const normalizeIdentity = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
  const isGeneric = (value) => !value || /^(khách hàng|chưa có liên hệ|khach hang|default|customer|user)$/i.test(String(value).trim());
  if (isGeneric(expectedContactName)) return true;
  if (isGeneric(visibleContactName)) {
    // Route thread id đã xác minh đúng hội thoại thì tên hiển thị không đọc
    // được chỉ là lỗi trích xuất DOM - cảnh báo, không chặn gửi nhầm ai.
    if (routeVerified) {
      console.warn('[CAMPAIGN] Visible contact name unreadable after verified route; allowing:', { expectedContactName, visibleContactName, stage });
      return true;
    }
    const error = new Error('Không xác minh được đúng người nhận chiến dịch trên Messenger; đã chặn gửi.');
    error.code = 'CAMPAIGN_RECIPIENT_IDENTITY_UNVERIFIED';
    error.stage = stage;
    throw error;
  }
  const expected = normalizeIdentity(expectedContactName);
  const visible = normalizeIdentity(visibleContactName);
  if (expected === visible || expected.includes(visible) || visible.includes(expected)) return true;
  // Route thread id đã xác minh đúng hội thoại: tên hiển thị lệch chỉ là do
  // CRM đặt biệt danh khác tên thật trên Messenger (vd 'thức đơ' vs tên thật)
  // - cảnh báo rồi gửi, không chặn người nhận đúng.
  if (routeVerified) {
    console.warn('[CAMPAIGN] Route verified; nickname differs from Messenger display name, allowing:', { expectedContactName, visibleContactName, stage });
    return true;
  }
  const error = new Error('Người nhận đang mở (' + visibleContactName + ') không khớp người đã chọn (' + expectedContactName + '); đã chặn gửi.');
  error.code = 'CAMPAIGN_RECIPIENT_IDENTITY_MISMATCH';
  error.stage = stage;
  throw error;
}

// Campaign sends reuse one dedicated Messenger tab. Facebook can update the
// URL and header before React rebinds the composer to the new conversation.
// Require the durable thread route plus an empty composer, then bind that exact
// DOM node to the recipient. The route is checked again immediately before and
// after insertion, so repeating this expensive Chrome probe only adds latency.
async function prepareCampaignRecipientComposer(tabId, targetThreadId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expectedThreadId) => {
        const routeMatch = location.href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/) ||
          location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
        const currentThreadId = routeMatch ? decodeURIComponent(routeMatch[1]) : null;
        const normalize = (value) => String(value || '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const main = document.querySelector('div[role="main"]');
        const candidates = [...(main?.querySelectorAll('[contenteditable="true"], [role="textbox"]') || [])]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const label = String(element.getAttribute('aria-label') || '').toLowerCase();
            return {
              element,
              area: rect.width * rect.height,
              visible: rect.width > 0 && rect.height > 0,
              isSearch: label.includes('search') || /t.m ki.m/.test(label),
              isContentEditable: element.getAttribute('contenteditable') === 'true'
            };
          })
          .filter((candidate) => candidate.visible && !candidate.isSearch);
        const contentEditable = candidates.filter((candidate) => candidate.isContentEditable);
        const pool = contentEditable.length ? contentEditable : candidates;
        pool.sort((left, right) => right.area - left.area);
        const composer = pool[0]?.element || null;
        const routeReady = String(currentThreadId || '') === String(expectedThreadId || '');
        if (!routeReady || !composer) {
          return {
            success: false,
            current_thread_id: currentThreadId,
            route_ready: routeReady,
            composer_ready: Boolean(composer)
          };
        }
        const composerText = normalize(composer.innerText || composer.textContent || '');
        if (composerText) {
          return {
            success: false,
            error: 'Campaign composer is not empty before recipient send',
            error_code: 'CAMPAIGN_COMPOSER_NOT_EMPTY',
            current_thread_id: currentThreadId,
            composer_ready: true,
            composer_content_length: composerText.length
          };
        }
        composer.setAttribute('data-crm-campaign-recipient-thread', String(expectedThreadId));
        composer.focus();
        return {
          // A background Messenger tab may refuse document.activeElement even
          // though the composer is mounted and focusable. Readiness is route +
          // mounted empty composer; the send step focuses it again immediately.
          success: true,
          focused: document.activeElement === composer,
          current_thread_id: currentThreadId,
          composer_ready: true,
          composer_label: composer.getAttribute('aria-label') || '',
          chosen_area: pool[0]?.area || 0
        };
      },
      args: [String(targetThreadId)]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);

    if (lastState?.error_code === 'CAMPAIGN_COMPOSER_NOT_EMPTY') break;
    if (lastState?.success) {
      // The campaign-only navigation loaded a fresh document. One authoritative
      // route + empty-composer probe is enough; the insertion step still rebinds
      // the node and rejects any route change before dispatching Enter.
      const ready = { ...lastState, stable_polls: 1 };
      sendToBackend('COMPOSER_DEBUG', { stage: 'campaign_recipient_composer_ready', target_thread_id: String(targetThreadId), ...ready });
      return ready;
    }
    await delay(200);
  }

  sendToBackend('COMPOSER_DEBUG', { stage: 'campaign_recipient_composer_timeout', target_thread_id: String(targetThreadId), ...(lastState || {}) });
  const error = new Error(lastState?.error || 'Messenger composer did not become stable on the requested campaign recipient');
  error.code = lastState?.error_code || 'CAMPAIGN_RECIPIENT_COMPOSER_NOT_READY';
  error.details = lastState;
  throw error;
}

// Sau khi submit video, Messenger vẫn xử lý phía server ("Đang xử lý").
// Điều hướng tab sang thread khác trong lúc đó làm hủy xử lý - video không
// bao giờ lên. Chờ spinner/progressbar quanh bubble biến mất rồi mới cho
// runner chuyển người nhận kế tiếp. Timeout chỉ ghi log, không coi là lỗi
// (video thường vẫn đăng thành công sau khi hết chờ).
async function waitPersonalVideoSettled(tabId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const main = document.querySelector('div[role="main"]');
        if (!main) return { settled: true, reason: 'no_main' };
        const tail = (main.innerText || '').slice(-2500);
        // Spinner / tiến trình upload còn chạy?
        const processing = /đang xử lý|xử lý video|processing video|đang tải lên|uploading|đang gửi|sending/i.test(tail);
        const busy = [...main.querySelectorAll('[aria-busy="true"], [role="progressbar"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).length;
        // Tín hiệu giao hàng chính thức của Messenger: dòng 'Đã gửi'/'Đã xem'
        // (hoặc tiếng Anh) dưới bubble - video chưa hiện dòng này là chưa xong.
        const sentMarker = /(đã gửi|đã xem|đã thấy|sent|seen|delivered)/i.test(tail);
        return { settled: !processing && busy === 0 && sentMarker, processing, busy, sent_marker: sentMarker };
      }
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);
    if (lastState?.settled) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'video_settled', waited_ms: timeoutMs - (deadline - Date.now()), ...lastState });
      return true;
    }
    // Log nhịp thăm dò mỗi 5s để nhìn thấy nó đang chờ điều kiện nào.
    if (Math.floor((timeoutMs - (deadline - Date.now())) / 5000) !== Math.floor((timeoutMs - (deadline - Date.now()) + 1000) / 5000)) {
      sendToBackend('COMPOSER_DEBUG', { stage: 'video_settle_poll', ...lastState });
    }
    await delay(1000);
  }
  sendToBackend('COMPOSER_DEBUG', { stage: 'video_settle_timeout', timeout_ms: timeoutMs, ...(lastState || {}) });
  return false;
}

async function handleSendPersonalMessageWithAttachment({ thread_id, recipient_thread_id = null, thread_url = null, expected_contact_name = null, strict_recipient_identity = false, content, attachment, attachmentManifest = null, client_message_id, account_id = user_id, tab_role = 'interaction' }) {
  const trace = (stage, extra = {}) => console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage, thread_id: String(thread_id), client_message_id, at: new Date().toISOString(), ...extra }));
  trace('EXTENSION_SEND_RECEIVED', { text_length: String(content || '').length, has_attachment: true });
  let tab = null;
  try {
    tab = await selectAttachmentCapableMessengerTab(account_id, tab_role);
    if (!tab) {
      const missingTabError = new Error('Facebook tab not found for attachment send');
      missingTabError.code = 'FACEBOOK_TAB_NOT_FOUND';
      throw missingTabError;
      sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: 'Không tìm thấy Tab Facebook hoạt động', error_code: 'FACEBOOK_TAB_NOT_FOUND' });
      return;
    }
    await isolateFailedMediaDraftBeforeSend(tab.id);
    await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
    await delay(300);

    const recipientPsid = resolvePersonalRecipientThreadId(thread_id, recipient_thread_id);
    const onThread = await ensureTabOnThread(tab, recipientPsid, thread_url, null, null, expected_contact_name, { forceCleanViewport: strict_recipient_identity });
    if (!onThread) {
      const navigationError = new Error('Messenger thread navigation failed for attachment send');
      navigationError.code = 'THREAD_NAV_FAILED';
      throw navigationError;
      sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: 'Không thể điều hướng đúng hội thoại Messenger để gửi attachment', error_code: 'THREAD_NAV_FAILED' });
      return;
    }
    if (strict_recipient_identity) {
      await prepareCampaignRecipientComposer(tab.id, recipientPsid);
    }

    const visibleContactName = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const main = document.querySelector('div[role="main"]') || document;
        const heading = main.querySelector('header h1, header h2, h1, h2, span[aria-level="1"], span[aria-level="2"]');
        const headingName = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
        if (headingName) return headingName;
        const composer = [...main.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .find((element) => /^(?:Viết cho|Write to)\s+/i.test(element.getAttribute('aria-label') || ''));
        const composerLabel = (composer?.getAttribute('aria-label') || '').trim();
        if (composerLabel) return composerLabel.replace(/^(?:Viết cho|Write to)\s+/i, '').trim() || null;
        const conversation = main.querySelector('[aria-label^="Tin nhắn trong cuộc trò chuyện với "], [aria-label^="Messages in conversation with "]');
        return (conversation?.getAttribute('aria-label') || '')
          .replace(/^(?:Tin nhắn trong cuộc trò chuyện với|Messages in conversation with)\s+/i, '')
          .trim() || null;
      }
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);
    const isGenericContactName = (n) => !n || /^(khách hàng|chưa có liên hệ|khach hang|default|customer|user)$/i.test(String(n).trim());
    const normalizedExpectedName = String(expected_contact_name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
    const normalizedVisibleName = String(visibleContactName || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
    assertCampaignRecipientIdentity(expected_contact_name, visibleContactName, strict_recipient_identity, 'PERSONAL_ATTACHMENT_IDENTITY', true);
    if (!isGenericContactName(normalizedExpectedName) && !isGenericContactName(normalizedVisibleName) && normalizedExpectedName !== normalizedVisibleName) {
      if (!normalizedExpectedName.includes(normalizedVisibleName) && !normalizedVisibleName.includes(normalizedExpectedName)) {
        console.warn('[ATTACHMENT] Contact identity mismatch warning:', { expected_contact_name, visibleContactName });
      }
    }

    await assertMessengerRecoveryDialogResolved(tab.id);
    const attachmentPayload = attachmentManifest || attachment;
    const attachmentItems = Array.isArray(attachmentPayload) ? attachmentPayload : [attachmentPayload];
    const mediaType = attachmentItems.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').startsWith('video/')) ? 'video' : 'image';
    const outgoingMediaIdsBefore = await snapshotPersonalOutgoingMediaIds(tab.id);
    await stagePersonalMessengerAttachment(tab.id, attachmentPayload);
    await waitForMessengerAttachmentReady(tab.id, attachmentPayload);
    const verifiedThreadId = await getCurrentThreadIdInTab(tab.id);
    if (String(verifiedThreadId || '') !== String(recipientPsid)) {
      const routeError = new Error('Conversation changed while preparing attachment; send blocked');
      routeError.code = 'THREAD_ROUTE_MISMATCH';
      throw routeError;
    }
    await typeAndSubmitComposer(tab.id, content);
    await delay(100);
    confirmPersonalAttachmentFromRenderedBubble({
      tabId: tab.id,
      threadId: thread_id,
      accountId: account_id,
      clientMessageId: client_message_id,
      mediaType,
      idsBefore: outgoingMediaIdsBefore
    }).catch(() => null);

    // Video: submit chỉ đưa bubble vào thread - Facebook vẫn xử lý phía server
    // ("Đang xử lý"). Nếu chuyển sang người nhận kế tiếp ngay, tab điều hướng
    // đi mất làm hủy xử lý -> video không bao giờ lên. Chờ bubble video hoàn
    // tất (spinner/progressbar biến mất, tối đa 90s) trước khi báo hoàn tất.
    if (mediaType === 'video') {
      await waitPersonalVideoSettled(tab.id, 90000);
    }

    console.log('[FB Engine] ✅ Đã dispatch tin nhắn (có đính kèm) qua Messenger cá nhân');
    sendToBackend('SEND_MESSAGE_RESULT', {
      thread_id,
      client_message_id,
      success: false,
      error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION',
      stage: 'PERSONAL_MESSENGER_CDP',
      error_code: 'COMPOSER_DISPATCHED'
    });
  } catch (error) {
    if (tab?.id) {
      dirtyAttachmentDraftTabs.add(tab.id);
      const resetResult = await resetFailedMessengerComposerDraft(tab.id);
      // Keep the dirty marker only when cleanup itself failed. Leaving it set
      // after a successful reset caused the next text/media send to clear a
      // healthy composer and surface a false Retry.
      if (resetResult?.success) dirtyAttachmentDraftTabs.delete(tab.id);
    }
    console.error('[FB Engine] ❌ Lỗi gửi attachment qua Messenger cá nhân:', error.message);
    sendToBackend('SEND_MESSAGE_RESULT', {
      thread_id,
      client_message_id,
      success: false,
      error: error.message || 'Lỗi gửi attachment qua Messenger cá nhân',
      error_code: error.code || 'ATTACHMENT_SEND_FAILED'
    });
    // Queue callers must receive the real failure. Swallowing it here made
    // handleSendQueuedMessage emit a second, contradictory "dispatched"
    // result, then the backend waited three minutes and rendered "Thử lại".
    throw error;
  }
}

async function handleSendMessage({ thread_id, recipient_thread_id = null, thread_url = null, expected_contact_name = null, strict_recipient_identity = false, content, text, attachment = null, attachmentManifest = null, client_message_id, account_id = user_id, tab_role = 'interaction' }) {
  const messageText = content ?? text;
  if (attachment || attachmentManifest) {
    return handleSendPersonalMessageWithAttachment({ thread_id, recipient_thread_id, thread_url, expected_contact_name, strict_recipient_identity, content: messageText, attachment, attachmentManifest, client_message_id, account_id, tab_role });
  }
  let lastSendError = null;
  const trace = (stage, extra = {}) => console.log('[OUTBOUND_TRACE]', JSON.stringify({ stage, thread_id: String(thread_id), client_message_id, at: new Date().toISOString(), ...extra }));
  const confirmFromRenderedBubble = async (tabId, stage) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (expectedText) => {
          const normalize = (value) => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
          const wanted = normalize(expectedText);
          const rows = [...document.querySelectorAll('[data-message-id]')].reverse();
          const row = rows.find((element) => {
            const label = element.getAttribute('aria-label') || '';
            return normalize(element.textContent) === wanted && /(?:Bạn|You)(?::|\s|$)/i.test(label);
          });
          return row ? { message_id: row.getAttribute('data-message-id'), content: normalize(row.textContent) } : null;
        },
        args: [messageText]
      }).then((rows) => rows?.[0]?.result || null).catch(() => null);
      if (result?.message_id && !String(result.message_id).startsWith('pending_')) {
        sendToBackend('NEW_MESSAGE_RECEIVED', {
          account_id,
          thread_id,
          sender_id: account_id,
          sender_name: 'Bạn',
          content: result.content,
          is_outgoing: true,
          sender_role: 'operator',
          fb_message_id: result.message_id,
          media_type: 'text',
          timestamp_ms: Date.now(),
          timestamp_source: 'composer_confirmation',
          created_at: new Date().toISOString(),
          source: 'composer_confirmation'
        });
        trace('COMPOSER_DOM_CONFIRMED', { stage, fb_message_id: result.message_id });
        return result;
      }
      await delay(200);
    }
    trace('COMPOSER_DOM_CONFIRMATION_TIMEOUT', { stage });
    return null;
  };
  if (!messageText || !messageText.trim()) {
    console.warn('[SEND_MESSAGE] Lỗi: Nội dung tin nhắn trống', { thread_id, client_message_id });
    sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: 'Nội dung tin nhắn trống' });
    return;
  }
  trace('EXTENSION_SEND_RECEIVED', { text_length: String(messageText).length });

  console.log(`[SEND_MESSAGE] 📤 Đang gửi tin nhắn: account= thread= client_msg_id=${client_message_id}`);

  // Cách 1: Thử gửi trực tiếp qua Service Worker Fetch nếu có token
  // Private GraphQL can resolve legacy/E2EE thread identifiers differently
  // from the visible conversation. Keep sends on the verified interaction DOM.
  if (false && fb_dtsg) {
    trace('GRAPHQL_ATTEMPT_START', { token_available: true });
    try {
      const formData = new URLSearchParams();
      formData.append('fb_dtsg', fb_dtsg);
      formData.append('queries', JSON.stringify({
        o0: {
          doc_id: '3336396659757871',
          query_params: {
            data: {
              client_mutation_id: client_message_id || Date.now().toString(),
              actor_id: account_id,
              thread_id,
              message: { text: messageText }
            }
          }
        }
      }));

      const response = await fetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });

      if (response.ok) {
        const rawBody = await response.text();
        let resJson = null;
        try { resJson = rawBody.trim() ? JSON.parse(rawBody) : null; } catch (parseError) {
          lastSendError = `Facebook response không phải JSON (HTTP ${response.status})`;
          console.warn('[SEND_MESSAGE] Facebook response parse thất bại:', { status: response.status, contentType: response.headers.get('content-type'), bodyLength: rawBody.length });
        }
        if (!resJson) {
          lastSendError = lastSendError || `Facebook trả response rỗng (HTTP ${response.status})`;
          trace('GRAPHQL_RESPONSE_EMPTY', { http_status: response.status });
        } else {
        const hasError = resJson?.errors?.length || resJson?.o0?.errors?.length;
        const messageId = resJson?.o0?.data?.message?.message_id || resJson?.data?.message?.message_id || resJson?.o0?.data?.message_id || resJson?.data?.message_id || resJson?.o0?.data?.send_message?.message?.message_id;

        if (!hasError && messageId) {
          console.log('[SEND_MESSAGE] ✅ ServiceWorker Fetch gửi thành công, message_id:', messageId);
          trace('GRAPHQL_CONFIRMED', { http_status: response.status, message_id: true });
          sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: true, message_id: messageId, result: resJson });
          return;
        }
        lastSendError = resJson?.errors?.[0]?.message || resJson?.o0?.errors?.[0]?.message || (hasError ? 'Facebook GraphQL trả về lỗi' : 'Facebook không trả message_id');
        }
      } else {
        lastSendError = `Facebook HTTP ${response.status}`;
        trace('GRAPHQL_HTTP_ERROR', { http_status: response.status });
      }
    } catch (e) {
      console.warn('[SEND_MESSAGE] ServiceWorker Fetch thất bại, thử lại qua Tab context:', e.message);
      lastSendError = e.message;
    }
  }

  // Cách 2: Fallback gửi tin nhắn trong Tab Context của Facebook (Đảm bảo đầy đủ Session, Cookie và Token dtsg)
  try {
    const tab = await ensureRoleMessengerTab(account_id, tab_role);
    if (!tab) {
      const tabError = new Error('Không tìm thấy Tab Facebook hoạt động');
      tabError.code = 'FACEBOOK_TAB_NOT_FOUND';
      sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: tabError.message, error_code: tabError.code });
      if (strict_recipient_identity) throw tabError;
      return;
    }
    await isolateFailedMediaDraftBeforeSend(tab.id);
    const recipientThreadId = resolvePersonalRecipientThreadId(thread_id, recipient_thread_id);
    const onRecipientThread = await ensureTabOnThread(
      tab,
      recipientThreadId,
      thread_url,
      null,
      null,
      expected_contact_name,
      { forceCleanViewport: strict_recipient_identity }
    );
    const interactionDeadline = Date.now() + 10000;
    let interactionState = null;
    while (onRecipientThread && Date.now() < interactionDeadline) {
      interactionState = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (targetThreadId) => {
          const routeMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/) ||
            location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
          const currentThreadId = routeMatch ? decodeURIComponent(routeMatch[1]) : null;
          const main = document.querySelector('div[role="main"]');
          const composer = main && [...main.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
            .find((element) => {
              const rect = element.getBoundingClientRect();
              const label = (element.getAttribute('aria-label') || '').toLowerCase();
              return rect.width > 0 && rect.height > 0 && !label.includes('search') && !label.includes('tìm kiếm');
            });
          const heading = main?.querySelector('header h1, header h2, h1, h2, span[aria-level="1"], span[aria-level="2"]');
          const headingName = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
          const composerLabel = (composer?.getAttribute('aria-label') || '').trim();
          const conversation = main?.querySelector('[aria-label^="Tin nhắn trong cuộc trò chuyện với "], [aria-label^="Messages in conversation with "]');
          const conversationName = (conversation?.getAttribute('aria-label') || '')
            .replace(/^(?:Tin nhắn trong cuộc trò chuyện với|Messages in conversation with)\s+/i, '')
            .trim();
          return {
            current_thread_id: currentThreadId,
            composer_ready: Boolean(composer),
            visible_contact_name: headingName || composerLabel.replace(/^(?:Viết cho|Write to)\s+/i, '').trim() || conversationName || null,
            route_ready: String(currentThreadId || '') === String(targetThreadId || '')
          };
        },
        args: [recipientThreadId]
      }).then((rows) => rows?.[0]?.result || null).catch(() => null);
      if (interactionState?.route_ready && interactionState?.composer_ready && interactionState?.visible_contact_name) break;
      await delay(200);
    }
    const verifiedThreadId = interactionState?.current_thread_id || await getCurrentThreadIdInTab(tab.id);
    if (!onRecipientThread || !interactionState?.route_ready || !interactionState?.composer_ready || String(verifiedThreadId || '') !== recipientThreadId) {
      trace('THREAD_ROUTE_REJECTED', {
        tab_id: tab.id,
        requested_thread_id: recipientThreadId,
        actual_thread_id: verifiedThreadId || null,
        composer_ready: Boolean(interactionState?.composer_ready)
      });
      sendToBackend('SEND_MESSAGE_RESULT', {
        thread_id,
        client_message_id,
        success: false,
        error: 'Messenger tab is not on the requested conversation; send blocked to prevent a wrong recipient',
        error_code: 'THREAD_ROUTE_MISMATCH'
      });
      if (strict_recipient_identity) {
        const routeError = new Error('Messenger tab is not on the requested conversation; campaign send blocked');
        routeError.code = 'THREAD_ROUTE_MISMATCH';
        throw routeError;
      }
      return;
    }
    const visibleContactName = interactionState.visible_contact_name;
    const normalizeIdentity = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
    const isGenericContactName = (n) => !n || /^(khách hàng|chưa có liên hệ|khach hang|default|customer|user)$/i.test(String(n).trim());
    assertCampaignRecipientIdentity(expected_contact_name, visibleContactName, strict_recipient_identity, 'PERSONAL_TEXT_IDENTITY', true);
    if (expected_contact_name && visibleContactName && !isGenericContactName(expected_contact_name) && !isGenericContactName(visibleContactName)) {
      const normExpected = normalizeIdentity(expected_contact_name);
      const normVisible = normalizeIdentity(visibleContactName);
      if (normExpected !== normVisible && !normExpected.includes(normVisible) && !normVisible.includes(normExpected)) {
        console.warn('[SEND_MESSAGE] Contact identity mismatch warning:', { expected_contact_name, visibleContactName });
      }
    }
    if (strict_recipient_identity) {
      const stableComposer = await prepareCampaignRecipientComposer(tab.id, recipientThreadId);
      trace('CAMPAIGN_RECIPIENT_COMPOSER_READY', {
        tab_id: tab.id,
        verified_thread_id: stableComposer.current_thread_id,
        stable_polls: stableComposer.stable_polls
      });
    }
    trace('TAB_CONTEXT_SELECTED', { tab_id: tab.id, verified_thread_id: verifiedThreadId });

    const tabSendResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (targetThreadId, msgTxt, clientMsgId, fallbackDtsg, actorId) => {
        // Fail into the verified composer path. Facebook's private mutation can
        // reinterpret legacy/E2EE IDs and has produced a confirmed send in a
        // different conversation than targetThreadId.
        return { success: false, error: 'PRIVATE_GRAPHQL_DISABLED', error_code: 'PRIVATE_GRAPHQL_DISABLED' };
        try {
          const dtsgToken = fallbackDtsg || window.require?.('DTSGInitialData')?.token || document.querySelector('[name="fb_dtsg"]')?.value;
          if (!dtsgToken) return { success: false, error: 'Thiếu fb_dtsg token trong Tab Facebook' };

          const formData = new URLSearchParams();
          formData.append('fb_dtsg', dtsgToken);
          formData.append('queries', JSON.stringify({
            o0: {
              doc_id: '3336396659757871',
              query_params: {
                data: {
                  client_mutation_id: clientMsgId || Date.now().toString(),
                  actor_id: actorId || document.cookie.match(/c_user=(\d+)/)?.[1],
                  thread_id: targetThreadId,
                  message: { text: msgTxt }
                }
              }
            }
          }));

          const res = await fetch('https://www.facebook.com/api/graphql/', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString()
          });

          const rawBody = await res.text();
          let json = null;
          try { json = rawBody.trim() ? JSON.parse(rawBody) : null; } catch (parseError) {
            return { success: false, error: `Facebook response không phải JSON (HTTP ${res.status})`, error_code: 'FACEBOOK_NON_JSON_RESPONSE' };
          }
          if (!json) return { success: false, error: `Facebook trả response rỗng (HTTP ${res.status})`, error_code: 'FACEBOOK_EMPTY_RESPONSE' };
          const msgId = json?.o0?.data?.message?.message_id || json?.data?.message?.message_id || json?.o0?.data?.message_id || json?.data?.send_message?.message?.message_id;
          const errMsg = json?.errors?.[0]?.message || json?.o0?.errors?.[0]?.message;

          return { success: !!msgId && res.ok && !errMsg, message_id: msgId, error: errMsg || (msgId ? null : `Facebook không trả message_id (HTTP ${res.status})`) };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      args: [recipientThreadId, messageText, client_message_id, fb_dtsg, account_id]
    });

    const tabRes = tabSendResult?.[0]?.result;
    if (tabRes && tabRes.success && tabRes.message_id) {
      console.log('[SEND_MESSAGE] ✅ Tab Context GraphQL gửi thành công, message_id:', tabRes.message_id);
      sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: true, message_id: tabRes.message_id });
    } else {
      // Facebook đôi khi trả body rỗng cho GraphQL. Fallback qua composer thật
      // của tab giúp gửi được trong phiên Messenger hiện tại mà không phụ thuộc
      // response JSON private API.
      const composerPrepResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msgTxt, expectedCampaignThreadId) => {
          const normalizeComposerText = (text) => {
            if (!text) return '';
            let norm = String(text).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
            norm = norm.replace(/\s+/g, ' ').trim();
            const lower = norm.toLowerCase();
            if (lower === 'aa' || lower === 'tin nhắn' || lower === 'soạn tin nhắn' || lower === 'message') return '';
            return norm;
          };
          const main = document.querySelector('div[role="main"]') || document;
          const candidates = [...main.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const label = (el.getAttribute('aria-label') || '').toLowerCase();
              return rect.width > 0 && rect.height > 0 && !label.includes('search') && !label.includes('tìm kiếm');
            });
          const routeMatch = location.href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/) ||
            location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
          const currentThreadId = routeMatch ? decodeURIComponent(routeMatch[1]) : null;
          if (expectedCampaignThreadId && String(currentThreadId || '') !== String(expectedCampaignThreadId)) {
            return { success: false, error: 'Campaign route changed before text insert', error_code: 'THREAD_ROUTE_MISMATCH', current_thread_id: currentThreadId };
          }
          const boundBox = expectedCampaignThreadId
            ? candidates.find((el) => el.getAttribute('data-crm-campaign-recipient-thread') === String(expectedCampaignThreadId))
            : null;
          const freshCampaignBox = expectedCampaignThreadId
            ? [...candidates].sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
              })[0]
            : null;
          // React may replace the verified composer node between polls. Rebind
          // the newly mounted empty composer only after rechecking the durable
          // thread route; never fall back across a route mismatch.
          const box = boundBox || freshCampaignBox || candidates[candidates.length - 1];
          if (expectedCampaignThreadId && box) {
            box.setAttribute('data-crm-campaign-recipient-thread', String(expectedCampaignThreadId));
          }
          if (!box) return { success: false, error: 'Không tìm thấy ô soạn Messenger', error_code: 'COMPOSER_NOT_FOUND', candidates: candidates.length };
          box.focus();
          const beforeText = normalizeComposerText(box.innerText || box.textContent || '');
          if (beforeText !== '') {
            return { success: false, error: 'Composer đang có text lạ', error_code: 'COMPOSER_NOT_EMPTY', composer_content_length: beforeText.length };
          }
          return { success: true, method: 'composer-ready' };
        },
        args: [messageText, strict_recipient_identity ? recipientThreadId : null]
      });
      let composer = composerPrepResult?.[0]?.result;

      if (composer?.success) {
        const insertResult = await dispatchTrustedText(tab.id, messageText);
        if (!insertResult.success) {
          composer = { success: false, method: 'cdp-insert-text', error: insertResult.error || 'CDP insert text failed', error_code: insertResult.error_code || 'CDP_INSERT_TEXT_FAILED' };
        } else {
          const composerSendResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (msgTxt, expectedThreadId, requireCampaignBinding) => {
              const currentThreadMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/);
              const currentThreadId = currentThreadMatch ? decodeURIComponent(currentThreadMatch[1]) : null;
              if (String(currentThreadId || '') !== String(expectedThreadId || '')) {
                return {
                  success: false,
                  error: 'Conversation changed before composer send',
                  error_code: 'THREAD_ROUTE_MISMATCH',
                  current_thread_id: currentThreadId
                };
              }
              const normalizeComposerText = (text) => {
                if (!text) return '';
                let norm = String(text).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
                norm = norm.replace(/\s+/g, ' ').trim();
                const lower = norm.toLowerCase();
                if (lower === 'aa' || lower === 'tin nhắn' || lower === 'soạn tin nhắn' || lower === 'message') return '';
                return norm;
              };
              const cleanupComposer = (box) => {
                try {
                  box.focus();
                  document.execCommand('selectAll', false, null);
                  document.execCommand('delete', false, null);
                } catch (_e) { /* best-effort */ }
              };
              const main = document.querySelector('div[role="main"]') || document;
              const candidates = [...main.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
                .filter((el) => {
                  const rect = el.getBoundingClientRect();
                  const label = (el.getAttribute('aria-label') || '').toLowerCase();
                  return rect.width > 0 && rect.height > 0 && !label.includes('search') && !label.includes('tìm kiếm');
                });
              const boundBox = candidates.find((el) => el.getAttribute('data-crm-campaign-recipient-thread') === String(expectedThreadId));
              const freshCampaignBox = requireCampaignBinding
                ? [...candidates].sort((left, right) => {
                    const leftRect = left.getBoundingClientRect();
                    const rightRect = right.getBoundingClientRect();
                    return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
                  })[0]
                : null;
              const box = boundBox || freshCampaignBox || candidates[candidates.length - 1];
              if (requireCampaignBinding && box && !boundBox) {
                box.setAttribute('data-crm-campaign-recipient-thread', String(expectedThreadId));
              }
              if (!box) return { success: false, error: 'Không tìm thấy ô soạn Messenger sau khi insert', error_code: 'COMPOSER_NOT_FOUND', candidates: candidates.length };

              const normalizedMsgTxt = normalizeComposerText(msgTxt);
              let afterText = '';
              for (let i = 0; i < 10; i += 1) {
                afterText = normalizeComposerText(box.innerText || box.textContent || '');
                if (afterText) break;
                await new Promise((resolve) => setTimeout(resolve, 70));
              }

              if (afterText === normalizedMsgTxt + normalizedMsgTxt) {
                cleanupComposer(box);
                return { success: false, error: 'Composer bị chèn lặp nội dung', error_code: 'COMPOSER_CONTENT_MISMATCH', composer_content_length: afterText.length };
              }
              if (afterText !== normalizedMsgTxt) {
                cleanupComposer(box);
                return { success: false, error: 'Nội dung composer không khớp sau khi insert', error_code: afterText ? 'COMPOSER_CONTENT_MISMATCH' : 'COMPOSER_CONTENT_MISSING', composer_content_length: afterText.length };
              }

              const isNotLikeButton = (el) => {
                if (!el) return false;
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();
                const combined = label + ' ' + title;
                if (/thích|like|cảm xúc|sticker|emoji|thả tim|biểu tượng|nhãn dán|icon|thumbs/i.test(combined)) return false;
                return true;
              };
              const findSendButton = () => {
                const candidates = [...document.querySelectorAll(
                  'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], ' +
                  'button[aria-label="Gửi"], [role="button"][aria-label="Gửi"], ' +
                  'button[aria-label="Send"], [role="button"][aria-label="Send"]'
                )];
                return candidates.find((btn) => isNotLikeButton(btn)) || null;
              };
              let sendButton = findSendButton();
              for (let i = 0; !sendButton && i < 10; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 75));
                sendButton = findSendButton();
              }
              const beforeSendMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/);
              const beforeSendThreadId = beforeSendMatch ? decodeURIComponent(beforeSendMatch[1]) : null;
              if (String(beforeSendThreadId || '') !== String(expectedThreadId || '')) {
                cleanupComposer(box);
                return {
                  success: false,
                  error: 'Conversation changed while preparing composer send',
                  error_code: 'THREAD_ROUTE_MISMATCH',
                  current_thread_id: beforeSendThreadId
                };
              }
              if (sendButton) {
                sendButton.click();
                await new Promise((resolve) => setTimeout(resolve, 500));
                const remaining = normalizeComposerText(box.innerText || box.textContent || '');
                if (remaining === '') {
                  return { success: true, method: 'composer-dom-click', aria_label: sendButton.getAttribute('aria-label'), composer_after_click: remaining };
                }
              }
              return {
                success: false,
                method: 'composer-enter-fallback',
                click_found: !!sendButton,
                click_label: sendButton?.getAttribute('aria-label') || null,
                composer_cleared: false,
                error: 'DOM click không thành công, chuyển sang CDP',
                error_code: 'ENTER_SUBMIT_FAILED'
              };
            },
            args: [messageText, recipientThreadId, strict_recipient_identity]
          });
          composer = composerSendResult?.[0]?.result;
        }
      }
      trace('COMPOSER_RESULT', { success: !!composer?.success, method: composer?.method || null, error_code: composer?.error_code || null, composer_cleared: composer?.composer_cleared ?? null });
      if (!composer?.success && ['ENTER_SUBMIT_FAILED', 'COMPOSER_SEND_CONTROL_NOT_FOUND'].includes(composer?.error_code)) {
        trace('CDP_ENTER_ATTEMPT', { adapter_version: TRUSTED_SEND_ADAPTER_VERSION, tab_id: tab.id });
        // Re-focus composer BEFORE sending Enter via CDP. After debugger
        // detach, browser focus may have moved to the 👍 Like button - pressing
        // Enter on that sends a reaction instead of the typed message.
        await refocusComposer(tab.id);
        const cdpResult = await dispatchTrustedEnter(tab.id);
        trace('CDP_ENTER_RESULT', { adapter_version: TRUSTED_SEND_ADAPTER_VERSION, success: !!cdpResult.success, error_code: cdpResult.error_code || null });
        if (cdpResult.success) {
          sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, stage: 'CDP_ENTER', error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION', error_code: 'COMPOSER_DISPATCHED' });
          if (strict_recipient_identity) await confirmFromRenderedBubble(tab.id, 'CDP_ENTER');
          else confirmFromRenderedBubble(tab.id, 'CDP_ENTER').catch(() => null);
          return;
        }
        composer.error = cdpResult.error || composer.error;
        composer.error_code = cdpResult.error_code || composer.error_code;
      }
      if (composer?.success) {
        console.log('[SEND_MESSAGE] ✅ Đã gửi qua Messenger composer fallback');
        // Chờ DOM/network observer xác nhận message thật; không tự gán message_id giả.
        sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION', stage: composer?.method === 'composer-dom-click' ? 'DOM_CLICK' : 'POLL_COMPOSER', error_code: 'COMPOSER_DISPATCHED' });
        if (strict_recipient_identity) await confirmFromRenderedBubble(tab.id, composer?.method || 'COMPOSER');
        else confirmFromRenderedBubble(tab.id, composer?.method || 'COMPOSER').catch(() => null);
      } else {
        const errMsg = composer?.error || tabRes?.error || lastSendError || 'Gửi tin nhắn qua Facebook thất bại';
        console.error('[SEND_MESSAGE] ❌ Gửi tin nhắn thất bại:', errMsg);
        sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: errMsg, error_code: composer?.error_code || 'FACEBOOK_SEND_REJECTED' });
        if (strict_recipient_identity) {
          const composerError = new Error(errMsg);
          composerError.code = composer?.error_code || 'FACEBOOK_SEND_REJECTED';
          throw composerError;
        }
      }
    }
  } catch (err) {
    console.error('[SEND_MESSAGE] ❌ Lỗi ngoại lệ Tab Context:', err.message);
    sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: err.message || lastSendError, error_code: err.code || 'FACEBOOK_SEND_EXCEPTION' });
    // Queue campaign calls need the rejection to reach
    // handleSendQueuedMessage; swallowing it here would emit a contradictory
    // QUEUED_MESSAGE_RESULT "dispatched" after the send was blocked.
    if (strict_recipient_identity) throw err;
  }
}

// ── Xử lý tin nhắn từ message_queue ──────────────────────────────────────────
async function validateRichQueuedEnvelope(payload) {
  return self.FbCrmQueueEnvelopeValidation.validateQueuedEnvelope(payload, {
    expectedAccountId: user_id
  });
}

// Feature 016: repeatedly checks for the Business Suite message composer
// instead of a single immediate check, mirroring the poll-loop idiom already
// used elsewhere in this file (e.g. waitForThreadDomReady) for DOM readiness
// that can't be pinned to a single "loaded" event. Business Suite's SPA
// render (see the loading-skeleton state confirmed live) can take longer than
// any single fixed delay, so this returns as soon as the composer appears
// rather than giving up (or checking too early) on one fixed wait.
async function pollForComposer(tabId, timeoutMs = 7000, intervalMs = 400) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.querySelectorAll('[contenteditable="true"], [role="textbox"]').length > 0
    }).catch(() => null);
    if (result?.[0]?.result) return true;
    await delay(intervalMs);
  }
  return false;
}

// ── CDP-based native file-chooser interception ─────────────────────────────
// Live testing found that Business Suite's attach icon no longer exposes a
// scriptable <input type="file"> - clicking it opens the OS-native file
// chooser directly (zero <input type="file"> elements exist in the DOM
// before or after that click). A script-dispatched click() also cannot open
// that chooser, since only a browser-trusted input event satisfies the
// activation requirement modern file pickers enforce - the same reason
// dispatchTrustedEnter/dispatchTrustedText use CDP instead of DOM events.
// Page.setInterceptFileChooserDialog covers both the classic <input> and
// native-picker cases: instead of the OS dialog appearing, Chrome emits
// Page.fileChooserOpened (with the file input's backendNodeId), answered
// here with DOM.setFileInputFiles and a real local path - the extension and
// backend always run on the same machine, so the staged attachment's bytes
// already exist on disk (see QueueWorker.buildAttachment's local_path).
// There is no "Page.handleFileChooser" CDP method - DOM.setFileInputFiles
// against the event's backendNodeId is the actual fulfillment call.
const pendingFileChoosers = new Map(); // tabId -> resolve(params)

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.fileChooserOpened') return;
  const resolve = pendingFileChoosers.get(source.tabId);
  if (resolve) {
    pendingFileChoosers.delete(source.tabId);
    resolve(params);
  }
});

function waitForFileChooserOpened(tabId, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFileChoosers.delete(tabId);
      reject(new Error('Hết thời gian chờ hộp thoại chọn file (Page.fileChooserOpened)'));
    }, timeoutMs);
    pendingFileChoosers.set(tabId, (params) => {
      clearTimeout(timer);
      resolve(params);
    });
  });
}

// Shared by both Business Suite and personal Messenger: the attach icon's
// accessible label has been observed as either "Đính kèm file" (generic) or
// split into "Đính kèm ảnh" / "Đính kèm PDF" on Business Suite. Personal
// Messenger's real label ("Đính kèm file có kích thước tối đa là 100MB") was
// confirmed live 2026-08-13 via DevTools inspection (the button is a
// `<div role="button" aria-label="...">`, not a real `<button>`, but the
// aria-label selector still matches it). If staging ever fails again with
// "Không tìm thấy icon đính kèm", check the real label live rather than
// guessing further blind.
async function findAttachButtonCenter(tabId, timeoutMs = 6000, preferredKind = 'file') {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (payload) => {
      // Exact-match labels for Business Suite, plus a starts-with match for
      // personal Messenger's longer label ("Đính kèm file có kích thước tối
      // đa là ...MB") - a prefix match avoids depending on getting every
      // diacritic in the trailing, size-dependent portion exactly right.
      const exactLabels = [
        'Đính kèm file', 'Đính kèm ảnh', 'Đính kèm PDF', 'Đính kèm tệp', 'Đính kèm hình ảnh',
        'Thêm file', 'Thêm ảnh', 'Attach a file', 'Attach photo', 'Attach file',
        'Đính kèm ảnh/video', 'Thêm ảnh/video', 'Attach photo or video', 'Attach video',
        'Đính kèm file hoặc ảnh', 'Đính kèm ảnh hoặc video', 'Mở tính năng chọn ảnh', 'Chọn ảnh'
      ];
      const prefixLabels = [
        'Đính kèm file', 'Đính kèm tệp', 'Đính kèm ảnh', 'Đính kèm hình ảnh', 'Đính kèm', 'Thêm file', 'Thêm ảnh', 'Attach',
        'Mở tính năng chọn ảnh', 'Chọn ảnh'
      ];
      const normalizeLabel = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const scoreForKind = (element, composerRect = null) => {
        const rawLabel = String(element.getAttribute('aria-label') || '');
        const label = normalizeLabel(`${rawLabel} ${element.getAttribute('title') || ''}`);
        let score = 0;
        if (label.includes('dinh kem') || label.includes('attach') || label.includes('them')) score += 10;
        if (payload.preferredKind === 'video') {
          if (label.includes('video')) score += 120;
          if (label.includes('file') || label.includes('tep')) score += 70;
          if (label.includes('anh') || label.includes('photo') || label.includes('image')) score += 60;
        } else if (payload.preferredKind === 'image') {
          if (label.includes('anh') || label.includes('photo') || label.includes('image')) score += 120;
          if (label.includes('file') || label.includes('tep')) score += 40;
        } else {
          if (label.includes('file') || label.includes('tep') || label.includes('pdf')) score += 100;
          if (label.includes('anh') || label.includes('photo') || label.includes('image')) score -= 80;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          score += 20;
          // Proximity scoring: heavily prioritize attach button near the active chat composer
          // and penalize unrelated buttons in sidebar/top nav (e.g. "Thư viện video").
          if (composerRect) {
            const dy = Math.abs((rect.top + rect.bottom) / 2 - (composerRect.top + composerRect.bottom) / 2);
            const dx = Math.abs((rect.left + rect.right) / 2 - (composerRect.left + composerRect.right) / 2);
            if (dy <= 160) {
              score += 300;
              if (dx <= 600) score += 100;
            } else if (dy > 300) {
              score -= 250;
            }
          }
        }
        // Exact match boost for verified Business Suite paperclip and Messenger attach buttons
        if (/^(đính kèm file|đính kèm tệp|đính kèm ảnh|đính kèm hình ảnh|attach a file|attach file|attach photo)/i.test(rawLabel.trim())) {
          score += 150;
        }
        if (element.getAttribute('role') === 'button' || element.tagName === 'BUTTON') {
          score += 30;
        }
        return score;
      };
      const find = () => {
        const visibleComposers = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const label = String(element.getAttribute('aria-label') || '').toLowerCase();
            return rect.width > 10 && rect.height > 10 && !label.includes('search') && !label.includes('tìm kiếm');
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return rightRect.bottom - leftRect.bottom;
          });
        const activeComposer = visibleComposers[0] || null;
        const composerRect = activeComposer ? activeComposer.getBoundingClientRect() : null;
        const composerScope = activeComposer
          ? (activeComposer.closest('form, footer, [data-surface*="composer"], div[role="main"]') || activeComposer.parentElement?.parentElement?.parentElement || document)
          : document;

        const candidates = new Set();
        for (const label of exactLabels) {
          composerScope.querySelectorAll(`[aria-label="${label}"]`).forEach((element) => candidates.add(element));
          document.querySelectorAll(`[aria-label="${label}"]`).forEach((element) => candidates.add(element));
        }
        for (const prefix of prefixLabels) {
          composerScope.querySelectorAll(`[aria-label^="${prefix}"]`).forEach((element) => candidates.add(element));
          document.querySelectorAll(`[aria-label^="${prefix}"]`).forEach((element) => candidates.add(element));
        }
        composerScope.querySelectorAll('[role="button"][aria-label], button[aria-label]').forEach((element) => {
          const label = normalizeLabel(element.getAttribute('aria-label'));
          if (label.includes('dinh kem') || label.includes('attach')) candidates.add(element);
        });
        document.querySelectorAll('[aria-label]').forEach((element) => {
          const label = normalizeLabel(element.getAttribute('aria-label'));
          if (label.includes('dinh kem') || label.includes('attach')) candidates.add(element);
        });
        const ranked = [...candidates].sort((left, right) => scoreForKind(right, composerRect) - scoreForKind(left, composerRect));
        if (ranked.length && scoreForKind(ranked[0], composerRect) > 0) return ranked[0];
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        const desired = String(payload.preferredKind || 'file');
        const compatible = fileInputs.find((input) => {
          const accept = String(input.getAttribute('accept') || '').toLowerCase();
          if (!accept) return true;
          if (desired === 'video') return /video|mp4|mov|webm|avi/.test(accept);
          if (desired === 'image') return /image|photo|png|jpe?g|webp/.test(accept);
          return true;
        });
        if (compatible) {
          const clickTarget = compatible.closest('[role="button"], button, label') || compatible.parentElement || compatible;
          const targetRect = clickTarget.getBoundingClientRect();
          if (targetRect.width > 0 && targetRect.height > 0) return clickTarget;
        }
        return compatible ? (compatible.parentElement || compatible) : null;
      };
      const deadline = Date.now() + (payload.timeoutMs || 6000);
      let el = find();
      while (!el && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        el = find();
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    args: [{ timeoutMs, preferredKind }]
  });
  return execution?.[0]?.result || null;
}

// Spec 040 T020: two independent live sends (2026-08-17, a 2-file .txt
// manifest then a 2-file .png image manifest, both to the same authorized
// test thread) showed the fixed 800ms delay below was not proof the
// attachment ever registered - both times the caption sent and Facebook
// confirmed it, but zero files ever appeared in the real thread, with no
// error surfaced anywhere in the pipeline. A third live test (still
// 2026-08-17) proved the attach step itself is NOT the problem: Business
// Suite staged both files fine as generic-file preview chips, displayed by
// their on-disk storage filename (the hashed basename of local_path, e.g.
// "c414cd...ce77.png") - NOT the original upload name - so this polls for
// that basename, plus a new blob: image as a fallback signal for whatever
// Facebook's image-preview markup turns out to be. Any one signal appearing
// for a given file counts - the point is only to rule out "nothing happened
// at all", not to model Facebook's exact markup. Scoped to the file/manifest
// path only (media_type 'file', or any manifest) - the plain single-image
// path already has a live-verified-working 800ms delay (.env: "Page image:
// verified 2026-08-12") and is left untouched to avoid regressing it without
// its own live re-verification.
async function pollForAttachmentEvidence(tabId, fileNames, timeoutMs = 8000, intervalMs = 400) {
  const names = fileNames.filter(Boolean);
  const baseline = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.querySelectorAll('img[src^="blob:"]').length
  }).then((r) => r?.[0]?.result || 0).catch(() => 0);
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (searchNames) => {
        const blobImages = document.querySelectorAll('img[src^="blob:"]').length;
        const haystacks = [document.body.innerText || ''];
        document.querySelectorAll('[aria-label]').forEach((el) => haystacks.push(el.getAttribute('aria-label') || ''));
        const text = haystacks.join('\n');
        return { blobImages, matchedNames: searchNames.filter((name) => text.includes(name)) };
      },
      args: [names]
    }).catch(() => null);
    const r = result?.[0]?.result;
    if (r && (r.blobImages > baseline || r.matchedNames.length >= names.length)) {
      return { ok: true, blobImages: r.blobImages, matchedNames: r.matchedNames };
    }
    await delay(intervalMs);
  }
  return { ok: false };
}

// Core CDP mechanic shared by every surface that stages an attachment via
// file-chooser interception (see Decision 9 in research.md): intercept the
// native chooser, CDP-click the attach control to open it, then fulfill it
// with DOM.setFileInputFiles against the backendNodeId the chooser reports.
// attachmentOrList: a single attachment object (spec 039 shape, unchanged)
// or an array of attachment objects (spec 040 manifest - several
// independently-selected files, or one folder ZIP as its single member).
// DOM.setFileInputFiles natively accepts multiple paths in one call, so a
// manifest attaches in the same one file-chooser interaction as a lone file
// - not verified live yet whether Facebook's composer actually keeps every
// member as a separate attachment vs. only the first; do not enable
// RICH_MESSAGE_*_FILE_ENABLED for more than one file per message until that
// live check happens (see research.md/quickstart.md).
async function stageAttachmentViaFileChooser(tabId, point, attachmentOrList, { preferDirectInput = false } = {}) {
  const items = Array.isArray(attachmentOrList) ? attachmentOrList : [attachmentOrList];
  const paths = items.map((item) => item.local_path);
  const isFileTransport = Array.isArray(attachmentOrList) || attachmentOrList?.media_type === 'file';
  const mediaKind = items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').startsWith('video/'))
    ? 'video'
    : items.some((item) => item?.media_type === 'image' || String(item?.mime_type || '').startsWith('image/'))
      ? 'image'
      : 'file';
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Page.enable');
    await chrome.debugger.sendCommand(target, 'DOM.enable');
    let chooserParams = null;

    if (preferDirectInput) {
      try {
        const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(() => {
            const desiredKind = ${JSON.stringify(mediaKind)};
            const visibleComposerControl = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                const label = String(element.getAttribute('aria-label') || '').toLowerCase();
                return rect.width > 0 && rect.height > 0 && !label.includes('search') && !label.includes('tìm kiếm');
              })
              .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
              })[0] || null;
            const composerScope = visibleComposerControl?.closest('[role="main"]') || document;
            const newestFirst = [...composerScope.querySelectorAll('input[type="file"]')].reverse();
            const acceptsKind = (input) => {
              const accept = String(input.getAttribute('accept') || '').toLowerCase();
              if (!accept) return true;
              if (desiredKind === 'video') return /video|mp4|mov|webm|avi|\*/.test(accept);
              if (desiredKind === 'image') return /image|photo|png|jpe?g|webp|\*/.test(accept);
              return true;
            };
            // Prefer an input that explicitly accepts the requested media kind.
            // A generic accept="" input is only a fallback; taking it first can
            // route MP4 into an unrelated uploader mounted elsewhere in main.
            const explicitInput = newestFirst.find((input) => {
              const accept = String(input.getAttribute('accept') || '').toLowerCase();
              return Boolean(accept) && acceptsKind(input);
            }) || null;
            const genericInput = newestFirst.find((input) => !String(input.getAttribute('accept') || '').trim()) || null;
            const matchingInput = explicitInput || genericInput;
            // Never push a video into an image-only input. If Messenger has not
            // mounted a compatible input yet, use the trusted chooser path.
            return matchingInput || (desiredKind === 'file' ? newestFirst[0] : null);
          })()`,
          returnByValue: false
        }).catch(() => null);

        if (evaluated?.result?.objectId && evaluated?.result?.subtype === 'node') {
          const nodeResult = await chrome.debugger.sendCommand(target, 'DOM.requestNode', {
            objectId: evaluated.result.objectId
          }).catch(() => null);

          if (nodeResult?.nodeId) {
            await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
              files: paths,
              nodeId: nodeResult.nodeId
            });

            await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
              objectId: evaluated.result.objectId,
              functionDeclaration: `function() {
                try {
                  this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                } catch (e) {}
              }`
            }).catch(() => null);

            chooserParams = { nodeId: nodeResult.nodeId, directSuccess: true };
          }
        }
      } catch (directError) {
        console.warn('[FB Engine] Direct file input failed, falling back to file chooser dialog interception:', directError?.message || directError);
        chooserParams = null;
      }
    }

    if (!chooserParams?.directSuccess) {
      if (!point) {
        const pointError = new Error('Không tìm thấy icon đính kèm hoặc input file của Messenger');
        pointError.code = 'ATTACHMENT_STAGE_FAILED';
        throw pointError;
      }
      await chrome.debugger.sendCommand(target, 'Page.setInterceptFileChooserDialog', { enabled: true });
      try {
        const chooserOpened = waitForFileChooserOpened(tabId, 8000);
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
        });
        chooserParams = await chooserOpened;
      } catch (error) {
        console.warn('[FB Engine] fileChooserOpened timeout, attempting DOM fallback for input[type="file"]');
        if (mediaKind !== 'file') throw error;
        const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument').catch(() => null);
        if (doc?.root) {
          const node = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: 'input[type="file"]'
          }).catch(() => null);
          if (node?.nodeId) chooserParams = { nodeId: node.nodeId };
        }
        if (!chooserParams) throw error;
      }

      if (!chooserParams?.backendNodeId && !chooserParams?.nodeId && !chooserParams?.objectId) {
        throw new Error('Không xác định được input file của Messenger');
      }
      await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
        files: paths,
        ...(chooserParams.objectId
          ? { objectId: chooserParams.objectId }
          : chooserParams.backendNodeId
            ? { backendNodeId: chooserParams.backendNodeId }
            : { nodeId: chooserParams.nodeId })
      });
    }

    if (isFileTransport) {
      const basenames = paths.map((filePath) => filePath.split(/[\\/]/).pop());
      const evidence = await pollForAttachmentEvidence(tabId, basenames);
      if (!evidence.ok) {
        const error = new Error('Facebook không hiển thị bằng chứng đã nhận file đính kèm sau khi chọn file');
        error.code = 'ATTACHMENT_STAGE_FAILED';
        throw error;
      }
    } else {
      // Only yield for Messenger to mount its upload state. The dedicated
      // readiness poll below is the real gate, so a fixed 3.5s video sleep
      // only added latency even when Facebook accepted the file instantly.
      await delay(250);
    }
  } finally {
    try { await chrome.debugger.sendCommand(target, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch (error) {}
    try { await chrome.debugger.detach(target); } catch (error) {}
  }
}
function assertValidImageAttachment(attachment) {
  // Kept under the old name for compatibility with the image path, but the
  // campaign file transport intentionally accepts any backend-validated file.
  if (!attachment || !attachment.local_path || !attachment.mime_type) {
    const error = new Error('Attachment không hợp lệ hoặc không được hỗ trợ');
    error.code = 'ATTACHMENT_INVALID';
    throw error;
  }
}

function assertValidAttachmentOrManifest(attachmentOrList) {
  const list = Array.isArray(attachmentOrList) ? attachmentOrList : [attachmentOrList];
  if (Array.isArray(attachmentOrList) && list.length === 0) {
    const error = new Error('Manifest đính kèm không có file nào');
    error.code = 'ATTACHMENT_INVALID';
    throw error;
  }
  list.forEach(assertValidImageAttachment);
}

async function stageBusinessSuiteAttachment(tabId, attachmentOrManifest) {
  if (!attachmentOrManifest) return;
  assertValidAttachmentOrManifest(attachmentOrManifest);

  const uploader = self.FbPageVideoUploader || (typeof FbPageVideoUploader !== 'undefined' ? FbPageVideoUploader : null);
  const preferredKind = uploader && typeof uploader.resolvePreferredKind === 'function'
    ? uploader.resolvePreferredKind(attachmentOrManifest)
    : (Array.isArray(attachmentOrManifest)
        ? (attachmentOrManifest.some((i) => i?.media_type === 'video') ? 'video' : 'file')
        : (attachmentOrManifest?.media_type === 'video' ? 'video' : 'file'));

  const point = await findAttachButtonCenter(tabId, 6000, preferredKind);
  if (!point) {
    const error = new Error('Không tìm thấy icon đính kèm của Business Suite');
    error.code = 'ATTACHMENT_STAGE_FAILED';
    throw error;
  }

  try {
    await stageAttachmentViaFileChooser(tabId, point, attachmentOrManifest, {
      preferDirectInput: false
    });

    if (preferredKind === 'video' && uploader && typeof uploader.pollForBusinessSuiteVideoReadiness === 'function') {
      const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
      const basenames = items.map((i) => (i?.local_path || '').split(/[\\/]/).pop()).filter(Boolean);
      await uploader.pollForBusinessSuiteVideoReadiness(tabId, basenames, chrome.scripting, 10000);
    }
  } catch (error) {
    const wrapped = new Error(error?.message || 'Business Suite không nhận attachment');
    wrapped.code = 'ATTACHMENT_STAGE_FAILED';
    throw wrapped;
  }
}

// Personal Messenger's exact composer/send-control DOM has not been verified
// live yet (unlike Business Suite's, which was confirmed via T025/T054 live
// testing) - this mirrors the same proven CDP file-chooser + DOM-click-send
// mechanism, but findAttachButtonCenter's personal-Messenger labels are best
// guesses. Do not enable RICH_MESSAGE_PERSONAL_IMAGE_ENABLED until a live
// send has actually been confirmed the same way Page's was.
async function stagePersonalMessengerAttachment(tabId, attachmentOrManifest) {
  if (!attachmentOrManifest) return;
  assertValidAttachmentOrManifest(attachmentOrManifest);

  const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
  const preferredKind = items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').startsWith('video/'))
    ? 'video'
    : items.some((item) => item?.media_type === 'image' || String(item?.mime_type || '').startsWith('image/'))
      ? 'image'
      : 'file';
  try {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const point = await findAttachButtonCenter(tabId, 6000, preferredKind);
      try {
        // Video trước đây bị ép đi đường chặn hộp thoại chọn file - menu
        // đính kèm của Messenger thường không mở native chooser kịp -> đạn
        // CAMERA_STAGE chết cả 2 lượt. Đường set file trực tiếp vào input
        // (đã chứng minh với ảnh) chấp nhận video khi accept cho phép, nên
        // dùng làm đường chính cho mọi loại; chooser chỉ là fallback.
        await stageAttachmentViaFileChooser(tabId, point, attachmentOrManifest, {
          preferDirectInput: true
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= 2) break;
        console.warn(`[FB Engine] Attachment staging attempt ${attempt} failed (${error?.code || error?.message}); resetting composer draft and retrying once`);
        dirtyAttachmentDraftTabs.add(tabId);
        await isolateFailedMediaDraftBeforeSend(tabId).catch(() => null);
        await delay(500);
      }
    }
    throw lastError;
  } catch (error) {
    const wrapped = new Error(error?.message || 'Messenger không nhận attachment');
    wrapped.code = 'ATTACHMENT_STAGE_FAILED';
    throw wrapped;
  }
}

// Focus the composer, type the caption (if any), then submit. Proven pattern
// (already used by handleSendMessage's plain-text composer fallback below):
// a native DOM click on the real send control first - Facebook's actual
// aria-label is "Nhấn Enter để gửi", not "Gửi"/"Send" - falling back to CDP
// Enter only if that click can't be found/doesn't clear the composer. An
// earlier attempt here used a CDP-simulated pixel-coordinate click on the
// wrong label and was never actually confirmed working live; the "success"
// seen during that test turned out to be the operator manually clicking
// Send out of impatience, not the code.
async function typeAndSubmitComposer(tabId, content) {
  const composerPrepResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Spec 040 T020: "last textbox in DOM order" was proven correct on a
      // bare composer, but with a file/manifest attachment staged, Business
      // Suite's generic-file preview chip adds its own [role="textbox"]-like
      // element (it shows/edits the filename) - "last" then no longer
      // reliably lands on the actual message composer. Confirmed live
      // 2026-08-17: a manual send through the real composer worked
      // perfectly, but the automated flow consistently typed/sent through
      // something else, dropping the staged files with zero error. Prefer a
      // true contenteditable node (Facebook's real composer) over a plain
      // role=textbox, and among those pick the largest by rendered area -
      // the real message input is reliably bigger than an inline filename
      // field or similar incidental control.
      const candidates = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')];
      if (!candidates.length) return { success: false, error: 'Không tìm thấy ô soạn tin nhắn' };
      const scored = candidates.map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, area: rect.width * rect.height, isContentEditable: el.getAttribute('contenteditable') === 'true' };
      });
      const contentEditableOnly = scored.filter((c) => c.isContentEditable);
      const pool = contentEditableOnly.length ? contentEditableOnly : scored;
      pool.sort((a, b) => b.area - a.area);
      const box = pool[0].el;
      box.focus();
      return { success: true, candidateCount: candidates.length, chosenArea: pool[0].area };
    }
  });

  if (!composerPrepResult?.[0]?.result?.success) {
    throw new Error(composerPrepResult?.[0]?.result?.error || 'Lỗi chuẩn bị ô soạn tin nhắn');
  }
  // Diagnostic only (spec 040 T020) - relayed to the backend since the
  // service worker's own console isn't reachable during live debugging;
  // cheap enough to always send, not gated behind the file-transport path.
  sendToBackend('COMPOSER_DEBUG', { stage: 'prep', ...composerPrepResult[0].result });

  if (content) {
    const insertResult = await dispatchTrustedText(tabId, content);
    if (!insertResult.success) {
      throw new Error('CDP Insert Text failed: ' + insertResult.error);
    }
  }

  await delay(100);

  const clickResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const SEND_SELECTOR = 'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], ' +
        'button[aria-label="Gửi"], [role="button"][aria-label="Gửi"], ' +
        'button[aria-label="Send"], [role="button"][aria-label="Send"]';
      const isNotLikeButton = (el) => {
        if (!el) return false;
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const combined = label + ' ' + title;
        if (/thích|like|cảm xúc|sticker|emoji|thả tim|biểu tượng|nhãn dán|icon|thumbs/i.test(combined)) return false;
        return true;
      };
      const isTextSendButton = (el) => {
        if (!el.matches?.('button, [role="button"]')) return false;
        if (!isNotLikeButton(el)) return false;
        const text = (el.textContent || '').trim();
        return /^(Gửi|Send)$/i.test(text);
      };
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const isReadySendButton = (el) => el && visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isNotLikeButton(el);
      const findInScope = (scope) => {
        const labelledCandidates = [...(scope.querySelectorAll?.(SEND_SELECTOR) || [])];
        const labelled = labelledCandidates.find(isReadySendButton);
        if (labelled) return labelled;
        return [...(scope.querySelectorAll?.('button, [role="button"]') || [])]
          .find((el) => isTextSendButton(el) && isReadySendButton(el)) || null;
      };
      // Spec 040 T020: an unscoped document-wide search can match an
      // unrelated "Gửi"/"Send"-labeled control elsewhere on Business Suite's
      // page instead of the composer's own send button, silently clicking
      // the wrong one while the real composer (with its staged files) is
      // never submitted. Walk up from the currently-focused composer box
      // (set by the previous executeScript call - focus persists across
      // separate calls since it's page state) and search each ancestor's own
      // subtree first, only falling back to a global search if none of them
      // contain a matching control.
      const findSendButton = () => {
        let scope = document.activeElement;
        for (let i = 0; scope && i < 8; i += 1) {
          const found = findInScope(scope);
          if (found) return found;
          scope = scope.parentElement;
        }
        return findInScope(document);
      };
      let sendButton = findSendButton();
      for (let i = 0; !sendButton && i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        sendButton = findSendButton();
      }
      if (!sendButton) return { success: false, error: 'Không tìm thấy nút Gửi' };
      const composerBefore = document.activeElement;
      const textBefore = (composerBefore?.innerText || composerBefore?.textContent || '').trim();
      const sendRect = sendButton.getBoundingClientRect();
      const hasValidRect = sendRect.width > 0 && sendRect.height > 0;
      const buttonCenter = hasValidRect
        ? { x: sendRect.left + sendRect.width / 2, y: sendRect.top + sendRect.height / 2 }
        : null;
      if (!textBefore) {
        return { success: false, error: 'Attachment-only message requires trusted CDP click', button_center: buttonCenter, aria_label: sendButton.getAttribute('aria-label') };
      }
      sendButton.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Spec 040 T020: confirmed live 2026-08-18 - a script-dispatched
      // .click() on a real, correctly-matched send button can report success
      // (the call itself never throws) while doing nothing at all - the
      // composer was still sitting there as an untouched draft afterward,
      // files and caption both still staged. This mirrors the exact reason
      // the file-chooser needs a CDP-dispatched trusted mouse event instead
      // of element.click() elsewhere in this file - Facebook's send control
      // likely also requires a trusted event. Verify the composer actually
      // emptied out before trusting this path; if not, report failure so the
      // caller falls through to the CDP Enter fallback below, which is the
      // one mechanism live-confirmed to actually submit in this state.
      const textAfter = (composerBefore?.innerText || composerBefore?.textContent || '').trim();
      if (textBefore && textAfter === textBefore) {
        return { success: false, error: 'Bấm nút Gửi không xóa được nội dung composer (có thể click không phải trusted event)', aria_label: sendButton.getAttribute('aria-label'), button_center: buttonCenter };
      }
      return { success: true, aria_label: sendButton.getAttribute('aria-label') };
    }
  });

  sendToBackend('COMPOSER_DEBUG', { stage: 'send_click', ...(clickResult?.[0]?.result || { success: false, error: 'no_result' }) });

  if (!clickResult?.[0]?.result?.success) {
    const clickDetails = clickResult?.[0]?.result || {};
    console.log('[FB Engine] DOM send did not dispatch; trying trusted CDP send:', clickDetails.error);
    let cdpResult = null;
    const hasValidCenter = clickDetails.button_center &&
      clickDetails.button_center.x > 0 &&
      clickDetails.button_center.y > 0;
    if (hasValidCenter) {
      cdpResult = await dispatchTrustedPointerClick(tabId, clickDetails.button_center);
      sendToBackend('COMPOSER_DEBUG', { stage: 'trusted_send_click', ...cdpResult, button_center: clickDetails.button_center });
      // Exactly one trusted submit per attachment. Messenger keeps a normal
      // Send control mounted after a successful media send, so using that as
      // proof that the draft remained and pressing Enter again duplicated the
      // image (and could poison the following text/video send).
      sendToBackend('COMPOSER_DEBUG', { stage: 'trusted_send_single_dispatch', ...cdpResult });
    } else {
      const focusResult = await refocusComposer(tabId);
      if (!focusResult?.success) {
        const focusError = new Error(focusResult?.error || 'Không thể focus đúng ô soạn tin trước khi gửi');
        focusError.code = 'COMPOSER_FOCUS_FAILED';
        throw focusError;
      }
      cdpResult = await dispatchTrustedEnter(tabId);
      sendToBackend('COMPOSER_DEBUG', { stage: 'trusted_send_enter', ...cdpResult });
    }
    if (!cdpResult?.success) {
      const sendError = new Error('Trusted composer send failed: ' + (cdpResult?.error || 'unknown error'));
      sendError.code = cdpResult?.error_code || 'TRUSTED_COMPOSER_SEND_FAILED';
      throw sendError;
    }
    await delay(300);
  }
}

async function handleSendPageMessage({ thread_id, content, page_id, client_message_id, attachment = null, attachmentManifest = null, expected_contact_name = null }) {
  console.log(`[FB Engine] 📤 Bắt đầu gửi qua Business Suite: page_id=${page_id} thread=${thread_id} expected_name=${expected_contact_name || 'none'}`);

  if (page_id) {
    const pid = String(page_id);
    const tid = String(thread_id || '');
    pageNavigationLockThreadId.set(pid, tid);
    pageNavigationLockUntil.set(pid, Date.now() + 30000);
    console.log(`[FB Engine] [PAGE_NAV_LOCK] Send action locked page=${pid} to thread=${tid}`);
  }

  // Extract recipient PSID from thread_id (format is "page:pageId:recipientPsid" or "sourceId:recipientPsid" or just "recipientPsid")
  const recipientPsid = extractBareThreadId(thread_id);
  const targetUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(page_id)}&mailbox_id=${encodeURIComponent(page_id)}&selected_item_id=${encodeURIComponent(recipientPsid)}&thread_type=FB_MESSAGE`;

  const role = `page:${page_id}`;
  let tab = await getBusinessSuiteTab(page_id);

  if (!tab) {
    if (await isTabCreationOnCooldown(role)) {
      throw new Error(`Tab Business Suite cho page_id=${page_id} đang trong cooldown (vừa bị lật identity), bỏ qua lần gửi này.`);
    }
    console.log(`[FB Engine] Không tìm thấy tab Business Suite cho page_id=${page_id}. Tạo tab nền mới.`);
    tab = await tabCreationCoordinator.run(
      role,
      () => getBusinessSuiteTab(page_id),
      async () => {
        const created = await new Promise(resolve => {
          // Business Suite sống TRONG CÙNG cửa sổ với Messenger cá nhân
          // (yêu cầu 2026-09-18: bỏ chế độ 2 cửa sổ Chrome riêng cho Page).
          // Ghim vào window chứa tab Messenger của tài khoản để tab không
          // bao giờ rơi vào một cửa sổ thứ hai.
          chrome.tabs.query({ url: ['*://www.facebook.com/messages/*', '*://web.facebook.com/messages/*'] }, (msgTabs) => {
            const personalWindowId = msgTabs && msgTabs.length ? msgTabs[0].windowId : undefined;
            chrome.tabs.create({ url: targetUrl, active: false, pinned: true, windowId: personalWindowId }, (createdTab) => {
              resolve(createdTab);
            });
          });
        });
        if (created?.id) {
          await registerTab(role, created.id);
          await Promise.race([waitForTabComplete(created.id, 10000), delay(4000)]);
          const settled = await chrome.tabs.get(created.id).catch(() => null);
          if (!settled || !isBusinessSuiteUrl(settled.url) || !String(settled.url || '').includes(`asset_id=${page_id}`)) {
            await unregisterTab(role);
            await startTabCreationCooldown(role);
            throw new Error(`Tab Business Suite cho page_id=${page_id} không ổn định vào đúng trang sau khi mở (identity dùng chung).`);
          }
          return settled;
        }
        return created || null;
      }
    );
  }

  if (!tab) {
    sendToBackend('SEND_MESSAGE_RESULT', { thread_id, client_message_id, success: false, error: 'Không tìm thấy hoặc không thể mở Tab Business Suite', error_code: 'FACEBOOK_TAB_NOT_FOUND' });
    throw new Error('Không tìm thấy Tab Business Suite');
  }

  // Đảm bảo tab đã ở đúng hội thoại (dù tab vừa mở hay đã mở sẵn từ trước)
  const onCorrectThread = await ensureTabOnThread(tab, recipientPsid, targetUrl, page_id, null, expected_contact_name);
  if (!onCorrectThread) {
    console.log(`[FB Engine] Business Suite chưa vào đúng recipientPsid=${recipientPsid}, thử tabs.update...`);
    await chrome.tabs.update(tab.id, { url: targetUrl });
    await Promise.race([waitForTabComplete(tab.id, 8000), delay(3000)]);
    await delay(1200);
  }

  // Dọn dẹp bản nháp hoặc gợi ý cũ nếu có trước khi soạn thảo
  await resetFailedBusinessSuiteComposerDraft(tab.id).catch(() => null);

  // Vòng lặp chờ ô soạn thảo và so khớp danh tính thực tế trên DOM
  const interactionDeadline = Date.now() + 10000;
  let interactionState = null;
  while (Date.now() < interactionDeadline) {
    interactionState = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (targetThreadId) => {
        const main = document.querySelector('div[role="main"]') || document;
        const composer = [...main.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
          .find((element) => {
            const rect = element.getBoundingClientRect();
            const label = (element.getAttribute('aria-label') || '').toLowerCase();
            return rect.width > 0 && rect.height > 0 && !label.includes('search') && !label.includes('tìm kiếm');
          });

        const heading = main.querySelector('header h1, header h2, h1, h2, span[aria-level="1"], span[aria-level="2"], [data-surface*="contact_name"]');
        const headingName = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
        const composerLabel = (composer?.getAttribute('aria-label') || '').trim();
        const visibleContactName = headingName || composerLabel.replace(/^(?:Viết cho|Write to)\s+/i, '').trim() || null;

        const selected = document.querySelector('[role="navigation"] [aria-selected="true"], [role="gridcell"] [aria-selected="true"], [data-surface*="thread_list"] [aria-selected="true"], [aria-selected="true"]');
        let selectedThreadId = null;
        if (selected) {
          const links = selected.tagName === 'A' ? [selected] : Array.from(selected.querySelectorAll('a[href]'));
          for (const l of links) {
            const m = l.href?.match(/(?:selected_item_id|thread_id)=(\d+)/);
            if (m) { selectedThreadId = m[1]; break; }
          }
        }
        const routeMatch = location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
        const currentThreadId = selectedThreadId || (routeMatch ? decodeURIComponent(routeMatch[1]) : null);

        return {
          current_thread_id: currentThreadId,
          composer_ready: Boolean(composer),
          visible_contact_name: visibleContactName,
          route_ready: String(currentThreadId || '') === String(targetThreadId || '')
        };
      },
      args: [recipientPsid]
    }).then((rows) => rows?.[0]?.result || null).catch(() => null);

    if (interactionState?.route_ready && interactionState?.composer_ready) {
      if (!expected_contact_name || interactionState?.visible_contact_name) break;
    }
    await delay(300);
  }

  if (!interactionState?.composer_ready) {
    const composerReady = await pollForComposer(tab.id, 5000);
    if (!composerReady) {
      throw new Error('Không tìm thấy ô soạn tin nhắn Business Suite');
    }
  }

  // Chốt chặn 1: Thread ID trên DOM
  const verifiedThreadId = interactionState?.current_thread_id || await getCurrentThreadIdInTab(tab.id);
  if (verifiedThreadId && String(verifiedThreadId) !== String(recipientPsid)) {
    console.error(`[FB Engine] 🛑 Chặn gửi nhầm: Tab Business Suite đang mở thread ${verifiedThreadId}, nhưng đích là ${recipientPsid}`);
    sendToBackend('SEND_MESSAGE_RESULT', {
      thread_id,
      client_message_id,
      success: false,
      error: `Tab Business Suite chưa ở đúng thread mục tiêu (đang mở ${verifiedThreadId} thay vì ${recipientPsid})`,
      error_code: 'THREAD_ROUTE_MISMATCH'
    });
    throw new Error(`Tab Business Suite chưa ở đúng thread mục tiêu (đang mở ${verifiedThreadId} thay vì ${recipientPsid})`);
  }

  // Chốt chặn 2: Tên người nhận trên Header (Identity Check - chống gửi nhầm người)
  const visibleContactName = interactionState?.visible_contact_name;
  const normalizeIdentity = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
  if (expected_contact_name && visibleContactName && normalizeIdentity(visibleContactName) !== normalizeIdentity(expected_contact_name)) {
    console.error(`[FB Engine] 🛑 Chặn gửi nhầm: Khung chat Business Suite đang mở "${visibleContactName}" thay vì "${expected_contact_name}"`);
    sendToBackend('SEND_MESSAGE_RESULT', {
      thread_id,
      client_message_id,
      success: false,
      error: `Business Suite contact identity does not match (${visibleContactName} vs ${expected_contact_name}); send blocked`,
      error_code: 'CONTACT_IDENTITY_MISMATCH'
    });
    throw new Error(`Business Suite contact identity mismatch: ${visibleContactName} !== ${expected_contact_name}`);
  }

  try {
    const attachmentPayload = attachmentManifest || attachment;
    if (attachmentPayload) {
      await stageBusinessSuiteAttachment(tab.id, attachmentPayload);
      await waitForBusinessSuiteAttachmentReady(tab.id, attachmentPayload);
    }

    await typeAndSubmitComposer(tab.id, content);
  } catch (error) {
    await resetFailedBusinessSuiteComposerDraft(tab.id).catch(() => null);
    throw error;
  }

  console.log('[FB Engine] ✅ Đã dispatch tin nhắn qua Business Suite');
  sendToBackend('SEND_MESSAGE_RESULT', {
    thread_id,
    client_message_id,
    success: false,
    error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION',
    stage: 'BUSINESS_SUITE_CDP',
    error_code: 'COMPOSER_DISPATCHED'
  });
}

async function handleSendQueuedMessage(data) {
  const dispatchKey = String(data?.outbound_attempt_id || `queue_${data?.queue_id || ''}`);
  const now = Date.now();
  for (const [key, seenAt] of recentQueuedDispatchAttempts) {
    if (now - seenAt > QUEUED_DISPATCH_IDEMPOTENCY_MS) recentQueuedDispatchAttempts.delete(key);
  }
  if (dispatchKey && recentQueuedDispatchAttempts.has(dispatchKey)) {
    console.warn(`[FB Engine] Ignored duplicate SEND_QUEUED_MESSAGE dispatch: ${dispatchKey}`);
    return;
  }
  if (dispatchKey) recentQueuedDispatchAttempts.set(dispatchKey, now);
  const client_message_id = `queue_${data.queue_id}`;
  console.log(`[FB Engine] 📥 Nhận SEND_QUEUED_MESSAGE: queue_id=${data.queue_id} source_type=${data.source_type} thread_id=${data.thread_id}`);

  // 1. Envelope validation
  try {
    if (typeof self !== 'undefined' && self.FbCrmQueueEnvelopeValidation?.validateQueuedEnvelope) {
      self.FbCrmQueueEnvelopeValidation.validateQueuedEnvelope(data, { expectedAccountId: user_id });
    }
  } catch (err) {
    console.error('[FB Engine] Lỗi validate envelope SEND_QUEUED_MESSAGE:', err);
    sendToBackend('QUEUED_MESSAGE_RESULT', {
      contract_version: data.contract_version || 1,
      queue_id: data.queue_id,
      outbound_attempt_id: data.outbound_attempt_id || null,
      thread_id: data.thread_id,
      client_message_id,
      outcome: 'invalid_contract',
      stage: 'ENVELOPE_VALIDATION',
      adapter_version: 'rich-message-v1',
      error_code: err.code || 'CONTRACT_VALIDATION_FAILED',
      error: err.message,
      success: false
    });
    return;
  }

  // 2. Dispatch according to source_type
  if (data.source_type === 'page_messenger' || data.page_id) {
    try {
      await handleSendPageMessage({
        thread_id: data.thread_id,
        content: data.content,
        page_id: data.page_id,
        client_message_id,
        attachment: data.attachment || null,
        attachmentManifest: Array.isArray(data.attachment_manifest) ? data.attachment_manifest : null,
        expected_contact_name: data.expected_contact_name || null
      });
      sendToBackend('QUEUED_MESSAGE_RESULT', {
        contract_version: data.contract_version || 1,
        queue_id: data.queue_id,
        outbound_attempt_id: data.outbound_attempt_id || null,
        thread_id: data.thread_id,
        client_message_id,
        outcome: 'dispatched',
        stage: 'BUSINESS_SUITE_CDP',
        adapter_version: 'rich-message-v1',
        error_code: null,
        error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION',
        success: true
      });
    } catch (err) {
      console.error('[FB Engine] Lỗi gửi Page Message từ Queue:', err);
      sendToBackend('QUEUED_MESSAGE_RESULT', {
        contract_version: data.contract_version || 1,
        queue_id: data.queue_id,
        outbound_attempt_id: data.outbound_attempt_id || null,
        thread_id: data.thread_id,
        client_message_id,
        outcome: 'rejected',
        stage: 'BUSINESS_SUITE_CDP',
        adapter_version: 'rich-message-v1',
        error_code: err.code || 'PAGE_SEND_FAILED',
        error: err.message,
        success: false
      });
    }
  } else if (data.source_type === 'personal_messenger' || (!data.source_type && !data.page_id)) {
    try {
      // Operator media belongs on the dedicated chat tab. Only an actual
      // campaign job may use the campaign tab; routing every queued upload to
      // campaign left manual videos stuck before the composer on a stale tab.
      const personalRole = data.campaign_id ? 'campaign' : 'interaction';
      await runPersonalSendSerialized(`${data.account_id || user_id}:${personalRole}`, () => handleSendMessage({
        thread_id: data.thread_id,
        recipient_thread_id: data.recipient_thread_id || null,
        thread_url: data.thread_url || null,
        expected_contact_name: data.expected_contact_name || null,
        strict_recipient_identity: Boolean(data.campaign_id),
        content: data.content,
        text: data.content,
        attachment: data.attachment || null,
        attachmentManifest: Array.isArray(data.attachment_manifest) ? data.attachment_manifest : null,
        client_message_id,
        account_id: data.account_id || user_id,
        tab_role: personalRole
      }));
      sendToBackend('QUEUED_MESSAGE_RESULT', {
        contract_version: data.contract_version || 1,
        queue_id: data.queue_id,
        outbound_attempt_id: data.outbound_attempt_id || null,
        thread_id: data.thread_id,
        client_message_id,
        outcome: 'dispatched',
        stage: 'PERSONAL_MESSENGER_CDP',
        adapter_version: 'rich-message-v1',
        error_code: null,
        error: 'COMPOSER_DISPATCHED_WAITING_CONFIRMATION',
        success: true
      });
    } catch (err) {
      console.error('[FB Engine] Lỗi gửi Personal Message từ Queue:', err);
      sendToBackend('QUEUED_MESSAGE_RESULT', {
        contract_version: data.contract_version || 1,
        queue_id: data.queue_id,
        outbound_attempt_id: data.outbound_attempt_id || null,
        thread_id: data.thread_id,
        client_message_id,
        outcome: 'rejected',
        stage: 'PERSONAL_MESSENGER_CDP',
        adapter_version: 'rich-message-v1',
        error_code: err.code || 'PERSONAL_SEND_FAILED',
        error: err.message,
        success: false
      });
    }
  } else {
    sendToBackend('QUEUED_MESSAGE_RESULT', {
      contract_version: data.contract_version || 1,
      queue_id: data.queue_id,
      outbound_attempt_id: data.outbound_attempt_id || null,
      thread_id: data.thread_id,
      client_message_id,
      outcome: 'rejected',
      stage: 'EXTENSION_DISPATCH',
      adapter_version: 'rich-message-v1',
      error_code: 'UNSUPPORTED_SOURCE_TYPE',
      error: `Loại nguồn không được hỗ trợ: ${data.source_type}`,
      success: false
    });
  }
}

async function getBusinessSuiteTab(pageId) {
  const role = `page:${pageId}`;
  const registered = await getRegisteredTab(role);
  if (registered && isBusinessSuiteUrl(registered.url) && (String(registered.url || '').includes(`asset_id=${pageId}`) || String(registered.url || '').includes(`mailbox_id=${pageId}`))) {
    return registered;
  }
  if (registered) await unregisterTab(role);

  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['*://business.facebook.com/*'] }, async (tabs) => {
      if (!tabs || tabs.length === 0) return resolve(null);
      let tab = tabs.find((t) => t.url && (t.url.includes(`asset_id=${pageId}`) || t.url.includes(`mailbox_id=${pageId}`)));
      if (!tab && tabs.length > 0) {
        tab = tabs.find((t) => isBusinessSuiteUrl(t.url));
      }
      if (tab?.id) await registerTab(role, tab.id);
      resolve(tab || null);
    });
  });
}

// ── Đồng bộ danh sách threads từ sidebar Facebook ──────────────────────────
// Yêu cầu content.js scrape DOM sidebar của facebook.com/messages
let discoverySyncInFlight = false;
let activeDiscoveryAccountKey = null;
// A normal Inbox hint may supersede another Inbox/full pass, but it must not
// abort the dedicated Message Requests pass before that surface mounts.
let activeDiscoveryScanMode = null;
const pendingDiscoveryScans = new Map();
let recoverySyncRetryTimer = null;
const discoverySyncCheckpoints = new Map();
const discoverySyncCancelledAccounts = new Set();
// A virtualized Messenger sidebar can report its current lazy chunk as the
// bottom before React appends the next chunk. Confirm that the tail is stable
// across lightweight ticks before cycling the list back to its saved top.
const discoveryRealtimeTailStates = new Map();

function moveMessengerDiscoverySidebar(action = 'step') {
  // Strategy 1: Find container by navigation grid/gridcell/role or sidebar aria labels
  let scroller = null;
  const linkSelector = 'a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href*="/messages/requests/t/"], a[href*="/messages/e2ee/requests/t/"], a[href*="/messages/requests/spam/t/"], a[href*="/messages/e2ee/requests/spam/t/"], a[href*="/messages/spam/t/"]';
  const visibleConversationLinks = [...document.querySelectorAll(linkSelector)].filter((link) => {
    const rect = link.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < Math.min(680, window.innerWidth * 0.55);
  });
  const navContainer = [
    ...document.querySelectorAll(
      '[role="navigation"], nav, [role="grid"], [aria-label*="Đoạn chat" i], [aria-label*="Chats" i], [aria-label*="Hội thoại" i], [aria-label*="Conversations" i]'
    )
  ].filter((container) => {
    const rect = container.getBoundingClientRect();
    return rect.width > 180 && rect.height > 180
      && rect.left < Math.min(680, window.innerWidth * 0.55)
      && Boolean(container.querySelector(linkSelector));
  }).sort((left, right) => (
    right.querySelectorAll(linkSelector).length - left.querySelectorAll(linkSelector).length
  ))[0] || null;
  if (navContainer) {
    const scrollables = [navContainer, ...navContainer.querySelectorAll('div')].filter(d => {
      const style = window.getComputedStyle(d);
      const rect = d.getBoundingClientRect();
      return (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay' || d.scrollHeight > d.clientHeight + 10)
        && d.clientHeight > 150
        && rect.width > 180
        && rect.left < Math.min(680, window.innerWidth * 0.55)
        && Boolean(d.querySelector(linkSelector));
    });
    // Prefer the narrow left-side element that actually owns the greatest
    // remaining scroll range and contains the visible conversation anchors.
    if (scrollables.length > 0) {
      scrollables.sort((a, b) => {
        const score = (node) => {
          const rect = node.getBoundingClientRect();
          const linkCount = node.querySelectorAll(linkSelector).length;
          const range = Math.max(0, node.scrollHeight - node.clientHeight);
          const overflow = getComputedStyle(node).overflowY;
          return linkCount * 100000 + range
            + (['auto', 'scroll', 'overlay'].includes(overflow) ? 50000 : 0)
            - Math.max(0, rect.width - 520) * 1000;
        };
        return score(b) - score(a);
      });
      scroller = scrollables[0];
    }
  }

  // Strategy 2: Ancestors of conversation link anchors
  if (!scroller) {
    const candidates = new Map();
    for (const link of visibleConversationLinks) {
      let node = link.parentElement;
      while (node && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (node.clientHeight > 150 && node.scrollHeight > node.clientHeight + 8
          && rect.width > 180 && rect.left < Math.min(680, window.innerWidth * 0.55)) {
          candidates.set(node, (candidates.get(node) || 0) + 1);
        }
        node = node.parentElement;
      }
    }
    scroller = [...candidates.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const aRange = a[0].scrollHeight - a[0].clientHeight;
      const bRange = b[0].scrollHeight - b[0].clientHeight;
      if (bRange !== aRange) return bRange - aRange;
      return a[0].clientWidth - b[0].clientWidth;
    })[0]?.[0] || null;
  }

  if (!scroller) {
    const fallbackRect = visibleConversationLinks[0]?.getBoundingClientRect?.();
    return {
      found: false,
      moved: false,
      atEnd: false,
      scrollHeight: 0,
      clientHeight: 0,
      point: fallbackRect ? {
        x: fallbackRect.left + fallbackRect.width / 2,
        y: fallbackRect.top + fallbackRect.height / 2
      } : null
    };
  }
  document.querySelectorAll('[data-crm-discovery-scroller="true"]').forEach((node) => {
    if (node !== scroller) delete node.dataset.crmDiscoveryScroller;
  });
  scroller.dataset.crmDiscoveryScroller = 'true';
  if (!scroller.dataset.crmDiscoveryOriginalTop) scroller.dataset.crmDiscoveryOriginalTop = String(scroller.scrollTop || 0);
  if (action === 'restore') {
    const beforeRestore = scroller.scrollTop;
    scroller.scrollTop = Number(scroller.dataset.crmDiscoveryOriginalTop || 0);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    delete scroller.dataset.crmDiscoveryOriginalTop;
    return { found: true, restored: true, moved: beforeRestore !== scroller.scrollTop, after: scroller.scrollTop };
  }
  const before = scroller.scrollTop;
  const stepAmount = Math.max(300, Math.floor(scroller.clientHeight * 0.75));
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const targetTop = Math.min(maxTop, before + stepAmount);
  scroller.scrollTop = targetTop;
  scroller.scrollTo?.({ top: targetTop, behavior: 'auto' });
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: stepAmount, deltaMode: 0, bubbles: true, cancelable: true }));
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  const after = scroller.scrollTop;
  const rect = scroller.getBoundingClientRect();
  const tailSignature = visibleConversationLinks.slice(-5)
    .map((link) => String(link.getAttribute('href') || ''))
    .join('|');
  // maxTop=0 can mean Messenger has mounted only its first lazy chunk. It is
  // not proof of the real end; let the trusted wheel fallback request more.
  const atEnd = maxTop > 0 && after >= maxTop - 20;
  return {
    found: true,
    moved: after !== before,
    before,
    after,
    targetTop,
    maxTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    tailSignature,
    atEnd,
    point: {
      x: rect.left + Math.min(rect.width - 24, Math.max(24, rect.width / 2)),
      y: rect.top + Math.min(rect.height - 24, Math.max(24, rect.height / 2))
    }
  };
}

async function handleSync100Threads({ account_id, resume = false, scan_mode = 'full', time_budget_ms = 120000 }) {
  const requestedScan = { account_id, resume, scan_mode, time_budget_ms };
  const requestedAccountKey = String(account_id || '');
  if (discoverySyncInFlight) {
    pendingDiscoveryScans.set(requestedAccountKey, requestedScan);
    if (scan_mode === 'realtime' && activeDiscoveryAccountKey) {
      // Realtime replies outrank every background crawl, including Requests.
      // The requests scheduler retries later; customer messages must not wait
      // behind a lazy request surface for up to ninety seconds.
      discoverySyncCancelledAccounts.add(activeDiscoveryAccountKey);
      console.log('[FB Engine] [DISCOVERY] Realtime queued; cancelling superseded scan account=' + activeDiscoveryAccountKey + ' mode=' + activeDiscoveryScanMode);
    }
    return;
  }
  discoverySyncInFlight = true;
  const accountKey = requestedAccountKey;
  activeDiscoveryAccountKey = accountKey;
  activeDiscoveryScanMode = scan_mode;
  const isRealtimeInboxScan = scan_mode === 'realtime';
  const isRealtimeRequestScan = scan_mode === 'realtime_requests';
  const isRealtimeScan = isRealtimeInboxScan || isRealtimeRequestScan;
  const deadline = Date.now() + Math.max(10000, Math.min(Number(time_budget_ms) || 120000, 120000));
  if (!resume) discoverySyncCheckpoints.delete(accountKey);
  discoverySyncCancelledAccounts.delete(accountKey);
  const checkpoint = discoverySyncCheckpoints.get(accountKey) || { sections: new Map(), updated_at: Date.now() };
  discoverySyncCheckpoints.set(accountKey, checkpoint);
  let budgetExpired = false;
  let cancelled = false;
  console.log('[FB Engine] 🔄 Đang sync threads sidebar cho account:', account_id);

  // Keep the existing Personal Messenger flow, but scrape open Business Suite
  // tabs independently as well. A Page thread must carry the asset_id of the
  // exact tab it came from even when a Personal Messenger tab is also open.
  // Discovery must never scroll the operator's interaction/chat tab.
  const personalTab = isRealtimeRequestScan ? null : await ensureRoleMessengerTab(account_id, 'discovery');
  const recoveryDialogOpen = personalTab?.id ? await chrome.scripting.executeScript({
    target: { tabId: personalTab.id },
    func: () => {
      const pattern = /kh\u00f4i ph\u1ee5c|restore (?:chat|message)|m\u00e3 pin|\bpin\b|secure storage/i;
      return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((dialog) => {
        const rect = dialog.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const text = `${dialog.innerText || ''} ${dialog.getAttribute('aria-label') || ''}`;
        return pattern.test(text) || Boolean(dialog.querySelector('input[type="password"], input[inputmode="numeric"], input[autocomplete="one-time-code"]'));
      });
    }
  }).then((rows) => rows?.[0]?.result === true).catch(() => false) : false;

  if (recoveryDialogOpen) {
    console.log(`[FB Engine] [DISCOVERY] Pause account=${account_id}: Messenger PIN recovery is open`);
    discoverySyncInFlight = false;
    if (!recoverySyncRetryTimer) {
      recoverySyncRetryTimer = setTimeout(() => {
        recoverySyncRetryTimer = null;
        handleSync100Threads({ account_id }).catch(() => {});
      }, 5000);
    }
    return;
  }
  const bizTabs = isRealtimeRequestScan ? [] : await new Promise((resolve) => {
    chrome.tabs.query({ url: ['*://business.facebook.com/*'] }, (tabs) => resolve(tabs || []));
  });
  const scrapeTargets = [];
  let inboxTarget = null;
  if (personalTab?.id) {
    const inboxUrl = 'https://www.facebook.com/messages?crm_tab_role=discovery';
    if (/\/messages\/(?:requests|spam)/i.test(String(personalTab.url || ''))) {
      const load = waitForTabComplete(personalTab.id, 12000);
      await chrome.tabs.update(personalTab.id, { url: inboxUrl });
      await Promise.race([load, delay(4500)]);
      await delay(1000);
    }
    inboxTarget = { tab: await chrome.tabs.get(personalTab.id).catch(() => personalTab), isBizTab: false, pageId: null, inboxFolder: 'INBOX' };
  }

  // Message requests use their own background tab, so scanning them cannot
  // navigate or scroll the tab used for normal CRM chat/send/call actions.
  // The normal Inbox tick stays lightweight. A separate lightweight mode
  // visits both Requests buttons without waiting for the periodic full crawl.
  const requestsTab = isRealtimeInboxScan ? null : await ensureRoleMessengerTab(account_id, 'requests');
  let liveRequestsTab = requestsTab;
  if (liveRequestsTab?.id) {
    // Tab 'requests' co the da chet tu phien truoc (id khon con ton tai).
    // Neu khong kiem tra, chrome.tabs.update tren tab chet nem loi ra ngoai
    // toan bo scan va mat luon phan spam/tin nhan cho (reproduced 2026-09-18:
    // "No tab with id" giets scan, spam khong bao gio duoc scrape).
    const alive = await chrome.tabs.get(liveRequestsTab.id).then(() => true).catch(() => false);
    if (!alive) {
      await unregisterTab(FbCrmMessengerTabRoles.roleKey(account_id, 'requests')).catch(() => {});
      liveRequestsTab = await ensureRoleMessengerTab(account_id, 'requests').catch(() => null);
    }
  }
  if (liveRequestsTab?.id) {
    const requestsTab = liveRequestsTab;
    const requestsUrl = 'https://www.facebook.com/messages/requests?crm_tab_role=requests';
    const spamRequestsUrl = 'https://www.facebook.com/messages/requests/spam?crm_tab_role=requests';
    if (!/\/messages\/requests(?:\/|$|\?)/i.test(String(requestsTab.url || ''))) {
      const load = waitForTabComplete(requestsTab.id, 15000).catch(() => null);
      await chrome.tabs.update(requestsTab.id, { url: requestsUrl }).catch(() => {});
      await Promise.race([load, delay(6000)]);
      await delay(1400);
    }
    const settledRequestsTab = await chrome.tabs.get(requestsTab.id).catch(() => requestsTab);
    scrapeTargets.push({ tab: settledRequestsTab, isBizTab: false, pageId: null, inboxFolder: 'MESSAGE_REQUEST_POSSIBLE', desiredUrl: requestsUrl, requestSection: 'possible' });
    scrapeTargets.push({ tab: settledRequestsTab, isBizTab: false, pageId: null, inboxFolder: 'MESSAGE_REQUEST_SPAM', desiredUrl: spamRequestsUrl, requestSection: 'spam' });
  }
  // Requests are independent and run first. Inbox discovery must not delay
  // switching from an empty "You may know" section to Spam.
  if (inboxTarget) scrapeTargets.push(inboxTarget);
  for (const bizTab of bizTabs) {
    if (!bizTab?.id) continue;
    const pageId = bizTab.url?.match(/[?&](?:asset_id|mailbox_id)=(\d+)/)?.[1] || null;
    if (!pageId) continue;
    scrapeTargets.push({ tab: bizTab, isBizTab: true, pageId });
  }

  if (scrapeTargets.length === 0) {
    console.warn('[FB Engine] Không tìm thấy tab Facebook nào để sync sidebar.');
    sendToBackend('SYNC_THREADS_RESULT', { account_id, threads: [] });
    discoverySyncInFlight = false;
    return;
  }

  try {
    const collectedThreads = [];
    for (const target of scrapeTargets) {
      if (Date.now() >= deadline || discoverySyncCancelledAccounts.has(accountKey)) {
        budgetExpired = Date.now() >= deadline;
        cancelled = discoverySyncCancelledAccounts.has(accountKey);
        break;
      }
      try {
        // Facebook does not fully mount virtualized rows in a never-active
        // background tab. Make the target active inside the managed (already
        // hidden/off-screen) Chrome window before selecting Requests/Spam.
        // This does not foreground Chrome on the user's desktop.
        await chrome.tabs.update(target.tab.id, { active: true }).catch(() => null);
        await delay(target.requestSection ? 1200 : (isRealtimeScan ? 50 : 500));
        let scraped = [];
        if (target.isBizTab) {
          let results = null;
          try {
            results = await chrome.scripting.executeScript({
              target: { tabId: target.tab.id, allFrames: true },
              world: 'MAIN',
              func: scrapeBusinessSuiteSidebar
            });
          } catch (e) {
            console.warn('[FB Engine] executeScript world:MAIN failed, fallback to default:', e.message);
            results = await chrome.scripting.executeScript({
              target: { tabId: target.tab.id, allFrames: true },
              func: scrapeBusinessSuiteSidebar
            });
          }
          const allScraped = [];
          for (const res of (results || [])) {
            if (Array.isArray(res?.result)) {
              allScraped.push(...res.result);
            }
          }
          scraped = allScraped.map((t) => ({ ...t, inbox_folder: 'INBOX' }));
          console.log(`[FB Engine] [BIZ_SIDEBAR] Scraped ${scraped.length} threads from Business Suite tab ${target.tab.id}:`, scraped.map(s => `${s.name} (${s.thread_id})`));
        } else {
          if (target.desiredUrl) {
            const current = await chrome.tabs.get(target.tab.id).catch(() => target.tab);
            const desiredPath = new URL(target.desiredUrl).pathname;
            let currentPath = '';
            try { currentPath = new URL(String(current?.url || '')).pathname.replace(/\/$/, ''); } catch (_) {}
            if (currentPath !== desiredPath.replace(/\/$/, '')) {
              const load = waitForTabComplete(target.tab.id, 15000);
              await chrome.tabs.update(target.tab.id, { url: target.desiredUrl });
              await Promise.race([load, delay(6000)]);
            }
            const sectionSelected = await chrome.scripting.executeScript({
              target: { tabId: target.tab.id },
              func: (section) => {
                const normalizeTabText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
                const currentPath = location.pathname.replace(/\/$/, '');
                const directSectionPath = section === 'spam'
                  ? /\/messages\/(?:requests\/spam|spam)$/.test(currentPath)
                  : currentPath === '/messages/requests';
                if (directSectionPath) return true;
                const semanticNames = section === 'spam'
                  ? new Set(['spam', 'thư rác'])
                  : new Set(['có thể bạn biết', 'bạn có thể biết', 'những người bạn có thể biết', 'you may know', 'people you may know']);
                const semanticTab = [...document.querySelectorAll('[role="tab"]')].find((tab) => {
                  const rect = tab.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && semanticNames.has(normalizeTabText(tab.textContent));
                });
                if (semanticTab) {
                  semanticTab.dataset.crmRequestSection = section;
                  if (semanticTab.getAttribute('aria-selected') !== 'true') semanticTab.click();
                  return true;
                }
                const labels = section === 'spam'
                  ? /^(?:Spam|Thư rác)$/i
                  : /^(?:Có thể bạn biết|Bạn có thể biết|Những người bạn có thể biết|You may know|People you may know)$/i;
                const candidates = [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex], span, div')]
                  .filter((el) => labels.test(String(el.textContent || '').trim()))
                  .filter((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && rect.left < 460 && rect.top < 420;
                  })
                  .sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (ar.width * ar.height) - (br.width * br.height);
                  });
                const label = candidates[0];
                if (!label) return false;
                const control = label.closest('[role="tab"], [role="button"], button, [tabindex]') || label;
                control.dataset.crmRequestSection = section;
                control.click();
                return true;
              },
              args: [target.requestSection]
            }).then((rows) => rows?.[0]?.result === true).catch(() => false);
            if (!sectionSelected) {
              console.warn(`[FB Engine] [REQUESTS] Cannot select section=${target.requestSection}`);
              continue;
            }
            await delay(1200);
            let selectedSectionReady = false;
            for (let selectionAttempt = 0; selectionAttempt < 20; selectionAttempt += 1) {
              if (Date.now() >= deadline || discoverySyncCancelledAccounts.has(accountKey)) break;
              selectedSectionReady = await chrome.scripting.executeScript({
                target: { tabId: target.tab.id },
                func: (section) => {
                  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
                  const currentPath = location.pathname.replace(/\/$/, '');
                  const directSectionPath = section === 'spam'
                    ? /\/messages\/(?:requests\/spam|spam)$/.test(currentPath)
                    : currentPath === '/messages/requests';
                  if (directSectionPath) return true;
                  const names = section === 'spam'
                    ? new Set(['spam', 'thư rác'])
                    : new Set(['có thể bạn biết', 'bạn có thể biết', 'những người bạn có thể biết', 'you may know', 'people you may know']);
                  return [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex]')]
                    .some((control) => {
                      if (!names.has(normalize(control.textContent))) return false;
                      const selected = control.getAttribute('aria-selected') === 'true'
                        || control.getAttribute('aria-pressed') === 'true'
                        || /^(?:active|selected|checked)$/i.test(String(control.getAttribute('data-state') || ''))
                        || control.dataset.crmRequestSection === section;
                      return selected && control.getBoundingClientRect().width > 0;
                    });
                },
                args: [target.requestSection]
              }).then((rows) => rows?.[0]?.result === true).catch(() => false);
              if (selectedSectionReady) break;
              await delay(250);
            }
            if (!selectedSectionReady) {
              console.warn(`[FB Engine] [REQUESTS] Section did not become selected=${target.requestSection}`);
              continue;
            }
            // Wait for both the request URL and its React surface. Merely
            // waiting for navigation lets the previous Inbox DOM be scraped
            // during the transition and labels normal chats as requests.
            let requestSurfaceReady = false;
            for (let readinessAttempt = 0; readinessAttempt < 60; readinessAttempt += 1) {
              if (Date.now() >= deadline || discoverySyncCancelledAccounts.has(accountKey)) break;
              requestSurfaceReady = await chrome.scripting.executeScript({
                target: { tabId: target.tab.id },
                func: () => {
                  const path = location.pathname.replace(/\/$/, '');
                  const hasRequestTabs = [...document.querySelectorAll('[role="tab"], [role="button"], button')].some((tab) =>
                    /^(?:Có thể bạn biết|Bạn có thể biết|Những người bạn có thể biết|You may know|People you may know|Spam|Thư rác)$/i.test(String(tab.textContent || '').replace(/\s+/g, ' ').trim())
                  );
                  const isDirectRequestSurface = /^\/messages\/(?:requests(?:\/spam)?|spam)$/.test(path);
                  return isDirectRequestSurface && (hasRequestTabs || document.readyState === 'complete');
                }
              }).then((rows) => rows?.[0]?.result === true).catch(() => false);
              if (requestSurfaceReady) break;
              await delay(750);
            }
            if (!requestSurfaceReady) {
              console.warn(`[FB Engine] [REQUESTS] Skip tab=${target.tab.id}: request surface not ready`);
              continue;
            }
          }
          const sectionKey = target.isBizTab
            ? `page:${target.pageId}`
            : (target.requestSection || 'inbox');
          const sectionCheckpoint = checkpoint.sections.get(sectionKey) || { threads: new Map(), completed: false };
          // Realtime discovery intentionally leaves this dedicated tab at its
          // current sidebar page so the next tick can continue downward. A
          // full scan must always begin from the saved top before doing its
          // existing exhaustive crawl.
          if (!isRealtimeScan && !target.requestSection) {
            await chrome.scripting.executeScript({
              target: { tabId: target.tab.id },
              func: moveMessengerDiscoverySidebar,
              args: ['restore']
            }).catch(() => {});
            await delay(300);
          }
          if (resume && sectionCheckpoint.completed) {
            scraped = [...sectionCheckpoint.threads.values()];
            for (const thread of scraped) collectedThreads.push({ ...thread, page_id: target.isBizTab ? (thread.page_id || target.pageId) : null, source_type: target.isBizTab ? 'page_messenger' : 'personal_messenger' });
            continue;
          }
          const discovered = resume ? new Map(sectionCheckpoint.threads) : new Map();
          let roundsWithoutNew = 0;
          const maxDiscoveryRounds = isRealtimeRequestScan && target.requestSection ? 12 : (isRealtimeScan ? 1 : 60);
          for (let round = 0; round < maxDiscoveryRounds && discovered.size < 500; round += 1) {
            if (Date.now() >= deadline || discoverySyncCancelledAccounts.has(accountKey)) {
              budgetExpired = Date.now() >= deadline;
              cancelled = discoverySyncCancelledAccounts.has(accountKey);
              break;
            }
            const results = await chrome.scripting.executeScript({ target: { tabId: target.tab.id }, func: scrapeFacebookSidebar }).catch((err) => {
              console.warn(`[FB Engine] [DISCOVERY] Tab ${target.tab.id} không còn truy cập được:`, err.message);
              return null;
            });
            if (!results) break;
            const primaryVisible = results?.[0]?.result || [];
            let visible = primaryVisible;
            if (target.requestSection) {
              const fallbackResults = await chrome.scripting.executeScript({
                target: { tabId: target.tab.id },
                func: scrapeMessageRequestsSidebar
              }).catch(() => []);
              // The generic parser can also see the open conversation in the
              // wide main panel. Accept its rows here only when Facebook put
              // an explicit Requests/Spam segment in the URL; the scoped
              // fallback owns canonical /messages/t links in the left list.
              const scopedFallback = fallbackResults?.[0]?.result || [];
              const scopedRequestIds = new Set(scopedFallback.map((thread) => String(thread?.thread_id || '')).filter(Boolean));
              const verifiedPrimary = primaryVisible.filter((thread) =>
                scopedRequestIds.has(String(thread?.thread_id || ''))
                && /\/messages\/(?:(?:e2ee\/)?(?:requests|spam)|(?:requests|spam)\/e2ee)(?:\/|\?)/i.test(String(thread?.thread_url || ''))
              );
              const combined = new Map();
              // The scoped parser owns membership; the existing generic parser
              // may only enrich those same visible request ids.
              for (const thread of [...scopedFallback, ...verifiedPrimary]) {
                if (thread?.thread_id) combined.set(String(thread.thread_id), thread);
              }
              visible = [...combined.values()];
              if (round === 0) {
                console.log(`[FB Engine] [REQUESTS] section=${target.requestSection} primary=${primaryVisible.length} verified_primary=${verifiedPrimary.length} fallback=${(fallbackResults?.[0]?.result || []).length}`);
              }
            }
            if (target.requestSection && visible.length === 0 && round < 10) {
              if (Date.now() >= deadline || discoverySyncCancelledAccounts.has(accountKey)) break;
              // The selected ARIA tab becomes active before React mounts its
              // virtualized conversation rows. An immediate empty result is
              // therefore "not loaded yet", not proof that Requests is empty.
              console.log(`[FB Engine] [REQUESTS] section=${target.requestSection} waiting_for_rows attempt=${round + 1}/10`);
              await delay(600);
              continue;
            }
            if (target.requestSection && visible.length === 0 && round === 10) {
              console.log(`[FB Engine] [REQUESTS] section=${target.requestSection} confirmed_empty_after_wait`);
              break;
            }
            const beforeCount = discovered.size;
            const newBatch = [];
            for (const thread of visible) {
              const key = String(thread.thread_id);
              if (!discovered.has(key)) {
                const item = {
                  ...thread,
                  inbox_folder: target.inboxFolder || 'INBOX',
                  // Only rows scraped after the Requests surface and its
                  // Possible/Spam control were verified may reclassify a
                  // legacy thread that was previously stored as Inbox.
                  inbox_folder_verified: Boolean(target.requestSection)
                };
                discovered.set(key, item);
                newBatch.push(item);
              }
            }
            // Send new threads immediately to backend so CRM UI updates live
            // Stream Inbox for fast UI feedback. Requests are held until the
            // final cross-folder dedupe so a stale request surface can never
            // temporarily move normal conversations into the waiting tab.
            const shouldStreamBatch = (target.inboxFolder || 'INBOX') === 'INBOX'
              || (isRealtimeRequestScan && Boolean(target.requestSection));
            if (newBatch.length > 0 && shouldStreamBatch) {
              sendToBackend('SYNC_THREADS_RESULT', {
                account_id,
                partial: true,
                sync_status: isRealtimeRequestScan ? 'realtime_requests' : 'realtime_hint',
                threads: newBatch.map((t) => ({
                  id: t.thread_id,
                  thread_id: t.thread_id,
                  contact_name: t.name || t.contact_name,
                  last_message: t.last_message,
                  is_unread: t.is_unread,
                  is_like: t.is_like === true,
                  preview_is_outgoing: t.preview_is_outgoing === true,
                  avatar_url: t.avatar_url || null,
                  avatar_base64: t.avatar_base64 || null,
                  thread_url: t.thread_url || null,
                  is_e2ee: !!t.is_e2ee,
                  page_id: null,
                  source_type: 'personal_messenger',
                  inbox_folder: target.inboxFolder || 'INBOX',
                  inbox_folder_verified: t.inbox_folder_verified === true
                }))
              });
            }
            roundsWithoutNew = discovered.size === beforeCount ? roundsWithoutNew + 1 : 0;
            sectionCheckpoint.threads = new Map(discovered);
            sectionCheckpoint.completed = false;
            sectionCheckpoint.updated_at = Date.now();
            checkpoint.sections.set(sectionKey, sectionCheckpoint);
            checkpoint.updated_at = Date.now();
            console.log('[FB Engine] [DISCOVERY] account=' + account_id + ' round=' + (round + 1) + ' total=' + discovered.size + ' visible=' + visible.length);
            // A request-only poll scans each selected button once. Empty
            // surfaces still use the existing ten-round mount wait above.
            if (isRealtimeRequestScan && target.requestSection) break;
            // Messenger virtualizes the list and often pauses at the bottom of
            // the currently loaded chunk. Give it several load windows before
            // deciding that the real end has been reached.
            if (isRealtimeInboxScan && !target.requestSection) {
              // The old realtime branch stopped before moveMessengerDiscoverySidebar,
              // then the cleanup below restored the list to the top. It could
              // therefore rescan only the first visible conversations forever.
              // Advance exactly one viewport per lightweight tick; keep that
              // position for the next tick and cycle back to the saved top at
              // the real end of the sidebar.
              const realtimeMove = await chrome.scripting.executeScript({
                target: { tabId: target.tab.id },
                func: moveMessengerDiscoverySidebar,
                args: ['step']
              }).catch(() => []);
              let realtimeMoveState = realtimeMove?.[0]?.result || {};
              if (!realtimeMoveState.moved && !realtimeMoveState.atEnd && realtimeMoveState.point) {
                // Some Messenger builds ignore programmatic scrollTop on their
                // virtual list and react only to a trusted wheel. Reuse the
                // existing CDP input adapter strictly as a no-movement fallback.
                const trustedSidebarWheel = await dispatchTrustedHistoryWheel(
                  target.tab.id,
                  realtimeMoveState.point,
                  Math.max(420, Number(realtimeMoveState.maxTop || 0) > 0 ? 720 : 520)
                );
                if (trustedSidebarWheel.success) {
                  await delay(700);
                  const trustedMoveProbe = await chrome.scripting.executeScript({
                    target: { tabId: target.tab.id },
                    func: (beforeTop) => {
                      const scroller = document.querySelector('[data-crm-discovery-scroller="true"]');
                      if (!scroller) return { found: false, moved: true, atEnd: false, trusted: true };
                      const afterTop = Number(scroller.scrollTop || 0);
                      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                      return {
                        found: true,
                        moved: afterTop !== Number(beforeTop || 0),
                        before: Number(beforeTop || 0),
                        after: afterTop,
                        maxTop,
                        scrollHeight: scroller.scrollHeight,
                        clientHeight: scroller.clientHeight,
                        atEnd: maxTop > 0 && afterTop >= maxTop - 20,
                        trusted: true
                      };
                    },
                    args: [Number(realtimeMoveState.before || 0)]
                  }).then((rows) => rows?.[0]?.result).catch(() => null);
                  realtimeMoveState = trustedMoveProbe || { ...realtimeMoveState, trusted: true };
                }
                console.log(`[FB Engine] [DISCOVERY_REALTIME] trusted_scroll=${!!trustedSidebarWheel.success} moved=${!!realtimeMoveState.moved}`);
              }
              if (realtimeMoveState.atEnd) {
                const tailKey = accountKey + ':' + target.tab.id;
                const previousTail = discoveryRealtimeTailStates.get(tailKey) || { stalls: 0, height: 0, signature: '' };
                // Hold this bottom while Messenger resolves its lazy loader,
                // then step again. A temporary chunk boundary must never send
                // the conversation list straight back to the top.
                await delay(1400);
                const tailProbeRows = await chrome.scripting.executeScript({
                  target: { tabId: target.tab.id },
                  func: moveMessengerDiscoverySidebar,
                  args: ['step']
                }).catch(() => []);
                const tailProbe = tailProbeRows?.[0]?.result || {};
                const oldHeight = Math.max(
                  Number(realtimeMoveState.scrollHeight || 0),
                  Number(previousTail.height || 0)
                );
                const grew = Number(tailProbe.scrollHeight || 0) > oldHeight + 2
                  || Number(tailProbe.maxTop || 0) > Number(realtimeMoveState.maxTop || 0) + 2
                  || (tailProbe.tailSignature && tailProbe.tailSignature !== (realtimeMoveState.tailSignature || previousTail.signature));
                const advanced = grew || tailProbe.moved || tailProbe.atEnd === false;
                if (advanced) {
                  discoveryRealtimeTailStates.set(tailKey, {
                    stalls: 0,
                    height: Number(tailProbe.scrollHeight || realtimeMoveState.scrollHeight || 0),
                    signature: tailProbe.tailSignature || realtimeMoveState.tailSignature || ''
                  });
                  console.log('[FB Engine] [DISCOVERY_REALTIME] Lazy-load grew; keeping current sidebar position.');
                  await delay(450);
                } else {
                  const stalls = Number(previousTail.stalls || 0) + 1;
                  discoveryRealtimeTailStates.set(tailKey, {
                    stalls,
                    height: Number(tailProbe.scrollHeight || realtimeMoveState.scrollHeight || 0),
                    signature: tailProbe.tailSignature || realtimeMoveState.tailSignature || previousTail.signature || ''
                  });
                  if (stalls >= 3) {
                    await chrome.scripting.executeScript({
                      target: { tabId: target.tab.id },
                      func: moveMessengerDiscoverySidebar,
                      args: ['restore']
                    }).catch(() => {});
                    discoveryRealtimeTailStates.delete(tailKey);
                    console.log('[FB Engine] [DISCOVERY_REALTIME] Stable sidebar end confirmed; cycling to top.');
                  } else {
                    console.log('[FB Engine] [DISCOVERY_REALTIME] Waiting at lazy-load tail confirmation ' + stalls + '/3.');
                  }
                }
              } else {
                discoveryRealtimeTailStates.delete(accountKey + ':' + target.tab.id);
                // Let React mount the next virtual page before the scheduler's
                // following realtime tick reads it.
                await delay(450);
              }
              break;
            }
            if (roundsWithoutNew >= 8) break;
            const move = await chrome.scripting.executeScript({ target: { tabId: target.tab.id }, func: moveMessengerDiscoverySidebar, args: ['step'] }).catch((err) => {
              console.warn(`[FB Engine] [DISCOVERY] Move sidebar tab ${target.tab.id} error:`, err.message);
              return null;
            });
            if (!move) break;
            const moveState = move?.[0]?.result || {};
            // At the real bottom, allow three lazy-load windows and then move
            // to the requests phase. Previously it waited eight identical
            // bottom rounds, which looked like an endless re-scroll.
            if (moveState.atEnd && roundsWithoutNew >= 3) break;
            await delay(moveState.atEnd ? 1800 : 850);
          }
          scraped = [...discovered.values()];
          sectionCheckpoint.threads = new Map(discovered);
          sectionCheckpoint.completed = !budgetExpired && !cancelled;
          checkpoint.sections.set(sectionKey, sectionCheckpoint);
          if (!isRealtimeScan && !budgetExpired && !cancelled) {
            await chrome.scripting.executeScript({ target: { tabId: target.tab.id }, func: moveMessengerDiscoverySidebar, args: ['restore'] }).catch(() => {});
          }
        }
        console.log(`[FB Engine] ✅ Đã scrape được ${scraped.length} threads từ ${target.isBizTab ? `Business Suite Page ${target.pageId}` : 'Messenger cá nhân'} sidebar`);
        for (const thread of scraped) {
          collectedThreads.push({
            ...thread,
            page_id: target.isBizTab ? (thread.page_id || target.pageId) : null,
            source_type: target.isBizTab ? 'page_messenger' : 'personal_messenger'
          });
        }
      } catch (targetErr) {
        console.warn(`[FB Engine] Không scrape được tab ${target.tab.id}:`, targetErr.message);
      }
    }

    // Process avatar downloads in fast parallel batches with timeout
    const fetchAvatarBase64 = async (url) => {
      if (!url || !url.startsWith('http')) return null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(url, { credentials: 'include', signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        return `data:${contentType};base64,${btoa(binary)}`;
      } catch (e) {
        return null;
      }
    };

    // A transient/stale Requests DOM can expose rows from the previous Inbox
    // surface. If the same thread was positively observed in Inbox during this
    // job, Inbox is authoritative and must never be overwritten by Requests.
    const threadsByIdentity = new Map();
    for (const thread of collectedThreads) {
      const identity = `${thread.source_type || 'personal_messenger'}:${thread.page_id || ''}:${String(thread.thread_id)}`;
      const existing = threadsByIdentity.get(identity);
      if (!existing || (existing.inbox_folder !== 'INBOX' && thread.inbox_folder === 'INBOX')) {
        threadsByIdentity.set(identity, thread);
      }
    }

    const processedThreads = await Promise.all([...threadsByIdentity.values()].map(async (t) => {
      // Realtime polling only needs identity + preview. Avatar downloads can
      // take 1.2s each and compete with message observation during campaigns.
      const avatarBase64 = t.avatar_base64 || (isRealtimeScan ? null : await fetchAvatarBase64(t.avatar_url));
      return {
        id: t.thread_id,
        thread_id: t.thread_id,
        contact_name: t.name || t.contact_name,
        last_message: t.last_message,
        is_unread: t.is_unread,
        is_like: t.is_like === true,
        preview_is_outgoing: t.preview_is_outgoing === true,
        avatar_url: t.avatar_url,
        avatar_base64: avatarBase64,
        thread_url: t.thread_url || null,
        is_e2ee: !!t.is_e2ee,
        page_id: t.page_id || null,
        source_type: t.source_type,
        inbox_folder: t.inbox_folder || 'INBOX',
        inbox_folder_verified: t.inbox_folder_verified === true
      };
    }));

    sendToBackend('SYNC_THREADS_RESULT', {
      account_id,
      threads: processedThreads,
      partial: budgetExpired || cancelled,
      sync_status: cancelled
        ? 'cancelled'
        : (budgetExpired ? 'paused' : (isRealtimeRequestScan ? 'realtime_requests' : 'completed')),
      checkpoint: [...checkpoint.sections.entries()].map(([section, state]) => ({ section, count: state.threads.size, completed: state.completed }))
    });
  } catch (err) {
    console.error('[FB Engine] Lỗi executeScript scrape sidebar:', err.message);
    sendToBackend('SYNC_THREADS_RESULT', { account_id, threads: [] });
  } finally {
    discoverySyncInFlight = false;
    activeDiscoveryAccountKey = null;
    activeDiscoveryScanMode = null;
    const nextEntry = pendingDiscoveryScans.entries().next();
    if (!nextEntry.done) {
      const [nextAccountKey, nextScan] = nextEntry.value;
      pendingDiscoveryScans.delete(nextAccountKey);
      setTimeout(() => handleSync100Threads(nextScan).catch(() => {}), 0);
    }
  }
}


// ── Hàm scrape sidebar Business Suite (chạy trong context trang) ─────────────
function scrapeBusinessSuiteSidebar() {
  const threads = [];
  const seen = new Set();

  const isSystemText = (t) => {
    if (!t || typeof t !== 'string') return true;
    const str = t.trim();
    if (str.length < 2) return true;
    const pat = /^(?:Tất cả tin nhắn|Tất cả|All messages|All|Tin nhắn trực tiếp|Direct messages|Hộp thư đến|Hộp thư|Inbox|Chưa đọc|Unread|Đã xong|Done|Gắn dấu sao|Đã gắn dấu sao|Starred|Spam|Thư rác|Bình luận.*|Comments.*|Thông báo|Notifications|Đang hoạt động.*|Hoạt động.*|Active now|Active recently|Online|Offline|Đang|Facebook|Messenger|Meta)$/i;
    return pat.test(str);
  };

  // 1. Kiểm tra phần tử có nằm trong khung chat, bong bóng tin nhắn, hay form soạn thảo không
  // TUYỆT ĐỐI KHÔNG dùng role="region" hoặc thread_detail (vì Meta dùng cho toàn bộ layout/trang)
  function isInsideChatOrDetailPane(el) {
    if (!el) return false;
    if (el.closest('[data-message-id], [data-testid*="message"], [data-surface*="message_list"], [data-surface*="composer"], [data-scope="messages_table"], form')) {
      return true;
    }
    if (el.querySelector && el.querySelector('[role="textbox"], textarea')) {
      return true;
    }
    return false;
  }

  // 2. Tìm container gốc của sidebar danh sách hội thoại bên trái
  // Business Suite 2026+: span dòng hội thoại cũng chứa "thread_list" trong
  // data-surface (.../thread_list/thread_row/...) — phải chọn phần tử KHÔNG
  // phải dòng và thực sự chứa các dòng bên trong, nếu không scope quét sẽ sai.
  let sidebarContainer = Array.from(document.querySelectorAll('[data-surface*="thread_list"], [data-surface*="bizweb_inbox:thread_list"]'))
    .find(el => !/thread_row/.test(el.getAttribute('data-surface') || '') && el.querySelector('[data-surface*="thread_row"], a[href*="selected_item_id="], [role="row"], [role="listitem"]'))
    || document.querySelector('[data-surface*="thread_list"], [data-surface*="bizweb_inbox:thread_list"]');
  if (!sidebarContainer) {
    const searchInput = document.querySelector('input[placeholder*="Tìm kiếm" i], input[placeholder*="Search" i], input[type="search"]');
    if (searchInput) {
      let curr = searchInput.parentElement;
      while (curr && curr !== document.body) {
        if (curr.querySelector('a[href*="selected_item_id="], [role="row"], [role="listitem"], [role="gridcell"]')) {
          sidebarContainer = curr;
          break;
        }
        curr = curr.parentElement;
      }
    }
  }

  function isInsideSidebar(el) {
    if (!el || isInsideChatOrDetailPane(el)) return false;
    if (sidebarContainer && sidebarContainer.contains(el)) return true;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.left > 550) return false;
    } catch (_) {}
    return true;
  }

  // Lấy page_id & selected_item_id từ URL hiện tại (asset_id)
  const urlParams = new URLSearchParams(window.location.search);
  const pageId = urlParams.get('asset_id') || null;
  const currentSelectedItemId = urlParams.get('selected_item_id') || urlParams.get('thread_id') || null;

  // Helper trích xuất ID từ React Fiber / Props của DOM element
  function extractIdFromReact(node) {
    if (!node) return null;
    try {
      const visited = new Set();
      const candidateNodes = [node, ...Array.from(node.querySelectorAll('*')).slice(0, 20)];
      for (const el of candidateNodes) {
        const keys = Object.keys(el);
        const reactKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactProps$'));
        if (!reactKey) continue;

        const queue = [el[reactKey]];
        let iterations = 0;
        while (queue.length > 0 && iterations < 80) {
          iterations++;
          const curr = queue.shift();
          if (!curr || typeof curr !== 'object' || visited.has(curr)) continue;
          visited.add(curr);

          // "threadID" (D hoa) là tên prop thật trong Business Suite 2026+.
          // Bỏ prop generic "id" — nó bắt nhầm ID trang/phantử khác khiến các
          // dòng khác nhau resolve cùng một ID và bị lọc trùng còn 1 thread.
          const directProps = ['threadID', 'threadKey', 'thread_key', 'thread_id', 'threadId', 'selected_item_id', 'selectedItemId', 'recipientId', 'recipient_id', 'contactId', 'contact_id', 'psid', 'participantId', 'participant_id', 'otherUserFbId', 'threadFbid', 'thread_fbid', 'userId', 'user_id'];
          for (const p of directProps) {
            const val = curr[p];
            if (val && (typeof val === 'string' || typeof val === 'number')) {
              const strVal = String(val);
              const m = strVal.match(/(\d{12,})/);
              if (m && m[1] !== pageId) {
                return m[1];
              }
            }
          }

          if (curr.memoizedProps) queue.push(curr.memoizedProps);
          if (curr.props) queue.push(curr.props);
          if (curr.return) queue.push(curr.return);
          if (curr.child) queue.push(curr.child);
          if (curr.stateNode && typeof curr.stateNode === 'object') queue.push(curr.stateNode);
        }
      }
    } catch (e) {}
    return null;
  }

  // 1. Quét tất cả các thread container NẰM TRONG SIDEBAR DANH SÁCH HỘI THOẠI
  const candidateRows = [];
  const scope = sidebarContainer || document;

  // A. Thẻ theo link hội thoại nằm trong sidebar
  scope.querySelectorAll('a[href*="selected_item_id="], a[href*="thread_id="], a[href*="/messages/t/"]').forEach(link => {
    if (isInsideSidebar(link)) {
      const row = link.closest('[data-surface*="thread_row"], [role="row"], [role="listitem"], [role="gridcell"]') || link;
      if (!candidateRows.includes(row) && isInsideSidebar(row)) {
        candidateRows.push(row);
      }
    }
  });

  // B. Thẻ theo role hoặc data-surface nằm trong sidebar
  scope.querySelectorAll('[data-surface*="thread_row"], [data-surface*="thread_list"] > div, [data-surface*="bizweb_inbox:thread_list"] > div, [role="row"], [role="listitem"], [role="gridcell"]').forEach(el => {
    if (isInsideSidebar(el) && !candidateRows.includes(el)) {
      const h = el.clientHeight || el.offsetHeight || 0;
      const w = el.clientWidth || el.offsetWidth || 0;
      if ((h >= 36 && h <= 180 && w >= 120) || el.getAttribute('data-surface')) {
        // Span thread_row của Business Suite 2026+ là inline 0x0 — dùng ancestor
        // gần nhất có hộp hiển thị thật làm dòng để querySelector/innerText hoạt động.
        let row = el;
        if ((el.clientHeight || el.offsetHeight || 0) === 0) {
          let node = el;
          while (node && node !== document.body) {
            const nh = node.clientHeight || node.offsetHeight || 0;
            const nw = node.clientWidth || node.offsetWidth || 0;
            if (nh >= 36 && nh <= 180 && nw >= 120) { row = node; break; }
            node = node.parentElement;
          }
        }
        if (!candidateRows.includes(row) && isInsideSidebar(row)) candidateRows.push(row);
      }
    }
  });

  // C. Fallback: Quét các container cha của avatar img CHỈ NẰM TRONG SIDEBAR
  const sidebarAvatars = scope.querySelectorAll('img[src*="fbcdn.net"], img[src*="scontent"]');
  for (const img of sidebarAvatars) {
    if (!isInsideSidebar(img)) continue;
    let p = img.parentElement;
    let depth = 0;
    while (p && p !== document.body && depth < 8) {
      depth++;
      if (isInsideChatOrDetailPane(p)) break;
      const h = p.clientHeight || p.offsetHeight || 0;
      const w = p.clientWidth || p.offsetWidth || 0;
      // Phải bao trọn cả avatar lẫn text tên khách
      if (h >= 36 && h <= 180 && w >= 120 && w <= 550) {
        if (!candidateRows.includes(p) && isInsideSidebar(p)) candidateRows.push(p);
        break;
      }
      p = p.parentElement;
    }
  }

  for (const row of candidateRows) {
    try {
      if (!isInsideSidebar(row)) continue;
      let thread_id = null;

      // 1. Tìm thread_id từ các thẻ link bên trong
      const links = row.tagName === 'A' ? [row] : Array.from(row.querySelectorAll('a[href]'));
      for (const link of links) {
        const href = link.getAttribute('href') || link.href || '';
        const m1 = href.match(/selected_item_id=(\d+)/);
        if (m1 && m1[1] !== pageId) { thread_id = m1[1]; break; }
        const m2 = href.match(/[?&]thread_id=(\d+)/);
        if (m2 && m2[1] !== pageId) { thread_id = m2[1]; break; }
        const m3 = href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
        if (m3 && m3[1] !== pageId) { thread_id = m3[1]; break; }
      }

      // 2. Fallback: chỉ khi row thực sự là active row được chọn
      if (!thread_id && currentSelectedItemId && (
        row.getAttribute('aria-selected') === 'true' ||
        row.getAttribute('aria-current') === 'true'
      )) {
        thread_id = currentSelectedItemId;
      }

      // 3. Fallback: trích xuất từ React Fiber Props
      if (!thread_id) {
        thread_id = extractIdFromReact(row);
      }

      // 4. Fallback: quét attribute ID/data-id/data-hovercard
      if (!thread_id) {
        const hoverEls = row.querySelectorAll('[data-hovercard*="id="], [href*="id="], [href*="selected_item_id="]');
        for (const el of hoverEls) {
          const s = (el.getAttribute('data-hovercard') || '') + ' ' + (el.getAttribute('href') || '');
          const m = s.match(/(?:id=|profile\/|selected_item_id=)(\d{12,})/);
          if (m && m[1] !== pageId) {
            thread_id = m[1];
            break;
          }
        }
      }

      if (!thread_id || thread_id === pageId || seen.has(thread_id)) continue;
      seen.add(thread_id);

      // Trích xuất Tên (Name)
      let name = '';
      const titleWrapper = row.querySelector('[data-surface*="thread_title"]');
      if (titleWrapper) {
        const txt = (titleWrapper.textContent || '').trim().split('\n')[0].trim();
        if (txt && !isSystemText(txt)) name = txt;
      }
      if (!name) {
        const candidateNameEls = Array.from(row.querySelectorAll('h2, h3, h4, [role="heading"], [dir="auto"], span[style*="font-weight"], .xeuugli, strong, b'));
        for (const el of candidateNameEls) {
          let txt = (el.textContent || '').trim().split('\n')[0].trim();
          txt = txt.replace(/\s*\d+\s*(?:ngày|giờ|phút|năm|tháng|s|m|h|d|y)\s*$/i, '').trim();
          txt = txt.replace(/^(?:Bạn|You):\s*/i, '').trim();
          if (txt && !isSystemText(txt) && txt.length >= 2 && txt.length <= 80 && !/^\d+$/.test(txt)) {
            name = txt;
            break;
          }
        }
      }
      if (!name) {
        const lines = String(row.innerText || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!isSystemText(line) && line.length >= 2 && line.length <= 80 && !/^\d+$/.test(line) && !/^\d{1,2}:\d{2}$/.test(line)) {
            name = line;
            break;
          }
        }
      }
      if (!name || isSystemText(name)) {
        name = 'Khách hàng (' + thread_id.substring(0, 8) + ')';
      }

      // Trích xuất avatar URL
      let avatar_url = null;
      let avatar_base64 = null;
      const imgEl = row.querySelector('img[src*="fbcdn.net"], img[src*="scontent"], img.img, img');
      if (imgEl && imgEl.src && !/^data:/.test(imgEl.src) && !imgEl.src.includes('static.xx.fbcdn.net/rsrc.php')) {
        avatar_url = imgEl.src;
        if (imgEl.complete && imgEl.naturalWidth > 10) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = imgEl.naturalWidth || 56;
            canvas.height = imgEl.naturalHeight || 56;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgEl, 0, 0);
            avatar_base64 = canvas.toDataURL('image/jpeg', 0.85);
          } catch (e) {}
        }
      }

      // Trích xuất last_message (tin nhắn xem trước)
      let last_message = '';
      row.querySelectorAll('span, div, p').forEach(el => {
        const txt = el.textContent.trim();
        const isSeparatorJunk = /^[\s\u00b7\u2022.\-|•·]+$/.test(txt);
        if (txt && !isSeparatorJunk && txt !== name && !txt.includes(name) && !isSystemText(txt) && txt.length > 2 && txt.length < 200 && !/^\d+\s*(?:ngày|giờ|phút|năm|s|m|h|d|y)$/i.test(txt) && !/^\d{1,2}:\d{2}$/.test(txt)) {
          if (!last_message || txt.length < last_message.length) last_message = txt;
        }
      });

      threads.push({
        thread_id,
        name,
        last_message: (last_message || '').substring(0, 200),
        is_unread: false,
        avatar_url,
        avatar_base64,
        thread_url: window.location.href,
        page_id: pageId,
        source_type: 'page_messenger'
      });
    } catch (e) {}
  }

  return threads;
}

// ── Hàm scrape sidebar Facebook (chạy trong context trang) ──────────────────
// Hàm này được inject vào tab Facebook qua chrome.scripting.executeScript
function scrapeFacebookSidebar() {
  const threads = [];
  const seen = new Set();

  const isSystemText = (t) => {
    if (!t || typeof t !== 'string') return true;
    const str = t.trim();
    if (str.length < 2) return true;
    const pat = /^(?:Tất cả tin nhắn|Tất cả|All messages|All|Tin nhắn trực tiếp|Direct messages|Hộp thư đến|Hộp thư|Inbox|Chưa đọc|Unread|Đã xong|Done|Gắn dấu sao|Đã gắn dấu sao|Starred|Spam|Thư rác|Bình luận.*|Comments.*|Thông báo|Notifications|Đang hoạt động.*|Hoạt động.*|Active now|Active recently|Online|Offline|Đang|Facebook|Messenger|Meta)$/i;
    return pat.test(str);
  };

  // Tìm các thread item trong sidebar Messenger (bao gồm cả E2EE /messages/e2ee/t/ và chuẩn /messages/t/)
  const links = document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href*="/messages/requests/t/"], a[href*="/messages/requests/spam/t/"], a[href*="/messages/spam/t/"], a[href*="/messages/"], div[role="row"] a, div[role="listitem"] a');

  for (const link of links) {
    try {
      const href = link.getAttribute('href') || '';
      const threadIdMatch = href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/);
      if (!threadIdMatch) continue;

      const thread_id = decodeURIComponent(threadIdMatch[1]);
      let thread_url = href;
      try {
        thread_url = new URL(href, window.location.origin).toString();
      } catch (e) {}
      if (!thread_id || thread_id === 't' || thread_id === 'e2ee' || thread_id === 'requests' || thread_id === 'archived') continue;
      if (seen.has(thread_id)) continue;
      seen.add(thread_id);

      // Tìm container row ở đúng phạm vi item (role="row", role="listitem" hoặc link)
      const rowContainer = link.closest('div[role="row"], div[role="listitem"]') || link;

      // 2. Trích xuất Tên (Name) thông minh
      const nameEl = rowContainer.querySelector('h2') ||
        rowContainer.querySelector('[dir="auto"]') ||
        link.querySelector('[dir="auto"]') ||
        rowContainer.querySelector('span[style*="font-weight"]') ||
        rowContainer.querySelector('span');

      let rawName = String(rowContainer.innerText || nameEl?.innerText || nameEl?.textContent || '').split(/\n+/)[0].trim();
      rawName = rawName.replace(/(?:Tin nhắn và cuộc gọi|Em chào chị|Bạn và|Các bạn|được bảo mật|hoạt động|vừa xong).*$/i, '').trim();
      rawName = rawName.replace(/\s*\d+\s*(?:ngày|giờ|phút|năm|s|m|h|d|y)\s*$/i, '').trim();

      const PRESENCE_EXACT = /^(?:Đang|Đang hoạt động.*|Hoạt động(?:\s+\d+.*)?|Đã hoạt động.*|Active now|Active recently|Active \d+.*|Online|Offline)$/i;
      let name = rawName.substring(0, 60).trim();
      if (PRESENCE_EXACT.test(name) || name === 'Đang' || isSystemText(name)) {
        const lines = String(rowContainer.innerText || '').split(/\n+/);
        name = lines.find(l => l.trim() && !PRESENCE_EXACT.test(l.trim()) && !isSystemText(l.trim()) && l.trim() !== 'Đang' && l.length > 2) || '';
        name = name.substring(0, 60);
      }
      if (!name || isSystemText(name)) {
        name = ('Khách hàng (' + thread_id.substring(0, 8) + ')');
      }

      // 3. Kiểm tra trạng thái unread
      const hasUnreadDot = rowContainer.querySelector('[data-testid="unread-count"]') || rowContainer.querySelector('.unread') || rowContainer.querySelector('[aria-label*="unread"]') || rowContainer.querySelector('[aria-label*="Chưa đọc"]');

      // 4. Lấy đoạn tin nhắn cuối
      const spans = rowContainer.querySelectorAll('span');
      let last_message = '';
      for (const span of spans) {
        const txt = span.textContent.trim();
        const isSeparatorJunk = /^[\s\u00b7\u2022.\-|•·]+$/.test(txt);
        if (txt && !isSeparatorJunk && txt !== name && !txt.includes(name) && !isSystemText(txt) && txt.length > 2 && txt.length < 200 && !/^\d+\s*(?:ngày|giờ|phút|năm|s|m|h|d|y)$/i.test(txt)) last_message = txt;
      }

      // Icon-only Like has no text preview and Facebook may omit the unread dot.
      // Sidebar rows contain no composer quick-like control, so the exact SVG title is safe evidence.
      const sidebarLike = Array.from(rowContainer.querySelectorAll('svg title, img[alt], [aria-label], [title]')).some((el) =>
        /(?:giơ ngón tay cái|thumbs?\s*up|\blike\b|thích|👍)/i.test(String(el.textContent || el.getAttribute?.('alt') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim())
      );
      if (sidebarLike) last_message = '👍';
      // Hidden/background Messenger tabs may mark the open conversation read
      // before CRM sees it. Direction is therefore more reliable than unread:
      // Facebook prefixes our own sidebar previews with Bạn:/You:.
      const preview_is_outgoing = /^(?:Bạn|You)\s*:/i.test(String(last_message || '').trim());
      // 5. Lấy Avatar chuẩn phạm vi row (thẻ img, SVG image, background-image)
      let avatar_url = null;
      let avatar_base64 = null;
      const mediaElements = rowContainer.querySelectorAll('img, image, [style*="background-image"]');
      for (const el of mediaElements) {
        let src = el.currentSrc || el.src || el.getAttribute?.('xlink:href') || el.getAttribute?.('href') || '';
        if (!src && el.style?.backgroundImage) {
          const bgMatch = el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
          if (bgMatch) src = bgMatch[1];
        }
        if (src && !/^(?:data:|blob:)/i.test(src) && /(?:fbcdn|scontent|facebook\.com|platform\.facebook\.com)/i.test(src)) {
          avatar_url = src;
          // Vẽ trực tiếp ra canvas trong trang DOM nếu img đã load
          if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 10) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = el.naturalWidth || 56;
              canvas.height = el.naturalHeight || 56;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(el, 0, 0);
              avatar_base64 = canvas.toDataURL('image/jpeg', 0.85);
            } catch (e) {}
          }
          break;
        }
      }

      threads.push({
        thread_id,
        name,
        last_message,
        is_unread: !!hasUnreadDot,
        is_like: sidebarLike,
        preview_is_outgoing,
        avatar_url,
        avatar_base64,
        thread_url,
        is_e2ee: /\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?e2ee\/t\//.test(thread_url)
      });

      if (threads.length >= 100) break;
    } catch (e) {
      // Skip lỗi từng item
    }
  }

  return threads;
}

// ── Điều hướng/xác thực tab Facebook trước khi scrape lịch sử ──────────────

// Additive fallback for Message Requests. Request rows can expose their id in
// query parameters and wrap anchors in role=button instead of normal rows.
function scrapeMessageRequestsSidebar() {
  const threads = [];
  const seen = new Set();
  const controls = [...document.querySelectorAll('a[href], [role="row"], [role="listitem"], [role="button"]')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      // Ignore anchors in the open chat/main panel. Request conversations are
      // mounted in Facebook's narrow left list.
      return rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.left < Math.min(680, window.innerWidth * 0.55)
        && !element.closest('[role="tab"]');
    });
  const extractThread = (rawHref) => {
    const href = String(rawHref || '');
    const pathMatch = href.match(/\/messages\/e2ee\/(?:requests(?:\/spam)?|spam)\/t\/([^\/?#]+)/i)
      || href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/i);
    if (pathMatch) return decodeURIComponent(pathMatch[1]);
    try {
      const url = new URL(href, location.origin);
      return url.searchParams.get('thread_id') || url.searchParams.get('selected_item_id');
    } catch (_) { return null; }
  };
  for (const control of controls) {
    const anchors = control.tagName === 'A' ? [control] : [...control.querySelectorAll('a[href]')];
    let anchor = null;
    let threadId = null;
    for (const candidate of anchors) {
      const anchorRect = candidate.getBoundingClientRect();
      if (anchorRect.width <= 0 || anchorRect.height <= 0 || anchorRect.right <= 0
        || anchorRect.left >= Math.min(680, window.innerWidth * 0.55)) continue;
      threadId = extractThread(candidate.getAttribute('href') || candidate.href);
      if (threadId) { anchor = candidate; break; }
    }
    if (!threadId || seen.has(String(threadId))) continue;
    const row = control.closest('[role="row"], [role="listitem"], [role="button"]') || control;
    const rect = row.getBoundingClientRect();
    const lines = String(row.innerText || row.textContent || '').split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (rect.width <= 0 || rect.height <= 0 || lines.length === 0) continue;
    const image = row.querySelector('img[src], image[href]');
    if (!image && lines.length < 2) continue;
    const systemLine = /^(?:Có thể bạn biết|You may know|Spam|Thư rác|Xem thêm|See more)$/i;
    const name = lines.find((line) => !systemLine.test(line) && line.length >= 2 && line.length <= 80)
      || `Khách hàng (${String(threadId).slice(0, 8)})`;
    const lastMessage = [...lines].reverse().find((line) => line !== name && !systemLine.test(line) && line.length < 200) || '';
    const rawHref = anchor?.getAttribute('href') || anchor?.href || '';
    let threadUrl = rawHref;
    try { threadUrl = new URL(rawHref, location.origin).toString(); } catch (_) {}
    seen.add(String(threadId));
    threads.push({
      thread_id: String(threadId), name, last_message: lastMessage,
      is_unread: Boolean(row.querySelector('[aria-label*="Chưa đọc"], [aria-label*="unread"], [data-testid="unread-count"]')),
      avatar_url: image?.currentSrc || image?.src || image?.getAttribute?.('href') || null,
      avatar_base64: null, thread_url: threadUrl,
      is_e2ee: /\/messages\/(?:e2ee\/(?:requests(?:\/spam)?|spam)|(?:requests(?:\/spam)?|spam)\/e2ee|e2ee)\/t\//i.test(threadUrl)
    });
  }
  return threads;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractThreadIdFromMessengerUrl(url) {
  const match = String(url || '').match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/) ||
                String(url || '').match(/[?&](?:selected_item_id|thread_id)=(\d+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeMessengerUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, 'https://www.facebook.com').toString();
  } catch (e) {
    return null;
  }
}

async function getCurrentThreadIdInTab(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // URL là trạng thái định tuyến CHÍNH THỨC của Facebook (selected_item_id
        // được FB tự ghi khi mở hội thoại) - ưu tiên tuyệt đối. aria-selected
        // trên sidebar có thể stale và trỏ sang hội thoại khác sau khi
        // Business Suite điều hướng mà chưa kịp cập nhật highlight.
        const urlMatch = location.href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/) ||
                         location.href.match(/[?&](?:selected_item_id|thread_id)=(\d+)/);
        if (urlMatch) return decodeURIComponent(urlMatch[1]);

        const selected = document.querySelector('[role="navigation"] [aria-selected="true"], [role="gridcell"] [aria-selected="true"], [data-surface*="thread_list"] [aria-selected="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]');
        if (selected) {
          const links = selected.tagName === 'A' ? [selected] : Array.from(selected.querySelectorAll('a[href]'));
          for (const l of links) {
            const m = l.href?.match(/(?:selected_item_id|thread_id)=(\d+)/) || l.href?.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/);
            if (m) return m[1];
          }
        }

        return null;
      }
    });
    return res?.[0]?.result || null;
  } catch (e) {
    return null;
  }
}

async function findThreadUrlInTab(tabId, targetThreadId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (targetId) => {
        const links = Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href*="selected_item_id="]'));
        for (const link of links) {
          const href = link.getAttribute('href') || link.href || '';
          const match = href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/) || href.match(/(?:selected_item_id|thread_id)=(\d+)/);
          if (match && decodeURIComponent(match[1]) === String(targetId)) {
            return new URL(href, location.origin).toString();
          }
        }
        return null;
      },
      args: [String(targetThreadId)]
    });
    return res?.[0]?.result || null;
  } catch (e) {
    return null;
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let done = false;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Đọc các tên ứng viên đang hiển thị trên header khung chat Business Suite
// (so khớp danh tính sau điều hướng - không tin vào URL/aria-selected một mình).
// Trả về MẢNG dòng-text ứng viên (thứ tự trên->trái) vì header có nhiều phần tử
// data-surface, dòng đầu của wrapper có thể không phải tên khách.
async function getVisibleBizContactNames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const candidates = Array.from(document.querySelectorAll('[data-surface*="detail_column"]')).sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (Math.round(ra.top) - Math.round(rb.top)) || (Math.round(ra.left) - Math.round(rb.left));
        });
        const names = [];
        for (const el of candidates) {
          if (el.closest('[role="complementary"], aside')) continue;
          const lines = (el.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean);
          for (const txt of lines.slice(0, 3)) {
            if (txt && txt.length >= 2 && txt.length <= 80 && !/^\d+$/.test(txt) && !names.includes(txt)) {
              names.push(txt);
            }
          }
          if (names.length >= 6) break;
        }
        return names;
      }
    });
    const raw = Array.isArray(results?.[0]?.result) ? results[0].result : [];
    // 2026-09-29: bo label nut hanh dong ("Chuyen den thu muc Spam"...) khoi
    // candidate ten - header cua hoi thoai lanh render nut truoc ten, tracker
    // nhat nhầm label lam ten khach roi abort ca sync (thread_route_mismatch).
    // Chi con label -> mang rong -> verifyBizHeaderIdentity roi vao nhanh
    // "khong doc duoc header" (tin vao ID) thay vi abort.
    return (typeof FbCrmPageIdentityGate !== 'undefined')
      ? FbCrmPageIdentityGate.filterCandidateNames(raw)
      : raw;
  } catch (_) { return []; }
}

function looseBizNameMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Verify kiên nhẫn: SPA cập nhật URL/sidebar TRƯỚC khi header render lại tên,
// nên lần đọc đầu có thể thấy tên của hội thoại TRƯỚC. Poll tới timeoutMs;
// header không đọc được -> tin vào ID (không abort nhầm); hết giờ vẫn sai -> fail.
async function verifyBizHeaderIdentity(tabId, contactName, timeoutMs = 3500) {
  if (!contactName) return { ok: true, visible: null };
  const deadline = Date.now() + timeoutMs;
  let lastNames = [];
  while (Date.now() < deadline) {
    const names = await getVisibleBizContactNames(tabId);
    if (!names.length) return { ok: true, visible: null }; // không đọc được header -> tin vào ID
    lastNames = names;
    if (names.some((n) => looseBizNameMatch(n, contactName))) return { ok: true, visible: names[0] };
    await new Promise((r) => setTimeout(r, 350));
  }
  console.warn(`[FB Engine] [BIZ_IDENTITY] ❌ Header "${lastNames.slice(0, 2).join('" | "')}" không khớp "${contactName}" sau ${timeoutMs}ms`);
  return { ok: false, visible: lastNames[0] || null };
}

async function ensureTabOnThread(tab, targetThreadId, requestedThreadUrl, pageId = null, navigationToken = null, contactName = null, options = {}) {
  const targetId = String(targetThreadId);
  const forceCleanViewport = options?.forceCleanViewport === true;
  const isBiz = isBusinessSuiteUrl(tab.url);
  // Verify danh tính cuối cùng cho Business Suite: URL/aria-selected có thể
  // stale (khớp ID nhưng khung chat đang mount hội thoại KHÁC - reproduce
  // 2026-09-19: yêu cầu Phạm Hùng, tab đang mở Lê Kim Thanh Ngân).
  const verifyBizIdentity = async () => {
    if (!contactName) return true; // không có tên để đối chiếu -> tin vào ID
    // URL do Facebook TỰ ghi selected_item_id=<target> là bằng chứng định tuyến
    // mạnh nhất - override bộ đọc header (bộ này có thể nhặt nhãn nút hành động
    // kiểu "Chuyển đến thư mục Spam" thay vì tên khách - reproduce 2026-09-21).
    try {
      const fresh = await chrome.tabs.get(tab.id).catch(() => null);
      const urlId = String(fresh?.url || '').match(/[?&](?:selected_item_id|thread_id)=(\d+)/)?.[1];
      if (urlId && String(urlId) === targetId) return true;
    } catch (_) {}
    const verdict = await verifyBizHeaderIdentity(tab.id, contactName, 3500);
    return verdict.ok;
  };
  // URL tab là bằng chứng định tuyến chính thức: khi Facebook TỰ ghi
  // selected_item_id=<target> vào URL, hội thoại đó đã mở - tin tuyệt đối,
  // không veto bằng header (tránh race header render chậm hơn URL).
  const currentFromUrl = isBiz
    ? (String(tab.url || '').match(/[?&](?:selected_item_id|thread_id)=(\d+)/)?.[1] || null)
    : extractThreadIdFromMessengerUrl(tab.url);
  const currentFromPage = currentFromUrl || await getCurrentThreadIdInTab(tab.id);
  if (!forceCleanViewport && String(currentFromPage) === targetId) {
    if (isBiz) {
      if (currentFromUrl) return true; // URL khớp -> Facebook đã route đúng
      return await verifyBizIdentity();
    }
    return true;
  }

  // Business Suite keeps its existing routing path. Personal-navigation tokens
  // deliberately do not affect Page tabs.
  if (isBiz) {
    const pId = pageId || (tab.url?.match(/[?&]asset_id=(\d+)/)?.[1] || null);
    if (!pId) {
      console.warn('[FB Engine] Không thể chuyển Business Suite thread vì thiếu page_id:', targetId);
      return false;
    }

    // 1. Thử Fast DOM click trong sidebar của Business Suite trước
    try {
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (tid, name) => {
          const links = Array.from(document.querySelectorAll('a[href*="selected_item_id="], [role="row"] a, [role="listitem"] a, [data-surface*="thread_list"] a'));
          let link = links.find(a => {
            const href = a.getAttribute('href') || a.href || '';
            return href.includes(`selected_item_id=${tid}`);
          });

          if (!link && name) {
            const cleanName = name.trim().toLowerCase();
            const sidebar = document.querySelector('[role="navigation"]') || 
                            document.querySelector('[data-surface*="thread_list"]') || 
                            document.querySelector('div[role="grid"]') || 
                            document.body;
            const nodes = Array.from(sidebar.querySelectorAll('span, div'));
            const matchingNode = nodes.find(el => {
              const text = (el.textContent || '').trim().toLowerCase();
              return text === cleanName && el.children.length === 0;
            });
            if (matchingNode) {
              link = matchingNode.closest('a[href]') || matchingNode.closest('[role="row"]') || matchingNode.closest('[role="listitem"]') || matchingNode.closest('div[tabindex]');
            }
          }

          if (link) {
            if (typeof link.click === 'function') link.click();
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { ok: true, type: 'dom_biz_sidebar_click' };
          }
          return { ok: false };
        },
        args: [targetId, contactName]
      });

      if (clicked?.[0]?.result?.ok) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await delay(200);
          const currentId = await getCurrentThreadIdInTab(tab.id);
          if (String(currentId) === targetId) {
            // URL/aria khớp chưa đủ - header phải khớp tên mới tin SPA đã đổi hội thoại
            if (!(await verifyBizIdentity())) break;
            console.log(`[FB Engine] ✅ Navigation Business Suite tới thread ${targetId} thành công (dom_biz_sidebar_click)`);
            return true;
          }
        }
      }
    } catch (e) {
      console.warn('[FB Engine] Fast Business Suite DOM navigation thất bại, fallback sang tabs.update:', e.message);
    }

    const targetBizUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(pId)}&mailbox_id=${encodeURIComponent(pId)}&selected_item_id=${encodeURIComponent(targetId)}&thread_type=FB_MESSAGE`;
    try {
      const loadPromise = waitForTabComplete(tab.id, 8000);
      await chrome.tabs.update(tab.id, { url: targetBizUrl });
      await Promise.race([loadPromise, delay(4500)]);
      await delay(1500);

      const currentId = await getCurrentThreadIdInTab(tab.id);
      if (String(currentId) === targetId) return await verifyBizIdentity();
      console.warn(`[FB Engine] Business Suite chưa vào đúng thread. requested=${targetId}, current=${currentId || 'unknown'}`);
      return false;
    } catch (e) {
      console.warn('[FB Engine] Không thể chuyển Business Suite tab sang thread:', targetId, e.message);
      return false;
    }
  }

  // Personal Messenger: try fast SPA navigation (DOM or dynamic <a> click) first
  // to avoid destroying tab JS state with unnecessary full-page reloads.
  const isMessengerTab = tab.url && /\/messages(?:\/|$|\?)/.test(tab.url);
  const requestedUrlThreadId = extractThreadIdFromMessengerUrl(requestedThreadUrl);
  const trustedRequestedThreadUrl = requestedUrlThreadId && String(requestedUrlThreadId) === targetId
    ? requestedThreadUrl
    : null;
  if (requestedThreadUrl && !trustedRequestedThreadUrl) {
    console.warn(`[FB Engine] Ignore stale thread_url. requested=${targetId}, urlThread=${requestedUrlThreadId || 'unknown'}`);
  }
  const targetPath = trustedRequestedThreadUrl
    ? (new URL(trustedRequestedThreadUrl, 'https://www.facebook.com')).pathname
    : `/messages/t/${encodeURIComponent(targetId)}/`;

  // A thread switch requested by CRM must not reuse the old React viewport.
  // Go through the canonical route below in that case; SPA link click may
  // update location.href before it replaces the mounted message rows.
  if (isMessengerTab && !forceCleanViewport) {
    try {
      if (!isPersonalNavigationCurrent(navigationToken)) return false;
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (tid, reqUrl) => {
          const links = Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]'));
          const link = links.find((anchor) => {
            const href = anchor.getAttribute('href') || anchor.href || '';
            const match = href.match(/\/messages\/(?:(?:requests(?:\/spam)?|spam)\/)?(?:e2ee\/)?t\/([^\/?#]+)/i);
            return match && String(decodeURIComponent(match[1])) === String(tid);
          });

          if (link) {
            if (typeof link.click === 'function') link.click();
            else link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { ok: true, type: 'dom_sidebar_click' };
          }

          const targetPath = reqUrl
            ? (new URL(reqUrl, location.origin)).pathname
            : `/messages/t/${encodeURIComponent(tid)}/`;

          window.location.href = targetPath;
          return { ok: true, type: 'location_assign' };
        },
        args: [targetId, trustedRequestedThreadUrl]
      });

      if (clicked?.[0]?.result?.ok) {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (!isPersonalNavigationCurrent(navigationToken)) return false;
          await delay(200);
          const currentId = await getCurrentThreadIdInTab(tab.id);
          if (String(currentId) === targetId) {
            console.log(`[FB Engine] ✅ Navigation tới thread ${targetId} thành công (${clicked[0].result.type})`);
            return true;
          }
        }
      }
    } catch (e) {
      console.warn('[FB Engine] Fast SPA navigation thất bại, fallback sang tabs.update:', e.message);
    }
  }

  // Fallback: full-page update if tab was not on /messages or SPA routing did not update location.href
  const canonicalUrl = trustedRequestedThreadUrl || `https://www.facebook.com/messages/t/${encodeURIComponent(targetId)}`;
  try {
    if (!isPersonalNavigationCurrent(navigationToken)) return false;
    const loadPromise = waitForTabComplete(tab.id, 8000);
    await chrome.tabs.update(tab.id, { url: canonicalUrl });
    await Promise.race([loadPromise, delay(4000)]);
    await delay(800);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (!isPersonalNavigationCurrent(navigationToken)) return false;
      await delay(250);
      const currentId = await getCurrentThreadIdInTab(tab.id);
      if (String(currentId) === targetId) {
        console.log(`[FB Engine] ✅ Personal Messenger đã vào đúng thread ${targetId} via tabs.update`);
        return true;
      }
    }
  } catch (e) {
    console.warn('[FB Engine] Điều hướng URL Messenger cá nhân thất bại:', targetId, e.message);
  }

  return false;
}

// ── Đồng bộ lịch sử tin nhắn của 1 hội thoại cụ thể ────────────────────────
async function dispatchTrustedMouseClick(tabId, point) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  } catch (error) {
    console.warn('[FB Engine] Trusted message-request click failed:', error.message);
    return false;
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}

async function inspectMessageRequestControls(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
      const actionLabels = new Map([
        ['chấp nhận', 'accept'], ['accept', 'accept'],
        ['tiếp tục', 'continue'], ['continue', 'continue'],
        ['xóa', 'delete'], ['delete', 'delete'],
        ['chặn', 'block'], ['block', 'block'],
        ['từ chối', 'decline'], ['decline', 'decline'], ['reject', 'decline'],
        ['từ chối yêu cầu', 'decline'], ['từ chối kết bạn', 'decline'],
        ['decline request', 'decline'], ['ignore', 'decline']
      ]);
      // Also detect buttons whose label starts with 'từ chối' (covers all variants)
      const declinePrefixTest = (label) => label.startsWith('từ chối') || label.startsWith('decline') || label.startsWith('reject');
      const visible = (element) => {
        if (!element || element.closest('[aria-hidden="true"]')) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const controls = [];
      for (const element of document.querySelectorAll('button, [role="button"], a[role="button"]')) {
        if (!visible(element)) continue;
        const labels = [element.innerText, element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')];
        const action = labels.map(normalize).map((label) => actionLabels.get(label) || (declinePrefixTest(label) ? 'decline' : undefined)).find(Boolean);
        if (!action) continue;
        const rect = element.getBoundingClientRect();
        controls.push({ action, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inDialog: Boolean(element.closest('[role="dialog"][aria-modal="true"]')) });
      }
      const unique = [];
      for (const control of controls) {
        if (!unique.some((item) => item.action === control.action)) unique.push(control);
      }
      const pageText = normalize(document.body?.innerText);
      const contactUnavailable = /không (?:thể|còn) liên lạc|can't (?:contact|message)|cannot (?:contact|message)/i.test(pageText);
      return { controls: unique, contactUnavailable, href: location.href };
    }
  });
  return result?.[0]?.result || { controls: [], contactUnavailable: false };
}

async function handleMessageRequestAction(data) {
  const requestId = String(data.request_id || '');
  const threadId = String(data.external_thread_id || data.thread_id || '');
  const accountId = String(data.account_id || user_id || '');
  const action = String(data.action || 'query');
  const reply = (payload) => sendToBackend('MESSAGE_REQUEST_ACTION_RESULT', {
    request_id: requestId, thread_id: data.thread_id || threadId, action, ...payload
  });
  if (!requestId || !threadId || !accountId || !['query', 'accept', 'continue', 'delete', 'block', 'decline'].includes(action)) {
    reply({ success: false, error: 'INVALID_MESSAGE_REQUEST_ACTION' });
    return;
  }
  try {
    const tab = await ensureRoleMessengerTab(accountId, 'request_action');
    if (!tab?.id) throw new Error('Không tìm thấy tab Messenger của tài khoản.');
    await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
    const navigationToken = beginPersonalNavigation(accountId);
    const onThread = await ensureTabOnThread(tab, extractBareThreadId(threadId), data.thread_url || null, null, navigationToken, data.contact_name || null);
    if (!onThread) throw new Error('Không mở đúng được hội thoại Tin nhắn chờ trên Messenger.');
    let snapshot = { controls: [], contactUnavailable: false };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      snapshot = await inspectMessageRequestControls(tab.id);
      if (snapshot.controls.length || snapshot.contactUnavailable) break;
      await delay(250);
    }
    if (action === 'query') {
      reply({ success: true, available_actions: snapshot.controls.map((control) => control.action), contact_unavailable: snapshot.contactUnavailable });
      return;
    }
    const requestedControl = snapshot.controls.find((control) => control.action === action)
      || (action === 'accept' ? snapshot.controls.find((control) => control.action === 'continue') : null)
      || (action === 'decline' ? snapshot.controls.find((control) => control.action !== 'accept' && control.action !== 'continue') : null);
    if (!requestedControl) throw new Error(`Messenger hiện không có nút ${action} cho hội thoại này.`);
    if (!await dispatchTrustedMouseClick(tab.id, requestedControl)) throw new Error('Không thể gửi cú bấm tin cậy tới Messenger.');
    await delay(450);
    const confirmation = await inspectMessageRequestControls(tab.id).catch(() => ({ controls: [] }));
    const confirmationControl = confirmation.controls.find((control) => control.action === action && control.inDialog);
    if (confirmationControl) {
      if (!await dispatchTrustedMouseClick(tab.id, confirmationControl)) throw new Error('Không thể xác nhận thao tác trên Messenger.');
      await delay(500);
    }
    const after = await inspectMessageRequestControls(tab.id).catch(() => ({ controls: [] }));
    reply({ success: true, available_actions: after.controls.map((control) => control.action), contact_unavailable: Boolean(after.contactUnavailable) });
  } catch (error) {
    reply({ success: false, error: error.message || 'MESSAGE_REQUEST_ACTION_FAILED' });
  }
}

async function handleSyncThreadMessages({ account_id, thread_id, external_thread_id = null, thread_url, page_id = null, mode = 'initial', cursor = null, contact_name = null, reason = null, allow_navigation = false, scroll_delta = 0, _history_tab_id = null }) {
  console.log(`[FB Engine] 🔄 Sync lịch sử tin nhắn cho thread: ${thread_id} (${contact_name || 'unknown'}, account=${account_id || user_id}) mode=${mode}`);
  if (!thread_id) return;
  const allowedReasons = new Set(['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport', 'initial_sweep', 'manual_resync', 'history_retry', 'sidebar_incoming']);
  const baseReason = String(reason || '').replace(/(?:_replay)+$/, '');
  if (!_history_tab_id && (allow_navigation !== true || !allowedReasons.has(baseReason))) {
    sendToBackend('THREAD_MESSAGES_SYNCED', {
      account_id: account_id || user_id,
      thread_id,
      messages: [],
      reason: 'navigation_not_authorized',
      mode,
      cursor
    });
    return;
  }
  // If user has explicitly clicked a thread, the history tab is locked to it.
  // Background sync for any OTHER thread must not navigate the history tab.
  const isUserDrivenReason = ['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport'].includes(baseReason);
  if (!_history_tab_id && !page_id && !isUserDrivenReason
    && userNavigationLockThreadId
    && userNavigationLockThreadId !== String(thread_id || '')) {
    console.log(`[FB Engine] [NAV_LOCK] Skipping background sync for thread=${thread_id} — history tab locked to ${userNavigationLockThreadId}`);
    sendToBackend('THREAD_MESSAGES_SYNCED', {
      account_id: account_id || user_id,
      thread_id,
      messages: [],
      reason: 'navigation_locked_by_user_selection',
      mode,
      cursor
    });
    return;
  }
  if (page_id && !isUserDrivenReason) {
    const pid = String(page_id);
    const lockedUntil = pageNavigationLockUntil.get(pid) || 0;
    const lockedThread = pageNavigationLockThreadId.get(pid);
    if (Date.now() < lockedUntil && lockedThread && lockedThread !== String(thread_id || '')) {
      console.log(`[FB Engine] [PAGE_NAV_LOCK] Skipping background sync for thread=${thread_id} on page=${pid} — tab locked to ${lockedThread}`);
      sendToBackend('THREAD_MESSAGES_SYNCED', {
        account_id: account_id || user_id,
        thread_id,
        page_id: pid,
        messages: [],
        reason: 'page_locked_by_user_action',
        mode,
        cursor
      });
      return;
    }
  }
  const targetAcc = account_id || user_id;
  const navigationThreadId = extractBareThreadId(external_thread_id || thread_id);
  const usesVisibleCrmTab = !page_id && !_history_tab_id
    && ['crm_navigation', 'crm_scroll_older', 'crm_scroll_viewport'].includes(baseReason);
  const navigationToken = (page_id || _history_tab_id)
    ? null
    : beginPersonalNavigation(`${targetAcc}:history`);

  // Page threads use the exact Business Suite asset. Personal threads always
  // go through ensureFacebookMessagesTab, which validates c_user/account_id;
  // never trust an arbitrary active Messenger tab.
  let tab = _history_tab_id
    ? await chrome.tabs.get(_history_tab_id).catch(() => null)
    : page_id
      ? await getBusinessSuiteTab(page_id)
      : await ensureRoleMessengerTab(targetAcc, 'history');

  if (!tab && page_id) {
    const pageTargetUrl = thread_url || `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(page_id)}&mailbox_id=${encodeURIComponent(page_id)}&selected_item_id=${encodeURIComponent(navigationThreadId)}&thread_type=FB_MESSAGE`;
    tab = await new Promise((resolve) => {
      chrome.tabs.create({ url: pageTargetUrl, active: false }, (createdTab) => {
        if (createdTab?.id) {
          registerTab(`page:${page_id}`, createdTab.id).catch(() => {});
          chrome.tabs.update(createdTab.id, { pinned: true }).catch(() => {});
        }
        resolve(createdTab);
      });
    });
    if (tab?.id) await Promise.race([waitForTabComplete(tab.id, 12000), delay(3500)]);
  }
  if (!tab) {
    console.warn('[FB Engine] Không có/tạo được Chrome tương ứng để sync thread messages.');
    sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'no_background_tab', mode, cursor });
    return;
  }

  if (!isPersonalNavigationCurrent(navigationToken)) {
    sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'navigation_superseded', mode, cursor });
    return;
  }
  const manualHistoryOwner = usesVisibleCrmTab ? navigationToken?.sequence : null;
  if (usesVisibleCrmTab) manualHistoryTabOwners.set(tab.id, manualHistoryOwner);
  const lastCrmThreadId = usesVisibleCrmTab ? String(crmHistoryThreadByTab.get(tab.id) || '') : '';
  const forceCleanViewport = usesVisibleCrmTab && Boolean(lastCrmThreadId) && lastCrmThreadId !== navigationThreadId;
  const releaseManualHistoryOwner = () => {
    if (usesVisibleCrmTab && manualHistoryTabOwners.get(tab.id) === manualHistoryOwner) {
      manualHistoryTabOwners.delete(tab.id);
    }
  };
  // 2026-09-29: Focus the page's Business Suite tab before scanning. Chrome
  // throttles rendering of background tabs, which stretched each scan cycle
  // to 20-40s and blew the lane deadline mid-scan - successful batches were
  // still reported as extension_history_timeout (reproduce: SW console log,
  // batch committed then deadline fired for the same thread). Focusing the
  // per-page tab is also the requested UX: the operator sees which
  // conversation is being synced.
  if (page_id && tab && tab.id != null) {
    chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null) {
      chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }
  const onTargetThread = await ensureTabOnThread(
    tab,
    navigationThreadId,
    thread_url,
    page_id,
    navigationToken,
    contact_name,
    { forceCleanViewport }
  )
    .catch((error) => {
      console.warn('[FB Engine] Messenger navigation failed:', error?.message || error);
      return false;
    });
  if (!isPersonalNavigationCurrent(navigationToken)) {
    console.log(`[FB Engine] Bỏ sync thread ${thread_id}: đã có click Messenger cá nhân mới hơn.`);
    sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'navigation_superseded', mode, cursor });
    releaseManualHistoryOwner();
    return;
  }
  let currentTabThreadId = await getCurrentThreadIdInTab(tab.id);
  // 2026-09-29: Facebook ghi selected_item_id vao URL TRE tren hoi thoai lanh
  // (chua tung mo) - doc 1 lan tra null va day ca sync vao nhanh header fallback.
  // Thu lai toi da 2 lan x 1s cho page thread truoc khi cham dich.
  if (page_id && String(currentTabThreadId || '') !== String(navigationThreadId || '')) {
    for (let attempt = 0; attempt < 2 && String(currentTabThreadId || '') !== String(navigationThreadId || ''); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      currentTabThreadId = await getCurrentThreadIdInTab(tab.id);
    }
  }
  const updatedTab = await chrome.tabs.get(tab.id).catch(() => tab);

  console.log(`[DOM Sync Verification] requested thread: ${thread_id} | current Facebook URL: ${updatedTab?.url || tab.url} | current thread id: ${currentTabThreadId}`);

  if (onTargetThread) crmHistoryThreadByTab.set(tab.id, navigationThreadId);

  // Page thread yêu cầu danh tính NGHIÊM NGẶT: URL (Facebook tự ghi
  // selected_item_id khi mở hội thoại) là bằng chứng chính - khớp là ĐỦ, không
  // phụ thuộc onTargetThread (verify header có thể nhặt nhầm nhãn nút hành
  // động kiểu "Chuyển đến thư mục Spam" - reproduce 2026-09-21). Chỉ khi URL
  // không có ID mới dùng header làm bằng chứng phụ.
  let pageIdentityOk = true;
  let routeDetail = null;
  if (page_id) {
    if (currentTabThreadId != null && String(currentTabThreadId) === String(navigationThreadId)) {
      pageIdentityOk = true;
    } else if (contact_name) {
      const verdict = await verifyBizHeaderIdentity(tab.id, contact_name, 10000);
      pageIdentityOk = verdict.ok;
      routeDetail = verdict.visible || 'không đọc được';
      if (!pageIdentityOk) {
        console.warn(`[FB Engine] [PAGE_IDENTITY] ❌ Header "${routeDetail}" không khớp "${contact_name}" cho thread ${thread_id}`);
      }
    } else {
      pageIdentityOk = false;
    }
  }

  if (!onTargetThread || !pageIdentityOk || (currentTabThreadId && String(currentTabThreadId) !== navigationThreadId)) {
    console.warn(`[DOM Sync Verification] ⚠️ Tab Facebook đang mở thread ${currentTabThreadId || 'khác'} (header: ${routeDetail || 'n/a'}), không khớp thread ${thread_id}. Hủy sync để tránh ghi nhầm DB.`);
    sendToBackend('THREAD_MESSAGES_SYNCED', {
      account_id: targetAcc,
      thread_id,
      page_id: page_id || null,
      messages: [],
      reason: page_id ? 'thread_route_mismatch' : 'url_mismatch',
      route_detail: page_id ? routeDetail : null,
      mode,
      cursor
    });
    releaseManualHistoryOwner();
    return;
  }

  if (page_id) {
    const pageMode = mode === 'ondemand_older' ? 'page_scroll_older' : (mode === 'ondemand_viewport' ? 'ondemand_viewport' : 'page_initial');
    chrome.tabs.sendMessage(tab.id, {
      type: 'REQUEST_PAGE_BATCH_SYNC',
      data: { account_id: targetAcc, thread_id, page_id, mode: pageMode, cursor, expected_bare_id: navigationThreadId, contact_name: contact_name || null }
    }).catch(async (error) => {
      console.warn('[FB Engine] Page content script unavailable:', error?.message || error);
      if (error?.message && error.message.includes('Receiving end does not exist')) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['textFilter.js', 'pageTimestampParser.js', 'threadScanStateMachine.js', 'pageDirection.js', 'pageActiveScroller.js', 'pageVideoDetector.js', 'pageNameExtractor.js', 'page_content.js']
          });
          await new Promise(r => setTimeout(r, 600));
          return chrome.tabs.sendMessage(tab.id, {
            type: 'REQUEST_PAGE_BATCH_SYNC',
            data: { account_id: targetAcc, thread_id, page_id, mode: pageMode, cursor, expected_bare_id: navigationThreadId, contact_name: contact_name || null }
          });
        } catch (injectErr) {
          console.warn('[FB Engine] Re-inject page scripts thất bại:', injectErr.message);
        }
      }
      sendToBackend('PAGE_SCROLLER_DEBUG', { thread_id, stage: 'TAB_DISCONNECTED', error: error?.message || String(error) });
      sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'page_content_unavailable', mode, cursor });
    });
    return;
  }
  // Messenger can leave a newly opened conversation completely unmounted in
  // an inactive background tab. Activate initial sync as well as older-page
  // sync so a blank CRM conversation does not require sending a message before
  // Facebook creates its first message rows.
  let previousActiveTabId = null;
  if (!page_id && ['ondemand_initial', 'ondemand_viewport', 'ondemand_older'].includes(mode)) {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    if (activeTab?.id && activeTab.id !== tab.id) previousActiveTabId = activeTab.id;
    await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Facebook ignores synthetic WheelEvent for its virtualized history list.
  // Dispatch one trusted CDP wheel at the actual chat scroller before parsing,
  // so React mounts the preceding page just as it does for a real user wheel.
  let trustedHistoryViewportChanged = false;
  if (!page_id && (mode === 'ondemand_older' || (mode === 'ondemand_viewport' && Number(scroll_delta) < 0))) {
    const pointResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const main = document.querySelector('div[role="main"]');
        if (!main) return null;
        const rows = [...main.querySelectorAll('div[role="row"], div[role="article"], [data-message-id]')];
        const candidates = new Set();
        for (const row of rows) {
          let node = row;
          while (node && node !== main.parentElement) {
            const style = getComputedStyle(node);
            if (node.scrollHeight > node.clientHeight + 8 && ['auto', 'scroll'].includes(style.overflowY)) candidates.add(node);
            node = node.parentElement;
          }
        }
        const scroller = [...candidates].sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth))[0];
        const rect = (scroller || main).getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const identity = rows.map((row) => (
          row.querySelector('[data-message-id]')?.getAttribute('data-message-id')
          || row.getAttribute('data-message-id')
          || row.getAttribute('aria-label')
          || String(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        )).filter(Boolean).join('||');
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + Math.min(rect.height - 24, Math.max(24, rect.height / 2)),
          height: rect.height,
          identity
        };
      }
    }).catch(() => []);
    const wheelPoint = pointResult?.[0]?.result || null;
    const wheelDistance = -Math.max(720, Math.min(1800, Number(wheelPoint?.height || 600) * 1.25));
    const trustedWheel = await dispatchTrustedHistoryWheel(tab.id, wheelPoint, wheelDistance);
    console.log(`[FB History CDP] trusted wheel success=${!!trustedWheel.success} delta=${wheelDistance}${trustedWheel.error_code ? ` error=${trustedWheel.error_code}` : ''}`);
    if (trustedWheel.success) {
      // A trusted wheel being accepted is not proof that Messenger finished
      // mounting the previous virtual page. Wait for a different row set and
      // for its loading indicator to settle before the parser takes a snapshot.
      let stableChangedRounds = 0;
      for (let waitRound = 0; waitRound < 24; waitRound += 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
        const viewportState = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (beforeIdentity) => {
            const main = document.querySelector('div[role="main"]');
            if (!main) return { changed: false, loading: true };
            const rows = [...main.querySelectorAll('div[role="row"], div[role="article"], [data-message-id]')];
            const afterIdentity = rows.map((row) => (
              row.querySelector('[data-message-id]')?.getAttribute('data-message-id')
              || row.getAttribute('data-message-id')
              || row.getAttribute('aria-label')
              || String(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
            )).filter(Boolean).join('||');
            return {
              changed: Boolean(afterIdentity && afterIdentity !== beforeIdentity),
              loading: Boolean(main.querySelector('svg[aria-label="Loading"], div[role="progressbar"]'))
            };
          },
          args: [String(wheelPoint?.identity || '')]
        }).then((rows) => rows?.[0]?.result).catch(() => null);
        stableChangedRounds = viewportState?.changed && !viewportState?.loading
          ? stableChangedRounds + 1
          : 0;
        if (stableChangedRounds >= 3) {
          trustedHistoryViewportChanged = true;
          break;
        }
      }
      console.log(`[FB History CDP] viewport changed=${trustedHistoryViewportChanged}`);
    }
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (targetThreadId, mode, cursor, contactName, scrollDelta, trustedViewportChanged) => {
        const MESSAGE_ROW_SELECTOR = 'div[role="row"], div[role="article"]';
        const FALLBACK_MESSAGE_SELECTOR = 'div[data-scope="messages_table"] div[dir="auto"]';
        const UI_EXCLUDE = 'form, [contenteditable="true"], [role="textbox"], [role="contentinfo"], header, nav, [role="complementary"]';
        function collectMessageRows(root) {
          // Messenger currently mixes several generations of message markup
          // in one mounted viewport. Some bubbles are role=row/article while
          // others expose only data-message-id or a semantic aria-label. Do
          // not stop at the first selector that happens to return something:
          // that previously reduced a fully mounted latest viewport to only
          // one or two messages.
          const rows = new Set(Array.from(root.querySelectorAll(MESSAGE_ROW_SELECTOR)));
          const semanticUnits = root.querySelectorAll(
            '[data-message-id], [data-scope="messages_table"][aria-label], [aria-roledescription][aria-label]'
          );
          for (const unit of semanticUnits) {
            if (unit.closest(UI_EXCLUDE)) continue;
            const wrapper = unit.closest(MESSAGE_ROW_SELECTOR);
            rows.add(wrapper && root.contains(wrapper) ? wrapper : unit);
          }
          if (rows.size === 0) {
            Array.from(root.querySelectorAll(FALLBACK_MESSAGE_SELECTOR))
            .filter((node) => !node.closest(UI_EXCLUDE))
            .filter((node) => node.hasAttribute('data-message-id') || node.closest('[data-message-id], [aria-roledescription]'))
            .forEach((node) => rows.add(node.closest(MESSAGE_ROW_SELECTOR) || node));
          }
          return [...rows].filter((node) => root.contains(node)).sort((left, right) => {
            if (left === right) return 0;
            return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
          });
        }
        // 1. Helper chờ DOM Ready
        async function waitForThreadDomReady(targetThreadId, timeoutMs = 8000) {
          const startTime = Date.now();
          let lastReason = 'timeout';
          let emptySince = 0;
          let lastRowsSignature = '';
          let stableRowsRounds = 0;

          while (Date.now() - startTime < timeoutMs) {
            // Personal Messenger exposes the thread in /messages/t/<id>;
            // Business Suite exposes it as selected_item_id/thread_id query params.
            const currentThreadMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/) ||
              location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
            const currentThreadId = currentThreadMatch ? decodeURIComponent(currentThreadMatch[1]) : null;
            if (String(currentThreadId) !== String(targetThreadId)) {
              lastReason = 'url_mismatch';
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // Kiểm tra sidebar active nếu có
            const activeSidebarItem = document.querySelector('a[aria-current="page"][href*="/messages/"], a[aria-current="true"][href*="/messages/"]');
            if (activeSidebarItem) {
              const activeUrl = activeSidebarItem.getAttribute('href') || '';
              const activeMatch = activeUrl.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/);
              const activeId = activeMatch ? decodeURIComponent(activeMatch[1]) : null;
              if (activeId && String(activeId) !== String(targetThreadId)) {
                lastReason = 'sidebar_mismatch';
                await new Promise(r => setTimeout(r, 400));
                continue;
              }
            }

            // Kiểm tra error screen
            const errorNodes = document.querySelectorAll('span[dir="auto"], div[dir="auto"]');
            let isErrorScreen = false;
            for (const node of errorNodes) {
              const txt = node.textContent || '';
              if (txt.includes('Nội dung này hiện không hiển thị') || txt.includes('This content isn\'t available') || txt.includes('hiện không có mặt') || txt.includes('unavailable')) {
                isErrorScreen = true;
                break;
              }
            }
            if (isErrorScreen) return { ok: false, reason: 'error_screen' };

            // Kiểm tra message rows trong main
            const mainContainer = document.querySelector('div[role="main"]');
            if (!mainContainer) {
              lastReason = 'no_main_container';
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // A Facebook SPA route changes before React replaces the old
            // conversation DOM. URL equality alone can therefore scrape user
            // A's rows into user B. When a contact name is available, wait
            // until the mounted conversation identity agrees as well.
            if (contactName) {
              const normalizeIdentity = (value) => String(value || '')
                .normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
              const expectedIdentity = normalizeIdentity(contactName);
              const conversationLabel = mainContainer.querySelector(
                '[aria-label^="Tin nhắn trong cuộc trò chuyện với "], [aria-label^="Messages in conversation with "]'
              )?.getAttribute('aria-label') || '';
              const labelIdentity = normalizeIdentity(conversationLabel
                .replace(/^(?:Tin nhắn trong cuộc trò chuyện với|Messages in conversation with)\s+/i, ''));
              const headingCandidates = Array.from(mainContainer.querySelectorAll('h1, h2, span[aria-level="1"], span[aria-level="2"]'))
                .map((node) => normalizeIdentity(node.textContent))
                .filter(Boolean);
              const hasIdentitySignal = Boolean(labelIdentity || headingCandidates.length);
              const identityReady = !hasIdentitySignal || labelIdentity === expectedIdentity || headingCandidates.includes(expectedIdentity);
              if (!identityReady) {
                lastReason = 'contact_identity_pending';
                await new Promise(r => setTimeout(r, 250));
                continue;
              }
            }

            const existingRows = collectMessageRows(mainContainer);
            if (existingRows.length === 0) {
              const composerReady = !!mainContainer.querySelector('[contenteditable="true"], [role="textbox"]');
              const loading = !!mainContainer.querySelector('svg[aria-label="Loading"], div[role="progressbar"]');
              if (composerReady && !loading) {
                if (!emptySince) emptySince = Date.now();
                // A just-activated background tab often exposes its composer
                // 1-2 seconds before React mounts historical rows. Preserve
                // the old short wait for other modes, but give first-open sync
                // enough time to hydrate an apparently blank conversation.
                const emptyConfirmationMs = mode === 'ondemand_initial' ? 4000 : 1200;
                if (Date.now() - emptySince >= emptyConfirmationMs) return { ok: true, empty: true, mainContainer };
              } else emptySince = 0;
              lastReason = 'no_rows';
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // Kiểm tra marker crmThreadId từ content.js
            let markerMismatch = false;
            for (const row of existingRows) {
              const taggedId = row.dataset.crmThreadId;
              if (taggedId && String(taggedId) !== String(targetThreadId)) {
                markerMismatch = true;
                break;
              }
            }
            if (markerMismatch) {
              lastReason = 'marker_mismatch';
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            // Route readiness occurs before React has necessarily mounted the
            // whole latest viewport. Wait for the visible row set to settle,
            // otherwise an initial sync can persist only the last 1-2 bubbles.
            const rowsSignature = existingRows.map((row) => (
              row.querySelector('[data-message-id]')?.getAttribute('data-message-id')
              || row.getAttribute('data-message-id')
              || row.getAttribute('aria-label')
              || String(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            )).join('|');
            if (rowsSignature && rowsSignature === lastRowsSignature) stableRowsRounds += 1;
            else stableRowsRounds = 0;
            lastRowsSignature = rowsSignature;
            if (stableRowsRounds >= 3) return { ok: true, mainContainer };
            lastReason = 'rows_settling';
            await new Promise(r => setTimeout(r, 250));
          }
          return { ok: false, reason: lastReason };
        }

        const domReadyStatus = await waitForThreadDomReady(
          targetThreadId,
          mode === 'bulk_full' ? 30000 : 8000
        );
        if (!domReadyStatus.ok) {
          return { _reason: domReadyStatus.reason };
        }

        const mainContainer = domReadyStatus.mainContainer;

        // 2. Helper scroll lazy load nhiều vòng
        let boundaryReached = false;
        let stopReason = null;
        const boundaryId = mode === 'incremental'
          ? cursor?.newest_message_id
          : (mode === 'ondemand_older' ? cursor?.oldest_message_id : null);
        const boundaryContent = mode === 'ondemand_older' ? String(cursor?.oldest_content || '').trim() : '';
        const boundaryMediaUrl = mode === 'ondemand_older' ? String(cursor?.oldest_media_url || '') : '';
        const boundaryTimestampMs = mode === 'ondemand_older' ? Number(cursor?.oldest_timestamp_ms || 0) : 0;
        // Keep the durable resume marker separate from the moving per-page
        // cursor. Reopening a thread mounts the newest viewport first; that
        // initial page must not erase where the previous crawl stopped.
        const resumeMarkerId = String(cursor?.resume_message_id || '').replace(/_media$/, '');
        const resumeMarkerContent = String(cursor?.resume_content || '').trim();
        const resumeMarkerTimestampMs = Number(cursor?.resume_timestamp_ms || 0);
        let resumeMarkerReached = cursor?.resume_marker_reached === true;
        // Round-budget phải khớp đúng mode server thực sự gửi (initial/incremental/deep_backfill) -
        // trước đây map này canh theo 'backfill' (không bao giờ được gửi) nên 'initial', mode quan
        // trọng nhất cho lần sync đầu tiên, luôn rơi vào default 5 vòng.
        // One navigation pass must persist one Facebook virtualized page. If
        // several pages are scrolled inside one executeScript call, React
        // unmounts the intermediate rows before the parser runs and CRM loses
        // them. Multi-page sync still works through the existing checkpoint /
        // next-batch loop, but every page is now extracted before continuing.
        const ROUND_BUDGET = { incremental: 1, ondemand_initial: 1, ondemand_older: 1, initial: 1, deep_backfill: 1, bulk_full: 1 };
        function findHistoryScroller(container) {
          const rows = collectMessageRows(container);
          const candidates = new Set([container]);
          for (const seed of [container.querySelector('[role="log"]'), container.querySelector('[data-scope="messages_table"]'), rows[0], rows[rows.length - 1]].filter(Boolean)) {
            let node = seed;
            while (node && node !== document.body) {
              candidates.add(node);
              node = node.parentElement;
            }
          }
          for (const node of container.querySelectorAll('div')) {
            if (node.scrollHeight > node.clientHeight + 40) candidates.add(node);
          }
          return [...candidates].map((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const range = Math.max(0, node.scrollHeight - node.clientHeight);
            const score = range
              + (['auto', 'scroll'].includes(style.overflowY) ? 100000 : 0)
              + (rows.some((row) => node.contains(row)) ? 200000 : 0)
              + (rect.width > 180 && rect.height > 180 ? 50000 : 0);
            return { node, score };
          }).filter(({ node }) => node.scrollHeight > node.clientHeight + 8)
            .sort((a, b) => b.score - a.score)[0]?.node || null;
        }

        function historyRowIdentity(row) {
          const marker = row?.querySelector?.('[data-message-id], [data-id], [id^="mid."]') || row;
          const nativeId = marker?.getAttribute?.('data-message-id') || marker?.getAttribute?.('data-id') || marker?.getAttribute?.('id');
          if (nativeId) return nativeId;
          if (!row) return '';
          // Some Messenger rows expose no stable id. This fingerprint is only
          // used to wait until the virtualized page has actually changed.
          const labels = Array.from(row.querySelectorAll('[aria-label], [title], time[datetime]'))
            .slice(0, 8)
            .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('datetime') || '')
            .filter(Boolean)
            .join('|');
          const media = Array.from(row.querySelectorAll('img[src], video[src], source[src], a[href]'))
            .slice(0, 6)
            .map((element) => element.currentSrc || element.src || element.href || '')
            .filter(Boolean)
            .join('|');
          const text = String(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
          return text || labels || media ? `fallback_${stringHash(`${text}|${labels}|${media}`)}` : '';
        }

        function historyViewportIdentity(container) {
          return collectMessageRows(container).map((row) => historyRowIdentity(row)).filter(Boolean).join('||');
        }

        async function forceLoadOlder(container) {
          const scroller = findHistoryScroller(container);
          if (!scroller) return { moved: false, reason: 'no_scroll_container' };
          const beforeTop = scroller.scrollTop;
          const beforeHeight = scroller.scrollHeight;
          const beforeFirst = historyRowIdentity(collectMessageRows(container)[0]);
          scroller.focus?.({ preventScroll: true });
          const pageDistance = Math.max(600, scroller.clientHeight);
          // Move in visible-sized stages so Messenger has time to mount the
          // preceding page instead of jumping over it in its virtual list.
          for (let step = 0; step < 4; step++) {
            const stepDistance = Math.max(180, Math.floor(pageDistance / 4));
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -stepDistance, deltaMode: 0, bubbles: true, cancelable: true }));
            scroller.scrollBy?.({ top: -stepDistance, behavior: 'auto' });
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          // Reach the mounted page's top to trigger Messenger's lazy loader,
          // then wait below until both row identity and height settle.
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          let lastHeight = beforeHeight;
          let lastFirst = beforeFirst;
          let stableRounds = 0;
          let changed = false;
          for (let waitRound = 0; waitRound < 24; waitRound++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const afterFirst = historyRowIdentity(collectMessageRows(container)[0]);
            const afterHeight = scroller.scrollHeight;
            const spinnerVisible = !!container.querySelector('svg[aria-label="Loading"], div[role="progressbar"]');
            if (afterHeight !== beforeHeight || (afterFirst && afterFirst !== beforeFirst)) changed = true;
            if (!spinnerVisible && afterHeight === lastHeight && afterFirst === lastFirst) stableRounds += 1;
            else stableRounds = 0;
            lastHeight = afterHeight;
            lastFirst = afterFirst;
            // 1 second stable after a real DOM change is sufficient for all
            // bubbles/media of that page to mount before extraction.
            if (changed && stableRounds >= 4) return { moved: true };
          }
          return { moved: changed || beforeTop !== scroller.scrollTop };
        }

        async function mirrorCrmViewportScroll(container, requestedDelta) {
          const scroller = findHistoryScroller(container);
          if (!scroller) return { moved: false, reason: 'no_scroll_container' };
          const rawDelta = Number(requestedDelta) || 0;
          // A CRM wheel gesture covers fewer CSS pixels than Messenger's
          // virtualized viewport. Scale it to a useful Messenger page while
          // preserving direction; this also prevents tiny trackpad deltas
          // from producing a visually imperceptible crawl.
          const scaledDelta = Math.sign(rawDelta) * Math.max(
            Math.abs(rawDelta) * 9,
            Math.min(2700, Math.max(1260, scroller.clientHeight * 2.55))
          );
          const delta = Math.max(-7200, Math.min(7200, scaledDelta));
          if (!delta) return { moved: false, reason: 'zero_delta' };
          const beforeTop = scroller.scrollTop;
          const beforeViewportIdentity = historyViewportIdentity(container);
          scroller.focus?.({ preventScroll: true });
          // One CRM gesture intentionally advances Messenger by three wheel
          // steps. Yield between them so Facebook can mount the intermediate
          // virtual page instead of jumping past content that was never DOM.
          const stepDelta = delta / 3;
          for (let step = 0; step < 3; step++) {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: stepDelta, deltaMode: 0, bubbles: true, cancelable: true }));
            scroller.scrollBy?.({ top: stepDelta, behavior: 'auto' });
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 160));
          }
          let stableRounds = 0;
          let lastViewportIdentity = beforeViewportIdentity;
          let lastTop = beforeTop;
          for (let round = 0; round < 24; round++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const afterViewportIdentity = historyViewportIdentity(container);
            const pageChanged = afterViewportIdentity !== beforeViewportIdentity;
            const top = scroller.scrollTop;
            const loading = !!container.querySelector('svg[aria-label="Loading"], div[role="progressbar"]');
            if (!loading && pageChanged && afterViewportIdentity === lastViewportIdentity && top === lastTop) stableRounds += 1;
            else stableRounds = 0;
            lastViewportIdentity = afterViewportIdentity;
            lastTop = top;
            if (stableRounds >= 4) break;
          }
          // A scrollTop change alone is not proof that React finished swapping
          // the virtual page. Only report success after the complete mounted
          // row set changed; otherwise the caller would parse the old page and
          // CRM would appear not to synchronize.
          return { moved: beforeViewportIdentity !== lastViewportIdentity, scrollMoved: beforeTop !== scroller.scrollTop };
        }

        async function loadOlderMessages(container, modeStr) {
          const maxRounds = modeStr === 'ondemand_older' && !boundaryId ? 1 : (ROUND_BUDGET[modeStr] || 5);

          let prevScrollHeight = 0;
          let roundsWithoutIncrease = 0;
          for (let i = 0; i < maxRounds; i++) {
            const rowsForBoundary = collectMessageRows(container);
            if (!resumeMarkerReached && (resumeMarkerId || resumeMarkerContent)) {
              resumeMarkerReached = rowsForBoundary.some((row) => {
                const marker = row.querySelector('[data-message-id], [data-id], [id^="mid."]') || row;
                const nativeId = String(marker.getAttribute('data-message-id') || marker.getAttribute('data-id') || marker.getAttribute('id') || '').replace(/_media$/, '');
                if (resumeMarkerId && nativeId === resumeMarkerId) return true;
                if (!resumeMarkerContent || resumeMarkerTimestampMs <= 0) return false;
                const text = String(row.textContent || '').replace(/\s+/g, ' ').trim();
                const label = Array.from(row.querySelectorAll('[aria-label], [title], time[datetime], [data-utime]'))
                  .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('datetime') || '')
                  .find((value) => /\b\d{1,2}:\d{2}\b/.test(value)) || row.getAttribute('aria-label') || '';
                const unixSeconds = Number(row.querySelector('[data-utime]')?.getAttribute('data-utime') || 0);
                const timestampMs = unixSeconds > 0 ? unixSeconds * 1000 : parseTimeFromLabel(label, resumeMarkerTimestampMs);
                return text.includes(resumeMarkerContent) && timestampMs > 0
                  && Math.abs(timestampMs - resumeMarkerTimestampMs) <= 90000;
              });
            }
            const foundBoundary = (boundaryId || boundaryContent || boundaryMediaUrl) && rowsForBoundary.some(row => {
              const el = row.querySelector('[data-message-id], [data-id], [id^="mid."]') || row;
              const rawBoundaryId = String(boundaryId || '').replace(/_media$/, '');
              const idMatched = rawBoundaryId && (el.getAttribute('data-message-id') === rawBoundaryId || el.getAttribute('data-id') === rawBoundaryId || el.getAttribute('id') === rawBoundaryId);
              const normalizedRowText = String(row.textContent || '').replace(/\s+/g, ' ').trim();
              const rowTimeLabel = Array.from(row.querySelectorAll('[aria-label], [title], time[datetime], [data-utime]'))
                .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('datetime') || '')
                .find((label) => /\b\d{1,2}:\d{2}\b/.test(label)) || row.getAttribute('aria-label') || '';
              const rowUnixSeconds = Number(row.querySelector('[data-utime]')?.getAttribute('data-utime') || 0);
              const rowTimestampMs = rowUnixSeconds > 0
                ? rowUnixSeconds * 1000
                : parseTimeFromLabel(rowTimeLabel, boundaryTimestampMs || Date.now());
              // Repeated message text is common. Content alone is never a
              // resume boundary: it must also match the saved Facebook minute.
              const timestampMatched = boundaryTimestampMs > 0 && rowTimestampMs > 0
                && Math.abs(rowTimestampMs - boundaryTimestampMs) <= 90000;
              const textMatched = boundaryContent.length >= 2 && normalizedRowText.includes(boundaryContent) && timestampMatched;
              const mediaMatched = boundaryMediaUrl && Array.from(row.querySelectorAll('img[src], video[src], source[src]'))
                .some((media) => (media.currentSrc || media.src || '') === boundaryMediaUrl) && timestampMatched;
              return idMatched || textMatched || mediaMatched;
            });
            const loadOnePagePastBoundary = foundBoundary && modeStr === 'ondemand_older';
            if (foundBoundary && !loadOnePagePastBoundary) {
              boundaryReached = true;
              stopReason = 'boundary_reached';
              console.log(`[FB LazyLoad] Đã gặp boundary ${boundaryId}; dừng crawl ${modeStr}.`);
              break;
            }
            const currentCount = rowsForBoundary.length;
            const explicitLog = container.querySelector('[role="log"], div[aria-label*="Messages"], div[aria-label*="Đoạn chat"], div[aria-label*="Tin nhắn trong cuộc trò chuyện"]');
            let scrollContainer = explicitLog || container;
            let scrollProbe = scrollContainer;
            while (scrollProbe && scrollProbe !== document.body) {
              if (scrollProbe.scrollHeight > scrollProbe.clientHeight + 8) {
                scrollContainer = scrollProbe;
                break;
              }
              scrollProbe = scrollProbe.parentElement;
            }
            scrollContainer = findHistoryScroller(container) || scrollContainer;
            const currentScrollHeight = scrollContainer ? scrollContainer.scrollHeight : 0;
            const currentScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
            const spinnerVisible = !!container.querySelector('svg[aria-label="Loading"], div[role="progressbar"]');

            console.log(`[FB LazyLoad] Vòng ${i + 1}/${maxRounds} - Rows: ${currentCount} | ScrollHeight: ${currentScrollHeight} | ScrollTop: ${currentScrollTop}${spinnerVisible ? ' | spinner' : ''}`);

            if (currentScrollHeight > prevScrollHeight) {
              roundsWithoutIncrease = 0;
              prevScrollHeight = currentScrollHeight;
            } else if (spinnerVisible) {
              // Facebook vẫn đang tải - không tính vòng này là "không tăng" kẻo dừng nhầm
              // trong khi nội dung cũ hơn vẫn đang trên đường về (FR-006).
            } else if (i > 0) {
              roundsWithoutIncrease++;
            } else {
              prevScrollHeight = currentScrollHeight;
            }

            const noGrowthLimit = modeStr === 'incremental' ? 2 : 5;
            if (roundsWithoutIncrease >= noGrowthLimit) {
              stopReason = 'no_scroll_growth';
              console.log('[FB LazyLoad] Không phát hiện chiều cao scroll tăng sau 2 vòng liên tiếp. Dừng.');
              break;
            }

            if (spinnerVisible) await new Promise(r => setTimeout(r, 300));
            const loadResult = await forceLoadOlder(container);
            if (!loadResult.moved && loadResult.reason === 'no_scroll_container') {
              stopReason = 'no_scroll_growth';
              break;
            }
            if (!loadResult.moved && modeStr === 'ondemand_older') {
              stopReason = 'no_scroll_growth';
              break;
            }
            if (loadOnePagePastBoundary) {
              boundaryReached = true;
              stopReason = 'on_demand_page';
              break;
            }
          }
          if (!stopReason) stopReason = 'max_rounds_hit';
        }

        if (domReadyStatus.empty && mode === 'ondemand_older') {
          // Even when the latest viewport mounted no rows, an explicit upward
          // CRM wheel should still probe the Messenger scroller. This is the
          // recovery path for conversations whose first background render was
          // blank; previously they became scrollable only after sending text.
          await loadOlderMessages(mainContainer, mode);
        } else if (domReadyStatus.empty) stopReason = 'no_scroll_growth';
        else if (mode === 'ondemand_initial' || mode === 'initial' || mode === 'crm_navigation') {
          // Opening a user synchronizes only the messages already mounted on
          // screen. Messenger scrolls only after the operator reaches the top
          // of the CRM conversation and requests `ondemand_older`.
          stopReason = 'on_demand_page';
        } else if (mode === 'ondemand_viewport') {
          if (trustedViewportChanged && Number(scrollDelta) < 0) stopReason = 'on_demand_page';
          else {
            const mirrorResult = await mirrorCrmViewportScroll(mainContainer, scrollDelta);
            stopReason = mirrorResult.moved ? 'on_demand_page' : 'no_scroll_growth';
          }
        } else if (mode === 'ondemand_older' || mode === 'deep_backfill') {
          // Mirror the operator's upward CRM gesture in the visible Messenger
          // tab first. If Facebook has not mounted a different virtual page,
          // fall back to the existing top-trigger lazy-loader.
          if (trustedViewportChanged) stopReason = 'on_demand_page';
          else {
            const mirrorResult = await mirrorCrmViewportScroll(mainContainer, Number(scrollDelta) || -1);
            if (mirrorResult.moved) stopReason = 'on_demand_page';
            else await loadOlderMessages(mainContainer, mode);
          }
        } else {
          stopReason = 'on_demand_page';
        }

        // Kiểm tra marker lại lần cuối xem có lạc thread không
        const finalRows = collectMessageRows(mainContainer);
        for (const row of finalRows) {
          const taggedId = row.dataset.crmThreadId;
          if (taggedId && String(taggedId) !== String(targetThreadId)) {
            return { _reason: 'marker_mismatch' };
          }
        }

        // Inline text filter helpers
        const SYSTEM_PATTERNS = [
          /Tin nh\u1eafn v\u00e0 cu\u1ed9c g\u1ecdi .*b\u1ea3o m\u1eadt/i,
          /^\d+\s*(?:gi\u00e2y|ph\u00fat|gi\u1edd|ng\u00e0y|tu\u1ea7n|th\u00e1ng|n\u0103m|seconds?|minutes?|hours?|days?|weeks?|months?|years?)(?:\s*(?:tr\u01b0\u1edbc|ago))?$/iu,
          /^(?:\u0110\u00e3 g\u1eedi|\u0110\u00e3 nh\u1eadn|\u0110\u00e3 xem|Sent|Delivered|Seen)$/i,
          /^(?:\u0110ang ho\u1ea1t \u0111\u1ed9ng|Ho\u1ea1t \u0111\u1ed9ng|\u0110\u00e3 ho\u1ea1t \u0111\u1ed9ng).*$/i,
          /^(?:\u0110ang nh\u1eadp|\u0110ang g\u1eedi|\u0110ang t\u1ea3i|Typing|Sending|Loading)[.\u2026]*$/i,
          /Tin nhắn và cuộc gọi (?:đang )?được bảo mật/i,
          /bảo mật bằng tính năng mã hóa/i,
          /bảo mật đầu cuối/i,
          /^Tìm hiểu thêm$/i,
          /^Xem thêm$/i,
          /^Quyền riêng tư/i,
          /^Cookie$/i,
          /^Facebook$/i,
          /^Messenger$/i,
          /^Meta$/i,
          /^Trang chủ$/i,
          /^(?:Trang cá nhân|View profile)$/i,
          /^(?:Tắt thông báo|Mute notifications)$/i,
          /^(?:Tìm kiếm|Search)$/i,
          /^(?:Thông tin về đoạn chat|Conversation information|Chat info|Chi tiết cuộc trò chuyện)$/i,
          /^(?:Tùy chỉnh đoạn chat|Customize chat)$/i,
          /^(?:File phương tiện,? file và liên kết|Media,? files and links)$/i,
          /^(?:Quyền riêng tư và hỗ trợ|Privacy and support|Privacy & support)$/i,
          /^(?:Chủ đề|Theme)$/i,
          /^(?:Biểu tượng cảm xúc|Emoji)$/i,
          /^(?:Biệt danh|Nicknames)$/i,
          /^(?:Tạo nhóm|Create group)$/i,
          /^(?:Thành viên|Members)$/i,
          /^(?:Tên người dùng|Username)$/i,
          /^(?:Gỡ|Remove|Unsend)$/i,
          /^(?:Trả lời|Reply)$/i,
          /^(?:Chuyển tiếp|Forward)$/i,
          /^(?:Ghim|Pin)$/i,
          /^(?:Sao chép|Copy)$/i,
          /^Khôi phục ngay$/i,
          /^Khôi phục tin nhắn$/i,
          /^Restore now$/i,
          /^Restore messages$/i,
          /^Personal chats are secured with end-to-end encryption/i,
          /^Thiếu lịch sử chat/i,
          /^Thiếu tin nhắn\.?$/i,
          /^Không khôi phục được tin nhắn\.?$/i,
          /^Bạn đã tạo nhóm này/i,
          /^Chỉ những người tham gia/i,
          /^Bản quyền Meta/i,
          /^Thêm tin nhắn được cá nhân h(?:óa|oá)\.?$/i,
          /^(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen)$/i,
/^(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen)\s+\d+\s+(?:giây|phút|giờ|ngày|tuần|tháng|năm)\s+(?:trước|ago)$/i,
          /^(?:Đang hoạt động.*|Hoạt động(?:\s+\d+.*)?|Đã hoạt động.*|Active now|Active recently|Active \d+.*|Online|Offline)$/i,
          /^(?:Typing[.…]*|Đang nhập[.…]*|Đang gửi[.…]*|Sending[.…]*)$/i,
          /^(?:Đang tải|Loading)[.…]*$/i,
          /^(?:Tin nhắn do|Message sent by) .+?(?:gửi lúc|at) .+?:\s*.*$/i,
          /^Nhấn Enter để gửi$/i,
          /^\d{1,2}:\d{2}(?:\s*(?:T[2-7]|CN|AM|PM))?$/i,
          /^(?:T[2-7]|CN)$/i,
          /^\d{1,2}:\d{2}\s+\d{1,2}\s+Tháng\s+\d{1,2},?\s+\d{4}$/i,
          /^\d{1,2}\s+Tháng\s+\d{1,2}(?:,?\s*\d{4})?$/i,
          /^(?:Thứ (?:Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|Hôm nay|Hôm qua|Today|Yesterday)$/i
        ];

        function isSystemText(txt) {
          if (!txt || !txt.trim()) return true;
          const t = txt.trim();
          for (const pat of SYSTEM_PATTERNS) {
            if (pat.test(t)) return true;
          }
          return false;
        }

        function cleanText(raw) {
          if (!raw) return '';
          let t = raw.trim();
          if (!t) return '';
          t = t.replace(/^(?:Nhập,\s*)?Tin nhắn do [^\n]+? gửi lúc [^\n]*:\s*/i, '').trim();
          t = t.replace(/^(?:Nhập,\s*)?Message sent by [^\n]+? at [^\n]*:\s*/i, '').trim();
          t = t.replace(/^Nhập,\s*/i, '').trim();
          t = t.replace(/^[:\s]+/, '').trim();
          const sentEmojiMatch = t.match(/^[^,\n]{1,80}\s+(?:đã gửi|sent),\s*(.+)$/i);
          if (sentEmojiMatch) {
            const payload = sentEmojiMatch[1].trim();
            if (payload && !/[A-Za-zÀ-ỹ0-9]/.test(payload)) t = payload;
          }
          t = t.replace(/(?:\n|\r|\s{2,})(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen|Nhấn Enter để gửi)\s*$/i, '').trim();
          t = t.replace(/^\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?\s*$/i, '').replace(/(?:\n|\r)\s*\d{1,2}:\d{2}\s*(?:T[2-7]|CN|AM|PM)?$/i, '').trim();
          t = t.replace(/^[:\s]+/, '').trim();
          if (!t || isSystemText(t)) return '';
          return t;
        }

        function isClockMinuteFragment(value, label) {
          const normalized = String(value || '').trim().replace(/\s+/g, '');
          const fragment = normalized.match(/^(\d{1,2})(?:sáng|chiều|tối|am|pm|sa|ch)?$/i);
          if (!fragment) return false;
          const match = String(label || '').match(/\b\d{1,2}:(\d{2})\b/);
          return !!match && Number(fragment[1]) === Number(match[1]);
        }

        function stringHash(str) {
          let hash = 0;
          for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
          }
          return (hash >>> 0).toString(36);
        }

        function parseTimeFromLabel(label, fallbackDate) {
          if (!label) return null;
          const timeMatch = label.match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH|SÁNG|CHIỀU|TỐI))?/i);
          if (!timeMatch) return null;

          let hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const ampm = timeMatch[3]?.toUpperCase();
          if (ampm === 'PM' || ampm === 'CH' || ampm === 'CHIỀU' || ampm === 'TỐI') {
            if (hours < 12) hours += 12;
          } else if (ampm === 'AM' || ampm === 'SA' || ampm === 'SÁNG') {
            if (hours === 12) hours = 0;
          }

          const now = new Date();
          now.setHours(hours, minutes, 0, 0);

          // Phát hiện ngày trong label (Hôm qua, Thứ Hai, 31 tháng 7, 2026...)
          const lowerLabel = label.toLowerCase();
          const yesterdayMatch = lowerLabel.match(/hôm qua|yesterday/);
          const dateMatch = lowerLabel.match(/(\d{1,2})\s*tháng\s*(\d{1,2})(?:,?\s*(\d{4}))?/i);
          const weekdayMatch = lowerLabel.match(/(thứ hai|thứ ba|thứ tư|thứ năm|thứ sáu|thứ bảy|chủ nhật|t2|t3|t4|t5|t6|t7|cn)/i);

          if (dateMatch) {
            const day = parseInt(dateMatch[1], 10);
            const month = parseInt(dateMatch[2], 10) - 1;
            const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.getFullYear();
            now.setFullYear(year, month, day);
          } else if (yesterdayMatch) {
            now.setDate(now.getDate() - 1);
          } else if (weekdayMatch) {
            // Tính ngược về thứ gần nhất
            const daysMap = {
              'chủ nhật': 0, 'cn': 0,
              'thứ hai': 1, 't2': 1,
              'thứ ba': 2, 't3': 2,
              'thứ tư': 3, 't4': 3,
              'thứ năm': 4, 't5': 4,
              'thứ sáu': 5, 't6': 5,
              'thứ bảy': 6, 't7': 6
            };
            const targetDay = daysMap[weekdayMatch[1].toLowerCase()];
            const currentDay = now.getDay();
            let diff = currentDay - targetDay;
            if (diff <= 0) diff += 7; // Trừ lùi về tuần trước
            now.setDate(now.getDate() - diff);
          } else if (fallbackDate) {
            // Dùng ngày của fallbackDate nhưng đè giờ phút mới (vì label chỉ có giờ phút của ngày hôm nay)
            const fallback = new Date(fallbackDate);
            now.setFullYear(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
          }

          if (now.getTime() > Date.now() + 60000) {
            now.setDate(now.getDate() - 1);
          }
          return now.getTime();
        }

        const messages = [];
        const boundaryIds = new Set([cursor?.newest_message_id, cursor?.oldest_message_id].filter(Boolean));
        const occurrencesMap = {};
        const seenBubblesInPass = new Set();

        // ── Composer/UI exclusion (tuyệt đối không lấy text từ vùng soạn tin/header/nav/sidebar) ──
        const COMPOSER_EXCLUDE = 'form, [contenteditable="true"], [role="textbox"], [aria-label="Aa"], [aria-label="Tin nhắn"], [aria-label*="composer"], [aria-label*="Soạn"], [role="contentinfo"], header, nav, [role="complementary"], [aria-label*="Thông tin về đoạn chat"], [aria-label*="Conversation information"], [aria-label*="Chi tiết cuộc trò chuyện"]';
        // Icon-only messages (especially a customer Like) have no dir=auto
        // text bubble. Read only a glyph itself, or an img/SVG semantic Like.
        // Button controls are deliberately excluded so the composer hover Like
        // can never become a fake incoming CRM message.
        function extractHistoryBubbleEmoji(container) {
          if (!container?.querySelectorAll) return '';
          const candidates = container.querySelectorAll('img[alt], [aria-label], [title], svg title');
          for (const element of candidates) {
            const exactReceivedLikeTitle = element.tagName === 'TITLE'
              && /^(?:k\u00fd hi\u1ec7u gi\u01a1 ng\u00f3n tay c\u00e1i|thumbs up symbol)$/i.test(String(element.textContent || '').trim());
            if (exactReceivedLikeTitle) return '👍';
            if (element.matches?.('[role="button"], button') || element.closest?.('[role="button"], button')) continue;
            const value = String(element.getAttribute('alt') || element.getAttribute('aria-label') || element.getAttribute('title')
              || (element.tagName === 'TITLE' ? element.textContent : '') || '').trim();
            if (!value) continue;
            if (value.length <= 16 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u20D0-\u20FF]*$/u.test(value)) return value;
            if (/(?:giơ ngón tay cái|thumbs?\\s*up|\\blike\\b|thích|👍)/i.test(value)
              && (element.matches?.('img, svg, title, [role="img"]') || element.closest?.('svg'))) return '👍';
          }
          const directText = String(container.textContent || '').trim();
          return directText.length <= 4 && /^\p{Extended_Pictographic}+$/u.test(directText) ? directText : '';
        }

        // ── Chiến lược: Chỉ lấy tin từ message row đã xác minh ──
        // Facebook đã chuyển message container từ role="row" sang role="article"
        // (xác nhận qua live DOM inspection 2026-08-19, giống fix đã có ở
        // content.js:401-407 cho luồng real-time) - phải nhận cả hai để không
        // bỏ sót toàn bộ lịch sử của thread dùng cấu trúc mới.
        // `data-scope="messages_table"` is attached to individual message
        // units in current Messenger builds. Selecting the first one here
        // made the history scraper inspect only a single bubble after scroll.
        // A real role=log can be used as the conversation root; otherwise the
        // verified main container is the only safe complete scan boundary.
        const messageLog = mainContainer.querySelector('[role="log"]') || mainContainer;
        const historyDirectionContainer = findHistoryScroller(mainContainer) || messageLog || mainContainer;
        const allRows = collectMessageRows(messageLog).flatMap((row) => {
          const nativeUnits = Array.from(row.querySelectorAll('[data-message-id]'))
            .filter((unit) => {
              const parentUnit = unit.parentElement?.closest('[data-message-id]');
              return !parentUnit || !row.contains(parentUnit);
            });
          return nativeUnits.length > 1 ? nativeUnits : [row];
        });

        let dom_order = 0;
        let lastFallbackTime = Date.now();

        allRows.forEach((row, idx) => {
          if (row.closest(COMPOSER_EXCLUDE)) return;

          const rowAriaLabel = row.getAttribute('aria-label') || '';
          // Trên cấu trúc role="article" mới, aria-label thật không nằm trên
          // chính row mà nằm ở phần tử con sâu hơn (đã xác nhận qua live DOM
          // inspection 2026-08-19: aria-label + data-message-id cùng nằm trên
          // 1 div con mang data-scope="messages_table"/aria-roledescription=
          // "tin nhắn", không phải trên div[role="article"] bao ngoài) - tìm
          // theo 2 marker này trước, fallback về pattern label cũ cho tương
          // thích ngược.
          const childMsgEl = !rowAriaLabel ? (
            row.querySelector('[data-scope="messages_table"][aria-label], [aria-roledescription="tin nhắn"][aria-label]') ||
            row.querySelector('[aria-label*="Tin nhắn do"], [aria-label*="Message sent"]')
          ) : null;
          let effectiveLabel = rowAriaLabel || (childMsgEl?.getAttribute('aria-label') || '');
          if (!/Tin nh\u1eafn do .+ g\u1eedi l\u00fac|Message sent by|^L\u00fac\s+.+?,\s*.+?:/i.test(effectiveLabel)) {
            effectiveLabel = Array.from(row.querySelectorAll('[aria-label]'))
              .map((element) => element.getAttribute('aria-label') || '')
              .find((label) => /Tin nh\u1eafn do .+ g\u1eedi l\u00fac|Message sent by|^L\u00fac\s+.+?,\s*.+?:/i.test(label))
              || effectiveLabel;
          }

          const hasMessageLabel = /Tin nhắn do .+ gửi lúc|Message sent by|^Lúc\s+.+?,\s*.+?:/i.test(effectiveLabel);
          // data-message-id là attribute Facebook thực sự dùng trên cấu trúc
          // role="article" mới (khớp content.js/page_content.js) - [data-id]/mid.
          // chỉ còn là fallback cho cấu trúc role="row" cũ.
          const nativeIdEl = row.matches?.('[data-message-id], [data-id], [id^="mid."]')
            ? row
            : (row.querySelector('[data-message-id]') || row.querySelector('[data-id], [id^="mid."]'));
          const hasNativeId = !!nativeIdEl;
          let rowEmojiContent = extractHistoryBubbleEmoji(row);

          if (!hasMessageLabel && !hasNativeId && !rowEmojiContent) return;

          const bubblesInRow = Array.from(row.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
          let leafBubbles = bubblesInRow.filter(b => {
            if (b.closest(COMPOSER_EXCLUDE)) return false;
            return !b.querySelector('div[dir="auto"], span[dir="auto"]');
          });

          // A Messenger video frequently uses a transient blob: URL and may
          // not have videoWidth yet while the hidden history tab is scraping.
          // Treat the VIDEO element itself as authoritative media evidence;
          // keep the old geometry-based image filtering for avatars/photos.
          const videoElement = Array.from(row.querySelectorAll('video')).find((element) => !element.closest(COMPOSER_EXCLUDE)) || null;
          // Hidden/history Messenger can render a video as a semantic control
          // before mounting the actual <video> element. Keep this in parity
          // with content.js so those rows are not silently dropped.
          const semanticVideoElement = Array.from(row.querySelectorAll('[role=img]')).find((element) => {
            if (element.closest(COMPOSER_EXCLUDE)) return false;
            const label = String(element.getAttribute('aria-label') || element.getAttribute('title') || '').trim();
            return /(?:ph\u00e1t|m\u1edf|xem|play|open|watch)?\s*video/i.test(label)
              && !/(?:cu\u1ed9c g\u1ecdi|video call|call video)/i.test(label);
          }) || null;
          const mediaElement = videoElement || Array.from(row.querySelectorAll('img[src]')).find((element) => {
            const rect = element.getBoundingClientRect();
            // Use rendered geometry first. Avatars often have a large source
            // bitmap (hundreds of pixels) but are rendered as a 28-40px circle;
            // Math.max(naturalWidth, rect.width) therefore misclassified them
            // as message photos.
            const width = rect.width || element.naturalWidth || element.videoWidth || 0;
            const height = rect.height || element.naturalHeight || element.videoHeight || 0;
            const alt = String(element.getAttribute('alt') || element.getAttribute('aria-label') || '').toLowerCase();
            const normalizedContactName = String(contactName || '').trim().toLowerCase();
            const namesContact = normalizedContactName && alt.includes(normalizedContactName);
            const isSmallProfileImage = width <= 64 && height <= 64;
            const isLikelyAvatar = namesContact || isSmallProfileImage;
            return !isLikelyAvatar && width >= 72 && height >= 72;
          });
          const mediaAnchor = row.querySelector('a[href*="fbcdn"], a[href*=".mp4"], a[href*="video"]');
          const videoPoster = videoElement?.poster || videoElement?.getAttribute?.('poster') || null;
          const rawMediaUrl = mediaElement?.currentSrc || mediaElement?.src
            || mediaElement?.querySelector?.('source[src]')?.src
            || mediaAnchor?.href || videoPoster || null;
          // MSE videos expose blob: as currentSrc, but their poster remains a
          // stable fbcdn/data image. Persist that thumbnail so CRM renders the
          // video message instead of a bare "[Video]" placeholder.
          const mediaUrl = rawMediaUrl && !String(rawMediaUrl).startsWith('blob:')
            ? rawMediaUrl
            : (videoPoster && !String(videoPoster).startsWith('blob:') ? videoPoster : null);
          const isVideoMessage = Boolean(videoElement || semanticVideoElement)
            || /\.mp4(?:\?|$)|video/i.test(String(mediaUrl || ''));
          const mediaType = isVideoMessage ? 'video' : (mediaUrl ? 'image' : null);

          // Some Like rows expose their timestamp minute (37/37sáng) as
          // the only dir=auto leaf. Replace that UI fragment with the row's
          // semantic thumbs-up so it cannot be persisted as message content.
          const hasOnlyClockFragments = leafBubbles.length > 0 && leafBubbles.every((bubble) => {
            const bubbleText = cleanText(bubble.textContent || '');
            return !bubbleText || isClockMinuteFragment(bubbleText, effectiveLabel);
          });
          if (!rowEmojiContent && hasOnlyClockFragments && row.querySelector('svg')) rowEmojiContent = '👍';
          if (rowEmojiContent && (leafBubbles.length === 0 || hasOnlyClockFragments) && !mediaUrl && !isVideoMessage) leafBubbles = [row];
          if (leafBubbles.length === 0 && !mediaUrl && !isVideoMessage) return;

          const timestampElement = row.querySelector('time[datetime], abbr[data-utime], [data-utime]');
          const unixSeconds = Number(timestampElement?.getAttribute('data-utime') || 0);
          const dateTimeValue = timestampElement?.getAttribute('datetime') || '';
          const timestampLabel = effectiveLabel || Array.from(row.querySelectorAll('[aria-label], [title]'))
            .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || '')
            .find((label) => /\b\d{1,2}:\d{2}\b/.test(label)) || '';
          const clockMatch = timestampLabel.match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM|SA|CH|SÁNG|CHIỀU|TỐI))?/i);
          let clockMinutes = null;
          if (clockMatch) {
            let clockHour = Number(clockMatch[1]);
            const clockSuffix = String(clockMatch[3] || '').toUpperCase();
            if (['PM', 'CH', 'CHIỀU', 'TỐI'].includes(clockSuffix) && clockHour < 12) clockHour += 12;
            if (['AM', 'SA', 'SÁNG'].includes(clockSuffix) && clockHour === 12) clockHour = 0;
            clockMinutes = clockHour * 60 + Number(clockMatch[2]);
          }
          const timestampHasExplicitDate = /(?:hôm qua|yesterday|thứ\s+(?:hai|ba|tư|năm|sáu|bảy)|chủ nhật|\bT[2-7]\b|\bCN\b|\d{1,2}\s*tháng\s*\d{1,2}|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b)/i.test(timestampLabel);
          let tsMs = unixSeconds > 0
            ? unixSeconds * 1000
            : (dateTimeValue && Number.isFinite(Date.parse(dateTimeValue)) ? Date.parse(dateTimeValue) : parseTimeFromLabel(timestampLabel, lastFallbackTime));
          let tsSource = tsMs ? (unixSeconds > 0 || dateTimeValue ? 'facebook_timestamp' : 'facebook_label') : 'fallback';

          if (tsMs) {
            lastFallbackTime = tsMs;
          } else {
            tsMs = lastFallbackTime;
          }

          if (mediaUrl || isVideoMessage) {
            // Priority 1: aria-label text is the most reliable direction signal.
            let mediaOutgoing;
            const labelSaysOutgoing = /do B\u1ea1n g\u1eedi|Tin nh\u1eafn do B\u1ea1n g\u1eedi l\u00fac|B\u1ea1n \u0111\u00e3 g\u1eedi|sent by you|You sent|Message sent by you/i.test(effectiveLabel);
            const labelSaysIncoming = !labelSaysOutgoing && /Tin nh\u1eafn do .+ g\u1eedi l\u00fac|Message sent by/i.test(effectiveLabel);
            if (labelSaysOutgoing) {
              mediaOutgoing = true;
            } else if (labelSaysIncoming) {
              mediaOutgoing = false;
            } else {
              // Geometry fallback: use actual media element rect, not the full-row wrapper.
              // The row wrapper (div[role="article"]) is always 100% wide so its center
              // is ~50% — wrongly reads as incoming when threshold is >= 0.55.
              const mediaRect = (mediaElement || mediaAnchor || semanticVideoElement || row).getBoundingClientRect();
              const directionRect = historyDirectionContainer.getBoundingClientRect();
              if (directionRect.width > 0 && mediaRect.width > 0) {
                // For wide media elements (> 40% of container), use right edge proximity.
                const mediaWidthRatio = mediaRect.width / directionRect.width;
                if (mediaWidthRatio > 0.40) {
                  const rightEdgeRatio = (mediaRect.right - directionRect.left) / directionRect.width;
                  mediaOutgoing = rightEdgeRatio >= 0.80;
                } else {
                  const relativeCenter = (mediaRect.left + mediaRect.width / 2 - directionRect.left) / directionRect.width;
                  mediaOutgoing = relativeCenter >= 0.55;
                }
              } else {
                mediaOutgoing = false;
              }
            }
            const mediaNativeId = nativeIdEl?.getAttribute('data-message-id') || nativeIdEl?.getAttribute('data-id')
              || nativeIdEl?.getAttribute('id') || row.getAttribute('data-message-id') || row.getAttribute('data-id') || null;
            const mediaStableId = mediaNativeId
              ? `${mediaNativeId}_media`
              : `dom_${targetThreadId}_media_${stringHash(mediaUrl || `${effectiveLabel}:${idx}:video`)}`;
            messages.push({
              fb_message_id: mediaStableId,
              thread_id: targetThreadId,
              sender_id: mediaOutgoing ? 'current_user' : null,
              sender_name: mediaOutgoing ? 'Bạn' : (contactName || 'Khách hàng'),
              // Keep a visible, persisted record even when Facebook exposes
              // only blob: media. If a stable fbcdn/mp4 URL is present the
              // existing downloader and video player continue unchanged.
              content: '',
              media_type: mediaType,
              media_url: mediaUrl,
              is_outgoing: mediaOutgoing ? 1 : 0,
              sender_role: mediaOutgoing ? 'operator' : 'customer',
              source: 'dom_history_sync',
              timestamp_ms: tsMs + dom_order,
              timestamp_source: tsSource,
              dom_order,
              sequence_order: dom_order,
              _clock_minutes: clockMinutes,
              _timestamp_has_explicit_date: timestampHasExplicitDate,
              created_at: new Date(tsMs + dom_order).toISOString()
            });
            dom_order++;
          }

          let bubble_idx = 0;
          for (const leafBubble of leafBubbles) {
            if (seenBubblesInPass.has(leafBubble)) continue;
            seenBubblesInPass.add(leafBubble);

            const rawBubbleText = leafBubble === row && rowEmojiContent
              ? rowEmojiContent
              : (leafBubble.textContent || '').trim();
            const rawEmojiContent = extractHistoryBubbleEmoji(leafBubble);

            const bubbleLabelEl = leafBubble.closest('[aria-label]');
            const bubbleLabel = bubbleLabelEl ? (bubbleLabelEl.getAttribute('aria-label') || '') : '';
            const currentLabel = bubbleLabel || effectiveLabel;

            let isOutgoing = false;
            let senderName = '';
            let directionMatched = false;
            if (/do Bạn gửi|Tin nhắn do Bạn gửi lúc|Bạn đã gửi|sent by you|You sent|Message sent by you/i.test(currentLabel)) {
              isOutgoing = true;
              senderName = 'Bạn';
              directionMatched = true;
            } else {
              const nameMatch = currentLabel.match(/Tin nhắn do ([^]+?) gửi lúc/i) || currentLabel.match(/Message sent by ([^]+?) at/i);
              if (nameMatch) {
                const rawSender = nameMatch[1].trim();
                if (/^(?:Bạn|You)$/i.test(rawSender)) {
                  isOutgoing = true;
                  senderName = 'Bạn';
                } else {
                  isOutgoing = false;
                  senderName = rawSender;
                }
                directionMatched = true;
              } else {
                const newLabelMatch = currentLabel.match(/^Lúc\s+.+,\s*(.+?):\s*/i);
                if (newLabelMatch) {
                  const rawSender = newLabelMatch[1].trim();
                  if (/^(?:Bạn|You)$/i.test(rawSender)) {
                    isOutgoing = true;
                    senderName = 'Bạn';
                    directionMatched = true;
                  } else if (contactName && rawSender.toLowerCase() === String(contactName).trim().toLowerCase()) {
                    isOutgoing = false;
                    senderName = rawSender;
                    directionMatched = true;
                  } else if (contactName) {
                    isOutgoing = true;
                    senderName = 'Bạn';
                    directionMatched = true;
                  }
                }
              }
            }

            const robustOutgoing = /do B\u1ea1n g\u1eedi|Tin nh\u1eafn do B\u1ea1n g\u1eedi l\u00fac|B\u1ea1n \u0111\u00e3 g\u1eedi|sent by you|You sent|Message sent by you/i.test(currentLabel);
            const robustSender = currentLabel.match(/Tin nh\u1eafn do ([^]+?) g\u1eedi l\u00fac/i) || currentLabel.match(/Message sent by ([^]+?) at/i);
            if (robustOutgoing) {
              isOutgoing = true;
              senderName = 'Bạn';
              directionMatched = true;
            } else if (robustSender) {
              const rawSender = robustSender[1].trim();
              isOutgoing = /^(?:B\u1ea1n|You)$/i.test(rawSender);
              senderName = isOutgoing ? 'Bạn' : rawSender;
              directionMatched = true;
            }

            if (!directionMatched) {
              // Check if row contains contact's avatar (Facebook puts alt="<Contact Name>" on incoming message avatars)
              const safeName = (contactName || '').trim();
              const hasContactAvatar = safeName ? !!(
                Array.from(row.querySelectorAll('img[alt], div[role="img"][aria-label], img[aria-label]')).some(el => {
                  const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
                  return alt.toLowerCase().includes(safeName.toLowerCase());
                })
              ) : false;

              if (hasContactAvatar) {
                isOutgoing = false;
                senderName = contactName || 'Khách hàng';
              } else {
                isOutgoing = true;
                senderName = 'Bạn';
              }
            }

            // Messenger's visual alignment is the final authority. Labels can
            // be inherited from a surrounding accessibility wrapper and refer
            // to a neighbouring bubble, especially in grouped call/messages.
            const directionRect = historyDirectionContainer.getBoundingClientRect();
            const bubbleRect = leafBubble.getBoundingClientRect();
            if (directionRect.width > 0 && bubbleRect.width > 0) {
              const relativeCenter = (bubbleRect.left + bubbleRect.width / 2 - directionRect.left) / directionRect.width;
              if (relativeCenter <= 0.45 || relativeCenter >= 0.55) {
                isOutgoing = relativeCenter >= 0.55;
                senderName = isOutgoing ? 'Bạn' : (contactName || 'Khách hàng');
                directionMatched = true;
              }
            }

            let textContent = rawBubbleText;
            const minuteFragment = isClockMinuteFragment(textContent, currentLabel || timestampLabel);
            const emojiContent = rawEmojiContent;
            if (emojiContent && (!textContent || minuteFragment)) textContent = emojiContent;
            if (!textContent) { bubble_idx++; continue; }
            const cleaned = cleanText(textContent);
            if (!cleaned || cleaned.length < 1 || cleaned.length > 1000 || isSystemText(cleaned)) { bubble_idx++; continue; }
            if ((mediaUrl || isVideoMessage) && /^\d{2}$/.test(cleaned)
              && Number.isFinite(Number(clockMinutes))
              && Number(cleaned) === (Number(clockMinutes) % 60)) { bubble_idx++; continue; }
            if (isClockMinuteFragment(cleaned, currentLabel || timestampLabel)) { bubble_idx++; continue; }
            if (contactName && cleaned.toLowerCase() === String(contactName).trim().toLowerCase()) { bubble_idx++; continue; }

            const bubbleNativeEl = leafBubble.closest('[data-message-id], [data-id], [id^="mid."]');
            const nativeId = bubbleNativeEl?.getAttribute('data-message-id') || bubbleNativeEl?.getAttribute('data-id') || bubbleNativeEl?.getAttribute('id')
              || nativeIdEl?.getAttribute('data-message-id') || nativeIdEl?.getAttribute('data-id') || nativeIdEl?.getAttribute('id')
              || row.getAttribute('data-message-id') || row.getAttribute('data-id') || null;

            const dirKey = isOutgoing ? 'out' : 'in';
            const textHash = stringHash(cleaned);
            const comboKey = `${targetThreadId}_${dirKey}_${textHash}`;
            occurrencesMap[comboKey] = (occurrencesMap[comboKey] || 0) + 1;
            const occIndex = occurrencesMap[comboKey];

            const identityKey = `${targetThreadId}|${dirKey}|${textHash}`;
            const labelHash = stringHash(currentLabel || String(tsMs));
            // Same text may be sent repeatedly in the same minute. The per-pass
            // occurrence is stable in DOM order and keeps each physical bubble.
            const deterministicId = nativeId || `dom_${targetThreadId}_hash_${textHash}_${labelHash}_${dirKey}_occ_${occIndex}`;

            if (!messages.some(m => m.fb_message_id === deterministicId)) {
              // Preserve Facebook DOM order for messages with the same minute.
              // A bounded offset is deterministic within the canonical oldest→newest pass.
              const finalTsMs = tsMs + dom_order;

              messages.push({
                fb_message_id: deterministicId,
                thread_id: targetThreadId,
                sender_id: isOutgoing ? 'current_user' : null,
                sender_name: senderName,
                content: cleaned,
                is_outgoing: isOutgoing ? 1 : 0,
                sender_role: isOutgoing ? 'operator' : 'customer',
                source: 'dom_history_sync',
                timestamp_ms: finalTsMs,
                timestamp_source: tsSource,
                dom_order,
                sequence_order: dom_order,
                _clock_minutes: clockMinutes,
                _timestamp_has_explicit_date: timestampHasExplicitDate,
                created_at: new Date(finalTsMs).toISOString()
              });
            }
            bubble_idx++;
            dom_order++;
          }
        });

        // Facebook labels can expose only a clock time and omit the date. Work
        // backwards from the newest visible row so a clock rollover creates a
        // previous day instead of flattening several days into one date.
        let nextChronologicalAnchor = Date.now() + 60000;
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message._timestamp_has_explicit_date) {
            nextChronologicalAnchor = Number(message.timestamp_ms || nextChronologicalAnchor);
            continue;
          }
          if (Number.isFinite(Number(message._clock_minutes))) {
            const anchorDate = new Date(nextChronologicalAnchor);
            let inferred = new Date(
              anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(),
              Math.floor(Number(message._clock_minutes) / 60), Number(message._clock_minutes) % 60, 0, 0
            ).getTime();
            while (inferred > nextChronologicalAnchor + 60000) inferred -= 86400000;
            message.timestamp_ms = inferred;
            message.timestamp_source = 'dom_clock_order';
            message.created_at = new Date(inferred).toISOString();
            nextChronologicalAnchor = inferred;
          } else {
            nextChronologicalAnchor = Math.min(nextChronologicalAnchor, Number(message.timestamp_ms || nextChronologicalAnchor));
          }
        }

        // Facebook labels can expose only a clock time and omit the date. That
        // can make a later DOM row appear hours/days older than the row above
        // it (observed: image -> "E gui nha" -> "Ok em"). DOM order is the
        // authoritative visual order, so keep timestamps strictly monotonic in
        // that order while preserving every trustworthy timestamp anchor.
        let previousDomTimestamp = 0;
        for (const message of messages) {
          let currentTimestamp = Number(message.timestamp_ms || 0);
          if (!Number.isFinite(currentTimestamp) || currentTimestamp <= 0) {
            currentTimestamp = previousDomTimestamp > 0 ? previousDomTimestamp + 1 : Date.now();
            message.timestamp_source = 'dom_order';
          } else if (previousDomTimestamp > 0 && currentTimestamp <= previousDomTimestamp) {
            currentTimestamp = previousDomTimestamp + 1;
            message.timestamp_source = 'dom_order';
          }
          message.timestamp_ms = currentTimestamp;
          message.created_at = new Date(currentTimestamp).toISOString();
          delete message._clock_minutes;
          delete message._timestamp_has_explicit_date;
          previousDomTimestamp = currentTimestamp;
        }

        const finalThreadMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/) ||
          location.href.match(/[?&](?:selected_item_id|thread_id)=([^&#]+)/);
        const finalThreadId = finalThreadMatch ? decodeURIComponent(finalThreadMatch[1]) : null;
        const finalActiveSidebar = document.querySelector('a[aria-current="page"][href*="/messages/"], a[aria-current="true"][href*="/messages/"]');
        const finalActiveMatch = (finalActiveSidebar?.getAttribute('href') || '').match(/\/messages\/(?:e2ee\/)?t\/([^\/?#]+)/);
        const finalActiveId = finalActiveMatch ? decodeURIComponent(finalActiveMatch[1]) : null;
        if (String(finalThreadId) !== String(targetThreadId) || (finalActiveId && String(finalActiveId) !== String(targetThreadId))) {
          return { _reason: 'thread_changed_during_parse' };
        }

        const filteredMessages = messages.filter(m => !boundaryIds.has(m.fb_message_id));
        return { messages: filteredMessages, skipped_count: messages.length - filteredMessages.length, boundary_reached: boundaryReached, stop_reason: stopReason, resume_marker_reached: resumeMarkerReached };
      },
      args: [navigationThreadId, mode, cursor, contact_name, Number(scroll_delta) || 0, trustedHistoryViewportChanged]
    });

    const parsedResult = results?.[0]?.result;
    const verifiedThreadAfterParse = await getCurrentThreadIdInTab(tab.id);
    if (String(verifiedThreadAfterParse) !== navigationThreadId) {
      console.warn('[DOM Sync Verification] Thread changed during parse. requested=' + navigationThreadId + ', current=' + (verifiedThreadAfterParse || 'unknown'));
      sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'thread_changed_after_parse', mode, cursor });
      return { ok: false, cancelled: true };
    }
    if (!isPersonalNavigationCurrent(navigationToken)) {
      console.log(`[FB Engine] Cancelled stale history result for thread ${thread_id}: a newer conversation owns the history tab.`);
      sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'navigation_superseded', mode, cursor });
      return { ok: false, cancelled: true };
    }
    const parsedMessages = Array.isArray(parsedResult) ? parsedResult : (parsedResult?.messages || []);
    const parserSkipped = Array.isArray(parsedResult) ? 0 : (parsedResult?.skipped_count || 0);

    if (parsedResult && parsedResult._reason) {
      console.warn(`[FB Engine] ⚠️ DOM chưa sẵn sàng. Hủy sync. Lý do: ${parsedResult._reason}`);
      sendToBackend('THREAD_MESSAGES_SYNCED', {
        account_id: targetAcc,
        thread_id,
        messages: [],
        reason: parsedResult._reason,
        mode,
        cursor
      });
      return;
    }

    const messagesArray = Array.isArray(parsedMessages)
      ? parsedMessages.map((message) => ({ ...message, thread_id: String(thread_id) })).sort((a, b) => {
          const domDiff = Number(a.dom_order || 0) - Number(b.dom_order || 0);
          if (domDiff !== 0) return domDiff;
          return String(a.fb_message_id || '').localeCompare(String(b.fb_message_id || ''));
        })
      : [];
    console.log(`[FB Engine] ✅ Synced ${messagesArray.length} new history messages for thread ${thread_id}; skipped=${parserSkipped}`);

    // Update cursor using timestamp extrema, not DOM array order.
    let newCursor = { ...(cursor || {}) };
    newCursor.mode = mode;
    // Cho server biết crawl có thực sự chạm hết lịch sử hay chỉ dừng vì hết ngân sách vòng cuộn -
    // thiếu field này khiến server luôn coi là SYNCED dù còn tin nhắn cũ hơn chưa lấy được.
    newCursor.boundary_reached = !!(parsedResult && parsedResult.boundary_reached);
    newCursor.stop_reason = (parsedResult && parsedResult.stop_reason) || null;
    if (mode === 'ondemand_initial' && cursor?.oldest_message_id) {
      newCursor.resume_message_id = cursor.oldest_message_id;
      newCursor.resume_content = cursor.oldest_content || '';
      newCursor.resume_timestamp_ms = Number(cursor.oldest_timestamp_ms || 0);
      newCursor.resume_marker_reached = false;
    }
    if (parsedResult?.resume_marker_reached) {
      newCursor.resume_marker_reached = true;
    }
    if (messagesArray.length > 0) {
      newCursor.oldest_timestamp_ms = messagesArray[0].timestamp_ms;
      newCursor.oldest_message_id = messagesArray[0].fb_message_id;
      newCursor.oldest_content = messagesArray[0].content || '';
      newCursor.oldest_is_outgoing = messagesArray[0].is_outgoing ? 1 : 0;
      newCursor.oldest_media_type = messagesArray[0].media_type || null;
      newCursor.oldest_media_url = messagesArray[0].media_url || null;
      newCursor.newest_timestamp_ms = messagesArray[messagesArray.length - 1].timestamp_ms;
      newCursor.newest_message_id = messagesArray[messagesArray.length - 1].fb_message_id;
    }

    sendToBackend('THREAD_MESSAGES_SYNCED', {
      account_id: targetAcc,
      thread_id,
      messages: messagesArray,
      mode,
      checkpoint: newCursor,
      fetched_count: messagesArray.length + parserSkipped,
      skipped_count: parserSkipped,
      scroll_delta: Number(scroll_delta) || 0
    });
    return { ok: true, checkpoint: newCursor };
  } catch (err) {
    console.error('[FB Engine] Lỗi sync thread messages:', err.message);
    sendToBackend('THREAD_MESSAGES_SYNCED', { account_id: targetAcc, thread_id, messages: [], reason: 'timeout' });
    return false;
  } finally {
    releaseManualHistoryOwner();
    if (previousActiveTabId) {
      await chrome.tabs.update(previousActiveTabId, { active: true }).catch(() => null);
    }
  }
}

let bulkHistorySyncInFlight = false;

// Set to true when a user-click sync needs the history tab immediately.
// The bulk sync worker loop checks this flag and yields on each thread.
let bulkHistorySyncAbortRequested = false;

// Tracks the thread the user last explicitly clicked in the CRM.
// While set, the history tab is LOCKED to this thread — no background
// sync is allowed to navigate it elsewhere until the user clicks again.
let userNavigationLockThreadId = null;

async function handleBulkHistorySync({ account_id, job_id, threads = [] } = {}) {
  const targetAcc = account_id || user_id;
  const personalThreads = (Array.isArray(threads) ? threads : [])
    .filter((thread) => thread?.thread_id && !thread.page_id);

  if (bulkHistorySyncInFlight) {
    sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
      account_id: targetAcc, job_id, status: 'failed',
      error: 'BULK_HISTORY_ALREADY_RUNNING', total: personalThreads.length
    });
    return;
  }
  if (!targetAcc || personalThreads.length === 0) {
    sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
      account_id: targetAcc, job_id, status: 'completed', total: 0, completed: 0, failed: 0
    });
    return;
  }

  bulkHistorySyncInFlight = true;
  const createdTabIds = [];
  let keeper = null;
  let completed = 0;
  let failed = 0;
  try {
    keeper = await ensureRoleMessengerTab(targetAcc, 'history');
    if (!keeper?.id) throw new Error('HISTORY_TAB_NOT_AVAILABLE');

    // Use only 1 worker tab (the existing history tab) to avoid creating
    // extra Chrome tabs that confuse the user. A user-click can abort the
    // bulk loop at any thread boundary via bulkHistorySyncAbortRequested.
    bulkHistorySyncAbortRequested = false;
    const workerTabs = [keeper];

    sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
      account_id: targetAcc, job_id, status: 'running', total: personalThreads.length,
      completed: 0, failed: 0
    });

    let nextThreadIndex = 0;
    await Promise.all(workerTabs.map(async (workerTab) => {
      while (true) {
        // If a user clicked a thread, stop bulk sync immediately so the
        // history tab is freed for the higher-priority navigation.
        if (bulkHistorySyncAbortRequested) {
          console.log('[BULK_HISTORY] Aborted by user-click navigation request.');
          return;
        }
        const index = nextThreadIndex++;
        if (index >= personalThreads.length) return;
        const thread = personalThreads[index];
        try {
          let syncResult = null;
          for (let chunk = 0; chunk < 40; chunk++) {
            syncResult = await handleSyncThreadMessages({
              account_id: targetAcc,
              thread_id: String(thread.thread_id),
              thread_url: thread.thread_url || null,
              contact_name: thread.contact_name || null,
              mode: 'bulk_full',
              cursor: syncResult?.checkpoint || null,
              reason: 'bulk_history_sync',
              allow_navigation: true,
              _history_tab_id: workerTab.id
            });
            if (!syncResult?.ok) throw new Error('THREAD_HISTORY_SYNC_FAILED');
            // Every chunk above has already been sent to the server/DB. Continue
            // only while the round budget, rather than the top of history, ended it.
            if (syncResult.checkpoint?.stop_reason !== 'max_rounds_hit') break;
            await delay(120);
          }
          completed += 1;
          sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
          account_id: targetAcc, job_id, status: 'running',
          thread_id: String(thread.thread_id), total: personalThreads.length,
          completed, failed
          });
        } catch (error) {
          failed += 1;
          console.warn(`[BULK_HISTORY] thread=${thread.thread_id} failed:`, error.message);
          sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
          account_id: targetAcc, job_id, status: 'running',
          thread_id: String(thread.thread_id), total: personalThreads.length,
          completed, failed, error: error.message
          });
        }
      }
    }));

    sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
      account_id: targetAcc, job_id, status: 'completed',
      total: personalThreads.length, completed, failed
    });
  } catch (error) {
    console.error('[BULK_HISTORY] fatal:', error.message);
    sendToBackend('BULK_HISTORY_SYNC_PROGRESS', {
      account_id: targetAcc, job_id, status: 'failed', total: personalThreads.length,
      completed, failed: Math.max(failed, personalThreads.length - completed), error: error.message
    });
  } finally {
    // Only the registered keeper survives. Closing by explicit IDs avoids
    // touching interaction/discovery or any user-opened Messenger tab.
    for (const tabId of createdTabIds) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
    if (keeper?.id) {
      await registerTab(FbCrmMessengerTabRoles.roleKey(targetAcc, 'history'), keeper.id);
    }
    bulkHistorySyncInFlight = false;
  }
}

const handledCallRequests = new Map();
const recentOutgoingCallThreads = new Map();
let callTriggerInFlight = false;

async function handleTriggerMessengerCall({ thread_id, account_id = user_id, call_type = 'audio', call_request_id = '' }) {
  if (callTriggerInFlight) {
    sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: false, error: 'CALL_TRIGGER_ALREADY_RUNNING' });
    return;
  }
  callTriggerInFlight = true;
  try {
    const now = Date.now();
    const requestKey = String(call_request_id || `${account_id}:${thread_id}:${call_type}`);
    for (const [key, timestamp] of handledCallRequests) {
      if (now - timestamp > 30000) handledCallRequests.delete(key);
    }
    if (handledCallRequests.has(requestKey)) return;
    handledCallRequests.set(requestKey, now);

    // Never start another Messenger call while this Chrome profile already
    // owns a groupcall window. Focus the existing call and collapse any stale
    // duplicates left by Facebook instead.
    const existingTabs = await chrome.tabs.query({});
    const existingPlan = CallTabDeduplicator.planGroupCallTabs(existingTabs);
    if (existingPlan.keeper) {
      for (const duplicateTabId of existingPlan.duplicateTabIds) {
        try { await chrome.tabs.remove(duplicateTabId); } catch (_) {}
      }
      try {
        await chrome.tabs.update(existingPlan.keeper.id, { active: true });
        await chrome.windows.update(existingPlan.keeper.windowId, { focused: true });
      } catch (_) {}
      sendToBackend('CALL_TRIGGER_RESULT', {
        thread_id,
        success: true,
        call_type,
        reused_existing_window: true
      });
      return;
    }

    // Calls never create Messenger tabs. They only reuse the one background
    // Messenger tab established by account startup.
    const registeredCallTab = await getRegisteredTab(FbCrmMessengerTabRoles.roleKey(account_id, 'interaction'))
      || await getRegisteredTab(FbCrmMessengerTabRoles.legacyInteractionKey(account_id));
    const tab = registeredCallTab || await ensureRoleMessengerTab(account_id, 'chat');
    if (!tab) {
      sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: false, error: 'Không tìm thấy Tab Facebook Messenger' });
      return;
    }

    await registerTab(FbCrmMessengerTabRoles.roleKey(account_id, 'interaction'), tab.id);
    await registerTab(FbCrmMessengerTabRoles.legacyInteractionKey(account_id), tab.id);

    // Execute call trigger in background Messenger tab so user stays on CRM page (http://localhost:5050)
    // while Facebook's "Cuộc gọi qua Messenger" popup window opens on top.

    const recipientPsid = extractBareThreadId(thread_id);
    const onThread = await ensureTabOnThread(tab, recipientPsid, null);
    if (!onThread) {
      sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: false, error: 'Không thể điều hướng tới cuộc trò chuyện' });
      return;
    }

    await delay(1200);

    const windowsBeforeCall = await chrome.windows.getAll();
    const windowIdsBeforeCall = new Set(windowsBeforeCall.map((win) => win.id));

    const callResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (targetType) => {
        const lockKey = `crm_call_lock:${location.pathname}:${targetType}`;
        const previousLock = Number(sessionStorage.getItem(lockKey) || 0);
        if (Date.now() - previousLock < 15000) {
          return { success: false, duplicate: true, error: 'DUPLICATE_CALL_TRIGGER' };
        }
        sessionStorage.setItem(lockKey, String(Date.now()));
        const isVideo = targetType === 'video';

        const findButton = () => {
          // 1. Direct query for Facebook's exact aria-label strings (Voice and Video)
          const exactAttr = isVideo
            ? '[aria-label="Bắt đầu gọi video"], [aria-label="Bắt đầu cuộc gọi video"]'
            : '[aria-label="Bắt đầu gọi thoại"], [aria-label="Bắt đầu cuộc gọi thoại"]';
          const exactEl = document.querySelector(exactAttr);
          if (exactEl) return exactEl;

          // 2. SVG path detection for phone vs video camera icon
          if (!isVideo) {
            const svgPath = document.querySelector('svg path[d*="4.776 1.111"]');
            if (svgPath) {
              const svgBtn = svgPath.closest('[role="button"]') || svgPath.closest('button') || svgPath.closest('div[tabindex]');
              if (svgBtn) return svgBtn;
            }
          } else {
            const allRoleBtns = [...document.querySelectorAll('[role="button"], button, [tabindex]')];
            for (const btnEl of allRoleBtns) {
              const label = (btnEl.getAttribute('aria-label') || '').toLowerCase();
              if (label.includes('video') || label.includes('máy quay')) return btnEl;
            }
          }

          // 3. Broad attribute scan
          const elements = [...document.querySelectorAll('[aria-label], [role="button"], [tabindex], button')];
          for (const el of elements) {
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            if (!label) continue;
            if (isVideo) {
              if (label.includes('bắt đầu gọi video') || label.includes('cuộc gọi video') || label.includes('gọi video') || label.includes('video call')) {
                return el;
              }
            } else {
              if (label.includes('bắt đầu gọi thoại') || label.includes('cuộc gọi thoại') || label.includes('gọi thoại') || label.includes('gọi âm thanh') || label.includes('voice call') || label.includes('audio call')) {
                return el;
              }
            }
          }
          return null;
        };

        let btn = findButton();
        if (!btn) {
          // Facebook Messenger SPA can take 3-6 seconds to fully render thread header icons.
          // Retry for up to ~14 seconds.
          for (let i = 0; i < 35; i++) {
            await new Promise((r) => setTimeout(r, 400));
            btn = findButton();
            if (btn) break;
          }
        }

        if (btn) {
          btn.focus();
          // HTMLElement.click() already performs the full activation. The
          // previous synthetic mouse sequence included a second click and
          // could open two Messenger call windows.
          btn.click();
          return { success: true, label: btn.getAttribute('aria-label') };
        }
        return { success: false, error: 'Không tìm thấy nút gọi trên Facebook Messenger' };
      },
      args: [call_type]
    });

    const res = callResult?.[0]?.result;
    if (res?.success) {
      recentOutgoingCallThreads.set(String(thread_id).split(':').pop(), Date.now());
      console.log('[FB Engine] ✅ Đã kích hoạt cuộc gọi Messenger thành công:', res.label);
      sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: true, call_type, label: res.label });

      // ===========================================================
      // CALL POPUP MONITOR: detect when the call popup window closes
      // → automatically send call log to server → CRM shows bubble
      // ===========================================================
      const callStartTime = Date.now();

      // Deduplicate by TAB, not by window. Facebook sometimes navigates the
      // already-existing hidden Messenger tab to /groupcall and also creates
      // a popup, so filtering only newly-created window IDs misses one copy.
      let guardedCallTabId = null;
      for (let guardTick = 0; guardTick < 40; guardTick++) {
        await delay(200);
        const allTabs = await chrome.tabs.query({});
        const preferredWindowIds = allTabs
          .filter((candidate) => !windowIdsBeforeCall.has(candidate.windowId))
          .map((candidate) => candidate.windowId);
        const plan = CallTabDeduplicator.planGroupCallTabs(
          allTabs,
          guardedCallTabId,
          preferredWindowIds
        );
        if (!plan.keeper) continue;
        guardedCallTabId = plan.keeper.id;
        for (const duplicateTabId of plan.duplicateTabIds) {
          try { await chrome.tabs.remove(duplicateTabId); } catch (_) {}
        }
        // The keeper is enough to install end-of-call monitoring. Continuing
        // this loop delayed listener registration by ~8 seconds and lost short
        // calls that ended before the loop completed.
        break;
      }

      // Snapshot all windows before the popup opens so we can detect the new one
      // Wait up to 8 seconds for the Facebook call popup window to open
      let callWindowId = null;
      if (guardedCallTabId != null) {
        try {
          const guardedTab = await chrome.tabs.get(guardedCallTabId);
          callWindowId = guardedTab.windowId;
        } catch (_) {}
      }
      for (let i = 0; !callWindowId && i < 40; i++) {
        await delay(200);
        const allWindows = await chrome.windows.getAll({ populate: true });
        const callWindows = allWindows.filter((win) =>
          !windowIdsBeforeCall.has(win.id) &&
          (win.tabs || []).some((callTab) => /facebook\.com\/groupcall\//i.test(String(callTab.url || '')))
        );
        if (callWindows.length > 0) {
          const [newWin, ...duplicates] = callWindows;
          callWindowId = newWin.id;
          for (const duplicate of duplicates) {
            try { await chrome.windows.remove(duplicate.id); } catch (_) {}
          }
          // Late duplicate cleanup must not block listener registration.
          for (let guardTick = 0; guardTick < 0; guardTick++) {
            await delay(250);
            const settledWindows = await chrome.windows.getAll({ populate: true });
            const lateDuplicates = settledWindows.filter((win) =>
              win.id !== callWindowId &&
              !windowIdsBeforeCall.has(win.id) &&
              (win.tabs || []).some((callTab) => /facebook\.com\/groupcall\//i.test(String(callTab.url || '')))
            );
            for (const duplicate of lateDuplicates) {
              try { await chrome.windows.remove(duplicate.id); } catch (_) {}
            }
          }
          console.log('[FB Engine] 📞 Phát hiện window cuộc gọi mới, window ID:', callWindowId, 'type:', newWin.type);
          break;
        }
      }

      let callEndReported = false;
      const reportCallEnded = () => {
        if (callEndReported) return;
        callEndReported = true;
        const callDurationMs = Date.now() - callStartTime;
        const callDurationSec = Math.max(0, Math.round(callDurationMs / 1000));
        const isVideo = call_type === 'video';
        const callLabel = isVideo ? 'Cu\u1ed9c g\u1ecdi video' : 'Cu\u1ed9c g\u1ecdi tho\u1ea1i';
        const durationText = callDurationSec < 60
          ? `${callDurationSec} gi\u00e2y`
          : `${Math.floor(callDurationSec / 60)} ph\u00fat ${callDurationSec % 60} gi\u00e2y`;
        sendToBackend('CALL_ENDED', {
          thread_id,
          account_id,
          call_type,
          call_label: callLabel,
          duration_text: durationText,
          duration_ms: callDurationMs,
          timestamp_ms: Date.now()
        });
      };

      if (guardedCallTabId != null) {
        const onCallTabRemoved = (removedTabId) => {
          if (removedTabId !== guardedCallTabId) return;
          chrome.tabs.onRemoved.removeListener(onCallTabRemoved);
          chrome.tabs.onUpdated.removeListener(onCallTabUpdated);
          reportCallEnded();
        };
        const onCallTabUpdated = (updatedTabId, changeInfo) => {
          if (updatedTabId !== guardedCallTabId || !changeInfo.url) return;
          if (/facebook\.com\/groupcall\//i.test(String(changeInfo.url))) return;
          chrome.tabs.onRemoved.removeListener(onCallTabRemoved);
          chrome.tabs.onUpdated.removeListener(onCallTabUpdated);
          reportCallEnded();
        };
        chrome.tabs.onRemoved.addListener(onCallTabRemoved);
        chrome.tabs.onUpdated.addListener(onCallTabUpdated);
      }

      if (callWindowId) {
        // Listen for this specific popup window to close
        const onWindowRemoved = (removedWindowId) => {
          if (removedWindowId !== callWindowId) return;
          chrome.windows.onRemoved.removeListener(onWindowRemoved);
          if (callEndReported) return;
          callEndReported = true;

          const callDurationMs = Date.now() - callStartTime;
          const callDurationSec = Math.round(callDurationMs / 1000);
          const isVideo = call_type === 'video';
          const callLabel = isVideo ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
          const durationText = callDurationSec < 60
            ? `${callDurationSec} giây`
            : `${Math.floor(callDurationSec / 60)} phút ${callDurationSec % 60} giây`;

          console.log(`[FB Engine] 📞 Cuộc gọi kết thúc sau ${durationText}. Gửi log về server.`);

          // Send call log to backend → will be saved to DB and emitted to CRM
          sendToBackend('CALL_ENDED', {
            thread_id,
            account_id,
            call_type,
            call_label: callLabel,
            duration_text: durationText,
            duration_ms: callDurationMs,
            timestamp_ms: Date.now()
          });
        };
        chrome.windows.onRemoved.addListener(onWindowRemoved);
      } else {
        console.warn('[FB Engine] ⚠️ Không tìm thấy popup cuộc gọi để giám sát.');
      }

    } else {
      console.warn('[FB Engine] ❌ Không thể kích hoạt cuộc gọi:', res?.error);
      sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: false, error: res?.error || 'Lỗi không tìm thấy nút gọi' });
    }
  } catch (err) {
    console.error('[FB Engine] ❌ Lỗi ngoại lệ khi kích hoạt cuộc gọi:', err.message);
    sendToBackend('CALL_TRIGGER_RESULT', { thread_id, success: false, error: err.message });
  } finally {
    callTriggerInFlight = false;
  }
}

async function handleAnswerIncomingCall({ action, thread_id, source_tab_id, source_frame_id, call_id }) {
  const message = { type: 'ANSWER_INCOMING_CALL', action, thread_id };
  let lastError = 'Call button was not found in Messenger';

  try {
    let tabId = Number.isInteger(source_tab_id) ? source_tab_id : null;
    let frameId = tabId && Number.isInteger(source_frame_id) ? source_frame_id : 0;

    // Handle the action on exactly one tab. Prefer the tab that emitted the
    // ringing event; otherwise use the first managed Messenger tab only.
    if (!tabId) {
      const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/messages/*' }).catch(() => []);
      tabId = tabs.find((tab) => Number.isInteger(tab.id))?.id || null;
      frameId = 0;
    }

    if (!tabId) {
      sendToBackend('ANSWER_INCOMING_CALL_RESULT', { action, thread_id, call_id, source_tab_id: null, success: false, error: lastError });
      return;
    }

    const response = await chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => null);
    if (response?.success) {
      sendToBackend('ANSWER_INCOMING_CALL_RESULT', { action, thread_id, call_id, source_tab_id: tabId, success: true });
      return;
    }

    lastError = response?.error || lastError;

    sendToBackend('ANSWER_INCOMING_CALL_RESULT', { action, thread_id, call_id, source_tab_id: tabId, success: false, error: lastError });
  } catch (error) {
    sendToBackend('ANSWER_INCOMING_CALL_RESULT', { action, thread_id, call_id, source_tab_id, success: false, error: error?.message || lastError });
  }
}

// Khởi chạy kết nối WS khi service worker load
connectWebSocket();

// Manifest V3 service workers are non-persistent - Chrome kills this one after
// ~30s idle and re-runs the whole script from scratch on the next event,
// wiping ws/user_id/fb_dtsg/reconnectDelay and forcing a fresh REGISTER_ACCOUNT
// handshake every time. A repeating alarm below ~30s keeps the worker woken up
// on a schedule instead of leaving it to Chrome's idle heuristics, cutting down
// how often that churn happens (spec 042). The handler is intentionally a
// no-op: any real work here would be a side effect nobody asked for.
const KEEPALIVE_ALARM_NAME = 'fb_engine_keepalive';
function maintainBackendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'HEARTBEAT', data: { account_id: user_id || null, at: Date.now() } }));
      return;
    } catch (_) {}
  }
  connectWebSocket();
  checkFacebookCookiesAndRegister().catch(() => {});
}

let realtimeReceiverRecovery = null;
function recoverRealtimeReceiver() {
  if (realtimeReceiverRecovery) return realtimeReceiverRecovery;
  realtimeReceiverRecovery = (async () => {
    await checkFacebookCookiesAndRegister();
    if (!user_id) return false;
    const tab = await ensureRoleMessengerTab(user_id, 'chat');
    const observerReady = await ensureRealtimeObserver(tab?.id);
    if (observerReady) await flushBackendOutbox();
    return observerReady;
  })().catch((error) => {
    console.warn('[FB Engine] Realtime receiver recovery failed:', error?.message || error);
    return false;
  }).finally(() => {
    realtimeReceiverRecovery = null;
  });
  return realtimeReceiverRecovery;
}

setInterval(maintainBackendHeartbeat, 10000);
// Chrome can restart a Messenger renderer while the extension socket stays
// connected. Re-check the live receiver frequently so realtime never waits
// for the 20-minute MV3 alarm or a history crawl.
setInterval(() => recoverRealtimeReceiver(), 5000);
chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 20 / 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    console.log('[FB Engine] 💓 Keepalive alarm tick');
    // An alarm wakes a suspended MV3 worker. Re-open the backend socket and
    // restore the realtime observer before another customer message arrives.
    maintainBackendHeartbeat();
    recoverRealtimeReceiver();
  }
});

// Do not wait for the first outbound CRM command. Restore the Messenger tab,
// content observer and queued customer messages as soon as the worker starts.
recoverRealtimeReceiver();
chrome.runtime.onStartup?.addListener(() => recoverRealtimeReceiver());
