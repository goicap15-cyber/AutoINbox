const MessageQueueRepository = require('../repositories/MessageQueueRepository');
const OutboundConfirmationService = require('./OutboundConfirmationService');

let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

function updateQueueStatusFromClientMessage(clientMessageId, status, errorReason = null, database = getDefaultDb()) {
  if (typeof clientMessageId !== 'string' || !clientMessageId.startsWith('queue_')) return false;
  const queueId = clientMessageId.slice('queue_'.length);
  if (!queueId) return false;
  return MessageQueueRepository.updateStatus(queueId, status, errorReason, database);
}

class OutboundDomCorrelationService {
  static hasRecentCrmImageOutbound(database, threadId, observedTimestamp = 0) {
    const observed = Number(observedTimestamp) || Date.now();
    return Boolean(database.prepare(`
      SELECT 1 FROM messages
      WHERE thread_id = ? AND is_outgoing = 1
        AND client_message_id IS NOT NULL
        AND media_type = 'image'
        AND ABS(COALESCE(NULLIF(timestamp_ms, 0), ?) - ?) <= 180000
      LIMIT 1
    `).get(threadId, observed, observed));
  }

  static findTemporaryIdUpgrade(database, threadId, message, isMedia = false) {
    if (!message?.fb_message_id) return null;
    const observedTimestamp = Number(message.timestamp_ms) || Date.parse(message.created_at || '') || Date.now();
    const mediaClause = isMedia
      ? `(attachment_id IS NOT NULL OR (media_type IS NOT NULL AND media_type != 'text'))`
      : `COALESCE(content, '') = COALESCE(?, '') AND attachment_id IS NULL AND (media_type IS NULL OR media_type = 'text')`;
    const params = isMedia
      ? [threadId, message.fb_message_id, observedTimestamp, observedTimestamp, observedTimestamp, observedTimestamp]
      : [threadId, message.fb_message_id, message.content || '', observedTimestamp, observedTimestamp, observedTimestamp, observedTimestamp];
    return database.prepare(`
      SELECT id, client_message_id, fb_message_id, timestamp_ms
      FROM messages
      WHERE thread_id = ? AND is_outgoing = 1 AND (delivery_status = 'sent' OR delivery_status = 'pending')
        AND fb_message_id IS NOT NULL AND fb_message_id != ?
        AND (fb_message_id NOT LIKE 'mid.%' OR client_message_id IS NOT NULL)
        AND ${mediaClause}
        AND ABS(COALESCE(NULLIF(timestamp_ms, 0), ?) - ?) <= 90000
      ORDER BY ABS(COALESCE(NULLIF(timestamp_ms, 0), ?) - ?) ASC, id DESC
      LIMIT 1
    `).get(...params);
  }

  static collapseStoredTemporaryIdUpgrades(database, threadId) {
    const officialRows = database.prepare(`
      SELECT * FROM messages WHERE thread_id = ? AND is_outgoing = 1 AND fb_message_id LIKE 'mid.%' ORDER BY id ASC
    `).all(threadId);
    let collapsed = 0;
    for (const official of officialRows) {
      const temporary = this.findTemporaryIdUpgrade(database, threadId, official, this.isMediaConfirmationEvent(official));
      if (!temporary) continue;
      database.prepare('DELETE FROM messages WHERE id = ?').run(official.id);
      database.prepare(`
        UPDATE messages SET fb_message_id = ?, media_type = COALESCE(?, media_type),
          media_url = COALESCE(?, media_url), local_media_path = COALESCE(?, local_media_path),
          timestamp_ms = CASE WHEN ? > 0 THEN ? ELSE timestamp_ms END,
          timestamp_source = COALESCE(?, timestamp_source) WHERE id = ?
      `).run(official.fb_message_id, official.media_type, official.media_url, official.local_media_path,
        Number(official.timestamp_ms) || 0, Number(official.timestamp_ms) || 0, official.timestamp_source, temporary.id);
      collapsed += 1;
    }
    return collapsed;
  }

  static mediaParentMessageId(fbMessageId) {
    const value = String(fbMessageId || '');
    return value.endsWith('_media') ? value.slice(0, -'_media'.length) : null;
  }

