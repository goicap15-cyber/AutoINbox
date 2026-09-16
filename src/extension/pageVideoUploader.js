/**
 * pageVideoUploader.js
 * Module chuyên biệt xử lý staging và upload video trên Meta Business Suite qua CDP.
 * Tách riêng độc lập để bảo toàn mã nguồn cũ và tránh phân mảnh logic trong background.js.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageVideoUploader = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /**
   * Kiểm tra xem attachment/manifest có chứa video hay không
   * @param {Object|Array} attachmentOrManifest 
   * @returns {boolean}
   */
  function hasVideoAttachment(attachmentOrManifest) {
    if (!attachmentOrManifest) return false;
    const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
    return items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').toLowerCase().startsWith('video/'));
  }

  /**
   * Xác định preferredKind chuẩn cho Business Suite composer
   * @param {Object|Array} attachmentOrManifest 
   * @returns {'video'|'image'|'file'}
   */
  function resolvePreferredKind(attachmentOrManifest) {
    if (!attachmentOrManifest) return 'file';
    const items = Array.isArray(attachmentOrManifest) ? attachmentOrManifest : [attachmentOrManifest];
    if (items.some((item) => item?.media_type === 'video' || String(item?.mime_type || '').toLowerCase().startsWith('video/'))) {
      return 'video';
    }
    if (items.some((item) => item?.media_type === 'image' || String(item?.mime_type || '').toLowerCase().startsWith('image/'))) {
      return 'image';
    }
    return 'file';
  }

  /**
   * Kiểm tra bằng chứng video đã được nạp vào composer của Business Suite
   * @param {number} tabId
   * @param {string[]} fileNames
   * @param {Object} chromeScripting - chrome.scripting API
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{ ok: boolean, matchedNames?: string[] }>}
   */
  async function pollForBusinessSuiteVideoReadiness(tabId, fileNames, chromeScripting, timeoutMs = 10000) {
    if (!chromeScripting || typeof chromeScripting.executeScript !== 'function') {
      return { ok: true };
    }

    const names = (fileNames || []).filter(Boolean);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await chromeScripting.executeScript({
        target: { tabId },
        func: (searchNames) => {
          // Kiểm tra xem có video preview hoặc chip file video nào trong composer không
          const composer = document.querySelector('[data-surface*="composer"], form, footer') || document.body;
          const videos = composer.querySelectorAll('video, [role="img"][aria-label*="video" i]');
          const blobImages = composer.querySelectorAll('img[src^="blob:"]');
          const haystacks = [composer.innerText || ''];
          composer.querySelectorAll('[aria-label]').forEach((el) => haystacks.push(el.getAttribute('aria-label') || ''));
          const text = haystacks.join('\n');
          const matched = searchNames.filter((name) => text.includes(name));

          return {
            hasVideoElement: videos.length > 0,
            hasBlobMedia: blobImages.length > 0,
            matchedNames: matched
          };
        },
        args: [names]
      }).catch(() => null);

      const r = result?.[0]?.result;
      if (r && (r.hasVideoElement || r.hasBlobMedia || (r.matchedNames && r.matchedNames.length > 0))) {
        return { ok: true, matchedNames: r.matchedNames };
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Nếu hết timeout mà không thấy lỗi fatal thì vẫn cho phép tiếp tục thử gửi
    return { ok: true, timedOut: true };
  }

  /**
   * Đánh giá chi tiết trạng thái upload và tính sẵn sàng của nút Gửi trên Meta Business Suite
   * @param {Document|Element} doc - DOM document ho?c container scope
   * @param {string[]} searchNames - Danh sách tên file để đối chiếu
   * @param {boolean} expectVideo - C? ch? ??nh ?ang mong ??i video
   * @returns {{ ready: boolean, send_found: boolean, has_staged_media: boolean, busy: number, matched_names: string[] }}
   */
  function evaluateBusinessSuiteUploadState(doc, searchNames = [], expectVideo = false) {
    if (!doc) return { ready: false, send_found: false, has_staged_media: false, busy: 0, matched_names: [] };

    const visible = (el) => {
      if (!el) return false;
      if (typeof el.getBoundingClientRect === 'function') {
        const r = el.getBoundingClientRect();
        return Boolean(r && r.width > 0 && r.height > 0);
      }
      return true;
    };

    const composerCandidates = [...doc.querySelectorAll('[contenteditable="true"], [role="textbox"]')];
    const composer = composerCandidates
      .filter((el) => {
        if (!visible(el)) return false;
        const label = String(el.getAttribute('aria-label') || '').toLowerCase();
        return !label.includes('search') && !label.includes('tìm kiếm');
      })
      .sort((a, b) => {
        const ra = typeof a.getBoundingClientRect === 'function' ? a.getBoundingClientRect() : { width: 1, height: 1 };
        const rb = typeof b.getBoundingClientRect === 'function' ? b.getBoundingClientRect() : { width: 1, height: 1 };
        return (rb.width * rb.height) - (ra.width * ra.height);
      })[0] || null;

    const scope = (composer && typeof composer.closest === 'function')
      ? (composer.closest('[role="main"], form, [data-surface*="composer"], footer') || doc.body || doc)
      : (doc.body || doc);

    const SEND_SELECTOR = 'button[aria-label="Nhấn Enter để gửi"], [role="button"][aria-label="Nhấn Enter để gửi"], ' +
      'button[aria-label="Gửi"], [role="button"][aria-label="Gửi"], ' +
      'button[aria-label="Send"], [role="button"][aria-label="Send"], ' +
      'button[aria-label="Gửi tin nhắn"], [role="button"][aria-label="Gửi tin nhắn"]';

    const isNotLikeButton = (el) => {
      if (!el) return false;
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      return !/thích|like|cảm xúc|sticker|emoji|thả tim|biểu tượng|nhãn dán|icon|thumbs/i.test(label + ' ' + title);
    };

    const isReadySendButton = (el) => el && visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isNotLikeButton(el);

    let sendButton = [...scope.querySelectorAll(SEND_SELECTOR)].find(isReadySendButton);
    if (!sendButton) {
      sendButton = [...scope.querySelectorAll('button, [role="button"]')].find((el) =>
        isReadySendButton(el) && /^(Gửi|Send)$/i.test((el.textContent || '').trim())
      );
    }

    const busyElements = [...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].filter(visible);
    const uploadLabels = [...scope.querySelectorAll('[aria-label]')].filter((el) =>
      visible(el) && /đang (?:tải|gửi|xử lý)|uploading|processing/i.test(el.getAttribute('aria-label') || '')
    );
    const spinnerElements = [...scope.querySelectorAll('svg circle[stroke-dasharray], [class*="loading" i], [class*="spinner" i]')].filter(visible);
    const totalBusy = busyElements.length + uploadLabels.length + spinnerElements.length;

    const videos = scope.querySelectorAll('video, [role="img"][aria-label*="video" i]');
    const blobImages = scope.querySelectorAll('img[src^="blob:"]');
    const stagedFileInput = [...scope.querySelectorAll('input[type="file"]')].some((inp) =>
      [...(inp.files || [])].length > 0
    );

    const names = (searchNames || []).filter(Boolean);
    const haystacks = [scope.innerText || ''];
    scope.querySelectorAll('[aria-label]').forEach((el) => haystacks.push(el.getAttribute('aria-label') || ''));
    const text = haystacks.join('\n');
    const matchedNames = names.filter((name) => text.includes(name));

    const hasStagedMedia = videos.length > 0 || blobImages.length > 0 || stagedFileInput || matchedNames.length > 0;
    const ready = Boolean(sendButton) && totalBusy === 0 && (hasStagedMedia || Boolean(sendButton));

    return {
      ready,
      send_found: Boolean(sendButton),
      has_staged_media: hasStagedMedia,
      busy: totalBusy,
      matched_names: matchedNames
    };
  }

  return {
    hasVideoAttachment,
    resolvePreferredKind,
    pollForBusinessSuiteVideoReadiness,
    evaluateBusinessSuiteUploadState
  };
});
