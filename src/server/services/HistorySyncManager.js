let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

const VALID_STATUSES = new Set(['LOCAL', 'SYNCING', 'PARTIAL', 'SYNCED', 'FAILED']);

class HistorySyncManager {
  static updateSyncStatus(threadId, status, cursorObj, error = null, database = getDefaultDb()) {
    if (!VALID_STATUSES.has(status)) throw new Error('Invalid sync status: ' + status);
    if (cursorObj !== undefined && cursorObj !== null && typeof cursorObj !== 'object') throw new TypeError('sync cursor must be an object or null');

    // Keep the last good cursor when a sync fails so reconnect can resume.
    if (status === 'FAILED' && cursorObj == null) {
      database.prepare('UPDATE threads SET sync_status = ?, sync_error = ? WHERE id = ?').run(status, error, threadId);
      return;
    }

    const cursorStr = cursorObj == null ? null : JSON.stringify(cursorObj);
    database.prepare(`
      UPDATE threads
      SET sync_status = ?, sync_cursor = ?, sync_error = ?
      WHERE id = ?
    `).run(status, cursorStr, error, threadId);
  }

  // Decide PARTIAL vs SYNCED from what the crawler actually reported, instead of
  // treating "we got a checkpoint back" as proof the history is complete.
  // Missing/legacy checkpoints (no stop_reason - written before this field
  // existed) default to SYNCED so already-synced threads are never silently
  // downgraded to PARTIAL by this change.
  static resolveStatusFromCheckpoint(checkpoint) {
    if (!checkpoint || !checkpoint.stop_reason) return 'SYNCED';
    if (checkpoint.stop_reason === 'on_demand_page') return 'PARTIAL';
    if (checkpoint.boundary_reached || checkpoint.stop_reason === 'no_scroll_growth') return 'SYNCED';
    if (checkpoint.stop_reason === 'max_rounds_hit') return 'PARTIAL';
    return 'SYNCED';
  }

  static getSyncState(threadId, database = getDefaultDb()) {
    const thread = database.prepare('SELECT sync_status, sync_cursor, sync_error FROM threads WHERE id = ?').get(threadId);
    if (!thread) return null;
    let cursorObj = null;
    if (thread.sync_cursor) {
      try { cursorObj = JSON.parse(thread.sync_cursor); }
      catch (e) { console.error('Failed to parse sync_cursor', e); }
    }
    return { sync_status: thread.sync_status || 'LOCAL', sync_cursor: cursorObj, sync_error: thread.sync_error };
  }
}

module.exports = HistorySyncManager;
