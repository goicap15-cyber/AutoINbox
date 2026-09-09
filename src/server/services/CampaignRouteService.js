let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../database/db');
  return defaultDb;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

class CampaignRouteService {
  static getRichConfig() {
    return {
      enabled: process.env.RICH_MESSAGE_ENABLED !== 'false',
      maxBytes: Number(process.env.RICH_MESSAGE_MAX_BYTES) || DEFAULT_MAX_BYTES,
      adapters: {
        page_messenger: {
          image: process.env.RICH_MESSAGE_PAGE_IMAGE_ENABLED !== 'false',
          file: process.env.RICH_MESSAGE_PAGE_FILE_ENABLED !== 'false'
        },
        personal_messenger: {
          image: process.env.RICH_MESSAGE_PERSONAL_IMAGE_ENABLED !== 'false',
          file: process.env.RICH_MESSAGE_PERSONAL_FILE_ENABLED !== 'false'
        }
      }
    };
  }

  static getCampaignConfig() {
    try {
      const CampaignService = require('./CampaignService');
      return CampaignService.getConfig();
    } catch {
      return {
        enabled: process.env.CAMPAIGN_FEATURE_ENABLED !== 'false',
        imageEnabled: process.env.CAMPAIGN_IMAGE_ENABLED !== 'false',
        fileEnabled: process.env.CAMPAIGN_FILE_ENABLED !== 'false'
      };
    }
  }

