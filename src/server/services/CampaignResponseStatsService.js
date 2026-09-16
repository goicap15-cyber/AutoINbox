class CampaignResponseStatsService {
  static isCallActivityText(content) {
    return /(?:cuộc gọi|bỏ lỡ|đã nhỡ|nhỡ cuộc|audio call|video call|voice call|missed call|call ended)/iu.test(String(content || ''));
  }

  static recordIncomingResponse({ messageId, threadId, accountId = null, observedAtMs = null }, database) {
    if (!messageId || !threadId) return null;
    // Campaign replies are customer chat messages only. Call activity is kept
    // in the conversation timeline, but must never count as a reply.
    const sourceMessage = database.prepare('SELECT content, is_outgoing FROM messages WHERE id = ?').get(messageId);
    if (!sourceMessage || Number(sourceMessage.is_outgoing) === 1 || this.isCallActivityText(sourceMessage.content)) return null;
    const existing = database.prepare(
      'SELECT campaign_id, campaign_recipient_id, message_id FROM campaign_response_events WHERE message_id = ?'
    ).get(messageId);
    if (existing) return existing;

    // One incoming message belongs to the most recently sent campaign for
    // this conversation. Account matching is preferred, while blank legacy
    // recipient account ids remain compatible with existing campaign data.
    const recipient = database.prepare(`
      SELECT cr.id AS campaign_recipient_id, cr.campaign_id, cr.sent_at
      FROM campaign_recipients cr
      WHERE cr.thread_id = ?
        AND cr.status = 'sent'
        AND cr.sent_at IS NOT NULL
        AND (? IS NULL OR cr.account_id = ? OR COALESCE(cr.account_id, '') = '')
      ORDER BY datetime(cr.sent_at) DESC, cr.rowid DESC
      LIMIT 1
    `).get(String(threadId), accountId == null ? null : String(accountId), accountId == null ? null : String(accountId));
    if (!recipient) return null;

    // DOM virtualization can mount an old customer message after a campaign
    // starts. Compare at minute precision because Messenger labels often omit
    // seconds: old history is rejected, while a genuine first reply in the
    // same displayed minute as the send is accepted immediately.
    const observed = Number(observedAtMs);
    const sentMs = Date.parse(String(recipient.sent_at || '').replace(' ', 'T') + (String(recipient.sent_at || '').includes('Z') ? '' : 'Z'));
    if (Number.isFinite(observed) && observed > 0 && Number.isFinite(sentMs)) {
      const observedMinute = Math.floor(observed / 60000);
      const sentMinute = Math.floor(sentMs / 60000);
      if (observedMinute < sentMinute) return null;
    }

    const inserted = database.prepare(`
      INSERT OR IGNORE INTO campaign_response_events
        (campaign_id, campaign_recipient_id, message_id)
      VALUES (?, ?, ?)
    `).run(recipient.campaign_id, recipient.campaign_recipient_id, messageId);
    if (!inserted.changes) return database.prepare(
      'SELECT campaign_id, campaign_recipient_id, message_id FROM campaign_response_events WHERE message_id = ?'
    ).get(messageId) || null;
    return { ...recipient, message_id: Number(messageId) };
  }

  static get(campaignId, database) {
    // Repair false historical attributions produced by call-log DOM rows.
    // This is idempotent and keeps the actual call messages in the timeline.
    const hasMediaType = database.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'media_type');
    database.prepare(`
      DELETE FROM campaign_response_events
      WHERE message_id IN (
        SELECT id FROM messages
        WHERE COALESCE(is_outgoing, 0) = 1
          OR lower(COALESCE(content, '')) LIKE '%cu?c g?i%'
          OR lower(COALESCE(content, '')) LIKE '%b? l?%'
          OR lower(COALESCE(content, '')) LIKE '%đã nhỡ%'
          OR lower(COALESCE(content, '')) LIKE '%missed call%'
          OR lower(COALESCE(content, '')) LIKE '%call ended%'
          ${hasMediaType ? "OR media_type = 'call'" : ''}
      )
    `).run();
    const campaign = database.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;

    const recipients = database.prepare(`
      SELECT
        cr.id AS recipient_id,
        cr.thread_id,
        cr.account_id,
        cr.status AS delivery_status,
        cr.sent_at,
        COALESCE(t.contact_name, cr.thread_id) AS contact_name,
        (
          SELECT m.created_at
          FROM campaign_response_events response
          JOIN messages m ON m.id = response.message_id
          WHERE response.campaign_recipient_id = cr.id
          ORDER BY response.id ASC
          LIMIT 1
        ) AS replied_at,
        (
          SELECT m.content
          FROM campaign_response_events response
          JOIN messages m ON m.id = response.message_id
          WHERE response.campaign_recipient_id = cr.id
          ORDER BY response.id ASC
          LIMIT 1
        ) AS reply_preview,
        (
          SELECT capture.normalized_phone
          FROM contact_phone_captures capture
          WHERE capture.thread_id = cr.thread_id
            AND capture.selection_state <> 'ignored'
            AND EXISTS (
              SELECT 1 FROM campaign_response_events response
              WHERE response.campaign_recipient_id = cr.id
            )
            AND COALESCE(NULLIF(capture.message_timestamp_ms, 0), unixepoch(capture.detected_at) * 1000)
                >= (unixepoch(cr.sent_at) * 1000) - 60000
          ORDER BY COALESCE(NULLIF(capture.message_timestamp_ms, 0), unixepoch(capture.detected_at) * 1000) ASC, capture.id ASC
          LIMIT 1
        ) AS phone,
        (
          SELECT capture.detected_at
          FROM contact_phone_captures capture
          WHERE capture.thread_id = cr.thread_id
            AND capture.selection_state <> 'ignored'
            AND EXISTS (
              SELECT 1 FROM campaign_response_events response
              WHERE response.campaign_recipient_id = cr.id
            )
            AND COALESCE(NULLIF(capture.message_timestamp_ms, 0), unixepoch(capture.detected_at) * 1000)
                >= (unixepoch(cr.sent_at) * 1000) - 60000
          ORDER BY COALESCE(NULLIF(capture.message_timestamp_ms, 0), unixepoch(capture.detected_at) * 1000) ASC, capture.id ASC
          LIMIT 1
        ) AS phone_captured_at
      FROM campaign_recipients cr
      LEFT JOIN threads t ON t.id = cr.thread_id
      WHERE cr.campaign_id = ? AND cr.status = 'sent' AND cr.sent_at IS NOT NULL
      ORDER BY datetime(cr.sent_at) DESC, cr.selection_order ASC
    `).all(campaignId);

    const rows = recipients.map((recipient) => ({
      ...recipient,
      replied: Boolean(recipient.replied_at),
      has_phone: Boolean(recipient.phone)
    }));
    const sent = rows.length;
    const replied = rows.filter((recipient) => recipient.replied).length;
    const withPhone = rows.filter((recipient) => recipient.has_phone).length;

    return {
      campaign_id: campaignId,
      counts: {
        sent,
        replied,
        with_phone: withPhone,
        unanswered: Math.max(0, sent - replied)
      },
      rates: {
        reply_rate: sent ? Math.round((replied / sent) * 1000) / 10 : 0,
        phone_rate: sent ? Math.round((withPhone / sent) * 1000) / 10 : 0
      },
      recipients: rows
    };
  }
}

module.exports = CampaignResponseStatsService;
