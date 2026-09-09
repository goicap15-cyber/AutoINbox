const MessageQueueRepository = require('../repositories/MessageQueueRepository');
const OutboundAttachmentRepository = require('../repositories/OutboundAttachmentRepository');
const OutboundAttemptRepository = require('../repositories/OutboundAttemptRepository');

const DEFAULT_CONFIRMATION_WINDOW_MS = 2 * 60 * 1000;

class OutboundConfirmationService {
  static confirmObservation({
    threadId,
    fbMessageId,
    isOutgoing,
    mediaType = 'text',
    content = '',
    observedAt = Date.now(),
    confirmationSource
  }, {
    database = require('../database/db'),
    windowMs = DEFAULT_CONFIRMATION_WINDOW_MS
  } = {}) {
    if (
      !threadId ||
      !fbMessageId ||
      String(fbMessageId).startsWith('pending_') ||
      isOutgoing !== true
    ) return { matched: false, reason: 'INVALID_OBSERVATION' };

    const observedTime = Number(observedAt) || Date.now();
    const rows = database.prepare(
      "SELECT a.*, m.thread_id, m.client_message_id, m.content, m.media_type AS message_media_type, " +
      'm.delivery_status, oa.media_type AS attachment_media_type ' +
      'FROM outbound_attempts a JOIN messages m ON m.id = a.message_id ' +
      'LEFT JOIN outbound_attachments oa ON oa.id = a.attachment_id ' +
      "WHERE m.thread_id = ? AND m.is_outgoing = 1 AND m.delivery_status = 'pending' " +
      "AND a.status IN ('queued', 'dispatching', 'awaiting_confirmation')"
    ).all(threadId);

    const candidates = rows.filter((row) => {
      const dispatchTime = Date.parse(row.dispatched_at || row.created_at);
      if (!Number.isFinite(dispatchTime) || Math.abs(observedTime - dispatchTime) > windowMs) {
        return false;
      }
      if (row.attachment_id && row.attachment_media_type !== mediaType && mediaType !== 'text') return false;
      if (!row.attachment_id && mediaType !== 'text' && row.message_media_type !== mediaType) return false;
      const expectedText = String(row.content || '').trim();
      const observedText = String(content || '').trim();
      if (expectedText && observedText && expectedText !== observedText) return false;
      return true;
    });

    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        candidates.forEach((candidate) => {
          OutboundAttemptRepository.transition(
            candidate.id,
            ['dispatching', 'awaiting_confirmation'],
            'uncertain',
            {
              error_code: 'CONFIRMATION_AMBIGUOUS',
              error_message: 'Nhiều attempt cùng khớp một Facebook observation.'
            },
            database
          );
        });
      }
      return {
        matched: false,
        reason: candidates.length > 1 ? 'AMBIGUOUS' : 'NO_CANDIDATE'
      };
    }

    const candidate = candidates[0];
    const transaction = database.transaction(() => {
      const conflictingMessage = database.prepare(
        'SELECT id FROM messages WHERE fb_message_id = ? AND id <> ?'
      ).get(fbMessageId, candidate.message_id);
      if (conflictingMessage) {
        OutboundAttemptRepository.transition(
          candidate.id,
          ['dispatching', 'awaiting_confirmation'],
          'uncertain',
          {
            error_code: 'CONFIRMATION_ID_CONFLICT',
            error_message: 'Facebook message id đã thuộc bản ghi khác.'
          },
          database
        );
        return { matched: false, reason: 'ID_CONFLICT' };
      }

      database.prepare(
        "UPDATE messages SET fb_message_id = ?, delivery_status = 'sent', delivery_error = NULL " +
        'WHERE id = ? AND delivery_status = ?'
      ).run(fbMessageId, candidate.message_id, 'pending');
      OutboundAttemptRepository.transition(
        candidate.id,
        ['dispatching', 'awaiting_confirmation'],
        'sent',
        {
          confirmed_at: new Date(observedTime).toISOString(),
          confirmation_message_id: fbMessageId,
          confirmation_source: confirmationSource
        },
        database
      );
      if (candidate.queue_id) {
        MessageQueueRepository.updateStatus(candidate.queue_id, 'sent', null, database);
      }
      if (candidate.attachment_id) {
        OutboundAttachmentRepository.transition(
          candidate.attachment_id,
          ['queued', 'sending'],
          'sent',
          {},
          database
        );
      }
      return {
        matched: true,
        message_id: candidate.message_id,
        attempt_id: candidate.id,
        queue_id: candidate.queue_id,
        client_message_id: candidate.client_message_id,
        fb_message_id: fbMessageId,
        confirmation_source: confirmationSource
      };
    });
    return transaction();
  }
}

OutboundConfirmationService.DEFAULT_CONFIRMATION_WINDOW_MS = DEFAULT_CONFIRMATION_WINDOW_MS;
module.exports = OutboundConfirmationService;
