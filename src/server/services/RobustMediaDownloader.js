const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a'
};

class RobustMediaDownloader {
  constructor() {
    this.mediaBaseDir = path.join(APP_DATA_ROOT, 'media');
    fs.mkdirSync(this.mediaBaseDir, { recursive: true });
  }

  requestStream(targetUrl, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft < 0) return reject(new Error('Too many media redirects'));
      const client = String(targetUrl).startsWith('https:') ? https : http;
      const request = client.get(targetUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,video/*,audio/*,*/*;q=0.8',
          Referer: 'https://www.facebook.com/'
        }
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          const redirected = new URL(response.headers.location, targetUrl).toString();
          response.resume();
          this.requestStream(redirected, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolve(response);
      });
      request.on('timeout', () => request.destroy(new Error('Media download timeout')));
      request.on('error', reject);
    });
  }

  async downloadNewMessageMedia(threadId, mediaUrl, mediaType) {
    if (!/^https?:\/\//i.test(String(mediaUrl || ''))) return null;
    const safeThreadId = String(threadId || '').replace(/[^a-z0-9_-]/gi, '_');
    if (!safeThreadId) return null;

    let tempPath = null;
    try {
      const response = await this.requestStream(String(mediaUrl));
      const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
      const fallbackExt = { image: '.jpg', video: '.mp4', voice: '.mp3', file: '.dat' }[mediaType] || '.bin';
      const extension = EXT_BY_TYPE[contentType] || fallbackExt;
      const directory = path.join(this.mediaBaseDir, safeThreadId);
      fs.mkdirSync(directory, { recursive: true });
      const stem = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const finalPath = path.join(directory, stem + extension);
      tempPath = finalPath + '.part';

      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tempPath, { flags: 'wx' });
        response.pipe(output);
        response.on('error', reject);
        output.on('error', reject);
        output.on('finish', () => output.close(resolve));
      });

      const size = fs.statSync(tempPath).size;
      if (size <= 0) throw new Error('Downloaded media is empty');
      fs.renameSync(tempPath, finalPath);
      tempPath = null;
      console.log(`[MediaDownloader] Downloaded ${mediaType || 'media'} (${size} bytes): ${finalPath}`);
      return `/data/media/${safeThreadId}/${path.basename(finalPath)}`;
    } catch (error) {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      console.warn('[MediaDownloader] Download failed:', error.message);
      return null;
    }
  }
}

module.exports = new RobustMediaDownloader();
