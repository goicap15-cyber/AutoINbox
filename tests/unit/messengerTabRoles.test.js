const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Roles = require('../../src/extension/messengerTabRoles');

test('maps registered tabs to independent chat, campaign, discovery and history roles', () => {
  const entries = [
    [Roles.roleKey('a1', 'chat'), 11],
    [Roles.roleKey('a1', 'campaign'), 12],
    [Roles.roleKey('a1', 'discovery'), 13],
    [Roles.roleKey('a1', 'history'), 14]
  ];
  assert.equal(Roles.roleForTab(entries, 'a1', 11), 'chat');
  assert.equal(Roles.roleForTab(entries, 'a1', 12), 'campaign');
  assert.equal(Roles.roleForTab(entries, 'a1', 13), 'discovery');
  assert.equal(Roles.roleForTab(entries, 'a1', 14), 'history');
});

test('legacy personal and interaction keys map only to chat', () => {
  assert.equal(Roles.roleForTab([['personal:a1', 7]], 'a1', 7), 'chat');
  assert.equal(Roles.roleForTab([[Roles.roleKey('a1', 'interaction'), 8]], 'a1', 8), 'chat');
});

test('campaign, history and request tabs never forward realtime rows', () => {
  for (const role of ['campaign', 'history', 'requests', 'request_action']) {
    assert.equal(Roles.canForwardRealtime(role), false);
    assert.equal(Roles.canForwardIncomingRealtime(role), false);
    assert.equal(Roles.canForwardCallRealtime(role), false);
  }
});

test('only chat and discovery surfaces forward realtime events', () => {
  assert.equal(Roles.canForwardRealtime('chat'), true);
  assert.equal(Roles.canForwardRealtime('discovery'), true);
  assert.equal(Roles.canForwardRealtime(null), false);
  assert.equal(Roles.canForwardCallRealtime('chat'), true);
  assert.equal(Roles.canForwardCallRealtime('discovery'), true);
});

test('background reuses the stable interaction tab for operator sends', () => {
  const background = fs.readFileSync(path.join(__dirname, '../../src/extension/background.js'), 'utf8');
  assert.match(background, /case 'SEND_MESSAGE':[\s\S]+?await handleSendMessage\(message\.data\)/);
  assert.match(background, /const personalRole = data\.campaign_id \? 'campaign' : 'interaction'/);
  assert.ok(background.includes("runPersonalSendSerialized(`${data.account_id || user_id}:${personalRole}`"));
  assert.match(background, /tab_role: personalRole/);
  assert.match(background, /ensureRoleMessengerTab\(targetAcc, 'history'\)/);
  assert.match(background, /beginPersonalNavigation\(`\$\{targetAcc\}:history`\)/);
  assert.match(background, /ensureRoleMessengerTab\(user_id, 'interaction'\)/);
  assert.doesNotMatch(background, /Promise\.all\(\[[\s\S]*ensureRoleMessengerTab\(user_id, 'campaign'\)/);
});

test('discovery/history automation tabs cannot be adopted as the interaction tab', () => {
  const background = fs.readFileSync(path.join(__dirname, '../../src/extension/background.js'), 'utf8');
  assert.match(background, /const DEDICATED_MESSENGER_ROLES = new Set/);
  assert.match(background, /isDedicatedMessengerRoleTab\(accountId, registered\.id\)/);
  assert.match(background, /if \(!await isDedicatedMessengerRoleTab\(accountId, candidate\.id\)\)/);
  assert.match(background, /interactionCandidates\.find/);
});
