const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const FILE_MIME_TYPES = Object.freeze([
  'application/pdf', 'text/plain', 'text/csv', 'application/json', 'application/xml',
  'text/html', 'text/markdown', 'application/zip', 'application/vnd.rar',
  'application/x-7z-compressed', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'audio/mpeg', 'audio/wav', 'video/mp4', 'video/quicktime', 'video/x-msvideo'
]);

class RichMessageCapabilityError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'RichMessageCapabilityError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class RichMessageCapabilityService {
  static getConfig() {
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

  static getForThread(threadId, {
    database = require('../database/db'),
    getConnection = () => null,
    config = this.getConfig()
  } = {}) {
    const route = database.prepare(
      "SELECT t.id AS thread_id, t.account_id, COALESCE(t.source_id, 'personal:' || t.account_id) AS source_id, " +
      "COALESCE(s.source_type, 'personal_messenger') AS source_type, " +
      "CASE WHEN s.source_type = 'page_messenger' THEN s.external_id ELSE NULL END AS page_id, " +
      "COALESCE(s.status, 'ACTIVE') AS source_status, COALESCE(a.status, 'ACTIVE') AS account_status " +
      'FROM threads t LEFT JOIN inbox_sources s ON s.id = t.source_id ' +
      'LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?'
    ).get(threadId);

    if (!route) {
      throw new RichMessageCapabilityError('THREAD_NOT_FOUND', 'Không tìm thấy hội thoại.', 404);
    }

    const connection = getConnection(route.account_id);
    const connected = Boolean(connection && connection.readyState === 1);
    const sourceReady = route.source_status === 'ACTIVE' && route.account_status === 'ACTIVE';
    const featureReady = config.enabled !== false;
    const textEnabled = featureReady && sourceReady && connected;
    const adapter = config.adapters?.[route.source_type] || {};
    const imageEnabled = textEnabled && adapter.image === true;
    const fileEnabled = textEnabled && adapter.file === true;
    let disabledReason = null;
    if (!featureReady) disabledReason = 'Tính năng gửi rich-message đang tắt.';
    else if (!sourceReady) disabledReason = 'Nguồn gửi chưa ở trạng thái hoạt động.';
    else if (!connected) disabledReason = 'Extension của nguồn gửi chưa kết nối.';

    return {
      thread_id: route.thread_id,
      account_id: route.account_id,
      source_id: route.source_id,
      source_type: route.source_type,
      page_id: route.page_id,
      connected,
      contract_version: 2,
      adapter_version: 'rich-message-v1',
      text: { enabled: textEnabled },
      emoji: { enabled: textEnabled, quick_like: '👍' },
      image: {
        enabled: imageEnabled,
        mime_types: imageEnabled ? [...IMAGE_MIME_TYPES] : [],
        max_bytes: Number(config.maxBytes) || DEFAULT_MAX_BYTES
      },
      file: {
        enabled: fileEnabled,
        mime_types: fileEnabled ? [...FILE_MIME_TYPES] : [],
        max_bytes: Number(config.maxBytes) || DEFAULT_MAX_BYTES
      },
      disabled_reason: disabledReason
    };
  }

  static allowedMimeTypes(capability) {
    return [
      ...(capability?.image?.enabled ? capability.image.mime_types : []),
      ...(capability?.file?.enabled ? capability.file.mime_types : [])
    ];
  }
}

RichMessageCapabilityService.Error = RichMessageCapabilityError;
RichMessageCapabilityService.DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
RichMessageCapabilityService.IMAGE_MIME_TYPES = IMAGE_MIME_TYPES;
RichMessageCapabilityService.FILE_MIME_TYPES = FILE_MIME_TYPES;
module.exports = RichMessageCapabilityService;
