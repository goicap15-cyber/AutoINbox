const crypto = require('crypto');

let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

class MessageQueueRepository {
  static insert(messageData, database = getDefaultDb()) {
    if (messageData.idempotency_key) {
      const existing = database.prepare(
        'SELECT id FROM message_queue WHERE idempotency_key = ?'
      ).get(messageData.idempotency_key);
      if (existing) return existing.id;
    }
    const id = crypto.randomUUID();
    try {
      // contract_version=2 whenever there's an attachment (or manifest) to
      // verify, so QueueWorker.buildAttachment()/buildAttachmentManifest()
      // actually run their byte-size/checksum integrity check before dispatch
      // (they gate on this column) - matters for campaign image/file sends
      // the same way it already does for 1:1 rich messages via
      // insertRichMessage. Text-only rows stay at the schema default (1).
      const contractVersion = (messageData.attachment_id || messageData.manifest_id) ? 2 : 1;
      database.prepare(`
        INSERT INTO message_queue
          (id, thread_id, account_id, source_id, source_type, page_id, content,
           attachment_id, attachment_path, attachment_mime_type, attachment_name,
           attachment_media_type, attachment_byte_size, attachment_checksum, manifest_id, contract_version,
           campaign_id, campaign_recipient_id, campaign_attempt_id, idempotency_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        id,
        messageData.thread_id,
        messageData.account_id,
        messageData.source_id || null,
        messageData.source_type || null,
        messageData.page_id || null,
        messageData.content || '',
        messageData.attachment_id || null,
        messageData.attachment_path || null,
        messageData.attachment_mime_type || null,
        messageData.attachment_name || null,
        messageData.attachment_media_type || null,
        messageData.attachment_byte_size || null,
        messageData.attachment_checksum || null,
        messageData.manifest_id || null,
        contractVersion,
        messageData.campaign_id || null,
        messageData.campaign_recipient_id || null,
        messageData.campaign_attempt_id || null,
        messageData.idempotency_key || null
      );
      return id;
    } catch (error) {
      if (
        messageData.idempotency_key &&
        /UNIQUE constraint failed: message_queue.idempotency_key/.test(error.message)
      ) {
        const existing = database.prepare(
          'SELECT id FROM message_queue WHERE idempotency_key = ?'
        ).get(messageData.idempotency_key);
        if (existing) return existing.id;
      }
      throw error;
    }
  }

  static insertCampaignDispatch(messageData, database = getDefaultDb()) {
    const transaction = database.transaction(() => {
      const queueId = this.insert(messageData, database);
      const clientMessageId = 'queue_' + queueId;
      const pendingFbId = 'pending_' + clientMessageId;
      const existingMessage = database.prepare(
        'SELECT id FROM messages WHERE client_message_id = ? OR fb_message_id = ?'
      ).get(clientMessageId, pendingFbId);
      let messageId = existingMessage?.id || null;
      if (!messageId) {
        const hasAttachment = !!(messageData.attachment_id || messageData.attachment_path);
        const mediaType = messageData.attachment_media_type || messageData.media_type || (hasAttachment ? 'image' : 'text');
        // Convert the absolute local path to a URL the browser can fetch.
        // The server exposes campaign-attachment files at /api/campaign-attachments/<filename>.
        let localMediaPath = null;
        if (messageData.attachment_path) {
          const fname = messageData.attachment_path.replace(/\\/g, '/').split('/').pop();
          localMediaPath = '/api/campaign-attachments/' + fname;
        }

        const result = database.prepare(
          "INSERT INTO messages (thread_id, fb_message_id, client_message_id, sender_id, content, local_media_path, media_type, is_outgoing, delivery_status) VALUES (?, ?, ?, 'SYSTEM', ?, ?, ?, 1, 'pending')"
        ).run(
          messageData.thread_id,
          pendingFbId,
          clientMessageId,
          messageData.content || '',
          localMediaPath,
          mediaType
        );
        messageId = result.lastInsertRowid;
      }
      database.prepare(
        'UPDATE threads SET last_message = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(messageData.content || '', messageData.thread_id);
      return { queueId, clientMessageId, messageId };
    });
    return transaction();
  }

  static insertRichMessage(messageData, database = getDefaultDb()) {
    const id = crypto.randomUUID();
    database.prepare(
      'INSERT INTO message_queue ' +
      '(id, thread_id, account_id, source_id, source_type, page_id, content, ' +
      'attachment_id, attachment_path, attachment_mime_type, attachment_name, ' +
      'outbound_attempt_id, attachment_media_type, attachment_byte_size, attachment_checksum, ' +
      'contract_version, idempotency_key, status) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, NULL, 'pending')"
    ).run(
      id,
      messageData.thread_id,
      messageData.account_id,
      messageData.source_id || null,
      messageData.source_type || null,
      messageData.page_id || null,
      messageData.content || '',
      messageData.attachment_id || null,
      messageData.attachment_path || null,
      messageData.attachment_mime_type || null,
      messageData.attachment_name || null,
      messageData.outbound_attempt_id,
      messageData.attachment_media_type || null,
      messageData.attachment_byte_size || null,
      messageData.attachment_checksum || null
    );
    return id;
  }

  static popPending(database = getDefaultDb()) {
    const transaction = database.transaction(() => {
      const row = database.prepare(`
        SELECT m.id, m.thread_id, m.account_id, m.content, m.status,
               t.thread_url, t.contact_name AS expected_contact_name,
               CASE WHEN m.campaign_id IS NOT NULL THEN m.source_id
                    ELSE COALESCE(m.source_id, t.source_id) END AS source_id,
               CASE WHEN m.campaign_id IS NOT NULL THEN m.source_type
                    ELSE COALESCE(m.source_type, s.source_type) END AS source_type,
               CASE WHEN m.campaign_id IS NOT NULL THEN m.page_id
                    ELSE COALESCE(m.page_id, s.external_id) END AS page_id,
               m.attachment_id, m.attachment_path, m.attachment_mime_type, m.attachment_name,
               m.outbound_attempt_id, m.attachment_media_type, m.attachment_byte_size,
               m.attachment_checksum, m.manifest_id, m.contract_version,
               m.campaign_id, m.campaign_recipient_id, m.campaign_attempt_id, m.idempotency_key
        FROM message_queue m
        LEFT JOIN threads t ON t.id = m.thread_id
        LEFT JOIN inbox_sources s ON s.id = t.source_id
        WHERE m.status = 'pending'
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 1
      `).get();
      if (!row) return null;
      const claimed = database.prepare(`
        UPDATE message_queue
        SET status = 'processing', processed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(row.id);
      return claimed.changes ? { ...row, status: 'processing' } : null;
    });
    return transaction();
  }

  static updateStatus(id, status, errorReason = null, database = getDefaultDb()) {
    return database.prepare(`
      UPDATE message_queue SET status = ?, error_reason = ? WHERE id = ?
    `).run(status, errorReason, id).changes > 0;
  }

  static getStatus(id, database = getDefaultDb()) {
    return database.prepare('SELECT * FROM message_queue WHERE id = ?').get(id);
  }

  static getByAttemptId(attemptId, database = getDefaultDb()) {
    return database.prepare(
      'SELECT * FROM message_queue WHERE campaign_attempt_id = ?'
    ).get(attemptId);
  }
}

module.exports = MessageQueueRepository;
