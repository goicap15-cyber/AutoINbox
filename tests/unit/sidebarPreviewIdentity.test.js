const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function previewId(accountId, threadId, content) {
  const hash = crypto.createHash('sha1').update(`${accountId}|${threadId}|${content}`).digest('hex').slice(0, 16);
  return `sidebar_preview_${hash}`;
}

test('same sidebar content in one thread always has one provisional identity', () => {
  assert.equal(previewId('a', 't', 'Hhhjj'), previewId('a', 't', 'Hhhjj'));
});

test('same content from different users cannot collide', () => {
  assert.notEqual(previewId('a', 't1', '0973148256'), previewId('a', 't2', '0973148256'));
});
