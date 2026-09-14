/* global self */
// Pure validation for v2 queue envelopes. Keep this file free of Chrome APIs
// so the extension and Node regression tests enforce the same contract.
(function registerQueueEnvelopeValidation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FbCrmQueueEnvelopeValidation = api;
})(typeof self !== 'undefined' ? self : globalThis, () => {
  const SUPPORTED_SOURCE_TYPES = new Set(['personal_messenger', 'page_messenger']);
  const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-msvideo']);
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function validateQueuedEnvelope(payload = {}, { expectedAccountId = null } = {}) {
    if (Number(payload.contract_version) !== 2) return;

    const isCampaign = Boolean(payload.campaign_id);
    const prefix = isCampaign ? 'CAMPAIGN_CONTRACT' : 'RICH_CONTRACT';
    const requiredAttempt = isCampaign ? payload.campaign_attempt_id : payload.outbound_attempt_id;

    if (!payload.queue_id || !requiredAttempt || !payload.thread_id || !payload.account_id) {
      fail(`${prefix}_REQUIRED_FIELD`, 'Envelope queue v2 thiếu định danh bắt buộc.');
    }
    if (expectedAccountId != null && String(payload.account_id) !== String(expectedAccountId)) {
      fail('QUEUED_ACCOUNT_MISMATCH', 'Envelope queue không thuộc tài khoản extension hiện tại.');
    }
    if (!SUPPORTED_SOURCE_TYPES.has(payload.source_type) || !payload.source_id) {
      fail(`${prefix}_SOURCE_INVALID`, 'Nguồn gửi trong envelope queue không hợp lệ.');
    }
    if (payload.source_type === 'page_messenger' && !payload.page_id) {
      fail(`${prefix}_PAGE_REQUIRED`, 'Envelope Page thiếu page_id.');
    }
    if (payload.source_type === 'personal_messenger' && payload.page_id != null) {
      fail(`${prefix}_PERSONAL_PAGE_FORBIDDEN`, 'Envelope Messenger cá nhân không được mang page_id.');
    }
    const hasManifest = Array.isArray(payload.attachment_manifest);
    if (!payload.attachment && !hasManifest && !String(payload.content || '').trim()) {
      fail(`${prefix}_EMPTY`, 'Envelope queue không có nội dung.');
    }

    if (hasManifest) {
      // Spec 040: several independently-selected files, or one folder ZIP,
      // dispatched together in one send. Every member is validated the same
      // way a lone attachment would be - no relaxed rules just because it's
      // part of a group.
      if (payload.attachment_manifest.length === 0) {
        fail(`${prefix}_ATTACHMENT_MANIFEST_EMPTY`, 'Manifest không có file nào.');
      }
      payload.attachment_manifest.forEach((item) => validateAttachmentItem(item, prefix));
      return;
    }

    if (!payload.attachment) return;
    validateAttachmentItem(payload.attachment, prefix);
  }

  function validateAttachmentItem(attachment, prefix) {
    const isImage = attachment.media_type === 'image' && SUPPORTED_IMAGE_TYPES.has(attachment.mime_type);
    const isVideo = attachment.media_type === 'video' && SUPPORTED_VIDEO_TYPES.has(attachment.mime_type);
    const isGenericFile = attachment.media_type === 'file' && typeof attachment.mime_type === 'string' && attachment.mime_type.length > 0;
    if (!isImage && !isVideo && !isGenericFile) {
      fail(`${prefix}_ATTACHMENT_UNSUPPORTED`, 'Attachment chưa được hỗ trợ cho nguồn gửi này.');
    }
    if (
      !attachment.id || !attachment.name || !attachment.local_path ||
      !Number.isSafeInteger(Number(attachment.byte_size)) ||
      Number(attachment.byte_size) <= 0 || Number(attachment.byte_size) > MAX_FILE_BYTES ||
      /^[a-f0-9]{64}$/.test(String(attachment.checksum_sha256 || '')) === false
    ) {
      fail(`${prefix}_ATTACHMENT_INVALID`, 'Metadata attachment không hợp lệ.');
    }
  }

  return { validateQueuedEnvelope };
});
