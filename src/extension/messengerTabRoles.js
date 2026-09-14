(function initMessengerTabRoles(root) {
  const PERSONAL_ROLES = ['chat', 'campaign', 'interaction', 'discovery', 'history', 'requests', 'request_action'];

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
      if (key === roleKey(accountId, 'campaign')) return 'campaign';
      if (key === roleKey(accountId, 'history')) return 'history';
      if (key === roleKey(accountId, 'requests')) return 'requests';
      if (key === roleKey(accountId, 'request_action')) return 'request_action';
      if (key === roleKey(accountId, 'discovery')) return 'discovery';
      if (key === roleKey(accountId, 'chat') || key === legacyInteractionKey(accountId) || key === roleKey(accountId, 'interaction')) return 'chat';
    }
    return null;
  }

  function canForwardRealtime(role) {
    // Only the dedicated chat surface (plus discovery's sidebar observer) may
    // forward live messages. Campaign/history tabs remount or navigate rows.
    return role === 'chat' || role === 'interaction' || role === 'discovery';
  }

  function canForwardIncomingRealtime(role) {
    return canForwardRealtime(role);
  }

  function canForwardCallRealtime(role) {
    return role === 'chat' || role === 'interaction' || role === 'discovery';
  }

  const api = { PERSONAL_ROLES, roleKey, legacyInteractionKey, roleForTab, canForwardRealtime, canForwardIncomingRealtime, canForwardCallRealtime };
  root.FbCrmMessengerTabRoles = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);