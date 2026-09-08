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

const THEME_VERSION = 'chat-redesign-v1';

// Older/background sync payloads can create a thread before Messenger returns
// the actual display name.  Do not keep showing that placeholder once the
// contact record has a verified name.
function isPlaceholderContactName(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('vi-VN');
  return !normalized || normalized === 'khách hàng' || normalized === 'customer';
}

function getVerifiedContactName(contact) {
  const name = String(contact?.name || contact?.contact_name || '').trim();
  return isPlaceholderContactName(name) ? '' : name;
}

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
  const [activeTab, setActiveTab] = useState('ALL');
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
    try {
      const res = await fetch('/api/license/status');
      const json = await res.json();
      if (json.success) {
        setLicenseStatus(json.data);
      }
    } catch (e) {
      console.warn('Failed to check license status:', e);
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
        throw new Error(created?.error || 'Không thể tạo trạng thái mới.');
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
    try {
      const res = await fetch(`/api/threads?tab=${activeTab}`);
      const data = await res.json();
      if (sessionUserIdRef.current !== requestedUserId) return;
      const threadList = Array.isArray(data) ? data : [];
      setThreads(threadList.map(t => ({ ...t, thread_key: t.thread_key || (t.account_id ? `${t.account_id}:${t.id}` : String(t.id)) })));
    } catch {
      setThreads([]);
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

  const requestThreadNavigation = useCallback((thread) => {
    if (!thread) return;
    setActiveThreadId(thread.id);
  }, []);

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
      scroll_delta: direction === 'viewport' ? Number(scrollDelta) || 0 : 0
    });
  }, [socket, isConnected]);

  useEffect(() => {
    if (!activeThreadId) return;
    const threadIdStr = String(activeThreadId);
    fetch(`/api/threads/${threadIdStr}/messages`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(prev => ({ ...prev, [threadIdStr]: data }));
        }
      })
      .catch(() => {});

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
        if (!response.ok) throw new Error(data.error || 'Không tải được khả năng gửi.');
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
              status: newMsg.status || newMsg.delivery_status || 'sent'
            };
          } else {
            updated = [...currentMsgs, { ...newMsg, status: newMsg.status || newMsg.delivery_status || 'sent' }];
          }
        } else {
          const existsIdx = currentMsgs.findIndex((message) => (
            (newMsg.fb_message_id && message.fb_message_id === newMsg.fb_message_id) ||
            (newMsg.id != null && message.id === newMsg.id)
          ));
          if (existsIdx >= 0) {
            updated = [...currentMsgs];
            updated[existsIdx] = {
              ...currentMsgs[existsIdx],
              ...newMsg,
              status: newMsg.status || newMsg.delivery_status || 'sent'
            };
          } else {
            updated = [...currentMsgs, { ...newMsg, status: newMsg.status || newMsg.delivery_status || 'sent' }];
          }
        }
        
        // Database insertion order is the canonical chat sequence. Direction
        // is stored separately in is_outgoing (0 = customer, 1 = operator),
        // so timestamps are display metadata only and never move a bubble.
        updated.sort((a, b) => {
          const sequenceA = Number(a.sequence_order ?? a.id);
          const sequenceB = Number(b.sequence_order ?? b.id);
          if (!Number.isFinite(sequenceA) || !Number.isFinite(sequenceB)) return 0;
          return sequenceA - sequenceB || Number(a.id || 0) - Number(b.id || 0);
        });

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
          return updated.sort((a, b) => {
            const timeA = new Date(a.last_activity || a.updated_at || a.created_at || 0).getTime();
            const timeB = new Date(b.last_activity || b.updated_at || b.created_at || 0).getTime();
            return timeB - timeA;
          });
        }
        return prev;
      });
      loadThreadsRef.current();

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
      if (provisional) return;
      // Auto-refetch after message is marked sent to load full database row with media URL
      setTimeout(() => {
        fetch(`/api/threads/${tidStr}/messages`)
          .then(r => r.json())
          .then(data => {
            if (Array.isArray(data)) {
              setMessages(prev => ({ ...prev, [tidStr]: data }));
            }
          })
          .catch(() => {});
      }, 300);
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
          [tidStr]: currentMsgs.map(m => m.client_message_id === client_message_id ? { ...m, status: 'failed', delivery_status: 'failed', error } : m)
        };
      });
    });


    socket.on('INCOMING_CALL_RINGING', (callData) => {
      console.log('[Socket.io] 🔔 INCOMING_CALL_RINGING:', callData);
      setIncomingCallInfo(callData);
    });

    socket.on('INCOMING_CALL_ENDED', (callData) => {
      console.log('[Socket.io] 📴 INCOMING_CALL_ENDED:', callData);
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
                status: accepted.status,
                delivery_status: 'pending',
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
        [tidStr]: (prev[tidStr] || []).map((message) => (
          message.client_message_id === statusEvent.client_message_id ||
          (statusEvent.message_id && Number(message.id) === Number(statusEvent.message_id))
            ? {
                ...message,
                attempt_id: statusEvent.attempt_id || message.attempt_id,
                latest_attempt_id: statusEvent.attempt_id || message.latest_attempt_id,
                status: statusEvent.status,
                delivery_status: statusEvent.status === 'sent'
                  ? 'sent'
                  : statusEvent.status === 'failed'
                    ? 'failed'
                    : 'pending',
                fb_message_id: statusEvent.fb_message_id || message.fb_message_id,
                error: statusEvent.error || null
              }
            : message
        ))
      }));
    });

    socket.on('SEND_ERROR', ({ client_message_id, error, code }) => {
      if (!client_message_id) return;
      setMessages((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((threadId) => {
          next[threadId] = next[threadId].map((message) => (
            message.client_message_id === client_message_id
              ? { ...message, status: 'failed', delivery_status: 'failed', error: { code, message: error } }
              : message
          ));
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

        const messageKey = (message) => {
          if (message.fb_message_id) return `fb_${message.fb_message_id}`;
          if (message.client_message_id) return `client_${message.client_message_id}`;
          if (message.id != null) return `id_${message.id}`;
          return `fallback_${message.timestamp_ms || message.created_at || 0}_${message.is_outgoing ? 1 : 0}_${message.content || ''}`;
        };

        // Nạp tin nhắn vừa sync
        (syncedMsgs || []).forEach(m => {
          const key = messageKey(m);
          mergedMap.set(key, { ...m, thread_key: m.thread_key || thread_key, account_id: m.account_id || account_id, status: 'sent' });
        });

        // Giữ lại các tin nhắn pending/failed/realtime chưa có trong bản sync
        existing.forEach(m => {
          const key = messageKey(m);
          const keepOptimistic = m.status === 'sending' || m.status === 'failed' || m.delivery_status === 'pending';
          if (!mergedMap.has(key) && (!authoritative || keepOptimistic)) {
            mergedMap.set(key, m);
          } else if (m.status === 'sending' || m.status === 'failed') {
            mergedMap.set(key, { ...mergedMap.get(key), status: m.status, error: m.error });
          }
        });

        const mergedArray = Array.from(mergedMap.values());
        mergedArray.sort((a, b) => {
          const sequenceA = Number(a.sequence_order ?? a.id);
          const sequenceB = Number(b.sequence_order ?? b.id);
          if (!Number.isFinite(sequenceA) || !Number.isFinite(sequenceB)) return 0;
          return sequenceA - sequenceB || Number(a.id || 0) - Number(b.id || 0);
        });

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
              if (Array.isArray(data)) setMessages((previous) => ({ ...previous, [threadId]: data }));
            })
            .catch(() => {});
        }
      }
    });

    socket.on('EXTENSION_CONNECTION_CHANGED', ({ account_id, is_connected }) => {
      setAccounts(prev => prev.map(a => String(a.id) === String(account_id) ? { ...a, is_extension_connected: is_connected } : a));
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
        const accIdStr = String(account_id || '');
        const updatedThreads = [...prev];

        for (const synced of syncedThreads) {
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

        return updatedThreads.sort((a, b) => {
          const timeA = new Date(a.last_activity || a.updated_at || a.created_at || 0).getTime();
          const timeB = new Date(b.last_activity || b.updated_at || b.created_at || 0).getTime();
          return timeB - timeA;
        });
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
    if (!activeThreadId) throw new Error('Chưa chọn hội thoại.');
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
      const error = new Error(data.error || 'Không tải được file đính kèm.');
      error.code = data.code;
      throw error;
    }
    return data.attachment;
  }, [activeThreadId]);

  const handleDiscardAttachment = useCallback(async (attachmentId) => {
    if (!activeThreadId) throw new Error('Chưa chọn hội thoại.');
    const response = await fetch(
      '/api/threads/' + encodeURIComponent(String(activeThreadId)) +
        '/outbound-attachments/' + encodeURIComponent(attachmentId),
      { method: 'DELETE' }
    );
    if (response.status === 204) return;
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || 'Không gỡ được file đính kèm.');
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
    if (!payload.client_message_id) throw new Error('Thiếu mã tin nhắn phía CRM.');

    const newMsg = {
      client_message_id: payload.client_message_id,
      content: payload.content,
      attachment_id: payload.attachment_id,
      attachment: payload.attachment,
      media_type: payload.attachment?.media_type || 'text',
      media_url: payload.attachment?.preview_url || null,
      media_name: payload.attachment?.safe_name || payload.attachment?.original_name || null,
      media_mime_type: payload.attachment?.mime_type || null,
      media_size: payload.attachment?.byte_size || null,
      is_outgoing: true,
      direction_status: 'confirmed',
      created_at: new Date().toISOString(),
      status: 'sending',
      delivery_status: 'pending'
    };

    setMessages((prev) => ({
      ...prev,
      [threadIdStr]: [...(prev[threadIdStr] || []), newMsg]
    }));

    if (socket && isConnected) {
      socket.emit('SEND_MESSAGE', {
        // Plain text uses the low-latency direct Messenger path. Rich-message
        // queueing is reserved for attachments, which need integrity tracking.
        contract_version: payload.attachment_id || payload.attachment ? 2 : 1,
        thread_id: threadIdStr,
        client_message_id: payload.client_message_id,
        content: payload.content,
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
              error: { code: 'SOCKET_DISCONNECTED', message: 'CRM chưa kết nối backend.' }
            }
          : message
      ))
    }));
  };

  const handleRetryMessage = (msg) => {
    if (msg?.content) {
      handleSendMessage(msg.content, `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    }
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
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Không thể lưu nhắc.');
    await loadThreads(); return data;
  };
  const handleCompleteReminder = async (threadId) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+'/reminder/complete',{method:'POST'}); const data=await res.json().catch(() => ({})); if(!res.ok) throw new Error(data.error || 'Không thể hoàn thành nhắc.'); await loadThreads(); };
  const handleCancelReminder = async (threadId) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+'/reminder',{method:'DELETE'}); const data=await res.json().catch(() => ({})); if(!res.ok) throw new Error(data.error || 'Không thể hủy nhắc.'); await loadThreads(); };
  const handleArchiveThread = async (threadId, restore=false) => { const res=await fetch('/api/threads/'+encodeURIComponent(threadId)+(restore?'/restore':'/archive'),{method:'POST'}); if(!res.ok) throw new Error('Không thể cập nhật lưu trữ.'); await loadThreads(); };

  const handleSaveContact = async (updatedContact) => {
    const contactThreadId = String(updatedContact.thread_id);
    const res = await fetch(`/api/contacts/${contactThreadId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedContact)
    });
    const responsePayload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(responsePayload?.error || `Lưu liên hệ thất bại (${res.status})`);
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

  const selectedThread = activeThreadId ? (
    threads.find(t => String(t.id) === String(activeThreadId)) || threads.find(t => t.id === activeThreadId)
  ) : null;
  const activeMessages = activeThreadId ? (messages[String(activeThreadId)] || []) : [];
  const currentAccount = selectedThread ? accounts.find(a => String(a.id) === String(selectedThread.account_id)) : null;
  const activeContact = activeThreadId && selectedThread ? {
    thread_id: String(activeThreadId),
    name: selectedThread.contact_name || selectedThread.name || 'Khách hàng',
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
    ? 'Đang chờ Page Messenger sẵn sàng. Vui lòng đợi trong giây lát.'
    : 'Tài khoản Facebook chưa được kết nối. Vui lòng vào Quản lý và bấm Kết nối Facebook.';

  const gridClass = `${leadPanelCollapsed ? 'app-grid-collapsed' : 'app-grid'}${activeView === 'employees' ? ' employee-view' : ''}`;

  const handleStartCall = useCallback((callType = 'audio') => {
    if (!activeThreadId || !selectedThread) return;
    if (!socket || !isConnected) {
      alert('Chưa kết nối đến Server WebSocket!');
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
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Đang kiểm tra phiên đăng nhập...</div>;
  }

  if (!sessionUser) {
    return <AuthScreen onAuthenticated={setSessionUser} />;
  }

  if (licenseStatus === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Đang kiểm tra bản quyền...</div>;
  }

  return (
    <div className={gridClass}>
      {accountSyncing && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg"
          style={{
            position: 'fixed',
            top: '12px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10000,
            width: 'max-content',
            height: 'auto',
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          {accountSyncing.tabCount == null
            ? 'Đang khởi động đồng bộ Facebook, vui lòng chờ...'
            : `Đang đồng bộ Facebook trên ${accountSyncing.tabCount} tab, vui lòng chờ...`}
        </div>
      )}
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
        activeTab={activeTab} onTabChange={setActiveTab}
        waitingCount={waitingCount}
        searchQuery={searchQuery} onSearchChange={setSearchQuery}
        isConnected={isConnected} onOpenSearch={() => setActiveModal('search')}
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
          <div className="chat-thread flex flex-col h-full flex-1 min-h-0 relative">
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
              messages={activeMessages}
              activeThread={selectedThread}
              onSyncThread={undefined}
              onRetryMessage={handleRetryMessage}
              historySyncing={String(historySyncingThreadId || '') === String(activeThreadId)}
              onViewportScroll={(scrollDelta) => {
                if (selectedThread.source_type === 'page_messenger') return;
                requestThreadMessageSync(activeThreadId, 'viewport', scrollDelta);
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
                disabled={!!isCurrentSendDisabled || richCapabilities?.text?.enabled === false}
                disabledReason={currentSendDisabledReason}
              />
            )}
          </div>
        ) : (
          <EmptyState icon={MessageSquare} title="Chọn một hội thoại để bắt đầu nhắn tin" description="Tin nhắn và thông tin khách hàng sẽ xuất hiện tại đây." />
        )}
      </div>

      {/* Column 4: Lead Details Panel */}
      {!leadPanelCollapsed && !isNarrow && (
        <LeadDetailsPanel contactInfo={activeContact} onSaveContact={handleSaveContact} onExportLeads={handleExportLeads} leadStatuses={leadStatuses} onCreateLeadStatus={handleCreateLeadStatus} onDeleteLeadStatus={handleDeleteLeadStatus} onSetReminder={handleSetReminder} onCompleteReminder={handleCompleteReminder} onCancelReminder={handleCancelReminder} onArchiveThread={handleArchiveThread} />
      )}

      {/* Lead Drawer for ≤1199px */}
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
        onAnswerCall={(action, thread_id, callback, source_tab_id = null) => {
          if (!socket) {
            callback?.(false, 'Extension Facebook chưa kết nối');
            return;
          }

          console.log(`[App] 🎯 Emitting ANSWER_INCOMING_CALL (${action}) for thread ${thread_id}`);

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
                ? (action === 'accept' ? 'Đã chấp nhận cuộc gọi' : 'Đã từ chối cuộc gọi')
                : (payload.error || 'Extension không bấm được nút cuộc gọi')
            );
          };

          const ackHandler = (payload = {}) => {
            if (payload?.success) return;
            finish(false, payload?.error || 'Không gửi được lệnh tới extension');
          };

          socket.on?.('ANSWER_INCOMING_CALL_RESULT', resultHandler);
          socket.on?.('ANSWER_INCOMING_CALL_RESPONSE', ackHandler);
          timeoutId = setTimeout(() => {
            finish(false, 'Hết thời gian chờ extension phản hồi');
          }, 10000);

          socket.emit('ANSWER_INCOMING_CALL', { action, thread_id, source_tab_id });
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
