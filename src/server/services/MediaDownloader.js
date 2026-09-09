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

    try {
      const threadMediaDir = path.join(this.mediaBaseDir, threadId);
      if (!fs.existsSync(threadMediaDir)) {
        fs.mkdirSync(threadMediaDir, { recursive: true });
      }

      const extMap = { image: '.jpg', video: '.mp4', voice: '.mp3', file: '.dat' };
      const ext = extMap[mediaType] || '.bin';
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
      const localFilePath = path.join(threadMediaDir, fileName);

      return new Promise((resolve) => {
        const client = mediaUrl.startsWith('https') ? https : http;
        const fileStream = fs.createWriteStream(localFilePath);

        client.get(mediaUrl, (response) => {
          if (response.statusCode === 200) {
            response.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              console.log(`[MediaDownloader] Đã tải media local: ${localFilePath}`);
              resolve(`/data/media/${threadId}/${fileName}`);
            });
          } else {
            console.warn(`[MediaDownloader] Lỗi HTTP status ${response.statusCode} khi tải media`);
            resolve(null);
          }
        }).on('error', (err) => {
          console.error('[MediaDownloader] Lỗi kết nối tải media:', err.message);
          resolve(null);
        });
      });
    } catch (err) {
      console.error('[MediaDownloader] Exception khi tải media:', err.message);
      return null;
    }
  }
}

module.exports = new MediaDownloader();
