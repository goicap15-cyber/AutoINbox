const fs = require('fs');
const CampaignRepository = require('../repositories/CampaignRepository');
const CampaignEligibilityService = require('./CampaignEligibilityService');

const CAMPAIGN_ROUTES = Object.freeze({
  CONFIG: '/api/campaigns/config',
  COLLECTION: '/api/campaigns',
  DETAIL: '/api/campaigns/:id',
  PREVIEW: '/api/campaigns/:id/preview',
  START: '/api/campaigns/:id/start',
  PAUSE: '/api/campaigns/:id/pause',
  RESUME: '/api/campaigns/:id/resume',
  CANCEL: '/api/campaigns/:id/cancel',
  RETRY: '/api/campaigns/:id/recipients/:recipientId/retry',
  ATTACHMENTS: '/api/campaigns/:id/attachments'
});

const CAMPAIGN_EVENTS = Object.freeze({
  UPDATED: 'CAMPAIGN_UPDATED',
  RECIPIENT_UPDATED: 'CAMPAIGN_RECIPIENT_UPDATED',
  AUDIT_EVENT: 'CAMPAIGN_AUDIT_EVENT'
});

const CAMPAIGN_ERROR_CODES = Object.freeze({
  FEATURE_DISABLED: 'CAMPAIGN_FEATURE_DISABLED',
  NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  NOT_READY: 'CAMPAIGN_NOT_READY',
  STATE_CONFLICT: 'CAMPAIGN_STATE_CONFLICT',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  INVALID_ORDER: 'INVALID_ORDER',
  MESSAGE_INVALID: 'CAMPAIGN_MESSAGE_INVALID',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  ATTACHMENT_INVALID: 'ATTACHMENT_INVALID',
  SEND_LIMIT_REACHED: 'SEND_LIMIT_REACHED',
  QUIET_HOURS_ACTIVE: 'QUIET_HOURS_ACTIVE',
  RECIPIENT_ALREADY_SENT: 'RECIPIENT_ALREADY_SENT'
});

class CampaignError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
    this.details = details;
  }
}

function getDefaultDb() {
  return require('../database/db');
}

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function validClock(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function parsePhoneCaptureStatusId(value, database) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new CampaignError('INVALID_PHONE_CAPTURE_STATUS', 'Trạng thái sau khi nhận số không hợp lệ.');
  }
  if (!database.prepare('SELECT 1 FROM lead_statuses WHERE id = ?').get(id)) {
    throw new CampaignError('INVALID_PHONE_CAPTURE_STATUS', 'Trạng thái sau khi nhận số không còn tồn tại.');
  }
  return id;
}

