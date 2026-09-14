const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

function readRichMessageFilePart(buffer, headerStart, headerEnd, bodyStart, bodyEnd) {
  const headers = buffer.subarray(headerStart, headerEnd).toString('latin1');
  const marker = 'filename=';
  const nameStart = headers.indexOf(marker);
  if (nameStart < 0) return null;
  const quote = String.fromCharCode(34);
  const valueStart = nameStart + marker.length + 1;
  const nameEnd = headers.indexOf(quote, valueStart);
  if (nameEnd < 0) return null;
  const originalName = headers.slice(valueStart, nameEnd);
  const lines = headers.split(String.fromCharCode(13, 10));
  const typeLine = lines.find((line) => line.toLowerCase().startsWith('content-type:'));
  const declaredMimeType = typeLine
    ? typeLine.slice(typeLine.indexOf(':') + 1).trim()
    : 'application/octet-stream';
  const file = {
    originalName,
    declaredMimeType,
    buffer: buffer.subarray(bodyStart, bodyEnd)
  };
  return { fields: {}, file, files: [file] };
}

function parseRichMessageFilePart(buffer, boundary) {
  const first = Buffer.from('--' + boundary, 'latin1');
  const next = Buffer.from('\r\n--' + boundary, 'latin1');
  const separator = Buffer.from('\r\n\r\n', 'latin1');
  let cursor = buffer.indexOf(first);
  while (cursor >= 0) {
    const headerStart = cursor + first.length + 2;
    const headerEnd = buffer.indexOf(separator, headerStart);
    if (headerEnd < 0) break;
    const bodyStart = headerEnd + separator.length;
    const bodyEnd = buffer.indexOf(next, bodyStart);
    if (bodyEnd < 0) break;
    const result = readRichMessageFilePart(buffer, headerStart, headerEnd, bodyStart, bodyEnd);
    if (result) return result;
    cursor = bodyEnd + 2;
  }
  throw new Error('Missing upload file');
}

// Zero-copy multipart path for large rich-message videos.
function parseRichMessageMultipart(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Invalid multipart body');
  const token = String(contentType || '').split('boundary=')[1];
  let boundary = token ? token.split(';')[0].trim() : '';
  if (boundary.startsWith(String.fromCharCode(34)) && boundary.endsWith(String.fromCharCode(34))) {
    boundary = boundary.slice(1, -1);
  }
  if (!boundary) throw new Error('Missing multipart boundary');
  return parseRichMessageFilePart(buffer, boundary);
}

class OutboundAttachmentService {
  static getDefaultStorageDir() {
    return path.join(APP_DATA_ROOT, 'outbound-attachments');
  }

  static parseMultipartBody(buffer, contentType) {
    try {
      return parseRichMessageMultipart(buffer, contentType);
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
        maxBytes: Math.min(capability.image.max_bytes, capability.video?.max_bytes || capability.file.max_bytes, capability.file.max_bytes),
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
