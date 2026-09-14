class InboundMediaHydrationService {
  constructor({ database, downloader, onHydrated = null, logger = console, maxConcurrency = 2, failedCooldownMs = 120000, batchLimit = 32 }) {
    this.database = database;
    this.downloader = downloader;
    this.onHydrated = onHydrated;
    this.logger = logger;
    this.inFlight = new Map();
    this.failedUntil = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 2);
    this.failedCooldownMs = Math.max(1000, Number(failedCooldownMs) || 120000);
    this.batchLimit = Math.max(1, Number(batchLimit) || 32);
  }

  findMissingMedia(threadId, limit = this.batchLimit) {
    return this.database.prepare(`
      SELECT id, thread_id, fb_message_id, media_type, media_url
      FROM messages
      WHERE thread_id = ?
        AND media_type IN ('image', 'video', 'voice', 'file')
        AND media_url LIKE 'http%'
        AND (local_media_path IS NULL OR local_media_path = '')
      ORDER BY id DESC
      LIMIT ?
    `).all(String(threadId), Math.max(1, Number(limit) || this.batchLimit));
  }

  hydrateThread(threadId) {
    const rows = this.findMissingMedia(threadId);
    for (const row of rows) this.hydrateRow(row);
    return rows.length;
  }

  async hydrateThreadAndWait(threadId) {
    const rows = this.findMissingMedia(threadId);
    await Promise.all(rows.map((row) => this.hydrateRow(row)));
    return rows.length;
  }

  mediaKey(row) {
    return `${String(row.thread_id)}:${String(row.media_type || 'file')}:${String(row.media_url)}`;
  }

  notifyHydratedRows(rows) {
    if (typeof this.onHydrated !== 'function') return;
    for (const stored of rows) this.onHydrated(stored);
  }

  applyLocalPath(row, localPath) {
    this.database.prepare(`
      UPDATE messages SET local_media_path = ?
      WHERE thread_id = ? AND media_url = ?
        AND (local_media_path IS NULL OR local_media_path = '')
    `).run(localPath, String(row.thread_id), String(row.media_url));
    const storedRows = this.database.prepare(`
      SELECT * FROM messages
      WHERE thread_id = ? AND media_url = ? AND local_media_path = ?
      ORDER BY id ASC
    `).all(String(row.thread_id), String(row.media_url), localPath);
    this.notifyHydratedRows(storedRows);
    return storedRows.find((stored) => String(stored.id) === String(row.id)) || storedRows[0] || null;
  }

  reuseExistingLocalPath(row) {
    const existing = this.database.prepare(`
      SELECT local_media_path FROM messages
      WHERE thread_id = ? AND media_url = ?
        AND local_media_path IS NOT NULL AND local_media_path <> ''
      ORDER BY id DESC LIMIT 1
    `).get(String(row.thread_id), String(row.media_url));
    return existing?.local_media_path ? this.applyLocalPath(row, existing.local_media_path) : null;
  }

  drainQueue() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const queued = this.queue.shift();
      this.activeCount += 1;
      this.runQueuedHydration(queued);
    }
  }

  async runQueuedHydration({ row, key, resolve }) {
    const startedAt = Date.now();
    try {
      const localPath = await this.downloader.downloadNewMessageMedia(row.thread_id, row.media_url, row.media_type);
      if (!localPath) {
        this.failedUntil.set(key, Date.now() + this.failedCooldownMs);
        resolve(null);
        return;
      }
      this.failedUntil.delete(key);
      const stored = this.applyLocalPath(row, localPath);
      this.logger.log?.('[INBOUND_MEDIA] Hydrated:', {
        message_id: row.id, thread_id: row.thread_id, media_type: row.media_type,
        duration_ms: Date.now() - startedAt
      });
      resolve(stored);
    } catch (error) {
      this.failedUntil.set(key, Date.now() + this.failedCooldownMs);
      this.logger.warn?.('[INBOUND_MEDIA] Hydration failed:', {
        message_id: row.id, thread_id: row.thread_id, media_type: row.media_type,
        duration_ms: Date.now() - startedAt, error: error?.message || String(error)
      });
      resolve(null);
    } finally {
      this.inFlight.delete(key);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drainQueue();
    }
  }

  hydrateRow(row) {
    if (!row?.id || !row?.thread_id || !row?.media_url) return Promise.resolve(null);
    const reused = this.reuseExistingLocalPath(row);
    if (reused) return Promise.resolve(reused);

    const key = this.mediaKey(row);
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if ((this.failedUntil.get(key) || 0) > Date.now()) return Promise.resolve(null);

    let resolveTask;
    const task = new Promise((resolve) => { resolveTask = resolve; });
    this.inFlight.set(key, task);
    this.queue.push({ row, key, resolve: resolveTask });
    this.drainQueue();
    return task;
  }
}

module.exports = InboundMediaHydrationService;
