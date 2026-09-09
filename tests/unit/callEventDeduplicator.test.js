const test = require('node:test');
const assert = require('node:assert/strict');
const CallEventDeduplicator = require('../../src/server/services/CallEventDeduplicator');

test('deduplicates one outgoing call action during the cooldown', () => {
  const dedupe = new CallEventDeduplicator({ outgoingCooldownMs: 10000 });
  const call = { accountId: 'a1', threadId: 't1', callType: 'audio' };
  assert.equal(dedupe.claimOutgoing(call, 10000), true);
  assert.equal(dedupe.claimOutgoing(call, 15000), false);
  assert.equal(dedupe.claimOutgoing(call, 20001), true);
});

test('deduplicates incoming ringing across profiles by caller when thread is unknown', () => {
  const dedupe = new CallEventDeduplicator({ incomingCooldownMs: 5000 });
  assert.equal(dedupe.claimIncoming({ callerName: 'Khang' }, 10000), true);
  assert.equal(dedupe.claimIncoming({ callerName: ' khang ' }, 12000), false);
  assert.equal(dedupe.claimIncoming({ callerName: 'Khang' }, 16000), true);
});
