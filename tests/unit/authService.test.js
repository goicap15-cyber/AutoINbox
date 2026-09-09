const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const { AuthService, hashToken, parseCookies } = require('../../src/server/services/AuthService');

test('registration creates STAFF and login creates a hashed server-side session', () => {
  const db = getTestDatabase();
  try {
    const auth = new AuthService(db);
    const user = auth.register({ username: '  Staff.One ', password: 'secure-pass-123' });
    assert.deepEqual(user, { id: user.id, username: 'staff.one', role: 'STAFF', company_id: user.id, company_role: 'ADMIN' });

    const login = auth.login({ username: 'STAFF.ONE', password: 'secure-pass-123' });
    assert.equal(login.user.id, user.id);
    assert.ok(login.token.length >= 40);
    const stored = db.prepare('SELECT token_hash FROM auth_sessions WHERE user_id = ?').get(user.id);
    assert.equal(stored.token_hash, hashToken(login.token));
    assert.notEqual(stored.token_hash, login.token);
    assert.deepEqual(auth.getUserByToken(login.token), user);
  } finally {
    db.close();
  }
});

test('registration rejects duplicate names and weak passwords without granting ADMIN', () => {
  const db = getTestDatabase();
  try {
    const auth = new AuthService(db);
    assert.throws(() => auth.register({ username: 'worker', password: 'short' }), { code: 'INVALID_PASSWORD' });
    auth.register({ username: 'worker', password: 'long-enough-password' });
    assert.throws(() => auth.register({ username: 'WORKER', password: 'another-password' }), { code: 'USERNAME_TAKEN' });
    assert.equal(db.prepare("SELECT role FROM users WHERE username = 'worker'").get().role, 'STAFF');
  } finally {
    db.close();
  }
});

test('invalid login is generic and logout revokes the cookie session', () => {
  const db = getTestDatabase();
  try {
    const auth = new AuthService(db);
    auth.register({ username: 'operator', password: 'valid-password' });
    assert.throws(() => auth.login({ username: 'missing', password: 'valid-password' }), { code: 'INVALID_CREDENTIALS' });
    assert.throws(() => auth.login({ username: 'operator', password: 'wrong-password' }), { code: 'INVALID_CREDENTIALS' });

    const login = auth.login({ username: 'operator', password: 'valid-password' });
    const request = { headers: { cookie: `theme=dark; crm_session=${encodeURIComponent(login.token)}` } };
    assert.equal(auth.getRequestUser(request).username, 'operator');
    auth.revokeRequestSession(request);
    assert.equal(auth.getRequestUser(request), null);
  } finally {
    db.close();
  }
});

test('cookie parser preserves values containing equals signs', () => {
  assert.deepEqual(parseCookies('a=one; token=abc%3D%3D'), { a: 'one', token: 'abc==' });
});

test('managed login migrates a valid legacy local account to central auth', async () => {
  const db = getTestDatabase();
  try {
    const auth = new AuthService(db);
    auth.register({ username: 'legacy.user', password: 'legacy-password' });
    const calls = [];
    const central = {
      async login() {
        calls.push('login');
        if (calls.length === 1) throw Object.assign(new Error('missing'), { code: 'USER_NOT_FOUND' });
        return { username: 'legacy.user', status: 'ACTIVE' };
      },
      async register() { calls.push('register'); }
    };
    const result = await auth.loginManaged({ username: 'legacy.user', password: 'legacy-password' }, central);
    assert.equal(result.user.username, 'legacy.user');
    assert.deepEqual(calls, ['login', 'register', 'login']);
  } finally { db.close(); }
});
