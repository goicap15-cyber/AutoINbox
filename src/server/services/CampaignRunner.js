const CampaignRepository = require('../repositories/CampaignRepository');
const MessageQueueRepository = require('../repositories/MessageQueueRepository');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE_ERRORS = new Set([
  'EXTENSION_NOT_CONNECTED',
  'EXTENSION_DISPATCH_FAILED',
  'EXTENSION_ACK_TIMEOUT',
  'QUEUE_CONFIRMATION_TIMEOUT',
  'FACEBOOK_SEND_EXCEPTION',
  'PAGE_SEND_FAILED',
  'PERSONAL_SEND_FAILED',
  'SEND_FAILED',
  'COMPOSER_NOT_FOUND',
  'COMPOSER_UNAVAILABLE',
  'COMPOSER_NOT_READY',
  'CDP_ENTER_FAILED',
  'CDP_INSERT_TEXT_FAILED'
]);

class CampaignRunner {
  constructor({ database = null } = {}) {
    this.database = database;
    this.runners = new Map();
    this.enqueueMessage = null;
    this.emit = () => {};
    this.getQueueStatus = null;
    this.sleep = defaultSleep;
    this.pollIntervalMs = 250;
    this.confirmationTimeoutMs = 120000;
  }

  configure({
    enqueueMessage,
    emit,
    getQueueStatus,
    sleep,
    pollIntervalMs,
    confirmationTimeoutMs,
    database,
    accountDailyCap
  } = {}) {
    if (enqueueMessage) this.enqueueMessage = enqueueMessage;
    if (emit) this.emit = emit;
    if (getQueueStatus) this.getQueueStatus = getQueueStatus;
    if (sleep) this.sleep = sleep;
    if (database) this.database = database;
    if (Number.isFinite(pollIntervalMs)) this.pollIntervalMs = Math.max(1, pollIntervalMs);
    if (Number.isFinite(confirmationTimeoutMs)) {
      this.confirmationTimeoutMs = Math.max(10, confirmationTimeoutMs);
    }
    if (Number.isFinite(accountDailyCap)) {
      this.accountDailyCap = accountDailyCap;
    }
  }

  repositoryCall(method, ...args) {
    if (method === 'addAudit') {
      const [campaignId, eventType, payload = {}, recipientId = null, options = {}] = args;
      return CampaignRepository.addAudit(
        campaignId,
        eventType,
        payload,
        recipientId,
        this.database || undefined,
        options
      );
    }
    if (method === 'createAttempt') {
      const [recipientId, messageId, options = {}] = args;
      return CampaignRepository.createAttempt(
        recipientId,
        messageId,
        this.database || undefined,
        options
      );
    }
    return CampaignRepository[method](...args, this.database || undefined);
  }

  finishAttempt(attemptId, status, errorCode = null, errorMessage = null, attachmentOutcome = null) {
    return CampaignRepository.finishAttempt(
      attemptId,
      status,
      errorCode,
      errorMessage,
      this.database || undefined,
      attachmentOutcome
    );
  }

  start(campaignId) {
    if (this.runners.has(campaignId)) return this.runners.get(campaignId);
    if (typeof this.enqueueMessage !== 'function') {
      throw new Error('CAMPAIGN_RUNNER_NOT_CONFIGURED');
    }
    const promise = this.run(campaignId).finally(() => this.runners.delete(campaignId));
    this.runners.set(campaignId, promise);
    return promise;
  }

  emitState(campaignId, recipientId = null) {
    const campaign = this.repositoryCall('getCampaign', campaignId);
    if (!campaign) return;
    const recipient = recipientId
      ? campaign.recipients.find((item) => item.id === recipientId)
      : null;
    this.emit(campaign, recipient || null);
  }

  finishProcessingAttempt(campaign, recipient, queueResult, recovery = false) {
    const attachment = campaign.attachments?.find(
      (item) => item.campaign_message_id === recipient.campaign_message_id
    ) || null;
    if (queueResult.status === 'sent') {
      this.finishAttempt(
        recipient.attempt_id,
        'confirmed',
        null,
        null,
        attachment ? { status: 'sent', error: null } : null
      );
      this.repositoryCall(
        'addAudit',
        campaign.id,
        recovery ? 'delivery_confirmed_after_recovery' : 'delivery_confirmed',
        { attempt_id: recipient.attempt_id, queue_id: recipient.queue_id },
        recipient.id
      );
      return;
    }
    const errorCode = queueResult.error_reason ||
      (queueResult.status === 'unknown' ? 'QUEUE_CONFIRMATION_TIMEOUT' : 'QUEUE_SEND_FAILED');
    const attemptStatus = queueResult.status === 'unknown' ? 'unknown' : 'failed';
    this.finishAttempt(
      recipient.attempt_id,
      attemptStatus,
      errorCode,
      errorCode,
      attachment ? { status: 'failed', error: errorCode } : null
    );
    this.repositoryCall(
      'addAudit',
      campaign.id,
      recovery ? 'delivery_failed_after_recovery' : 'delivery_failed',
      { attempt_id: recipient.attempt_id, queue_id: recipient.queue_id, error: errorCode },
      recipient.id
    );
  }

