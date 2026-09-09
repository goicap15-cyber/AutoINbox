const crypto = require('crypto');

let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

function makeId(prefix) {
  return prefix + '_' + crypto.randomUUID();
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (error) { return null; }
}

const CAMPAIGN_STATUSES = new Set([
  'draft', 'ready', 'running', 'pausing', 'paused', 'cancelling', 'cancelled',
  'completed', 'completed_with_errors', 'failed'
]);

const PHONE_CAPTURE_POLICIES = new Set(['continue', 'stop_remaining', 'thank_then_stop']);

function normalizePhoneCapturePolicy(policy) {
  if (policy == null) return 'continue';
  if (!PHONE_CAPTURE_POLICIES.has(policy)) throw new Error('INVALID_PHONE_CAPTURE_POLICY');
  return policy;
}

class CampaignRepository {
  static createDraft({
    name,
    source_scope = null,
    account_scope = null,
    start_position = 1,
    direction = 'asc',
    pacing_ms = 5000,
    max_retries = 0,
    send_cap = 50,
    quiet_hours_start = '00:00',
    quiet_hours_end = '00:00',
    created_by = null,
    recipients = [],
    messages = [],
    phone_capture_policy = 'continue',
    phone_capture_thank_you_text = null,
    phone_capture_status_id = null
  }, database = getDefaultDb()) {
    const campaignId = makeId('campaign');
    const normalizedMessages = messages.length ? messages : [{ text_content: '' }];
    const normalizedPolicy = normalizePhoneCapturePolicy(phone_capture_policy);
    if (normalizedPolicy === 'thank_then_stop' && !String(phone_capture_thank_you_text || '').trim()) {
      throw new Error('PHONE_CAPTURE_THANK_YOU_TEXT_REQUIRED');
    }
    const transaction = database.transaction(() => {
      database.prepare(`
        INSERT INTO campaigns
          (id, name, source_scope, account_scope, start_position, direction, pacing_ms,
           max_retries, send_cap, quiet_hours_start, quiet_hours_end, feature_version, created_by,
           phone_capture_policy, phone_capture_thank_you_text, phone_capture_status_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '038-v1', ?, ?, ?, ?)
      `).run(
        campaignId, name, source_scope, account_scope, start_position, direction, pacing_ms,
        max_retries, send_cap, quiet_hours_start, quiet_hours_end, created_by,
        normalizedPolicy, normalizedPolicy === 'thank_then_stop' ? String(phone_capture_thank_you_text).trim() : null,
        phone_capture_status_id || null
      );

      const insertRecipient = database.prepare(`
        INSERT INTO campaign_recipients
          (id, campaign_id, thread_id, source_id, account_id,
           source_type_snapshot, source_external_id_snapshot, source_display_name_snapshot,
           selection_order, eligibility_status, eligibility_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      recipients.forEach((recipient, index) => {
        insertRecipient.run(
          makeId('campaign_recipient'), campaignId, recipient.thread_id,
          recipient.source_id || null, recipient.account_id || '',
          recipient.source_type || null,
          recipient.source_type === 'page_messenger' ? (recipient.source_external_id || null) : null,
          recipient.source_display_name || recipient.source_name || null,
          index + 1, recipient.eligibility_status, recipient.eligibility_reason || null
        );
      });

      const insertMessage = database.prepare(`
        INSERT INTO campaign_messages
          (id, campaign_id, sequence_order, text_content, validation_status, validation_error)
        VALUES (?, ?, ?, ?, 'pending', NULL)
      `);
      normalizedMessages.forEach((message, index) => {
        insertMessage.run(
          makeId('campaign_message'), campaignId, index + 1,
          typeof message.text_content === 'string' ? message.text_content : ''
        );
      });
      this.addAudit(
        campaignId,
        'created',
        { recipient_count: recipients.length, message_count: normalizedMessages.length },
        null,
        database,
        { actorUserId: created_by, actorType: 'operator' }
      );
    });
    transaction();
    return this.getCampaign(campaignId, database);
  }

  static getCampaign(campaignId, database = getDefaultDb()) {
    const campaign = database.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;
    const recipients = database.prepare(`
      SELECT cr.*, t.contact_name, t.last_message, t.thread_url,
             COALESCE(cr.source_type_snapshot, s.source_type, 'page_messenger') AS source_type,
             COALESCE(cr.source_display_name_snapshot, s.display_name, t.contact_name, 'Không xác định') AS source_name,
             COALESCE(cr.source_external_id_snapshot, CASE WHEN COALESCE(cr.source_type_snapshot, s.source_type) = 'page_messenger' THEN s.external_id ELSE NULL END) AS source_external_id,
             s.status AS current_source_status,
             a.status AS current_account_status
      FROM campaign_recipients cr
      LEFT JOIN threads t ON t.id = cr.thread_id
      LEFT JOIN inbox_sources s ON s.id = cr.source_id
      LEFT JOIN accounts a ON a.id = cr.account_id
      WHERE cr.campaign_id = ?
      ORDER BY cr.selection_order ASC
    `).all(campaignId);
    const messages = database.prepare(
      'SELECT * FROM campaign_messages WHERE campaign_id = ? ORDER BY sequence_order ASC'
    ).all(campaignId);
    const attachments = database.prepare(`
      SELECT ca.* FROM campaign_attachments ca
      JOIN campaign_messages cm ON cm.id = ca.campaign_message_id
      WHERE cm.campaign_id = ?
      ORDER BY ca.created_at ASC, ca.id ASC
    `).all(campaignId);
    const manifests = database.prepare(`
      SELECT cam.* FROM campaign_attachment_manifests cam
      JOIN campaign_messages cm ON cm.id = cam.campaign_message_id
      WHERE cm.campaign_id = ?
      ORDER BY cam.created_at ASC, cam.id ASC
    `).all(campaignId);
    const manifestsByMessage = new Map();
    for (const manifest of manifests) {
      const rows = manifestsByMessage.get(manifest.campaign_message_id) || [];
      rows.push(manifest);
      manifestsByMessage.set(manifest.campaign_message_id, rows);
    }
    const attachmentsByMessage = new Map();
    for (const attachment of attachments) {
      const rows = attachmentsByMessage.get(attachment.campaign_message_id) || [];
      rows.push(attachment);
      attachmentsByMessage.set(attachment.campaign_message_id, rows);
    }
    const hydratedMessages = messages.map((message) => ({
      ...message,
      attachments: attachmentsByMessage.get(message.id) || [],
      manifests: manifestsByMessage.get(message.id) || []
    }));
    const attempts = database.prepare(`
      SELECT ca.*, cr.thread_id
      FROM campaign_attempts ca
      JOIN campaign_recipients cr ON cr.id = ca.campaign_recipient_id
      WHERE cr.campaign_id = ?
      ORDER BY ca.created_at ASC, ca.id ASC
    `).all(campaignId);
    const audit = database.prepare(
      'SELECT * FROM campaign_audit_events WHERE campaign_id = ? ORDER BY id ASC'
    ).all(campaignId).map((event) => ({ ...event, payload: parseJson(event.payload_json) }));
    const counts = database.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN eligibility_status = 'eligible' THEN 1 ELSE 0 END), 0) AS eligible,
        COALESCE(SUM(CASE WHEN eligibility_status <> 'eligible' THEN 1 ELSE 0 END), 0) AS ineligible,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') AND eligibility_status = 'eligible' THEN 1 ELSE 0 END), 0) AS remaining
      FROM campaign_recipients WHERE campaign_id = ?
    `).get(campaignId);
    const source_counts = {
      page_messenger: recipients.filter((r) => (r.source_type_snapshot || r.source_type) === 'page_messenger').length,
      personal_messenger: recipients.filter((r) => (r.source_type_snapshot || r.source_type) === 'personal_messenger').length,
      total: recipients.length
    };
    return { ...campaign, counts, source_counts, recipients, messages: hydratedMessages, attachments, manifests, attempts, audit };
  }

  static listCampaigns(limit = 50, database = getDefaultDb()) {
    return database.prepare(`
      SELECT c.*,
        COUNT(cr.id) AS recipient_count,
        COALESCE(SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN cr.eligibility_status = 'eligible' THEN 1 ELSE 0 END), 0) AS eligible_count
      FROM campaigns c
      LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 50, 200)));
  }

  static updateDraft(campaignId, changes = {}, database = getDefaultDb()) {
    const campaign = database.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return null;
    if (!['draft', 'ready'].includes(campaign.status)) return false;
    const nextPolicy = normalizePhoneCapturePolicy(changes.phone_capture_policy ?? campaign.phone_capture_policy);
    const nextThankYouText = changes.phone_capture_thank_you_text ?? campaign.phone_capture_thank_you_text;
    if (nextPolicy === 'thank_then_stop' && !String(nextThankYouText || '').trim()) {
      throw new Error('PHONE_CAPTURE_THANK_YOU_TEXT_REQUIRED');
    }
    const next = {
      name: changes.name ?? campaign.name,
      start_position: changes.start_position ?? campaign.start_position,
      direction: changes.direction ?? campaign.direction,
      pacing_ms: changes.pacing_ms ?? campaign.pacing_ms,
      max_retries: changes.max_retries ?? campaign.max_retries,
      send_cap: changes.send_cap ?? campaign.send_cap,
      quiet_hours_start: changes.quiet_hours_start ?? campaign.quiet_hours_start,
      quiet_hours_end: changes.quiet_hours_end ?? campaign.quiet_hours_end,
      phone_capture_policy: nextPolicy,
      phone_capture_thank_you_text: nextPolicy === 'thank_then_stop' ? String(nextThankYouText).trim() : null,
      phone_capture_status_id: changes.phone_capture_status_id !== undefined ? changes.phone_capture_status_id : campaign.phone_capture_status_id
    };
    const transaction = database.transaction(() => {
      database.prepare(`
        UPDATE campaigns
        SET name = ?, start_position = ?, direction = ?, pacing_ms = ?, max_retries = ?,
            send_cap = ?, quiet_hours_start = ?, quiet_hours_end = ?,
            phone_capture_policy = ?, phone_capture_thank_you_text = ?, phone_capture_status_id = ?,
            status = 'draft', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('draft', 'ready')
      `).run(
        next.name, next.start_position, next.direction, next.pacing_ms, next.max_retries,
        next.send_cap, next.quiet_hours_start, next.quiet_hours_end,
        next.phone_capture_policy, next.phone_capture_thank_you_text, next.phone_capture_status_id || null,
        campaignId
      );
      if (Array.isArray(changes.messages)) {
        const rows = changes.messages.length ? changes.messages : [{ text_content: '' }];
        const existing = database.prepare(
          'SELECT * FROM campaign_messages WHERE campaign_id = ? ORDER BY sequence_order ASC'
        ).all(campaignId);
        if (rows.length < existing.length) {
          throw new Error('CAMPAIGN_MESSAGE_REMOVAL_REQUIRES_EXPLICIT_CLEANUP');
        }
        const update = database.prepare(`
          UPDATE campaign_messages
          SET text_content = ?, validation_status = 'pending', validation_error = NULL
          WHERE id = ?
        `);
        const insert = database.prepare(`
          INSERT INTO campaign_messages
            (id, campaign_id, sequence_order, text_content, validation_status)
          VALUES (?, ?, ?, ?, 'pending')
        `);
        rows.forEach((message, index) => {
          const current = existing[index];
          if (current) {
            update.run(message.text_content || '', current.id);
          } else {
            insert.run(makeId('campaign_message'), campaignId, index + 1, message.text_content || '');
          }
        });
      } else {
        database.prepare(`
          UPDATE campaign_messages
          SET validation_status = 'pending', validation_error = NULL
          WHERE campaign_id = ?
        `).run(campaignId);
      }
      database.prepare(`
        UPDATE campaign_recipients
        SET execution_order = NULL,
            status = CASE WHEN eligibility_status = 'eligible' THEN 'pending' ELSE 'skipped' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE campaign_id = ? AND status NOT IN ('sent', 'processing')
      `).run(campaignId);
    });
    transaction();
    return this.getCampaign(campaignId, database);
  }

  static setExecutionOrder(campaignId, orderedRecipientIds, database = getDefaultDb(), auditOptions = {}) {
    const transaction = database.transaction(() => {
      database.prepare(`
        UPDATE campaign_recipients
        SET execution_order = NULL,
            status = CASE WHEN eligibility_status = 'eligible' THEN 'skipped' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE campaign_id = ? AND status NOT IN ('sent', 'processing')
      `).run(campaignId);
      const update = database.prepare(`
        UPDATE campaign_recipients
        SET execution_order = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE campaign_id = ? AND id = ? AND eligibility_status = 'eligible'
          AND status NOT IN ('sent', 'processing')
      `);
      orderedRecipientIds.forEach((recipientId, index) => {
        const result = update.run(index + 1, campaignId, recipientId);
        if (!result.changes) throw new Error('INVALID_EXECUTION_RECIPIENT');
      });
      this.addAudit(campaignId, 'previewed', { execution_order: orderedRecipientIds }, null, database, auditOptions);
    });
    transaction();
    return this.getCampaign(campaignId, database);
  }

  static setMessageValidation(messageId, status, error = null, database = getDefaultDb()) {
    database.prepare(`
      UPDATE campaign_messages SET validation_status = ?, validation_error = ?
      WHERE id = ?
    `).run(status, error, messageId);
  }

  static setCampaignReady(campaignId, database = getDefaultDb()) {
    return this.updateCampaignStatus(campaignId, ['draft', 'ready'], 'ready', database);
  }

  static updateCampaignStatus(campaignId, fromStatuses, nextStatus, database = getDefaultDb()) {
    if (!CAMPAIGN_STATUSES.has(nextStatus)) throw new Error('INVALID_CAMPAIGN_STATUS');
    const expected = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    if (!expected.length) return false;
    const placeholders = expected.map(() => '?').join(',');
    const finished = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(nextStatus)
      ? ', finished_at = CURRENT_TIMESTAMP' : '';
    const started = nextStatus === 'running'
      ? ', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = NULL' : '';
    const result = database.prepare(
      'UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP' + finished + started +
      ' WHERE id = ? AND status IN (' + placeholders + ')'
    ).run(nextStatus, campaignId, ...expected);
    return result.changes > 0;
  }

  static getProcessingRecipient(campaignId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT cr.*, cm.id AS campaign_message_id, cm.text_content,
             ca.id AS attempt_id, ca.queue_id, ca.client_message_id,
             ca.status AS attempt_status, ca.idempotency_key
      FROM campaign_recipients cr
      JOIN campaign_attempts ca
        ON ca.campaign_recipient_id = cr.id AND ca.attempt_number = cr.attempt_count
      JOIN campaign_messages cm ON cm.id = ca.campaign_message_id
      WHERE cr.campaign_id = ? AND cr.status = 'processing'
        AND ca.status IN ('created', 'dispatched')
      ORDER BY cr.execution_order ASC LIMIT 1
    `).get(campaignId);
  }

  static getNextRecipient(campaignId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT cr.*, cm.id AS campaign_message_id, cm.text_content
      FROM campaign_recipients cr
      JOIN campaign_messages cm ON cm.campaign_id = cr.campaign_id
      WHERE cr.campaign_id = ? AND cr.eligibility_status = 'eligible'
        AND cr.status = 'pending' AND cr.execution_order IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campaign_attempts ca
          WHERE ca.campaign_recipient_id = cr.id AND ca.campaign_message_id = cm.id AND ca.status = 'confirmed'
        )
      ORDER BY cr.execution_order ASC, cm.sequence_order ASC
    `).get(campaignId);
  }

  static createAttempt(recipientId, messageId, database = getDefaultDb(), options = {}) {
    if (database && typeof database.prepare !== 'function') {
      const temp = database;
      database = (options && typeof options.prepare === 'function') ? options : getDefaultDb();
      options = temp;
    }
    const transaction = database.transaction(() => {
      const recipient = database.prepare('SELECT * FROM campaign_recipients WHERE id = ?').get(recipientId);
      if (!recipient) throw new Error('RECIPIENT_NOT_FOUND');
      if (recipient.status === 'sent') throw new Error('RECIPIENT_ALREADY_SENT');
      if (recipient.status !== 'pending') throw new Error('RECIPIENT_NOT_PENDING');
      const attemptNumber = Number(recipient.attempt_count || 0) + 1;
      const attemptId = makeId('attempt');
      const idempotencyKey =
        'campaign:' + recipient.campaign_id + ':recipient:' + recipient.id + ':attempt:' + attemptNumber;
      const claimed = database.prepare(`
        UPDATE campaign_recipients
        SET status = 'processing', attempt_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(attemptNumber, recipientId);
      if (!claimed.changes) throw new Error('RECIPIENT_NOT_PENDING');

      const dailyCap = Number(options?.accountDailyCap || process.env.CAMPAIGN_ACCOUNT_DAILY_CAP || 50);
      const sentToday = this.countAccountSentToday(recipient.account_id, database);
      if (sentToday >= dailyCap) {
        const error = new Error('Tài khoản đã đạt giới hạn gửi trong ngày');
        error.code = 'SEND_LIMIT_REACHED';
        throw error;
      }

      const hasAttachment = database.prepare(`
        SELECT 1 AS found FROM campaign_attachments
        WHERE campaign_message_id = ? AND validation_status = 'valid' LIMIT 1
      `).get(messageId);
      database.prepare(`
        INSERT INTO campaign_attempts
          (id, campaign_recipient_id, campaign_message_id, attempt_number,
           idempotency_key, status, attachment_status)
        VALUES (?, ?, ?, ?, ?, 'created', ?)
      `).run(
        attemptId, recipientId, messageId, attemptNumber, idempotencyKey,
        hasAttachment ? 'pending' : 'not_requested'
      );
      return {
        id: attemptId,
        idempotency_key: idempotencyKey,
        attempt_number: attemptNumber,
        campaign_id: recipient.campaign_id,
        recipient
      };
    });
    return transaction();
  }

  static linkAttemptQueue(attemptId, queueId, clientMessageId, database = getDefaultDb()) {
    return database.prepare(`
      UPDATE campaign_attempts
      SET queue_id = ?, client_message_id = ?, status = 'dispatched'
      WHERE id = ? AND status = 'created'
    `).run(queueId, clientMessageId, attemptId).changes > 0;
  }

  static finishAttempt(
    attemptId,
    status,
    errorCode = null,
    errorMessage = null,
    database = getDefaultDb(),
    attachmentOutcome = null
  ) {
    if (!['confirmed', 'failed', 'unknown'].includes(status)) throw new Error('INVALID_ATTEMPT_STATUS');
    const attempt = database.prepare('SELECT * FROM campaign_attempts WHERE id = ?').get(attemptId);
    if (!attempt) return null;
    const transaction = database.transaction(() => {
      const update = database.prepare(`
        UPDATE campaign_attempts
        SET status = ?, error_code = ?, error_message = ?,
            confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
            attachment_status = COALESCE(?, attachment_status),
            attachment_error = COALESCE(?, attachment_error)
        WHERE id = ? AND status NOT IN ('confirmed', 'failed', 'unknown')
      `).run(
        status, errorCode, errorMessage, status,
        attachmentOutcome?.status || null, attachmentOutcome?.error || null, attemptId
      );
      if (!update.changes) return;
      let recipientStatus = 'failed';
      let deferredStopAction = null;
      if (status === 'confirmed') {
        const remaining = database.prepare(`
          SELECT 1 AS found
          FROM campaign_messages cm
          JOIN campaign_recipients cr ON cr.campaign_id = cm.campaign_id
          WHERE cr.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM campaign_attempts other
              WHERE other.campaign_recipient_id = cr.id AND other.campaign_message_id = cm.id
                AND other.status = 'confirmed'
            )
          LIMIT 1
        `).get(attempt.campaign_recipient_id);
        recipientStatus = remaining ? 'pending' : 'sent';

        // A phone-capture stop/thank-then-stop action that arrived while
        // this attempt was still in flight couldn't cancel the recipient
        // immediately (never interrupts a dispatch already underway - see
        // CampaignPhoneCaptureService.applyStop). Finalize it now that the
        // in-flight attempt has settled, instead of leaving the recipient to
        // continue on to its next message.
        if (recipientStatus === 'pending') {
          deferredStopAction = database.prepare(`
            SELECT * FROM campaign_phone_capture_actions
            WHERE campaign_recipient_id = ?
              AND policy IN ('stop_remaining', 'thank_then_stop')
              AND state IN ('pending', 'thank_queued', 'thank_confirmed', 'thank_failed')
            ORDER BY id DESC LIMIT 1
          `).get(attempt.campaign_recipient_id);
          if (deferredStopAction) recipientStatus = 'cancelled';
        }
      }
      database.prepare(`
        UPDATE campaign_recipients
        SET status = ?, last_error_code = ?, last_error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing'
      `).run(recipientStatus, errorCode, errorMessage, recipientStatus, attempt.campaign_recipient_id);

      if (deferredStopAction) {
        const campaign = database.prepare('SELECT phone_capture_status_id FROM campaigns WHERE id = ?').get(deferredStopAction.campaign_id);
        let appliedStatusId = null;
        if (campaign && campaign.phone_capture_status_id) {
          const statusRow = database.prepare('SELECT id FROM lead_statuses WHERE id = ?').get(campaign.phone_capture_status_id);
          if (statusRow) {
            const recipientThread = database.prepare('SELECT thread_id FROM campaign_recipients WHERE id = ?').get(attempt.campaign_recipient_id);
            if (recipientThread) database.prepare('UPDATE contacts SET status_id = ? WHERE thread_id = ?').run(statusRow.id, recipientThread.thread_id);
            appliedStatusId = statusRow.id;
          } else {
            this.addAudit(deferredStopAction.campaign_id, 'phone_capture_status_unavailable', { status_id: campaign.phone_capture_status_id }, deferredStopAction.campaign_recipient_id, database);
          }
        }
        database.prepare(`
          UPDATE campaign_phone_capture_actions
          SET state = 'stop_applied', applied_status_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(appliedStatusId, deferredStopAction.id);
        this.addAudit(deferredStopAction.campaign_id, 'phone_capture_stop_applied', { phone_capture_id: deferredStopAction.phone_capture_id, deferred: true }, deferredStopAction.campaign_recipient_id, database);
      }
    });
    transaction();
    return database.prepare('SELECT * FROM campaign_attempts WHERE id = ?').get(attemptId);
  }

  static resetRecipientForRetry(recipientId, database = getDefaultDb()) {
    return database.prepare(`
      UPDATE campaign_recipients
      SET status = 'pending', last_error_code = NULL, last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'failed'
    `).run(recipientId).changes > 0;
  }

  static retryRecipient(campaignId, recipientId, database = getDefaultDb()) {
    const recipient = database.prepare(
      'SELECT * FROM campaign_recipients WHERE id = ? AND campaign_id = ?'
    ).get(recipientId, campaignId);
    if (!recipient) throw new Error('RECIPIENT_NOT_FOUND');
    if (recipient.status === 'sent') throw new Error('RECIPIENT_ALREADY_SENT');
    if (recipient.status !== 'failed') throw new Error('RECIPIENT_NOT_RETRYABLE');
    this.resetRecipientForRetry(recipientId, database);
    return database.prepare('SELECT * FROM campaign_recipients WHERE id = ?').get(recipientId);
  }

  static cancelPending(campaignId, database = getDefaultDb()) {
    return database.prepare(`
      UPDATE campaign_recipients
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND status = 'pending'
    `).run(campaignId).changes;
  }

  // spec 035: recipients across any non-terminal campaign whose thread just
  // produced a phone capture, still eligible for a policy reaction (pending
  // or mid-dispatch). Terminal campaigns (cancelled/completed/failed) are
  // excluded - there is no remaining work left to react to.
  static findPhoneCapturePolicyRecipients(threadId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT cr.*, c.phone_capture_policy, c.phone_capture_thank_you_text, c.phone_capture_status_id
      FROM campaign_recipients cr
      JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.thread_id = ? AND cr.status IN ('pending', 'processing')
        AND c.status NOT IN ('cancelled', 'completed', 'completed_with_errors', 'failed')
    `).all(threadId);
  }

  // Idempotency boundary for spec 035 campaign reactions: at most one action
  // row per (recipient, capture) pair, ever - returns null (not created) on
  // a repeat call instead of throwing, since callers just skip work then.
  static createPhoneCaptureAction({ campaignId, campaignRecipientId, phoneCaptureId, policy }, database = getDefaultDb()) {
    const info = database.prepare(`
      INSERT OR IGNORE INTO campaign_phone_capture_actions
        (campaign_id, campaign_recipient_id, phone_capture_id, policy, state)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(campaignId, campaignRecipientId, phoneCaptureId, policy);
    if (!info.changes) return null;
    return database.prepare('SELECT * FROM campaign_phone_capture_actions WHERE id = ?').get(info.lastInsertRowid);
  }

  static updatePhoneCaptureActionState(campaignRecipientId, phoneCaptureId, state, database = getDefaultDb(), { thankYouClientMessageId, errorDetail } = {}) {
    database.prepare(`
      UPDATE campaign_phone_capture_actions
      SET state = ?,
          thank_you_client_message_id = COALESCE(?, thank_you_client_message_id),
          error_detail = COALESCE(?, error_detail),
          updated_at = CURRENT_TIMESTAMP
      WHERE campaign_recipient_id = ? AND phone_capture_id = ?
    `).run(state, thankYouClientMessageId || null, errorDetail || null, campaignRecipientId, phoneCaptureId);
  }

  static getActiveCampaigns(database = getDefaultDb()) {
    return database.prepare(
      "SELECT * FROM campaigns WHERE status IN ('running', 'pausing', 'cancelling')"
    ).all();
  }

  static getAttemptByQueueId(queueId, database = getDefaultDb()) {
    return database.prepare('SELECT * FROM campaign_attempts WHERE queue_id = ?').get(queueId);
  }

  static addAudit(
    campaignId,
    eventType,
    payload = {},
    recipientId = null,
    database = getDefaultDb(),
    { actorUserId = null, actorType = 'system' } = {}
  ) {
    const result = database.prepare(`
      INSERT INTO campaign_audit_events
        (campaign_id, campaign_recipient_id, event_type, actor_user_id, actor_type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      campaignId, recipientId, eventType, actorUserId,
      actorType === 'operator' ? 'operator' : 'system', JSON.stringify(payload || {})
    );
    return database.prepare('SELECT * FROM campaign_audit_events WHERE id = ?').get(result.lastInsertRowid);
  }

  static countAccountSentToday(accountId, database = getDefaultDb(), options = {}) {
    const excludeAttemptId = options?.excludeAttemptId || null;
    const query = excludeAttemptId
      ? `SELECT COUNT(*) AS count
         FROM campaign_attempts ca
         JOIN campaign_recipients cr ON cr.id = ca.campaign_recipient_id
         WHERE cr.account_id = ?
           AND ca.id != ?
           AND ca.status IN ('confirmed', 'dispatched', 'unknown', 'created')
           AND date(COALESCE(ca.confirmed_at, ca.created_at)) = date('now')`
      : `SELECT COUNT(*) AS count
         FROM campaign_attempts ca
         JOIN campaign_recipients cr ON cr.id = ca.campaign_recipient_id
         WHERE cr.account_id = ?
           AND ca.status IN ('confirmed', 'dispatched', 'unknown', 'created')
           AND date(COALESCE(ca.confirmed_at, ca.created_at)) = date('now')`;

    const row = excludeAttemptId
      ? database.prepare(query).get(accountId, excludeAttemptId)
      : database.prepare(query).get(accountId);

    return row?.count || 0;
  }

  static getAttachment(attachmentId, database = getDefaultDb()) {
    return database.prepare('SELECT * FROM campaign_attachments WHERE id = ?').get(attachmentId);
  }

  static getAttachmentsForMessage(messageId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT * FROM campaign_attachments
      WHERE campaign_message_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(messageId);
  }

  static insertAttachment(attachment, database = getDefaultDb()) {
    const existing = database.prepare(`
      SELECT * FROM campaign_attachments
      WHERE campaign_message_id = ? AND checksum = ?
    `).get(attachment.campaign_message_id, attachment.checksum);
    if (existing) return existing;
    const attachmentId = attachment.id || makeId('attachment');
    database.prepare(`
      INSERT INTO campaign_attachments
        (id, campaign_message_id, manifest_id, media_type, original_name, mime_type, byte_size,
         storage_path, checksum, validation_status, validation_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachmentId, attachment.campaign_message_id, attachment.manifest_id || null, attachment.media_type,
      attachment.original_name, attachment.mime_type, attachment.byte_size,
      attachment.storage_path, attachment.checksum, attachment.validation_status,
      attachment.validation_error || null
    );
    return this.getAttachment(attachmentId, database);
  }

  static deleteAttachment(attachmentId, database = getDefaultDb()) {
    const row = this.getAttachment(attachmentId, database);
    if (!row) return null;
    database.prepare('DELETE FROM campaign_attachments WHERE id = ?').run(attachmentId);
    return row;
  }

  // Spec 040: groups one or more campaign_attachments rows (multiple selected
  // files, or one generated folder ZIP) staged together for one campaign
  // message. Kept separate from insertAttachment so spec 039's single-image
  // callers never need to know manifests exist.
  static insertManifest({ campaign_message_id, kind, item_count, total_bytes, archive_name = null }, database = getDefaultDb()) {
    if (!['files', 'folder_zip'].includes(kind)) throw new Error('INVALID_MANIFEST_KIND');
    const manifestId = makeId('manifest');
    database.prepare(`
      INSERT INTO campaign_attachment_manifests
        (id, campaign_message_id, kind, item_count, total_bytes, archive_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(manifestId, campaign_message_id, kind, item_count, total_bytes, archive_name);
    return this.getManifest(manifestId, database);
  }

  static getManifest(manifestId, database = getDefaultDb()) {
    return database.prepare('SELECT * FROM campaign_attachment_manifests WHERE id = ?').get(manifestId);
  }

  static getManifestsForMessage(messageId, database = getDefaultDb()) {
    return database.prepare(`
      SELECT * FROM campaign_attachment_manifests
      WHERE campaign_message_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(messageId);
  }
}

CampaignRepository.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;
CampaignRepository.PHONE_CAPTURE_POLICIES = PHONE_CAPTURE_POLICIES;
module.exports = CampaignRepository;
