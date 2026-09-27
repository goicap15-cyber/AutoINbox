/**
 * InboxSourceService — CRUD for inbox_sources table.
 * Manages personal_messenger and page_messenger sources.
 */
const { encryptToken, decryptToken } = require('../utils/tokenEncryption');
let defaultDb;
function getDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

class InboxSourceService {
  /**
   * Get all inbox sources (without decrypted tokens).
   */
  static getAllSources(database = getDb()) {
    return database.prepare(`
      SELECT id, source_type, owner_account_id, external_id, display_name, avatar_url, status, webhook_verify_token, created_at
      FROM inbox_sources ORDER BY created_at ASC
    `).all();
  }

  /**
   * Get a single source by ID.
   */
  static getSourceById(id, database = getDb()) {
    return database.prepare(`
      SELECT id, source_type, owner_account_id, external_id, display_name, avatar_url, status, webhook_verify_token, created_at
      FROM inbox_sources WHERE id = ?
    `).get(id);
  }

  /**
   * Get source by external_id and type.
   */
  static getSourceByExternalId(sourceType, externalId, database = getDb()) {
    return database.prepare(`
      SELECT id, source_type, owner_account_id, external_id, display_name, avatar_url, status, created_at
      FROM inbox_sources WHERE source_type = ? AND external_id = ?
    `).get(sourceType, String(externalId));
  }

  /**
   * Create a personal_messenger source for an existing account.
   * Idempotent: if already exists, returns existing.
   */
  static createPersonalSource(accountId, displayName, database = getDb()) {
    const sourceId = 'src_personal_' + accountId;
    const existing = database.prepare('SELECT id FROM inbox_sources WHERE id = ?').get(sourceId);
    if (existing) {
      console.log(`[UNIFIED_INBOX_SOURCE_RESOLVED] Personal source already exists: ${sourceId}`);
      return this.getSourceById(sourceId, database);
    }
    database.prepare(`
      INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
      VALUES (?, 'personal_messenger', NULL, ?, ?, 'ACTIVE')
    `).run(sourceId, String(accountId), displayName || String(accountId));
    console.log(`[UNIFIED_INBOX_SOURCE_RESOLVED] Created personal source: ${sourceId} for account ${accountId}`);
    return this.getSourceById(sourceId, database);
  }

