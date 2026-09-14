/**
 * pageVideoDetector.js
 * Module chuyên biệt phát hiện tin nhắn video trong DOM Meta Business Suite.
 * Tách riêng độc lập để bảo toàn mã nguồn cũ và tiện kiểm thử.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageVideoDetector = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const OPEN_VIDEO_LABEL_PATTERN = /(?:phát|mở|xem|play|open|watch)?\s*video/i;
  const CALL_EXCLUDE_PATTERN = /(?:cuộc gọi|video call|call video|đã nhỡ|bỏ lỡ|missed call)/i;
  const COMPOSER_EXCLUDE_SELECTOR = '[data-surface*="composer"], form, footer, [aria-label*="soạn tin" i], [aria-label*="nhập tin" i]';

  function isExcludedCall(text) {
    return text && CALL_EXCLUDE_PATTERN.test(text);
  }

  function cleanVideoCaption(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}(?:\s+|\n|\r)*/i, '').trim();
    cleaned = cleaned.replace(/(?:\s+|\n|\r)*\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}$/i, '').trim();
    if (/^\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}$/i.test(cleaned)) {
      cleaned = '';
    }
    return cleaned || null;
  }

  /**
   * Phát hiện video bên trong một messageIdNode (vỏ bọc tin nhắn [data-message-id])
   * @param {Element} messageNode - Element node của tin nhắn
   * @param {string} [captionText] - Nội dung text đã được lọc
   * @returns {{ isVideo: boolean, mediaUrl?: string|null, caption?: string|null, posterUrl?: string|null }}
   */
  function detectPageVideo(messageNode, captionText = '') {
    if (!messageNode || typeof messageNode.querySelectorAll !== 'function') {
      return { isVideo: false };
    }

    const rawText = (captionText || messageNode.innerText || messageNode.textContent || '').trim();
    if (isExcludedCall(rawText)) {
      return { isVideo: false };
    }

    const finalCaption = cleanVideoCaption(captionText || rawText);

    // 1. Quét các thẻ <video> trực tiếp
    const videos = Array.from(messageNode.querySelectorAll('video'));
    for (const video of videos) {
      if (video.closest && video.closest(COMPOSER_EXCLUDE_SELECTOR)) continue;

      const label = (video.getAttribute('aria-label') || video.getAttribute('title') || '').trim();
      if (isExcludedCall(label)) continue;

      const sourceCandidates = [
        video.currentSrc,
        video.getAttribute('src'),
        ...Array.from(video.querySelectorAll('source[src]')).map((s) => s.getAttribute('src'))
      ].filter(Boolean);

      const realCdnSource = sourceCandidates.find((src) => /^https?:\/\//i.test(src));
      const poster = video.poster || video.getAttribute('poster') || '';
      const validPoster = /^https?:\/\//i.test(poster) ? poster : null;

      let detectedPoster = validPoster;
      if (!detectedPoster) {
        const thumbImg = messageNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
        if (thumbImg) {
          const src = thumbImg.currentSrc || thumbImg.getAttribute('src') || '';
          if (/^https?:\/\//i.test(src)) detectedPoster = src;
        }
      }

      const hasPlayerTimeInNode = /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(rawText);
      const hasVideoSignal = Boolean(
        sourceCandidates.length > 0 ||
        realCdnSource ||
        OPEN_VIDEO_LABEL_PATTERN.test(label) ||
        (video.closest && video.closest('[aria-label*="video" i]')) ||
        detectedPoster ||
        hasPlayerTimeInNode ||
        (typeof video.readyState === 'number' && video.readyState > 0) ||
        (typeof video.duration === 'number' && video.duration > 0)
      );

      if (hasVideoSignal) {
        return {
          isVideo: true,
          mediaUrl: realCdnSource || detectedPoster || null,
          posterUrl: detectedPoster || null,
          caption: finalCaption
        };
      }
    }

    // 2. Quét các thẻ <a> hoặc control trỏ tới video/reel/watch hoặc .mp4
    const linksAndControls = Array.from(messageNode.querySelectorAll('a[href], [aria-label], [role="link"]'));
    for (const el of linksAndControls) {
      if (el.closest && el.closest(COMPOSER_EXCLUDE_SELECTOR)) continue;

      const href = el.href || el.getAttribute('href') || '';
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();

      if (isExcludedCall(label)) continue;

      const isMp4Direct = /\.mp4(?:\?|$)/i.test(href);
      const isVideoLink = /\/(?:videos|reel|watch)\//i.test(href);
      const isVideoLabel = OPEN_VIDEO_LABEL_PATTERN.test(label);

      if (isMp4Direct || (isVideoLink && isVideoLabel) || (isVideoLabel && !isExcludedCall(label))) {
        // Nếu là mp4 thì lấy trực tiếp, nếu là link trang thì tìm poster hoặc ảnh thumbnail đi kèm
        let detectedUrl = isMp4Direct ? href : null;
        if (!detectedUrl) {
          const thumbImg = messageNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
          if (thumbImg) {
            const src = thumbImg.getAttribute('src');
            if (/^https?:\/\//i.test(src)) detectedUrl = src;
          }
        }

        return {
          isVideo: true,
          mediaUrl: detectedUrl || href || null,
          posterUrl: null,
          caption: finalCaption
        };
      }
    }

    // 3. Quét các thẻ ngữ nghĩa [role="img"] có label video
    const semanticVideos = Array.from(messageNode.querySelectorAll('[role="img"]'));
    for (const bgEl of semanticVideos) {
      if (bgEl.closest && bgEl.closest(COMPOSER_EXCLUDE_SELECTOR)) continue;

      const label = String(bgEl.getAttribute('aria-label') || bgEl.getAttribute('title') || '').trim();
      if (OPEN_VIDEO_LABEL_PATTERN.test(label) && !isExcludedCall(label)) {
        const style = bgEl.getAttribute('style') || '';
        const match = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/);
        const bgUrl = match ? match[2] : null;

        return {
          isVideo: true,
          mediaUrl: (bgUrl && /^https?:\/\//i.test(bgUrl)) ? bgUrl : null,
          posterUrl: (bgUrl && /^https?:\/\//i.test(bgUrl)) ? bgUrl : null,
          caption: finalCaption || cleanVideoCaption(label)
        };
      }
    }

    return { isVideo: false };
  }

  return {
    detectPageVideo,
    OPEN_VIDEO_LABEL_PATTERN,
    CALL_EXCLUDE_PATTERN
  };
});
