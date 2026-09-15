class InboxSyncScheduler {
  constructor({
    // Realtime network/DOM observation is the primary path. When Facebook
    // does not surface an inactive thread there, this lightweight one-round
    // Inbox scan is the fallback. A two-second cadence keeps replies responsive
    // while leaving Chrome capacity for manual and campaign sends.
    sidebarIntervalMs = 2000,
    sidebarCooldownMs = 1200,
    // Requests/Spam live on a separate Messenger surface. Poll them often
    // enough for the waiting tab to feel live without adding work to every
    // 2s Inbox tick. Scheduled request scans are deliberately less frequent.
    requestsIntervalMs = 60000,
    // Sidebar work is bounded so a stalled Facebook lazy surface cannot hold
    // the extension command lane for minutes.
    sidebarTimeoutMs = 45000,
    threadCooldownMs = 2000,
    // Messenger virtualized history regularly needs longer than 20s to
    // mount older rows. Expiring it early dispatches a replay while the first
    // extension job is still alive, and the replay supersedes that navigation.
    threadTimeoutMs = 120000
  } = {}) {
    this.sidebarIntervalMs = sidebarIntervalMs;
    this.sidebarCooldownMs = sidebarCooldownMs;
    this.requestsIntervalMs = requestsIntervalMs;
    this.sidebarTimeoutMs = sidebarTimeoutMs;
    this.threadCooldownMs = threadCooldownMs;
    this.threadTimeoutMs = threadTimeoutMs;

    this.accounts = new Map();
    this.threadInFlight = new Set();
    this.threadTimeouts = new Map();
    this.threadCooldownUntil = new Map();
    this.pendingThreadSyncs = new Map();
    this.threadQueues = new Map();
    this.accountThreadBusy = new Set();
    this.getConnection = null;
    this.dispatchThreadMessagesSync = null;
  }

  configure({ getConnection, dispatchThreadMessagesSync }) {
    this.getConnection = getConnection;
    this.dispatchThreadMessagesSync = dispatchThreadMessagesSync;
  }

  registerAccount(accountId) {
    const accId = String(accountId || '');
    if (!accId) return;

    let state = this.accounts.get(accId);
    if (!state) {
      state = {
        account_id: accId,
        inFlight: false,
        lastSidebarSyncAt: 0,
        // Do not launch the expensive Requests crawl immediately after startup;
        // the explicit waiting tab can still request it at once.
        lastRequestsSyncAt: Date.now(),
        activeScanMode: null,
        activeScanReason: null,
        lastRealtimePreemptAt: 0,
        // Sidebar discovery is opt-in. Manual/campaign sending remains online,
        // while Inbox + Requests polling runs only inside a one-minute window.
        syncEnabledUntil: 0,
        syncWindowTimer: null,
        pendingRequestScan: false,
        lastResultAt: 0,
        pending: false,
        timeout: null,
        interval: null
      };
      this.accounts.set(accId, state);
    }

    if (!state.interval) {
      state.interval = setInterval(() => {
        if (!this.isSyncWindowActive(accId)) return;
        console.log(`[INBOX_SYNC_TICK] account=${accId}`);
        state.quickTickCount = Number(state.quickTickCount || 0) + 1;
        // Preserve periodic full discovery while polling Inbox quickly for replies.
        // Keep the previous five-minute cadence for the expensive full scan
        // even though lightweight realtime ticks now run once per second.
        const fullDiscoveryTicks = Math.max(1, Math.round(300000 / this.sidebarIntervalMs));
        const fullDiscoveryDue = state.quickTickCount % fullDiscoveryTicks === 0;
        const requestsDue = !fullDiscoveryDue
          && Date.now() - Number(state.lastRequestsSyncAt || 0) >= this.requestsIntervalMs;
        const scanMode = fullDiscoveryDue ? 'full' : (requestsDue ? 'realtime_requests' : 'realtime');
        const reason = fullDiscoveryDue ? 'scheduler_full' : (requestsDue ? 'scheduler_requests' : 'scheduler_realtime');
        const dispatched = this.requestSidebarSync(accId, reason, { scanMode });
        if (dispatched && scanMode !== 'realtime') state.lastRequestsSyncAt = Date.now();
      }, this.sidebarIntervalMs);
      if (typeof state.interval.unref === 'function') state.interval.unref();
    }

    console.log(`[INBOX_SYNC_REGISTER] account=${accId} interval_ms=${this.sidebarIntervalMs}`);
    // Keep the extension connection ready for manual sends, but leave the two
    // expensive sidebar tabs asleep until the operator presses Refresh.
  }

  isSyncWindowActive(accountId) {
    const state = this.accounts.get(String(accountId || ''));
    return Boolean(state && Number(state.syncEnabledUntil || 0) > Date.now());
  }

  scheduleSidebarReplay(accountId, reason = 'scheduled_replay', delayMs = 500) {
    const accId = String(accountId || '');
    const state = this.accounts.get(accId);
    if (!state || !this.isSyncWindowActive(accId)) return false;
    state.pending = true;
    if (state.pendingTimer) return true;
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      if (!this.isSyncWindowActive(accId)) return;
      this.requestSidebarSync(accId, reason, { force: true, scanMode: 'realtime' });
    }, Math.max(25, Number(delayMs) || 500));
    if (typeof state.pendingTimer.unref === 'function') state.pendingTimer.unref();
    return true;
  }

  startSyncWindow(accountId, durationMs = 120000) {
    const accId = String(accountId || '');
    if (!accId) return { enabled: false, expires_at: 0 };
    if (!this.accounts.has(accId)) this.registerAccount(accId);
    const state = this.accounts.get(accId);
    const boundedDuration = Math.max(5000, Math.min(Number(durationMs) || 120000, 120000));
    state.syncEnabledUntil = Date.now() + boundedDuration;
    if (state.syncWindowTimer) clearTimeout(state.syncWindowTimer);
    state.syncWindowTimer = setTimeout(() => this.stopSyncWindow(accId, 'window_expired'), boundedDuration);
    if (typeof state.syncWindowTimer.unref === 'function') state.syncWindowTimer.unref();

    const inboxDispatched = this.requestSidebarSync(accId, 'manual_window_inbox', { force: true, scanMode: 'realtime' });
    // The refresh button can be pressed while the extension is reconnecting.
    // Do not lose that explicit request: retry the Inbox scan after the socket
    // becomes ready and trigger Message Requests independently of Inbox.
    if (!inboxDispatched) this.scheduleSidebarReplay(accId, 'manual_window_inbox_replay', 500);
    this.requestMessageRequestsSync(accId, 'manual_window_requests');
    console.log(`[INBOX_SYNC_WINDOW_STARTED] account=${accId} duration_ms=${boundedDuration}`);
    return { enabled: true, expires_at: state.syncEnabledUntil };
  }

  stopSyncWindow(accountId, reason = 'manual') {
    const accId = String(accountId || '');
    const state = this.accounts.get(accId);
    if (!state) return { enabled: false, expires_at: 0 };
    state.syncEnabledUntil = 0;
    state.pending = false;
    state.pendingRequestScan = false;
    if (state.syncWindowTimer) clearTimeout(state.syncWindowTimer);
    state.syncWindowTimer = null;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
    state.inFlight = false;
    state.activeScanMode = null;
    state.activeScanReason = null;
    const extWs = this.getConnection?.(accId);
    if (extWs?.readyState === 1) {
      extWs.send(JSON.stringify({ type: 'CANCEL_THREADS_SYNC', data: { account_id: accId, reason } }));
      extWs.send(JSON.stringify({ type: 'SET_SIDEBAR_SYNC_WINDOW', data: { account_id: accId, enabled: false, reason } }));
    }
    console.log(`[INBOX_SYNC_WINDOW_STOPPED] account=${accId} reason=${reason}`);
    return { enabled: false, expires_at: 0 };
  }

  unregisterAccount(accountId) {
    const accId = String(accountId || '');
    const state = this.accounts.get(accId);
    if (!state) return;
    if (state.interval) clearInterval(state.interval);
    if (state.timeout) clearTimeout(state.timeout);
    if (state.syncWindowTimer) clearTimeout(state.syncWindowTimer);
    this.accounts.delete(accId);
    this.threadQueues.delete(accId);
    this.accountThreadBusy.delete(accId);

    for (const key of [...this.threadInFlight]) {
      if (key.startsWith(`${accId}:`)) this.threadInFlight.delete(key);
    }
    for (const [key, timeout] of [...this.threadTimeouts.entries()]) {
      if (key.startsWith(`${accId}:`)) {
        clearTimeout(timeout);
        this.threadTimeouts.delete(key);
      }
    }
    for (const key of [...this.threadCooldownUntil.keys()]) {
      if (key.startsWith(`${accId}:`)) this.threadCooldownUntil.delete(key);
    }
    for (const key of [...this.pendingThreadSyncs.keys()]) {
      if (key.startsWith(`${accId}:`)) this.pendingThreadSyncs.delete(key);
    }
    console.log(`[INBOX_SYNC_UNREGISTER] account=${accId}`);
  }

  requestSidebarSync(accountId, reason = 'manual', { force = false, scanMode = null } = {}) {
    const accId = String(accountId || '');
    if (!accId || !this.getConnection) return false;

    const state = this.accounts.get(accId) || {
      account_id: accId,
      inFlight: false,
      lastSidebarSyncAt: 0,
      lastRequestsSyncAt: Date.now(),
      activeScanMode: null,
      activeScanReason: null,
      lastRealtimePreemptAt: 0,
      syncEnabledUntil: 0,
      syncWindowTimer: null,
      pendingRequestScan: false,
      lastResultAt: 0,
      timeout: null,
      interval: null
    };
    this.accounts.set(accId, state);

    const now = Date.now();
    if (!this.isSyncWindowActive(accId)) {
      console.log(`[INBOX_SYNC_SKIP] account=${accId} reason=${reason} skip=manual_window_inactive`);
      return false;
    }
    const isLightweightScan = scanMode === 'realtime' || scanMode === 'realtime_requests';
    if (this.accountThreadBusy.has(accId)) {
      // Realtime discovery uses a separate tab, so history/campaign work must not pause new replies.
      if (!isLightweightScan) {
      state.pending = true;
      console.log(`[INBOX_SYNC_DEFER] account=${accId} reason=${reason} defer=thread_history_busy`);
      return false;
      }
    }
    if (state.inFlight && !force) {
      if (scanMode === 'realtime' && state.activeScanMode === 'realtime_requests'
        && state.activeScanReason === 'scheduler_requests'
        && now - Number(state.lastSidebarSyncAt || 0) >= 8000
        && now - Number(state.lastRealtimePreemptAt || 0) >= 1000) {
        const priorityWs = this.getConnection(accId);
        if (priorityWs?.readyState === 1) {
          // Queue a realtime scan inside the extension. It cancels the slower
          // scheduled Requests crawl and starts as soon as that crawl unwinds.
          priorityWs.send(JSON.stringify({ type: 'SYNC_THREADS', data: {
            account_id: accId,
            reason: 'realtime_preempt_requests',
            scan_mode: 'realtime',
            resume: false,
            time_budget_ms: 5000
          } }));
          state.lastRealtimePreemptAt = now;
          console.log(`[INBOX_SYNC_PREEMPT_REQUESTS] account=${accId}`);
          return true;
        }
      }
      if (isLightweightScan) return false;
      state.pending = true;
      console.log(`[INBOX_SYNC_DEFER] account=${accId} reason=${reason} defer=in_flight`);
      return false;
    }
    if (!force && now - state.lastSidebarSyncAt < this.sidebarCooldownMs) {
      if (isLightweightScan) return false;
      state.pending = true;
      const delay = Math.max(25, this.sidebarCooldownMs - (now - state.lastSidebarSyncAt));
      console.log(`[INBOX_SYNC_DEFER] account=${accId} reason=${reason} defer=cooldown delay_ms=${delay}`);
      if (!state.pendingTimer) {
        state.pendingTimer = setTimeout(() => {
          state.pendingTimer = null;
          if (state.pending) this.requestSidebarSync(accId, 'pending_replay');
        }, delay);
        if (typeof state.pendingTimer.unref === 'function') state.pendingTimer.unref();
      }
      return false;
    }

    const extWs = this.getConnection(accId);
    if (!extWs || extWs.readyState !== 1) {
      console.warn(`[INBOX_SYNC_SKIP] account=${accId} reason=${reason} skip=extension_not_ready`);
      const replayReason = String(reason || '').includes('_extension_replay') ? reason : `${reason}_extension_replay`;
      this.scheduleSidebarReplay(accId, replayReason, 750);
      return false;
    }

    state.inFlight = true;
    state.activeScanMode = scanMode || (reason === 'scheduler_realtime' || reason === 'register' ? 'realtime' : 'full');
    state.activeScanReason = reason;
    state.pending = false;
    state.lastSidebarSyncAt = now;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      const current = this.accounts.get(accId);
      if (current?.inFlight) {
        current.inFlight = false;
        console.warn(`[INBOX_SYNC_TIMEOUT] account=${accId} timeout_ms=${this.sidebarTimeoutMs}`);
        if (current.pending) this.requestSidebarSync(accId, 'timeout_replay', { force: true });
      }
    }, this.sidebarTimeoutMs);
    if (typeof state.timeout.unref === 'function') state.timeout.unref();

    extWs.send(JSON.stringify({ type: 'SYNC_THREADS', data: {
      account_id: accId,
      reason,
      scan_mode: scanMode || (reason === 'scheduler_realtime' || reason === 'register' ? 'realtime' : 'full'),
      resume: reason === 'crm_continue',
      // Requests must visit both the Possible and Spam surfaces. Facebook can
      // spend tens of seconds mounting either lazy sidebar, so keep this job
      // alive without changing the normal Inbox realtime budget.
      time_budget_ms: scanMode === 'realtime'
        ? 5000
        : (scanMode === 'realtime_requests' ? (reason === 'scheduler_requests' ? 12000 : 30000) : 120000)
    } }));
    console.log(`[INBOX_SYNC_THREADS_DISPATCHED] account=${accId} reason=${reason}`);
    return true;
  }

  requestMessageRequestsSync(accountId, reason = 'crm_waiting_tab') {
    const accId = String(accountId || '');
    if (!accId) return false;
    const state = this.accounts.get(accId);
    if (state?.inFlight) {
      state.pendingRequestScan = true;
      console.log(`[INBOX_SYNC_REQUESTS_DEFER] account=${accId} reason=${reason} defer=in_flight`);
      return false;
    }
    return this.requestSidebarSync(accId, reason, { scanMode: 'realtime_requests' });
  }

  markSidebarResult(accountId, count = 0) {
    const accId = String(accountId || '');
    const state = this.accounts.get(accId);
    if (!state) return;
    state.inFlight = false;
    state.activeScanMode = null;
    state.activeScanReason = null;
    state.lastResultAt = Date.now();
    if (!this.isSyncWindowActive(accId)) return;
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    console.log(`[INBOX_SYNC_THREADS_RESULT] account=${accId} count=${count}`);
    if (state.pendingRequestScan) {
      state.pendingRequestScan = false;
      const requestsTimer = setTimeout(() => this.requestMessageRequestsSync(accId, 'waiting_tab_replay'), 25);
      if (typeof requestsTimer.unref === 'function') requestsTimer.unref();
    }
    if (state.pending) {
      const timer = setTimeout(() => this.requestSidebarSync(accId, 'result_replay'), this.sidebarCooldownMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  enqueueThreadSync({ account_id, thread_id, external_thread_id = null, thread_url = null, page_id = null, contact_name = null, reason = 'changed', allow_navigation = false, priority = 'normal', sync_mode = null, scroll_delta = 0 }) {
    const accId = String(account_id || '');
    const threadId = String(thread_id || '');
    if (!accId || !threadId || !this.dispatchThreadMessagesSync) return false;

    const key = `${accId}:${threadId}`;
    const now = Date.now();
    const jobData = { account_id: accId, thread_id: threadId, external_thread_id, thread_url, page_id, contact_name, reason, allow_navigation: allow_navigation === true, priority, sync_mode, scroll_delta: Number(scroll_delta) || 0 };
    const cooldownUntil = this.threadCooldownUntil.get(key) || 0;
    // Explicit CRM navigation/scroll may reacquire a thread immediately after
    // it was preempted when the operator switched away and then back.
    if (this.threadInFlight.has(key) || (now < cooldownUntil && priority !== 'high')) {
      const pending = this.pendingThreadSyncs.get(key);
      const combinedScrollDelta = sync_mode === 'ondemand_viewport' && pending?.sync_mode === 'ondemand_viewport'
        ? Math.max(-3600, Math.min(3600, Number(pending.scroll_delta || 0) + Number(jobData.scroll_delta || 0)))
        : jobData.scroll_delta;
      this.pendingThreadSyncs.set(key, { ...jobData, scroll_delta: combinedScrollDelta, reason: `${reason}_replay` });
      const deferredBy = this.threadInFlight.has(key) ? 'in_flight' : 'cooldown';
      console.log(`[INBOX_SYNC_MESSAGES_DEFER] account=${accId} thread=${threadId} reason=${reason} defer=${deferredBy}`);
      if (deferredBy === 'cooldown') {
        const timer = setTimeout(() => this.replayPendingThread(key), Math.max(25, cooldownUntil - now));
        if (typeof timer.unref === 'function') timer.unref();
      }
      return false;
    }

    const queue = this.threadQueues.get(accId) || [];
    const existingIndex = queue.findIndex(job => job.key === key);
    if (existingIndex >= 0) {
      const existing = queue[existingIndex];
      const combinedScrollDelta = sync_mode === 'ondemand_viewport' && existing.sync_mode === 'ondemand_viewport'
        ? Math.max(-3600, Math.min(3600, Number(existing.scroll_delta || 0) + Number(jobData.scroll_delta || 0)))
        : jobData.scroll_delta;
      queue[existingIndex] = { key, ...jobData, scroll_delta: combinedScrollDelta };
      console.log(`[INBOX_SYNC_MESSAGES_COALESCED] account=${accId} thread=${threadId} reason=${reason}`);
      return false;
    }

    if (priority === 'high') queue.unshift({ key, ...jobData });
    else queue.push({ key, ...jobData });
    this.threadQueues.set(accId, queue);
    this.threadCooldownUntil.set(key, now + this.threadCooldownMs);
    console.log(`[INBOX_SYNC_MESSAGES_QUEUED] account=${accId} thread=${threadId} reason=${reason} queue_depth=${queue.length}`);
    this.drainThreadQueue(accId);
    return true;
  }

  clearQueuedThreadSyncs(accountId, predicate = () => true) {
    const accId = String(accountId || '');
    const queue = this.threadQueues.get(accId) || [];
    const removedJobs = queue.filter(predicate);
    if (removedJobs.length === 0) return 0;
    this.threadQueues.set(accId, queue.filter((job) => !predicate(job)));
    for (const job of removedJobs) this.pendingThreadSyncs.delete(job.key);
    console.log(`[INBOX_SYNC_MESSAGES_CLEARED] account=${accId} removed=${removedJobs.length}`);
    return removedJobs.length;
  }

  clearPendingThreadSyncs(accountId, predicate = () => true) {
    const accId = String(accountId || '');
    let removed = 0;
    for (const [key, job] of [...this.pendingThreadSyncs.entries()]) {
      if (!key.startsWith(`${accId}:`) || !predicate(job)) continue;
      this.pendingThreadSyncs.delete(key);
      removed += 1;
    }
    if (removed) console.log(`[INBOX_SYNC_MESSAGES_PENDING_CLEARED] account=${accId} removed=${removed}`);
    return removed;
  }

  preemptActiveThreadSync(accountId, predicate = () => true) {
    const accId = String(accountId || '');
    let removed = 0;
    for (const key of [...this.threadInFlight]) {
      if (!key.startsWith(`${accId}:`)) continue;
      const threadId = key.slice(accId.length + 1);
      const activeJob = { key, account_id: accId, thread_id: threadId };
      if (!predicate(activeJob)) continue;
      this.threadInFlight.delete(key);
      const timeout = this.threadTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.threadTimeouts.delete(key);
      this.pendingThreadSyncs.delete(key);
      removed += 1;
    }
    if (removed) {
      this.accountThreadBusy.delete(accId);
      console.log(`[INBOX_SYNC_MESSAGES_PREEMPTED] account=${accId} removed=${removed}`);
    }
    return removed;
  }

  isAccountThreadBusy(accountId) {
    return this.accountThreadBusy.has(String(accountId || ''));
  }

  drainThreadQueue(accountId) {
    const accId = String(accountId || '');
    if (!accId || this.accountThreadBusy.has(accId)) return;

    const queue = this.threadQueues.get(accId) || [];
    const job = queue.shift();
    if (!job) return;
    this.threadQueues.set(accId, queue);

    this.accountThreadBusy.add(accId);
    this.threadInFlight.add(job.key);
    console.log(`[INBOX_SYNC_MESSAGES_DISPATCHED] account=${accId} thread=${job.thread_id} reason=${job.reason} remaining_queue=${queue.length}`);

    const dispatched = this.dispatchThreadMessagesSync({
      account_id: job.account_id,
      thread_id: job.thread_id,
      external_thread_id: job.external_thread_id,
      thread_url: job.thread_url,
      page_id: job.page_id,
      contact_name: job.contact_name,
      reason: job.reason,
      sync_mode: job.sync_mode,
      scroll_delta: job.scroll_delta,
      allow_navigation: job.allow_navigation === true,
      force: false
    });

    if (!dispatched) {
      this.threadInFlight.delete(job.key);
      this.accountThreadBusy.delete(accId);
      // A user can select a blank thread while Chrome/the extension is still
      // reconnecting. Retain that explicit request instead of silently losing
      // it; replay is cancelled naturally if the operator selects another chat.
      const retryCount = (job.retry_count || 0) + 1;
      if (retryCount <= 5) {
        const cleanReason = String(job.reason || '').includes('_extension_replay')
          ? job.reason
          : `${job.reason}_extension_replay`;
        this.pendingThreadSyncs.set(job.key, { ...job, retry_count: retryCount, reason: cleanReason });
        const retryTimer = setTimeout(() => this.replayPendingThread(job.key), 1000);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
      } else {
        this.pendingThreadSyncs.delete(job.key);
        console.warn(`[INBOX_SYNC_MESSAGES_ABORT] account=${accId} thread=${job.thread_id} reason=${job.reason} max_retries_exceeded`);
      }
      setTimeout(() => this.drainThreadQueue(accId), 250);
      return;
    }

    const timeout = setTimeout(() => {
      this.threadTimeouts.delete(job.key);
      if (this.threadInFlight.delete(job.key)) {
        this.accountThreadBusy.delete(accId);
        console.warn(`[INBOX_SYNC_MESSAGES_TIMEOUT] account=${accId} thread=${job.thread_id} timeout_ms=${this.threadTimeoutMs}`);
        this.replayPendingThread(job.key);
        this.drainThreadQueue(accId);
        const sidebarState = this.accounts.get(accId);
        if (sidebarState?.pending) this.requestSidebarSync(accId, 'thread_timeout_replay', { force: true });
      }
    }, this.threadTimeoutMs);
    this.threadTimeouts.set(job.key, timeout);
    if (typeof timeout.unref === 'function') timeout.unref();
  }

  replayPendingThread(key) {
    const pending = this.pendingThreadSyncs.get(key);
    if (!pending || this.threadInFlight.has(key)) return false;
    const cooldownUntil = this.threadCooldownUntil.get(key) || 0;
    if (Date.now() < cooldownUntil) {
      const timer = setTimeout(() => this.replayPendingThread(key), Math.max(25, cooldownUntil - Date.now()));
      if (typeof timer.unref === 'function') timer.unref();
      return false;
    }
    this.pendingThreadSyncs.delete(key);
    return this.enqueueThreadSync(pending);
  }

  markThreadSyncResult(accountId, threadId, reason = null) {
    const accId = String(accountId || '');
    const key = `${accId}:${String(threadId || '')}`;
    if (this.threadInFlight.delete(key)) {
      const timeout = this.threadTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.threadTimeouts.delete(key);
      this.accountThreadBusy.delete(accId);
      console.log(`[INBOX_SYNC_MESSAGES_RESULT] account=${accountId} thread=${threadId}${reason ? ` reason=${reason}` : ''}`);
      this.replayPendingThread(key);
      const timer = setTimeout(() => {
        this.drainThreadQueue(accId);
        const sidebarState = this.accounts.get(accId);
        if (!this.accountThreadBusy.has(accId) && sidebarState?.pending) {
          this.requestSidebarSync(accId, 'thread_result_replay', { force: true });
        }
      }, 25);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

const inboxSyncScheduler = new InboxSyncScheduler();
inboxSyncScheduler.InboxSyncScheduler = InboxSyncScheduler;
module.exports = inboxSyncScheduler;
