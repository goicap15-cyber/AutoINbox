const test = require('node:test');
const assert = require('node:assert/strict');

test('hides only a nearby provisional sidebar echo of an outbound text', async () => {
  const { collapseSidebarOutboundEchoes } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseSidebarOutboundEchoes([
    { id: 1, fb_message_id: 'mid.$OUT', content: 'same text', is_outgoing: 1, timestamp_ms: 100000 },
    { id: 2, fb_message_id: 'sidebar_preview_echo', content: 'same text', is_outgoing: 0, timestamp_ms: 110000 },
    { id: 3, fb_message_id: 'mid.$CUSTOMER', content: 'same text', is_outgoing: 0, timestamp_ms: 111000 },
    { id: 4, fb_message_id: 'sidebar_preview_old', content: 'same text', is_outgoing: 0, timestamp_ms: 5000000 }
  ]);
  assert.deepEqual(rows.map((row) => row.id), [1, 3]);
});

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
    { id: 1, fb_message_id: 'mid.$ONE_media', media_type: 'image', media_url: 'https://facebook/one.jpg' },
    { id: 2, fb_message_id: 'mid.$TWO_media', media_type: 'image', media_url: 'https://facebook/two.jpg' }
  ]);
  assert.equal(result.length, 2);
});


test('collapses an optimistic and durable copy of the same outbound attachment', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    { client_message_id: 'client-local', attachment_id: 'att-1', local_media_path: 'C:/a.jpg', media_type: 'image', is_outgoing: 1, status: 'sent', ui_render_key: 'crm_client-local', ui_position_locked: true, sequence_order: 7 },
    { id: 99, client_message_id: 'client-server', fb_message_id: 'mid.$REAL', attachment_id: 'att-1', media_url: '/api/a', media_type: 'image', is_outgoing: 1, status: 'sent' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 99);
  assert.equal(rows[0].fb_message_id, 'mid.$REAL');
  assert.equal(rows[0].client_message_id, 'client-local');
  assert.equal(rows[0].ui_render_key, 'crm_client-local');
  assert.equal(rows[0].ui_position_locked, true);
  assert.equal(rows[0].sequence_order, 7);
});

test('keeps native video confirmation and removes the CRM duplicate', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    { id: 1, fb_message_id: 'dom_video', client_message_id: 'client-video', attachment_id: 'att-video', media_type: 'video', is_outgoing: 1, timestamp_ms: 100000 },
    { id: 2, fb_message_id: 'mid.$VIDEO', media_type: 'video', media_url: 'https://facebook/video.mp4', is_outgoing: 1, timestamp_ms: 104000 },
    { id: 3, fb_message_id: 'mid.$CUSTOMER', media_type: 'video', media_url: 'https://facebook/incoming.mp4', is_outgoing: 0, timestamp_ms: 105000 }
  ]);
  assert.deepEqual(rows.map((row) => row.id), [2, 3]);
});

test('keeps ambiguous rapid outgoing videos instead of hiding an intentional send', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    { id: 1, client_message_id: 'client-1', attachment_id: 'att-1', media_type: 'video', media_url: '/api/one', is_outgoing: 1, timestamp_ms: 100000 },
    { id: 2, client_message_id: 'client-2', attachment_id: 'att-2', media_type: 'video', media_url: '/api/two', is_outgoing: 1, timestamp_ms: 110000 },
    { id: 3, fb_message_id: 'mid.$VIDEO', media_type: 'video', media_url: 'https://facebook/video.mp4', is_outgoing: 1, timestamp_ms: 115000 }
  ]);
  assert.equal(rows.length, 3);
});

test('hides a delayed provisional sidebar echo of the same outbound text', async () => {
  const { collapseSidebarOutboundEchoes } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseSidebarOutboundEchoes([
    { id: 1, fb_message_id: 'mid.$OUT', content: 'cxxcxcxc', is_outgoing: 1, timestamp_ms: 100000 },
    { id: 2, fb_message_id: 'sidebar_preview_delayed', content: 'cxxcxcxc', is_outgoing: 0, timestamp_ms: 1500000 },
    { id: 3, fb_message_id: 'mid.$REAL_INCOMING', content: 'cxxcxcxc', is_outgoing: 0, timestamp_ms: 1500001 }
  ]);
  assert.deepEqual(rows.map((row) => row.id), [1, 3]);
});

test('removes a CRM video duplicate even when its Facebook timestamp is stale', async () => {
  const { collapseMessengerMediaCompanions } = await import('../../src/client/utils/messageDedup.js');
  const rows = collapseMessengerMediaCompanions([
    {
      id: 1, fb_message_id: 'mid.$OLD__bubble_1', client_message_id: 'client-video',
      attachment_id: 'att-video', media_type: 'video', is_outgoing: 1,
      timestamp_ms: 1789395660000, created_at: '2026-09-15 03:32:11'
    },
    {
      id: 2, fb_message_id: 'mid.$REAL_media', media_type: 'video',
      media_url: 'https://facebook/video.mp4', is_outgoing: 1,
      timestamp_ms: 1789443120000, created_at: '2026-09-15T03:32:00.000Z', sequence_order: 22
    }
  ]);
  assert.deepEqual(rows.map((row) => row.id), [2]);
  assert.equal(rows[0].sequence_order, 22);
});