  static mergeMediaCompanion(database, threadId, message, isOutgoing) {
    const parentFbMessageId = this.mediaParentMessageId(message?.fb_message_id);
    if (!parentFbMessageId) return null;
    // Search parent WITHOUT filtering by is_outgoing: the parent row may have
    // been wrongly stored as is_outgoing=0 by a noisy history crawl even though
    // the _media companion (created at send time) carries is_outgoing=1. We
    // always preserve the highest confidence direction after the merge.
    const parent = database.prepare(`
      SELECT * FROM messages
      WHERE thread_id = ? AND fb_message_id = ?
      LIMIT 1
    `).get(threadId, parentFbMessageId);
    // If either the _media companion or the parent was confirmed outgoing,
    // the merged row must also be outgoing. Never let an incoming parent
    // overwrite an outgoing companion.
    const mergedIsOutgoing = (isOutgoing || Number(parent?.is_outgoing) === 1) ? 1 : 0;

    // For our own send, Facebook emits a text/base row plus a _media row,
    // while CRM already owns a temporary attachment row. Upgrade that durable
    // CRM row first; otherwise merging into the Facebook base leaves two images.
    if (isOutgoing) {
      // When the base Facebook id already belongs to the CRM-owned attachment,
      // it is the exact parent. Merge the late _media companion into it before
      // any fuzzy recent-media lookup can select a different send.
      if (parent && (parent.attachment_id || parent.client_message_id)) {
        database.prepare(`UPDATE messages SET media_type = ?,
          media_url = CASE WHEN attachment_id IS NOT NULL THEN media_url ELSE COALESCE(?, media_url) END,
          local_media_path = COALESCE(local_media_path, ?)
          WHERE id = ?`).run(message.media_type || 'image', message.media_url || null,
            message.local_media_path || null, parent.id);
        return database.prepare('SELECT * FROM messages WHERE id = ?').get(parent.id);
      }
      const temporary = this.findTemporaryIdUpgrade(database, threadId, {
        ...message, fb_message_id: parentFbMessageId
      }, true);
      if (temporary) {
        if (parent && parent.id !== temporary.id) database.prepare('DELETE FROM messages WHERE id = ?').run(parent.id);
        database.prepare(`
          UPDATE messages SET fb_message_id = ?, media_type = ?,
            media_url = CASE WHEN attachment_id IS NOT NULL THEN media_url ELSE COALESCE(?, media_url) END,
            local_media_path = COALESCE(local_media_path, ?),
            -- The CRM-created attachment row owns display time/order. The
            -- Messenger observation confirms transport only; it must not move
            -- or replace the already-visible CRM image bubble.
            timestamp_ms = timestamp_ms,
            timestamp_source = timestamp_source,
            sequence_order = sequence_order,
            content = CASE
              WHEN TRIM(COALESCE(content, '')) GLOB '[0-9]*'
               AND LENGTH(TRIM(COALESCE(content, ''))) <= 2
               AND CAST(TRIM(content) AS INTEGER) = CAST((? / 60000) AS INTEGER) % 60
              THEN '' ELSE content END
          WHERE id = ?
        `).run(parentFbMessageId, message.media_type || 'image', message.media_url || null,
          message.local_media_path || null,
          Number(message.timestamp_ms) || 0, temporary.id);
        return database.prepare('SELECT * FROM messages WHERE id = ?').get(temporary.id);
      }
    }
    if (!parent) return null;
    database.prepare(`
      UPDATE messages SET
        media_type = CASE WHEN ? IS NOT NULL AND ? != 'text' THEN ? ELSE media_type END,
        media_url = CASE WHEN attachment_id IS NOT NULL THEN media_url ELSE COALESCE(?, media_url) END,
        local_media_path = COALESCE(?, local_media_path),
        timestamp_ms = CASE WHEN ? > 0 THEN ? ELSE timestamp_ms END,
        timestamp_source = COALESCE(?, timestamp_source),
        sequence_order = COALESCE(?, sequence_order),
        is_outgoing = ?,
        sender_id = CASE WHEN ? = 1 THEN COALESCE(sender_id, 'current_user') ELSE sender_id END,
        sender_role = CASE WHEN ? = 1 THEN 'operator' ELSE sender_role END,
        direction_status = CASE WHEN ? = 1 THEN 'confirmed' ELSE direction_status END,
        content = CASE
          WHEN TRIM(COALESCE(content, '')) GLOB '[0-9]*'
           AND LENGTH(TRIM(COALESCE(content, ''))) <= 2
           AND CAST(TRIM(content) AS INTEGER) = CAST((? / 60000) AS INTEGER) % 60
          THEN '' ELSE content END
      WHERE id = ?
    `).run(message.media_type || null, message.media_type || null, message.media_type || null,
      message.media_url || null, message.local_media_path || null,
      Number(message.timestamp_ms) || 0, Number(message.timestamp_ms) || 0, message.timestamp_source || null,
      Number.isFinite(Number(message.sequence_order)) ? Number(message.sequence_order) : null,
      mergedIsOutgoing,
      mergedIsOutgoing, mergedIsOutgoing, mergedIsOutgoing,
      Number(message.timestamp_ms) || 0, parent.id);
    return database.prepare('SELECT * FROM messages WHERE id = ?').get(parent.id);
  }

