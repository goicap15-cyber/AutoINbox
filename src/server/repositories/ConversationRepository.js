const crypto = require('crypto');
const { isInvalidContactName, cleanContactName } = require('../utils/textFilter');
const { isBlacklistedThreadId } = require('../utils/threadGuard');
let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

// Feature 019: page_dom_observer's geometry-based direction detection
// recomputes a fresh horizontal midpoint every scan tick, which can read
// noisy/wrong right after a page reload before layout has settled (e.g.
// right after `npm start`, mid backlog rescan). Committing a flip on a
// single disagreeing reading let one bad tick silently corrupt an
// already-correct is_outgoing. This map requires the SAME disagreeing
// value to be seen twice (not necessarily consecutive ticks, but with no
// agreeing reading in between) before it's actually written - see
// shouldCommitDirectionFlip below. In-memory and reset on server restart
// by design: a restart is exactly when the first noisy reading tends to
// happen, so it should never carry a "one disagreement already logged"
// state across restarts.
let directionFlipCandidates = new Map(); // fb_message_id -> proposed isOutgoing (0/1)
const scanIdCache = new Map(); // scan_id -> timestamp
const threadGenerations = new Map(); // thread_id -> { session_epoch, generation }
const SCAN_ID_TTL_MS = 10 * 60 * 1000; // 10 minutes TTL

function cleanExpiredScanIds() {
  const now = Date.now();
  for (const [id, ts] of scanIdCache.entries()) {
    if (now - ts > SCAN_ID_TTL_MS) {
      scanIdCache.delete(id);
    }
  }
}

function shouldCommitDirectionFlip(stableMessageId, existingIsOutgoing, proposedIsOutgoing) {
  if (Number(!!existingIsOutgoing) === Number(!!proposedIsOutgoing)) {
    directionFlipCandidates.delete(stableMessageId); // agrees with stored value - any pending disagreement was noise
    return false;
  }
  const proposed = proposedIsOutgoing ? 1 : 0;
  if (directionFlipCandidates.get(stableMessageId) === proposed) {
    directionFlipCandidates.delete(stableMessageId); // confirmed by a second matching disagreement - commit
    return true;
  }
  directionFlipCandidates.set(stableMessageId, proposed); // first disagreement (or a different one) - wait for confirmation
  return false;
}

