/**
 * pageProfileUrlExtractor.js
 * Module chuyên biệt trích xuất đường dẫn trang cá nhân Facebook của khách hàng
 * từ giao diện Meta Business Suite (cột chi tiết khách hàng / right rail).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageProfileUrlExtractor = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const NON_PROFILE_ROUTES = new Set([
    'messages', 'pages', 'groups', 'events', 'watch', 'gaming', 'marketplace',
    'latest', 'inbox', 'photo', 'video', 'reel', 'story', 'sharer', 'dialog',
    'login', 'recover', 'help', 'about', 'privacy', 'policies', 'terms', 'settings',
    'ads', 'business', 'notifications', 'checkpoint', 'home.php', 'all'
  ]);

  /**
   * Chuẩn hóa và làm sạch link Facebook, loại bỏ các tham số tracking
   * @param {string} rawUrl 
   * @returns {string|null}
   */
  function cleanFacebookProfileUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    // Không chấp nhận link nội bộ Business Suite hoặc link ngoài Facebook
    if (trimmed.includes('business.facebook.com') || !/(?:facebook\.com|fb\.com)/i.test(trimmed)) {
      return null;
    }

    try {
      // Đảm bảo URL có protocol hợp lệ
      const normalizedUrl = trimmed.startsWith('//')
        ? 'https:' + trimmed
        : (trimmed.startsWith('http') ? trimmed : 'https://www.facebook.com' + (trimmed.startsWith('/') ? '' : '/') + trimmed);
      
      const parsed = new URL(normalizedUrl);
      const pathname = parsed.pathname || '';

      // 1. Dạng numeric UID: profile.php?id=1000...
      if (pathname.includes('profile.php')) {
        const uid = parsed.searchParams.get('id');
        if (uid && /^\d+$/.test(uid)) {
          return `https://www.facebook.com/profile.php?id=${uid}`;
        }
      }

      // 2. Dạng user ID: /user/<id>/
      const userMatch = pathname.match(/\/user\/(\d+)/i);
      if (userMatch) {
        return `https://www.facebook.com/profile.php?id=${userMatch[1]}`;
      }

      // 3. Dạng vanity username: /<username>
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length >= 1) {
        const candidate = segments[0];
        // Bỏ qua nếu candidate nằm trong danh sách route hệ thống
        if (!NON_PROFILE_ROUTES.has(candidate.toLowerCase()) && /^[a-zA-Z0-9.-]{3,60}$/.test(candidate)) {
          return `https://www.facebook.com/${candidate}`;
        }
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Kiểm tra xem một thẻ hoặc URL có biểu thị trang cá nhân Facebook hay không
   * @param {string} href 
   * @param {string} labelText 
   * @returns {boolean}
   */
  function isProfileLinkIndicator(href, labelText = '') {
    const text = String(labelText || '').toLowerCase();
    if (
      text.includes('xem trang cá nhân') ||
      text.includes('trang cá nhân trên facebook') ||
      text.includes('view profile on facebook') ||
      text.includes('view facebook profile') ||
      text.includes('view profile') ||
      text.includes('xem hồ sơ')
    ) {
      return true;
    }
    if (href && (href.includes('profile.php?id=') || /\/user\/\d+/i.test(href))) {
      return true;
    }
    return false;
  }

  /**
   * Trích xuất liên kết trang cá nhân Facebook từ phần tử DOM (cột chi tiết)
   * @param {Element} container - DOM node của cột chi tiết (right rail)
   * @param {string} [fallbackThreadId] - ID của thread dự phòng nếu không có link DOM
   * @returns {string|null}
   */
  function extractProfileUrlFromElement(container, fallbackThreadId) {
    if (container) {
      try {
        // Tìm tất cả các thẻ <a> trỏ tới facebook.com
        const links = Array.from(container.querySelectorAll('a[href*="facebook.com"], a[href^="/"]'));
        
        // Vòng 1: Tìm link có chỉ dấu rõ ràng (nút "Xem trang cá nhân" hoặc profile.php)
        for (const a of links) {
          const href = a.getAttribute('href') || a.href || '';
          if (href.includes('business.facebook.com')) continue;
          
          const label = [
            a.textContent,
            a.getAttribute('aria-label'),
            a.getAttribute('title')
          ].filter(Boolean).join(' ');

          if (isProfileLinkIndicator(href, label)) {
            const cleaned = cleanFacebookProfileUrl(href);
            if (cleaned) return cleaned;
          }
        }

        // Vòng 2: Duyệt các link facebook.com khác trong container
        for (const a of links) {
          const href = a.getAttribute('href') || a.href || '';
          if (href.includes('business.facebook.com')) continue;

          const cleaned = cleanFacebookProfileUrl(href);
          if (cleaned) return cleaned;
        }
      } catch (_) {}
    }

    // Fallback: Nếu không tìm thấy link trong DOM nhưng threadId là UID số hợp lệ (10-18 số)
    if (fallbackThreadId && /^\d{10,18}$/.test(String(fallbackThreadId))) {
      return `https://www.facebook.com/profile.php?id=${String(fallbackThreadId)}`;
    }

    return null;
  }

  return {
    cleanFacebookProfileUrl,
    isProfileLinkIndicator,
    extractProfileUrlFromElement
  };
});
