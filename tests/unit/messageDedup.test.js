const test = require('node:test');
const assert = require('node:assert/strict');

test('collapses an exact Messenger _media companion into the base message', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const result = collapseMessengerMediaCompanions([
    { id: 1, fb_message_id: 'mid.$ONE', content: 'caption', media_type: 'image', media_url: '/local.jpg', attachment_id: 'attachment-1' },
    { id: 2, fb_message_id: 'mid.$ONE_media', content: '', media_type: 'image', media_url: 'https://facebook/image.jpg' }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].content, 'caption');
  assert.equal(result[0].media_url, '/local.jpg');
});

test('does not collapse unrelated images', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const result = collapseMessengerMediaCompanions([
    { id: 1, fb_message_id: 'mid.$ONE_media', media_type: 'image' },
    { id: 2, fb_message_id: 'mid.$TWO_media', media_type: 'image' }
  ]);
  assert.equal(result.length, 2);
});


test('collapses an optimistic and durable copy of the same outbound attachment', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    { client_message_id: 'client-local', attachment_id: 'att-1', local_media_path: 'C:/a.jpg', media_type: 'image', is_outgoing: 1, status: 'sent' },
    { id: 99, client_message_id: 'client-server', fb_message_id: 'mid.$REAL', attachment_id: 'att-1', media_url: '/api/a', media_type: 'image', is_outgoing: 1, status: 'sent' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 99);
  assert.equal(rows[0].fb_message_id, 'mid.$REAL');
});

test('collapses a temporary outbound image with a confirmed mid.* image within 120s window', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    { id: 14049, client_message_id: 'client_123', fb_message_id: '7504119442649168613', media_type: 'image', is_outgoing: 1, timestamp_ms: 1789121492783, status: 'sent' },
    { id: 14233, fb_message_id: 'mid.$cAAQXQILUZ2SmwTiBrWgj_N_gJaU2', media_type: 'image', is_outgoing: 1, timestamp_ms: 1789121400270, status: 'sent' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 14233);
  assert.equal(rows[0].fb_message_id, 'mid.$cAAQXQILUZ2SmwTiBrWgj_N_gJaU2');
});

