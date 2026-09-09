const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  detectMimeType,
  sanitizeFilename,
  checksumSha256,
  assertSafePath,
  validateAttachment,
  MIME_CAPABILITIES
} = require('../../src/server/services/attachmentValidation');

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webp = Buffer.from('RIFF1234WEBPVP8 ', 'ascii');
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

test('detectMimeType identifies the initial rich-message formats', () => {
  assert.equal(detectMimeType(jpeg), 'image/jpeg');
  assert.equal(detectMimeType(png), 'image/png');
  assert.equal(detectMimeType(webp), 'image/webp');
  assert.equal(detectMimeType(pdf), 'application/pdf');
  assert.equal(detectMimeType(Buffer.from('not-media')), null);
  assert.equal(MIME_CAPABILITIES['application/pdf'].mediaType, 'file');
});

test('sanitizeFilename preserves a recognizable safe Vietnamese filename', () => {
  assert.equal(sanitizeFilename('Báo giá tháng 8.pdf'), 'Bao_gia_thang_8.pdf');
  assert.equal(sanitizeFilename('../../evil<script>.pdf'), 'evil_script_.pdf');
  assert.ok(sanitizeFilename('a'.repeat(300) + '.pdf').length <= 160);
});

test('checksumSha256 is stable for the same bytes', () => {
  assert.equal(checksumSha256(pdf), checksumSha256(Buffer.from(pdf)));
  assert.match(checksumSha256(pdf), /^[a-f0-9]{64}$/);
});

test('assertSafePath accepts children and rejects traversal/outside paths', () => {
  const root = path.join(os.tmpdir(), 'rich-message-root');
  const safe = path.join(root, 'abc.pdf');
  assert.equal(assertSafePath(root, safe), path.resolve(safe));
  assert.throws(() => assertSafePath(root, path.join(root, '..', 'outside.pdf')), /storage root/i);
  assert.throws(() => assertSafePath(root, '/etc/passwd'), /storage root/i);
});

test('validateAttachment returns normalized metadata for valid content', () => {
  const result = validateAttachment({
    buffer: pdf,
    originalName: 'Báo giá.pdf',
    declaredMimeType: 'application/pdf',
    allowedMimeTypes: ['application/pdf'],
    maxBytes: 1024
  });
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.mediaType, 'file');
  assert.equal(result.safeName, 'Bao_gia.pdf');
  assert.equal(result.byteSize, pdf.length);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.equal(result.extension, '.pdf');
});

test('validateAttachment rejects empty, oversized, mismatched and truncated PDF bytes', () => {
  assert.throws(() => validateAttachment({
    buffer: Buffer.alloc(0),
    originalName: 'empty.pdf',
    declaredMimeType: 'application/pdf'
  }), (error) => error.code === 'ATTACHMENT_EMPTY');

  assert.throws(() => validateAttachment({
    buffer: pdf,
    originalName: 'large.pdf',
    declaredMimeType: 'application/pdf',
    maxBytes: pdf.length - 1
  }), (error) => error.code === 'ATTACHMENT_TOO_LARGE');

  assert.throws(() => validateAttachment({
    buffer: png,
    originalName: 'fake.pdf',
    declaredMimeType: 'application/pdf'
  }), (error) => error.code === 'ATTACHMENT_TYPE_MISMATCH');

  assert.throws(() => validateAttachment({
    buffer: Buffer.from('%PDF-1.7\nno eof marker', 'ascii'),
    originalName: 'broken.pdf',
    declaredMimeType: 'application/pdf'
  }), (error) => error.code === 'ATTACHMENT_CORRUPT');

  assert.throws(() => validateAttachment({
    buffer: pdf,
    originalName: 'blocked.pdf',
    declaredMimeType: 'application/pdf',
    allowedMimeTypes: ['image/png']
  }), (error) => error.code === 'ATTACHMENT_UNSUPPORTED');
});

test('validateAttachment accepts a safe chat file from its allow-listed extension', () => {
  const bytes = Buffer.from('noi dung tai lieu');
  const result = validateAttachment({
    buffer: bytes,
    originalName: 'ghi-chu.txt',
    declaredMimeType: '',
    allowedMimeTypes: ['text/plain'],
    enforceExtension: true
  });
  assert.equal(result.mimeType, 'text/plain');
  assert.equal(result.mediaType, 'file');
  assert.equal(result.extension, '.txt');
});
