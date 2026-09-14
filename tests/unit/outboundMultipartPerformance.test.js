const test = require('node:test');
const assert = require('node:assert/strict');
const OutboundAttachmentService = require('../../src/server/services/OutboundAttachmentService');

test('rich-message multipart parser returns a zero-copy video slice', () => {
  const boundary = 'crm-video-boundary';
  const quote = String.fromCharCode(34);
  const video = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(1024 * 1024, 7)]);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=${quote}file${quote}; filename=${quote}clip.mp4${quote}\r\nContent-Type: video/mp4\r\n\r\n`);
  const body = Buffer.concat([head, video, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const parsed = OutboundAttachmentService.parseMultipartBody(body, `multipart/form-data; boundary=${quote}${boundary}${quote}`);
  assert.equal(parsed.file.originalName, 'clip.mp4');
  assert.equal(parsed.file.declaredMimeType, 'video/mp4');
  assert.equal(parsed.file.buffer.length, video.length);
  assert.equal(parsed.file.buffer.buffer, body.buffer);
});
