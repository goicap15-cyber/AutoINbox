class CallEventDeduplicator {
  constructor({ outgoingCooldownMs = 10000, incomingCooldownMs = 2000 } = {}) {
    this.outgoingCooldownMs = outgoingCooldownMs;
    this.incomingCooldownMs = incomingCooldownMs;
    this.outgoing = new Map();
    this.incoming = new Map();
  }

  claimOutgoing({ accountId, threadId, callType = 'audio' }, now = Date.now()) {
    const key = `${accountId || ''}|${threadId || ''}|${callType}`;
    return this.#claim(this.outgoing, key, this.outgoingCooldownMs, now);
  }

  claimIncoming({ threadId, callerName }, now = Date.now()) {
    const normalizedCaller = String(callerName || '').trim().toLocaleLowerCase('vi-VN');
    const key = String(threadId || '').trim() || normalizedCaller || 'unknown';
    return this.#claim(this.incoming, key, this.incomingCooldownMs, now);
  }

  #claim(store, key, cooldownMs, now) {
    const previous = store.get(key) || 0;
    if (now - previous < cooldownMs) return false;
    store.set(key, now);
    for (const [storedKey, timestamp] of store) {
      if (now - timestamp > cooldownMs * 2) store.delete(storedKey);
    }
    return true;
  }
}

module.exports = CallEventDeduplicator;