  static collapseStoredMediaCompanions(database, threadId) {
    const companions = database.prepare(`
      SELECT media.id AS media_id, media.media_type, media.media_url, media.local_media_path
      FROM messages media
      WHERE media.thread_id = ? AND media.fb_message_id LIKE '%_media'
        AND media.client_message_id IS NULL
        AND media.attachment_id IS NULL
        AND media.latest_attempt_id IS NULL
    `).all(threadId);
    for (const row of companions) {
      const media = database.prepare('SELECT * FROM messages WHERE id = ?').get(row.media_id);
      const merged = this.mergeMediaCompanion(database, threadId, media, Boolean(media.is_outgoing));
      // A CRM-owned attachment can be upgraded to a Facebook id ending in
      // _media. It is the durable row referenced by outbound attempts, not a
      // disposable companion. Never delete the row returned by the merge.
      if (merged && Number(merged.id) !== Number(row.media_id)) {
        database.prepare('DELETE FROM messages WHERE id = ?').run(row.media_id);
      }
    }
    return companions.length;
  }

  /**
   * Spec 040 T020: a DOM-observed event carries real media evidence
   * (media_url, or a media_type other than 'text') regardless of whether a
   * caption is also present - page_content.js's resolveMessageContent now
   * reports kind:'media' with a caption instead of silently losing the image
   * when both are found in the same DOM wrapper (confirmed live 2026-08-17/18
   * for a file-transport image manifest sent with a caption). Requiring an
   * EMPTY caption to treat an event as media confirmation meant a real,
   * successful file-transport send with a caption could never be recognized
   * as sent - it fell through to the text-only match, which correctly
   * refuses to confirm an attachment/manifest dispatch by content alone (see
   * matchPendingOutboundByRawContent above), so it would time out and get
   * resent for real since QUEUE_CONFIRMATION_TIMEOUT is retryable.
   */
  static isMediaConfirmationEvent(m) {
    return !!(m?.media_url || (m?.media_type && m.media_type !== 'text'));
  }

  /**
   * A DOM observer's raw scrape of our own just-sent bubble can get fully
   * collapsed to '' by cleanMessageText's junk-pattern pass (it targets exactly
   * the kind of status/timestamp-surrounded text a fresh Business Suite
   * confirmation looks like) - so this matches on the RAW text instead, against
   * only what we ourselves are actively waiting to confirm in that exact
   * thread. Bounded to one confirmation-cycle window (same constant
   * OutboundConfirmationService already uses) so a stale, unrelated pending row
   * from much earlier can't be coincidentally claimed by a later echo.
   *
   * Excludes any pending row whose dispatch carries an attachment/manifest
   * (spec 039/040): a text-only DOM scrape proves the caption rendered, not
   * that the file(s) actually attached and sent - live testing showed
   * Facebook can post the caption alone while the file silently fails to
   * attach, and this content-only match would otherwise mark the whole
   * dispatch (including the unverified files) as falsely 'sent'. Such
   * dispatches are left pending for matchPendingImageOutbound (an explicit
   * media observation) or the confirmation timeout (fails to 'unknown'
   * rather than a false positive) - see FR-007/FR-012 in specs 039/040.
   */
  static matchPendingOutboundByRawContent(database, threadId, rawContent) {
    if (!rawContent) return null;
    const windowSeconds = Math.round(OutboundConfirmationService.DEFAULT_CONFIRMATION_WINDOW_MS / 1000);
    const candidate = database.prepare(`
      SELECT outbound.id, outbound.client_message_id, outbound.content FROM messages outbound
      LEFT JOIN outbound_attempts attempt ON outbound.latest_attempt_id = attempt.id
      LEFT JOIN message_queue queued ON (
        outbound.client_message_id = 'queue_' || queued.id
        OR attempt.id = queued.outbound_attempt_id
      )
      WHERE outbound.thread_id = ? AND outbound.is_outgoing = 1 AND outbound.delivery_status = 'pending'
        AND datetime(outbound.created_at) >= datetime('now', '-' || ? || ' seconds')
        AND (queued.id IS NULL OR (queued.attachment_id IS NULL AND queued.manifest_id IS NULL))
        AND outbound.attachment_id IS NULL AND (outbound.media_type IS NULL OR outbound.media_type = 'text')
      ORDER BY outbound.id ASC LIMIT 1
    `).get(threadId, windowSeconds);
    if (!candidate) return null;
    const pendingContent = String(candidate.content || '').trim();
    if (!pendingContent) return null;
    if (rawContent === pendingContent || rawContent.includes(pendingContent) || pendingContent.includes(rawContent)) {
      return candidate;
    }
    return null;
  }

