/**
 * PageMessengerAdapter — Handles Facebook Page messaging via Meta Webhook + Send API.
 * 
 * Responsibilities:
 * - Webhook verification (GET) and event handling (POST)
 * - X-Hub-Signature-256 validation
 * - Message deduplication by message.mid
 * - Persist incoming Page messages to unified conversations
 * - Send replies via Page Send API
 * - Conversation history backfill
 */
const crypto = require('crypto');
const InboxSourceService = require('./InboxSourceService');
const ConversationRepository = require('../repositories/ConversationRepository');

let defaultDb;
function getDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

class PageMessengerAdapter {
  /**
   * Verify webhook subscription (GET endpoint).
   * @param {object} query - { 'hub.mode', 'hub.verify_token', 'hub.challenge' }
   * @returns {{ status: number, body: string }}
   */
  static verifyWebhook(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe') {
      console.warn('[PAGE_WEBHOOK_RECEIVED] Verify: invalid mode', mode);
      return { status: 403, body: 'Invalid mode' };
    }

    // Check against all registered Page sources' verify tokens
    const db = getDb();
    const sources = db.prepare("SELECT webhook_verify_token FROM inbox_sources WHERE source_type = 'page_messenger' AND status = 'ACTIVE'").all();
    const globalVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN;

    const isValid = sources.some(s => s.webhook_verify_token === token) || (globalVerifyToken && token === globalVerifyToken);

    if (isValid) {
      console.log('[PAGE_WEBHOOK_RECEIVED] Webhook verified successfully');
      return { status: 200, body: challenge };
    }

