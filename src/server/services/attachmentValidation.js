const crypto = require('crypto');
const path = require('path');
const JSZip = require('jszip');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SAFE_FILE_EXTENSIONS = Object.freeze({
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.md': 'text/markdown',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo'
});
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jse', '.jar', '.sh', '.bin']);
const ZIP_CONTAINER_MIMES = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.android.package-archive']);

const FILE_MIME_CAPABILITIES = Object.fromEntries(
  Object.entries(SAFE_FILE_EXTENSIONS).map(([extension, mimeType]) => [mimeType, Object.freeze({
    extension,
    extensions: Object.freeze(Object.entries(SAFE_FILE_EXTENSIONS).filter(([, value]) => value === mimeType).map(([key]) => key)),
    mediaType: 'file'
  })])
);
const MIME_CAPABILITIES = Object.freeze({
  'image/jpeg': Object.freeze({
    extension: '.jpg',
    extensions: Object.freeze(['.jpg', '.jpeg']),
    mediaType: 'image'
  }),
  'image/png': Object.freeze({
    extension: '.png',
    extensions: Object.freeze(['.png']),
    mediaType: 'image'
  }),
  'image/webp': Object.freeze({
    extension: '.webp',
    extensions: Object.freeze(['.webp']),
    mediaType: 'image'
  }),
  'application/pdf': Object.freeze({
    extension: '.pdf',
    extensions: Object.freeze(['.pdf']),
    mediaType: 'file'
  }),
  ...FILE_MIME_CAPABILITIES
});

class AttachmentValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
    this.details = details;
  }
}

function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'image/png';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  ) return 'application/pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('binary') === 'PK\x03\x04') return 'application/zip';
  return null;
}

function sanitizeFilename(value) {
  const original = path.basename(String(value || 'upload'));
  let safe = original
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  if (!safe) safe = 'upload';
  if (safe.length <= 160) return safe;

  const extension = path.extname(safe).slice(0, 20);
  const stemLength = Math.max(1, 160 - extension.length);
  return safe.slice(0, stemLength) + extension;
}

