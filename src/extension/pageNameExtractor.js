/**
 * pageNameExtractor.js
 * Helper bóc tách và chuẩn hóa tên Fanpage từ Meta Business Suite Script JSON, DOM và document.title.
 * Tương thích UMD (Browser Content Script, Service Worker & CommonJS Node.js Unit Tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageNameExtractor = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Chặn tuyệt đối URL / link / domain / endpoint query
  const URL_EXCLUDE_REGEX = /(?:https?:\/\/|business\.facebook|facebook\.com|messenger\.com|\/latest\/|[?&](?:asset_id|mailbox_id)=)/i;

  // Chặn các chuỗi tĩnh dùng chung của toàn hệ thống Meta (kể cả khi ghép lại như "Hộp thư | Meta Business Suite")
  const GENERIC_EXCLUDE_REGEX = /^(?:hộp thư|inbox|messages|tin nhắn|tất cả tin nhắn|all messages|meta business suite|business suite|facebook|trang|page|\d+|đang tải(?:\.\.\.)?|loading(?:\.\.\.)?|chuyển tài khoản|chuyển đổi tài khoản|trang quản lý tài sản doanh nghiệp)(?:\s*[:|—–-]\s*(?:hộp thư|inbox|messages|tin nhắn|tất cả tin nhắn|all messages|meta business suite|business suite|facebook|trang|page|\d+|đang tải(?:\.\.\.)?|loading(?:\.\.\.)?))*$/i;

  function decodeFacebookString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch (_) {
      return String(value || '');
    }
  }

  /**
   * Làm sạch và kiểm tra tên Page có hợp lệ không (Guardrail)
   */
  function cleanPageName(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    let cleaned = rawName.trim();

    // Bỏ thông báo đếm số ở đầu: (1) , (99+) , • , ...
    cleaned = cleaned.replace(/^\s*(?:\(\d+\+?\)|[·•\*\-])\s*/, '').trim();

    // Bỏ các ký tự bao bọc thừa
    cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

    if (!cleaned || cleaned.length < 2) return null;

    // 1. Chặn URL / domain
    if (URL_EXCLUDE_REGEX.test(cleaned)) return null;

    // 2. Chặn chuỗi tĩnh nền tảng
    if (GENERIC_EXCLUDE_REGEX.test(cleaned)) return null;

    // 3. Chặn generic ID
    if (/^page\s+\d+$/i.test(cleaned)) return null;
    if (/^\d+$/.test(cleaned)) return null;
    if (/^(?:undefined|null|none)$/i.test(cleaned)) return null;

    // Giới hạn độ dài tối đa 100 ký tự
    return cleaned.slice(0, 100).trim();
  }

  /**
   * Bóc tách tên Page từ các thẻ <script> chứa JSON metadata của Facebook
   * Nguồn đáng tin cậy nhất: dữ liệu máy chủ của Meta gắn liền với asset_id/page_id
   */
  function extractPageNameFromScripts(rootDoc, pageId) {
    if (!rootDoc || typeof rootDoc.querySelectorAll !== 'function') return null;
    const safePageId = String(pageId || '').replace(/[^0-9]/g, '');
    const scripts = rootDoc.querySelectorAll('script');
    if (!scripts || !scripts.length) return null;

    const patterns = [];
    if (safePageId) {
      patterns.push(
        new RegExp(`"asset_id":"${safePageId}"[\\s\\S]{0,1200}?"name":"((?:\\\\.|[^"\\\\])*)"`, 'i'),
        new RegExp(`"name":"((?:\\\\.|[^"\\\\])*)"[\\s\\S]{0,1200}?"asset_id":"${safePageId}"`, 'i'),
        new RegExp(`"id":"${safePageId}"[\\s\\S]{0,800}?"name":"((?:\\\\.|[^"\\\\])*)"`, 'i'),
        new RegExp(`"name":"((?:\\\\.|[^"\\\\])*)"[\\s\\S]{0,800}?"id":"${safePageId}"`, 'i'),
        new RegExp(`"page_id":"${safePageId}"[\\s\\S]{0,1200}?"name":"((?:\\\\.|[^"\\\\])*)"`, 'i'),
        new RegExp(`"name":"((?:\\\\.|[^"\\\\])*)"[\\s\\S]{0,1200}?"page_id":"${safePageId}"`, 'i')
      );
    }

    patterns.push(
      /["']selected_asset["']\s*:\s*\{[^}]*?["']name["']\s*:\s*["']([^"']+)["']/i,
      /["']current_page["']\s*:\s*\{[^}]*?["']name["']\s*:\s*["']([^"']+)["']/i
    );

    for (const script of scripts) {
      const text = script.textContent || '';
      if (safePageId && !text.includes(safePageId)) continue;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const decoded = decodeFacebookString(match[1]);
          const cleaned = cleanPageName(decoded);
          if (cleaned) return cleaned;
        }
      }
    }
    return null;
  }

  /**
   * Bóc tách tên Page từ chuỗi document.title
   */
  function extractPageNameFromTitle(title) {
    if (!title || typeof title !== 'string') return null;

    // Bỏ thông báo đếm số đầu tiên: (3) Hộp thư...
    let cleanTitle = title.replace(/^\s*(?:\(\d+\+?\)|[·•\*\-])\s*/, '').trim();

    // 1. Phân tách bằng dấu gạch dọc '|'
    if (cleanTitle.includes('|')) {
      const parts = cleanTitle.split('|').map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const cleanedPart = cleanPageName(part);
        if (cleanedPart) {
          return cleanedPart;
        }
      }
      // Nếu tất cả các phần tách bởi '|' đều là chuỗi chung/rác, không cố chấp lấy
      return null;
    }

    // 2. Loại bỏ prefix ("Hộp thư", "Inbox") và suffix ("Meta Business Suite", "Facebook")
    let candidate = cleanTitle
      .replace(/^(?:hộp thư|inbox|messages|tin nhắn)\s*[:|—–-]\s*/i, '')
      .replace(/\s*[:|—–-]\s*(?:meta business suite|business suite|facebook).*$/i, '')
      .trim();

    const cleanedCandidate = cleanPageName(candidate);
    if (cleanedCandidate) return cleanedCandidate;

    return cleanPageName(cleanTitle);
  }

  /**
   * Bóc tách tên Page từ các phần tử thương hiệu DOM của Business Suite
   */
  function extractPageNameFromDom(rootDoc) {
    if (!rootDoc || typeof rootDoc.querySelector !== 'function') return null;

    const switcherSelectors = [
      '[data-surface*="business_switcher"] [role="heading"]',
      '[data-surface*="business_switcher"] [dir="auto"]',
      '[data-surface*="business_switcher"] span',
      '[aria-label*="chuyển tài khoản" i]',
      '[aria-label*="chuyển đổi tài khoản" i]',
      '[aria-label*="switch account" i]',
      '[aria-label*="switch business" i]',
      '[data-testid*="business-switcher"]',
      'div[role="navigation"] button[aria-haspopup="menu"] span[dir="auto"]',
      'nav button[aria-haspopup] span[dir="auto"]',
      'header button[aria-haspopup] span[dir="auto"]',
      'div[role="banner"] button[aria-haspopup] span[dir="auto"]',
      'nav [role="button"] span[dir="auto"]',
      'header [role="button"] span[dir="auto"]'
    ];

    for (const sel of switcherSelectors) {
      try {
        const el = rootDoc.querySelector(sel);
        if (el) {
          const aria = el.getAttribute?.('aria-label');
          if (aria) {
            const matchAria = aria.replace(/^(?:đang xem với tư cách|xem với tư cách|chuyển tài khoản sang|switch to)\s*/i, '');
            const cleanedAria = cleanPageName(matchAria);
            if (cleanedAria) return cleanedAria;
          }

          const txt = (el.innerText || el.textContent || '').trim();
          const cleanedTxt = cleanPageName(txt);
          if (cleanedTxt) return cleanedTxt;
        }
      } catch (_) {}
    }

    // Tìm qua avatar Page ở thanh điều hướng / banner trên cùng
    try {
      const avatarImgs = rootDoc.querySelectorAll('nav img[alt], header img[alt], div[role="banner"] img[alt], [data-surface*="sidebar"] img[alt]');
      for (const img of avatarImgs) {
        let alt = (img.getAttribute('alt') || '').trim();
        if (!alt) continue;
        alt = alt.replace(/^(?:ảnh đại diện của|ảnh đại diện|avatar của|profile picture of|avatar of)\s*/i, '').trim();
        const cleanedAlt = cleanPageName(alt);
        if (cleanedAlt) return cleanedAlt;
      }
    } catch (_) {}

    return null;
  }

  /**
   * Phương thức tổng hợp:
   * 1. Ưu tiên Script JSON metadata (Chính xác 100%, không bị ảnh hưởng bởi UI/Title)
   * 2. Ưu tiên nhì: DOM thương hiệu (Brand Sidebar)
   * 3. Fallback: document.title (chỉ khi vượt qua bộ lọc nghiêm ngặt)
   */
  function detectPageName(context = {}) {
    const doc = context.document || (typeof document !== 'undefined' ? document : null);
    const pageId = context.pageId || null;
    const title = context.title || (doc ? doc.title : '');

    // 1. Script JSON metadata
    if (doc) {
      const scriptName = extractPageNameFromScripts(doc, pageId);
      if (scriptName) return scriptName;
    }

    // 2. DOM thương hiệu
    if (doc) {
      const domName = extractPageNameFromDom(doc);
      if (domName) return domName;
    }

    // 3. document.title (chỉ dùng nếu cleanPageName chấp nhận)
    if (title) {
      const titleName = extractPageNameFromTitle(title);
      if (titleName) return titleName;
    }

    return null;
  }

  return {
    cleanPageName,
    decodeFacebookString,
    extractPageNameFromScripts,
    extractPageNameFromTitle,
    extractPageNameFromDom,
    detectPageName
  };
});