    console.warn('[PAGE_WEBHOOK_RECEIVED] Verify: token mismatch');
    return { status: 403, body: 'Verify token mismatch' };
  }

  /**
   * Validate X-Hub-Signature-256 header.
   * @param {Buffer|string} rawBody
   * @param {string} signatureHeader - e.g. "sha256=abcdef..."
   * @returns {boolean}
   */
  static validateSignature(rawBody, signatureHeader) {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      console.warn('[PAGE_WEBHOOK_RECEIVED] META_APP_SECRET not set, skipping signature validation');
      return true; // Allow in dev mode
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

    const signature = signatureHeader.replace('sha256=', '');
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    const provided = Buffer.from(signature, 'hex');
    const expected = Buffer.from(expectedSignature, 'hex');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  /**
   * Handle incoming webhook event (POST endpoint).
   * @param {object} body - Parsed JSON body from Meta
   * @param {function} emitFn - Socket.io emit function: (event, data) => void
   * @returns {{ processed: number, errors: number }}
   */
  static handleWebhookEvent(body, emitFn) {
    const db = getDb();
    const result = { processed: 0, errors: 0 };

    if (body.object !== 'page') {
      console.warn('[PAGE_WEBHOOK_RECEIVED] Ignoring non-page object:', body.object);
      return result;
    }

    for (const entry of (body.entry || [])) {
      const pageId = entry.id;
      const source = InboxSourceService.getSourceByExternalId('page_messenger', pageId, db);

      if (!source) {
        console.warn(`[PAGE_WEBHOOK_RECEIVED] No registered source for Page ID ${pageId}. Discarding.`);
        result.errors++;
        continue;
      }

      for (const event of (entry.messaging || [])) {
        try {
          this._processMessagingEvent(event, source, db, emitFn);
          result.processed++;
        } catch (err) {
          console.error(`[PAGE_WEBHOOK_RECEIVED] Error processing event:`, err.message);
          result.errors++;
        }
      }
    }

    console.log(`[PAGE_WEBHOOK_RECEIVED] Processed ${result.processed} events, ${result.errors} errors`);
    return result;
  }

  /**
   * Process a single messaging event from webhook.
   */
  static _processMessagingEvent(event, source, db, emitFn) {
    const message = event.message;
    if (!message) return; // Skip non-message events (read receipts, deliveries, etc.)

    const senderPsid = event.sender?.id;
    const recipientId = event.recipient?.id; // Page ID
    const messageId = message.mid;
    const messageText = message.text || '';
    const timestamp = event.timestamp || Date.now();

    // Determine if outgoing (sent by Page) or incoming (sent by customer)
    const isOutgoing = String(senderPsid) === String(source.external_id);
    const contactPsid = isOutgoing ? recipientId : senderPsid;

    // Deduplicate by message.mid
    const existing = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(messageId);
    if (existing) {
      console.log(`[PAGE_WEBHOOK_RECEIVED] Duplicate message ${messageId}, skipping`);
      return;
    }

    // Upsert thread: use contactPsid as external_thread_id under this source
    const threadId = `${source.id}:${contactPsid}`;
    const thread = ConversationRepository.upsertThread({
      id: threadId,
      account_id: source.owner_account_id || source.external_id,
      source_id: source.id,
      external_thread_id: contactPsid,
      contact_name: null, // Will be resolved later if needed
      last_message: messageText.substring(0, 200),
      is_unread: !isOutgoing
    }, db);

    // Set source_id on thread if not set
    if (!thread.source_id) {
      db.prepare('UPDATE threads SET source_id = ? WHERE id = ?').run(source.id, thread.id);
    }

    // Handle media attachments
    let mediaType = 'text';
    let mediaUrl = null;
    if (message.attachments && message.attachments.length > 0) {
      const attachment = message.attachments[0];
      if (attachment.type === 'image') { mediaType = 'image'; mediaUrl = attachment.payload?.url; }
      else if (attachment.type === 'video') { mediaType = 'video'; mediaUrl = attachment.payload?.url; }
      else if (attachment.type === 'audio') { mediaType = 'voice'; mediaUrl = attachment.payload?.url; }
      else if (attachment.type === 'file') { mediaType = 'file'; mediaUrl = attachment.payload?.url; }
    }

    // Insert message
    db.prepare(`
      INSERT INTO messages (thread_id, fb_message_id, sender_id, content, media_type, media_url, is_outgoing, timestamp_ms, timestamp_source, delivery_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'webhook', 'sent', ?)
    `).run(
      thread.id, messageId, senderPsid, messageText || null,
      mediaType, mediaUrl, isOutgoing ? 1 : 0,
      timestamp, new Date(timestamp).toISOString()
    );

    // Update thread last_activity
    ConversationRepository.touchThread(thread.id, messageText.substring(0, 200), db);

    console.log(`[PAGE_MESSAGE_PERSISTED] mid=${messageId} thread=${thread.id} source=${source.id} outgoing=${isOutgoing}`);

    // Emit to CRM
    const messageData = {
      thread_id: thread.id,
      fb_message_id: messageId,
      sender_id: senderPsid,
      content: messageText,
      media_type: mediaType,
      media_url: mediaUrl,
      is_outgoing: isOutgoing,
      timestamp_ms: timestamp,
      timestamp_source: 'webhook',
      delivery_status: 'sent',
      source_id: source.id,
      source_type: source.source_type,
      source_name: source.display_name,
      created_at: new Date(timestamp).toISOString()
    };

    if (emitFn) {
      emitFn('NEW_MESSAGE', messageData);
      emitFn('PAGE_MESSAGE_RECEIVED', messageData);
    }
  }

  /**
   * Send a message via Page Send API.
   * @param {string} sourceId - inbox_sources.id
   * @param {string} recipientPsid - Customer's PSID
   * @param {string} messageText - Text to send
   * @returns {object} { success, messageId, error }
   */
  static async sendMessage(sourceId, recipientPsid, messageText) {
    console.log(`[PAGE_SEND_REQUEST] Queuing message for source=${sourceId} recipient=${recipientPsid} text_len=${(messageText || '').length}`);

    try {
      const db = getDb();
      const MessageQueueRepository = require('../repositories/MessageQueueRepository');
      
      const threadId = `${sourceId}:${recipientPsid}`;
      // Lấy owner_account_id từ inbox_sources để Extension biết account nào xử lý
      const source = db.prepare('SELECT owner_account_id, external_id FROM inbox_sources WHERE id = ?').get(sourceId);
      const accountId = source?.owner_account_id || source?.external_id;

      if (!accountId) {
        throw new Error('Không tìm thấy owner_account_id cho Page source này');
      }

      const queueId = MessageQueueRepository.insert({
        thread_id: threadId,
        account_id: accountId,
        content: messageText
      });

      console.log(`[PAGE_SEND_RESULT] Queued successfully: queueId=${queueId}`);
      // Trả về success giả lập để CRM không báo lỗi, 
      // queue worker s? dispatch th?c t?.
      return { success: true, messageId: queueId, recipientId: recipientPsid };
      
      /* --- FALLBACK: OLD WEBHOOK FETCH LOGIC ---
      const token = InboxSourceService.getDecryptedToken(sourceId);
      if (!token) return { success: false, error: 'No access token' };
      if (typeof fetch !== 'function') throw new Error('Global fetch is not available');
      
      const res = await fetch('https://graph.facebook.com/v18.0/me/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientPsid }, message: { text: messageText } })
      });
      const data = await res.json();
      if (data.error) return { success: false, error: data.error.message, error_code: data.error.code };
      return { success: true, messageId: data.message_id, recipientId: data.recipient_id };
      ------------------------------------------ */
    } catch (err) {
      console.error(`[PAGE_SEND_RESULT] Queue error:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Backfill conversation history for a Page source.
   * @param {string} sourceId
   * @param {function} emitFn
   */
  static async backfillConversations(sourceId, emitFn) {
    const db = getDb();
    const token = InboxSourceService.getDecryptedToken(sourceId, db);
    const source = InboxSourceService.getSourceById(sourceId, db);
    if (!token || !source) {
      console.warn(`[PAGE_BACKFILL] Cannot backfill: missing token or source for ${sourceId}`);
      return;
    }

    try {
      if (typeof fetch !== 'function') throw new Error('Global fetch is not available in this Node runtime');
      const convUrl = new URL(`https://graph.facebook.com/v18.0/${source.external_id}/conversations`);
      convUrl.searchParams.set('fields', 'id,participants,updated_time');
      convUrl.searchParams.set('limit', '25');
      convUrl.searchParams.set('access_token', token);
      const convRes = await fetch(convUrl);
      const convData = await convRes.json();

      if (convData.error) {
        console.warn(`[PAGE_BACKFILL] Conversations API error for ${sourceId}:`, convData.error.message);
        return;
      }

      for (const conv of (convData.data || [])) {
        try {
          // Get participant info
          const participant = (conv.participants?.data || []).find(p => String(p.id) !== String(source.external_id));
          const contactPsid = participant?.id;
          const contactName = participant?.name || null;
          if (!contactPsid) continue;

          // Upsert thread
          const threadId = `${source.id}:${contactPsid}`;
          const thread = ConversationRepository.upsertThread({
            id: threadId,
            account_id: source.owner_account_id || source.external_id,
            source_id: source.id,
            external_thread_id: contactPsid,
            contact_name: contactName,
            is_unread: false
          }, db);

          if (!thread.source_id) {
            db.prepare('UPDATE threads SET source_id = ? WHERE id = ?').run(source.id, thread.id);
          }

          // Fetch messages for this conversation
          const msgUrl = new URL(`https://graph.facebook.com/v18.0/${conv.id}/messages`);
          msgUrl.searchParams.set('fields', 'id,message,from,created_time');
          msgUrl.searchParams.set('limit', '25');
          msgUrl.searchParams.set('access_token', token);
          const msgRes = await fetch(msgUrl);
          const msgData = await msgRes.json();

          for (const msg of (msgData.data || []).reverse()) {
            const existing = db.prepare('SELECT id FROM messages WHERE fb_message_id = ?').get(msg.id);
            if (existing) continue;

            const isOutgoing = String(msg.from?.id) === String(source.external_id);
            const ts = new Date(msg.created_time).getTime();

            db.prepare(`
              INSERT OR IGNORE INTO messages (thread_id, fb_message_id, sender_id, content, is_outgoing, timestamp_ms, timestamp_source, delivery_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'backfill', 'sent', ?)
            `).run(thread.id, msg.id, msg.from?.id || 'unknown', msg.message || '', isOutgoing ? 1 : 0, ts, new Date(ts).toISOString());
          }

          // Update thread last_message
          const lastMsg = (msgData.data || [])[0];
          if (lastMsg) {
            ConversationRepository.touchThread(thread.id, (lastMsg.message || '').substring(0, 200), db);
          }
        } catch (convErr) {
          console.warn(`[PAGE_BACKFILL] Error processing conversation:`, convErr.message);
        }
      }

      console.log(`[PAGE_BACKFILL] Completed for source ${sourceId}: ${(convData.data || []).length} conversations`);
    } catch (err) {
      console.warn(`[PAGE_BACKFILL] Failed for source ${sourceId}:`, err.message);
    }
  }
}

module.exports = PageMessengerAdapter;
