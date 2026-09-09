class CampaignResponseStatsService {
  static get(campaignId, database) {
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
          FROM messages m
          WHERE m.thread_id = cr.thread_id
            AND m.is_outgoing = 0
            AND COALESCE(m.is_unsent, 0) = 0
            AND COALESCE(m.media_type, 'text') <> 'call'
            AND datetime(m.created_at) >= datetime(cr.sent_at)
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients newer
              WHERE newer.thread_id = cr.thread_id
                AND newer.status = 'sent'
                AND datetime(newer.sent_at) > datetime(cr.sent_at)
                AND datetime(m.created_at) >= datetime(newer.sent_at)
            )
          ORDER BY datetime(m.created_at), m.id
          LIMIT 1
        ) AS replied_at,
        (
          SELECT m.content
          FROM messages m
          WHERE m.thread_id = cr.thread_id
            AND m.is_outgoing = 0
            AND COALESCE(m.is_unsent, 0) = 0
            AND COALESCE(m.media_type, 'text') <> 'call'
            AND datetime(m.created_at) >= datetime(cr.sent_at)
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients newer
              WHERE newer.thread_id = cr.thread_id
                AND newer.status = 'sent'
                AND datetime(newer.sent_at) > datetime(cr.sent_at)
                AND datetime(m.created_at) >= datetime(newer.sent_at)
            )
          ORDER BY datetime(m.created_at), m.id
          LIMIT 1
        ) AS reply_preview,
        (
          SELECT capture.normalized_phone
          FROM contact_phone_captures capture
          WHERE capture.thread_id = cr.thread_id
            AND capture.selection_state <> 'ignored'
            AND datetime(capture.detected_at) >= datetime(cr.sent_at)
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients newer
              WHERE newer.thread_id = cr.thread_id
                AND newer.status = 'sent'
                AND datetime(newer.sent_at) > datetime(cr.sent_at)
                AND datetime(capture.detected_at) >= datetime(newer.sent_at)
            )
          ORDER BY datetime(capture.detected_at), capture.id
          LIMIT 1
        ) AS phone,
        (
          SELECT capture.detected_at
          FROM contact_phone_captures capture
          WHERE capture.thread_id = cr.thread_id
            AND capture.selection_state <> 'ignored'
            AND datetime(capture.detected_at) >= datetime(cr.sent_at)
            AND NOT EXISTS (
              SELECT 1 FROM campaign_recipients newer
              WHERE newer.thread_id = cr.thread_id
                AND newer.status = 'sent'
                AND datetime(newer.sent_at) > datetime(cr.sent_at)
                AND datetime(capture.detected_at) >= datetime(newer.sent_at)
            )
          ORDER BY datetime(capture.detected_at), capture.id
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
