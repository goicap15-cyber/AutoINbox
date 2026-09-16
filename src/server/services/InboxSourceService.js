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
        if (!finalPageId) throw new Error('Thi?u Page ID');
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
  /**
   * Ensure a page_messenger source exists for pageId, then bind threadId to it.
   * Called automatically when page_dom_observer reports a message with a page_id.
   */
  static ensurePageSource({ pageId, accountId, threadId, pageName }, database = getDb()) {
    if (!pageId) return null;
    const sourceId = 'src_page_' + pageId;

    // 1. Upsert inbox_source row (idempotent)
    const existing = database.prepare('SELECT id FROM inbox_sources WHERE id = ?').get(sourceId);
    if (!existing) {
      database.prepare(`
        INSERT OR IGNORE INTO inbox_sources
          (id, source_type, owner_account_id, external_id, display_name, status)
        VALUES (?, 'page_messenger', ?, ?, ?, 'ACTIVE')
      `).run(sourceId, accountId || null, String(pageId), pageName || ('Page ' + pageId));
      console.log(`[PAGE_SOURCE] ? T? ??ng t?o page source: ${sourceId} (Page ${pageId})`);
    }

    // 2. Bind thread ? source if not already correct
    if (threadId) {
      const thread = database.prepare('SELECT source_id FROM threads WHERE id = ?').get(String(threadId));
      if (thread && thread.source_id !== sourceId) {
        database.prepare('UPDATE threads SET source_id = ? WHERE id = ?').run(sourceId, String(threadId));
        console.log(`[PAGE_SOURCE] 🔗 Thread ${threadId} gán sang source ${sourceId} (Page ${pageId})`);
      }
    }

    return this.getSourceById(sourceId, database);
  }
}

module.exports = InboxSourceService;
