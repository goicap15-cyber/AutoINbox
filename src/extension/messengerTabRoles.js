(function initMessengerTabRoles(root) {
  const PERSONAL_ROLES = ['interaction', 'discovery', 'history', 'requests', 'request_action'];

  function roleKey(accountId, role) {
    if (!PERSONAL_ROLES.includes(role)) throw new Error(`Unknown Messenger tab role: ${role}`);
    return `personal:${String(accountId)}:${role}`;
  }

  function legacyInteractionKey(accountId) {
    return `personal:${String(accountId)}`;
  }

  function roleForTab(registryEntries, accountId, tabId) {
    const targetId = String(tabId);
    const entries = Array.isArray(registryEntries) ? registryEntries : [];
    for (const [key, value] of entries) {
      if (String(value) !== targetId) continue;
      if (key === legacyInteractionKey(accountId) || key === roleKey(accountId, 'interaction')) return 'interaction';
      if (key === roleKey(accountId, 'discovery')) return 'discovery';
      if (key === roleKey(accountId, 'history')) return 'history';
      if (key === roleKey(accountId, 'requests')) return 'requests';
      if (key === roleKey(accountId, 'request_action')) return 'request_action';
    }
    return null;
  }

  function canForwardRealtime(role) {
    // Discovery is also a live Messenger surface. It is commonly the first
    // loaded tab after startup, before an outbound action creates/promotes the
    // interaction tab. History/request workers stay excluded (they replay rows).
    return role === 'interaction' || role === 'discovery';
  }

  function canForwardIncomingRealtime(role) {
    // A history tab is also the active DOM surface used by on-demand CRM
    // navigation. It may forward only confirmed incoming observations; its
    // outgoing/history rows remain blocked by canForwardRealtime above.
    return canForwardRealtime(role) || role === 'history';
  }

  function canForwardCallRealtime(role) {
    return role === 'interaction' || role === 'discovery';
  }

  const api = { PERSONAL_ROLES, roleKey, legacyInteractionKey, roleForTab, canForwardRealtime, canForwardIncomingRealtime, canForwardCallRealtime };
  root.FbCrmMessengerTabRoles = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
