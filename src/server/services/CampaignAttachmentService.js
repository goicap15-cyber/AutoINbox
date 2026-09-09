const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const CampaignRepository = require('../repositories/CampaignRepository');
const {
  detectMimeType,
  validateAttachment,
  buildStoragePath,
  validateZipArchiveEntries,
  isSafeArchiveEntryPath,
  sanitizeFilename,
  checksumSha256
} = require('./attachmentValidation');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

class AttachmentError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'AttachmentError';
    this.code = 'ATTACHMENT_INVALID';
    this.details = details;
  }
}

function toCampaignAttachmentError(error) {
  const messages = {
    ATTACHMENT_EMPTY: 'File rỗng hoặc không đọc được.',
    ATTACHMENT_TOO_LARGE: 'File vượt giới hạn dung lượng.',
    ATTACHMENT_TYPE_MISMATCH: 'Loại file hoặc chữ ký file không được hỗ trợ.',
    ATTACHMENT_UNSUPPORTED: 'Loại file hoặc chữ ký file không được hỗ trợ.',
    ATTACHMENT_CORRUPT: 'Loại file hoặc chữ ký file không được hỗ trợ.',
    ATTACHMENT_EXECUTABLE_RISK: 'File thực thi hoặc có rủi ro bảo mật không được phép.',
    ATTACHMENT_UNSAFE_PATH: 'Đường dẫn lưu attachment không hợp lệ.',
    ATTACHMENT_STORAGE_INVALID: 'Không thể tạo đường dẫn lưu attachment.',
    ATTACHMENT_ARCHIVE_UNSAFE: 'Thư mục/file nén chứa đường dẫn hoặc symlink không an toàn.'
  };
  return new AttachmentError(
    messages[error?.code] || error?.message || 'Attachment không hợp lệ.',
    error?.details || null
  );
}

class CampaignAttachmentService {
  static getDefaultStorageDir() {
    return path.join(APP_DATA_ROOT, 'campaign-attachments');
  }

