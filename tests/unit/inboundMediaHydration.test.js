const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const InboundMediaHydrationService = require('../../src/server/services/InboundMediaHydrationService');

function createDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      fb_message_id TEXT,
      media_type TEXT,
      media_url TEXT,
      local_media_path TEXT
    )
  `);
  return database;
}

test('incoming media hydration updates the surviving durable row and coalesces duplicate work', async () => {
  const database = createDatabase();
  database.prepare(`
    INSERT INTO messages (id, thread_id, fb_message_id, media_type, media_url)
    VALUES (1, 'thread-a', 'facebook-parent', 'image', 'https://example.test/photo.jpg')
  `).run();

  let downloadCount = 0;
  const hydrated = [];
  const service = new InboundMediaHydrationService({
    database,
    downloader: {
      async downloadNewMessageMedia() {
        downloadCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return '/data/media/thread-a/photo.jpg';
      }
    },
    onHydrated: (row) => hydrated.push(row)
  });

  const row = database.prepare('SELECT * FROM messages WHERE id = 1').get();
  const first = service.hydrateRow(row);
  const second = service.hydrateRow(row);
  assert.equal(first, second);
  await Promise.all([first, second]);

  assert.equal(downloadCount, 1);
  assert.equal(hydrated.length, 1);
  assert.equal(
    database.prepare('SELECT local_media_path FROM messages WHERE id = 1').get().local_media_path,
    '/data/media/thread-a/photo.jpg'
  );
  database.close();
});

test('thread hydration selects only missing downloadable media rows', async () => {
  const database = createDatabase();
  const insert = database.prepare(`
    INSERT INTO messages (id, thread_id, fb_message_id, media_type, media_url, local_media_path)
    VALUES (?, 'thread-b', ?, ?, ?, ?)
  `);
  insert.run(1, 'video-row', 'video', 'https://example.test/video.mp4', null);
  insert.run(2, 'text-row', 'text', null, null);
  insert.run(3, 'local-image', 'image', 'https://example.test/photo.jpg', '/data/media/thread-b/photo.jpg');

  const service = new InboundMediaHydrationService({
    database,
    downloader: {
      async downloadNewMessageMedia() {
        return '/data/media/thread-b/video.mp4';
      }
    }
  });

  assert.equal(service.hydrateThread('thread-b'), 1);
  await Promise.all([...service.inFlight.values()]);
  assert.equal(
    database.prepare('SELECT local_media_path FROM messages WHERE id = 1').get().local_media_path,
    '/data/media/thread-b/video.mp4'
  );
  database.close();
});

test('duplicate database rows sharing one video URL download only once', async () => {
  const database = createDatabase();
  const insert = database.prepare(`INSERT INTO messages
    (id, thread_id, fb_message_id, media_type, media_url)
    VALUES (?, 'thread-c', ?, 'video', 'https://example.test/shared.mp4')`);
  insert.run(1, 'video-a');
  insert.run(2, 'video-b');
  let downloads = 0;
  const service = new InboundMediaHydrationService({
    database,
    downloader: { async downloadNewMessageMedia() { downloads += 1; return '/data/media/thread-c/shared.mp4'; } }
  });
  service.hydrateThread('thread-c');
  await Promise.all([...service.inFlight.values()]);
  assert.equal(downloads, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE local_media_path <> ''`).get().count, 2);
  database.close();
});
