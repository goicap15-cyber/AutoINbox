/**
 * pageDiscovery.js
 * Module trích xuất và chuẩn hóa danh sách Fanpage mà tài khoản Facebook đang quản trị.
 * Hỗ trợ UMD: chạy trong Chrome Extension Service Worker, Content Script và Node.js unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageDiscovery = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Danh sách các chuỗi tĩnh generic cần loại bỏ khi bóc tách tên Page (chỉ loại bỏ nếu toàn bộ tên là từ khóa generic).
  // Bao gồm cả tiêu đề mục trong UI Facebook ("Quản lý trang", "Trang của bạn"...) - trước đây
  // các tiêu đề này bị quét nhầm thành 1 Page có ID 13 số, mở tab Business Suite thì
  // Facebook trả "Rất tiếc, nội dung này hiện không khả dụng".
  const GENERIC_EXCLUDE_REGEX = /^(?:facebook|messenger|trang|page|trang cá nhân|profile|hộp thư|inbox|bảng tin|feed|thông báo|notifications|cài đặt|settings|xem tất cả|see all|quản lý|manage|quản lý trang|trang của bạn|trang bạn quản lý|trang của tôi|tất cả trang|your pages|pages you manage|manage pages|my pages)$/i;

  // Facebook trả về Page ID dài khác nhau: legacy 15-16 chữ số, new-style 11-14 chữ số.
  // Chỉ lọc element UI ngắn ≤ 10 chữ số bị trích xuất nhầm.
  const PAGE_ID_REGEX = /\d{11,}/;

  // ID profile/delegate mới (14 chữ số đầu 6155-6159) không phải ID page thật:
  // Business Suite chặn asset_id dạng này ("nội dung này hiện không khả dụng").
  // Loại khỏi discovery để không tạo source/link sai.
  const SUSPICIOUS_PAGE_ID_REGEX = /^615[5-9]\d{10}$/;

  /**
   * Decode ký tự escape Unicode trong Facebook JSON/HTML (ví dụ \u003C -> <, \u0026 -> &)
   */
  function decodeFbUnicode(str) {
    if (!str || typeof str !== 'string') return '';
    try {
      return JSON.parse(`"${str.replace(/"/g, '\\"')}"`);
    } catch (_) {
      return str
        .replace(/\\u003C/gi, '<')
        .replace(/\\u003E/gi, '>')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u0022/gi, '"')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/');
    }
  }

  /**
   * Làm sạch và kiểm tra tên Page có hợp lệ không
   */
  function cleanPageName(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    let cleaned = decodeFbUnicode(rawName).trim();

    // Bỏ đếm số hoặc icon ở đầu
    cleaned = cleaned.replace(/^\s*(?:\(\d+\+?\)|[·•\*\-])\s*/, '').trim();
    // Bỏ dấu ngoặc kép thừa
    cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

    if (!cleaned || cleaned.length < 2) return null;
    if (GENERIC_EXCLUDE_REGEX.test(cleaned)) return null;
    if (/^\d+$/.test(cleaned)) return null;
    if (/^(?:undefined|null|none)$/i.test(cleaned)) return null;

    return cleaned.slice(0, 100).trim();
  }

  /**
   * Khử trùng lặp danh sách Page.
   * Quy tắc (sửa 2026-09-28 - trước đây dedupe theo TÊN đã gộp nhầm 2 page
   * khác nhau trùng tên "Phòng Khám Meditech" làm mất 1 page):
   * 1. ID profile/delegate 6155xxx-6159xxx -> loại (chúng KHÔNG phải page).
   * 2. ID nằm trong profileAliases (node.id của node có delegate_page) -> loại.
   * 3. Các page còn lại KHÔNG BAO GIỜ gộp theo tên — Facebook cho phép 2 page
   *    khác nhau trùng tên; gộp theo tên = mất page.
   * 4. Trong nhóm trùng tên: nếu có member legacy (delegate) thì loại member
   *    profile 10007xxx cùng tên (bài học commit ed24ca2).
   * Tên chỉ dùng để GÁN alias_ids (thông tin, không quyết định sống còn).
   */
  function deduplicatePages(pages, legacyIds, profileAliases = null) {
    if (!Array.isArray(pages)) return [];
    const keptById = new Map();
    const nameGroups = new Map();
    const droppedOut = [];
    for (const p of pages) {
      if (!p || !p.page_id) continue;
      const pid = String(p.page_id);
      const norm = (p.name || '').trim().toLowerCase();
      if (!norm) continue;

      // 1. ID profile/delegate 6155xxx-6159xxx không phải page thật -> loại luôn.
      if (SUSPICIOUS_PAGE_ID_REGEX.test(pid)) {
        droppedOut.push(Object.assign({}, p, { dropped: true, drop_reason: 'suspicious_id' }));
        continue;
      }
      // 2. ID là profile actor của một page khác đã extract qua delegate.
      if (profileAliases && profileAliases.has(pid)) {
        droppedOut.push(Object.assign({}, p, { dropped: true, drop_reason: 'profile_alias' }));
        continue;
      }

      if (!keptById.has(pid)) keptById.set(pid, p);
      else {
        const prev = keptById.get(pid);
        // Cùng ID trùng lặp giữa 2 nguồn fetch: giữ bản giàu thông tin hơn.
        if ((p.id_source === 'delegate_page' && prev.id_source !== 'delegate_page') || (p.raw_fragment && !prev.raw_fragment)) {
          keptById.set(pid, p);
        }
      }

      if (!nameGroups.has(norm)) nameGroups.set(norm, []);
      const group = nameGroups.get(norm);
      if (!group.includes(pid)) group.push(pid);
    }

    // Quy tắc 4: nhóm trùng tên có member legacy (delegate) -> loại member
    // profile 10007xxx (Business Suite chặn ID profile này).
    const kept = [];
    const droppedIds = new Set();
    for (const [norm, ids] of nameGroups.entries()) {
      const hasLegacy = ids.some((id) => legacyIds && legacyIds.has(id));
      if (!hasLegacy) continue;
      for (const id of ids) {
        if (legacyIds.has(id)) continue;
        if (/^10007\d+$/.test(id)) {
          const dup = keptById.get(id);
          if (dup) {
            droppedOut.push(Object.assign({}, dup, { dropped: true, drop_reason: 'profile_10007_with_legacy_sibling' }));
            droppedIds.add(id);
          }
        }
      }
    }

    for (const [pid, p] of keptById.entries()) {
      if (droppedIds.has(pid)) continue;
      const norm = (p.name || '').trim().toLowerCase();
      const aliases = (nameGroups.get(norm) || []).filter((id) => id !== pid);
      if (aliases.length > 1) p.alias_ids = aliases;
      kept.push(p);
    }
    return kept.concat(droppedOut);
  }

  // (Phase 0 capture) Bóc các cặp asset_id= / mailbox_id= xuất hiện trong
  // fragment thô quanh page - kênh tín hiệu phân biệt asset thật vs mailbox.
  function extractUrlIds(fragment) {
    const out = { asset_ids: [], mailbox_ids: [] };
    if (!fragment || typeof fragment !== 'string') return out;
    const re = /[?&](asset_id|mailbox_id)=(\d+)/g;
    let m;
    while ((m = re.exec(fragment)) !== null) {
      const key = m[1] === 'asset_id' ? 'asset_ids' : 'mailbox_ids';
      if (!out[key].includes(m[2])) out[key].push(m[2]);
    }
    return out;
  }

  function safeFragment(nodeOrText, maxLen) {
    try {
      const raw = typeof nodeOrText === 'string' ? nodeOrText : JSON.stringify(nodeOrText);
      return raw ? String(raw).slice(0, maxLen || 1400) : '';
    } catch (_) {
      return '';
    }
  }

  function attachCapture(page, idSource, fragment, sourceUrl) {
    const frag = safeFragment(fragment);
    if (idSource) page.id_source = idSource;
    if (sourceUrl) page.source_url = sourceUrl;
    if (frag) {
      page.raw_fragment = frag;
      page.url_params = extractUrlIds(frag);
    }
    return page;
  }

  /**
   * Đệ quy duyệt cây JSON để tìm các object đại diện cho Fanpage
   * Facebook Comet lưu các Page dạng { __typename: "Page", id: "...", name: "..." }
   * hoặc { delegate_page: { id: "...", name: "..." } }
   * hoặc trong viewer.actor.all_pages / launchpoint
   */
  function extractPagesFromJsonTree(node, foundPagesMap, depth = 0, accountId = null, legacyIds = null, sourceUrl = null, profileAliases = null) {
    if (!node || depth > 25 || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        extractPagesFromJsonTree(node[i], foundPagesMap, depth + 1, accountId, legacyIds, sourceUrl, profileAliases);
      }
      return;
    }

    const safeAccountId = accountId ? String(accountId).trim() : null;

    // 1. Kiểm tra cấu trúc delegate_page (chuyển đổi profile sang trang NPE)
    // ƯU TIÊN: Nếu có delegate_page, đây mới là Page ID thực sự -> không lấy ID profile actor bên ngoài
    // Hai dạng: (a) object delegate_page {id, name}; (b) CHUỖI delegate_page_id
    // không kèm object (reproduce 2026-09-28: page "Phòng Khám Meditech"
    // 1283058584897853 chỉ có delegate_page_id dạng chuỗi - bỏ sót làm mất
    // cả trang vì node.id là profile 6159... bị lọc).
    if ((node.delegate_page && typeof node.delegate_page === 'object') || node.delegate_page_id) {
      const dpId = String((node.delegate_page && node.delegate_page.id) || node.delegate_page_id || '');
      const dpName = cleanPageName((node.delegate_page && node.delegate_page.name) || node.name);
      if (dpId && dpName && PAGE_ID_REGEX.test(dpId) && (!safeAccountId || dpId !== safeAccountId)) {
        if (legacyIds) legacyIds.add(dpId);
        let avatar = (node.delegate_page && node.delegate_page.profile_picture?.uri) || `https://graph.facebook.com/${dpId}/picture?type=normal`;
        if (!foundPagesMap.has(dpId)) {
          const pageObj = {
            page_id: dpId,
            name: dpName,
            avatar_url: avatar,
            category: (node.delegate_page && node.delegate_page.category_name) || 'Trang Facebook'
          };
          // ID actor ngoài (node.id) là profile ID - ghi làm alias để chặn
          // việc entry profile cùng tên lọt vào danh sách sau này.
          if (node.id != null && String(node.id) !== dpId) {
            pageObj.context_id = String(node.id);
            if (profileAliases) profileAliases.add(String(node.id));
          }
          attachCapture(pageObj, node.delegate_page && typeof node.delegate_page === 'object' ? 'delegate_page' : 'delegate_page_id_string', node, sourceUrl);
          foundPagesMap.set(dpId, pageObj);
        }
      }
      // Không add thêm node.id ngoài để tránh sinh 2 ID cho cùng 1 Page
    } else {
      // 2. Kiểm tra cấu trúc Page trực tiếp (chỉ khi KHÔNG PHẢI tài khoản cá nhân User/Actor)
      const isUserType = node.__typename === 'User' || node.__typename === 'CometUser' || node.__typename === 'Actor';
      const isPageType = node.__typename === 'Page' || node.__typename === 'CometPage';
      const hasPageFields = !isUserType && node.id && (node.name || node.name_or_vanity) && PAGE_ID_REGEX.test(String(node.id));

      if ((isPageType || hasPageFields) && node.name) {
        const pageId = String(node.id || '');
        const cleanedName = cleanPageName(node.name || node.name_or_vanity);
        if (pageId && cleanedName && (!safeAccountId || pageId !== safeAccountId)) {
          let avatarUrl = null;
          if (typeof node.profile_picture === 'object' && node.profile_picture?.uri) {
            avatarUrl = node.profile_picture.uri;
          } else if (typeof node.profile_photo === 'object' && node.profile_photo?.uri) {
            avatarUrl = node.profile_photo.uri;
          } else if (typeof node.avatar_url === 'string') {
            avatarUrl = node.avatar_url;
          } else if (typeof node.profile_pic_uri === 'string') {
            avatarUrl = node.profile_pic_uri;
          }

          let category = null;
          if (typeof node.category_name === 'string') category = node.category_name;
          else if (Array.isArray(node.categories) && node.categories[0]?.name) category = node.categories[0].name;

          if (!foundPagesMap.has(pageId)) {
            const pageObj = {
              page_id: pageId,
              name: cleanedName,
              avatar_url: avatarUrl || `https://graph.facebook.com/${pageId}/picture?type=normal`,
              category: category || 'Trang Facebook'
            };
            attachCapture(pageObj, 'json_page', node, sourceUrl);
            foundPagesMap.set(pageId, pageObj);
          }
        }
      }
    }

    // Duyệt tiếp các thuộc tính con
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      // Bỏ qua các key nhị phân hoặc chuỗi quá dài không chứa object
      if (typeof node[k] === 'object' && node[k] !== null) {
        extractPagesFromJsonTree(node[k], foundPagesMap, depth + 1, accountId, legacyIds, sourceUrl, profileAliases);
      }
    }
  }

  /**
   * Bóc tách danh sách Fanpage từ HTML response của Facebook
   * (áp dụng cho https://www.facebook.com/pages/?category=your_pages hoặc bookmarks)
   */
  function parsePagesFromHtml(html, accountId = null, legacyIds = null, sourceUrl = null, profileAliases = null) {
    if (!html || typeof html !== 'string') return [];
    const foundPagesMap = new Map();
    if (!legacyIds) legacyIds = new Set();
    if (!profileAliases) profileAliases = new Set();
    const safeAccountId = accountId ? String(accountId).trim() : null;

    // 1. Quét các khối <script ...> chứa JSON Comet
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const scriptContent = match[1];
      if (!scriptContent) continue;
      // Chỉ parse các script có khả năng chứa dữ liệu Page
      if (
        !scriptContent.includes('Page') &&
        !scriptContent.includes('delegate_page') &&
        !scriptContent.includes('category_name') &&
        !scriptContent.includes('your_pages')
      ) {
        continue;
      }

      // Thử parse JSON hoàn chỉnh hoặc trích xuất khối {...} / [...] từ script JS
      try {
        const trimmed = scriptContent.trim();
        let parsed = null;
        try {
          parsed = JSON.parse(trimmed);
        } catch (_) {
          const firstBrace = trimmed.indexOf('{');
          const lastBrace = trimmed.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
              parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            } catch (_) {}
          }
        }
        if (parsed) {
          extractPagesFromJsonTree(parsed, foundPagesMap, 0, safeAccountId, legacyIds, sourceUrl, profileAliases);
        }
      } catch (_) {}

      // Nếu script dạng JavaScript phức tạp không parse được toàn phần
      const jsonBlobRegex = /"__typename"\s*:\s*"Page"|"delegate_page"\s*:\s*\{/g;
      if (jsonBlobRegex.test(scriptContent)) {
        // Ưu tiên regex tìm delegate_page
        const dpRegex = /"delegate_page"\s*:\s*\{[^{}]*?"id"\s*:\s*"(\d{11,})"[^{}]*?"name"\s*:\s*"([^"]+)"/g;
        let dpMatch;
        while ((dpMatch = dpRegex.exec(scriptContent)) !== null) {
          const rawId = dpMatch[1];
          const rawName = dpMatch[2];
          const name = cleanPageName(rawName);
          if (rawId && name && (!safeAccountId || rawId !== safeAccountId)) {
            legacyIds.add(rawId);
          }
          if (rawId && name && (!safeAccountId || rawId !== safeAccountId) && !foundPagesMap.has(rawId)) {
            const pageObj = {
              page_id: rawId,
              name: name,
              avatar_url: `https://graph.facebook.com/${rawId}/picture?type=normal`,
              category: 'Trang Facebook'
            };
            const fragStart = Math.max(0, dpMatch.index - 400);
            attachCapture(pageObj, 'regex_delegate_page', scriptContent.slice(fragStart, dpMatch.index + 1400), sourceUrl);
            foundPagesMap.set(rawId, pageObj);
          }
        }

        // Regex tìm object Page thông thường (chỉ match khi có __typename Page để tránh nhặt User)
        const pageItemRegex = /\{[^{}]*?"id"\s*:\s*"(\d{14,})"[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?"__typename"\s*:\s*"(?:Page|CometPage)"[^{}]*?\}/g;
        let itemMatch;
        while ((itemMatch = pageItemRegex.exec(scriptContent)) !== null) {
          const rawId = itemMatch[1];
          const rawName = itemMatch[2];
          const name = cleanPageName(rawName);
          if (rawId && name && (!safeAccountId || rawId !== safeAccountId) && !foundPagesMap.has(rawId)) {
            const pageObj = {
              page_id: rawId,
              name: name,
              avatar_url: `https://graph.facebook.com/${rawId}/picture?type=normal`,
              category: 'Trang Facebook'
            };
            const fragStart = Math.max(0, itemMatch.index - 400);
            attachCapture(pageObj, 'regex_page_typename', scriptContent.slice(fragStart, itemMatch.index + 1400), sourceUrl);
            foundPagesMap.set(rawId, pageObj);
          }
        }
      }
    }

    // 2. Fallback: Quét Regex toàn bộ nội dung HTML cho các pattern phổ biến của Facebook Launchpoint
    if (foundPagesMap.size === 0) {
      // Pattern 1: {"page_id":"123","page_name":"XYZ"}
      const launchpointRegex = /"page_id"\s*:\s*"(\d{14,})"[^}]*?"(?:page_)?name"\s*:\s*"([^"]+)"/g;
      let lpMatch;
      while ((lpMatch = launchpointRegex.exec(html)) !== null) {
        const id = lpMatch[1];
        const name = cleanPageName(lpMatch[2]);
        if (id && name && (!safeAccountId || id !== safeAccountId) && !foundPagesMap.has(id)) {
          const pageObj = {
            page_id: id,
            name: name,
            avatar_url: `https://graph.facebook.com/${id}/picture?type=normal`,
            category: 'Trang Facebook'
          };
          const fragStart = Math.max(0, lpMatch.index - 400);
          attachCapture(pageObj, 'regex_launchpoint', html.slice(fragStart, lpMatch.index + 1400), sourceUrl);
          foundPagesMap.set(id, pageObj);
        }
      }

      // Pattern 2: "id":"123","name":"XYZ","__typename":"Page"
      const typePageRegex = /"id"\s*:\s*"(\d{14,})"[^}]*?"name"\s*:\s*"([^"]+)"[^}]*?"__typename"\s*:\s*"(?:Page|CometPage)"/g;
      let tpMatch;
      while ((tpMatch = typePageRegex.exec(html)) !== null) {
        const id = tpMatch[1];
        const name = cleanPageName(tpMatch[2]);
        if (id && name && (!safeAccountId || id !== safeAccountId) && !foundPagesMap.has(id)) {
          const pageObj = {
            page_id: id,
            name: name,
            avatar_url: `https://graph.facebook.com/${id}/picture?type=normal`,
            category: 'Trang Facebook'
          };
          const fragStart = Math.max(0, tpMatch.index - 400);
          attachCapture(pageObj, 'regex_typepage', html.slice(fragStart, tpMatch.index + 1400), sourceUrl);
          foundPagesMap.set(id, pageObj);
        }
      }
    }

    const allDiscovered = Array.from(foundPagesMap.values());
    const filtered = safeAccountId ? allDiscovered.filter(p => String(p.page_id) !== safeAccountId) : allDiscovered;
    return deduplicatePages(filtered, legacyIds, profileAliases);
  }

  /**
   * Hàm gọi chính: Discover toàn bộ Fanpage từ phiên đăng nhập hiện tại
   * Thứ tự:
   * 1. Fetch https://www.facebook.com/pages/?category=your_pages
   * 2. Nếu rỗng, fetch https://www.facebook.com/bookmarks/pages/
   */
  async function discoverPages(accountId) {
    const results = [];
    const seenIds = new Set();
    const safeAccountId = accountId ? String(accountId).trim() : null;
    const legacyIds = new Set();
    const profileAliases = new Set();

    // Nguồn 1: your_pages
    try {
      const url = 'https://www.facebook.com/pages/?category=your_pages';
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (res.ok) {
        const html = await res.text();
        const pages = parsePagesFromHtml(html, safeAccountId, legacyIds, 'your_pages', profileAliases);
        for (const p of pages) {
          if (!seenIds.has(p.page_id)) {
            seenIds.add(p.page_id);
            results.push(p);
          }
        }
      }
    } catch (e) {
      console.warn('[FbPageDiscovery] Lỗi khi fetch your_pages:', e?.message || e);
    }

    // Nguồn 2: bookmarks/pages - your_pages có khi chỉ render một phần danh sách
    // (lazy-load) nên luôn quét thêm nguồn này và gộp, tránh thiếu page.
    {
      try {
        const urlBookmarks = 'https://www.facebook.com/bookmarks/pages/';
        const resBm = await fetch(urlBookmarks, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        if (resBm.ok) {
          const htmlBm = await resBm.text();
          const pagesBm = parsePagesFromHtml(htmlBm, safeAccountId, legacyIds, 'bookmarks', profileAliases);
          for (const p of pagesBm) {
            if (!seenIds.has(p.page_id)) {
              seenIds.add(p.page_id);
              results.push(p);
            }
          }
        }
      } catch (e) {
        console.warn('[FbPageDiscovery] Lỗi khi fetch bookmarks/pages:', e?.message || e);
      }
    }

    // Lọc lại lần cuối loại trừ tài khoản cá nhân và khử trùng lặp
    // (dedupe theo page-id + profile alias - KHÔNG gộp theo tên)
    const filtered = safeAccountId ? results.filter(p => String(p.page_id) !== safeAccountId) : results;
    return deduplicatePages(filtered, legacyIds, profileAliases);
  }

  return {
    cleanPageName,
    decodeFbUnicode,
    deduplicatePages,
    parsePagesFromHtml,
    discoverPages
  };
});
