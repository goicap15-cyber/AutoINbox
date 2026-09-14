const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('background.js findAttachButtonCenter implements composer proximity and exact label boosting', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const funcStart = source.indexOf('async function findAttachButtonCenter(');
  assert.ok(funcStart > 0, 'findAttachButtonCenter must be defined');
  const funcEnd = source.indexOf('async function pollForAttachmentEvidence(', funcStart);
  const body = source.slice(funcStart, funcEnd);

  // Checks for active composer identification
  assert.match(body, /visibleComposers/, 'Must identify visible composers');
  assert.match(body, /composerRect\s*=\s*activeComposer/, 'Must compute composerRect');
  assert.match(body, /composerScope/, 'Must scope queries to composerScope');

  // Checks for proximity calculation
  assert.match(body, /dy\s*<=\s*160/, 'Must reward elements vertically close to composer');
  assert.match(body, /dy\s*>\s*300/, 'Must penalize elements far vertically from composer');

  // Checks for exact label match boost
  assert.match(body, /đính kèm file\|đính kèm tệp/i, 'Must boost exact match for Business Suite paperclip button');
});

test('Scoring logic prioritizes paperclip button near composer over unrelated sidebar video button', () => {
  // Simulate scoring function extracted from findAttachButtonCenter
  const payload = { preferredKind: 'video' };
  const normalizeLabel = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const scoreForKind = (element, composerRect = null) => {
    const rawLabel = String(element.getAttribute('aria-label') || '');
    const label = normalizeLabel(`${rawLabel} ${element.getAttribute('title') || ''}`);
    let score = 0;
    if (label.includes('dinh kem') || label.includes('attach') || label.includes('them')) score += 10;
    if (payload.preferredKind === 'video') {
      if (label.includes('video')) score += 120;
      if (label.includes('file') || label.includes('tep')) score += 70;
      if (label.includes('anh') || label.includes('photo') || label.includes('image')) score += 60;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      score += 20;
      if (composerRect) {
        const dy = Math.abs((rect.top + rect.bottom) / 2 - (composerRect.top + composerRect.bottom) / 2);
        const dx = Math.abs((rect.left + rect.right) / 2 - (composerRect.left + composerRect.right) / 2);
        if (dy <= 160) {
          score += 300;
          if (dx <= 600) score += 100;
        } else if (dy > 300) {
          score -= 250;
        }
      }
    }
    if (/^(đính kèm file|đính kèm tệp|attach a file|attach file)$/i.test(rawLabel.trim())) {
      score += 150;
    }
    if (element.getAttribute('role') === 'button' || element.tagName === 'BUTTON') {
      score += 30;
    }
    return score;
  };

  const composerRect = { top: 800, bottom: 840, left: 300, right: 900 };

  // Simulated paperclip button: <div role="button" aria-label="Đính kèm file" tabindex="0">
  const paperclipEl = {
    getAttribute: (attr) => attr === 'aria-label' ? 'Đính kèm file' : (attr === 'role' ? 'button' : null),
    tagName: 'DIV',
    getBoundingClientRect: () => ({ top: 850, bottom: 874, left: 310, right: 334, width: 24, height: 24 })
  };

  // Simulated sidebar menu item: <div role="button" aria-label="Thư viện video">
  const sidebarVideoEl = {
    getAttribute: (attr) => attr === 'aria-label' ? 'Thư viện video' : (attr === 'role' ? 'button' : null),
    tagName: 'DIV',
    getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 20, right: 180, width: 160, height: 40 })
  };

  const paperclipScore = scoreForKind(paperclipEl, composerRect);
  const sidebarVideoScore = scoreForKind(sidebarVideoEl, composerRect);

  assert.ok(paperclipScore > 500, `Paperclip score should be very high (>500), got: ${paperclipScore}`);
  assert.ok(sidebarVideoScore < 0, `Sidebar video score should be penalized (<0), got: ${sidebarVideoScore}`);
  assert.ok(paperclipScore > sidebarVideoScore, 'Paperclip must decisively beat sidebar video button');
});

test('stageBusinessSuiteAttachment uses preferDirectInput: false', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const start = source.indexOf('async function stageBusinessSuiteAttachment(');
  const end = source.indexOf('async function stagePersonalMessengerAttachment(', start);
  const body = source.slice(start, end);

  assert.match(body, /preferDirectInput:\s*false/);
});

test('stageAttachmentViaFileChooser uses 8000ms timeout for file chooser', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension/background.js'), 'utf8');
  const start = source.indexOf('async function stageAttachmentViaFileChooser(');
  const end = source.indexOf('function assertValidImageAttachment(', start);
  const body = source.slice(start, end);

  assert.match(body, /waitForFileChooserOpened\(tabId,\s*8000\)/);
});