class ConversationRepository {
  static upsertThread(threadData, database = getDefaultDb()) {
    const { id, account_id, thread_url, contact_name, last_message, is_unread, source_id, inbox_folder } = threadData;
    const external_thread_id = String(threadData.external_thread_id || threadData.thread_id || id);
    const preferredId = String(id || external_thread_id);
    if (isBlacklistedThreadId(preferredId) || isBlacklistedThreadId(external_thread_id)) {
      return null;
    }
    const cleanIncomingName = isInvalidContactName(contact_name) ? null : cleanContactName(contact_name);
    const normalizedInboxFolder = ['INBOX', 'MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(String(inbox_folder || '').trim())
      ? String(inbox_folder).trim()
      : null;

    let existing = null;
    if (source_id && external_thread_id) {
      existing = database.prepare(`
        SELECT id, contact_name FROM threads
        WHERE source_id = ? AND COALESCE(external_thread_id, id) = ?
      `).get(source_id, external_thread_id);
    }
    if (!existing && account_id && external_thread_id) {
      existing = database.prepare(`
        SELECT id, contact_name FROM threads
        WHERE account_id = ? AND COALESCE(external_thread_id, id) = ?
      `).get(account_id, external_thread_id);
    }
    if (!existing) {
      existing = database.prepare('SELECT id, contact_name FROM threads WHERE id = ?').get(preferredId);
    }

    if (existing) {
      const existingIsInvalid = isInvalidContactName(existing.contact_name);
      let targetName = existing.contact_name;
      if (cleanIncomingName && cleanIncomingName !== 'Khách hàng') {
        targetName = cleanIncomingName;
      } else if (existingIsInvalid || !existing.contact_name) {
        targetName = cleanIncomingName || 'Khách hàng';
      }

      database.prepare(`
        UPDATE threads
        SET external_thread_id = COALESCE(external_thread_id, ?),
            source_id = COALESCE(?, source_id),
            contact_name = ?,
            thread_url = COALESCE(?, thread_url),
            last_message = COALESCE(?, last_message),
            is_unread = COALESCE(?, is_unread),
            inbox_folder = CASE
              WHEN inbox_folder = 'INBOX' AND ? IN ('MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE') THEN inbox_folder
              ELSE COALESCE(?, inbox_folder)
            END
        WHERE id = ?
      `).run(
          external_thread_id, 
          source_id || null, 
          targetName,
          thread_url, 
          last_message, 
          is_unread === undefined ? null : (is_unread ? 1 : 0), 
          normalizedInboxFolder,
          normalizedInboxFolder,
          existing.id
      );
      return this.getThread(existing.id, database);
    }

    database.prepare(`
      INSERT INTO threads (id, external_thread_id, account_id, source_id, thread_url, contact_name, last_message, is_unread, inbox_folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(preferredId, external_thread_id, account_id, source_id || null, thread_url, cleanIncomingName || 'Khách hàng', last_message, is_unread === undefined ? 1 : (is_unread ? 1 : 0), normalizedInboxFolder || 'INBOX');
    return this.getThread(preferredId, database);
  }

  static getThread(id, database = getDefaultDb()) {
    return database.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  }

  // Resolves a thread's inbox source for send-routing decisions (feature 015).
  // Mirrors the exact threads -> inbox_sources join MessageQueueRepository.popPending()
  // already uses, so both places agree on what counts as a Page thread. Returns
  // { sourceType: null, pageId: null } for a thread with no source_id (e.g. legacy
  // personal threads) or one whose source_id doesn't resolve to a live source row.
  static getThreadSource(threadId, database = getDefaultDb()) {
    const row = database.prepare(`
      SELECT s.source_type AS sourceType, s.external_id AS pageId
      FROM threads t
      LEFT JOIN inbox_sources s ON s.id = t.source_id
      WHERE t.id = ?
    `).get(threadId);
    if (!row || !row.sourceType) return { sourceType: null, pageId: null };
    return row;
  }

  static touchThread(threadId, lastMessage, database = getDefaultDb()) {
    database.prepare('UPDATE threads SET last_message = COALESCE(?, last_message), last_activity = CURRENT_TIMESTAMP WHERE id = ?').run(lastMessage, threadId);
  }

  // History crawling must not make an old conversation look newly active.
  // Advance the sidebar only when the observed Facebook timestamp is newer
  // than the timestamp already stored for the thread.
  static touchThreadFromHistory(threadId, lastMessage, observedTimestampMs, database = getDefaultDb()) {
    const timestampMs = Number(observedTimestampMs || 0);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return false;
    const thread = database.prepare('SELECT last_activity FROM threads WHERE id = ?').get(threadId);
    if (!thread) return false;
    const currentTimestampMs = Date.parse(thread.last_activity || '') || 0;
    if (currentTimestampMs >= timestampMs) return false;
    database.prepare('UPDATE threads SET last_message = COALESCE(?, last_message), last_activity = ? WHERE id = ?')
      .run(lastMessage, new Date(timestampMs).toISOString(), threadId);
    return true;
  }

  // Writes a resolved avatar to the contacts row only when no real avatar is
  // stored yet, so re-scanning an already-captured thread (or one whose
  // messages predate avatar extraction) can still backfill it once, without
  // clobbering a good value on every later scan tick.
  static setContactAvatarIfMissing(threadId, contactName, avatarUrl, database = getDefaultDb()) {
    if (!avatarUrl) return { updated: false };
    const existing = database.prepare('SELECT avatar_url FROM contacts WHERE thread_id = ?').get(threadId);
    if (existing && existing.avatar_url) return { updated: false };
    database.prepare(`
      INSERT INTO contacts (thread_id, name, avatar_url)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        avatar_url = COALESCE(contacts.avatar_url, excluded.avatar_url)
    `).run(threadId, contactName || 'Khách hàng', avatarUrl);
    return { updated: true };
  }

  // Lightweight projection used to seed a fresh content-script's client-side
  // timestamp-anchor map (see page_content.js) after a restart, without
  // sending full message content/media over that sync-hint channel. Excludes
  // synthetic fingerprint() ids ('history_...') - they never match a real
  // DOM data-message-id, so they'd never be usable as anchors anyway.
  static getMessageTimestamps(threadId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT fb_message_id, timestamp_ms FROM messages
      WHERE thread_id = ? AND fb_message_id IS NOT NULL AND fb_message_id NOT LIKE 'history_%'
      ORDER BY timestamp_ms ASC, created_at ASC, id ASC
    `).all(threadId);
  }

  static getMessages(threadId, limit = 50, offset = 0, database = getDefaultDb()) {
    return database.prepare(`
      SELECT * FROM messages
      WHERE thread_id = ?
      ORDER BY COALESCE(sequence_order, id) DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(threadId, limit, offset).reverse();
  }

  static saveMessagesTransaction(threadId, messages = [], database = getDefaultDb()) {
    if (isBlacklistedThreadId(threadId)) return { insertedIds: [], updatedIds: [], skippedCount: 0 };
    const insertMsg = database.prepare(`
      INSERT INTO messages (thread_id, fb_message_id, sender_id, content, media_type, media_url, timestamp_ms, timestamp_source, is_outgoing, sender_role, sequence_order, direction_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fb_message_id) DO UPDATE SET
        content = CASE WHEN excluded.content IS NOT NULL AND excluded.content <> '' THEN excluded.content ELSE messages.content END,
        media_type = CASE WHEN excluded.media_type IS NOT NULL AND excluded.media_type <> 'text' THEN excluded.media_type ELSE messages.media_type END,
        media_url = COALESCE(excluded.media_url, messages.media_url),
        timestamp_ms = excluded.timestamp_ms,
        timestamp_source = excluded.timestamp_source,
        created_at = excluded.created_at,
        is_outgoing = CASE WHEN excluded.direction_status = 'confirmed' THEN excluded.is_outgoing ELSE messages.is_outgoing END,
        sender_role = CASE WHEN excluded.direction_status = 'confirmed' THEN excluded.sender_role ELSE messages.sender_role END,
        sequence_order = CASE WHEN excluded.sequence_order IS NOT NULL THEN excluded.sequence_order ELSE messages.sequence_order END,
        direction_status = CASE WHEN excluded.direction_status = 'confirmed' THEN 'confirmed' ELSE messages.direction_status END
    `);
    const rank = { facebook_payload: 6, facebook_timestamp: 6, facebook_label: 5, dom_clock_order: 5, dom_order: 5, facebook_dom: 4, realtime_fallback: 3, sync: 3, fallback: 2, unknown: 1 };
    const transaction = database.transaction((msgs) => {
      const result = { insertedIds: [], updatedIds: [], skippedCount: 0 };
      for (const msg of msgs) {
        const isOutgoing = msg.is_outgoing === true || msg.is_outgoing === 1 ? 1 : 0;
        const directionStatus = msg.direction_status === 'pending' || msg.directionStatus === 'pending'
          ? 'pending'
          : 'confirmed';
        const senderId = msg.sender_id || msg.sender || (isOutgoing ? String(msg.account_id || 'SYSTEM') : 'CONTACT');
        const senderRole = isOutgoing ? 'operator' : 'customer';
        const observedSequence = Number.isFinite(Number(msg.sequence_order ?? msg.dom_order))
          ? Number(msg.sequence_order ?? msg.dom_order)
          : null;
        let stableId = msg.fb_message_id || msg.messageId || msg.client_message_id || ConversationRepository.fingerprint(threadId, msg);
        const observedTimestampMs = Number(msg.timestamp_ms || msg.timestamp || 0);
        const observedTimestampSource = msg.timestamp_source || 'sync';
        const content = msg.content ?? msg.text ?? msg.cleaned ?? null;
        const mediaType = msg.media_type || (msg.media_url ? 'image' : 'text');
        const mediaUrl = msg.media_url || null;
        const observedCreatedAt = msg.created_at || (observedTimestampMs > 0 ? new Date(observedTimestampMs).toISOString() : new Date().toISOString());
        let existing = database.prepare('SELECT content, media_type, media_url, timestamp_ms, timestamp_source, created_at, is_outgoing, sender_role, sequence_order, direction_status FROM messages WHERE fb_message_id = ?').get(stableId);
        // Facebook sometimes omits data-message-id during a partial/reloaded DOM
        // render. The extension then generates an occurrence-based dom_* id,
        // whose suffix can change when fewer older rows are mounted. Reuse one
        // unambiguous historical row with the same payload and nearby timestamp
        // instead of inserting that old message again under the changed id.
        if (!existing && /^dom_.+_hash_.+_\d+$/.test(String(stableId)) && observedTimestampMs > 0) {
          const candidates = database.prepare(`
            SELECT fb_message_id, content, media_type, media_url, timestamp_ms, timestamp_source, created_at,
                   is_outgoing, sender_role, sequence_order, direction_status
            FROM messages
            WHERE thread_id = ? AND content = ? AND is_outgoing = ?
              AND timestamp_ms > 0 AND ABS(timestamp_ms - ?) <= 90000
            ORDER BY ABS(timestamp_ms - ?) ASC
            LIMIT 2
          `).all(threadId, content, isOutgoing, observedTimestampMs, observedTimestampMs);
          if (candidates.length === 1) {
            stableId = candidates[0].fb_message_id;
            existing = candidates[0];
          }
        }
        let timestampMs = observedTimestampMs;
        let timestampSource = observedTimestampSource;
        let createdAt = observedCreatedAt;
        if (existing) {
          const oldRank = rank[existing.timestamp_source] || 1;
          const newRank = rank[observedTimestampSource] || 1;
          // History sync adds a deterministic millisecond DOM offset to
          // Facebook's minute-only label.  Older rows may already have the
          // same `facebook_label` provenance but not that offset, so requiring
          // a strictly better source would leave their incorrect order frozen
          // forever.  Only let the canonical history pass correct an
          // equal-rank timestamp; realtime/fallback replays must not move it.
          const isCanonicalHistoryCorrection = msg.source === 'dom_history_sync'
            && observedTimestampSource === existing.timestamp_source
            && observedTimestampMs !== Number(existing.timestamp_ms || 0);
          const shouldUpgradeTimestamp = observedTimestampMs > 0
            && (newRank > oldRank || isCanonicalHistoryCorrection);
          if (!shouldUpgradeTimestamp) {
            timestampMs = existing.timestamp_ms || 0;
            timestampSource = existing.timestamp_source || 'unknown';
            createdAt = existing.created_at;
          }
          const directionChanged = directionStatus === 'confirmed'
            && (existing.direction_status !== 'confirmed' || existing.is_outgoing !== isOutgoing);
          const timestampChanged = shouldUpgradeTimestamp && (
            timestampMs !== (existing.timestamp_ms || 0) || timestampSource !== existing.timestamp_source
          );
          const sequenceChanged = observedSequence !== null
            && observedSequence !== Number(existing.sequence_order);
          const roleChanged = existing.sender_role !== senderRole;
          const mediaChanged = (mediaUrl && existing.media_url !== mediaUrl) || (mediaType !== 'text' && existing.media_type !== mediaType);
          const changed = existing.content !== content || mediaChanged || timestampChanged || directionChanged || sequenceChanged || roleChanged;
          if (!changed) { result.skippedCount += 1; continue; }
          insertMsg.run(threadId, stableId, senderId, content, mediaType, mediaUrl, timestampMs, timestampSource, isOutgoing, senderRole, observedSequence, directionStatus, createdAt);
          result.updatedIds.push(stableId);
          continue;
        }
        insertMsg.run(threadId, stableId, senderId, content, mediaType, mediaUrl, timestampMs, timestampSource, isOutgoing, senderRole, observedSequence, directionStatus, createdAt);
        result.insertedIds.push(stableId);
      }
      return result;
    });
    return transaction(messages);
  }

  static normalizeMessageSequence(threadId, database = getDefaultDb()) {
    const rows = database.prepare(`
      SELECT id
      FROM messages
      WHERE thread_id = ?
      ORDER BY
        CASE WHEN COALESCE(timestamp_ms, 0) > 0 THEN 0 ELSE 1 END ASC,
        COALESCE(NULLIF(timestamp_ms, 0), CAST(strftime('%s', created_at) AS INTEGER) * 1000, id) ASC,
        COALESCE(sequence_order, id) ASC,
        id ASC
    `).all(threadId);
    const update = database.prepare('UPDATE messages SET sequence_order = ? WHERE id = ?');
    const normalize = database.transaction((orderedRows) => {
      orderedRows.forEach((row, index) => update.run(index + 1, row.id));
    });
    normalize(rows);
    return rows.length;
  }
  // Test-only: clears direction-flip hysteresis state between test cases so
  // one test's pending candidate can't leak into another's assertions.
  static _resetDirectionFlipTracking() {
    directionFlipCandidates = new Map();
  }

  // Reconciles an already-existing message row with a freshly re-scanned
  // observation of it: upgrades the timestamp when the new source outranks the
  // stored one, and (for page_dom_observer specifically, whose geometry-based
  // direction detection is the most reliable signal for that source) corrects
  // is_outgoing when it disagrees with what's stored - but only once that
  // disagreement is confirmed twice (see shouldCommitDirectionFlip). Never
  // inserts a second row and never throws on repeated identical re-scans.
  static reconcileExistingMessage(stableMessageId, { source, isOutgoing, directionStatus, direction_status, directionConfidence, direction_confidence, tsMs, tsSource, createdAt, content = null } = {}, database = getDefaultDb()) {
    const existingMsg = database.prepare('SELECT timestamp_source, is_outgoing, direction_status FROM messages WHERE fb_message_id = ?').get(stableMessageId);
    if (!existingMsg) return { updated: false, reason: 'not_found' };

    const ranks = {
      facebook_payload: 6,
      facebook_label: 5,
      dom_order: 5,
      facebook_dom: 4,
      realtime_fallback: 3,
      fallback: 2,
      unknown: 1
    };
    const oldRank = ranks[existingMsg.timestamp_source] || 1;
    const newRank = ranks[tsSource] || 1;
    const shouldUpdateTimestamp = newRank > oldRank;
    const explicitStatus = directionStatus || direction_status;
    const explicitConfidence = directionConfidence || direction_confidence;
    const isDirectionKnown = isOutgoing === true || isOutgoing === false || isOutgoing === 1 || isOutgoing === 0;
    const isPendingObservation = explicitStatus === 'pending'
      || !isDirectionKnown
      || explicitConfidence === 'unknown';
    const normalizedOutgoing = isOutgoing === true || isOutgoing === 1 ? 1 : 0;

    // Unknown geometry must never complete or alter a direction decision. It
    // also clears any prior flip candidate so two separated noisy readings
    // cannot combine around an unknown observation.
    if (isPendingObservation) {
      directionFlipCandidates.delete(stableMessageId);
      if (!shouldUpdateTimestamp) return { updated: false, reason: 'no_change' };
      database.prepare(`
        UPDATE messages
        SET timestamp_ms = ?, timestamp_source = ?, created_at = ?
        WHERE fb_message_id = ?
      `).run(tsMs, tsSource, createdAt, stableMessageId);
      return {
        updated: true,
        timestampUpdated: true,
        directionUpdated: false,
        previousTimestampSource: existingMsg.timestamp_source,
        previousIsOutgoing: existingMsg.is_outgoing,
        previousDirectionStatus: existingMsg.direction_status
      };
    }

    const isPageObservation = source === 'page_dom_observer';
    const existingIsPending = existingMsg.direction_status === 'pending';
    const shouldPromotePending = isPageObservation && existingIsPending;
    const shouldUpdateDirection = isPageObservation && (
      shouldPromotePending
      || shouldCommitDirectionFlip(stableMessageId, existingMsg.is_outgoing, normalizedOutgoing)
    );

    if (!shouldUpdateTimestamp && !shouldUpdateDirection) {
      return { updated: false, reason: 'no_change' };
    }

    database.prepare(`
      UPDATE messages
      SET timestamp_ms = CASE WHEN ? = 1 THEN ? ELSE timestamp_ms END,
          timestamp_source = CASE WHEN ? = 1 THEN ? ELSE timestamp_source END,
          created_at = CASE WHEN ? = 1 THEN ? ELSE created_at END,
          is_outgoing = CASE WHEN ? = 1 THEN ? ELSE is_outgoing END,
          direction_status = CASE WHEN ? = 1 THEN 'confirmed' ELSE direction_status END,
          content = CASE WHEN (content IS NULL OR content = '') AND (? IS NOT NULL AND ? != '') THEN ? ELSE content END
      WHERE fb_message_id = ?
    `).run(
      shouldUpdateTimestamp ? 1 : 0, tsMs,
      shouldUpdateTimestamp ? 1 : 0, tsSource,
      shouldUpdateTimestamp ? 1 : 0, createdAt,
      shouldUpdateDirection ? 1 : 0, normalizedOutgoing,
      shouldUpdateDirection ? 1 : 0,
      content, content, content,
      stableMessageId
    );

    return {
      updated: true,
      timestampUpdated: shouldUpdateTimestamp,
      directionUpdated: shouldUpdateDirection,
      previousTimestampSource: existingMsg.timestamp_source,
      previousIsOutgoing: existingMsg.is_outgoing,
      previousDirectionStatus: existingMsg.direction_status
    };
  }

  static getTimestampRank(source) {
    if (!source) return 1;
    const s = String(source).trim().toLowerCase();
    if (s === 'facebook_payload' || s === 'facebook_timestamp') return 6;
    if (s === 'facebook_label' || s === 'facebook_dom') return 5;
    if (s === 'separator_date_clock' || s === 'dom_clock_order') return 4;
    if (s === 'realtime_delta' || s === 'client_submit' || s === 'composer_confirmation' || s === 'realtime_fallback' || s === 'sync') return 3;
    if (s === 'dom_order') return 2;
    return 1;
  }

  static shouldUpgradeTimestamp(oldSource, newSource, oldTs = 0, newTs = 0) {
    const oldRank = ConversationRepository.getTimestampRank(oldSource);
    const newRank = ConversationRepository.getTimestampRank(newSource);
    if (newRank > oldRank) return true;
    if (newRank < oldRank) return false;
    // When ranks are identical (e.g. separator_date_clock or realtime_fallback):
    // allow upgrade if the new timestamp is valid (>0) and significantly different (>= 30s or across days)
    if (newTs > 0 && oldTs > 0 && Math.abs(Number(newTs) - Number(oldTs)) >= 30000) {
      return true;
    }
    return false;
  }

  static upgradeMessageTimestamp(threadId, fbMessageId, timestampMs, timestampSource, database = getDefaultDb()) {
    if (!threadId || !fbMessageId || !timestampMs || timestampMs <= 0) return null;
    const existing = database.prepare('SELECT id, timestamp_ms, timestamp_source FROM messages WHERE fb_message_id = ?').get(fbMessageId);
    if (!existing) return null;
    if (!ConversationRepository.shouldUpgradeTimestamp(existing.timestamp_source, timestampSource, existing.timestamp_ms, timestampMs)) {
      return null;
    }
    database.prepare(`
      UPDATE messages 
      SET timestamp_ms = ?, timestamp_source = ?
      WHERE fb_message_id = ?
    `).run(timestampMs, timestampSource, fbMessageId);
    ConversationRepository.normalizeMessageSequence(threadId, database);
    return database.prepare('SELECT * FROM messages WHERE fb_message_id = ?').get(fbMessageId);
  }

  static reconcileBatchWithAnchors(existingRows = [], incomingBatch = [], options = {}) {
    const mode = options.mode || 'page_initial';
    const boundaryEvidence = options.boundary_evidence || null;

    const existingMap = new Map();
    for (const row of existingRows) {
      if (row.fb_message_id) {
        existingMap.set(row.fb_message_id, row);
      }
    }

    if (!existingRows.length) {
      const mergedList = incomingBatch.map((msg, index) => ({
        ...msg,
        sequence_order: index + 1
      }));
      return { status: 'committed', mergedList };
    }

    const existingIndexMap = new Map();
    existingRows.forEach((r, idx) => {
      if (r.fb_message_id) existingIndexMap.set(r.fb_message_id, idx);
    });

    let firstIncomingMatch = -1;
    let firstExistingMatch = -1;
    let lastIncomingMatch = -1;
    let lastExistingMatch = -1;

    for (let i = 0; i < incomingBatch.length; i++) {
      const id = incomingBatch[i].fb_message_id;
      if (id && existingIndexMap.has(id)) {
        if (firstIncomingMatch === -1) {
          firstIncomingMatch = i;
          firstExistingMatch = existingIndexMap.get(id);
        }
        lastIncomingMatch = i;
        lastExistingMatch = existingIndexMap.get(id);
      }
    }

    if (firstIncomingMatch !== -1) {
      // Overlap exists between incoming batch and existing database rows!
      const olderIncoming = incomingBatch.slice(0, firstIncomingMatch);
      const newerIncoming = incomingBatch.slice(lastIncomingMatch + 1);

      const mergedList = [];
      const seenIds = new Set();

      const pushMsg = (m) => {
        if (!m || !m.fb_message_id || seenIds.has(m.fb_message_id)) return;
        seenIds.add(m.fb_message_id);
        mergedList.push(m);
      };

      // Existing rows that are strictly older than the first existing match
      for (let i = 0; i < firstExistingMatch; i++) {
        pushMsg(existingRows[i]);
      }

      // Older incoming items that appeared before the first anchor
      for (const m of olderIncoming) {
        pushMsg(m);
      }

      // Items in the overlapping window (merge incoming updates into existing)
      const incomingOverlapMap = new Map();
      for (let i = firstIncomingMatch; i <= lastIncomingMatch; i++) {
        if (incomingBatch[i].fb_message_id) {
          incomingOverlapMap.set(incomingBatch[i].fb_message_id, incomingBatch[i]);
        }
      }

      for (let i = firstExistingMatch; i <= lastExistingMatch; i++) {
        const ex = existingRows[i];
        const inc = incomingOverlapMap.get(ex.fb_message_id);
        pushMsg(inc ? { ...ex, ...inc } : ex);
      }

      // Also include any incoming items in the overlap span that were not in existing
      for (let i = firstIncomingMatch; i <= lastIncomingMatch; i++) {
        pushMsg(incomingBatch[i]);
      }

      // Newer incoming items that appeared after the last anchor
      for (const m of newerIncoming) {
        pushMsg(m);
      }

      // Any remaining existing rows after the last match
      for (let i = lastExistingMatch + 1; i < existingRows.length; i++) {
        pushMsg(existingRows[i]);
      }

      mergedList.forEach((msg, idx) => {
        msg.sequence_order = idx + 1;
      });

      return { status: 'committed', mergedList };
    }

    if (mode === 'page_scroll_older') {
      if (!boundaryEvidence || !boundaryEvidence.previous_oldest_message_id) {
        return { status: 'retry_required', reason: 'missing_anchor_and_invalid_boundary' };
      }

      const prevOldestId = boundaryEvidence.previous_oldest_message_id;
      const isKnownOldest = existingRows.length > 0 && existingRows[0].fb_message_id === prevOldestId;
      if (!isKnownOldest && !existingMap.has(prevOldestId)) {
        return { status: 'retry_required', reason: 'missing_anchor_and_invalid_boundary' };
      }

      const mergedList = [...incomingBatch, ...existingRows];
      mergedList.forEach((msg, idx) => {
        msg.sequence_order = idx + 1;
      });

      return { status: 'committed', mergedList };
    }

    const mergedMap = new Map();
    for (const row of existingRows) {
      mergedMap.set(row.fb_message_id, { ...row });
    }
    for (const msg of incomingBatch) {
      if (mergedMap.has(msg.fb_message_id)) {
        const prev = mergedMap.get(msg.fb_message_id);
        mergedMap.set(msg.fb_message_id, { ...prev, ...msg });
      } else {
        mergedMap.set(msg.fb_message_id, { ...msg });
      }
    }

    const mergedList = Array.from(mergedMap.values());
    mergedList.forEach((msg, idx) => {
      msg.sequence_order = idx + 1;
    });

    return { status: 'committed', mergedList };
  }

  static processPageBatchEnvelope(envelope, database = getDefaultDb()) {
    cleanExpiredScanIds();
    const { thread_id, session_epoch, generation, scan_id, mode, messages = [] } = envelope;

    if (isBlacklistedThreadId(thread_id)) {
      return {
        status: 'rejected',
        reason: 'blacklisted_thread_id',
        thread_id,
        session_epoch,
        generation,
        scan_id
      };
    }

    const currentGen = threadGenerations.get(thread_id);
    if (currentGen && currentGen.session_epoch === session_epoch && generation < currentGen.generation) {
      return {
        status: 'rejected',
        reason: 'stale_generation',
        thread_id,
        session_epoch,
        generation,
        scan_id
      };
    }

    if (scanIdCache.has(scan_id)) {
      return {
        status: 'duplicate',
        thread_id,
        session_epoch,
        generation,
        scan_id
      };
    }

    threadGenerations.set(thread_id, { session_epoch, generation });

    const existingRows = database.prepare(`
      SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_order ASC, id ASC
    `).all(thread_id);

    const reconcileRes = ConversationRepository.reconcileBatchWithAnchors(existingRows, messages, envelope);
    if (reconcileRes.status !== 'committed') {
      return {
        status: reconcileRes.status,
        reason: reconcileRes.reason,
        thread_id,
        session_epoch,
        generation,
        scan_id
      };
    }

    const insertOrUpdate = database.prepare(`
      INSERT INTO messages (
        thread_id, fb_message_id, client_message_id, sender_id, content,
        media_type, media_url, timestamp_ms, timestamp_source, is_outgoing,
        sender_role, sequence_order, direction_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fb_message_id) DO UPDATE SET
        content = CASE WHEN excluded.content IS NOT NULL AND excluded.content <> '' THEN excluded.content ELSE messages.content END,
        media_type = CASE WHEN excluded.media_type IS NOT NULL AND excluded.media_type <> 'text' THEN excluded.media_type ELSE messages.media_type END,
        media_url = COALESCE(excluded.media_url, messages.media_url),
        timestamp_ms = CASE WHEN ? = 1 THEN excluded.timestamp_ms ELSE messages.timestamp_ms END,
        timestamp_source = CASE WHEN ? = 1 THEN excluded.timestamp_source ELSE messages.timestamp_source END,
        is_outgoing = CASE WHEN excluded.direction_status = 'confirmed' THEN excluded.is_outgoing ELSE messages.is_outgoing END,
        sender_role = CASE WHEN excluded.direction_status = 'confirmed' THEN excluded.sender_role ELSE messages.sender_role END,
        sequence_order = excluded.sequence_order,
        direction_status = CASE WHEN excluded.direction_status = 'confirmed' THEN 'confirmed' ELSE messages.direction_status END
    `);

    const updateTx = database.transaction((mergedList) => {
      for (const msg of mergedList) {
        const isOutgoing = msg.is_outgoing === true || msg.is_outgoing === 1 ? 1 : 0;
        const directionStatus = (msg.is_outgoing === null || msg.direction_status === 'pending') ? 'pending' : 'confirmed';
        const senderRole = isOutgoing ? 'operator' : 'customer';
        const senderId = msg.sender_id || (isOutgoing ? (msg.account_id || 'SYSTEM') : 'CONTACT');
        const tsMs = Number(msg.timestamp_ms || 0);
        const tsSource = msg.timestamp_source || 'unknown';
        const createdAt = msg.created_at || (tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString());

        const existing = database.prepare('SELECT timestamp_source, timestamp_ms FROM messages WHERE fb_message_id = ?').get(msg.fb_message_id);
        const canUpgrade = !existing || ConversationRepository.shouldUpgradeTimestamp(existing.timestamp_source, tsSource, existing.timestamp_ms, tsMs);

        insertOrUpdate.run(
          thread_id,
          msg.fb_message_id,
          msg.client_message_id || null,
          senderId,
          msg.content || null,
          msg.media_type || 'text',
          msg.media_url || null,
          tsMs,
          tsSource,
          isOutgoing,
          senderRole,
          msg.sequence_order,
          directionStatus,
          createdAt,
          canUpgrade ? 1 : 0,
          canUpgrade ? 1 : 0
        );
      }
    });

    updateTx(reconcileRes.mergedList);
    ConversationRepository.normalizeMessageSequence(thread_id, database);
    scanIdCache.set(scan_id, Date.now());

    return {
      status: 'committed',
      thread_id,
      session_epoch,
      generation,
      scan_id,
      persisted_count: messages.length
    };
  }

  static fingerprint(threadId, message) {
    return 'history_' + crypto.createHash('sha256').update(JSON.stringify([
      threadId,
      message.sender_id || message.sender || '',
      message.content || message.text || message.cleaned || '',
      message.timestamp_ms || message.timestamp || 0,
      message.media_url || '',
      message.created_at || ''
    ])).digest('hex').slice(0, 32);
  }
}

module.exports = ConversationRepository;
