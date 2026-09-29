'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../src/extension/pageIdentityGate');

// Vietnamese action labels via unicode escapes so this source stays ASCII.
const MOVE_TO_SPAM = 'Chuy\u1ec3n \u0111\u1ebfn th\u01b0 m\u1ee5c Spam';
const ASSIGN_LABEL = 'G\u00e1n nh\u00e3n';
const MARK_DONE = '\u0110\u00e1nh d\u1ea5u l\u00e0 \u0111\u00e3 x\u1eed l\u00fd';
const EDIT = 'Ch\u1ec9nh s\u1eeda';

test('isActionLabel matches known header action-button labels', () => {
  assert.equal(gate.isActionLabel(MOVE_TO_SPAM), true);
  assert.equal(gate.isActionLabel(ASSIGN_LABEL), true);
  assert.equal(gate.isActionLabel(MARK_DONE), true);
  assert.equal(gate.isActionLabel(EDIT), true);
  assert.equal(gate.isActionLabel('Vung Vu Vuong'), false);
  assert.equal(gate.isActionLabel('Nguy\u1ec5n V\u0103n A'), false);
  assert.equal(gate.isActionLabel(''), false);
});

test('filterCandidateNames drops action labels, keeps real names, dedupes', () => {
  const names = gate.filterCandidateNames([
    MOVE_TO_SPAM,
    'Vung Vu Vuong',
    ASSIGN_LABEL,
    '  ' + MARK_DONE + '  ',
    'Nguy\u1ec5n V\u0103n A',
    'Vung Vu Vuong',
    '',
    null
  ]);
  assert.deepEqual(names, ['Vung Vu Vuong', 'Nguy\u1ec5n V\u0103n A']);
});

test('label-only header becomes unreadable (empty) -> existing trust-ID policy applies', () => {
  // Reproduce 2026-09-29: cold conversation renders the action button before
  // the title; before the fix this array kept only the button label and the
  // sync aborted with thread_route_mismatch.
  const raw = [MOVE_TO_SPAM, ASSIGN_LABEL];
  const filtered = gate.filterCandidateNames(raw);
  assert.equal(filtered.length, 0); // -> verifyBizHeaderIdentity treats as unreadable -> trusts ID
});

test('readable wrong name survives filtering (miswrite protection stays)', () => {
  const filtered = gate.filterCandidateNames([MOVE_TO_SPAM, 'Kh\u00e1c Ho\u00e0n To\u00e0n']);
  assert.deepEqual(filtered, ['Kh\u00e1c Ho\u00e0n To\u00e0n']);
});
