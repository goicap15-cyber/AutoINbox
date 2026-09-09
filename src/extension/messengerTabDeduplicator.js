(function initMessengerTabDeduplicator(root) {
  function isMessagesUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return /(^|\.)facebook\.com$/i.test(parsed.hostname)
        && /^\/messages(?:\/|$)/i.test(parsed.pathname)
        && !/^\/groupcall(?:\/|$)/i.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function planMessengerTabs(tabs, keeperTabId = null) {
    const messengerTabs = (Array.isArray(tabs) ? tabs : []).filter((tab) =>
      tab && tab.id != null && isMessagesUrl(tab.url || tab.pendingUrl)
    );
    if (messengerTabs.length === 0) return { keeper: null, duplicateTabIds: [] };
    const keeper = messengerTabs.find((tab) => String(tab.id) === String(keeperTabId)) || messengerTabs[0];
    return {
      keeper,
      duplicateTabIds: messengerTabs.filter((tab) => tab.id !== keeper.id).map((tab) => tab.id)
    };
  }

  const api = { isMessagesUrl, planMessengerTabs };
  root.MessengerTabDeduplicator = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
