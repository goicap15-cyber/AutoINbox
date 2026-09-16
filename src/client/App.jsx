import React, { useState, useEffect, useCallback, useRef } from 'react';
import AppSidebar from './components/AppSidebar.jsx';
import ConversationSidebar from './components/ConversationSidebar.jsx';
import ChatHeader from './components/ChatHeader.jsx';
import MessageList from './components/MessageList.jsx';
import MessageComposer from './components/MessageComposer.jsx';
import MessageRequestActions from './components/MessageRequestActions.jsx';
import LeadDetailsPanel from './components/LeadDetailsPanel.jsx';
import EmptyState from './components/EmptyState.jsx';
import SearchOverlay from './components/SearchOverlay.jsx';
import AccountManagerModal from './components/AccountManagerModal.jsx';
import AutoReplyModal from './components/AutoReplyModal.jsx';
import CampaignCreateModal from './components/CampaignCreateModal.jsx';
import CampaignDetail from './components/CampaignDetail.jsx';
import AiConfigModal from './components/AiConfigModal.jsx';
import PhoneAutomationSettingsModal from './components/PhoneAutomationSettingsModal.jsx';
import IncomingCallModal from './components/IncomingCallModal.jsx';
import PaymentModal from './components/PaymentModal.jsx';
import LicenseManagerModal from './components/LicenseManagerModal.jsx';
import LicenseLockScreen from './components/LicenseLockScreen.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import EmployeeManagementModal from './components/EmployeeManagementModal.jsx';
import { useSocket } from './hooks/useSocket.js';
import { MessageSquare } from 'lucide-react';
import { sortThreadsByActivity } from './utils/threadActivity.js';

const THEME_VERSION = 'chat-redesign-v1';
const WAITING_REQUEST_REFRESH_MS = 15000;

// Older/background sync payloads can create a thread before Messenger returns
// the actual display name.  Do not keep showing that placeholder once the
// contact record has a verified name.
function isPlaceholderContactName(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('vi-VN');
  return !normalized || normalized === 'khÃ¡ch hÃ ng' || normalized === 'customer';
}

function getVerifiedContactName(contact) {
  const name = String(contact?.name || contact?.contact_name || '').trim();
  return isPlaceholderContactName(name) ? '' : name;
}

