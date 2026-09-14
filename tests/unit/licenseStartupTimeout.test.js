const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('desktop license startup cannot remain on an infinite loading screen', () => {
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(app, /setTimeout\(\(\) => controller\.abort\(\), 8000\)/);
  assert.match(app, /reason: e\?\.name === 'AbortError' \? 'LICENSE_CHECK_TIMEOUT'/);
  assert.match(app, /setLicenseStatus\(\{[\s\S]+?isLicensed: false/);
});

test('server license checks have a shorter upstream timeout', () => {
  const server = fs.readFileSync('src/server/server.js', 'utf8');
  const checker = fs.readFileSync('src/server/services/LicenseChecker.js', 'utf8');
  assert.match(server, /setTimeout\(\(\) => licenseAbortController\.abort\(\), 5000\)/);
  assert.match(server, /signal: licenseAbortController\.signal/);
  assert.match(checker, /fetchLicenseWithTimeout[\s\S]+?timeoutMs = 5000/);
});
