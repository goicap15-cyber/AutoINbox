const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contentPath = path.join(__dirname, '..', '..', 'src', 'extension', 'content.js');

test('decline execution never uses the accept-neighbor fallback', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const references = source.match(/findDeclineButtonBesideAccept\s*\(/g) || [];
  assert.equal(references.length, 1, 'only the unused legacy declaration may remain');
  assert.match(source, /findKnownMessengerDeclineButton\(\)\s*\|\|\s*\r?\n?\s*findCallButtonFromRingingText\('decline'\)/);
});

test('decline does not stop ringtone before locating and clicking its own control', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('function triggerCallAnswer');
  const lookup = source.indexOf('function findExactButton', start);
  assert.ok(start >= 0 && lookup > start);
  assert.doesNotMatch(source.slice(start, lookup), /stopAllRingtoneAudio\s*\(/);
});
test('decline never silences ringtone before Messenger confirms the action', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('function triggerCallAnswer');
  const end = source.indexOf('\n  try {', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /stopAllRingtoneAudio\s*\(/);
});

test('red decline fallback is independent from Accept', () => {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('function findRedIncomingCallDeclineButton');
  const end = source.indexOf('function findCallButtonFromRingingText', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /acceptButton|findIncomingCallActionButton\('accept'\)/);
});