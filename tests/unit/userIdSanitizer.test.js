const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors content.js's sanitizeUserId(). content.js runs a lot of top-level
// DOM wiring (event listeners, setInterval scanners) that would need a heavy
// document/window/chrome shim to load safely via vm.runInContext, so this is
// a plain mirror copy - same duplication pattern as historyRowSupport.js for
// background.js's injected closures. Keep both copies in sync.
function sanitizeUserId(rawId) {
  if (!rawId) return null;
  const id = String(rawId).trim();
  return (!id || id === '0') ? null : id;
}

test('rejects the Facebook "0" placeholder used while a page is mid-login/logged out', () => {
  assert.equal(sanitizeUserId('0'), null);
});

test('rejects falsy/empty input without throwing', () => {
  assert.equal(sanitizeUserId(null), null);
  assert.equal(sanitizeUserId(undefined), null);
  assert.equal(sanitizeUserId(''), null);
});

test('accepts a real-looking numeric Facebook user id', () => {
  assert.equal(sanitizeUserId('100008005082872'), '100008005082872');
});

test('trims whitespace and still rejects "0" after trimming', () => {
  assert.equal(sanitizeUserId('  0  '), null);
  assert.equal(sanitizeUserId('  100022290034259  '), '100022290034259');
});