const messageTime = (message) => {
  // Local outgoing placeholders keep this anchor for their whole lifetime.
  // Delivery confirmation may arrive later, but it must not move the bubble.
  const anchor = Number(message?.order_anchor_ms);
  if (Number.isFinite(anchor) && anchor > 0) return anchor;
  const numeric = Number(message?.timestamp_ms);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(message?.created_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortMessagesChronologically = (items = []) => items
  .map((message, originalIndex) => ({ message, originalIndex }))
  .sort((left, right) => {
    const sequenceA = Number(left.message?.sequence_order ?? left.message?.id);
    const sequenceB = Number(right.message?.sequence_order ?? right.message?.id);
    // Persisted backend order is authoritative. A local placeholder without a
    // backend sequence keeps its existing array position; timestamps never
    // participate in chat ordering.
    if (Number.isFinite(sequenceA) && Number.isFinite(sequenceB) && sequenceA !== sequenceB) {
      return sequenceA - sequenceB;
    }
    return left.originalIndex - right.originalIndex;
  })
  .map(({ message }) => message);

const messageText = (message) => String(
  message?.content ?? message?.text_content ?? message?.text ?? message?.message ?? ''
).trim();

const hasRenderableMessagePayload = (message) => Boolean(
  messageText(message)
  || message?.media_url
  || message?.local_media_path
  || message?.attachment_id
  || message?.attachment?.preview_url
  || message?.attachment?.media_url
  || message?.attachment?.local_media_path
  || message?.attachment?.id
  || message?.media_type === 'call'
);

const filterRenderableMessages = (items = []) => items.filter((message) => {
  if (hasRenderableMessagePayload(message)) return true;
  const status = String(message?.status || message?.delivery_status || '').toLowerCase();
  return Boolean(message?.client_message_id && ['sending', 'pending', 'failed'].includes(status));
});

const preserveOrderAnchors = (incoming = [], existing = []) => {
  const byClientId = new Map(existing.filter((m) => m?.client_message_id).map((m) => [String(m.client_message_id), m]));
  const byFacebookId = new Map(existing.filter((m) => m?.fb_message_id).map((m) => [String(m.fb_message_id), m]));
  return incoming.map((message) => {
    const previous = (message.client_message_id && byClientId.get(String(message.client_message_id)))
      || (message.fb_message_id && byFacebookId.get(String(message.fb_message_id)));
    return previous?.order_anchor_ms
      ? { ...message, order_anchor_ms: previous.order_anchor_ms }
      : message;
  });
};

// Live chat is append-only. Database/history snapshots are completeness
// updates, not a reason to rebuild and sort the visible conversation. Keep
// every bubble already on screen at its exact array position, patch it only
// when the same durable identity is observed, then append genuinely unseen
// rows in the order supplied by the backend.
const mergeMessagesWithoutReordering = (existing = [], incoming = []) => {
  const cleanIncoming = filterRenderableMessages(incoming);
  if (!existing.length) return sortMessagesChronologically(cleanIncoming);
  const result = filterRenderableMessages(existing);
  let newestVisibleSequence = existing.reduce((maximum, message) => {
    const sequence = Number(message?.sequence_order ?? message?.id);
    return Number.isFinite(sequence) ? Math.max(maximum, sequence) : maximum;
  }, Number.NEGATIVE_INFINITY);
  const identities = (message) => [
    message?.client_message_id ? `client:${message.client_message_id}` : null,
    message?.attachment_id ? `attachment:${message.attachment_id}` : null,
    message?.fb_message_id ? `fb:${message.fb_message_id}` : null,
    message?.id != null ? `id:${message.id}` : null
  ].filter(Boolean);
  const indexByIdentity = new Map();
  result.forEach((message, index) => identities(message).forEach((key) => indexByIdentity.set(key, index)));

  cleanIncoming.forEach((message) => {
    let matchedIndex = identities(message)
      .map((key) => indexByIdentity.get(key))
      .find((index) => index !== undefined);
    if (matchedIndex === undefined && message?.is_outgoing && String(message?.fb_message_id || '').startsWith('mid.')) {
      const incomingText = String(message.content || '').trim();
      const incomingAt = Number(message.timestamp_ms) || Date.parse(message.created_at || '') || 0;
      const optimisticIdx = result.findIndex((candidate) => {
        if (!candidate?.is_outgoing) return false;
        const candFbId = String(candidate?.fb_message_id || '');
        const candClientId = String(candidate?.client_message_id || '');
        const isTemporary = candClientId || candFbId.startsWith('pending_') || !candFbId.startsWith('mid.');
        if (!isTemporary) return false;
        if (String(candidate.content || '').trim() !== incomingText) return false;
        const candidateAt = Number(candidate.timestamp_ms) || Date.parse(candidate.created_at || '') || 0;
        return !incomingAt || !candidateAt || Math.abs(incomingAt - candidateAt) <= 120000;
      });
      if (optimisticIdx >= 0) {
        matchedIndex = optimisticIdx;
      }
    }
    if (matchedIndex === undefined) {
      const incomingSequence = Number(message?.sequence_order ?? message?.id);
      const previousId = String(message?.dom_previous_message_id || '');
      const nextId = String(message?.dom_next_message_id || '');
      const previousIndex = message?.dom_position_confirmed && previousId
        ? result.findIndex((candidate) => String(candidate?.fb_message_id || '') === previousId)
        : -1;
      const nextIndex = message?.dom_position_confirmed && nextId
        ? result.findIndex((candidate) => String(candidate?.fb_message_id || '') === nextId)
        : -1;
      if (previousIndex >= 0 || nextIndex >= 0) {
        const insertAt = previousIndex >= 0 ? previousIndex + 1 : nextIndex;
        result.splice(insertAt, 0, message);
        indexByIdentity.clear();
        result.forEach((candidate, index) => identities(candidate)
          .forEach((key) => indexByIdentity.set(key, index)));
        if (Number.isFinite(incomingSequence)) newestVisibleSequence = Math.max(newestVisibleSequence, incomingSequence);
        return;
      }
      // Missing older rows are completeness backfill, not a new arrival.
      // Insert it at its durable sequence without rebuilding/re-sorting the
      // rest of the live chat. This must apply to text too; otherwise a blank
      // conversation only becomes visible after the operator sends a new
      // message, and the fetched older rows end up in the wrong place.
      if (Number.isFinite(newestVisibleSequence) && Number.isFinite(incomingSequence)
        && incomingSequence <= newestVisibleSequence) {
        const insertAt = result.findIndex((candidate) => {
          const candidateSequence = Number(candidate?.sequence_order ?? candidate?.id);
          return Number.isFinite(candidateSequence) && candidateSequence > incomingSequence;
        });
        result.splice(insertAt >= 0 ? insertAt : result.length, 0, message);
        indexByIdentity.clear();
        result.forEach((candidate, index) => identities(candidate)
          .forEach((key) => indexByIdentity.set(key, index)));
        return;
      }
      const appendedIndex = result.length;
      result.push(message);
      if (Number.isFinite(incomingSequence)) newestVisibleSequence = Math.max(newestVisibleSequence, incomingSequence);
      identities(message).forEach((key) => indexByIdentity.set(key, appendedIndex));
      return;
    }
    const previous = result[matchedIndex];
    const incomingStatus = String(message?.delivery_status || message?.status || '').toLowerCase();
    const incomingIsTerminalSuccess = ['sent', 'delivered', 'read'].includes(incomingStatus);
    result[matchedIndex] = {
      ...previous,
      ...message,
      status: incomingIsTerminalSuccess
        ? incomingStatus
        : (message.status || message.delivery_status || previous.status),
      delivery_status: incomingIsTerminalSuccess
        ? incomingStatus
        : (message.delivery_status || message.status || previous.delivery_status),
      error: incomingIsTerminalSuccess ? null : (message.error ?? previous.error),
      ui_render_key: previous.ui_render_key || message.ui_render_key,
      ui_position_locked: previous.ui_position_locked || message.ui_position_locked,
      order_anchor_ms: previous.order_anchor_ms,
      sequence_order: previous.sequence_order ?? message.sequence_order
    };
    identities(result[matchedIndex]).forEach((key) => indexByIdentity.set(key, matchedIndex));
  });
  return result;
};
const isSyntheticId = (messageOrId) => {
  const id = typeof messageOrId === 'string'
    ? messageOrId
    : String(messageOrId?.fb_message_id || messageOrId?.id || '');
  return !id || /^(?:dom_|history_|sidebar_preview_|pending_|network_|websocket_|mercury_|xhr_)/i.test(id) || !id.startsWith('mid.');
};

// A CRM text send can briefly arrive twice: once as the local/client row and
// once as Messenger's DOM row carrying only an fb_message_id. Merge only that
// asymmetric pair. Two real sends both have their own client_message_id, so
// repeated identical messages are intentionally preserved.
const reconcileOutgoingTextEchoes = (items = []) => {
  const result = [];
  const normalizedText = (message) => String(message?.content || '')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/\s+/g, ' ').trim();
  const isPlainText = (message) => !(
    message?.attachment_id || message?.media_url || message?.local_media_path
    || (message?.media_type && message.media_type !== 'text')
  );
  // SQLite/network payloads may encode the flag as 0/1 or as a string. Never
  // use JavaScript truthiness here: Boolean("0") is true and was the reason
  // an incoming history echo could survive the old filter.
  const isOutgoing = (message) => message?.is_outgoing === true
    || message?.is_outgoing === 1
    || String(message?.is_outgoing || '').toLowerCase() === 'true'
    || String(message?.is_outgoing || '') === '1';
  const outgoingTextKeys = new Set(items
    .filter((message) => isOutgoing(message) && isPlainText(message) && normalizedText(message))
    .map((message) => normalizedText(message).toLocaleLowerCase('vi-VN')));
  const withoutIncomingEchoes = items.filter((message) => {
    if (isOutgoing(message) || !isPlainText(message)) return true;
    const contentKey = normalizedText(message).toLocaleLowerCase('vi-VN');
    // Direction is authoritative: if this thread already has the exact text
    // as an outgoing CRM row, an incoming copy is a Messenger history echo.
    // Keep only the outgoing bubble. Real incoming messages with different
    // content remain untouched.
    if (contentKey && outgoingTextKeys.has(contentKey)) return false;
    return true;
  });

  withoutIncomingEchoes.forEach((message) => {
    if (!message?.is_outgoing || !isPlainText(message) || !normalizedText(message)) {
      result.push(message);
      return;
    }
    const messageAt = messageTime(message);
    const matchIndex = result.findIndex((candidate) => {
      if (!candidate?.is_outgoing || !isPlainText(candidate)) return false;
      if (normalizedText(candidate) !== normalizedText(message)) return false;
      const asymmetricClientEcho = Boolean(candidate.client_message_id) !== Boolean(message.client_message_id);
      const syntheticDomEcho = isSyntheticId(candidate) || isSyntheticId(message);
      if (!asymmetricClientEcho && !syntheticDomEcho) return false;
      const candidateAt = messageTime(candidate);
      return !candidateAt || !messageAt || Math.abs(candidateAt - messageAt) <= 120000;
    });
    if (matchIndex < 0) {
      result.push(message);
      return;
    }
    const previous = result[matchIndex];
    const clientRow = previous.client_message_id ? previous : message;
    const observedRow = previous.client_message_id ? message : previous;
    const clientFbId = String(clientRow.fb_message_id || '');
    const observedFbId = String(observedRow.fb_message_id || '');
    const clientIsTemporary = !clientFbId || clientFbId.startsWith('pending_') || !clientFbId.startsWith('mid.');
    if (!clientIsTemporary && observedFbId && clientFbId !== observedFbId
      && !isSyntheticId(previous) && !isSyntheticId(message)) {
      result.push(message);
      return;
    }
    const officialRow = [previous, message].find((row) => String(row?.fb_message_id || '').startsWith('mid.'));
    result[matchIndex] = {
      ...clientRow,
      ...observedRow,
      client_message_id: clientRow.client_message_id,
      fb_message_id: officialRow?.fb_message_id || observedRow.fb_message_id || clientRow.fb_message_id,
      order_anchor_ms: clientRow.order_anchor_ms,
      sequence_order: previous.sequence_order ?? message.sequence_order,
      status: observedRow.status || observedRow.delivery_status || clientRow.status || 'sent',
      delivery_status: observedRow.delivery_status || clientRow.delivery_status || 'sent'
    };
  });
  return result;
};

export default function App() {
  const [theme, setTheme] = useState(() => {
    if (localStorage.getItem('app_theme_version') !== THEME_VERSION) return 'light';
    return localStorage.getItem('app_theme') || 'light';
  });
  const [leadPanelCollapsed, setLeadPanelCollapsed] = useState(false);
  const [showLeadDrawer, setShowLeadDrawer] = useState(false);

  // Responsive detection
  const [isNarrow, setIsNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 1200);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 900);

  useEffect(() => {
    const handleResize = () => {
      setIsNarrow(window.innerWidth < 1200);
      setIsMobile(window.innerWidth < 900);
      if (window.innerWidth >= 1200) setShowLeadDrawer(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Keyboard handler for Escape key on drawer
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && showLeadDrawer) {
        setShowLeadDrawer(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showLeadDrawer]);

  useEffect(() => {
    localStorage.setItem('app_theme_version', THEME_VERSION);
    localStorage.setItem('app_theme', theme);
    document.documentElement.classList.toggle('light-theme', theme === 'light');
  }, [theme]);

  const toggleTheme = () => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));

  const [activeView, setActiveView] = useState('chat');
  const [threads, setThreads] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [inboxSources, setInboxSources] = useState([]);
  const [leadStatuses, setLeadStatuses] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const activeThreadIdRef = useRef(null);
  const [activeTab, setActiveTab] = useState('ALL');
  const activeTabRef = useRef('ALL');
  const threadListRequestVersionRef = useRef(0);
  const [waitingCount, setWaitingCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [messages, setMessages] = useState({});
  const [contacts, setContacts] = useState({});
  const contactRequestVersionRef = useRef(new Map());
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [activeModal, setActiveModal] = useState(null);
  const [richCapabilities, setRichCapabilities] = useState(null);
  const [bulkHistoryProgress, setBulkHistoryProgress] = useState(null);
  const [accountSyncing, setAccountSyncing] = useState(null);
  const [historySyncingThreadId, setHistorySyncingThreadId] = useState(null);
  const historySyncTimeoutRef = useRef(null);
  const requestedFacebookSyncRef = useRef(null);
  const [sidebarSyncUntil, setSidebarSyncUntil] = useState(0);
  const [sidebarSyncClock, setSidebarSyncClock] = useState(() => Date.now());

  const [campaignSelectionMode, setCampaignSelectionMode] = useState(false);
  const [selectedCampaignThreadIds, setSelectedCampaignThreadIds] = useState([]);
  const [activeCampaignId, setActiveCampaignId] = useState(null);
  const [campaignRefreshVersion, setCampaignRefreshVersion] = useState(0);
  const [incomingCallInfo, setIncomingCallInfo] = useState(null);
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [sessionUser, setSessionUser] = useState(null);
  const sessionUserIdRef = useRef(null);
  const accountsRef = useRef([]);
  const [authLoading, setAuthLoading] = useState(true);
  const { socket, isConnected } = useSocket(Boolean(sessionUser));

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const json = await res.json().catch(() => ({}));
      setSessionUser(res.ok && json.success ? json.user : null);
    } catch {
      setSessionUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  useEffect(() => {
    const nextUserId = sessionUser?.id ?? null;
    if (sessionUserIdRef.current !== nextUserId) {
      setThreads([]);
      setAccounts([]);
      accountsRef.current = [];
      setInboxSources([]);
      setMessages({});
      setContacts({});
      setActiveThreadId(null);
      setWaitingCount(0);
      setSelectedCampaignThreadIds([]);
      setCampaignSelectionMode(false);
      setActiveCampaignId(null);
    }
    sessionUserIdRef.current = nextUserId;
  }, [sessionUser?.id]);

  const checkLicenseStatus = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/license/status', { signal: controller.signal });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success && json.data) {
        setLicenseStatus(json.data);
      } else {
        setLicenseStatus({
          isLicensed: false,
          reason: json.code || 'LICENSE_CHECK_FAILED',
          message: json.message || 'KhÃ´ng thá»ƒ kiá»ƒm tra báº£n quyá»n.'
        });
      }
    } catch (e) {
      console.warn('Failed to check license status:', e);
      // Never leave the desktop shell on an infinite loading screen. This
      // does not bypass licensing: the existing lock screen still prevents
      // CRM use until a valid status is returned.
      setLicenseStatus({
        isLicensed: false,
        reason: e?.name === 'AbortError' ? 'LICENSE_CHECK_TIMEOUT' : 'LICENSE_CHECK_FAILED',
        message: e?.name === 'AbortError'
          ? 'MÃ¡y chá»§ báº£n quyá»n pháº£n há»“i quÃ¡ lÃ¢u. Vui lÃ²ng thá»­ láº¡i.'
          : 'KhÃ´ng thá»ƒ káº¿t ná»‘i Ä‘á»ƒ kiá»ƒm tra báº£n quyá»n.'
      });
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    if (sessionUser) checkLicenseStatus();
    else setLicenseStatus(null);
  }, [checkLicenseStatus, sessionUser]);

  const loadInboxSources = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox-sources');
      const data = await res.json();
      setInboxSources(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn('Failed to load inbox sources:', e);
      setInboxSources([]);
    }
  }, []);

  const loadLeadStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/lead-statuses');
      const data = await res.json();
      setLeadStatuses(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn('Failed to load lead statuses:', e);
      setLeadStatuses([]);
    }
  }, []);

  const handleCreateLeadStatus = useCallback(async (name, color) => {
    try {
      const res = await fetch('/api/lead-statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      const created = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(created?.error || 'KhÃ´ng thá»ƒ táº¡o tráº¡ng thÃ¡i má»›i.');
      }
      if (created?.id != null) {
        setLeadStatuses((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
      }
      return created;
    } catch (e) {
      console.warn('Failed to create lead status:', e);
      return null;
    }
  }, []);

  const handleDeleteLeadStatus = useCallback(async (id) => {
    try {
      await fetch(`/api/lead-statuses/${id}`, { method: 'DELETE' });
      setLeadStatuses((prev) => prev.filter((s) => s.id !== id));
      setThreads((prev) => prev.map((t) => (t.status_id === id ? { ...t, status_id: null, status_name: null, status_color: null } : t)));
      setContacts((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((tid) => {
          if (next[tid]?.status_id === id) next[tid] = { ...next[tid], status_id: null };
        });
        return next;
      });
      return true;
    } catch (e) {
      console.warn('Failed to delete lead status:', e);
      return false;
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      const accountList = Array.isArray(data) ? data : [];
      setAccounts(accountList);
      accountsRef.current = accountList;
      setHasCheckpoint(accountList.some(a => a.status === 'CHECKPOINT'));
    } catch (e) {
      console.warn('Failed to load accounts:', e);
      setAccounts([]);
    }
  }, []);

  const loadThreads = useCallback(async () => {
    if (!sessionUser) return;
    const requestedUserId = sessionUser.id;
    const requestedTab = activeTab;
    const requestVersion = ++threadListRequestVersionRef.current;
    try {
      const res = await fetch(`/api/threads?tab=${requestedTab}`);
      const data = await res.json();
      if (sessionUserIdRef.current !== requestedUserId
        || activeTabRef.current !== requestedTab
        || threadListRequestVersionRef.current !== requestVersion) return;
      const threadList = Array.isArray(data) ? data : [];
      setThreads(sortThreadsByActivity(threadList.map(t => ({ ...t, thread_key: t.thread_key || (t.account_id ? `${t.account_id}:${t.id}` : String(t.id)) }))));
    } catch {
      if (activeTabRef.current === requestedTab && threadListRequestVersionRef.current === requestVersion) setThreads([]);
    }
  }, [activeTab, sessionUser]);

  const loadWaitingCount = useCallback(async () => {
    if (!sessionUser) return;
    const requestedUserId = sessionUser.id;
    try {
      const response = await fetch('/api/threads/waiting-count');
      const data = await response.json();
      if (sessionUserIdRef.current !== requestedUserId) return;
      setWaitingCount(Math.max(0, Number(data?.count) || 0));
    } catch {
      if (sessionUserIdRef.current === requestedUserId) setWaitingCount(0);
    }
  }, [sessionUser]);

  const loadThreadsRef = useRef(loadThreads);
  useEffect(() => { loadThreadsRef.current = loadThreads; }, [loadThreads]);
  useEffect(() => {
    if (sessionUser && licenseStatus?.isLicensed) {
      loadThreads(); loadWaitingCount(); loadAccounts(); loadInboxSources(); loadLeadStatuses();
    }
  }, [sessionUser, licenseStatus?.isLicensed, loadThreads, loadWaitingCount, loadAccounts, loadInboxSources, loadLeadStatuses]);

  useEffect(() => {
    if (!isMobile && !activeThreadId && threads.length > 0) {
      setActiveThreadId(threads[0].id);
    }
  }, [isMobile, activeThreadId, threads]);

  const threadsRef = useRef(threads);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { activeThreadIdRef.current = activeThreadId; }, [activeThreadId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  const sidebarSyncActive = isConnected && sidebarSyncUntil > sidebarSyncClock;
  const sidebarSyncSecondsRemaining = sidebarSyncActive
    ? Math.max(1, Math.ceil((sidebarSyncUntil - sidebarSyncClock) / 1000))
    : 0;

  useEffect(() => {
    if (!sidebarSyncUntil) return undefined;
    const updateClock = () => {
      const now = Date.now();
      setSidebarSyncClock(now);
      if (now >= sidebarSyncUntil) setSidebarSyncUntil(0);
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, [sidebarSyncUntil]);

  useEffect(() => {
    if (!socket) return undefined;
    const handleSyncWindowState = ({ enabled, expires_at } = {}) => {
      const nextUntil = enabled ? Number(expires_at || 0) : 0;
      setSidebarSyncUntil(nextUntil > Date.now() ? nextUntil : 0);
      setSidebarSyncClock(Date.now());
    };
    socket.on('SIDEBAR_SYNC_WINDOW_STATE', handleSyncWindowState);
    return () => socket.off('SIDEBAR_SYNC_WINDOW_STATE', handleSyncWindowState);
  }, [socket]);

  const handleToggleSidebarSync = useCallback(() => {
    if (!socket || !isConnected) return;
    const enable = !sidebarSyncActive;
    socket.emit('SET_SIDEBAR_SYNC_WINDOW', {
      enabled: enable,
      duration_ms: 120000,
      account_ids: accountsRef.current.map((account) => account.id).filter(Boolean)
    });
    // Optimistic feedback keeps the button responsive while the server starts
    // or closes the two background Messenger surfaces.
    const now = Date.now();
    setSidebarSyncClock(now);
    setSidebarSyncUntil(enable ? now + 120000 : 0);
  }, [socket, isConnected, sidebarSyncActive]);

  const requestThreadNavigation = useCallback((thread) => {
    if (!thread) return;
    setActiveThreadId(thread.id);
  }, []);

  const handleConversationTabChange = useCallback((nextTab) => {
    const normalizedTab = nextTab === 'WAITING' ? 'WAITING' : 'ALL';
    if (activeTabRef.current === normalizedTab) return;
    // Clear the previous tab's selected chat in the same render as the list
    // switch. Keeping that stale row while async WAITING data arrived made
    // the old chat alternate between mounted/unmounted on realtime updates.
    activeTabRef.current = normalizedTab;
    threadListRequestVersionRef.current += 1;
    setActiveThreadId(null);
    setThreads([]);
    setActiveTab(normalizedTab);
    if (normalizedTab === 'WAITING' && sidebarSyncActive && socket && isConnected) {
      for (const account of accountsRef.current) {
        if (!account?.id) continue;
        socket.emit('REQUEST_SYNC_MESSAGE_REQUESTS', { account_id: account.id });
      }
    }
  }, [socket, isConnected, sidebarSyncActive]);

  // Message Requests live on a separate Facebook surface. Keep asking for
  // that dedicated scan while WAITING is visible, including after a socket
  // reconnect or when accounts finish loading after the user opened the tab.
  useEffect(() => {
    if (activeTab !== 'WAITING' || !sidebarSyncActive || !socket || !isConnected) return undefined;
    const requestWaitingThreads = () => {
      for (const account of accountsRef.current) {
        if (!account?.id) continue;
        socket.emit('REQUEST_SYNC_MESSAGE_REQUESTS', { account_id: account.id });
      }
    };
    requestWaitingThreads();
    const refreshTimer = setInterval(requestWaitingThreads, WAITING_REQUEST_REFRESH_MS);
    return () => clearInterval(refreshTimer);
  }, [activeTab, sidebarSyncActive, socket, isConnected, accounts]);

  const requestThreadMessageSync = useCallback((threadId, direction = 'initial', scrollDelta = 0) => {
    if (!socket || !isConnected || !threadId) return;
    setHistorySyncingThreadId(String(threadId));
    if (historySyncTimeoutRef.current) clearTimeout(historySyncTimeoutRef.current);
    historySyncTimeoutRef.current = setTimeout(() => {
      setHistorySyncingThreadId((current) => String(current || '') === String(threadId) ? null : current);
      historySyncTimeoutRef.current = null;
    }, 15000);
    socket.emit('REQUEST_SYNC_THREAD_MESSAGES', {
      thread_id: String(threadId),
      direction,
      scroll_delta: ['viewport', 'older'].includes(direction) ? Number(scrollDelta) || 0 : 0
    });
  }, [socket, isConnected]);

  useEffect(() => {
    if (!activeThreadId) return;
    const threadIdStr = String(activeThreadId);
    fetch(`/api/threads/${threadIdStr}/messages`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(prev => ({ ...prev, [threadIdStr]: reconcileOutgoingTextEchoes(mergeMessagesWithoutReordering(prev[threadIdStr] || [], preserveOrderAnchors(data, prev[threadIdStr] || []))) }));
        }
      })
      .catch(() => {});

  }, [activeThreadId]);

  // Socket events are the fast path; this local REST reconciliation is the
  // completeness path. History persistence can finish just after the last
  // socket burst, so refresh the open conversation cheaply once per second.
  useEffect(() => {
    if (!activeThreadId) return undefined;
    const threadIdStr = String(activeThreadId);
    let stopped = false;
    const reconcileFromDatabase = () => {
      fetch(`/api/threads/${encodeURIComponent(threadIdStr)}/messages`)
        .then((response) => response.json())
        .then((data) => {
          if (stopped || !Array.isArray(data)) return;
          setMessages((previous) => ({
            ...previous,
            [threadIdStr]: reconcileOutgoingTextEchoes(mergeMessagesWithoutReordering(previous[threadIdStr] || [], preserveOrderAnchors(data, previous[threadIdStr] || [])))
          }));
        })
        .catch(() => {});
    };
    const timer = setInterval(reconcileFromDatabase, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !isConnected) return;
    requestThreadMessageSync(activeThreadId, 'initial');
  }, [activeThreadId, isConnected, requestThreadMessageSync]);

  useEffect(() => {
    if (!activeThreadId) return;
    const threadIdStr = String(activeThreadId);
    const requestVersion = (contactRequestVersionRef.current.get(threadIdStr) || 0) + 1;
    contactRequestVersionRef.current.set(threadIdStr, requestVersion);
    fetch(`/api/contacts/${threadIdStr}`)
      .then(r => r.json())
      .then(data => {
        if (contactRequestVersionRef.current.get(threadIdStr) !== requestVersion) return;
        setContacts(prev => ({ ...prev, [threadIdStr]: { thread_id: threadIdStr, ...data } }));
        // The thread list can arrive before the contact/avatar lookup. Promote
        // the durable contact avatar into the active thread as soon as it is
        // available so ChatHeader/MessageBubble do not fall back to a letter.
        if (data?.avatar_url) {
          setThreads(prev => prev.map((thread) => (
            String(thread.id) === threadIdStr
              ? { ...thread, avatar_url: data.avatar_url }
              : thread
          )));
        }
        const verifiedName = getVerifiedContactName(data);
        if (verifiedName) {
          setThreads(prev => prev.map((thread) => {
            if (String(thread.id) !== threadIdStr) return thread;
            const currentName = thread.contact_name || thread.name;
            return isPlaceholderContactName(currentName)
              ? { ...thread, contact_name: verifiedName }
              : thread;
          }));
        }
      })
      .catch(() => {});
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) {
      setRichCapabilities(null);
      return;
    }
    const threadId = String(activeThreadId);
    const controller = new AbortController();
    setRichCapabilities(null);
    fetch('/api/threads/' + encodeURIComponent(threadId) + '/rich-message-capabilities', {
      signal: controller.signal
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'KhÃ´ng táº£i Ä‘Æ°á»£c kháº£ nÄƒng gá»­i.');
        return data;
      })
      .then(setRichCapabilities)
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setRichCapabilities({
            text: { enabled: false },
            image: { enabled: false, mime_types: [] },
            file: { enabled: false, mime_types: [] },
            disabled_reason: error.message
          });
        }
      });
    return () => controller.abort();
  }, [activeThreadId]);

  useEffect(() => {
    if (!socket) return;
    socket.on('NEW_MESSAGE', (newMsg) => {
      if (newMsg.account_id && accountsRef.current.length > 0) {
        const matchesAccount = accountsRef.current.some((account) =>
          String(account.id) === String(newMsg.account_id) ||
          String(account.account_id || '') === String(newMsg.account_id)
        );
        if (!matchesAccount) return;
      }
      loadWaitingCount();
      // Map thread_id to canonical thread id if available in threadsRef
      let tidStr = String(newMsg.thread_id);
      const matchedThread = threadsRef.current.find(t =>
        String(t.id) === tidStr ||
        String(t.external_thread_id || '') === tidStr ||
        String(t.id).endsWith(':' + tidStr)
      );
      if (matchedThread) {
        tidStr = String(matchedThread.id);
      }
      setMessages(prev => {
        const currentMsgs = prev[tidStr] || [];
        let updated;
        const newIsMedia = !!(newMsg.attachment_id || newMsg.media_url || (newMsg.media_type && newMsg.media_type !== 'text'));
        const optimisticIdx = currentMsgs.findIndex((message) => {
          if (!newMsg.is_outgoing || !message.is_outgoing || !message.client_message_id) return false;
          // A local bubble may already be marked sent by the provisional numeric
          // confirmation before Messenger emits its final mid.* observation.
          // Keep correlating it for a short arrival window so the final event
          // replaces the bubble instead of flashing a duplicate until reload.
          const localCreatedAt = Date.parse(message.created_at || '') || 0;
          const isRecentLocal = localCreatedAt > 0 && Date.now() - localCreatedAt <= 120000;
          if (!isRecentLocal) return false;
          const localFbId = String(message.fb_message_id || '');
          const incomingFbId = String(newMsg.fb_message_id || '');
          if (incomingFbId.startsWith('mid.') && localFbId.startsWith('mid.') && incomingFbId !== localFbId) return false;
          const existingIsMedia = !!(message.attachment_id || message.media_url || (message.media_type && message.media_type !== 'text'));
          const incomingMediaType = String(newMsg.media_type || '').toLowerCase();
          const existingMediaType = String(message.media_type || '').toLowerCase();
          const sameAttachment = Boolean(newMsg.attachment_id && message.attachment_id)
            ? String(newMsg.attachment_id) === String(message.attachment_id)
            : true;
          const sameMediaType = !incomingMediaType || !existingMediaType || incomingMediaType === existingMediaType;
          // Text can be intentionally sent twice. Only a still-pending local
          // bubble may absorb its own DOM confirmation; a sent text is final.
          const localDelivery = String(message.delivery_status || message.status || '').toLowerCase();
          const awaitingTextConfirmation = ['pending', 'sending', 'queued', 'awaiting_confirmation'].includes(localDelivery);
          return newIsMedia
            ? existingIsMedia && sameAttachment && sameMediaType
            : awaitingTextConfirmation && !existingIsMedia && String(message.content || '') === String(newMsg.content || '');
        });
        if (newMsg.client_message_id) {
          // Feature 021: a Page send's local optimistic bubble is created
          // with the CRM's own id, but the server necessarily broadcasts a
          // different 'queue_'-derived id for it (background.js echoes that
          // exact id back for DOM/network correlation, so the server can't
          // just reuse the CRM's id there). original_client_message_id lets
          // us find that local bubble by its original id and reconcile it to
          // the server's id, instead of rendering a second, orphaned bubble.
          const existsIdx = currentMsgs.findIndex(m =>
            m.client_message_id === newMsg.client_message_id ||
            (newMsg.original_client_message_id && m.client_message_id === newMsg.original_client_message_id)
          );
          if (existsIdx >= 0) {
            updated = [...currentMsgs];
            updated[existsIdx] = {
              ...currentMsgs[existsIdx],
              ...newMsg,
              local_media_path: newMsg.local_media_path || currentMsgs[existsIdx].local_media_path,
              media_url: newMsg.media_url || currentMsgs[existsIdx].media_url,
              media_type: newMsg.media_type || currentMsgs[existsIdx].media_type,
              client_message_id: newMsg.client_message_id,
              ui_render_key: currentMsgs[existsIdx]?.ui_render_key,
              ui_position_locked: currentMsgs[existsIdx]?.ui_position_locked,
              order_anchor_ms: currentMsgs[existsIdx]?.order_anchor_ms,
              sequence_order: currentMsgs[existsIdx]?.sequence_order ?? newMsg.sequence_order,
              status: newMsg.status || newMsg.delivery_status || 'sent'
            };
          } else if (optimisticIdx >= 0) {
            updated = [...currentMsgs];
            updated[optimisticIdx] = {
              ...currentMsgs[optimisticIdx],
              ...newMsg,
              ui_render_key: currentMsgs[optimisticIdx]?.ui_render_key,
              ui_position_locked: currentMsgs[optimisticIdx]?.ui_position_locked,
              order_anchor_ms: currentMsgs[optimisticIdx]?.order_anchor_ms,
              sequence_order: currentMsgs[optimisticIdx]?.sequence_order ?? newMsg.sequence_order,
              status: newMsg.status || newMsg.delivery_status || 'sent'
            };
          } else {
            updated = mergeMessagesWithoutReordering(currentMsgs, [{ ...newMsg,
              status: newMsg.status || newMsg.delivery_status || 'sent' }]);
          }
        } else {
          const existsIdx = currentMsgs.findIndex((message) => (
            (newMsg.fb_message_id && message.fb_message_id === newMsg.fb_message_id) ||
            (newMsg.id != null && message.id === newMsg.id) ||
            (!newMsg.is_outgoing && !message.is_outgoing &&
              (String(message.fb_message_id || '').startsWith('sidebar_preview_') || newMsg.provisional_incoming) &&
              String(message.content || '') === String(newMsg.content || ''))
          ));
          const mergeIdx = existsIdx >= 0 ? existsIdx : optimisticIdx;
          if (mergeIdx >= 0) {
            updated = [...currentMsgs];
            updated[mergeIdx] = {
              ...currentMsgs[mergeIdx],
              ...newMsg,
              ui_render_key: currentMsgs[mergeIdx]?.ui_render_key,
              ui_position_locked: currentMsgs[mergeIdx]?.ui_position_locked,
              order_anchor_ms: currentMsgs[mergeIdx]?.order_anchor_ms,
              sequence_order: currentMsgs[mergeIdx]?.sequence_order ?? newMsg.sequence_order,
              status: newMsg.status || newMsg.delivery_status || 'sent'
            };
          } else {
            updated = mergeMessagesWithoutReordering(currentMsgs, [{ ...newMsg,
              status: newMsg.status || newMsg.delivery_status || 'sent' }]);
          }
        }
        
        // Database insertion order is the canonical chat sequence. Direction
        // is stored separately in is_outgoing (0 = customer, 1 = operator),
        // so timestamps are display metadata only and never move a bubble.
        // NEW_MESSAGE is an arrival event. Never sort the whole live list:
        // append the new text, or patch its existing bubble in place.
        updated = reconcileOutgoingTextEchoes(updated);

        return { ...prev, [tidStr]: updated };
      });

      setThreads(prev => {
        const msgAccStr = String(newMsg.account_id || '');
        const msgThreadKey = newMsg.thread_key || (msgAccStr ? `${msgAccStr}:${tidStr}` : null);
        const idx = prev.findIndex(t => {
          if (msgThreadKey && String(t.thread_key || '') === String(msgThreadKey)) return true;
          return String(t.id) === tidStr && (!msgAccStr || String(t.account_id || '') === msgAccStr);
        });
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...(['source_id','source_type','source_name','source_status'].reduce((acc, key) => (newMsg[key] ? { ...acc, [key]: newMsg[key] } : acc), {})), thread_key: msgThreadKey || updated[idx].thread_key, last_message: newMsg.content, last_activity: newMsg.created_at || new Date().toISOString(), is_unread: true };
          return sortThreadsByActivity(updated);
        }
        const summary = newMsg.thread_summary;
        if (summary?.id) {
          return sortThreadsByActivity([{
            ...summary,
            id: String(summary.id),
            thread_key: newMsg.thread_key || (summary.account_id ? `${summary.account_id}:${summary.id}` : String(summary.id)),
            last_message: newMsg.content ?? summary.last_message,
            last_activity: newMsg.created_at || summary.last_activity || new Date().toISOString(),
            is_unread: !newMsg.is_outgoing
          }, ...prev]);
        }
        return prev;
      });
      // Existing rows are patched synchronously above. Only fetch the complete
      // list when a legacy event lacks the new summary payload.
      if (!newMsg.thread_summary?.id) loadThreadsRef.current();

      // Media URLs are already included in NEW_MESSAGE/THREAD_MESSAGES_UPDATED.
      // Do not replace the live state with a delayed REST response: that response
      // can race a later socket event and make a freshly-arrived message disappear.
    });

    socket.on('MESSAGE_SENT', ({ thread_id, client_message_id, fb_message_id, provisional = false }) => {
      const tidStr = String(thread_id);
      setMessages(prev => {
        const currentMsgs = prev[tidStr] || [];
        return {
          ...prev,
          [tidStr]: currentMsgs.map(m => m.client_message_id === client_message_id ? { ...m, status: 'sent', delivery_status: 'sent', fb_message_id: fb_message_id || m.fb_message_id, error: null } : m)
        };
      });
      // Keep the optimistic sent state while Facebook's late DOM confirmation
      // attaches the official id. An immediate refetch would restore pending.
      // Auto-refetch even after a provisional composer acknowledgement. A
      // burst of sends can make Socket.IO coalesce/miss one UI event, while
      // the durable database already contains every message.
      setTimeout(() => {
        fetch(`/api/threads/${tidStr}/messages`)
          .then(r => r.json())
          .then(data => {
            if (Array.isArray(data)) {
              setMessages(prev => ({
                ...prev,
                [tidStr]: reconcileOutgoingTextEchoes(mergeMessagesWithoutReordering(prev[tidStr] || [], preserveOrderAnchors(data, prev[tidStr] || [])))
              }));
            }
          })
          .catch(() => {});
      }, provisional ? 700 : 300);
    });

    socket.on('THREAD_INBOX_FOLDER_CHANGED', ({ thread_id, inbox_folder }) => {
      const tidStr = String(thread_id);
      setThreads((previous) => previous.map((thread) => (
        String(thread.id) === tidStr ? { ...thread, inbox_folder } : thread
      )));
      loadThreadsRef.current();
      loadWaitingCount();
    });

    socket.on('MESSAGE_REQUEST_REMOVED', ({ thread_id }) => {
      const tidStr = String(thread_id);
      setThreads((previous) => previous.filter((thread) => String(thread.id) !== tidStr));
      setActiveThreadId((previous) => String(previous || '') === tidStr ? null : previous);
      loadThreadsRef.current();
      loadWaitingCount();
    });

    socket.on('MESSAGE_SEND_FAILED', ({ thread_id, client_message_id, error }) => {
      const tidStr = String(thread_id);
      setMessages(prev => {
        const currentMsgs = prev[tidStr] || [];
        return {
          ...prev,
          [tidStr]: currentMsgs.flatMap((message) => {
            if (message.client_message_id !== client_message_id) return [message];
            if (['sent', 'delivered', 'read'].includes(String(message.delivery_status || message.status).toLowerCase())) return [message];
            const isAttachment = Boolean(message.attachment_id || message.attachment
              || message.media_url || message.local_media_path
              || (message.media_type && message.media_type !== 'text'));
            // The CRM owns an attachment bubble once the user submits it.
            // A transport failure must never erase that bubble from history.
            return [{
              ...message,
              status: 'failed',
              delivery_status: 'failed',
              error: typeof error === 'object' ? error : { message: error || (isAttachment ? 'KhÃ´ng gá»­i Ä‘Æ°á»£c áº£nh.' : 'KhÃ´ng gá»­i Ä‘Æ°á»£c tin nháº¯n.') }
            }];
          })
        };
      });
    });


    socket.on('INCOMING_CALL_RINGING', (callData) => {
      console.log('[Socket.io] ðŸ”” INCOMING_CALL_RINGING:', callData);
      setIncomingCallInfo(callData);
    });

    socket.on('INCOMING_CALL_ENDED', (callData) => {
      console.log('[Socket.io] ðŸ“´ INCOMING_CALL_ENDED:', callData);
      setIncomingCallInfo(null);
    });

    socket.on('MESSAGE_SEND_ACCEPTED', (accepted) => {
      const tidStr = String(accepted.thread_id);
      setMessages((prev) => ({
        ...prev,
        [tidStr]: (prev[tidStr] || []).map((message) => (
          message.client_message_id === accepted.client_message_id
            ? {
                ...message,
                id: accepted.message_id,
                attempt_id: accepted.attempt_id,
                latest_attempt_id: accepted.attempt_id,
                queue_id: accepted.queue_id,
                status: ['sent', 'delivered', 'read'].includes(String(message.delivery_status || message.status || '').toLowerCase()) ? (message.status || message.delivery_status) : accepted.status,
                delivery_status: ['sent', 'delivered', 'read'].includes(String(message.delivery_status || message.status || '').toLowerCase()) ? (message.delivery_status || message.status) : 'pending',
                attachment: accepted.attachment || message.attachment
              }
            : message
        ))
      }));
    });

    socket.on('MESSAGE_SEND_STATUS', (statusEvent) => {
      const tidStr = String(statusEvent.thread_id);
      setMessages((prev) => ({
        ...prev,
        [tidStr]: (prev[tidStr] || []).map((message) => {
          const matches = message.client_message_id === statusEvent.client_message_id ||
            (statusEvent.message_id && Number(message.id) === Number(statusEvent.message_id));
          if (!matches) return message;
          const currentStatus = String(message.delivery_status || message.status || '').toLowerCase();
          const incomingStatus = String(statusEvent.status || '').toLowerCase();
          if (['sent', 'delivered', 'read'].includes(currentStatus)
            && !['sent', 'delivered', 'read'].includes(incomingStatus)) {
            return {
              ...message,
              attempt_id: statusEvent.attempt_id || message.attempt_id,
              latest_attempt_id: statusEvent.attempt_id || message.latest_attempt_id,
              fb_message_id: statusEvent.fb_message_id || message.fb_message_id
            };
          }
          if (statusEvent.status === 'failed' && ['sent', 'delivered', 'read'].includes(currentStatus)) {
            return message;
          }
          return statusEvent.status === 'failed' ? {
            ...message,
            status: 'failed',
            delivery_status: 'failed',
            error: statusEvent.error || { message: 'KhÃ´ng gá»­i Ä‘Æ°á»£c áº£nh.' }
          } : {
            ...message,
            attempt_id: statusEvent.attempt_id || message.attempt_id,
            latest_attempt_id: statusEvent.attempt_id || message.latest_attempt_id,
            status: statusEvent.status,
            delivery_status: statusEvent.status === 'sent' ? 'sent' : 'pending',
            fb_message_id: statusEvent.fb_message_id || message.fb_message_id,
            error: statusEvent.error || null
          };
        })
      }));
    });
    socket.on('SEND_ERROR', ({ client_message_id, error, code, message_id }) => {
      if (!client_message_id && !message_id) return;
      setMessages((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((threadId) => {
          next[threadId] = next[threadId].map((message) => {
            const matches = (client_message_id && message.client_message_id === client_message_id) || (message_id && Number(message.id) === Number(message_id));
            if (!matches || ['sent', 'delivered', 'read'].includes(String(message.delivery_status || message.status).toLowerCase())) return message;
            return { ...message, status: 'failed', delivery_status: 'failed', error: { code: code || 'SEND_ERROR', message: error || 'KhÃ´ng gá»­i Ä‘Æ°á»£c tin nháº¯n.' } };
          });
        });
        return next;
      });
    });

    socket.on('THREAD_MESSAGES_UPDATED', ({ thread_id, thread_key, account_id, messages: syncedMsgs, authoritative = false }) => {
      const tidStr = String(thread_id);
      if (historySyncTimeoutRef.current) {
        clearTimeout(historySyncTimeoutRef.current);
        historySyncTimeoutRef.current = null;
      }
      setHistorySyncingThreadId((current) => String(current || '') === tidStr ? null : current);
      setMessages(prev => {
        const existing = prev[tidStr] || [];
        const mergedMap = new Map();
        const reconciledOptimisticClients = new Set();

        const messageKey = (message) => {
          if (message.fb_message_id) return `fb_${message.fb_message_id}`;
          if (message.client_message_id) return `client_${message.client_message_id}`;
          if (message.id != null) return `id_${message.id}`;
          return `fallback_${message.timestamp_ms || message.created_at || 0}_${message.is_outgoing ? 1 : 0}_${message.content || ''}`;
        };

        // Náº¡p tin nháº¯n vá»«a sync
        (syncedMsgs || []).forEach(m => {
          let key = messageKey(m);
          let reconciledMessage = m;

          // Messenger and the optimistic CRM image have different ids/URLs.
          // Fold the official observation into the recent pending bubble.
          if (m.is_outgoing) {
            const syncedIsMedia = !!(m.attachment_id || m.media_url || (m.media_type && m.media_type !== 'text'));
            const syncedAt = Number(m.timestamp_ms) || Date.parse(m.created_at || '') || 0;
            const optimistic = existing
              .filter((candidate) => {
              if (!candidate.is_outgoing || !candidate.client_message_id) return false;
              const candidatePending = candidate.status === 'sending' || candidate.delivery_status === 'pending' || String(candidate.fb_message_id || '').startsWith('pending_');
              const candidateUsesTemporaryId = !String(candidate.fb_message_id || '').startsWith('mid.');
              // Composer dispatch can mark the durable CRM attachment as sent
              // before Facebook exposes its permanent mid.$ id. It is still
              // the same optimistic bubble and must be eligible for folding.
              if (!candidatePending && !candidateUsesTemporaryId) return false;
              if (reconciledOptimisticClients.has(String(candidate.client_message_id))) return false;
              const candidateIsMedia = !!(candidate.attachment_id || candidate.media_url || candidate.local_media_path || (candidate.media_type && candidate.media_type !== 'text'));
              if (candidateIsMedia !== syncedIsMedia) return false;
              const candidateAt = Number(candidate.timestamp_ms) || Date.parse(candidate.created_at || '') || 0;
              if (syncedAt && candidateAt && Math.abs(syncedAt - candidateAt) > 120000) return false;
              return syncedIsMedia || String(candidate.content || '') === String(m.content || '');
              })
              .sort((left, right) => {
                const leftAt = Number(left.timestamp_ms) || Date.parse(left.created_at || '') || 0;
                const rightAt = Number(right.timestamp_ms) || Date.parse(right.created_at || '') || 0;
                return Math.abs(syncedAt - leftAt) - Math.abs(syncedAt - rightAt);
              })[0];
            if (optimistic) {
              key = `client_${optimistic.client_message_id}`;
              reconciledOptimisticClients.add(String(optimistic.client_message_id));
              reconciledMessage = {
                ...optimistic,
                ...m,
                client_message_id: optimistic.client_message_id,
                local_media_path: m.local_media_path || optimistic.local_media_path,
                media_url: m.media_url || optimistic.media_url,
                // An authoritative history snapshot owns the final Messenger
                // DOM position. Live confirmations still keep the optimistic
                // bubble stationary until that canonical snapshot arrives.
                sequence_order: authoritative ? m.sequence_order : (optimistic.sequence_order ?? m.sequence_order),
                timestamp_ms: authoritative ? m.timestamp_ms : (optimistic.timestamp_ms || m.timestamp_ms),
                created_at: authoritative ? m.created_at : (optimistic.created_at || m.created_at),
                order_anchor_ms: optimistic.order_anchor_ms,
                delivery_status: 'sent',
                status: 'sent'
              };
            }
          }
          mergedMap.set(key, { ...reconciledMessage, thread_key: m.thread_key || thread_key, account_id: m.account_id || account_id, status: 'sent' });
        });

        // Giá»¯ láº¡i cÃ¡c tin nháº¯n pending/failed/realtime chÆ°a cÃ³ trong báº£n sync
        existing.forEach(m => {
          const key = messageKey(m);
          const keepOptimistic = m.status === 'sending' || m.status === 'failed' || m.delivery_status === 'pending';
          if (!mergedMap.has(key) && (!authoritative || keepOptimistic)) {
            mergedMap.set(key, m);
          } else if ((m.status === 'sending' || m.status === 'failed') && !reconciledOptimisticClients.has(String(m.client_message_id || ''))) {
            const durable = mergedMap.get(key);
            const durableStatus = String(durable?.delivery_status || durable?.status || '').toLowerCase();
            if (!['sent', 'delivered', 'read'].includes(durableStatus)) {
              mergedMap.set(key, { ...durable, status: m.status, error: m.error });
            }
          }
        });

        const authoritativeSnapshot = reconcileOutgoingTextEchoes(Array.from(mergedMap.values()));
        // A user-requested older-history page is an authoritative DB snapshot.
        // The append-only merge below intentionally rejects rows older than the
        // visible tail to protect realtime replay, but that also hid every
        // valid historical message just fetched after CRM was scrolled up.
        // Render this complete snapshot in its durable server sequence instead.
        const mergedArray = authoritative
          ? sortMessagesChronologically(preserveOrderAnchors(authoritativeSnapshot, existing))
          : mergeMessagesWithoutReordering(existing, authoritativeSnapshot);

        return {
          ...prev,
          [tidStr]: mergedArray
        };
      });
    });

    socket.on('BULK_HISTORY_SYNC_PROGRESS', (progress) => {
      setBulkHistoryProgress(progress);
      if (progress?.status === 'completed') {
        loadThreadsRef.current();
        if (activeThreadId) {
          const threadId = String(activeThreadId);
          fetch(`/api/threads/${threadId}/messages`)
            .then((response) => response.json())
            .then((data) => {
              if (Array.isArray(data)) setMessages((previous) => ({ ...previous, [threadId]: reconcileOutgoingTextEchoes(mergeMessagesWithoutReordering(previous[threadId] || [], preserveOrderAnchors(data, previous[threadId] || []))) }));
            })
            .catch(() => {});
        }
      }
    });

    socket.on('EXTENSION_CONNECTION_CHANGED', ({ account_id, is_connected }) => {
      setAccounts(prev => prev.map(a => String(a.id) === String(account_id) ? { ...a, is_extension_connected: is_connected } : a));
      if (!is_connected) return;
      loadThreadsRef.current();
      setTimeout(() => {
        const currentThreadId = activeThreadIdRef.current;
        if (!currentThreadId) return;
        const currentThread = threadsRef.current.find((thread) => String(thread.id) === String(currentThreadId));
        if (currentThread && String(currentThread.account_id || '') !== String(account_id || '')) return;
        fetch(`/api/threads/${encodeURIComponent(String(currentThreadId))}/messages`)
          .then((response) => response.json())
          .then((data) => {
            if (!Array.isArray(data)) return;
            setMessages((previous) => ({ ...previous, [String(currentThreadId)]: reconcileOutgoingTextEchoes(mergeMessagesWithoutReordering(previous[String(currentThreadId)] || [], preserveOrderAnchors(data, previous[String(currentThreadId)] || []))) }));
          })
          .catch(() => {});
      }, 750);
    });

    socket.on('CONTACT_UPDATED', (contactUpdate = {}) => {
      const { thread_id, avatar_url, name, nickname, phone, email, status_id, status_name, status_color, phone_source, phone_captured_at } = contactUpdate;
      if (thread_id == null) return;
      const tidStr = String(thread_id);
      const contactPatch = {
        ...(avatar_url ? { avatar_url } : {}),
        ...(name ? { name } : {}),
        ...(nickname !== undefined ? { nickname } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        ...(status_id !== undefined ? { status_id, status_name: status_name || null, status_color: status_color || null } : {}),
        ...(phone_source !== undefined ? { phone_source } : {}),
        ...(phone_captured_at !== undefined ? { phone_captured_at } : {})
      };
      setThreads(prev => prev.map(t => String(t.id) === tidStr ? {
        ...t,
        ...(avatar_url ? { avatar_url } : {}),
        ...(name ? { contact_name: name } : {}),
        ...(nickname !== undefined ? { nickname } : {}),
        ...(status_id !== undefined ? { status_id, status_name: status_name || null, status_color: status_color || null } : {})
      } : t));
      setContacts(prev => ({
        ...prev,
        [tidStr]: { ...prev[tidStr], thread_id: tidStr, ...contactPatch }
      }));
    });

    // spec 035: merges the server's fully-resolved phone/provenance/candidate
    // view directly, regardless of which thread is currently active - keeps
    // the background cache correct for whenever the operator switches to it,
    // and never overwrites a manual/legacy value since the server itself
    // already refused to change `phone` in that case.
    socket.on('PHONE_CAPTURED', ({ thread_id, phone, phone_source, phone_captured_at, phone_capture, phone_candidates }) => {
      const tidStr = String(thread_id);
      setContacts(prev => ({
        ...prev,
        [tidStr]: {
          ...prev[tidStr],
          thread_id: tidStr,
          phone,
          phone_source,
          phone_captured_at,
          phone_capture,
          phone_candidates
        }
      }));
    });

    socket.on('MESSAGE_UNSENT', ({ fb_message_id }) => {
      setMessages(prev => {
        const updated = {};
        Object.entries(prev).forEach(([tid, msgs]) => {
          updated[tid] = msgs.map(m => m.fb_message_id === fb_message_id ? { ...m, is_unsent: true } : m);
        });
        return updated;
      });
    });

    socket.on('ACCOUNT_STATUS_CHANGED', ({ status }) => {
      if (status === 'CHECKPOINT') setHasCheckpoint(true);
      loadAccounts();
    });

    socket.on('ACCOUNT_REMOVED', ({ account_id }) => {
      const removedAccountId = String(account_id || '');
      const removedThreadIds = new Set(
        threadsRef.current
          .filter((thread) => String(thread.account_id || '') === removedAccountId)
          .map((thread) => String(thread.id))
      );
      setAccounts((previous) => {
        const nextAccounts = previous.filter((account) => String(account.id) !== removedAccountId);
        accountsRef.current = nextAccounts;
        return nextAccounts;
      });
      setThreads((previous) => previous.filter((thread) => String(thread.account_id || '') !== removedAccountId));
      setMessages((previous) => Object.fromEntries(
        Object.entries(previous).filter(([threadId]) => !removedThreadIds.has(String(threadId)))
      ));
      setActiveThreadId((previous) => removedThreadIds.has(String(previous || '')) ? null : previous);
      loadThreadsRef.current();
      loadWaitingCount();
    });

    socket.on('FACEBOOK_SYNC_STARTED', ({ account_id, tab_count }) => {
      if (String(requestedFacebookSyncRef.current || '') !== String(account_id || '')) return;
      setAccountSyncing({ accountId: String(account_id), tabCount: Math.max(0, Number(tab_count) || 0) });
    });

    socket.on('AI_PAUSED', ({ thread_id, until }) => {
      const tidStr = String(thread_id);
      setThreads(prev => prev.map(t => String(t.id) === tidStr ? { ...t, ai_paused_until: until } : t));
    });
    socket.on('THREAD_ASSIGNED', () => loadThreadsRef.current());
    socket.on('THREAD_COMPLETED', () => loadThreadsRef.current());
    socket.on('INBOX_SOURCE_ADDED', () => { loadInboxSources(); loadThreadsRef.current(); });
    socket.on('INBOX_SOURCE_REMOVED', () => { loadInboxSources(); loadThreadsRef.current(); });
    socket.on('INBOX_SOURCE_STATUS_CHANGED', () => { loadInboxSources(); loadThreadsRef.current(); });

    const handleCampaignEvent = (event) => {
      if (activeCampaignId && String(event?.campaign_id) === String(activeCampaignId)) setCampaignRefreshVersion((version) => version + 1);
    };
    socket.on('CAMPAIGN_UPDATED', handleCampaignEvent);
    socket.on('CAMPAIGN_RECIPIENT_UPDATED', handleCampaignEvent);
    socket.on('CAMPAIGN_AUDIT_EVENT', handleCampaignEvent);
    socket.on('THREADS_SYNCED', ({ account_id, threads: syncedThreads }) => {
      if (!syncedThreads || !Array.isArray(syncedThreads)) return;
      if (String(requestedFacebookSyncRef.current || '') === String(account_id || '')) {
        requestedFacebookSyncRef.current = null;
        setAccountSyncing(null);
      }
      if (!accountsRef.current.some((account) => String(account.id) === String(account_id))) return;
      loadWaitingCount();
      setThreads(prev => {
        const waitingTabActive = activeTabRef.current === 'WAITING';
        const belongsToCurrentTab = (thread) => {
          const isRequest = ['MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE']
            .includes(String(thread?.inbox_folder || 'INBOX'));
          return waitingTabActive ? isRequest : !isRequest;
        };
        const relevantSyncedThreads = syncedThreads.filter(belongsToCurrentTab);
        const currentTabThreads = prev.filter(belongsToCurrentTab);
        if (relevantSyncedThreads.length === 0) {
          return currentTabThreads.length === prev.length ? prev : currentTabThreads;
        }
        const accIdStr = String(account_id || '');
        const updatedThreads = [...currentTabThreads];

        for (const synced of relevantSyncedThreads) {
          const syncedIdStr = String(synced.id || synced.thread_id || '');
          const syncedAccStr = String(synced.account_id || account_id || '');

          const idx = updatedThreads.findIndex(t => 
            String(t.id || t.thread_id || '') === syncedIdStr && String(t.account_id || accIdStr) === syncedAccStr
          );

          if (idx >= 0) {
            updatedThreads[idx] = {
              ...updatedThreads[idx],
              ...synced,
              thread_key: synced.thread_key || updatedThreads[idx].thread_key || (syncedAccStr ? `${syncedAccStr}:${syncedIdStr}` : syncedIdStr),
              contact_name: synced.contact_name || synced.name || updatedThreads[idx].contact_name,
              avatar_url: synced.avatar_url || updatedThreads[idx].avatar_url,
              phone: synced.phone || updatedThreads[idx].phone,
              email: synced.email || updatedThreads[idx].email
            };
          } else {
            updatedThreads.push({
              ...synced,
              thread_key: synced.thread_key || (syncedAccStr || accIdStr ? `${syncedAccStr || accIdStr}:${syncedIdStr}` : syncedIdStr),
              account_id: syncedAccStr || accIdStr
            });
          }
        }

        return sortThreadsByActivity(updatedThreads);
      });
    });

    return () => {
      socket.off('NEW_MESSAGE');
      socket.off('MESSAGE_SENT');
      socket.off('THREAD_INBOX_FOLDER_CHANGED');
      socket.off('MESSAGE_REQUEST_REMOVED');
      socket.off('MESSAGE_SEND_FAILED');
      socket.off('MESSAGE_SEND_ACCEPTED');
      socket.off('MESSAGE_SEND_STATUS');
      socket.off('SEND_ERROR');
      socket.off('THREAD_MESSAGES_UPDATED');
      socket.off('BULK_HISTORY_SYNC_PROGRESS');
      socket.off('EXTENSION_CONNECTION_CHANGED');
      socket.off('MESSAGE_UNSENT');
      socket.off('ACCOUNT_STATUS_CHANGED');
      socket.off('ACCOUNT_REMOVED');
      socket.off('FACEBOOK_SYNC_STARTED');
      socket.off('AI_PAUSED');
      socket.off('THREAD_ASSIGNED');
      socket.off('THREAD_COMPLETED');
      socket.off('THREADS_SYNCED');
      socket.off('INBOX_SOURCE_ADDED');
      socket.off('INBOX_SOURCE_REMOVED');
      socket.off('INBOX_SOURCE_STATUS_CHANGED');
      socket.off('CAMPAIGN_UPDATED', handleCampaignEvent);
      socket.off('CAMPAIGN_RECIPIENT_UPDATED', handleCampaignEvent);
      socket.off('CAMPAIGN_AUDIT_EVENT', handleCampaignEvent);
    };
  }, [socket, loadAccounts, loadInboxSources, loadWaitingCount, activeCampaignId]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setActiveModal('search'); }
      if (e.key === 'Escape') { setActiveModal(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleStageAttachment = useCallback(async (file) => {
    if (!activeThreadId) throw new Error('ChÆ°a chá»n há»™i thoáº¡i.');
    const threadId = String(activeThreadId);
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('client_upload_id', 'upload_' + Date.now());

    const response = await fetch(
      '/api/threads/' + encodeURIComponent(threadId) + '/outbound-attachments',
      { method: 'POST', body: formData }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'KhÃ´ng táº£i Ä‘Æ°á»£c file Ä‘Ã­nh kÃ¨m.');
      error.code = data.code;
      throw error;
    }
    return data.attachment;
  }, [activeThreadId]);

  const handleDiscardAttachment = useCallback(async (attachmentId) => {
    if (!activeThreadId) throw new Error('ChÆ°a chá»n há»™i thoáº¡i.');
    const response = await fetch(
      '/api/threads/' + encodeURIComponent(String(activeThreadId)) +
        '/outbound-attachments/' + encodeURIComponent(attachmentId),
      { method: 'DELETE' }
    );
    if (response.status === 204) return;
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || 'KhÃ´ng gá»¡ Ä‘Æ°á»£c file Ä‘Ã­nh kÃ¨m.');
    error.code = data.code;
    throw error;
  }, [activeThreadId]);

  const handleSendMessage = async (payloadOrText, legacyClientMessageId = null) => {
    if (!activeThreadId) return;
    const threadIdStr = String(activeThreadId);
    const payload = typeof payloadOrText === 'string'
      ? {
          contract_version: 2,
          content: payloadOrText,
          client_message_id: legacyClientMessageId ||
            ('client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
          attachment_id: null
        }
      : {
          contract_version: 2,
          content: payloadOrText?.content || '',
          client_message_id: payloadOrText?.client_message_id,
          attachment_id: payloadOrText?.attachment_id || null,
          attachment: payloadOrText?.attachment || null
        };
    if (!payload.client_message_id) throw new Error('Thiáº¿u mÃ£ tin nháº¯n phÃ­a CRM.');
    const hasAttachment = Boolean(payload.attachment_id || payload.attachment?.media_type || payload.attachment?.preview_url);
    // Preserve caption/text when attachment is present
    const outboundContent = String(payload.content || '').trim();
    // Do not create a phantom CRM bubble for an empty transport event.
    // Real video/image sends always carry an attachment identity.
    if (!outboundContent && !hasAttachment) return;

    const newMsg = {
      client_message_id: payload.client_message_id,
      content: outboundContent,
      attachment_id: payload.attachment_id,
      attachment: payload.attachment,
      media_type: payload.attachment?.media_type || 'text',
      media_url: payload.attachment?.preview_url || null,
      media_name: payload.attachment?.safe_name || payload.attachment?.original_name || null,
      media_mime_type: payload.attachment?.mime_type || null,
      media_size: payload.attachment?.byte_size || null,
      is_outgoing: true,
      direction_status: 'confirmed',
      // Attachment transport runs independently in the extension. This key
      // and lock belong only to the CRM view and are never replaced by queue,
      // database or Messenger confirmation identifiers.
      ui_render_key: `crm_${payload.client_message_id}`,
      ui_position_locked: Boolean(payload.attachment_id || payload.attachment),
      // Stable UI position assigned before the upload starts.
      order_anchor_ms: Date.now(),
      created_at: new Date().toISOString(),
      status: 'sending',
      delivery_status: 'pending'
    };

    setMessages((prev) => ({
      ...prev,
      // Reconcile after optimistic append: history can insert an incoming echo just before CRM adds its outgoing bubble.
      [threadIdStr]: reconcileOutgoingTextEchoes([...(prev[threadIdStr] || []), newMsg])
    }));

    // Socket.IO buffers outbound events during a short reconnect. The
    // extension worker is deliberately refreshed after desktop startup, and
    // treating that small window as a hard failure drops the operator text
    // before it ever reaches the backend. Emit whenever the socket instance
    // exists and let its reconnect queue preserve the message.
    if (socket) {
      socket.emit('SEND_MESSAGE', {
        // Plain text uses the low-latency direct Messenger path. Rich-message
        // queueing is reserved for attachments, which need integrity tracking.
        contract_version: payload.attachment_id || payload.attachment ? 2 : 1,
        thread_id: threadIdStr,
        client_message_id: payload.client_message_id,
        content: outboundContent,
        attachment_id: payload.attachment_id
      });
      return;
    }

    setMessages((prev) => ({
      ...prev,
      [threadIdStr]: (prev[threadIdStr] || []).map((message) => (
        message.client_message_id === payload.client_message_id
          ? {
              ...message,
              status: 'failed',
              delivery_status: 'failed',
              error: { code: 'SOCKET_DISCONNECTED', message: 'CRM chÆ°a káº¿t ná»‘i backend.' }
            }
          : message
      ))
    }));
  };

  const handleRetryMessage = (msg) => {
    if (!msg) return;
    if (msg.attachment_id && socket) {
      socket.emit('RETRY_MESSAGE', { thread_id: String(activeThreadId), message_id: msg.id, expected_latest_attempt_id: msg.latest_attempt_id || msg.attempt_id || null });
      return;
    }
    if (msg.content) handleSendMessage(msg.content, 'retry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  };

  const handleAssignStaff = async (threadId) => {
    const threadIdStr = String(threadId);
    try {
      await fetch(`/api/threads/${threadIdStr}/assign`, { method: 'POST' });
      setThreads(prev => prev.map(t => String(t.id) === threadIdStr ? { ...t, status: 'ASSIGNED', assigned_user_id: sessionUser.id } : t));
    } catch (e) { console.error('Assign error:', e); }
  };

  const handleCompleteThread = async (threadId) => {
    const threadIdStr = String(threadId);
    await fetch(`/api/threads/${threadIdStr}/complete`, { method: 'POST' });
    setThreads(prev => prev.map(t => String(t.id) === threadIdStr ? { ...t, status: 'COMPLETED' } : t));
  };

  const handlePauseAi = async (threadId) => {
    const threadIdStr = String(threadId);
    const res = await fetch(`/api/threads/${threadIdStr}/ai/pause`, { method: 'POST' });
    const data = await res.json();
    setThreads(prev => prev.map(t => String(t.id) === threadIdStr ? { ...t, ai_paused_until: data.until } : t));
  };

  const handleResumeAi = async (threadId) => {
    const threadIdStr = String(threadId);
    await fetch(`/api/threads/${threadIdStr}/ai/resume`, { method: 'POST' });
    setThreads(prev => prev.map(t => String(t.id) === threadIdStr ? { ...t, ai_paused_until: null } : t));
  };

  const handleSetReminder = async (threadId, dueAt, note) => {
    const res = await fetch('/api/threads/' + encodeURIComponent(threadId) + '/reminder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ due_at: dueAt, note }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'KhÃ´ng thá»ƒ lÆ°u nháº¯c.');
    await loadThreads(); return data;
  };
  const handleCompleteReminder = async (threadId) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+'/reminder/complete',{method:'POST'}); const data=await res.json().catch(() => ({})); if(!res.ok) throw new Error(data.error || 'KhÃ´ng thá»ƒ hoÃ n thÃ nh nháº¯c.'); await loadThreads(); };
  const handleCancelReminder = async (threadId) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+'/reminder',{method:'DELETE'}); const data=await res.json().catch(() => ({})); if(!res.ok) throw new Error(data.error || 'KhÃ´ng thá»ƒ há»§y nháº¯c.'); await loadThreads(); };
  const handleArchiveThread = async (threadId, restore=false) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+(restore?'/restore':'/archive'),{method:'POST'}); if(!res.ok) throw new Error('KhÃ´ng thá»ƒ cáº­p nháº­t lÆ°u trá»¯.'); await loadThreads(); };

  const handleSaveContact = async (updatedContact) => {
    const contactThreadId = String(updatedContact.thread_id);
    const res = await fetch(`/api/contacts/${contactThreadId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedContact)
    });
    const responsePayload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(responsePayload?.error || `LÆ°u liÃªn há»‡ tháº¥t báº¡i (${res.status})`);
    }
    const persistedContact = { ...updatedContact, ...(responsePayload.contact || {}) };

    // Commit only server-confirmed provenance so choosing a candidate always
    // displays the original customer-message timestamp rather than detection time.
    contactRequestVersionRef.current.set(
      contactThreadId,
      (contactRequestVersionRef.current.get(contactThreadId) || 0) + 1
    );
    setContacts(prev => ({ ...prev, [contactThreadId]: persistedContact }));
    setThreads(prev => prev.map((thread) => String(thread.id) === contactThreadId
      ? { ...thread, nickname: persistedContact.nickname || null }
      : thread));
    const verifiedName = getVerifiedContactName(persistedContact);
    if (verifiedName) {
      setThreads(prev => prev.map((thread) => (
        String(thread.id) === contactThreadId && isPlaceholderContactName(thread.contact_name || thread.name)
          ? { ...thread, contact_name: verifiedName }
          : thread
      )));
    }
    if ('status_id' in persistedContact) {
      const matchedStatus = leadStatuses.find((s) => s.id === persistedContact.status_id) || null;
      setThreads(prev => prev.map(t => String(t.id) === contactThreadId
        ? { ...t, status_id: persistedContact.status_id ?? null, status_name: matchedStatus?.name ?? null, status_color: matchedStatus?.color ?? null }
        : t));
    }
  };

  const handleExportLeads = async (format = 'excel') => {
    const res = await fetch(`/api/leads/export/${format}`, { method: 'POST' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `leads.${format === 'excel' ? 'xlsx' : 'csv'}`; a.click();
    URL.revokeObjectURL(url);
  };

  const startCampaignSelection = () => {
    setActiveModal(null);
    setCampaignSelectionMode(true);
  };

  const cancelCampaignSelection = () => {
    setCampaignSelectionMode(false);
    setSelectedCampaignThreadIds([]);
  };

  const toggleCampaignThread = (threadId) => {
    setSelectedCampaignThreadIds((current) => (
      current.some((item) => String(item) === String(threadId))
        ? current.filter((item) => String(item) !== String(threadId))
        : [...current, threadId]
    ));
  };

  const openCampaign = (campaignId) => {
    setActiveCampaignId(campaignId);
    setActiveModal('campaignDetail');
  };

  const handleCampaignCreated = (campaign) => {
    cancelCampaignSelection();
    openCampaign(campaign.id);
  };

  const handleOpenModal = (modalName) => {
    setActiveModal(modalName);
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setSessionUser(null);
    setLicenseStatus(null);
    setThreads([]);
    setAccounts([]);
    setWaitingCount(0);
    setActiveThreadId(null);
  };

  const selectedCampaignThreads = threads.filter((thread) => (
    selectedCampaignThreadIds.some((threadId) => String(threadId) === String(thread.id))
  ));

  const selectedThreadFromList = activeThreadId ? (
    threads.find(t => String(t.id) === String(activeThreadId)) || threads.find(t => t.id === activeThreadId)
  ) : null;
  const selectedThreadContact = activeThreadId ? contacts[String(activeThreadId)] : null;
  // Contact data is the durable avatar source. A later sidebar/thread refresh
  // must never replace it with an empty value and make the UI fall back to L.
  const selectedThread = selectedThreadFromList ? {
    ...selectedThreadFromList,
    ...(selectedThreadContact?.avatar_url ? { avatar_url: selectedThreadContact.avatar_url } : {})
  } : null;
  const activeMessages = activeThreadId ? (messages[String(activeThreadId)] || []) : [];
  const currentAccount = selectedThread ? accounts.find(a => String(a.id) === String(selectedThread.account_id)) : null;
  const currentInboxSource = selectedThread ? inboxSources.find((source) => String(source.id) === String(selectedThread.source_id)) : null;
  const currentSenderIdentity = selectedThread ? {
    name: selectedThread.source_type === 'page_messenger'
      ? (selectedThread.source_name || currentInboxSource?.display_name || selectedThread.source_external_id || 'Facebook Page')
      : (currentAccount?.name || selectedThread.source_name || selectedThread.account_id || 'TÃ i khoáº£n Facebook'),
    id: selectedThread.source_type === 'page_messenger'
      ? (selectedThread.source_external_id || currentInboxSource?.external_id || selectedThread.source_id)
      : selectedThread.account_id,
    type: selectedThread.source_type || 'personal_messenger',
    avatar_url: selectedThread.source_type === 'page_messenger'
      ? (currentInboxSource?.avatar_url || null)
      : (currentAccount?.avatar_url || currentInboxSource?.avatar_url || null)
  } : null;
  const activeContact = activeThreadId && selectedThread ? {
    thread_id: String(activeThreadId),
    name: selectedThread.contact_name || selectedThread.name || 'KhÃ¡ch hÃ ng',
    nickname: selectedThread.nickname || null,
    avatar_url: selectedThread.avatar_url,
    status: selectedThread.status,
    account_id: selectedThread.account_id,
    account_name: currentAccount ? (currentAccount.name || currentAccount.id) : selectedThread.account_id,
    archived_at: selectedThread.archived_at,
    reminder_due_at: selectedThread.reminder_due_at,
    reminder_note: selectedThread.reminder_note,
    ...(contacts[String(activeThreadId)] || {})
  } : null;

  const isCurrentExtensionDisconnected = currentAccount ? currentAccount.is_extension_connected === false : false;
  const isCurrentSendDisabled = selectedThread?.source_type === 'page_messenger'
    ? selectedThread?.source_status && selectedThread.source_status !== 'ACTIVE'
    : isCurrentExtensionDisconnected;
  const currentSendDisabledReason = selectedThread?.source_type === 'page_messenger'
    ? 'Äang chá» Page Messenger sáºµn sÃ ng. Vui lÃ²ng Ä‘á»£i trong giÃ¢y lÃ¡t.'
    : 'TÃ i khoáº£n Facebook chÆ°a Ä‘Æ°á»£c káº¿t ná»‘i. Vui lÃ²ng vÃ o Quáº£n lÃ½ vÃ  báº¥m Káº¿t ná»‘i Facebook.';

  const gridClass = `${leadPanelCollapsed ? 'app-grid-collapsed' : 'app-grid'}${activeView === 'employees' ? ' employee-view' : ''}`;

  const handleStartCall = useCallback((callType = 'audio') => {
    if (!activeThreadId || !selectedThread) return;
    if (!socket || !isConnected) {
      alert('ChÆ°a káº¿t ná»‘i Ä‘áº¿n Server WebSocket!');
      return;
    }
    socket.emit('TRIGGER_CALL', {
      thread_id: selectedThread.id,
      account_id: selectedThread.account_id,
      call_type: callType,
      call_request_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    });
  }, [activeThreadId, selectedThread, socket, isConnected]);

  const handleBulkHistorySync = useCallback(() => {
    if (!socket || !isConnected || bulkHistoryProgress?.status === 'running') return;
    const personalThreads = threads.filter((thread) => thread.source_type !== 'page_messenger');
    const jobId = globalThis.crypto?.randomUUID?.() || `bulk_${Date.now()}`;
    setBulkHistoryProgress({ job_id: jobId, status: 'running', total: personalThreads.length, completed: 0, failed: 0 });
    socket.emit('REQUEST_BULK_HISTORY_SYNC', {
      job_id: jobId,
      threads: personalThreads.map((thread) => ({
        thread_id: String(thread.id),
        thread_url: thread.thread_url || null,
        contact_name: thread.contact_name || thread.name || null
      }))
    });
  }, [socket, isConnected, threads, bulkHistoryProgress?.status]);

  if (authLoading) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Äang kiá»ƒm tra phiÃªn Ä‘Äƒng nháº­p...</div>;
  }

  if (!sessionUser) {
    return <AuthScreen onAuthenticated={setSessionUser} />;
  }

  if (licenseStatus === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Äang kiá»ƒm tra báº£n quyá»n...</div>;
  }

  return (
    <div className={gridClass}>
      {/* Column 1: Sidebar Navigation - 48px */}
      <AppSidebar
        activeView={activeView}
        onSelectView={(viewId) => {
          setActiveModal(null);
          setActiveView(viewId);
        }}
        onOpenModal={setActiveModal}
        theme={theme} onToggleTheme={toggleTheme}
        hasCheckpoint={hasCheckpoint} collapsed={leadPanelCollapsed}
        onToggleCollapse={() => setLeadPanelCollapsed(!leadPanelCollapsed)}
        sessionUser={sessionUser} onLogout={handleLogout}
      />

      {activeView === 'employees' && <EmployeeManagementModal />}

      {/* Column 2: Conversation List */}
      <ConversationSidebar
        threads={threads} activeThreadId={activeThreadId}
        onSelectThread={(threadId) => {
          const clickedThread = threads.find((thread) => String(thread.id) === String(threadId));
          requestThreadNavigation(clickedThread);
        }}
        activeTab={activeTab} onTabChange={handleConversationTabChange}
        waitingCount={waitingCount}
        searchQuery={searchQuery} onSearchChange={setSearchQuery}
        isConnected={isConnected} onOpenSearch={() => setActiveModal('search')}
        sidebarSyncActive={sidebarSyncActive}
        sidebarSyncSecondsRemaining={sidebarSyncSecondsRemaining}
        onToggleSidebarSync={handleToggleSidebarSync}
        accounts={accounts}
        inboxSources={inboxSources}
        leadStatuses={leadStatuses}
        campaignSelectionMode={campaignSelectionMode}
        selectedCampaignThreadIds={selectedCampaignThreadIds}
        onToggleCampaignThread={toggleCampaignThread}
        onStartCampaignSelection={startCampaignSelection}
        onCancelCampaignSelection={cancelCampaignSelection}
        onCreateCampaign={() => setActiveModal('campaigns')}
        onBulkHistorySync={handleBulkHistorySync}
        bulkHistoryProgress={bulkHistoryProgress}
      />

      {/* Column 3: Chat Area */}
      <div className="chat-area bg-[var(--color-bg-app)] flex flex-col h-full">
        {activeThreadId && selectedThread ? (
          <div
            key={'chat-thread-' + String(activeThreadId)}
            className="chat-thread flex flex-col h-full flex-1 min-h-0 relative"
            data-active-thread-id={String(activeThreadId)}
          >
            <ChatHeader
              activeThread={selectedThread}
              accounts={accounts}
              inboxSources={inboxSources}
              onAssignStaff={handleAssignStaff} onCompleteThread={handleCompleteThread}
              onPauseAi={handlePauseAi} onResumeAi={handleResumeAi}
              onOpenSearch={() => setActiveModal('search')}
              onShowLeadPanel={() => setShowLeadDrawer(true)}
              onStartCall={handleStartCall}
              showBackButton={isMobile}
              onGoBack={() => { setActiveThreadId(null); }}
            />
            <MessageList
              // Reset scroll/debounce/in-flight state for every conversation.
              // Without a React key, a prior thread can leave its older-page
              // request locked and the next clicked user cannot mirror scroll.
              key={String(activeThreadId)}
              messages={activeMessages}
              activeThread={selectedThread}
              // Keep automatic first-open sync as the primary path, and expose
              // the existing manual retry control when Facebook confirms an
              // actually empty viewport.
              onSyncThread={() => requestThreadMessageSync(activeThreadId, 'initial')}
              onRetryMessage={handleRetryMessage}
              historySyncing={String(historySyncingThreadId || '') === String(activeThreadId)}
              onViewportScroll={(scrollDelta) => {
                requestThreadMessageSync(
                  activeThreadId,
                  Number(scrollDelta) < 0 ? 'older' : 'viewport',
                  scrollDelta
                );
              }}
            />
            {['MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(selectedThread.inbox_folder) ? (
              <MessageRequestActions
                key={String(activeThreadId)}
                thread={selectedThread}
                socket={socket}
                isConnected={isConnected}
              />
            ) : (
              <MessageComposer
                key={String(activeThreadId)}
                onSendMessage={handleSendMessage}
                onStageAttachment={handleStageAttachment}
                onDiscardAttachment={handleDiscardAttachment}
                capabilities={richCapabilities}
                senderIdentity={currentSenderIdentity}
                disabled={!!isCurrentSendDisabled || richCapabilities?.text?.enabled === false}
                disabledReason={currentSendDisabledReason}
              />
            )}
          </div>
        ) : (
          <EmptyState icon={MessageSquare} title="Chá»n má»™t há»™i thoáº¡i Ä‘á»ƒ báº¯t Ä‘áº§u nháº¯n tin" description="Tin nháº¯n vÃ  thÃ´ng tin khÃ¡ch hÃ ng sáº½ xuáº¥t hiá»‡n táº¡i Ä‘Ã¢y." />
        )}
      </div>

      {/* Column 4: Lead Details Panel */}
      {!leadPanelCollapsed && !isNarrow && (
        <LeadDetailsPanel contactInfo={activeContact} onSaveContact={handleSaveContact} onExportLeads={handleExportLeads} leadStatuses={leadStatuses} onCreateLeadStatus={handleCreateLeadStatus} onDeleteLeadStatus={handleDeleteLeadStatus} onSetReminder={handleSetReminder} onCompleteReminder={handleCompleteReminder} onCancelReminder={handleCancelReminder} onArchiveThread={handleArchiveThread} />
      )}

      {/* Lead Drawer for â‰¤1199px */}
      {showLeadDrawer && (
        <>
          <div className="lead-drawer-backdrop open" onClick={() => setShowLeadDrawer(false)} role="presentation" />
          <div className="lead-drawer open" role="dialog" aria-modal="true">
            <LeadDetailsPanel contactInfo={activeContact} onSaveContact={handleSaveContact} onExportLeads={handleExportLeads} onCloseDrawer={() => setShowLeadDrawer(false)} leadStatuses={leadStatuses} onCreateLeadStatus={handleCreateLeadStatus} onDeleteLeadStatus={handleDeleteLeadStatus} onSetReminder={handleSetReminder} onCompleteReminder={handleCompleteReminder} onCancelReminder={handleCancelReminder} onArchiveThread={handleArchiveThread} />
          </div>
        </>
      )}

      {/* Modals */}
      {activeModal === 'search' && <SearchOverlay onClose={() => setActiveModal(null)} onSelectThread={(tid) => { setActiveThreadId(tid); setActiveModal(null); }} />}
      {activeModal === 'accounts' && <AccountManagerModal sessionUser={sessionUser} socket={socket} onClose={() => { setActiveModal(null); loadAccounts(); loadInboxSources(); }} onSourcesChanged={() => { loadInboxSources(); loadThreads(); }} onFacebookSyncStart={(accountId, started) => {
        if (!started) {
          if (String(requestedFacebookSyncRef.current || '') === String(accountId)) requestedFacebookSyncRef.current = null;
          setAccountSyncing(null);
          return;
        }
        requestedFacebookSyncRef.current = String(accountId);
        setAccountSyncing({ accountId: String(accountId), tabCount: null });
      }} />}
      {activeModal === 'autoReply' && <AutoReplyModal onClose={() => setActiveModal(null)} />}
      {activeModal === 'campaigns' && (
        <CampaignCreateModal
          selectedThreads={selectedCampaignThreads}
          onClose={() => setActiveModal(null)}
          onStartSelection={startCampaignSelection}
          onCreated={handleCampaignCreated}
          onOpenCampaign={openCampaign}
          leadStatuses={leadStatuses}
        />
      )}
      {activeModal === 'campaignDetail' && activeCampaignId && (
        <CampaignDetail
          campaignId={activeCampaignId}
          refreshVersion={campaignRefreshVersion}
          leadStatuses={leadStatuses}
          socket={socket}
          onClose={() => { setActiveModal(null); setActiveCampaignId(null); }}
          onBackToList={() => { setActiveModal('campaigns'); setActiveCampaignId(null); }}
        />
      )}
      {activeModal === 'aiConfig' && <AiConfigModal onClose={() => setActiveModal(null)} />}
      {activeModal === 'phoneAutomation' && <PhoneAutomationSettingsModal leadStatuses={leadStatuses} onClose={() => setActiveModal(null)} />}
      {activeModal === 'payment' && (
        <PaymentModal
          isOpen={true}
          onClose={() => setActiveModal(null)}
          onActivated={checkLicenseStatus}
          existingLicense={licenseStatus?.isLicensed ? licenseStatus : null}
        />
      )}
      {activeModal === 'license' && (
        <LicenseManagerModal
          isOpen={true}
          onClose={() => setActiveModal(null)}
          onOpenPayment={() => setActiveModal('payment')}
        />
      )}

      {/* Real-time Incoming Call Overlay */}
      <IncomingCallModal
        callInfo={incomingCallInfo}
        onClose={() => setIncomingCallInfo(null)}
        onSelectThread={(tid) => setActiveThreadId(tid)}
        onAnswerCall={(action, thread_id, callback, source_tab_id = null, source_frame_id = 0, account_id = null, call_id = null) => {
          if (!socket) {
            callback?.(false, 'Extension Facebook chÆ°a káº¿t ná»‘i');
            return;
          }

          console.log(`[App] ðŸŽ¯ Emitting ANSWER_INCOMING_CALL (${action}) for thread ${thread_id}`);

          let settled = false;
          let timeoutId = null;

          const cleanup = () => {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            socket.off?.('ANSWER_INCOMING_CALL_RESULT', resultHandler);
            socket.off?.('ANSWER_INCOMING_CALL_RESPONSE', ackHandler);
          };

          const finish = (ok, msg) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback?.(!!ok, msg);
          };

          const matchesThread = (payloadThreadId, payloadExternalThreadId) => {
            if (!thread_id) return true;
            const expected = String(thread_id);
            return String(payloadThreadId || '') === expected || String(payloadExternalThreadId || '') === expected;
          };

          const resultHandler = (payload = {}) => {
            if (payload.action !== action) return;
            if (!matchesThread(payload.thread_id, payload.external_thread_id)) return;
            finish(
              !!payload.success,
              payload.success
                ? (action === 'accept' ? 'ÄÃ£ cháº¥p nháº­n cuá»™c gá»i' : 'ÄÃ£ tá»« chá»‘i cuá»™c gá»i')
                : (payload.error || 'Extension khÃ´ng báº¥m Ä‘Æ°á»£c nÃºt cuá»™c gá»i')
            );
          };

          const ackHandler = (payload = {}) => {
            if (payload?.success) return;
            finish(false, payload?.error || 'KhÃ´ng gá»­i Ä‘Æ°á»£c lá»‡nh tá»›i extension');
          };

          socket.on?.('ANSWER_INCOMING_CALL_RESULT', resultHandler);
          socket.on?.('ANSWER_INCOMING_CALL_RESPONSE', ackHandler);
          timeoutId = setTimeout(() => {
            finish(false, 'Háº¿t thá»i gian chá» extension pháº£n há»“i');
          }, 10000);

          socket.emit('ANSWER_INCOMING_CALL', { action, thread_id, source_tab_id, source_frame_id, account_id, call_id });
        }}
      />

      {/* FULL LOCK OVERLAY IF NOT LICENSED */}
      {licenseStatus && !licenseStatus.isLicensed && activeModal !== 'payment' && (
        <LicenseLockScreen
          status={licenseStatus}
          sessionUser={sessionUser}
          onOpenPayment={() => setActiveModal('payment')}
          onBackToLogin={handleLogout}
        />
      )}
    </div>
  );
}