  async settleProcessing(campaign, recipient) {
    if (!recipient.attempt_id) {
      const database = this.database || require('../database/db');
      database.prepare(`
        UPDATE campaign_recipients
        SET status = 'failed', last_error_code = 'RECOVERY_ATTEMPT_MISSING',
            last_error = 'Không tìm thấy attempt đang xử lý', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing'
      `).run(recipient.id);
      this.repositoryCall(
        'addAudit',
        campaign.id,
        'recovery_attempt_missing',
        {},
        recipient.id
      );
      return;
    }
    if (!recipient.queue_id) {
      this.finishAttempt(
        recipient.attempt_id,
        'unknown',
        'RECOVERY_QUEUE_MISSING',
        'Attempt chưa có queue id trước khi backend dừng'
      );
      this.repositoryCall(
        'addAudit',
        campaign.id,
        'recovery_attempt_unknown',
        { attempt_id: recipient.attempt_id, reason: 'RECOVERY_QUEUE_MISSING' },
        recipient.id
      );
      return;
    }
    const result = await this.waitForQueue(recipient.queue_id, campaign.id);
    this.finishProcessingAttempt(campaign, recipient, result, true);
  }

  shouldRetry(campaign, recipient, errorCode) {
    const attempts = (campaign.attempts || []).filter(
      (attempt) => attempt.campaign_recipient_id === recipient.id
    );
    const latest = attempts[attempts.length - 1];
    const messageAttemptCount = latest ? attempts.filter((attempt) => attempt.campaign_message_id === latest.campaign_message_id).length : 0;
    return RETRYABLE_ERRORS.has(errorCode) &&
      messageAttemptCount <= Number(campaign.max_retries || 0);
  }

