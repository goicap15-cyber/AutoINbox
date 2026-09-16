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
    if (/^\d{1,2}:\d{2}$/i.test(cleaned)) {
      cleaned = '';
    }
    if (/^(?:video|\d+\s*giây|\d+\s*s|\d+s|xem video|phát video)$/i.test(cleaned)) {
      cleaned = '';
    }
    return cleaned || null;
  }

  /**
   * Trích xuất link CDN video hoặc thumbnail từ cây React Fiber của phần tử DOM
   * @param {Element} node - Element node cần kiểm tra
   * @returns {{ videoUrl: string|null, posterUrl: string|null }}
   */
  function extractVideoCdnFromReact(node) {
    if (!node) return { videoUrl: null, posterUrl: null };
    try {
      const keys = Object.keys(node);
      const reactKey = keys.find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$') || k.startsWith('__reactInternalInstance$'));
      if (!reactKey) return { videoUrl: null, posterUrl: null };

      let curr = node[reactKey];
      let depth = 0;
      let foundVideo = null;
      let foundPoster = null;

      function scanObject(obj, currentDepth = 0) {
        if (!obj || typeof obj !== 'object' || currentDepth > 5) return;

        // 1. Kiểm tra các trường chứa link video CDN trực tiếp của Facebook
        const videoKeys = [
          'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url',
          'browser_native_sd_url', 'video_direct_url', 'videoDirectUrl', 'playableUrl'
        ];
        for (const vk of videoKeys) {
          const val = obj[vk];
          if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
            if (!foundVideo) foundVideo = val;
          }
        }

        // 2. Kiểm tra các trường chứa link poster/thumbnail CDN
        const posterKeys = [
          'preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl',
          'poster_url', 'posterUrl', 'large_preview', 'preview_image',
          'thumbnail', 'image'
        ];
        for (const pk of posterKeys) {
          const pval = obj[pk];
          if (typeof pval === 'string' && /^https?:\/\//i.test(pval)) {
            if (!foundPoster && !pval.includes('/emoji.php') && !pval.includes('/rsrc.php')) foundPoster = pval;
          } else if (pval && typeof pval === 'object' && typeof pval.uri === 'string' && /^https?:\/\//i.test(pval.uri)) {
            if (!foundPoster && !pval.uri.includes('/emoji.php') && !pval.uri.includes('/rsrc.php')) foundPoster = pval.uri;
          }
        }

        // 3. Duyệt đệ quy các container đính kèm phổ biến của Facebook
        const containers = [
          'attachment', 'attachments', 'blob_attachments', 'video_attachments',
          'extensible_attachment', 'story', 'media', 'video', 'video_delivery'
        ];
        for (const ck of containers) {
          const child = obj[ck];
          if (Array.isArray(child)) {
            for (const item of child) scanObject(item, currentDepth + 1);
          } else if (child && typeof child === 'object') {
            scanObject(child, currentDepth + 1);
          }
        }
      }

      while (curr && depth < 40) {
        depth++;
        const props = curr.memoizedProps || curr.props || (depth === 1 ? curr : null);
        if (props) {
          scanObject(props);
          if (foundVideo) break;
        }
        curr = curr.return || curr.child;
      }

      return { videoUrl: foundVideo || null, posterUrl: foundPoster || null };
    } catch (_) {
      return { videoUrl: null, posterUrl: null };
    }
  }

  const resolvedVideoCache = new Map();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'CRM_RESOLVE_PAGE_VIDEO_RESPONSE') {
        const { fb_message_id, videoUrl, posterUrl } = event.data;
        if (fb_message_id) {
          resolvedVideoCache.set(fb_message_id, { videoUrl, posterUrl });
        }
      }
    });
  }

  function requestVideoResolutionFromMain(fbMessageId) {
    if (!fbMessageId || typeof window === 'undefined' || typeof window.postMessage !== 'function') return;
    try {
      window.postMessage({
        type: 'CRM_RESOLVE_PAGE_VIDEO_REQUEST',
        fb_message_id: fbMessageId
      }, '*');
    } catch (_) {}
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
    if (rawText === '👍' || /^(?:thích|like|biểu tượng thích|biểu tượng cảm xúc thích|gửi biểu tượng thích|thumbs up)$/i.test(rawText)) {
      return { isVideo: false };
    }

    const finalCaption = cleanVideoCaption(captionText || rawText);
    const fbMessageId = messageNode.getAttribute?.('data-message-id') ||
      messageNode.getAttribute?.('data-id') ||
      messageNode.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      null;

    const cachedMedia = fbMessageId ? resolvedVideoCache.get(fbMessageId) : null;
    const domCdnAttr = messageNode.getAttribute?.('data-crm-video-url') ||
      messageNode.querySelector?.('[data-crm-video-url]')?.getAttribute?.('data-crm-video-url');
    const domPosterAttr = messageNode.getAttribute?.('data-crm-poster-url') ||
      messageNode.querySelector?.('[data-crm-poster-url]')?.getAttribute?.('data-crm-poster-url');

    // 1. Quét các thẻ <video> trực tiếp
    const videos = Array.from(messageNode.querySelectorAll('video'));
    for (const video of videos) {
      if (video.closest && video.closest(COMPOSER_EXCLUDE_SELECTOR)) continue;

      const label = (video.getAttribute('aria-label') || video.getAttribute('title') || '').trim();
      if (isExcludedCall(label)) continue;

      const sourceCandidates = [
        video.currentSrc,
        video.src,
        video.getAttribute('src'),
        ...Array.from(video.querySelectorAll('source[src]')).map((s) => s.getAttribute('src'))
      ].filter(Boolean);

      const realCdnSource = domCdnAttr ||
        cachedMedia?.videoUrl ||
        video.getAttribute('data-crm-video-url') ||
        sourceCandidates.find((src) => /^https?:\/\//i.test(src));
      const poster = domPosterAttr ||
        cachedMedia?.posterUrl ||
        video.getAttribute('data-crm-poster-url') ||
        video.poster ||
        video.getAttribute('poster') ||
        '';
      const validPoster = /^https?:\/\//i.test(poster) ? poster : null;

      let detectedPoster = validPoster;
      if (!detectedPoster) {
        const thumbImg = messageNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
        if (thumbImg) {
          const src = thumbImg.currentSrc || thumbImg.getAttribute('src') || '';
          if (/^https?:\/\//i.test(src)) detectedPoster = src;
        }
      }
      if (!detectedPoster) {
        const bgElements = Array.from(messageNode.querySelectorAll('[style*="background-image"]'));
        for (const el of bgElements) {
          const style = el.getAttribute('style') || '';
          const match = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
          if (match && /^https?:\/\//i.test(match[2])) {
            detectedPoster = match[2];
            break;
          }
        }
      }

      let effectiveCdnSource = realCdnSource;
      let effectivePoster = detectedPoster;

      // Nếu DOM không có URL CDN trực tiếp (dạng blob: hoặc stream MSE), bóc tách từ React Fiber
      if (!effectiveCdnSource || !effectivePoster) {
        const reactMedia = extractVideoCdnFromReact(video);
        if (!effectiveCdnSource && reactMedia?.videoUrl) effectiveCdnSource = reactMedia.videoUrl;
        if (!effectivePoster && reactMedia?.posterUrl) effectivePoster = reactMedia.posterUrl;

        if (!effectiveCdnSource || !effectivePoster) {
          const nodeReactMedia = extractVideoCdnFromReact(messageNode);
          if (!effectiveCdnSource && nodeReactMedia?.videoUrl) effectiveCdnSource = nodeReactMedia.videoUrl;
          if (!effectivePoster && nodeReactMedia?.posterUrl) effectivePoster = nodeReactMedia.posterUrl;
        }
      }

      // Kích hoạt giải mã từ MAIN world nếu chưa có URL CDN trực tiếp
      if (!effectiveCdnSource && fbMessageId) {
        requestVideoResolutionFromMain(fbMessageId);
      }

      const hasPlayerTimeInNode = /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(rawText);
      const hasVideoSignal = Boolean(
        sourceCandidates.length > 0 ||
        effectiveCdnSource ||
        OPEN_VIDEO_LABEL_PATTERN.test(label) ||
        (video.closest && video.closest('[aria-label*="video" i]')) ||
        effectivePoster ||
        hasPlayerTimeInNode ||
        (typeof video.readyState === 'number' && video.readyState > 0) ||
        (typeof video.duration === 'number' && video.duration > 0)
      );

      if (hasVideoSignal) {
        return {
          isVideo: true,
          mediaUrl: effectiveCdnSource || effectivePoster || null,
          posterUrl: effectivePoster || null,
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

      if (isMp4Direct || isVideoLink || (isVideoLabel && !isExcludedCall(label))) {
        // Nếu là mp4 thì lấy trực tiếp, nếu là link trang thì tìm poster hoặc ảnh thumbnail đi kèm
        let detectedUrl = isMp4Direct ? href : null;
        if (!detectedUrl) {
          const thumbImg = messageNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
          if (thumbImg) {
            const src = thumbImg.currentSrc || thumbImg.getAttribute('src');
            if (/^https?:\/\//i.test(src)) detectedUrl = src;
          }
        }
        if (!detectedUrl) {
          const bgElements = Array.from(messageNode.querySelectorAll('[style*="background-image"]'));
          for (const bgEl of bgElements) {
            const style = bgEl.getAttribute('style') || '';
            const match = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
            if (match && /^https?:\/\//i.test(match[2])) {
              detectedUrl = match[2];
              break;
            }
          }
        }

        return {
          isVideo: true,
          mediaUrl: detectedUrl || href || null,
          posterUrl: detectedUrl || null,
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

    // 4. Quét khi có thanh thời lượng video player (dạng 0:00 / 0:xx hoặc 0:xx) hoặc nút play bên trong messageNode
    const hasDurationFormat = /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(rawText) ||
      (/^\d{1,2}:\d{2}$/.test(rawText) && Boolean(messageNode.querySelector?.('img[src], [style*="background-image"], [aria-label*="phát" i], [aria-label*="play" i], [aria-label*="video" i]')));
    const hasPlayControl = Boolean(messageNode.querySelector?.('[aria-label*="phát" i], [aria-label*="play" i], [aria-label*="video" i], [data-surface*="video"]'));

    if ((hasDurationFormat || hasPlayControl) && !isExcludedCall(rawText)) {
      let detectedUrl = null;
      const thumbImg = messageNode.querySelector('img[src]:not([src*="/emoji.php"]):not([src*="/rsrc.php"])');
      if (thumbImg) {
        const src = thumbImg.currentSrc || thumbImg.getAttribute('src') || '';
        if (/^https?:\/\//i.test(src)) detectedUrl = src;
      }
      if (!detectedUrl) {
        const bgElements = Array.from(messageNode.querySelectorAll('[style*="background-image"]'));
        for (const el of bgElements) {
          const style = el.getAttribute('style') || '';
          const match = style.match(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
          if (match && /^https?:\/\//i.test(match[2])) {
            detectedUrl = match[2];
            break;
          }
        }
      }
      if (!detectedUrl) {
        const reactMedia = extractVideoCdnFromReact(messageNode);
        detectedUrl = reactMedia?.videoUrl || reactMedia?.posterUrl || null;
      }
      if (detectedUrl || hasDurationFormat || hasPlayControl) {
        return {
          isVideo: true,
          mediaUrl: detectedUrl || null,
          posterUrl: detectedUrl || null,
          caption: finalCaption
        };
      }
    }

    return { isVideo: false };
  }

  return {
    detectPageVideo,
    extractVideoCdnFromReact,
    cleanVideoCaption,
    getVideoCache: () => resolvedVideoCache,
    requestVideoResolutionFromMain,
    OPEN_VIDEO_LABEL_PATTERN,
    CALL_EXCLUDE_PATTERN
  };
});