  /**
   * Create a page_messenger source by validating and storing a Page access token.
   * @param {object} params - { pageAccessToken, ownerAccountId }
   * @returns {object} The created source row
   */
  static async createPageSource({ pageAccessToken, pageId, pageName, ownerAccountId }, database = getDb()) {
    let finalPageId = pageId;
    let finalPageName = pageName || pageId;
    let avatarUrl = null;

    if (pageAccessToken) {
        // Validate token by fetching Page info from Graph API. Node 18+ exposes global fetch.
        if (typeof fetch !== 'function') throw new Error('Global fetch is not available in this Node runtime');
        const pageInfoUrl = new URL('https://graph.facebook.com/v18.0/me');
        pageInfoUrl.searchParams.set('fields', 'id,name,picture');
        pageInfoUrl.searchParams.set('access_token', pageAccessToken);
        const res = await fetch(pageInfoUrl);
        const data = await res.json();
        if (data.error) {
          throw new Error(data.error.message || 'Invalid Page access token');
        }
        finalPageId = data.id;
        finalPageName = data.name || finalPageId;
        avatarUrl = data.picture?.data?.url || null;
    } else {
        if (!finalPageId) throw new Error('Thiếu Page ID');
        // Avatar default for public page
        avatarUrl = `https://graph.facebook.com/${finalPageId}/picture?type=normal`;
    }

    // Check for duplicate
    const existing = database.prepare('SELECT id FROM inbox_sources WHERE source_type = ? AND external_id = ?').get('page_messenger', finalPageId);
    if (existing) {
      throw new Error(`Page ${finalPageName} (${finalPageId}) is already connected`);
    }

    const sourceId = 'src_page_' + finalPageId;
    const encryptedToken = pageAccessToken ? encryptToken(pageAccessToken) : null;
    const crypto = require('crypto');
    const verifyToken = crypto.randomBytes(16).toString('hex');

    database.prepare(`
      INSERT INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, avatar_url, access_token_encrypted, webhook_verify_token, status)
      VALUES (?, 'page_messenger', ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(sourceId, ownerAccountId || null, pageId, pageName, avatarUrl, encryptedToken, verifyToken);

    console.log(`[UNIFIED_INBOX_SOURCE_RESOLVED] Created page source: ${sourceId} for Page ${pageName} (${pageId})`);
    return this.getSourceById(sourceId, database);
  }

  /**
   * Remove/disconnect a source.
   */
  static removeSource(id, database = getDb()) {
    database.prepare("UPDATE inbox_sources SET status = 'DISCONNECTED' WHERE id = ?").run(id);
    console.log(`[UNIFIED_INBOX_SOURCE_RESOLVED] Source disconnected: ${id}`);
  }

  /**
   * Get decrypted Page access token for API calls.
   */
  static getDecryptedToken(sourceId, database = getDb()) {
    const row = database.prepare('SELECT access_token_encrypted FROM inbox_sources WHERE id = ?').get(sourceId);
    if (!row || !row.access_token_encrypted) return null;
    return decryptToken(row.access_token_encrypted);
  }

  /**
   * Update source status.
   */
  static updateSourceStatus(id, status, database = getDb()) {
    database.prepare('UPDATE inbox_sources SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Get source for a thread.
   */
  static getSourceForThread(threadId, database = getDb()) {
    const thread = database.prepare('SELECT source_id FROM threads WHERE id = ?').get(threadId);
    if (!thread || !thread.source_id) return null;
    return this.getSourceById(thread.source_id, database);
  }

  static isValidPageDisplayName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return false;
    // Chặn URL / Domain
    if (/(?:https?:\/\/|business\.facebook|facebook\.com|messenger\.com|\/latest\/|[?&](?:asset_id|mailbox_id)=)/i.test(trimmed)) return false;
    // Chặn chuỗi tĩnh Meta
    if (/^(?:hộp thư|inbox|messages|tin nhắn|tất cả tin nhắn|all messages|meta business suite|business suite|facebook|trang|page|\d+|đang tải(?:\.\.\.)?|loading(?:\.\.\.)?|chuyển tài khoản|chuyển đổi tài khoản|trang quản lý tài sản doanh nghiệp)$/i.test(trimmed)) return false;
    if (/^page\s+\d+$/i.test(trimmed)) return false;
    if (/^\d+$/.test(trimmed)) return false;
    if (/^(?:undefined|null|none)$/i.test(trimmed)) return false;
    return true;
  }

  /**
   * Ensure a page_messenger source exists for pageId, then bind threadId to it.
   * Called automatically when page_dom_observer reports a message with a page_id.
   */
  static ensurePageSource({ pageId, accountId, threadId, canonicalThreadId, pageName }, database = getDb()) {
    if (!pageId) return null;
    // ID profile/delegate mới (14 chữ số đầu 6155-6159) không phải ID page thật:
    // Business Suite chặn asset_id này ("nội dung không khả dụng") và tab
    // fallback /messages/t/<id> cũng không mở được inbox. Không tạo source.
    if (/^615[5-9]\d{11}$/.test(String(pageId))) {
      console.warn(`[PAGE_SOURCE] Bỏ qua ID profile/delegate ${pageId} - không tạo source page.`);
      return null;
    }
    const sourceId = 'src_page_' + pageId;
    const targetThreadId = threadId || canonicalThreadId;

    // 1. Upsert inbox_source row (idempotent)
    const existing = database.prepare('SELECT id, display_name, owner_account_id FROM inbox_sources WHERE id = ?').get(sourceId);
    if (!existing) {
      const initialDisplayName = this.isValidPageDisplayName(pageName) ? pageName.trim() : ('Page ' + pageId);
      database.prepare(`
        INSERT OR IGNORE INTO inbox_sources
          (id, source_type, owner_account_id, external_id, display_name, status)
        VALUES (?, 'page_messenger', ?, ?, ?, 'ACTIVE')
      `).run(sourceId, accountId || null, String(pageId), initialDisplayName);
      console.log(`[PAGE_SOURCE] ✅ Tự động tạo page source: ${sourceId} (${initialDisplayName})`);
    } else {
      // Gắn chủ cho row được tự tạo TRƯỚC khi user bấm "Kết nối Page":
      // các row này tồn tại với owner NULL (scan Business Suite tự phát hiện),
      // khiến danh sách "Page đã kết nối" lọc theo owner mất page và các luồng
      // ingest chặt chẽ bị từ chối. Chỉ bind khi chưa có chủ.
      if (accountId && !existing.owner_account_id) {
        database.prepare('UPDATE inbox_sources SET owner_account_id = ? WHERE id = ?').run(String(accountId), sourceId);
        console.log(`[PAGE_SOURCE] 🔗 Đã gắn owner ${accountId} cho source ${sourceId} (trước đây NULL).`);
      }
      if (pageName && this.isValidPageDisplayName(pageName) && (!existing.display_name || existing.display_name === 'Page ' + pageId || existing.display_name.startsWith('Page ') || !this.isValidPageDisplayName(existing.display_name))) {
        database.prepare('UPDATE inbox_sources SET display_name = ? WHERE id = ?').run(pageName.trim(), sourceId);
        console.log(`[PAGE_SOURCE] 🏷️ Tự động cập nhật display_name cho source ${sourceId}: "${pageName.trim()}"`);
      }
    }

    // 2. Bind thread → source if not already correct.
    // Tách kênh Page/cá nhân (2026-09-17): chỉ được gắn các thread đã
    // namespaced (page_<pageId>:<psid>) - một thread cá nhân (id thường)
    // không bao giờ bị chuyển sang nguồn Page nữa, tránh sidebar/metadata
    // của Page "chiếm" hội thoại cá nhân cùng psid.
    if (targetThreadId && (String(targetThreadId).startsWith(`page:${pageId}:`) || String(targetThreadId).startsWith(`page_${pageId}:`))) {
      const thread = database.prepare('SELECT source_id FROM threads WHERE id = ?').get(String(targetThreadId));
      if (thread && thread.source_id !== sourceId) {
        database.prepare('UPDATE threads SET source_id = ? WHERE id = ?').run(sourceId, String(targetThreadId));
        console.log(`[PAGE_SOURCE] 🔗 Thread ${targetThreadId} gán sang source ${sourceId} (Page ${pageId})`);
      }
    }

    return this.getSourceById(sourceId, database);
  }

  /**
   * Cập nhật tên hiển thị thật (display_name) của Fanpage khi bóc tách được từ DOM/Title
   */
  static updatePageDisplayName({ pageId, pageName }, database = getDb()) {
    if (!pageId || !pageName) return null;
    const cleanName = String(pageName).trim().slice(0, 100);
    if (!this.isValidPageDisplayName(cleanName)) return null;

    const sourceId = 'src_page_' + pageId;
    const existing = database.prepare('SELECT id, display_name FROM inbox_sources WHERE external_id = ? AND source_type = ?').get(String(pageId), 'page_messenger');

    if (existing) {
      if (existing.display_name !== cleanName) {
        database.prepare('UPDATE inbox_sources SET display_name = ? WHERE id = ?').run(cleanName, existing.id);
        console.log(`[PAGE_SOURCE] 🏷️ Cập nhật display_name cho page ${pageId}: "${existing.display_name}" -> "${cleanName}"`);
      }
      return this.getSourceById(existing.id, database);
    } else {
      return this.ensurePageSource({ pageId, pageName: cleanName }, database);
    }
  }
}

module.exports = InboxSourceService;
