(function initCallTabDeduplicator(root) {
  function isGroupCallUrl(url) {
    return /facebook\.com\/groupcall\//i.test(String(url || ''));
  }

  function planGroupCallTabs(tabs, keeperTabId = null, preferredWindowIds = []) {
    const callTabs = (Array.isArray(tabs) ? tabs : []).filter((tab) =>
      tab && tab.id != null && isGroupCallUrl(tab.url || tab.pendingUrl)
    );
    if (callTabs.length === 0) return { keeper: null, duplicateTabIds: [] };

    const preferred = new Set(preferredWindowIds || []);
    const keeper = callTabs.find((tab) => String(tab.id) === String(keeperTabId))
      || callTabs.find((tab) => preferred.has(tab.windowId))
      || callTabs[0];

    return {
      keeper,
      duplicateTabIds: callTabs
        .filter((tab) => String(tab.id) !== String(keeper.id))
        .map((tab) => tab.id)
    };
  }

  const api = { isGroupCallUrl, planGroupCallTabs };
  root.CallTabDeduplicator = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
