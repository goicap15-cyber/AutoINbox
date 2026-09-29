const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FbPageVideoUploader = require('../../src/extension/pageVideoUploader');

test('stageBusinessSuiteAttachment uses preferDirectInput: false to trigger trusted file chooser via paperclip', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const bsuiteStageStart = source.indexOf('async function stageBusinessSuiteAttachment(');
  assert.ok(bsuiteStageStart > 0, 'stageBusinessSuiteAttachment function should exist');
  const bsuiteStageEnd = source.indexOf('async function stagePersonalMessengerAttachment(', bsuiteStageStart);
  const bsuiteStageBody = source.slice(bsuiteStageStart, bsuiteStageEnd);

  assert.match(
    bsuiteStageBody,
    /await stageAttachmentViaFileChooser\(tabId, point, attachmentOrManifest, \{\s*preferDirectInput:\s*false\s*\}\)/,
    'stageBusinessSuiteAttachment must pass preferDirectInput: false'
  );
});

test('stagePersonalMessengerAttachment uses preferDirectInput: true for ALL kinds (video freeze fix 2026-09-24)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const personalStageStart = source.indexOf('async function stagePersonalMessengerAttachment(');
  assert.ok(personalStageStart > 0, 'stagePersonalMessengerAttachment function should exist');
  const personalStageEnd = source.indexOf('async function typeAndSubmitComposer(', personalStageStart);
  const personalStageBody = source.slice(personalStageStart, personalStageEnd);

  // Đường set file trực tiếp vào input là đường CHÍNH cho mọi loại (kể cả
  // video) - chooser chỉ còn là fallback. Trước đây video bị ép đi chooser
  // và làm chết cả 2 lượt CAMERA_STAGE (video upload freeze).
  assert.match(
    personalStageBody,
    /preferDirectInput:\s*true/,
    'stagePersonalMessengerAttachment must use direct input for all kinds'
  );
  assert.doesNotMatch(
    personalStageBody,
    /preferDirectInput:\s*preferredKind !== 'video'/,
    'old per-kind rule must not come back (video freeze regression)'
  );
});

test('findAttachButtonCenter scores combined photo/video labels positively for video preferredKind', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const findStart = source.indexOf('async function findAttachButtonCenter(');
  const findEnd = source.indexOf('async function pollForAttachmentEvidence(', findStart);
  const findBody = source.slice(findStart, findEnd);

  assert.match(findBody, /'Đính kèm ảnh\/video'/);
  assert.match(findBody, /'Thêm ảnh\/video'/);
  assert.match(findBody, /if \(label\.includes\('anh'\) \|\| label\.includes\('photo'\) \|\| label\.includes\('image'\)\) score \+= 60;/);
});

test('acceptsKind in stageAttachmentViaFileChooser allows wildcard and video mime formats', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const chooserStart = source.indexOf('async function stageAttachmentViaFileChooser(');
  const chooserEnd = source.indexOf('function assertValidImageAttachment(', chooserStart);
  const chooserBody = source.slice(chooserStart, chooserEnd);

  assert.match(chooserBody, /\/video\|mp4\|mov\|webm\|avi\|\\\*\/\.test\(accept\)/);
  assert.match(chooserBody, /\/image\|photo\|png\|jpe\?g\|webp\|\\\*\/\.test\(accept\)/);
});

test('FbPageVideoUploader correctly resolves and checks video attachments', () => {
  assert.equal(FbPageVideoUploader.hasVideoAttachment({ media_type: 'video', mime_type: 'video/mp4' }), true);
  assert.equal(FbPageVideoUploader.hasVideoAttachment({ media_type: 'image', mime_type: 'image/png' }), false);
  assert.equal(FbPageVideoUploader.resolvePreferredKind({ media_type: 'video', mime_type: 'video/mp4' }), 'video');
  assert.equal(FbPageVideoUploader.resolvePreferredKind({ media_type: 'file', mime_type: 'video/mp4' }), 'video');
});
