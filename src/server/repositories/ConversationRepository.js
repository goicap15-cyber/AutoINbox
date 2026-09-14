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
  static bubbleFamilyId(messageId) {
    return String(messageId || '').replace(/__bubble_\d+$/, '');
  }

  // Facebook may group several real, consecutive bubbles under one native
  // message wrapper. The suffix is an occurrence identity, not a duplicate
  // marker: mid.x, mid.x__bubble_1, ... must remain distinct even when their
  // text or media payload is identical.
  static bubbleOccurrenceId(messageId) {
    const value = String(messageId || '');
    const match = value.match(/__bubble_(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  static findEquivalentBubbleMessage({ threadId, fbMessageId, content, isOutgoing, timestampMs }, database = getDefaultDb()) {
    const messageId = String(fbMessageId || '');
    if (!messageId) return null;
    const familyId = this.bubbleFamilyId(messageId);
    const rows = database.prepare(`
      SELECT id, fb_message_id, client_message_id, timestamp_ms
      FROM messages
      WHERE thread_id = ? AND COALESCE(content, '') = COALESCE(?, '') AND is_outgoing = ?
        AND (? <= 0 OR COALESCE(timestamp_ms, 0) <= 0 OR ABS(timestamp_ms - ?) <= 2000)
      ORDER BY id DESC LIMIT 30
    `).all(threadId, content ?? '', isOutgoing ? 1 : 0, Number(timestampMs) || 0, Number(timestampMs) || 0);
    const occurrenceId = this.bubbleOccurrenceId(messageId);
    return rows.find((row) => this.bubbleFamilyId(row.fb_message_id) === familyId
      && this.bubbleOccurrenceId(row.fb_message_id) === occurrenceId) || null;
  }

  static findEquivalentCrossSourceMessage({ threadId, fbMessageId, content, mediaUrl, isOutgoing, timestampMs }, database = getDefaultDb()) {
    const incomingId = String(fbMessageId || '');
    if (!threadId || !incomingId) return null;
    const isSynthetic = (value) => /^(?:dom_|sidebar_preview_)/.test(String(value || ''));
    const observedTimestamp = Number(timestampMs) || 0;
    const rows = database.prepare(`
      SELECT id, fb_message_id, client_message_id, timestamp_ms
      FROM messages
      WHERE thread_id = ? AND is_outgoing = ?
        AND (
          (? IS NOT NULL AND ? <> '' AND media_url = ?)
          OR ((? IS NULL OR ? = '') AND COALESCE(content, '') = COALESCE(?, ''))
        )
        AND (? <= 0 OR COALESCE(timestamp_ms, 0) <= 0 OR ABS(timestamp_ms - ?) <= 90000)
      ORDER BY id DESC LIMIT 10
    `).all(threadId, isOutgoing ? 1 : 0,
      mediaUrl || null, mediaUrl || null, mediaUrl || null,
      mediaUrl || null, mediaUrl || null, content ?? '',
      observedTimestamp, observedTimestamp);
    return rows.find((row) => isSynthetic(incomingId) !== isSynthetic(row.fb_message_id)) || null;
  }

  static dedupeBubbleFamilyMessages(messages = []) {
    const result = [];
    const indexes = new Map();
    for (const message of messages) {
      const key = [
        this.bubbleFamilyId(message.fb_message_id),
        this.bubbleOccurrenceId(message.fb_message_id),
        message.is_outgoing ? 1 : 0,
        String(message.content || ''),
        String(message.media_type || 'text')
      ].join('\u0000');
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, result.length);
        result.push(message);
        continue;
      }
      const existing = result[existingIndex];
      const existingIsBase = this.bubbleFamilyId(existing.fb_message_id) === String(existing.fb_message_id || '');
      const currentIsBase = this.bubbleFamilyId(message.fb_message_id) === String(message.fb_message_id || '');
      if ((!existing.client_message_id && message.client_message_id) || (!existingIsBase && currentIsBase)) {
        result[existingIndex] = message;
      }
    }
    return result;
  }

  static promoteSidebarPreview({ threadId, fbMessageId, content, isOutgoing, timestampMs }, database = getDefaultDb()) {
    if (!threadId || !fbMessageId || isOutgoing || !content || String(fbMessageId).startsWith('sidebar_preview_')) return null;
    const observedTimestamp = Number(timestampMs) || 0;
    const candidates = database.prepare(`
      SELECT id, fb_message_id FROM messages
      WHERE thread_id = ? AND fb_message_id LIKE 'sidebar_preview_%'
        AND is_outgoing = 0 AND COALESCE(content, '') = COALESCE(?, '')
        AND (? <= 0 OR COALESCE(timestamp_ms, 0) <= 0 OR ABS(timestamp_ms - ?) <= 120000)
      ORDER BY id DESC LIMIT 2
    `).all(threadId, content, observedTimestamp, observedTimestamp);
    if (candidates.length !== 1) return null;
    try {
      database.prepare('UPDATE messages SET fb_message_id = ? WHERE id = ?').run(String(fbMessageId), candidates[0].id);
      return { id: candidates[0].id, previousFbMessageId: candidates[0].fb_message_id, fbMessageId: String(fbMessageId) };
    } catch (_) {
      return null;
    }
  }

  static hasNewerOutgoingAfterMatchingIncoming(threadId, content, database = getDefaultDb()) {
    if (!threadId || !content) return false;
    return Boolean(database.prepare(`
      SELECT 1
      FROM messages incoming
      WHERE incoming.thread_id = ? AND incoming.is_outgoing = 0
        AND incoming.fb_message_id NOT LIKE 'sidebar_preview_%'
        AND COALESCE(incoming.content, '') = COALESCE(?, '')
        AND EXISTS (
          SELECT 1 FROM messages outgoing
          WHERE outgoing.thread_id = incoming.thread_id AND outgoing.is_outgoing = 1
            AND (
              COALESCE(outgoing.timestamp_ms, 0) > COALESCE(incoming.timestamp_ms, 0)
              OR (COALESCE(outgoing.timestamp_ms, 0) = COALESCE(incoming.timestamp_ms, 0) AND outgoing.id > incoming.id)
            )
        )
      ORDER BY incoming.id DESC LIMIT 1
    `).get(threadId, content));
  }

  static upsertThread(threadData, database = getDefaultDb()) {
    const { id, account_id, thread_url, contact_name, last_message, is_unread, source_id, inbox_folder } = threadData;
    const external_thread_id = String(threadData.external_thread_id || threadData.thread_id || id);
    let preferredId = String(id || external_thread_id);
    if (isBlacklistedThreadId(preferredId) || isBlacklistedThreadId(external_thread_id)) {
      return null;
    }
    const cleanIncomingName = isInvalidContactName(contact_name) ? null : cleanContactName(contact_name);
    const normalizedInboxFolder = ['INBOX', 'MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(String(inbox_folder || '').trim())
      ? String(inbox_folder).trim()
      : null;
    const inboxFolderVerified = threadData.inbox_folder_verified === true ? 1 : 0;

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
      const idCollision = database.prepare('SELECT id, contact_name, account_id FROM threads WHERE id = ?').get(preferredId);
      if (idCollision && account_id && String(idCollision.account_id) !== String(account_id)) {
        // Facebook participant/thread ids are global and can appear under
        // several connected accounts. Never reuse another account's CRM row.
        preferredId = preferredId.startsWith(`${account_id}:`)
          ? preferredId
          : `${account_id}:${external_thread_id}`;
        existing = database.prepare(
          'SELECT id, contact_name, account_id FROM threads WHERE id = ? AND account_id = ?'
        ).get(preferredId, account_id);
      } else {
        existing = idCollision;
      }
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
              WHEN inbox_folder = 'INBOX'
                AND ? IN ('MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE')
                AND ? = 0
              THEN inbox_folder
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
          inboxFolderVerified,
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
        -- Once a bubble is stored its visible position is immutable. A later
        -- partial DOM/history scan may have a different local index and must
        -- not move that existing text.
        sequence_order = messages.sequence_order,
        direction_status = CASE WHEN excluded.direction_status = 'confirmed' THEN 'confirmed' ELSE messages.direction_status END
    `);
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
        let promotedSidebarPreview = false;
        if (!existing && msg.fb_message_id) {
          const promoted = ConversationRepository.promoteSidebarPreview({
            threadId, fbMessageId: msg.fb_message_id, content, isOutgoing,
            timestampMs: observedTimestampMs
          }, database);
          if (promoted) {
            stableId = promoted.fbMessageId;
            promotedSidebarPreview = true;
            existing = database.prepare('SELECT content, media_type, media_url, timestamp_ms, timestamp_source, created_at, is_outgoing, sender_role, sequence_order, direction_status FROM messages WHERE fb_message_id = ?').get(stableId);
          }
        }
        if (!existing && msg.fb_message_id) {
          const crossSource = ConversationRepository.findEquivalentCrossSourceMessage({
            threadId, fbMessageId: msg.fb_message_id, content, mediaUrl,
            isOutgoing, timestampMs: observedTimestampMs
          }, database);
          if (crossSource) {
            stableId = crossSource.fb_message_id;
            existing = database.prepare('SELECT content, media_type, media_url, timestamp_ms, timestamp_source, created_at, is_outgoing, sender_role, sequence_order, direction_status FROM messages WHERE fb_message_id = ?').get(stableId);
          }
        }
        if (!existing && msg.fb_message_id) {
          const equivalentBubble = ConversationRepository.findEquivalentBubbleMessage({
            threadId,
            fbMessageId: msg.fb_message_id,
            content,
            isOutgoing,
            timestampMs: observedTimestampMs
          }, database);
          if (equivalentBubble) {
            stableId = equivalentBubble.fb_message_id;
            existing = database.prepare('SELECT content, media_type, media_url, timestamp_ms, timestamp_source, created_at, is_outgoing, sender_role, sequence_order, direction_status FROM messages WHERE fb_message_id = ?').get(stableId);
          }
        }
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
          const oldRank = ConversationRepository.getTimestampRank(existing.timestamp_source);
          const newRank = ConversationRepository.getTimestampRank(observedTimestampSource);
          // History sync adds a deterministic millisecond DOM offset to
          // Facebook's minute-only label. Older rows may already have the
          // same `facebook_label` provenance but not that offset, so requiring
          // a strictly better source would leave their incorrect order frozen
          // forever. Only let the canonical history pass correct an
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
          const sequenceChanged = false;
          const roleChanged = existing.sender_role !== senderRole;
          const mediaChanged = (mediaUrl && existing.media_url !== mediaUrl) || (mediaType !== 'text' && existing.media_type !== mediaType);
          const changed = existing.content !== content || mediaChanged || timestampChanged || directionChanged || sequenceChanged || roleChanged;
          if (!changed) {
            if (promotedSidebarPreview) result.updatedIds.push(stableId);
            else result.skippedCount += 1;
            continue;
          }
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
      SELECT id, timestamp_ms, sequence_order
      FROM messages
      WHERE thread_id = ?
      ORDER BY
        CASE WHEN COALESCE(timestamp_ms, 0) > 0 THEN 0 ELSE 1 END ASC,
        -- Facebook labels are minute-precision. Millisecond suffixes are DOM
        -- offsets/optimistic send times, not chronology. Within one minute the
        -- authoritative DOM sequence must win.
        CAST(COALESCE(NULLIF(timestamp_ms, 0), CAST(strftime('%s', created_at) AS INTEGER) * 1000, id) / 60000 AS INTEGER) ASC,
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

  // Reconcile only the rows that Messenger has just exposed in one DOM
  // window. Their relative visual order is authoritative, while rows outside
  // that window keep their current slots. This repairs stale realtime/
  // optimistic ranks without moving unrelated older history around.
  static reconcileObservedDomSequence(threadId, observedMessages = [], database = getDefaultDb()) {
    const rows = database.prepare(`
      SELECT id, fb_message_id, COALESCE(sequence_order, id) AS sequence_order
      FROM messages
      WHERE thread_id = ?
      ORDER BY COALESCE(sequence_order, id) ASC, id ASC
    `).all(threadId);
    if (rows.length < 2 || !Array.isArray(observedMessages) || observedMessages.length < 2) return 0;

    const byFacebookId = new Map(rows
      .filter((row) => row.fb_message_id)
      .map((row) => [String(row.fb_message_id), row]));
    const seenRowIds = new Set();
    const observedRows = [];
    for (const message of observedMessages) {
      const observedId = String(message?.fb_message_id || '');
      if (!observedId) continue;
      let row = byFacebookId.get(observedId);
      // Media companions can be collapsed into their native parent before
      // this pass. Resolve that durable row while retaining the media's DOM
      // position in the observed sequence.
      if (!row && observedId.endsWith('_media')) {
        row = byFacebookId.get(observedId.slice(0, -'_media'.length));
      }
      if (!row || seenRowIds.has(row.id)) continue;
      seenRowIds.add(row.id);
      observedRows.push(row);
    }
    if (observedRows.length < 2) return 0;

    const observedRowIds = new Set(observedRows.map((row) => row.id));
    const slots = [];
    rows.forEach((row, index) => {
      if (observedRowIds.has(row.id)) slots.push(index);
    });
    if (slots.length !== observedRows.length) return 0;

    const alreadyOrdered = slots.every((slot, index) => rows[slot].id === observedRows[index].id);
    if (alreadyOrdered) return 0;

    const reconciled = [...rows];
    slots.forEach((slot, index) => { reconciled[slot] = observedRows[index]; });
    const update = database.prepare('UPDATE messages SET sequence_order = ? WHERE id = ?');
    const apply = database.transaction((orderedRows) => {
      orderedRows.forEach((row, index) => update.run(index + 1, row.id));
    });
    apply(reconciled);
    return observedRows.length;
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
    const existingMsg = database.prepare('SELECT timestamp_ms, timestamp_source, is_outgoing, direction_status FROM messages WHERE fb_message_id = ?').get(stableMessageId);
    if (!existingMsg) return { updated: false, reason: 'not_found' };

    const shouldUpdateTimestamp = Boolean(
      tsMs && tsMs > 0 && ConversationRepository.shouldUpgradeTimestamp(
        existingMsg.timestamp_source,
        tsSource,
        existingMsg.timestamp_ms,
        tsMs
      )
    );
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
    // When ranks are identical:
    // Never allow realtime_fallback or realtime_delta (volatile Date.now()) to drift timestamps on repeated rescans
    const s = String(newSource || '').trim().toLowerCase();
    if (s === 'realtime_fallback' || s === 'realtime_delta') return false;
    // Allow upgrade if the new timestamp is valid (>0) and significantly different (>= 30s or across days)
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

      // Items in the overlapping window: follow the incoming batch's authoritative DOM order!
      const existingOverlapMap = new Map();
      for (let i = firstExistingMatch; i <= lastExistingMatch; i++) {
        if (existingRows[i].fb_message_id) {
          existingOverlapMap.set(existingRows[i].fb_message_id, existingRows[i]);
        }
      }

      for (let i = firstIncomingMatch; i <= lastIncomingMatch; i++) {
        const inc = incomingBatch[i];
        const ex = existingOverlapMap.get(inc.fb_message_id);
        pushMsg(ex ? { ...ex, ...inc } : inc);
      }

      // Also include any existing items in the overlap span that were unmounted/not in incomingBatch (skip stale synthetic likes)
      for (let i = firstExistingMatch; i <= lastExistingMatch; i++) {
        const exRow = existingRows[i];
        if (exRow && exRow.fb_message_id && exRow.fb_message_id.startsWith('page_like_')) {
          continue;
        }
        pushMsg(exRow);
      }

      // Newer incoming items that appeared after the last anchor
      for (const m of newerIncoming) {
        pushMsg(m);
      }

      // Any remaining existing rows after the last match (filter out stale synthetic like messages)
      for (let i = lastExistingMatch + 1; i < existingRows.length; i++) {
        const exRow = existingRows[i];
        if (exRow && exRow.fb_message_id && exRow.fb_message_id.startsWith('page_like_')) {
          continue;
        }
        pushMsg(exRow);
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

    // Ensure thread exists in threads table to prevent FOREIGN KEY constraint failed
    const threadExists = database.prepare('SELECT id FROM threads WHERE id = ?').get(thread_id);
    if (!threadExists) {
      ConversationRepository.upsertThread({
        id: thread_id,
        account_id: envelope.account_id,
        contact_name: envelope.contact_name || 'Khách hàng',
        last_message: messages.length > 0 ? (messages[messages.length - 1].content || 'Chưa có tin nhắn') : 'Chưa có tin nhắn',
        is_unread: 0,
        inbox_folder: 'INBOX'
      }, database);
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