  /**
   * A DOM image observation carries nothing comparable to a specific
   * attachment (no checksum/id is recoverable from a rendered Facebook
   * image), so thread + "has an attachment" is the strongest signal
   * available - unlike the text match above, this cannot require exact
   * content equality. Bounding by the same confirmation window at least
   * keeps a long-stale pending image in this thread from being coincidentally
   * claimed by an unrelated later image confirmation.
   *
   * @param {string} mediaType - 'image' | 'video' | 'any' (default 'any').
   *   Pass 'image' to exclude video pending rows so an image DOM observation
   *   cannot accidentally claim a video that is stuck in awaiting_confirmation.
   *   Pass 'video' to match only video pending rows. 'any' is the legacy
   *   behaviour (no media_type filter) used when the caller doesn't know the
   *   observed media type.
   */
  static matchPendingImageOutbound(database, threadId, mediaType = 'any') {
    const windowSeconds = Math.round(OutboundConfirmationService.DEFAULT_CONFIRMATION_WINDOW_MS / 1000);

    // Build an extra WHERE clause that restricts attachment media_type when
    // the caller knows what it saw. This prevents cross-type false matches:
    // - An image DOM event must not consume a pending video attempt (video
    //   may still be uploading or temporarily stuck – it should time out to
    //   failed on its own, not be stolen by the next image send).
    // - A video DOM event must not consume a pending image attempt.
    const normalizedMediaType = ['image', 'video', 'file'].includes(String(mediaType || '').toLowerCase())
      ? String(mediaType).toLowerCase()
      : 'any';
    const mediaTypeClause = normalizedMediaType === 'any'
      ? ''
      : "AND LOWER(COALESCE(oa.media_type, queued.attachment_media_type, outbound.media_type, '')) = ?";
    const params = normalizedMediaType === 'any'
      ? [threadId, windowSeconds]
      : [threadId, windowSeconds, normalizedMediaType];

    return database.prepare(`
      SELECT outbound.id, outbound.client_message_id, outbound.thread_id, outbound.attachment_id, outbound.media_type
      FROM messages outbound
      LEFT JOIN outbound_attempts attempt ON outbound.latest_attempt_id = attempt.id
      LEFT JOIN message_queue queued ON (
        outbound.client_message_id = 'queue_' || queued.id
        OR attempt.id = queued.outbound_attempt_id
      )
      LEFT JOIN outbound_attachments oa ON oa.id = COALESCE(outbound.attachment_id, queued.attachment_id)
      WHERE outbound.thread_id = ? AND outbound.is_outgoing = 1
        AND outbound.delivery_status = 'pending'
        AND (
          outbound.attachment_id IS NOT NULL
          OR (outbound.media_type IS NOT NULL AND outbound.media_type != 'text')
          OR queued.attachment_id IS NOT NULL
          OR queued.manifest_id IS NOT NULL
        )
        AND datetime(outbound.created_at) >= datetime('now', '-' || ? || ' seconds')
        ${mediaTypeClause}
      ORDER BY outbound.id ASC LIMIT 1
    `).get(...params) || null;
  }

