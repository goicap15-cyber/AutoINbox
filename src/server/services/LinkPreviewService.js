/**
 * LinkPreviewService.js (2026-09-18)
 * Khi tin nhắn chứa link (facebook.com/share/v/..., Spotify, YouTube...),
 * backend tự đọc Open Graph metadata của link (title + thumbnail + site name)
 * rồi cache lại để CRM hiển thị thành thẻ preview như Messenger: link trên,
 * ảnh/video ở giữa, tên trang ở dưới.
 *
 * - Bảng link_previews cache theo hash URL (một link chỉ fetch một lần).
 * - Fetch dùng User-Agent crawler (facebookexternalhit) vì Facebook chỉ trả
 *   thẻ og cho bot preview, không trả cho trình duyệt thường.
 * - Link fetch lỗi được negative-cache 10 phút trong bộ nhớ để không dội
 *   request liên tục.
 */

const crypto = require('crypto');
const db = require('../database/db');
const { saveAvatarFromBase64OrUrl } = require('../utils/avatarManager');

let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS link_previews (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    image_url TEXT,
    site_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  tableReady = true;
}

const inFlight = new Set();
const failedAt = new Map();
const FAILED_RETRY_MS = 10 * 60 * 1000;

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function extractFirstUrl(content) {
  const str = String(content || '');
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(str);
  if (!m) return null;
  let url = m[0];
  const trail = url.match(/[.,;:!?)\]]+$/);
  if (trail) url = url.slice(0, url.length - trail[0].length);
  return url;
}

function hashUrl(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2?7;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // Thực thể số thập phân & thập lục phân (&#x1b0; = u...) - tiêu đề
    // Facebook video đầy các ký tự Unicode dạng này.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

function pickMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return null;
}

async function fetchAndStore(url) {
  const key = hashUrl(url);
  inFlight.add(key);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let html;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // UA crawler: Facebook/Google serving og-tags cho bot preview
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept-Language': 'vi,en;q=0.8'
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      html = Buffer.from(buf).toString('utf8').slice(0, 2000000);
    } finally {
      clearTimeout(timer);
    }
    const title = pickMeta(html, 'og:title') || pickMeta(html, 'title') || null;
    const imageUrl = pickMeta(html, 'og:image:secure_url') || pickMeta(html, 'og:image') || null;
    const siteName = pickMeta(html, 'og:site_name')
      || (url.match(/^https?:\/\/(?:www\.)?([^\/?#]+)/i) || [])[1]
      || null;
    if (!title && !imageUrl) throw new Error('NO_OG_DATA');
    // Ảnh CDN của Facebook (scontent/lookaside) la URL tam thoi co han - tai
    // ve luu local va phuc vu qua /api/avatars de the preview khong vo anh
    // sau vai gio.
    if (imageUrl && !/facebook\.com\/share\//i.test(url)) {
      const localFile = await saveAvatarFromBase64OrUrl(imageUrl, 'link_' + key).catch(() => null);
      if (localFile) imageUrl = '/api/avatars/' + localFile;
    }
    db.prepare(`
      INSERT INTO link_previews (url_hash, url, title, image_url, site_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        title = excluded.title,
        image_url = COALESCE(excluded.image_url, link_previews.image_url),
        site_name = COALESCE(excluded.site_name, link_previews.site_name)
    `).run(key, url, title, imageUrl, siteName);
    if (!imageUrl && /facebook\.com\/share\//i.test(url) && onImageNeeded) {
      try { onImageNeeded(key, url); } catch (_) {}
    }
    return true;
  } catch (error) {
    failedAt.set(key, Date.now());
    // Link facebook share fetch fail (NO_OG_DATA, cookie wall...) - giao
    // extension lay preview trong Chrome da dang nhap thay vi bo trống.
    if (/facebook\.com\/share\//i.test(url) && onImageNeeded) {
      try { onImageNeeded(key, url); } catch (_) {}
    }
    return false;
  } finally {
    inFlight.delete(key);
  }
}

// Hook: server.js gán để đẩy nhiệm vụ lấy ảnh qua extension (Chrome đăng
// nhập) khi fetch server-side không có og:image - đúng pattern profile Page.
let onImageNeeded = null;

function queueFetch(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const key = hashUrl(url);
  ensureTable();
  const exists = db.prepare('SELECT 1 FROM link_previews WHERE url_hash = ?').get(key);
  if (exists) return;
  if (inFlight.has(key)) return;
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < FAILED_RETRY_MS) return;
  fetchAndStore(url).catch(() => {});
}

/**
 * Gắn link_preview (nếu có cache) vào các message row và xếp hàng fetch cho
 * link chưa có preview. Được gọi từ prepareMessagesForClient - hàm chạy sync
 * nên phần fetch chỉ fire-and-forget; khi fetch xong, lần đọc kế tiếp (hoặc
 * THREAD_MESSAGES_UPDATED do caller emit) sẽ mang preview.
 */
function attachPreviews(rows = []) {
  try {
    ensureTable();
    const byHash = new Map();
    const need = [];
    for (const row of rows) {
      const url = extractFirstUrl(row.content);
      if (!url) continue;
      const key = hashUrl(url);
      row._link_url = url;
      byHash.set(key, url);
      need.push(key);
    }
    if (!need.length) return rows;
    const placeholders = need.map(() => '?').join(',');
    const cached = db.prepare(`SELECT * FROM link_previews WHERE url_hash IN (${placeholders})`).all(...need);
    const cacheMap = new Map(cached.map((c) => [c.url_hash, c]));
    for (const row of rows) {
      if (!row._link_url) continue;
      const key = hashUrl(row._link_url);
      const hit = cacheMap.get(key);
      if (hit) {
        row.link_preview = {
          url: hit.url,
          title: decodeEntities(hit.title),
          image_url: hit.image_url,
          site_name: decodeEntities(hit.site_name)
        };
        const localImage = hit.image_url && hit.image_url.startsWith('/api/avatars/');
        if ((!localImage) && /facebook\.com\/share\//i.test(hit.url) && onImageNeeded) {
          try { onImageNeeded(key, hit.url); } catch (_) {}
        }
      } else {
        queueFetch(row._link_url);
      }
    }
  } catch (_) { /* preview là tính năng phụ - không được làm hỏng việc đọc tin nhắn */ }
  return rows;
}

module.exports = { attachPreviews, extractFirstUrl, queueFetch, set onImageNeeded(fn) { onImageNeeded = fn; } };
