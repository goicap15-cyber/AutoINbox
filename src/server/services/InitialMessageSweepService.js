'use strict';

// Fast, bounded bootstrap for conversation contents. It deliberately owns no
// browser logic: all navigation remains serialized by InboxSyncScheduler per lane
// (Page Business Suite tab or isolated Personal history tab).
class InitialMessageSweepService {
  constructor({ tickMs = 600, jitterMs = 250, userQuietMs = 15000, startDelayMs = 250 } = {}) {
    this.tickMs = tickMs;
    this.jitterMs = jitterMs;
    this.userQuietMs = userQuietMs;
    this.startDelayMs = startDelayMs;
    this.states = new Map();
    this.accountLanes = new Map();
    this.callbacks = {};
  }

  configure(callbacks) {
    this.callbacks = callbacks || {};
  }

  _getLaneKey(thread, accountId) {
    if (thread?.page_id) return `page:${thread.page_id}`;
    return `personal:${accountId}`;
  }

  start(accountId, { force = false } = {}) {
    const accId = String(accountId || '');
    if (!accId || !this.callbacks.listThreads || !this.callbacks.enqueue) return false;

    const allThreads = this.callbacks.listThreads(accId) || [];
    if (!Array.isArray(allThreads)) return false;

    // Group threads into lanes (page:<page_id> or personal:<accId>)
    const threadsByLane = new Map();
    for (const thread of allThreads) {
      const laneKey = this._getLaneKey(thread, accId);
      if (!threadsByLane.has(laneKey)) threadsByLane.set(laneKey, []);
      threadsByLane.get(laneKey).push(thread);
    }

    if (threadsByLane.size === 0) {
      const defaultLane = `personal:${accId}`;
      threadsByLane.set(defaultLane, []);
    }

    const laneSet = this.accountLanes.get(accId) || new Set();
    this.accountLanes.set(accId, laneSet);

    let anyRunning = false;

    for (const [laneKey, threads] of threadsByLane.entries()) {
      laneSet.add(laneKey);
      const old = this.states.get(laneKey);

      if (force && old?.timer) {
        clearTimeout(old.timer);
      }

      const processed = (force || !old) ? new Set() : (old.processedIds || new Set());
      const queuedIds = new Set((old?.queue || []).map(t => String(t.id)));

      // If lane is currently running, append any newly discovered threads
      if (old?.running && !force) {
        const newThreads = threads.filter(t => !processed.has(String(t.id)) && !queuedIds.has(String(t.id)));
        if (newThreads.length > 0) {
          old.queue.push(...newThreads);
          this._emit(laneKey);
        }
        anyRunning = true;
        continue;
      }

      // If lane completed, filter for threads not yet processed in this session
      const pendingThreads = force
        ? threads.slice()
        : threads.filter(t => !processed.has(String(t.id)));

      if (old?.completed && !force && pendingThreads.length === 0) {
        continue;
      }

      if (old?.timer) clearTimeout(old.timer);

      // Priority sort within the lane:
      // 1. Unread threads first
      // 2. Threads with 0 messages first
      // 3. Most recent activity first
      const sortedQueue = pendingThreads.slice().sort((a, b) => {
        const aUnread = a.is_unread ? 1 : 0;
        const bUnread = b.is_unread ? 1 : 0;
        if (aUnread !== bUnread) return bUnread - aUnread;

        const aEmpty = (a.message_count === 0 || a.message_count === '0') ? 1 : 0;
        const bEmpty = (b.message_count === 0 || b.message_count === '0') ? 1 : 0;
        if (aEmpty !== bEmpty) return bEmpty - aEmpty;

        return (b.last_activity || 0) - (a.last_activity || 0);
      });

      const state = {
        accountId: accId,
        laneKey,
        running: sortedQueue.length > 0,
        completed: sortedQueue.length === 0,
        queue: sortedQueue,
        processedIds: processed,
        done: (old && !force) ? Number(old.done || 0) : 0,
        suspendedUntil: (old && !force) ? Number(old.suspendedUntil || 0) : 0,
        force: Boolean(force),
        timer: null
      };

      this.states.set(laneKey, state);
      this._emit(laneKey);

      if (state.running) {
        anyRunning = true;
        this._schedule(laneKey, this.startDelayMs);
      }
    }

    return anyRunning;
  }

