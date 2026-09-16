const CampaignRouteService = require('./CampaignRouteService');

let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

class CampaignEligibilityService {
  static inspectThread(threadId, database = getDefaultDb(), options = {}) {
    return CampaignRouteService.inspectThreadRoute(threadId, database, options);
  }

  static inspectThreads(threadIds, database = getDefaultDb(), options = {}) {
    const uniqueIds = [...new Set(
      (threadIds || []).map((threadId) => String(threadId)).filter(Boolean)
    )];
    return uniqueIds.map((threadId) => this.inspectThread(threadId, database, options));
  }

  static revalidateSnapshotRecipient(recipient, database = getDefaultDb(), options = {}) {
    return CampaignRouteService.revalidateSnapshotRecipient(recipient, database, options);
  }

  static assertAttachmentCapability(recipients, attachments, { imageEnabled = false, fileEnabled = false, database = getDefaultDb() } = {}) {
    if (!attachments || attachments.length === 0) return true;
    const invalid = attachments.find((attachment) => attachment.validation_status !== 'valid');
    if (invalid) {
      const error = new Error(invalid.validation_error || 'Attachment ch?a h?p l?.');
      error.code = 'ATTACHMENT_INVALID';
      throw error;
    }
    const unsupported = attachments.find((attachment) => {
      if (attachment.media_type === 'image') return !imageEnabled && !fileEnabled;
      return !fileEnabled;
    });
    if (unsupported) {
      const error = new Error('Loại file này chưa được bật cho campaign transport.');
      error.code = 'ATTACHMENT_INVALID';
      throw error;
    }
    return true;
  }
}

module.exports = CampaignEligibilityService;
