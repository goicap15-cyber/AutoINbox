const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CampaignAttachmentService = require('./CampaignAttachmentService');
const RichMessageCapabilityService = require('./RichMessageCapabilityService');
const OutboundAttachmentRepository = require('../repositories/OutboundAttachmentRepository');
const {
  validateAttachment,
  buildStoragePath,
  assertSafePath,
  AttachmentValidationError
} = require('./attachmentValidation');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

const STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;

class OutboundAttachmentError extends Error {
  constructor(code, message, httpStatus = 400, details = null) {
    super(message);
    this.name = 'OutboundAttachmentError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function mapValidationError(error) {
  if (!(error instanceof AttachmentValidationError) && !error?.code) return error;
  const statusByCode = {
    ATTACHMENT_TOO_LARGE: 413,
    ATTACHMENT_CORRUPT: 422,
    ATTACHMENT_UNSAFE_PATH: 500,
    ATTACHMENT_STORAGE_INVALID: 500
  };
  return new OutboundAttachmentError(
    error.code,
    error.message,
    statusByCode[error.code] || 400,
    error.details || null
  );
}

class OutboundAttachmentService {
  static getDefaultStorageDir() {
    return path.join(APP_DATA_ROOT, 'outbound-attachments');
  }

  static parseMultipartBody(buffer, contentType) {
    try {
      return CampaignAttachmentService.parseMultipartBody(buffer, contentType);
    } catch (error) {
      throw new OutboundAttachmentError(
        error.code || 'ATTACHMENT_INVALID_MULTIPART',
        error.message || 'Multipart body không hợp lệ.',
        400
      );
    }
  }

  static stageUpload({
    threadId,
    createdBy = null,
    originalName,
    declaredMimeType,
    buffer
  }, {
    database = require('../database/db'),
    storageDir = this.getDefaultStorageDir(),
    capabilityOptions = {}
  } = {}) {
    const capability = RichMessageCapabilityService.getForThread(threadId, {
      ...capabilityOptions,
      database
    });
    if (!capability.connected) {
      throw new OutboundAttachmentError('SOURCE_DISCONNECTED', capability.disabled_reason, 409);
    }

    const allowedMimeTypes = RichMessageCapabilityService.allowedMimeTypes(capability);
    let validated;
    try {
      validated = validateAttachment({
        buffer,
        originalName,
        declaredMimeType,
        allowedMimeTypes,
        maxBytes: Math.min(capability.image.max_bytes, capability.file.max_bytes),
        enforceExtension: true
      });
    } catch (error) {
      throw mapValidationError(error);
    }

    fs.mkdirSync(storageDir, { recursive: true });
    let storagePath;
    try {
      storagePath = buildStoragePath(storageDir, validated.checksum, validated.mimeType);
      if (!fs.existsSync(storagePath)) {
        try {
          fs.writeFileSync(storagePath, buffer, { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
    } catch (error) {
      throw mapValidationError(error);
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + STAGED_RETENTION_MS).toISOString();
    try {
      return OutboundAttachmentRepository.create({
        id,
        thread_id: threadId,
        created_by: createdBy,
        original_name: String(originalName || validated.safeName),
        safe_name: validated.safeName,
        media_type: validated.mediaType,
        mime_type: validated.mimeType,
        byte_size: validated.byteSize,
        storage_path: storagePath,
        checksum_sha256: validated.checksum,
        expires_at: expiresAt
      }, database);
    } catch (error) {
      if (OutboundAttachmentRepository.countLiveStorageReferences(storagePath, null, database) === 0) {
        try { fs.unlinkSync(storagePath); } catch (unlinkError) {}
      }
      throw error;
    }
  }

  static discard(threadId, attachmentId, createdBy = null, {
    database = require('../database/db'),
    storageDir = this.getDefaultStorageDir()
  } = {}) {
    const attachment = OutboundAttachmentRepository.getForThread(attachmentId, threadId, database);
    if (!attachment) return false;
    const discarded = OutboundAttachmentRepository.discardStaged(
      attachmentId,
      threadId,
      createdBy,
      database
    );
    if (!discarded) return false;

    if (OutboundAttachmentRepository.countLiveStorageReferences(attachment.storage_path, attachmentId, database) === 0) {
      const safePath = assertSafePath(storageDir, attachment.storage_path);
      try { fs.unlinkSync(safePath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return true;
  }

  static resolveContent(attachmentId, {
    database = require('../database/db'),
    storageDir = this.getDefaultStorageDir()
  } = {}) {
    const attachment = OutboundAttachmentRepository.getById(attachmentId, database);
    if (!attachment || ['expired', 'deleted'].includes(attachment.status)) return null;
    const safePath = assertSafePath(storageDir, attachment.storage_path);
    if (!fs.existsSync(safePath)) {
      OutboundAttachmentRepository.transition(
        attachment.id,
        ['staged', 'queued', 'sending', 'failed'],
        'failed',
        { validation_error: 'FILE_MISSING' },
        database
      );
      return null;
    }
    return { ...attachment, storage_path: safePath };
  }
}

OutboundAttachmentService.Error = OutboundAttachmentError;
OutboundAttachmentService.STAGED_RETENTION_MS = STAGED_RETENTION_MS;
module.exports = OutboundAttachmentService;
