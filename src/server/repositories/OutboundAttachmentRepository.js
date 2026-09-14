let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

class OutboundAttachmentRepository {
  static normalizeMediaType(row) {
    if (!row) return null;
    const name = String(row.safe_name || row.original_name || row.storage_path || '').toLowerCase();
    const videoMime = name.endsWith('.mp4')
      ? 'video/mp4'
      : name.endsWith('.mov')
        ? 'video/quicktime'
        : name.endsWith('.avi')
          ? 'video/x-msvideo'
          : null;
    return videoMime || String(row.mime_type || '').startsWith('video/')
      ? { ...row, media_type: 'video', mime_type: videoMime || row.mime_type }
      : row;
  }

  static create(data, database = getDefaultDb()) {
    database.prepare(
      'INSERT INTO outbound_attachments ' +
      '(id, thread_id, created_by, original_name, safe_name, media_type, mime_type, byte_size, storage_path, checksum_sha256, status, validation_error, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      data.id,
      data.thread_id,
      data.created_by ?? null,
      data.original_name,
      data.safe_name,
      data.media_type,
      data.mime_type,
      data.byte_size,
      data.storage_path,
      data.checksum_sha256,
      data.status || 'staged',
      data.validation_error || null,
      data.expires_at || null
    );
    return this.getById(data.id, database);
  }

  static getById(id, database = getDefaultDb()) {
    return this.normalizeMediaType(
      database.prepare('SELECT * FROM outbound_attachments WHERE id = ?').get(id) || null
    );
  }

  static getForThread(id, threadId, database = getDefaultDb()) {
    return this.normalizeMediaType(database.prepare(
      'SELECT * FROM outbound_attachments WHERE id = ? AND thread_id = ?'
    ).get(id, threadId) || null);
  }

  static bindToMessage(id, messageId, database = getDefaultDb()) {
    return database.prepare(
      "UPDATE outbound_attachments SET status = 'queued', consumed_by_message_id = ?, expires_at = NULL " +
      "WHERE id = ? AND status = 'staged' AND consumed_by_message_id IS NULL"
    ).run(messageId, id).changes === 1;
  }

  static transition(id, fromStatuses, toStatus, fields = {}, database = getDefaultDb()) {
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) return false;
    const allowedFields = new Set(['validation_error', 'expires_at']);
    const entries = Object.entries(fields).filter(([key]) => allowedFields.has(key));
    const assignments = ['status = ?', ...entries.map(([key]) => key + ' = ?')];
    const placeholders = fromStatuses.map(() => '?').join(', ');
    const values = [toStatus, ...entries.map(([, value]) => value), id, ...fromStatuses];
    return database.prepare(
      'UPDATE outbound_attachments SET ' + assignments.join(', ') +
      ' WHERE id = ? AND status IN (' + placeholders + ')'
    ).run(...values).changes === 1;
  }

  static discardStaged(id, threadId, createdBy = null, database = getDefaultDb()) {
    const creatorClause = createdBy == null ? '' : ' AND created_by = ?';
    const args = createdBy == null ? [id, threadId] : [id, threadId, createdBy];
    return database.prepare(
      "UPDATE outbound_attachments SET status = 'deleted', expires_at = NULL " +
      "WHERE id = ? AND thread_id = ? AND status = 'staged' " +
      'AND consumed_by_message_id IS NULL' + creatorClause
    ).run(...args).changes === 1;
  }

  static listExpired(nowIso, database = getDefaultDb()) {
    return database.prepare(
      "SELECT * FROM outbound_attachments WHERE status = 'staged' " +
      'AND consumed_by_message_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ? ' +
      'ORDER BY expires_at ASC'
    ).all(nowIso);
  }

  static countLiveStorageReferences(storagePath, excludingId = null, database = getDefaultDb()) {
    return database.prepare(
      "SELECT COUNT(*) AS count FROM outbound_attachments WHERE storage_path = ? " +
      "AND status NOT IN ('expired', 'deleted') AND (? IS NULL OR id <> ?)"
    ).get(storagePath, excludingId, excludingId).count;
  }
}

module.exports = OutboundAttachmentRepository;
