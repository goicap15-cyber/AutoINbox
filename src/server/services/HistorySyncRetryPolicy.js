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

// Phase 1 (ke hoach 2026-10-01): khi guard navigated_away chan mot retry,
// thay vi huy mat trang thi goi handler do server.js wire qua configure() de
// re-queue thread ve DUOI hang doi quet (reason history_retry - khong phai
// user-driven nen tu dong xep cuoi). Cap so lan moi thread de thread loi
// cuu huong khong lap vo han; nguoi den luot quet that (retry fire) thi
// reset ngan sach.
const MAX_NAVIGATED_AWAY_REQUEUES = 3;
const navigatedAwayRequeues = new Map(); // thread_id -> so lan da re-queue
let navigatedAwayRequeueHandler = null;

class HistorySyncRetryPolicy {
  // server.js wire: onNavigatedAwayRequeue(accountId, threadId) -> enqueueThreadSync.
  static configure({ onNavigatedAwayRequeue } = {}) {
    navigatedAwayRequeueHandler = typeof onNavigatedAwayRequeue === 'function' ? onNavigatedAwayRequeue : null;
  }

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

  static scheduleRetry(accountId, threadId, retryFn, customBackoffMs = null, skipNavigatedAwayGuard = false) {
    const accId = String(accountId || '');
    const tId = String(threadId || '');
    if (!accId || !tId) return false;

    // Lock-window rejections (navigation_locked_by_user_selection, ...) need
    // their first attempt to land after the extension's 30s navigation lock
    // expires, so callers can pass a per-reason backoff schedule.
    const backoff = Array.isArray(customBackoffMs) && customBackoffMs.length > 0
      ? customBackoffMs
      : BACKOFF_MS;
    const maxAttempts = backoff.length;

    const state = retryState.get(tId) || { attempts: 0, timer: null, skipNavigatedAwayGuard };
    if (state.attempts >= maxAttempts) {
      console.warn(`[HISTORY_SYNC_RETRY_EXHAUSTED] thread=${tId} attempts=${state.attempts}`);
      retryState.delete(tId);
      return false;
    }

    const delay = backoff[state.attempts];
    state.attempts += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const current = retryState.get(tId);
      if (!current) return; // cancelled in the meantime

      // Background syncs of threads the operator is NOT viewing must not die
      // just because the operator clicked some other thread in the CRM - the
      // extension's own 30s navigation lock already protects the clicked
      // thread, and a retry that still lands inside that window is simply
      // rejected again and escalates to the next backoff attempt.
      if (!current.skipNavigatedAwayGuard
        && latestThreadByAccount.has(accId)
        && latestThreadByAccount.get(accId) !== tId) {
        // Phase 1 (2026-10-01): re-queue thay vi huy - job roi vao hang doi
        // quet nen se duoc thu lai khi operator ranh tay, khong bi mat trang.
        const requeues = navigatedAwayRequeues.get(tId) || 0;
        if (typeof navigatedAwayRequeueHandler === 'function' && requeues < MAX_NAVIGATED_AWAY_REQUEUES) {
          navigatedAwayRequeues.set(tId, requeues + 1);
          retryState.delete(tId);
          console.log(`[HISTORY_SYNC_RETRY_REQUEUED] thread=${tId} reason=navigated_away requeue=${requeues + 1}/${MAX_NAVIGATED_AWAY_REQUEUES}`);
          try {
            navigatedAwayRequeueHandler(accId, tId);
          } catch (err) {
            console.error(`[HISTORY_SYNC_RETRY_REQUEUE_ERROR] thread=${tId}:`, err.message);
          }
          return;
        }
        console.log(`[HISTORY_SYNC_RETRY_SKIPPED] thread=${tId} reason=navigated_away requeues_exhausted=${requeues}`);
        retryState.delete(tId);
        return;
      }

      // Retry fire that = mot luot quet that xay ra; reset ngan sach re-queue
      // cua thread de chu ky fail-moi sau nay van duoc cuu neu guard chan tiep.
      navigatedAwayRequeues.delete(tId);
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
    navigatedAwayRequeues.clear();
  }
}

module.exports = HistorySyncRetryPolicy;
