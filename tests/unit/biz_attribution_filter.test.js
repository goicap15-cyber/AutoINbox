'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripBizSentByAttribution, isBizSentByAttributionOnly } = require('../../src/server/utils/textFilter');

// Vietnamese via unicode escapes so this source stays ASCII.
const NGUOI_GUI = 'Ng\u01b0\u1eddi g\u1eedi'; // "Người gửi"
const CON_VIT = 'Con Vit';
const REAL_TEXT = 'H\u00f4m nay em t\u1eb7ng \u01b0u \u0111\u00e3i gi\u1ea3m gi\u00e1 mua h\u00e0ng cho anh qua s\u1ed1 zalo n\u00e0o \u0111\u01b0\u1ee3c a?';
const MERGED = REAL_TEXT + '\n' + NGUOI_GUI + ':\n' + CON_VIT;
const ATTR_ONLY = NGUOI_GUI + ':\n' + CON_VIT;
const ATTR_SAME_LINE = NGUOI_GUI + ': ' + CON_VIT;

test('stripBizSentByAttribution removes trailing sent-by attribution (next-line name)', () => {
  assert.equal(stripBizSentByAttribution(MERGED), REAL_TEXT);
});

test('stripBizSentByAttribution removes same-line attribution', () => {
  assert.equal(stripBizSentByAttribution(REAL_TEXT + '\n' + ATTR_SAME_LINE), REAL_TEXT);
});

test('stripBizSentByAttribution leaves clean text untouched', () => {
  assert.equal(stripBizSentByAttribution(REAL_TEXT), REAL_TEXT);
  assert.equal(stripBizSentByAttribution('B\u00ecnh th\u01b0\u1eddng\nhai d\u00f2ng'), 'B\u00ecnh th\u01b0\u1eddng\nhai d\u00f2ng');
  assert.equal(stripBizSentByAttribution(''), '');
  assert.equal(stripBizSentByAttribution(null), null);
});

test('stripBizSentByAttribution on attribution-only input yields empty', () => {
  assert.equal(stripBizSentByAttribution(ATTR_ONLY), '');
});

test('isBizSentByAttributionOnly detects attribution-only rows', () => {
  assert.equal(isBizSentByAttributionOnly(ATTR_ONLY), true);
  assert.equal(isBizSentByAttributionOnly(ATTR_SAME_LINE), true);
  assert.equal(isBizSentByAttributionOnly(NGUOI_GUI + ':'), true);
  assert.equal(isBizSentByAttributionOnly(REAL_TEXT), false);
  assert.equal(isBizSentByAttributionOnly(MERGED), false);
  assert.equal(isBizSentByAttributionOnly(''), false);
  assert.equal(isBizSentByAttributionOnly(null), false);
});

test('mid-text mention of the phrase is not stripped', () => {
  const mid = 'Anh ' + NGUOI_GUI + ': Nam r\u1ed3i g\u1eedi l\u1ea1i h\u00f3a \u0111\u01a1n nh\u00e9';
  assert.equal(stripBizSentByAttribution(mid), mid);
  assert.equal(isBizSentByAttributionOnly(mid), false);
});
