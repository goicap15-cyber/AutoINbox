// Bounded auto-retry for transient history-sync DOM failures
// (marker_mismatch, sidebar_mismatch, no_rows, no_main_container).
//
// Must NOT reintroduce the bug server.js's THREAD_MESSAGES_SYNCED handler
// comment warns about: a delayed retry also performs tab navigation, so if
// the operator has already clicked a different thread, firing the old retry
// would yank Messenger back to the stale thread. noteManualRequest() tracks
// the latest thread requested per account and cancels any pending retry for
// a thread that is no longer the one the operator is looking at.

const BACKOFF_MS = [2000, 6000, 15000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

const retryState = new Map(); // thread_id -> { attempts, timer }
const latestThreadByAccount = new Map(); // account_id -> thread_id

class HistorySyncRetryPolicy {
  static noteManualRequest(accountId, threadId) {
    const accId = String(accountId || '');
    const tId = String(threadId || '');
    if (!accId || !tId) return;

    const prevThreadId = latestThreadByAccount.get(accId);
    latestThreadByAccount.set(accId, tId);
    if (prevThreadId && prevThreadId !== tId) {
      HistorySyncRetryPolicy.cancelRetry(prevThreadId);
    }
    // A fresh manual request for the same thread also supersedes any retry already pending for it.
    HistorySyncRetryPolicy.cancelRetry(tId);
  }

  static scheduleRetry(accountId, threadId, retryFn) {
    const accId = String(accountId || '');
    const tId = String(threadId || '');
    if (!accId || !tId) return false;

    const state = retryState.get(tId) || { attempts: 0, timer: null };
    if (state.attempts >= MAX_ATTEMPTS) {
      console.warn(`[HISTORY_SYNC_RETRY_EXHAUSTED] thread=${tId} attempts=${state.attempts}`);
      retryState.delete(tId);
      return false;
    }

    const delay = BACKOFF_MS[state.attempts];
    state.attempts += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const current = retryState.get(tId);
      if (!current) return; // cancelled in the meantime

      if (latestThreadByAccount.has(accId) && latestThreadByAccount.get(accId) !== tId) {
        console.log(`[HISTORY_SYNC_RETRY_SKIPPED] thread=${tId} reason=navigated_away`);
        retryState.delete(tId);
        return;
      }

      console.log(`[HISTORY_SYNC_RETRY_FIRE] thread=${tId} attempt=${current.attempts}/${MAX_ATTEMPTS}`);
      try {
        retryFn();
      } catch (err) {
        // A fire-and-forget setTimeout has no caller to catch this - letting it
        // escape would crash the whole server process (this is exactly how the
        // cursor-not-defined bug during initial rollout took the server down).
        console.error(`[HISTORY_SYNC_RETRY_ERROR] thread=${tId}:`, err.message);
      }
    }, delay);
    if (typeof state.timer.unref === 'function') state.timer.unref();

    retryState.set(tId, state);
    console.log(`[HISTORY_SYNC_RETRY_SCHEDULED] thread=${tId} attempt=${state.attempts}/${MAX_ATTEMPTS} delay_ms=${delay}`);
    return true;
  }

  static cancelRetry(threadId) {
    const tId = String(threadId || '');
    const state = retryState.get(tId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    retryState.delete(tId);
  }

  // Exposed for tests only.
  static _reset() {
    for (const state of retryState.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    retryState.clear();
    latestThreadByAccount.clear();
  }
}

module.exports = HistorySyncRetryPolicy;