  /**
   * Shared "mark a pending outbound row as sent" step, used both by the early
   * raw-content match above and the legacy content-match correlation in
   * server.js - keeps one place that performs this update instead of a third
   * parallel variant. Returns false (no-op) if this fb/dom id was already
   * claimed by another row (replay-safe).
   */
  static confirmPendingOutbound(database, ioServer, pendingRow, { fbMessageId, tsMs = 0, tsSource = 'unknown', rawMessage }) {
    const confirmedId = fbMessageId || `dom_${pendingRow.client_message_id}`;
    if (fbMessageId) {
      // A real Facebook id confirms exactly one send. Reject echoes whose id
      // was already consumed by another attempt (stale history bubble).
      const ownAttempt = database.prepare('SELECT latest_attempt_id FROM messages WHERE id = ?').get(pendingRow.id);
      const recycled = database.prepare(
        'SELECT id FROM outbound_attempts WHERE confirmation_message_id = ?'
      ).get(fbMessageId);
      if (recycled && recycled.id !== ownAttempt?.latest_attempt_id) {
        console.log(`[WS] Confirmation id ${fbMessageId} was already consumed by attempt ${recycled.id}; stale echo skipped.`);
        return false;
      }
    }
    const existingConfirmed = database.prepare(
      'SELECT id, thread_id, is_outgoing, media_type, media_url, attachment_id, timestamp_ms FROM messages WHERE fb_message_id = ?'
    ).get(confirmedId);
    if (existingConfirmed) {
      if (existingConfirmed.id === pendingRow.id) {
        return false;
      }
      if (existingConfirmed.is_outgoing === 0) {
        console.log(`[WS] Removing duplicate misidentified incoming row ${existingConfirmed.id} in favor of pending outbound row ${pendingRow.id}`);
        database.prepare('DELETE FROM messages WHERE id = ?').run(existingConfirmed.id);
      } else if (
        (pendingRow.attachment_id || (pendingRow.media_type && pendingRow.media_type !== 'text')) &&
        (existingConfirmed.media_url || (existingConfirmed.media_type && existingConfirmed.media_type !== 'text')) &&
        String(existingConfirmed.thread_id) === String(pendingRow.thread_id || rawMessage?.thread_id)
      ) {
        // History sync can persist Facebook's official media row before the
        // realtime observer confirms the CRM-owned pending attachment. Keep
        // the durable CRM row (preview/order/client id) and collapse the echo.
        database.prepare('DELETE FROM messages WHERE id = ?').run(existingConfirmed.id);
      } else {
        console.log(`[WS] Confirmed ID ${confirmedId} already belongs to outgoing row ${existingConfirmed.id}; pending match skipped.`);
        return false;
      }
    }
    database.prepare(`
      UPDATE messages SET fb_message_id = ?, delivery_status = 'sent', delivery_error = NULL,
        -- The pending row was stamped at send time. A confirmation echo may
        -- arrive late carrying only an observation time; confirming transport
        -- must not move the already-visible bubble below newer messages.
        timestamp_ms = CASE WHEN timestamp_ms > 0 THEN timestamp_ms WHEN ? > 0 THEN ? ELSE timestamp_ms END,
        timestamp_source = CASE WHEN timestamp_ms > 0 THEN timestamp_source WHEN ? <> 'unknown' THEN ? ELSE timestamp_source END
      WHERE id = ?
    `).run(confirmedId, tsMs, tsMs, tsSource, tsSource, pendingRow.id);

    const updatedMsg = database.prepare('SELECT * FROM messages WHERE id = ?').get(pendingRow.id);
    const OutboundAttemptRepository = require('../repositories/OutboundAttemptRepository');
    if (updatedMsg && updatedMsg.latest_attempt_id) {
      OutboundAttemptRepository.transition(
        updatedMsg.latest_attempt_id,
        ['queued', 'dispatching', 'awaiting_confirmation'],
        'sent',
        {
          confirmed_at: new Date(tsMs || Date.now()).toISOString(),
          confirmation_message_id: confirmedId,
          confirmation_source: (tsSource === 'page_dom_observer' || tsSource === 'page_dom') ? 'page_dom' : 'personal_dom'
        },
        database
      );
      const attempt = OutboundAttemptRepository.getById(updatedMsg.latest_attempt_id, database);
      if (attempt && attempt.queue_id) {
        MessageQueueRepository.updateStatus(attempt.queue_id, 'sent', null, database);
      }
    }
    updateQueueStatusFromClientMessage(pendingRow.client_message_id, 'sent', null, database);

    if (ioServer) {
      const targetThreadId = pendingRow.thread_id || rawMessage?.thread_id;
      ioServer.emit('MESSAGE_SENT', { thread_id: targetThreadId, client_message_id: pendingRow.client_message_id, fb_message_id: confirmedId, status: 'sent' });
      ioServer.emit('MESSAGE_SEND_STATUS', {
        thread_id: targetThreadId,
        client_message_id: pendingRow.client_message_id,
        message_id: pendingRow.id,
        status: 'sent',
        fb_message_id: confirmedId
      });
      ioServer.emit('NEW_MESSAGE', {
        ...rawMessage,
        ...updatedMsg,
        client_message_id: pendingRow.client_message_id,
        fb_message_id: confirmedId,
        delivery_status: 'sent',
        status: 'sent',
        is_outgoing: true,
        timestamp_ms: tsMs || updatedMsg?.timestamp_ms,
        timestamp_source: tsSource || updatedMsg?.timestamp_source,
        created_at: rawMessage?.created_at || updatedMsg?.created_at || new Date().toISOString()
      });
    }
    console.log(`[WS] Đã ghép DOM confirmation vào pending outbound ${pendingRow.client_message_id}`);
    return true;
  }
}

module.exports = OutboundDomCorrelationService;