  async run(campaignId) {
    while (true) {
      const campaign = this.repositoryCall('getCampaign', campaignId);
      if (!campaign) return;

      const processing = this.repositoryCall('getProcessingRecipient', campaignId);
      if (processing) {
        await this.settleProcessing(campaign, processing);
        this.emitState(campaignId, processing.id);
        continue;
      }

      if (campaign.status === 'cancelling') {
        this.repositoryCall('cancelPending', campaignId);
        this.repositoryCall('updateCampaignStatus', campaignId, 'cancelling', 'cancelled');
        this.repositoryCall('addAudit', campaignId, 'cancelled', {});
        this.emitState(campaignId);
        return;
      }
      if (campaign.status === 'pausing') {
        this.repositoryCall('updateCampaignStatus', campaignId, 'pausing', 'paused');
        this.repositoryCall('addAudit', campaignId, 'paused', {});
        this.emitState(campaignId);
        return;
      }
      if (campaign.status !== 'running') return;

      const recipient = this.repositoryCall('getNextRecipient', campaignId);
      if (!recipient) {
        const latest = this.repositoryCall('getCampaign', campaignId);
        const finishedStatus = Number(latest.counts.failed || 0) > 0
          ? 'completed_with_errors'
          : 'completed';
        this.repositoryCall('updateCampaignStatus', campaignId, 'running', finishedStatus);
        this.repositoryCall('addAudit', campaignId, finishedStatus, latest.counts);
        this.emitState(campaignId);
        return;
      }

      let attempt = null;
      try {
        attempt = this.repositoryCall(
          'createAttempt',
          recipient.id,
          recipient.campaign_message_id,
          { accountDailyCap: this.accountDailyCap }
        );
        // Spec 040: a message may have a manifest (several files, or one
        // folder ZIP) instead of/alongside spec 039's single attachment.
        // .find() alone would silently pick only the first of several
        // manifest members - look the message up by id to get all of them.
        const dispatchMessage = campaign.messages?.find((item) => item.id === recipient.campaign_message_id) || null;
        // Guard against a stale/orphaned manifest row that ended up with no
        // member attachments left (e.g. its last file was removed) - picking
        // one would fail the whole dispatch with ATTACHMENT_MANIFEST_EMPTY
        // even though a perfectly good manifest/attachment exists alongside it.
        const manifest = dispatchMessage?.manifests?.find((item) =>
          dispatchMessage.attachments?.some((attachmentItem) => attachmentItem.manifest_id === item.id)
        ) || null;
        const attachment = manifest ? null : (dispatchMessage?.attachments?.[0] || null);
        const dispatched = await this.enqueueMessage({
          campaign,
          recipient,
          attempt,
          content: recipient.text_content || '',
          attachment,
          manifest
        });
        this.repositoryCall(
          'linkAttemptQueue',
          attempt.id,
          dispatched.queueId,
          dispatched.clientMessageId
        );
        this.repositoryCall(
          'addAudit',
          campaignId,
          'dispatch_requested',
          {
            recipient_id: recipient.id,
            attempt_id: attempt.id,
            queue_id: dispatched.queueId,
            attachment_id: attachment?.id || null
          },
          recipient.id
        );
        this.emitState(campaignId, recipient.id);
        const result = await this.waitForQueue(dispatched.queueId, campaignId);
        const processingRow = this.repositoryCall('getProcessingRecipient', campaignId);
        if (processingRow) this.finishProcessingAttempt(campaign, processingRow, result, false);
      } catch (error) {
        const isDailyCapReached = error?.code === 'SEND_LIMIT_REACHED' ||
          error?.message === 'SEND_LIMIT_REACHED' ||
          (typeof error?.message === 'string' && (
            error.message.includes('SEND_LIMIT_REACHED') ||
            error.message.includes('giới hạn gửi trong ngày') ||
            error.message.includes('gi?i h?n g?i')
          ));

        if (isDailyCapReached) {
          if (attempt) {
            this.finishAttempt(
              attempt.id,
              'failed',
              'SEND_LIMIT_REACHED',
              error.message
            );
            this.repositoryCall(
              'addAudit',
              campaignId,
              'delivery_failed',
              { attempt_id: attempt.id, error: error.message, error_code: 'SEND_LIMIT_REACHED' },
              recipient.id
            );
            this.repositoryCall('resetRecipientForRetry', recipient.id);
          }
          this.repositoryCall('updateCampaignStatus', campaignId, ['running', 'pausing'], 'paused');
          this.repositoryCall(
            'addAudit',
            campaignId,
            'paused',
            {
              reason: 'SEND_LIMIT_REACHED',
              message: error.message || 'Tài khoản đã đạt giới hạn gửi trong ngày'
            }
          );
          this.emitState(campaignId, recipient.id);
          return;
        }

        if (attempt) {
          this.finishAttempt(
            attempt.id,
            'failed',
            error.code || 'DISPATCH_FAILED',
            error.message
          );
          this.repositoryCall(
            'addAudit',
            campaignId,
            'delivery_failed',
            { attempt_id: attempt.id, error: error.message, error_code: error.code || 'DISPATCH_FAILED' },
            recipient.id
          );
        } else {
          this.repositoryCall(
            'addAudit',
            campaignId,
            'delivery_failed',
            { error: error.message, error_code: error.code || 'ATTEMPT_CREATION_FAILED' },
            recipient.id
          );
          this.repositoryCall('updateCampaignStatus', campaignId, ['running', 'pausing'], 'paused');
          this.emitState(campaignId, recipient.id);
          return;
        }
      }

      let updated = this.repositoryCall('getCampaign', campaignId);
      let updatedRecipient = updated.recipients.find((item) => item.id === recipient.id);
      if (
        updatedRecipient?.status === 'failed' &&
        this.shouldRetry(updated, updatedRecipient, updatedRecipient.last_error_code)
      ) {
        // Give Chrome time to recover from a service-worker restart, tab reload,
        // or composer remount instead of burning every retry in the same tick.
        const retryDelayMs = Math.max(1000, Math.min(5000, Number(updated.pacing_ms) || 2000));
        await this.sleep(retryDelayMs);
        this.repositoryCall('resetRecipientForRetry', updatedRecipient.id);
        this.repositoryCall(
          'addAudit',
          campaignId,
          'automatic_retry_scheduled',
          {
            recipient_id: updatedRecipient.id,
            attempt_count: updatedRecipient.attempt_count,
            max_retries: updated.max_retries
          },
          updatedRecipient.id
        );
        updated = this.repositoryCall('getCampaign', campaignId);
        updatedRecipient = updated.recipients.find((item) => item.id === recipient.id);
      }
      this.emit(updated, updatedRecipient || null);
      if (updated.status === 'pausing' || updated.status === 'cancelling') continue;
      if (updated.pacing_ms > 0) await this.sleep(updated.pacing_ms);
    }
  }

  async waitForQueue(queueId, campaignId) {
    const timeoutAt = Date.now() + this.confirmationTimeoutMs;
    while (Date.now() < timeoutAt) {
      const row = this.getQueueStatus
        ? this.getQueueStatus(queueId)
        : MessageQueueRepository.getStatus(queueId, this.database || undefined);
      if (row && ['sent', 'failed'].includes(row.status)) return row;
      const campaign = this.repositoryCall('getCampaign', campaignId);
      if (!campaign || campaign.status === 'cancelled') {
        return { status: 'failed', error_reason: 'CAMPAIGN_CANCELLED' };
      }
      await this.sleep(this.pollIntervalMs);
    }
    return { status: 'unknown', error_reason: 'QUEUE_CONFIRMATION_TIMEOUT' };
  }

  recover() {
    for (const campaign of this.repositoryCall('getActiveCampaigns')) {
      if (!this.runners.has(campaign.id)) this.start(campaign.id);
    }
  }
}

const campaignRunner = new CampaignRunner();
campaignRunner.CampaignRunner = CampaignRunner;
campaignRunner.RETRYABLE_ERRORS = RETRYABLE_ERRORS;
module.exports = campaignRunner;