  noteUserActivity(accountId, laneKey = null) {
    const accId = String(accountId || '');
    if (laneKey) {
      const state = this.states.get(String(laneKey));
      if (state) state.suspendedUntil = Date.now() + this.userQuietMs;
      return;
    }
    const lanes = this.accountLanes.get(accId);
    if (lanes) {
      for (const lk of lanes) {
        const state = this.states.get(lk);
        if (state) state.suspendedUntil = Date.now() + this.userQuietMs;
      }
    }
    const directState = this.states.get(accId);
    if (directState) directState.suspendedUntil = Date.now() + this.userQuietMs;
  }

  stop(accountId, laneKey = null) {
    const accId = String(accountId || '');
    if (laneKey) {
      const state = this.states.get(String(laneKey));
      if (state?.timer) clearTimeout(state.timer);
      this.states.delete(String(laneKey));
      return;
    }
    const lanes = this.accountLanes.get(accId);
    if (lanes) {
      for (const lk of lanes) {
        const state = this.states.get(lk);
        if (state?.timer) clearTimeout(state.timer);
        this.states.delete(lk);
      }
      this.accountLanes.delete(accId);
    }
    const directState = this.states.get(accId);
    if (directState?.timer) clearTimeout(directState.timer);
    this.states.delete(accId);
  }

  _schedule(laneKey, delayMs) {
    const state = this.states.get(laneKey);
    if (!state?.running) return;
    const jitter = this.jitterMs ? Math.floor(Math.random() * this.jitterMs) : 0;
    state.timer = setTimeout(() => this._tick(laneKey), Math.max(0, delayMs) + jitter);
    state.timer.unref?.();
  }

  _tick(laneKey) {
    const state = this.states.get(laneKey);
    if (!state?.running) return;
    state.timer = null;

    // 2026-09-30 (Phase 1 - plan dom-fast-sync): bỏ qua thread không có gì mới
    // - preview sidebar trùng tin cuối đã lưu. Xử lý loạt ngay tại đây để các
    // thread bị skip không tốn tick 600ms/thread. `force` bỏ qua bộ lọc này
    // (operator yêu cầu sync đầy đủ thì quét hết).
    if (!state.force && typeof this.callbacks.shouldSkipSweep === 'function') {
      while (state.queue.length > 0) {
        let skip = false;
        try { skip = this.callbacks.shouldSkipSweep(state.queue[0], state.accountId) === true; } catch (_) { skip = false; }
        if (!skip) break;
        const skipped = state.queue.shift();
        state.done += 1;
        state.processedIds?.add(String(skipped.id));
      }
      this._emit(laneKey);
    }

    if (state.queue.length === 0) {
      state.running = false;
      state.completed = true;
      this._emit(laneKey);
      return;
    }
    const isBusy = this.callbacks.isBusy?.(laneKey, state.accountId);
    const isReady = this.callbacks.isReady?.(state.accountId);
    if (Date.now() < state.suspendedUntil || isBusy || !isReady) {
      this._schedule(laneKey, this.tickMs);
      return;
    }
    const thread = state.queue.shift();
    const accepted = this.callbacks.enqueue({
      account_id: state.accountId,
      lane_key: laneKey,
      thread_id: thread.id,
      external_thread_id: thread.external_thread_id || thread.id,
      thread_url: thread.thread_url || null,
      page_id: thread.page_id || null,
      contact_name: thread.contact_name || null,
      reason: 'initial_sweep',
      allow_navigation: true,
      sync_mode: 'initial'
    });
    if (!accepted) {
      state.queue.unshift(thread);
    } else {
      state.done += 1;
      state.processedIds?.add(String(thread.id));
    }
    this._emit(laneKey);
    this._schedule(laneKey, this.tickMs);
  }

  _emit(laneKey) {
    const state = this.states.get(laneKey);
    if (!state) return;
    this.callbacks.emit?.({
      account_id: state.accountId,
      lane_key: laneKey,
      status: state.running ? 'running' : 'completed',
      total: state.done + state.queue.length,
      done: state.done,
      remaining: state.queue.length
    });
  }
}

module.exports = new InitialMessageSweepService();
module.exports.InitialMessageSweepService = InitialMessageSweepService;
