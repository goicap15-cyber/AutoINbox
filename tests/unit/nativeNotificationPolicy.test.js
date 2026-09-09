const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '../..');

test('managed Chrome profiles automatically block native Facebook notifications', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'src/extension/manifest.json'),
    'utf8'
  ));
  const background = fs.readFileSync(
    path.join(projectRoot, 'src/extension/background.js'),
    'utf8'
  );
  const processManager = fs.readFileSync(
    path.join(projectRoot, 'src/server/services/ProcessManager.js'),
    'utf8'
  );

  assert.ok(manifest.permissions.includes('contentSettings'));
  assert.match(background, /contentSettings\.notifications\.set/);
  assert.match(background, /https:\/\/\[\*\.\]facebook\.com\/\*/);
  assert.match(background, /setting:\s*'block'/);
  assert.ok((processManager.match(/--disable-notifications/g) || []).length >= 2);
  assert.match(processManager, /default_content_setting_values\.notifications\s*=\s*2/);
});