function checksumSha256(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new AttachmentValidationError(
      'ATTACHMENT_INVALID_BUFFER',
      'Attachment bytes must be a Buffer.'
    );
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertSafePath(storageRoot, candidatePath) {
  const root = path.resolve(String(storageRoot || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  if (!root || candidate === root || !candidate.startsWith(root + path.sep)) {
    throw new AttachmentValidationError(
      'ATTACHMENT_UNSAFE_PATH',
      'Attachment path is outside the configured storage root.',
      { storage_root: root }
    );
  }
  return candidate;
}

function buildStoragePath(storageRoot, checksum, mimeType) {
  const capability = MIME_CAPABILITIES[mimeType];
  if (!/^[a-f0-9]{64}$/.test(String(checksum || ''))) {
    throw new AttachmentValidationError(
      'ATTACHMENT_STORAGE_INVALID',
      'Cannot build an attachment storage path from invalid metadata.'
    );
  }
  return assertSafePath(
    storageRoot,
    path.join(path.resolve(storageRoot), checksum + (capability?.extension || Object.entries(SAFE_FILE_EXTENSIONS).find(([, value]) => value === mimeType)?.[0] || '.bin'))
  );
}

const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

// Spec 040 FR-005: a relative path is only safe as a folder-upload entry or
// ZIP member name if it cannot escape the folder/archive root once used to
// build a path on disk. Used both for client-declared webkitRelativePath
// values (folder selection) and for inspecting an already-built/uploaded
// ZIP's own entry names.
function isSafeArchiveEntryPath(relativePath) {
  const value = String(relativePath || '');
  if (!value || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false; // Windows drive letter
  if (value.startsWith('\\\\')) return false; // UNC path
  const normalized = value.replace(/\\/g, '/');
  // A single trailing slash marks a ZIP directory entry (e.g. "sub/") - safe
  // to allow; strip it before segment-checking so it isn't read as an empty
  // final segment, without permitting an empty segment anywhere else.
  const withoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return false;
  if (segments.some((segment) => segment.length === 0)) return false;
  return true;
}

// Zip entries can mark a member as a symlink via the POSIX file-type bits of
// the unix mode (S_IFLNK = 0xA000). JSZip's entry.unixPermissions already
// returns the extracted 16-bit unix mode (not the raw 32-bit external
// attributes field), so no further shifting is needed here. A symlink member
// is never safe to trust the name/content of - it does not carry the linked
// bytes at all, so forwarding it as-is would send whatever it happens to
// resolve to, and following it server-side risks reading outside the
// intended folder.
function isZipEntrySymlink(unixPermissions) {
  if (!Number.isInteger(unixPermissions)) return false;
  return (unixPermissions & 0xf000) === 0xa000;
}

// Inspects an already-assembled ZIP buffer (either uploaded directly by an
// operator, or one this service just built from a folder selection) for path
// traversal, symlink members, and zip-bomb-scale entry counts/sizes. Does not
// extract file contents - only reads the central directory metadata.
async function validateZipArchiveEntries(buffer, {
  maxEntries = MAX_ARCHIVE_ENTRIES,
  maxUncompressedBytes = MAX_ARCHIVE_UNCOMPRESSED_BYTES
} = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new AttachmentValidationError('ATTACHMENT_CORRUPT', 'Archive structure is incomplete or unreadable.');
  }
  const entries = Object.values(zip.files);
  if (entries.length > maxEntries) {
    throw new AttachmentValidationError(
      'ATTACHMENT_ARCHIVE_UNSAFE',
      'Archive contains too many entries.',
      { entry_count: entries.length, maximum_entries: maxEntries }
    );
  }
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    if (!isSafeArchiveEntryPath(entry.name)) {
      throw new AttachmentValidationError(
        'ATTACHMENT_ARCHIVE_UNSAFE',
        'Archive contains an unsafe entry path.',
        { entry_name: entry.name }
      );
    }
    const unixPermissions = entry.unixPermissions || (entry._data && entry._data.unixPermissions) || null;
    if (isZipEntrySymlink(unixPermissions)) {
      throw new AttachmentValidationError(
        'ATTACHMENT_ARCHIVE_UNSAFE',
        'Archive contains a symlink entry.',
        { entry_name: entry.name }
      );
    }
    totalUncompressedBytes += Number(entry._data?.uncompressedSize) || 0;
  }
  if (totalUncompressedBytes > maxUncompressedBytes) {
    throw new AttachmentValidationError(
      'ATTACHMENT_ARCHIVE_UNSAFE',
      'Archive uncompressed size exceeds the configured limit.',
      { total_uncompressed_bytes: totalUncompressedBytes, maximum_bytes: maxUncompressedBytes }
    );
  }
  return { entryCount: entries.length, totalUncompressedBytes };
}

function validatePdfStructure(buffer) {
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    throw new AttachmentValidationError(
      'ATTACHMENT_CORRUPT',
      'PDF structure is incomplete or unreadable.'
    );
  }
}

function validateAttachment({
  buffer,
  originalName,
  declaredMimeType,
  allowedMimeTypes = Object.keys(MIME_CAPABILITIES),
  maxBytes = DEFAULT_MAX_BYTES,
  enforceExtension = false,
  allowAnyFile = false,
  rejectExecutable = true
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AttachmentValidationError(
      'ATTACHMENT_EMPTY',
      'Attachment is empty or unreadable.'
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AttachmentValidationError(
      'ATTACHMENT_LIMIT_INVALID',
      'Attachment byte limit is invalid.'
    );
  }
  if (buffer.length > maxBytes) {
    throw new AttachmentValidationError(
      'ATTACHMENT_TOO_LARGE',
      'Attachment exceeds the configured byte limit.',
      { maximum_bytes: maxBytes, byte_size: buffer.length }
    );
  }

  const detectedMimeType = detectMimeType(buffer);
  const normalizedDeclared = String(declaredMimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const safeName = sanitizeFilename(originalName);
  const originalExtension = path.extname(safeName).toLowerCase();
  if (rejectExecutable && EXECUTABLE_EXTENSIONS.has(originalExtension)) {
    throw new AttachmentValidationError('ATTACHMENT_EXECUTABLE_RISK', 'Executable file types are not allowed.', { extension: originalExtension });
  }
  const compatibleContainer = detectedMimeType === 'application/zip' && ZIP_CONTAINER_MIMES.has(normalizedDeclared);
  const extensionMimeType = SAFE_FILE_EXTENSIONS[originalExtension] || null;
  // Browsers/Windows frequently report an empty or vendor-specific MIME for
  // ordinary documents. The allow-list is anchored to the sanitized file
  // extension; known byte signatures still win and are mismatch-checked.
  const declaredSafeFile = extensionMimeType && !detectedMimeType;
  const effectiveMimeType = (compatibleContainer ? normalizedDeclared : detectedMimeType) ||
    (declaredSafeFile ? extensionMimeType : null) ||
    (allowAnyFile ? (normalizedDeclared || extensionMimeType || 'application/octet-stream') : null);
  if (!effectiveMimeType) {
    throw new AttachmentValidationError(
      'ATTACHMENT_UNSUPPORTED',
      'Attachment type is not supported.'
    );
  }
  if (detectedMimeType && normalizedDeclared && normalizedDeclared !== detectedMimeType && !compatibleContainer) {
    throw new AttachmentValidationError(
      'ATTACHMENT_TYPE_MISMATCH',
      'Declared attachment type does not match its byte signature.',
      {
        declared_mime_type: normalizedDeclared,
        detected_mime_type: detectedMimeType
      }
    );
  }

  const allowed = new Set((allowedMimeTypes || []).map((value) => String(value).toLowerCase()));
  if (!allowAnyFile && !allowed.has(effectiveMimeType)) {
    throw new AttachmentValidationError(
      'ATTACHMENT_UNSUPPORTED',
      'Attachment type is disabled for this operation.',
      { detected_mime_type: effectiveMimeType }
    );
  }

  const capability = MIME_CAPABILITIES[effectiveMimeType] || { extension: originalExtension || '.bin', extensions: originalExtension ? [originalExtension] : [], mediaType: 'file' };
  if (
    enforceExtension &&
    originalExtension &&
    !capability.extensions.includes(originalExtension)
  ) {
    throw new AttachmentValidationError(
      'ATTACHMENT_TYPE_MISMATCH',
      'Attachment filename extension does not match its byte signature.',
      {
        filename_extension: originalExtension,
        detected_mime_type: detectedMimeType
      }
    );
  }

  if (effectiveMimeType === 'application/pdf') validatePdfStructure(buffer);

  return Object.freeze({
    mimeType: effectiveMimeType,
    mediaType: capability.mediaType,
    extension: capability.extension,
    safeName,
    byteSize: buffer.length,
    checksum: checksumSha256(buffer)
  });
}

// Same result as validateAttachment, but additionally inspects ZIP entries
// for traversal/symlink/zip-bomb risk when the effective type is a ZIP -
// kept as a separate async wrapper so every existing synchronous caller of
// validateAttachment (1:1 rich messaging, existing campaign image tests)
// stays unchanged; only new file-transport callers that can await this.
async function validateAttachmentAsync(options = {}) {
  const validated = validateAttachment(options);
  if (validated.mimeType === 'application/zip') {
    const archiveStats = await validateZipArchiveEntries(options.buffer, options.archiveOptions);
    return Object.freeze({ ...validated, archive: archiveStats });
  }
  return validated;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  SAFE_FILE_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  MIME_CAPABILITIES,
  AttachmentValidationError,
  detectMimeType,
  sanitizeFilename,
  checksumSha256,
  assertSafePath,
  buildStoragePath,
  validateAttachment,
  isSafeArchiveEntryPath,
  validateZipArchiveEntries,
  validateAttachmentAsync
};
