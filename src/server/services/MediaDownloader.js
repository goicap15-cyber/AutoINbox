const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

class MediaDownloader {
  constructor() {
    this.mediaBaseDir = path.join(APP_DATA_ROOT, 'media');
    if (!fs.existsSync(this.mediaBaseDir)) {
      fs.mkdirSync(this.mediaBaseDir, { recursive: true });
    }
  }

  // Tải media đính kèm về ổ cứng local (chỉ dành cho tin nhắn MỚI)
  async downloadNewMessageMedia(threadId, mediaUrl, mediaType) {
    if (!mediaUrl) return null;
    if (!/^https?:\/\//i.test(String(mediaUrl))) return null;

    try {
      const threadMediaDir = path.join(this.mediaBaseDir, threadId);
      if (!fs.existsSync(threadMediaDir)) {
        fs.mkdirSync(threadMediaDir, { recursive: true });
      }

      const extMap = { image: '.jpg', video: '.mp4', voice: '.mp3', file: '.dat' };
      const videoPosterMatch = mediaType === 'video'
        ? String(mediaUrl).match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)
        : null;
      const ext = videoPosterMatch
        ? '.' + videoPosterMatch[1].toLowerCase().replace('jpeg', 'jpg')
        : (extMap[mediaType] || '.bin');
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
      const localFilePath = path.join(threadMediaDir, fileName);

      return new Promise((resolve) => {
        const client = mediaUrl.startsWith('https') ? https : http;
        const fileStream = fs.createWriteStream(localFilePath);
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(stallTimer);
          try { fileStream.destroy(); } catch (_) {}
          if (!value) { try { fs.unlinkSync(localFilePath); } catch (_) {} }
          resolve(value);
        };
        // A hung CDN connection must never occupy a hydration slot forever;
        // the hydration pool is small and one stuck download stalls the queue.
        const stallTimer = setTimeout(() => {
          console.warn('[MediaDownloader] Timeout tải media (90s)');
          try { request.destroy(new Error('stall timeout')); } catch (_) {}
          finish(null);
        }, 90000);
        const request = client.get(mediaUrl, (response) => {
          if (response.statusCode === 200) {
            response.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              console.log(`[MediaDownloader] Đã tải media local: ${localFilePath}`);
              finish(`/data/media/${threadId}/${fileName}`);
            });
          } else {
            console.warn(`[MediaDownloader] Lỗi HTTP status ${response.statusCode} khi tải media`);
            response.resume?.();
            finish(null);
          }
        }).on('error', (err) => {
          console.error('[MediaDownloader] Lỗi kết nối tải media:', err.message);
          finish(null);
        });
      });
    } catch (err) {
      console.error('[MediaDownloader] Exception khi tải media:', err.message);
      return null;
    }
  }
}

module.exports = new MediaDownloader();