  static inspectThreadRoute(threadId, database = getDefaultDb(), {
    getConnection = null,
    campaignConfig = null,
    richConfig = null
  } = {}) {
    const thread = database.prepare(`
      SELECT t.id AS thread_id, t.account_id, t.source_id,
             a.status AS account_status, a.name AS account_name,
             s.source_type, s.external_id AS source_external_id,
             s.display_name AS source_display_name, s.status AS source_status,
             COALESCE(c.campaign_opt_out, 0) AS campaign_opt_out
      FROM threads t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN inbox_sources s ON s.id = t.source_id
      LEFT JOIN contacts c ON c.thread_id = t.id
      WHERE t.id = ?
    `).get(threadId);

    if (!thread) {
      return {
        thread_id: String(threadId),
        account_id: null,
        source_id: null,
        source_type: null,
        source_external_id: null,
        source_display_name: null,
        source_name: null,
        eligibility_status: 'invalid_route',
        eligibility_reason: 'THREAD_NOT_FOUND',
        reason_message: 'Không tìm thấy hội thoại.',
        capabilities: { text: false, image: false }
      };
    }

    if (thread.campaign_opt_out) {
      return {
        ...thread,
        source_name: thread.source_display_name || thread.account_name || 'Khách hàng',
        eligibility_status: 'opted_out',
        eligibility_reason: 'CONTACT_OPTED_OUT',
        reason_message: 'Khách hàng đã từ chối nhận tin nhắn chiến dịch.',
        capabilities: { text: false, image: false }
      };
    }

    if (!thread.account_id || !thread.account_status) {
      return {
        ...thread,
        source_name: thread.source_display_name || 'Không xác định',
        eligibility_status: 'invalid_route',
        eligibility_reason: 'ACCOUNT_NOT_FOUND',
        reason_message: 'Không tìm thấy tài khoản sở hữu hội thoại.',
        capabilities: { text: false, image: false }
      };
    }

    // Resolve effective source type
    const effectiveSourceType = thread.source_type || 'personal_messenger';
    const effectiveSourceId = thread.source_id || ('personal:' + thread.account_id);
    const effectiveSourceName = thread.source_display_name || (
      effectiveSourceType === 'page_messenger' ? 'Facebook Page' : (thread.account_name || 'Messenger cá nhân')
    );
    const effectiveSourceExternalId = effectiveSourceType === 'page_messenger'
      ? (thread.source_external_id || null)
      : null;
    const effectiveSourceStatus = thread.source_status || 'ACTIVE';

    if (!['page_messenger', 'personal_messenger'].includes(effectiveSourceType)) {
      return {
        ...thread,
        source_id: effectiveSourceId,
        source_type: effectiveSourceType,
        source_external_id: effectiveSourceExternalId,
        source_display_name: effectiveSourceName,
        source_name: effectiveSourceName,
        eligibility_status: 'unsupported',
        eligibility_reason: 'UNSUPPORTED_SOURCE_TYPE',
        reason_message: 'Loại nguồn hội thoại không được hỗ trợ cho chiến dịch.',
        capabilities: { text: false, image: false }
      };
    }

    if (effectiveSourceType === 'page_messenger' && !effectiveSourceExternalId) {
      return {
        ...thread,
        source_id: effectiveSourceId,
        source_type: effectiveSourceType,
        source_external_id: null,
        source_display_name: effectiveSourceName,
        source_name: effectiveSourceName,
        eligibility_status: 'invalid_route',
        eligibility_reason: 'SOURCE_NOT_FOUND',
        reason_message: 'Nguồn Page thiếu Page ID hợp lệ.',
        capabilities: { text: false, image: false }
      };
    }

    if (thread.account_status !== 'ACTIVE') {
      return {
        ...thread,
        source_id: effectiveSourceId,
        source_type: effectiveSourceType,
        source_external_id: effectiveSourceExternalId,
        source_display_name: effectiveSourceName,
        source_name: effectiveSourceName,
        eligibility_status: 'invalid_route',
        eligibility_reason: 'ACCOUNT_NOT_ACTIVE',
        reason_message: 'Tài khoản quản lý chưa ở trạng thái hoạt động.',
        capabilities: { text: false, image: false }
      };
    }

    if (effectiveSourceStatus !== 'ACTIVE') {
      return {
        ...thread,
        source_id: effectiveSourceId,
        source_type: effectiveSourceType,
        source_external_id: effectiveSourceExternalId,
        source_display_name: effectiveSourceName,
        source_name: effectiveSourceName,
        eligibility_status: 'ineligible',
        eligibility_reason: 'SOURCE_NOT_ACTIVE',
        reason_message: 'Nguồn gửi chưa ở trạng thái hoạt động.',
        capabilities: { text: false, image: false }
      };
    }

    // Resolve capabilities
    const rConfig = richConfig || this.getRichConfig();
    const cConfig = campaignConfig || this.getCampaignConfig();

    const connectionChecked = typeof getConnection === "function";
    const connection = connectionChecked ? getConnection(thread.account_id) : null;
    const isConnected = connectionChecked ? Boolean(connection && connection.readyState === 1) : null;

    if (connectionChecked && !isConnected) {
      const isPersonal = effectiveSourceType === "personal_messenger";
      return {
        thread_id: String(thread.thread_id),
        account_id: String(thread.account_id),
        source_id: String(effectiveSourceId),
        source_type: effectiveSourceType,
        source_external_id: effectiveSourceExternalId,
        source_display_name: effectiveSourceName,
        source_name: effectiveSourceName,
        account_status: thread.account_status,
        source_status: effectiveSourceStatus,
        campaign_opt_out: 0,
        connected: false,
        eligibility_status: "ineligible",
        eligibility_reason: isPersonal ? "PERSONAL_SOURCE_NOT_CONNECTED" : "PAGE_SOURCE_NOT_CONNECTED",
        reason_message: isPersonal
          ? "Messenger cá nhân của nguồn này chưa kết nối."
          : "Facebook Page của nguồn này chưa kết nối.",
        capabilities: { text: false, image: false }
      };
    }

    const textEnabled = thread.account_status === 'ACTIVE' && effectiveSourceStatus === 'ACTIVE';
    const adapterImage = rConfig.adapters?.[effectiveSourceType]?.image === true;
    const campaignImage = cConfig.imageEnabled !== false;
    const imageEnabled = textEnabled && adapterImage && campaignImage;
    // Kept independent from imageEnabled on purpose (spec 040 FR-018): a
    // source may have image capability live-verified while file capability
    // has not, so RICH_MESSAGE_*_FILE_ENABLED must gate file attachments on
    // its own, never fall back to the image flag.
    const adapterFile = rConfig.adapters?.[effectiveSourceType]?.file === true;
    const campaignFile = cConfig.fileEnabled === true;
    const fileEnabled = textEnabled && adapterFile && campaignFile;

    return {
      thread_id: String(thread.thread_id),
      account_id: String(thread.account_id),
      source_id: String(effectiveSourceId),
      source_type: effectiveSourceType,
      source_external_id: effectiveSourceExternalId,
      source_display_name: effectiveSourceName,
      source_name: effectiveSourceName,
      account_status: thread.account_status,
      source_status: effectiveSourceStatus,
      campaign_opt_out: 0,
      connected: isConnected,
      eligibility_status: 'eligible',
      eligibility_reason: null,
      reason_message: null,
      capabilities: {
        text: textEnabled,
        image: imageEnabled,
        file: fileEnabled
      }
    };
  }