class CampaignService {
  static getConfig(environment = process.env) {
    const maxRecipients = parseInteger(environment.CAMPAIGN_MAX_RECIPIENTS, 50, 1, 500);
    return {
      enabled: environment.CAMPAIGN_FEATURE_ENABLED !== 'false',
      imageEnabled: environment.CAMPAIGN_IMAGE_ENABLED !== 'false',
      fileEnabled: environment.CAMPAIGN_FILE_ENABLED !== 'false',
      maxAttachmentBytes: parseInteger(environment.CAMPAIGN_MAX_FILE_BYTES, 25 * 1024 * 1024, 1, 100 * 1024 * 1024),
      testMode: environment.CAMPAIGN_TEST_MODE === 'true',
      testSourceIds: String(environment.CAMPAIGN_TEST_SOURCE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
      maxRecipients,
      accountDailyCap: parseInteger(environment.CAMPAIGN_ACCOUNT_DAILY_CAP, 50, 1, 1000),
      minimumPacingMs: parseInteger(environment.CAMPAIGN_MIN_PACING_MS, 3000, 0, 60000),
      quietHoursStart: validClock(environment.CAMPAIGN_QUIET_HOURS_START)
        ? environment.CAMPAIGN_QUIET_HOURS_START : '00:00',
      quietHoursEnd: validClock(environment.CAMPAIGN_QUIET_HOURS_END)
        ? environment.CAMPAIGN_QUIET_HOURS_END : '00:00'
    };
  }

  static assertFeatureEnabled(config = this.getConfig()) {
    if (!config.enabled) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.FEATURE_DISABLED,
        'Campaign đang tắt. Bật CAMPAIGN_FEATURE_ENABLED=true sau khi hoàn tất kiểm thử nguồn.'
      );
    }
  }

  static createDraft(payload = {}, database = getDefaultDb(), options = {}) {
    const config = { ...this.getConfig(), ...options };
    const {
      name,
      thread_ids,
      message,
      messages,
      start_position = 1,
      direction = 'asc',
      pacing_ms = 5000,
      max_retries = 0,
      created_by = 1,
      source_scope = null,
      account_scope = null,
      phone_capture_policy = 'continue',
      phone_capture_thank_you_text = null,
      phone_capture_status_id = null
    } = payload;
    const cleanName = normalizedText(name) || 'Chiến dịch ' + new Date().toLocaleString('vi-VN');
    const ids = [...new Set((thread_ids || []).map((threadId) => String(threadId)).filter(Boolean))];
    if (!ids.length) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.INVALID_RECIPIENT, 'Cần chọn ít nhất một hội thoại.');
    }
    if (ids.length > config.maxRecipients) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED,
        'Số người nhận vượt giới hạn campaign.',
        { selected: ids.length, maximum: config.maxRecipients }
      );
    }
    const position = Number(start_position);
    if (!Number.isInteger(position) || position < 1 || position > ids.length) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.INVALID_ORDER,
        'Vị trí bắt đầu phải nằm trong snapshot người nhận.',
        { start_position: position, total: ids.length }
      );
    }
    if (!['asc', 'desc'].includes(direction)) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.INVALID_ORDER, 'direction phải là asc hoặc desc.');
    }
    const normalizedMessages = Array.isArray(messages) && messages.length
      ? messages.slice(0, 5).map((item) => ({ text_content: normalizedText(item?.text_content) }))
      : [{ text_content: normalizedText(message) }];
    const recipients = CampaignEligibilityService.inspectThreads(ids, database, {
      getConnection: typeof options.getConnection === "function" ? options.getConnection : null
    });
    const sendCap = parseInteger(payload.send_cap, Math.min(ids.length, config.maxRecipients), 1, config.maxRecipients);
    const quietStart = validClock(payload.quiet_hours_start)
      ? payload.quiet_hours_start : config.quietHoursStart;
    const quietEnd = validClock(payload.quiet_hours_end)
      ? payload.quiet_hours_end : config.quietHoursEnd;
    const phoneCaptureStatusId = parsePhoneCaptureStatusId(phone_capture_status_id, database);
    return CampaignRepository.createDraft({
      name: cleanName,
      source_scope,
      account_scope,
      start_position: position,
      direction,
      pacing_ms: parseInteger(pacing_ms, 5000, 0, 24 * 60 * 60 * 1000),
      max_retries: parseInteger(max_retries, 0, 0, 3),
      send_cap: sendCap,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
      created_by: Number(created_by) || 1,
      phone_capture_policy,
      phone_capture_thank_you_text,
      phone_capture_status_id: phoneCaptureStatusId,
      recipients,
      messages: normalizedMessages
    }, database);
  }

  static updateDraft(campaignId, payload = {}, database = getDefaultDb(), options = {}) {
    const campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.NOT_FOUND, 'Không tìm thấy chiến dịch.');
    }
    if (!['draft', 'ready'].includes(campaign.status)) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.STATE_CONFLICT,
        'Chỉ có thể sửa campaign nháp hoặc sẵn sàng.'
      );
    }
    const config = { ...this.getConfig(), ...options };
    const startPosition = payload.start_position === undefined
      ? campaign.start_position : Number(payload.start_position);
    if (!Number.isInteger(startPosition) || startPosition < 1 || startPosition > campaign.recipients.length) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.INVALID_ORDER, 'Vị trí bắt đầu không hợp lệ.');
    }
    const direction = payload.direction ?? campaign.direction;
    if (!['asc', 'desc'].includes(direction)) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.INVALID_ORDER, 'direction phải là asc hoặc desc.');
    }
    const messages = Array.isArray(payload.messages)
      ? payload.messages.slice(0, 5).map((item) => ({ text_content: normalizedText(item?.text_content) }))
      : undefined;
    const phoneCaptureStatusId = payload.phone_capture_status_id === undefined
      ? campaign.phone_capture_status_id
      : parsePhoneCaptureStatusId(payload.phone_capture_status_id, database);
    return CampaignRepository.updateDraft(campaignId, {
      name: payload.name === undefined ? campaign.name : normalizedText(payload.name),
      start_position: startPosition,
      direction,
      pacing_ms: payload.pacing_ms === undefined
        ? campaign.pacing_ms
        : parseInteger(payload.pacing_ms, campaign.pacing_ms, 0, 24 * 60 * 60 * 1000),
      max_retries: payload.max_retries === undefined
        ? campaign.max_retries
        : parseInteger(payload.max_retries, campaign.max_retries, 0, 3),
      send_cap: payload.send_cap === undefined
        ? campaign.send_cap
        : parseInteger(payload.send_cap, campaign.send_cap, 1, config.maxRecipients),
      quiet_hours_start: validClock(payload.quiet_hours_start)
        ? payload.quiet_hours_start : campaign.quiet_hours_start,
      quiet_hours_end: validClock(payload.quiet_hours_end)
        ? payload.quiet_hours_end : campaign.quiet_hours_end,
      phone_capture_policy: payload.phone_capture_policy ?? campaign.phone_capture_policy,
      phone_capture_thank_you_text: payload.phone_capture_thank_you_text ?? campaign.phone_capture_thank_you_text,
      phone_capture_status_id: phoneCaptureStatusId,
      messages
    }, database);
  }

  static preview(campaignId, database = getDefaultDb(), options = {}) {
    let campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.NOT_FOUND, 'Không tìm thấy chiến dịch.');
    }
    if (!['draft', 'ready'].includes(campaign.status)) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.STATE_CONFLICT,
        'Chỉ có thể preview chiến dịch nháp hoặc đã sẵn sàng.'
      );
    }

    let validMessageCount = 0;
    for (const message of campaign.messages) {
      const validAttachments = message.attachments.filter(
        (attachment) => attachment.validation_status === 'valid' && fs.existsSync(attachment.storage_path)
      );
      const missingAttachment = message.attachments.find(
        (attachment) => attachment.validation_status !== 'valid' || !fs.existsSync(attachment.storage_path)
      );
      let error = null;
      if (missingAttachment) error = missingAttachment.validation_error || 'ATTACHMENT_UNAVAILABLE';
      if (validAttachments.length > 1) {
        // Spec 040: more than one physical attachment on a message is fine
        // as long as every one of them belongs to the SAME manifest (several
        // selected files, or one folder ZIP's member) - CampaignRunner only
        // ever dispatches one manifest per message. Anything else (no
        // manifest at all, or attachments split across more than one
        // manifest) is the actual invalid state this guard exists to catch.
        const manifestIds = new Set(validAttachments.map((attachment) => attachment.manifest_id).filter(Boolean));
        const hasUngroupedAttachment = validAttachments.some((attachment) => !attachment.manifest_id);
        if (manifestIds.size !== 1 || hasUngroupedAttachment) {
          error = error || 'ATTACHMENT_MANIFEST_REQUIRED';
        }
      }
      if (!normalizedText(message.text_content) && validAttachments.length === 0) {
        error = error || 'Tin nhắn cần có text hoặc attachment hợp lệ.';
      }
      CampaignRepository.setMessageValidation(
        message.id,
        error ? 'invalid' : 'valid',
        error,
        database
      );
      if (!error) validMessageCount += 1;
    }
    campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!validMessageCount || campaign.messages.some((item) => item.validation_status !== 'valid')) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.MESSAGE_INVALID,
        'Nội dung campaign chưa hợp lệ.',
        { invalid_messages: campaign.messages.filter((item) => item.validation_status !== 'valid').length }
      );
    }

    CampaignEligibilityService.assertAttachmentCapability(
      campaign.recipients,
      campaign.attachments,
      { imageEnabled: options.imageEnabled ?? this.getConfig().imageEnabled, fileEnabled: options.fileEnabled ?? this.getConfig().fileEnabled }
    );
    const eligible = campaign.recipients.filter((item) => item.eligibility_status === 'eligible');
    if (!eligible.length) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.NOT_READY,
        'Không có người nhận nào đủ điều kiện.',
        { ineligible_count: campaign.recipients.length }
      );
    }
    const start = campaign.recipients.find(
      (item) => item.selection_order === Number(campaign.start_position)
    );
    if (!start || start.eligibility_status !== 'eligible') {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.INVALID_ORDER,
        'Vị trí bắt đầu phải trỏ tới một người nhận đủ điều kiện.',
        { start_position: campaign.start_position }
      );
    }
    const ordered = eligible
      .filter((item) => campaign.direction === 'desc'
        ? item.selection_order <= start.selection_order
        : item.selection_order >= start.selection_order)
      .sort((left, right) => campaign.direction === 'desc'
        ? right.selection_order - left.selection_order
        : left.selection_order - right.selection_order);
    if (!ordered.length) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.INVALID_ORDER, 'Thứ tự đã chọn không có người nhận.');
    }
    if (ordered.length > Number(campaign.send_cap)) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED,
        'Số lượt gửi dự kiến vượt send cap của campaign.',
        { planned: ordered.length, send_cap: campaign.send_cap }
      );
    }
    CampaignRepository.setExecutionOrder(
      campaignId,
      ordered.map((item) => item.id),
      database,
      { actorUserId: campaign.created_by, actorType: 'operator' }
    );
    CampaignRepository.setCampaignReady(campaignId, database);
    return CampaignRepository.getCampaign(campaignId, database);
  }

  static assertTransition(campaignId, action, database = getDefaultDb()) {
    const campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.NOT_FOUND, 'Không tìm thấy chiến dịch.');
    }
    const allowed = {
      start: ['ready'],
      pause: ['running'],
      resume: ['paused'],
      cancel: ['running', 'pausing', 'paused'],
      retry: ['ready', 'paused', 'completed_with_errors', 'failed', 'cancelled']
    }[action] || [];
    if (!allowed.includes(campaign.status)) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.STATE_CONFLICT,
        'Không thể ' + action + ' ở trạng thái ' + campaign.status + '.',
        { status: campaign.status }
      );
    }
    return campaign;
  }

  static isWithinQuietHours(campaign, now = new Date()) {
    const start = campaign.quiet_hours_start || '00:00';
    const end = campaign.quiet_hours_end || '00:00';
    if (start === end) return false;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const toMinutes = (value) => {
      const [hour, minute] = value.split(':').map(Number);
      return hour * 60 + minute;
    };
    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    return startMinutes < endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  static validateReadyForStart(campaignId, database = getDefaultDb(), options = {}) {
    const campaign = this.assertTransition(campaignId, 'start', database);
    const config = { ...this.getConfig(), ...options };
    if (campaign.messages.some((message) => message.validation_status !== 'valid')) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.NOT_READY, 'Campaign cần preview hợp lệ trước khi chạy.');
    }
    const planned = campaign.recipients.filter(
      (recipient) => recipient.execution_order != null && recipient.status === 'pending'
    );
    if (config.testMode) {
      const unauthorized = planned.find((recipient) => !config.testSourceIds.includes(String(recipient.source_id)));
      if (!config.testSourceIds.length || unauthorized) {
        throw new CampaignError(
          CAMPAIGN_ERROR_CODES.SOURCE_UNAVAILABLE,
          'Test mode chỉ cho phép source nằm trong CAMPAIGN_TEST_SOURCE_IDS.'
        );
      }
    }
    if (!planned.length || planned.length > campaign.send_cap) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED, 'Execution order vượt giới hạn gửi.');
    }
    if (!config.testMode && campaign.pacing_ms < config.minimumPacingMs) {
      throw new CampaignError(
        CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED,
        'Pacing thấp hơn giới hạn vận hành.',
        { minimum_pacing_ms: config.minimumPacingMs }
      );
    }
    if (this.isWithinQuietHours(campaign, options.now || new Date())) {
      throw new CampaignError(CAMPAIGN_ERROR_CODES.QUIET_HOURS_ACTIVE, 'Campaign đang trong quiet hours.');
    }
    const accounts = [...new Set(planned.map((recipient) => recipient.account_id))];
    for (const accountId of accounts) {
      const sentToday = CampaignRepository.countAccountSentToday(accountId, database);
      const plannedForAccount = planned.filter((recipient) => recipient.account_id === accountId).length;
      if (sentToday + plannedForAccount > config.accountDailyCap) {
        throw new CampaignError(
          CAMPAIGN_ERROR_CODES.SEND_LIMIT_REACHED,
          'Account daily cap không đủ cho campaign.',
          { account_id: accountId, sent_today: sentToday, planned: plannedForAccount, cap: config.accountDailyCap }
        );
      }
    }
    return campaign;
  }
}

CampaignService.CampaignError = CampaignError;
CampaignService.CAMPAIGN_ROUTES = CAMPAIGN_ROUTES;
CampaignService.CAMPAIGN_EVENTS = CAMPAIGN_EVENTS;
CampaignService.CAMPAIGN_ERROR_CODES = CAMPAIGN_ERROR_CODES;
module.exports = CampaignService;
