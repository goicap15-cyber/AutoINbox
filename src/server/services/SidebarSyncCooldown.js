// Cooldown so REGISTER_ACCOUNT churn from a repeatedly-restarted extension
// service worker (spec 042) doesn't cause a full sidebar SYNC_THREADS on every
// single restart, which would otherwise contend with an in-flight per-thread
// history sync for the same shared Messenger tab's DOM.

const DEFAULT_COOLDOWN_MS = 15000;

const cooldownUntilByAccount = new Map();

class SidebarSyncCooldown {
  // Returns true when a SYNC_THREADS was already dispatched for this account
  // recently enough that another one should be skipped.
  static isInCooldown(accountId, now, cooldownMap = cooldownUntilByAccount) {
    const accId = String(accountId || '');
    if (!accId) return false;
    return now < (cooldownMap.get(accId) || 0);
  }

  static markDispatched(accountId, now, cooldownMs = DEFAULT_COOLDOWN_MS, cooldownMap = cooldownUntilByAccount) {
    const accId = String(accountId || '');
    if (!accId) return;
    cooldownMap.set(accId, now + cooldownMs);
  }

  static remainingMs(accountId, now, cooldownMap = cooldownUntilByAccount) {
    const accId = String(accountId || '');
    return Math.max(0, (cooldownMap.get(accId) || 0) - now);
  }

  // Exposed for tests only.
  static _reset() {
    cooldownUntilByAccount.clear();
  }
}

module.exports = SidebarSyncCooldown;
