/* FbCrmTabAudit - pure classifier for tab hygiene.
 *
 * Reproduce 2026-09-29: sau mot ngay debug/reload, Chrome tich tu 8 tab -
 * 3 tab Business Suite (1/page, BY DESIGN cho co che activate-tab), 2 tab
 * "(13) Messenger | Facebook" trung lap, va cac tab facebook.com loai k.
 * Nguon goc: cac duong tao tab (ensureRoleMessengerTab, page sync, sidebar
 * window) chi reuse khi registry role con song; registry stale/thieu thi
 * tao moi -> trung lap tich tu.
 *
 * Chinh sach (user duyet 2026-09-29):
 *  - GIU: tab page (1/page, uu tien tab dang registry role page:* hoac active),
 *    tab messenger ca nhan da registry role lam viec (history/chat/campaign/
 *    request_action), tab nguoi dung tu mo (khong khop pattern).
 *  - DONG: tab messenger/trang messages KHONG registry (leftover), tab
 *    discovery/requests da registry (be mat transient, flow tu tao lai),
 *    tab BS trung lap cung page.
 *  - KHONG DONG: tab active cua bat ky window nao (chi dong sau khi keeper
 *    duoc activate - do background ap dung), tab khong khop pattern (cua
 *    nguoi dung), marker tabs (TTL rieng).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbCrmTabAudit = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BS_INBOX_RE = /business\.facebook\.com\/(?:latest\/inbox|inbox)/i;
  var MESSENGER_RE = /(?:^|\.)messenger\.com/i;
  var FB_MESSAGES_RE = /facebook\.com\/messages/i;

  function pageKeyOf(url) {
    const m = String(url || '').match(/[?&](?:asset_id|mailbox_id)=(\d+)/);
    return m ? m[1] : null;
  }

  // Registry key dạng "acc_1:history" / "page:768..." -> tách tên role cuối.
  function roleNameOf(key) {
    const s = String(key || '');
    if (s.startsWith('page:')) return 'page';
    const idx = s.lastIndexOf(':');
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  function categoryOf(url) {
    const u = String(url || '');
    if (BS_INBOX_RE.test(u)) return 'bs_inbox';
    if (MESSENGER_RE.test(u) || FB_MESSAGES_RE.test(u)) return 'messenger';
    return 'other';
  }

  // Luật ổn định cho group messenger: các role làm việc thực sự.
  var PERSONAL_KEEP_ROLES = new Set(['history', 'chat', 'campaign', 'request_action', 'send']);
  // Role tạm (bề mặt đắt, đóng khi rảnh - flow tự mở lại khi cần).
  var PERSONAL_TRANSIENT_ROLES = new Set(['discovery', 'requests']);

  function classifyTabsForAudit(options) {
    const tabs = Array.isArray(options && options.tabs) ? options.tabs : [];
    const registry = (options && options.registry) || {};
    const protectedIds = new Set((options && options.protectedIds) || []);

    // role -> tabId (chỉ giữ role có tab tồn tại thật)
    const rolesByTabId = new Map();
    const roleOwner = {};
    for (const role of Object.keys(registry)) {
      const tabId = Number(registry[role]);
      if (!Number.isFinite(tabId)) continue;
      rolesByTabId.set(tabId, role);
      (roleOwner[role] = roleOwner[role] || tabId);
    }

    const keepIds = [];
    const closeIds = [];

    // Nhóm BS inbox theo page; messenger gộp chung một nhóm.
    const bsByPage = new Map();
    let messengerSeenKeeper = false;
    const messengerCandidates = [];

    // Pass 1: xác định keeper cho từng nhóm.
    for (const tab of tabs) {
      const cat = categoryOf(tab.url);
      if (cat === 'other' || protectedIds.has(tab.id)) continue;
      const roleKey = rolesByTabId.get(tab.id) || null;
      const roleName = roleKey ? roleNameOf(roleKey) : null;
      if (cat === 'bs_inbox') {
        const key = pageKeyOf(tab.url) || 'home';
        if (!bsByPage.has(key)) bsByPage.set(key, []);
        bsByPage.get(key).push({ tab, role: roleKey });
      } else if (cat === 'messenger') {
        if (roleName && PERSONAL_KEEP_ROLES.has(roleName)) {
          keepIds.push(tab.id);
          messengerSeenKeeper = true;
        } else {
          messengerCandidates.push({ tab, roleName, role: roleKey });
        }
      }
    }

    // Pass 2: BS inbox - mỗi page giữ 1 tab (ưu tiên registry > active > cũ nhất).
    for (const [, group] of bsByPage) {
      if (group.length === 0) continue;
      const registered = group.find((g) => g.role && String(g.role).startsWith('page:'));
      const active = group.find((g) => g.tab.active);
      const sorted = group.slice().sort((a, b) => a.tab.id - b.tab.id);
      const keeper = registered ? registered.tab : (active ? active.tab : sorted[0].tab);
      keepIds.push(keeper.id);
      for (const g of group) {
        if (g.tab.id !== keeper.id && !protectedIds.has(g.tab.id)) closeIds.push(g.tab.id);
      }
      void sorted;
    }

    // Pass 3: messenger - nếu chưa có keeper làm việc nào, chọn 1 candidate
    // (ưu tiên active) làm keeper; còn lại toàn bộ đóng (gồm transient role).
    if (messengerCandidates.length > 0) {
      if (!messengerSeenKeeper) {
        const active = messengerCandidates.find((c) => c.tab.active);
        const keeper = active ? active.tab : messengerCandidates[0].tab;
        keepIds.push(keeper.id);
        messengerSeenKeeper = true;
        messengerCandidates.splice(messengerCandidates.indexOf(messengerCandidates.find((c) => c.tab.id === keeper.id)), 1);
      }
      for (const c of messengerCandidates) {
        const isTransientRole = c.roleName && PERSONAL_TRANSIENT_ROLES.has(c.roleName);
        const unregistered = !c.role;
        if (c.tab.active && !isTransientRole) { keepIds.push(c.tab.id); continue; } // không đóng tab user đang nhìn
        if (unregistered || isTransientRole) closeIds.push(c.tab.id);
        else keepIds.push(c.tab.id); // role làm việc khác -> giữ
      }
    }

    return { keepIds, closeIds };
  }

  return { classifyTabsForAudit, categoryOf, pageKeyOf };
});
