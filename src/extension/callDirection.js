(function initCallDirection(root) {
  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // Returns null when the label does not identify an owner. A named sender is
  // always the contact; Facebook uses "Bạn"/"You" for the logged-in account.
  function directionFromAccessibilityLabel(label) {
    const value = normalize(label);
    if (!value) return null;

    if (/Tin nhắn do (?:Bạn|You) gửi|Message sent by you|You sent/i.test(value)) return true;
    if (/Tin nhắn do .+? gửi|Message sent by .+?(?: at|$)/i.test(value)) return false;

    const timedSender = value.match(/^Lúc\s+.+?,\s*(.+?):/i);
    if (timedSender) return /^(?:Bạn|You)$/i.test(normalize(timedSender[1]));
    return null;
  }

  root.FbCrmCallDirection = { directionFromAccessibilityLabel };
  if (typeof module === 'object' && module.exports) module.exports = root.FbCrmCallDirection;
})(typeof globalThis !== 'undefined' ? globalThis : this);