  static parseMultipartBody(buffer, contentType) {
    if (!Buffer.isBuffer(buffer)) throw new AttachmentError('Multipart body không hợp lệ.');
    const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
    if (!boundary) throw new AttachmentError('Thiếu multipart boundary.');
    const source = buffer.toString('latin1');
    const delimiter = '--' + boundary;
    const fields = {};
    const files = [];

    for (const rawPart of source.split(delimiter)) {
      if (!rawPart || rawPart === '--\r\n' || rawPart === '--') continue;
      const part = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '').replace(/--$/, '');
      const separator = part.indexOf('\r\n\r\n');
      if (separator < 0) continue;
      const headerText = part.slice(0, separator);
      let bodyText = part.slice(separator + 4);
      if (bodyText.endsWith('\r\n')) bodyText = bodyText.slice(0, -2);
      const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disposition.match(/name="([^"]+)"/i)?.[1];
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
      const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (!name) continue;
      if (filename !== undefined) {
        files.push({
          fieldName: name,
          originalName: filename,
          declaredMimeType: mimeType || 'application/octet-stream',
          buffer: Buffer.from(bodyText, 'latin1')
        });
      } else {
        fields[name] = Buffer.from(bodyText, 'latin1').toString('utf8');
      }
    }
    if (!files.length) throw new AttachmentError('Thiếu file upload.');
    return { fields, file: files[0], files };
  }

  static saveUpload({
    campaignId,
    campaignMessageId,
    originalName,
    declaredMimeType,
    buffer,
    manifestId = null
  }, {
    database = require('../database/db'),
    storageDir = this.getDefaultStorageDir(),
    imageEnabled = process.env.CAMPAIGN_IMAGE_ENABLED !== 'false',
    fileEnabled = process.env.CAMPAIGN_FILE_ENABLED !== 'false',
    maxBytes = DEFAULT_MAX_IMAGE_BYTES,
    allowAnyFile = fileEnabled
  } = {}) {
    const campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) throw new AttachmentError('Không tìm thấy campaign.');
    if (!['draft', 'ready'].includes(campaign.status)) {
      throw new AttachmentError('Không thể thay attachment sau khi campaign đã chạy.');
    }
    const message = campaign.messages.find((item) => item.id === campaignMessageId);
    if (!message) throw new AttachmentError('Campaign message không hợp lệ.');
    if (!imageEnabled && !fileEnabled) {
      throw new AttachmentError('Campaign attachment transport đang tắt.');
    }

    let validated;
    try {
      validated = validateAttachment({
        buffer,
        originalName,
        declaredMimeType,
        allowedMimeTypes: fileEnabled ? undefined : ALLOWED_IMAGE_MIME_TYPES,
        maxBytes,
        allowAnyFile,
        rejectExecutable: true
      });
    } catch (error) {
      throw toCampaignAttachmentError(error);
    }

    const existing = database.prepare(`
      SELECT * FROM campaign_attachments
      WHERE campaign_message_id = ? AND checksum = ?
    `).get(campaignMessageId, validated.checksum);
    if (existing) return existing;

    fs.mkdirSync(storageDir, { recursive: true });
    let storagePath;
    try {
      storagePath = buildStoragePath(storageDir, validated.checksum, validated.mimeType);
    } catch (error) {
      throw toCampaignAttachmentError(error);
    }
    if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, buffer, { flag: 'wx' });

    const attachment = CampaignRepository.insertAttachment({
      campaign_message_id: campaignMessageId,
      manifest_id: manifestId,
      media_type: validated.mediaType,
      original_name: validated.safeName,
      mime_type: validated.mimeType,
      byte_size: validated.byteSize,
      storage_path: storagePath,
      checksum: validated.checksum,
      validation_status: 'valid',
      validation_error: null
    }, database);
    CampaignRepository.updateCampaignStatus(campaignId, 'ready', 'draft', database);
    CampaignRepository.setMessageValidation(campaignMessageId, 'pending', null, database);
    CampaignRepository.addAudit(
      campaignId,
      'attachment_added',
      {
        attachment_id: attachment.id,
        mime_type: attachment.mime_type,
        byte_size: attachment.byte_size
      },
      null,
      database,
      { actorUserId: campaign.created_by, actorType: 'operator' }
    );
    return attachment;
  }

  // Spec 040 FR-003/FR-009: multiple independently-selected files (not a
  // folder) still travel as one manifest, so preview/dispatch/UI have one
  // grouping to reason about instead of N unrelated attachment rows. A
  // single file needs no manifest - kept identical to spec 039's behavior.
  static saveUploads({ campaignId, campaignMessageId, files = [] }, options = {}) {
    if (!Array.isArray(files) || files.length === 0) throw new AttachmentError('Thiếu file upload.');
    const database = options.database || require('../database/db');
    const saved = [];
    const transaction = database.transaction(() => {
      let manifestId = null;
      if (files.length > 1) {
        const manifest = CampaignRepository.insertManifest({
          campaign_message_id: campaignMessageId,
          kind: 'files',
          item_count: files.length,
          total_bytes: files.reduce((sum, file) => sum + (Buffer.isBuffer(file.buffer) ? file.buffer.length : 0), 0)
        }, database);
        manifestId = manifest.id;
      }
      for (const file of files) {
        saved.push(this.saveUpload({ campaignId, campaignMessageId, manifestId, ...file }, options));
      }
    });
    transaction();
    return saved;
  }

  // Spec 040 FR-002: packages a folder selection's permitted files into one
  // ZIP attachment, preserving relative paths. `files` entries carry
  // `relativePath` (the browser's webkitRelativePath for a directory input).
  // Rejects the WHOLE folder on the first unsafe/invalid file rather than
  // silently dropping it, so the operator sees one clear error instead of an
  // unexpectedly incomplete archive (plan.md Architecture Decision 3).
  static async saveFolderAsZip({
    campaignId,
    campaignMessageId,
    archiveName,
    files = []
  }, {
    database = require('../database/db'),
    storageDir = this.getDefaultStorageDir(),
    fileEnabled = process.env.CAMPAIGN_FILE_ENABLED === 'true',
    maxBytes = require('./attachmentValidation').DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = require('./attachmentValidation').DEFAULT_MAX_FILE_BYTES * 20
  } = {}) {
    if (!Array.isArray(files) || files.length === 0) throw new AttachmentError('Thư mục không có file hợp lệ để gửi.');
    const campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) throw new AttachmentError('Không tìm thấy campaign.');
    if (!['draft', 'ready'].includes(campaign.status)) {
      throw new AttachmentError('Không thể thay attachment sau khi campaign đã chạy.');
    }
    const message = campaign.messages.find((item) => item.id === campaignMessageId);
    if (!message) throw new AttachmentError('Campaign message không hợp lệ.');
    if (!fileEnabled) throw new AttachmentError('Campaign file transport đang tắt.');

    let totalBytes = 0;
    const safeEntries = [];
    for (const file of files) {
      if (!isSafeArchiveEntryPath(file.relativePath)) {
        throw new AttachmentError('Thư mục chứa đường dẫn không an toàn: ' + file.relativePath, { relative_path: file.relativePath });
      }
      let validated;
      try {
        validated = validateAttachment({
          buffer: file.buffer,
          originalName: path.basename(file.relativePath),
          declaredMimeType: file.declaredMimeType,
          allowAnyFile: true,
          maxBytes,
          rejectExecutable: true
        });
      } catch (error) {
        throw toCampaignAttachmentError(error);
      }
      totalBytes += validated.byteSize;
      if (totalBytes > maxTotalBytes) {
        throw new AttachmentError('Tổng dung lượng thư mục vượt giới hạn cho phép.', { maximum_bytes: maxTotalBytes });
      }
      safeEntries.push({ relativePath: file.relativePath, buffer: file.buffer });
    }

    const zipBuffer = await this.buildZipBuffer(safeEntries);
    await validateZipArchiveEntries(zipBuffer, { maxUncompressedBytes: maxTotalBytes });
    const checksum = checksumSha256(zipBuffer);

    const existing = database.prepare(`
      SELECT * FROM campaign_attachments
      WHERE campaign_message_id = ? AND checksum = ?
    `).get(campaignMessageId, checksum);
    if (existing) return existing;

    fs.mkdirSync(storageDir, { recursive: true });
    const storagePath = buildStoragePath(storageDir, checksum, 'application/zip');
    if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, zipBuffer, { flag: 'wx' });

    const safeArchiveName = sanitizeFilename(archiveName || 'folder.zip');
    const transaction = database.transaction(() => {
      const manifest = CampaignRepository.insertManifest({
        campaign_message_id: campaignMessageId,
        kind: 'folder_zip',
        item_count: files.length,
        total_bytes: totalBytes,
        archive_name: safeArchiveName
      }, database);
      const attachment = CampaignRepository.insertAttachment({
        campaign_message_id: campaignMessageId,
        manifest_id: manifest.id,
        media_type: 'file',
        original_name: safeArchiveName,
        mime_type: 'application/zip',
        byte_size: zipBuffer.length,
        storage_path: storagePath,
        checksum,
        validation_status: 'valid',
        validation_error: null
      }, database);
      CampaignRepository.updateCampaignStatus(campaignId, 'ready', 'draft', database);
      CampaignRepository.setMessageValidation(campaignMessageId, 'pending', null, database);
      CampaignRepository.addAudit(
        campaignId,
        'attachment_added',
        { attachment_id: attachment.id, mime_type: attachment.mime_type, byte_size: attachment.byte_size, manifest_kind: 'folder_zip', item_count: files.length },
        null,
        database,
        { actorUserId: campaign.created_by, actorType: 'operator' }
      );
      return attachment;
    });
    return transaction();
  }

  // Streams a ZIP archive of the given { relativePath, buffer } entries into
  // memory. Used only for folder selections, where entries are already
  // validated one-by-one before this is called - this function trusts its
  // input and only handles the archiving mechanics.
  static buildZipBuffer(entries) {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks = [];
      archive.on('data', (chunk) => chunks.push(chunk));
      archive.on('warning', (warning) => { if (warning.code !== 'ENOENT') reject(warning); });
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      for (const entry of entries) {
        archive.append(entry.buffer, { name: entry.relativePath.replace(/\\/g, '/') });
      }
      archive.finalize();
    });
  }

  static removeAttachment(campaignId, attachmentId, {
    database = require('../database/db')
  } = {}) {
    const campaign = CampaignRepository.getCampaign(campaignId, database);
    if (!campaign) throw new AttachmentError('Không tìm thấy campaign.');
    if (!['draft', 'ready'].includes(campaign.status)) {
      throw new AttachmentError('Không thể xóa attachment sau khi campaign đã chạy.');
    }
    const attachment = campaign.attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new AttachmentError('Không tìm thấy attachment.');
    const removed = CampaignRepository.deleteAttachment(attachmentId, database);
    const references = database.prepare(
      'SELECT COUNT(*) AS count FROM campaign_attachments WHERE storage_path = ?'
    ).get(removed.storage_path).count;
    if (references === 0 && fs.existsSync(removed.storage_path)) fs.unlinkSync(removed.storage_path);
    // Spec 040: removing the last member of a manifest must not leave an
    // empty manifest row behind - CampaignRunner picks messages.manifests[0]
    // for dispatch, so a stale empty manifest could otherwise be selected
    // over a genuinely populated one and fail the whole send with
    // ATTACHMENT_MANIFEST_EMPTY.
    if (removed.manifest_id) {
      const remainingInManifest = database.prepare(
        'SELECT COUNT(*) AS count FROM campaign_attachments WHERE manifest_id = ?'
      ).get(removed.manifest_id).count;
      if (remainingInManifest === 0) {
        database.prepare('DELETE FROM campaign_attachment_manifests WHERE id = ?').run(removed.manifest_id);
      }
    }
    CampaignRepository.updateCampaignStatus(campaignId, 'ready', 'draft', database);
    CampaignRepository.setMessageValidation(removed.campaign_message_id, 'pending', null, database);
    CampaignRepository.addAudit(
      campaignId,
      'attachment_removed',
      { attachment_id: attachmentId },
      null,
      database,
      { actorUserId: campaign.created_by, actorType: 'operator' }
    );
    return removed;
  }

  static resolveContent(attachmentId, database = require('../database/db')) {
    const attachment = CampaignRepository.getAttachment(attachmentId, database);
    if (!attachment || attachment.validation_status !== 'valid') return null;
    if (!fs.existsSync(attachment.storage_path)) {
      database.prepare(`
        UPDATE campaign_attachments
        SET validation_status = 'unavailable', validation_error = 'FILE_MISSING'
        WHERE id = ?
      `).run(attachmentId);
      return null;
    }
    return attachment;
  }
}

CampaignAttachmentService.AttachmentError = AttachmentError;
CampaignAttachmentService.DEFAULT_MAX_IMAGE_BYTES = DEFAULT_MAX_IMAGE_BYTES;
CampaignAttachmentService.DEFAULT_MAX_FILE_BYTES = require('./attachmentValidation').DEFAULT_MAX_FILE_BYTES;
CampaignAttachmentService.detectMimeType = detectMimeType;
module.exports = CampaignAttachmentService;
