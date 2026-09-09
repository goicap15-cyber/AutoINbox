const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePageIdFromInput } = require('../../src/server/utils/pageIdParser');

test('accepts a raw numeric page id', () => {
  assert.equal(parsePageIdFromInput('61572034604426'), '61572034604426');
});

test('extracts id from a profile.php?id= link, with or without scheme', () => {
  assert.equal(parsePageIdFromInput('https://www.facebook.com/profile.php?id=123456789'), '123456789');
  assert.equal(parsePageIdFromInput('facebook.com/profile.php?id=61572034604426'), '61572034604426');
});

test('extracts id from a generic ?id= query string', () => {
  assert.equal(parsePageIdFromInput('https://business.facebook.com/latest/home?asset_id=1209772058877160&id=1209772058877160'), '1209772058877160');
});

test('returns null for a vanity-name page URL (no numeric id present)', () => {
  assert.equal(parsePageIdFromInput('https://www.facebook.com/somepagename'), null);
});

test('returns null for empty/whitespace-only/missing input', () => {
  assert.equal(parsePageIdFromInput(''), null);
  assert.equal(parsePageIdFromInput('   '), null);
  assert.equal(parsePageIdFromInput(null), null);
  assert.equal(parsePageIdFromInput(undefined), null);
});

test('trims surrounding whitespace before checking for a pure numeric id', () => {
  assert.equal(parsePageIdFromInput('  61572034604426  '), '61572034604426');
});
