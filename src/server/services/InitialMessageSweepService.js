'use strict';

// Fast, bounded bootstrap for conversation contents. It deliberately owns no
// browser logic: all navigation remains serialized by InboxSyncScheduler and
// is performed in the extension's isolated `history` tab.
class InitialMessageSweepService {
  constructor({ tickMs = 600, jitterMs = 250, userQuietMs = 15000, startDelayMs = 250 } = {}) {
    this.tickMs = tickMs;
    this.jitterMs = jitterMs;
    this.userQuietMs = userQuietMs;
    this.startDelayMs = startDelayMs;
    this.states = new Map();
    this.callbacks = {};
  }

  configure(callbacks) {
    this.callbacks = callbacks || {};
  }

  start(accountId, { force = false } = {}) {
    const key = String(accountId || '');
    if (!key || !this.callbacks.listThreads || !this.callbacks.enqueue) return false;
    const old = this.states.get(key);
    if (old && !force && (old.running || old.completed)) return false;
    if (old?.timer) clearTimeout(old.timer);
    const queue = this.callbacks.listThreads(key) || [];
    const state = { running: queue.length > 0, completed: queue.length === 0, queue: queue.slice(), done: 0, suspendedUntil: 0, timer: null };
    this.states.set(key, state);
    this._emit(key);
    if (state.running) this._schedule(key, this.startDelayMs);
    return state.running;
  }

  noteUserActivity(accountId) {
    const state = this.states.get(String(accountId || ''));
    if (state) state.suspendedUntil = Date.now() + this.userQuietMs;
  }

  stop(accountId) {
    const key = String(accountId || '');
    const state = this.states.get(key);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(key);
  }

  _schedule(key, delayMs) {
    const state = this.states.get(key);
    if (!state?.running) return;
    const jitter = this.jitterMs ? Math.floor(Math.random() * this.jitterMs) : 0;
    state.timer = setTimeout(() => this._tick(key), Math.max(0, delayMs) + jitter);
    state.timer.unref?.();
  }

  _tick(key) {
    const state = this.states.get(key);
    if (!state?.running) return;
    state.timer = null;
    if (state.queue.length === 0) {
      state.running = false;
      state.completed = true;
      this._emit(key);
      return;
    }
    if (Date.now() < state.suspendedUntil || this.callbacks.isBusy?.(key) || !this.callbacks.isReady?.(key)) {
      this._schedule(key, this.tickMs);
      return;
    }
    const thread = state.queue.shift();
    const accepted = this.callbacks.enqueue({
      account_id: key,
      thread_id: thread.id,
      thread_url: thread.thread_url || null,
      page_id: thread.page_id || null,
      contact_name: thread.contact_name || null,
      reason: 'initial_sweep',
      allow_navigation: true
    });
    if (!accepted) state.queue.unshift(thread);
    else state.done += 1;
    this._emit(key);
    this._schedule(key, this.tickMs);
  }

  _emit(key) {
    const state = this.states.get(key);
    if (!state) return;
    this.callbacks.emit?.({ account_id: key, status: state.running ? 'running' : 'completed', total: state.done + state.queue.length, done: state.done, remaining: state.queue.length });
  }
}

module.exports = new InitialMessageSweepService();
module.exports.InitialMessageSweepService = InitialMessageSweepService;
