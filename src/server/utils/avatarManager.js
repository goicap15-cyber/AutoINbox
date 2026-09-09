// Avatar Manager - Saves avatars to local filesystem and serves them
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { APP_DATA_ROOT } = require('./appDataRoot');

const DATA_DIR = APP_DATA_ROOT;
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

// Ensure avatar directory exists
function initAvatarDir() {
  if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  }
}

initAvatarDir();

// Helper: Tải tệp hỗ trợ chuyển hướng Redirect (301/302/307)
function fetchWithRedirects(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = targetUrl.startsWith('https') ? https : http;
    const req = client.get(targetUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.facebook.com/'
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return fetchWithRedirects(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Error status: ${res.statusCode}`));
      }
      resolve(res);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Download avatar from URL and save to local file
async function downloadAvatar(avatarUrl, threadId = null) {
  if (!avatarUrl || typeof avatarUrl !== 'string' || !avatarUrl.startsWith('http')) return null;

  try {
    const urlHash = crypto.createHash('md5').update(avatarUrl).digest('hex').substring(0, 8);
    const filename = threadId ? `avatar_${threadId}_${urlHash}.jpg` : `avatar_${Date.now()}_${urlHash}.jpg`;
    const filePath = path.join(AVATAR_DIR, filename);

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 500) {
        return filename;
      }
    }

    const responseStream = await fetchWithRedirects(avatarUrl);
    const uniqueTmpId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const tempPath = path.join(AVATAR_DIR, `${filename}.${uniqueTmpId}.tmp`);
    const fileStream = fs.createWriteStream(tempPath);

    await new Promise((resolve, reject) => {
      responseStream.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(resolve));
      fileStream.on('error', reject);
    });

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 300) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return filename;
    }

    const stat = fs.statSync(tempPath);
    if (stat.size > 300) {
      fs.renameSync(tempPath, filePath);
      if (threadId) {
        try {
          const files = fs.readdirSync(AVATAR_DIR);
          for (const f of files) {
            if (f.startsWith(`avatar_${threadId}_`) && f !== filename && !f.endsWith('.tmp')) {
              fs.unlinkSync(path.join(AVATAR_DIR, f));
            }
          }
        } catch (e) {}
      }
      return filename;
    } else {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return null;
    }
  } catch (err) {
    console.warn(`[AvatarManager] ⚠️ Lỗi tải avatar (${threadId}):`, err.message);
    return null;
  }
}

// Save avatar from Base64 or HTTP URL
async function saveAvatarFromBase64OrUrl(avatarData, threadId) {
  if (!avatarData || typeof avatarData !== 'string') return null;

  try {
    const urlHash = crypto.createHash('md5').update(avatarData).digest('hex').substring(0, 8);
    const filename = threadId ? `avatar_${threadId}_${urlHash}.jpg` : `avatar_${Date.now()}_${urlHash}.jpg`;
    const filePath = path.join(AVATAR_DIR, filename);

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 300) {
      return filename;
    }

    if (avatarData.startsWith('data:image/')) {
      const base64Data = avatarData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length > 300) {
        fs.writeFileSync(filePath, buffer);
        if (threadId) {
          try {
            const files = fs.readdirSync(AVATAR_DIR);
            for (const f of files) {
              if (f.startsWith(`avatar_${threadId}_`) && f !== filename && !f.endsWith('.tmp')) {
                fs.unlinkSync(path.join(AVATAR_DIR, f));
              }
            }
          } catch (e) {}
        }
        return filename;
      }
    } else if (avatarData.startsWith('http')) {
      return await downloadAvatar(avatarData, threadId);
    }
  } catch (err) {
    console.warn(`[AvatarManager] Lỗi lưu avatar (${threadId}):`, err.message);
  }
  return null;
}

// Serve avatar via static endpoint
function serveAvatar(req, res) {
  const filename = req.params.filename;
  if (!filename || !/^[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(filename)) {
    return res.status(400).send('Invalid filename');
  }

  const filePath = path.join(AVATAR_DIR, filename);
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.status(404).send('Avatar not found');
    }

    res.sendFile(filePath);
  });
}

module.exports = { downloadAvatar, saveAvatarFromBase64OrUrl, serveAvatar, initAvatarDir };
