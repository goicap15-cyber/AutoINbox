const test = require('node:test');
const assert = require('node:assert/strict');
const { ThreadScanStateMachine } = require('../../src/extension/threadScanStateMachine');

test('T006: state machine chuyển UNINITIALIZED -> BASELINING -> READY khi nhận ACK committed', () => {
  const sm = new ThreadScanStateMachine('thread_123');
  assert.equal(sm.getState(), 'UNINITIALIZED');

  const baselineReq = sm.startBaselining();
  assert.equal(sm.getState(), 'BASELINING');
  assert.ok(baselineReq.session_epoch);
  assert.equal(baselineReq.generation, 1);
  assert.ok(baselineReq.scan_id);

  // Tin realtime đến trong lúc BASELINING được gom vào buffer
  sm.bufferRealtimeMessage({ fb_message_id: 'realtime_1', content: 'Khách nhắn trong lúc quét' });
  assert.equal(sm.getBufferSize(), 1);

  // Nhận ACK committed khớp đúng epoch, generation, scan_id
  const ack = {
    thread_id: 'thread_123',
    session_epoch: baselineReq.session_epoch,
    generation: baselineReq.generation,
    scan_id: baselineReq.scan_id,
    status: 'committed'
  };

  const flush = sm.handleAck(ack);
  assert.equal(sm.getState(), 'READY');
  assert.equal(flush.length, 1);
  assert.equal(flush[0].fb_message_id, 'realtime_1');
  assert.equal(sm.getBufferSize(), 0);
});

test('T006: timeout 10s hoặc ACK lỗi chuyển sang retry generation mới và bảo toàn buffer', () => {
  const sm = new ThreadScanStateMachine('thread_123');
  const req1 = sm.startBaselining();

  sm.bufferRealtimeMessage({ fb_message_id: 'realtime_1', content: 'Tin buffer' });

  // Giả lập ACK retry_required
  const ackRetry = {
    thread_id: 'thread_123',
    session_epoch: req1.session_epoch,
    generation: req1.generation,
    scan_id: req1.scan_id,
    status: 'retry_required',
    reason: 'missing_anchor'
  };

  const req2 = sm.handleAck(ackRetry);
  assert.equal(sm.getState(), 'BASELINING');
  assert.equal(req2.generation, 2); // Tăng generation
  assert.equal(req2.session_epoch, req1.session_epoch); // Giữ nguyên session_epoch
  assert.equal(sm.getBufferSize(), 1); // Buffer được bảo toàn
});

test('T006: chính sách tràn bộ đệm (buffer overflow 100 tin)', () => {
  const sm = new ThreadScanStateMachine('thread_123');
  sm.startBaselining();

  // Nhồi 101 tin
  let overflowTriggered = false;
  sm.onOverflow = () => { overflowTriggered = true; };

  for (let i = 0; i < 101; i++) {
    sm.bufferRealtimeMessage({ fb_message_id: `m_${i}`, content: `tin ${i}` });
  }

  assert.equal(overflowTriggered, true);
});
