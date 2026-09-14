const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FbPageVideoUploader = require('../../src/extension/pageVideoUploader');

test('evaluateBusinessSuiteUploadState returns ready: false while upload is busy or button is disabled', () => {
  const mockDoc = {
    querySelectorAll: (selector) => {
      if (selector.includes('textbox') || selector.includes('contenteditable')) {
        return [{
          getAttribute: () => 'Nhập tin nhắn',
          getBoundingClientRect: () => ({ width: 400, height: 50 }),
          closest: () => mockDoc
        }];
      }
      if (selector.includes('button')) {
        return [{
          disabled: true,
          getAttribute: (attr) => attr === 'aria-label' ? 'Gửi' : 'true',
          textContent: 'Gửi',
          getBoundingClientRect: () => ({ width: 30, height: 30 })
        }];
      }
      if (selector.includes('progressbar')) {
        return [{
          getBoundingClientRect: () => ({ width: 100, height: 4 })
        }];
      }
      return [];
    }
  };

  const state = FbPageVideoUploader.evaluateBusinessSuiteUploadState(mockDoc, ['test_video.mp4'], true);
  assert.equal(state.ready, false, 'Should not be ready while upload is busy and button is disabled');
  assert.equal(state.send_found, false, 'Disabled button should not count as ready send button');
  assert.equal(state.busy, 1, 'Should register 1 busy progressbar');
});

test('evaluateBusinessSuiteUploadState returns ready: true when upload finishes and send button is enabled', () => {
  const mockDoc = {
    querySelectorAll: (selector) => {
      if (selector.includes('textbox') || selector.includes('contenteditable')) {
        return [{
          getAttribute: () => 'Nhập tin nhắn',
          getBoundingClientRect: () => ({ width: 400, height: 50 }),
          closest: () => mockDoc
        }];
      }
      if (selector.includes('button')) {
        return [{
          disabled: false,
          getAttribute: (attr) => attr === 'aria-label' ? 'Gửi' : null,
          textContent: 'Gửi',
          getBoundingClientRect: () => ({ width: 30, height: 30 })
        }];
      }
      if (selector.includes('video')) {
        return [{
          getBoundingClientRect: () => ({ width: 200, height: 150 })
        }];
      }
      return [];
    },
    innerText: 'Composer with test_video.mp4 staged'
  };

  const state = FbPageVideoUploader.evaluateBusinessSuiteUploadState(mockDoc, ['test_video.mp4'], true);
  assert.equal(state.ready, true, 'Should be ready when video is staged, no busy elements, and send button enabled');
  assert.equal(state.send_found, true, 'Enabled send button should be recognized');
  assert.equal(state.has_staged_media, true, 'Should detect staged video');
  assert.equal(state.busy, 0, 'No busy elements should be present');
});

test('background.js implements waitForBusinessSuiteAttachmentReady and calls it in handleSendPageMessage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');

  assert.ok(
    source.includes('async function waitForBusinessSuiteAttachmentReady('),
    'waitForBusinessSuiteAttachmentReady must be defined in background.js'
  );

  const handlePageSendStart = source.indexOf('async function handleSendPageMessage(');
  assert.ok(handlePageSendStart > 0, 'handleSendPageMessage must exist');
  const handlePageSendEnd = source.indexOf('async function handleSendQueuedMessage(', handlePageSendStart);
  const handlePageSendBody = source.slice(handlePageSendStart, handlePageSendEnd);

  assert.match(
    handlePageSendBody,
    /await stageBusinessSuiteAttachment\(tab\.id, attachmentPayload\);/,
    'Must stage attachment'
  );
  assert.match(
    handlePageSendBody,
    /await waitForBusinessSuiteAttachmentReady\(tab\.id, attachmentPayload\);/,
    'Must wait for Business Suite attachment readiness before submit'
  );
  assert.match(
    handlePageSendBody,
    /await typeAndSubmitComposer\(tab\.id, content\);/,
    'Must call typeAndSubmitComposer after readiness'
  );
});

test('background.js checkFacebookCookiesAndRegister guards against infinite loops', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const checkFuncStart = source.indexOf('async function checkFacebookCookiesAndRegister()');
  assert.ok(checkFuncStart > 0, 'checkFacebookCookiesAndRegister must exist');
  const checkFuncEnd = source.indexOf('if (chrome?.cookies?.onChanged)', checkFuncStart);
  const checkFuncBody = source.slice(checkFuncStart, checkFuncEnd);

  assert.doesNotMatch(
    checkFuncBody,
    /if\s*\(!hadUser\s*\|\|\s*userChanged\s*\|\|\s*pending_key\)/,
    'Must not unconditionally re-register every tick when pending_key is set'
  );
  assert.match(
    checkFuncBody,
    /if\s*\(!hadUser\s*\|\|\s*userChanged\s*\|\|\s*!backendAccountRegistered\)/,
    'Must gate registration by backendAccountRegistered state'
  );
});