  static revalidateSnapshotRecipient(recipient, database = getDefaultDb(), {
    getConnection = null,
    hasAttachment = false,
    attachmentMediaType = null,
    campaignConfig = null,
    richConfig = null
  } = {}) {
    const current = this.inspectThreadRoute(recipient.thread_id, database, {
      getConnection,
      campaignConfig,
      richConfig
    });

    if (current.eligibility_status !== 'eligible') {
      const error = new Error(current.reason_message || current.eligibility_reason || 'INVALID_RECIPIENT');
      error.code = current.eligibility_reason || 'INVALID_RECIPIENT';
      throw error;
    }

    // Verify account and source matches snapshot
    if (
      String(current.account_id) !== String(recipient.account_id) ||
      (recipient.source_id && String(current.source_id) !== String(recipient.source_id))
    ) {
      const error = new Error('Route nguồn/tài khoản đã thay đổi sau khi tạo snapshot.');
      error.code = 'SOURCE_UNAVAILABLE';
      throw error;
    }

    // If recipient has snapshot fields, verify them strictly
    const expectedSourceType = recipient.source_type_snapshot || recipient.source_type;
    if (expectedSourceType && current.source_type !== expectedSourceType) {
      const error = new Error('Loại nguồn gửi đã thay đổi sau khi tạo snapshot.');
      error.code = 'SOURCE_UNAVAILABLE';
      throw error;
    }

    if (expectedSourceType === 'page_messenger') {
      const expectedExternalId = recipient.source_external_id_snapshot || recipient.page_id;
      if (expectedExternalId && current.source_external_id !== expectedExternalId) {
        const error = new Error('Page ID đã thay đổi sau khi tạo snapshot.');
        error.code = 'SOURCE_UNAVAILABLE';
        throw error;
      }
    }

    // Check attachment capability if message has attachment. A file
    // attachment (spec 040) MUST be gated by its own capabilities.file, never
    // by capabilities.image - RICH_MESSAGE_*_IMAGE_ENABLED being on must not
    // silently let a file attachment through a source whose *_FILE_ENABLED
    // flag is still off (FR-018: personal file stays disabled independently
    // of personal image until separately live-verified).
    if (hasAttachment) {
      const isFileAttachment = attachmentMediaType === 'file';
      if (!current.capabilities[isFileAttachment ? 'file' : 'image']) {
        const error = new Error(
          current.source_type === 'personal_messenger'
            ? `Messenger cá nhân của nguồn này chưa hỗ trợ gửi ${isFileAttachment ? 'file' : 'hình ảnh'} đính kèm.`
            : `Nguồn gửi này chưa hỗ trợ gửi ${isFileAttachment ? 'file' : 'hình ảnh'} đính kèm.`
        );
        error.code = 'ATTACHMENT_INVALID';
        throw error;
      }
    }

    return current;
  }

  static getSourceCounts(recipients = []) {
    let pageCount = 0;
    let personalCount = 0;
    for (const r of recipients) {
      const type = r.source_type_snapshot || r.source_type;
      if (type === 'personal_messenger') {
        personalCount++;
      } else {
        pageCount++;
      }
    }
    return {
      page_messenger: pageCount,
      personal_messenger: personalCount,
      total: recipients.length
    };
  }
}

CampaignRouteService.IMAGE_MIME_TYPES = IMAGE_MIME_TYPES;
CampaignRouteService.DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;

module.exports = CampaignRouteService;
