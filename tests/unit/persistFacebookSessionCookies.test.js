const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors background.js's persistFacebookSessionCookies(). background.js runs
// heavy top-level side effects on load (importScripts, connectWebSocket(),
// chrome.alarms.create) that would need an elaborate service-worker shim to
// load safely via vm.runInContext, so this is a plain mirror copy - same
// duplication pattern as historySyncRoundBudget.js/historyRowSupport.js for
// other background.js logic. Keep both copies in sync.
const FB_SESSION_COOKIE_NAMES = ['c_user', 'xs'];
const FB_COOKIE_URL = 'https://www.facebook.com/';

async function persistFacebookSessionCookies(chromeApi) {
  if (!chromeApi?.cookies) return;
  for (const name of FB_SESSION_COOKIE_NAMES) {
    try {
      const cookie = await chromeApi.cookies.get({ url: FB_COOKIE_URL, name });
      if (!cookie || !cookie.session) continue;
      const oneYearFromNowSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
      await chromeApi.cookies.set({
        url: FB_COOKIE_URL,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: oneYearFromNowSeconds
      });
    } catch (_err) {
      // swallow - matches background.js's per-cookie try/catch
    }
  }
}

function makeMockChrome(cookieMap) {
  const setCalls = [];
  return {
    setCalls,
    cookies: {
      get: async ({ name }) => cookieMap[name] || null,
      set: async (details) => { setCalls.push(details); return details; }
    }
  };
}

test('rewrites a session-only cookie with a far-future expirationDate', async () => {
  const chromeApi = makeMockChrome({
    c_user: { name: 'c_user', value: '100008005082872', domain: '.facebook.com', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', session: true },
    xs: { name: 'xs', value: 'abc123', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: true }
  });

  await persistFacebookSessionCookies(chromeApi);

  assert.equal(chromeApi.setCalls.length, 2);
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const call of chromeApi.setCalls) {
    assert.equal(call.value, call.name === 'c_user' ? '100008005082872' : 'abc123');
    assert.ok(call.expirationDate > nowSeconds + 60 * 60 * 24 * 300, 'expirationDate should be roughly a year out');
  }
});

test('leaves an already-persistent cookie untouched', async () => {
  const chromeApi = makeMockChrome({
    c_user: { name: 'c_user', value: '100008005082872', session: false, expirationDate: Date.now() / 1000 + 999999 },
    xs: { name: 'xs', value: 'abc123', session: false, expirationDate: Date.now() / 1000 + 999999 }
  });

  await persistFacebookSessionCookies(chromeApi);

  assert.equal(chromeApi.setCalls.length, 0);
});

test('does nothing when the cookie is missing entirely (not logged in yet)', async () => {
  const chromeApi = makeMockChrome({});

  await persistFacebookSessionCookies(chromeApi);

  assert.equal(chromeApi.setCalls.length, 0);
});

test('does not throw when chrome.cookies is unavailable', async () => {
  await assert.doesNotReject(() => persistFacebookSessionCookies({}));
  await assert.doesNotReject(() => persistFacebookSessionCookies(null));
});
