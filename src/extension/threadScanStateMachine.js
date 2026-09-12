/**
 * threadScanStateMachine.js
 * Máy trạng thái quét tin nhắn Page DOM: UNINITIALIZED -> BASELINING -> READY
 * Tương thích UMD (Browser Extension & CommonJS Node.js)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ThreadScanStateMachine = factory().ThreadScanStateMachine;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function generateUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'uuid_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
  }

  class ThreadScanStateMachine {
    constructor(threadId) {
      this.threadId = threadId;
      this.state = 'UNINITIALIZED'; // UNINITIALIZED, BASELINING, READY
      this.sessionEpoch = generateUuid();
      this.generation = 0;
      this.currentScanId = null;
      this.realtimeBuffer = [];
      this.bufferLimit = 100;
      this.bufferExpiryMs = 30000;
      this.onOverflow = null;
      this.ackTimeoutTimer = null;
    }

    getState() {
      return this.state;
    }

    getBufferSize() {
      return this.realtimeBuffer.length;
    }

    startBaselining() {
      this.state = 'BASELINING';
      this.generation += 1;
      this.currentScanId = generateUuid();
      return {
        thread_id: this.threadId,
        session_epoch: this.sessionEpoch,
        generation: this.generation,
        scan_id: this.currentScanId
      };
    }

    bufferRealtimeMessage(message) {
      if (this.state === 'READY') {
        return null;
      }
      this.realtimeBuffer.push({
        ...message,
        buffered_at: Date.now()
      });

      if (this.realtimeBuffer.length > this.bufferLimit) {
        if (typeof this.onOverflow === 'function') {
          this.onOverflow();
        }
      }
      return this.realtimeBuffer.length;
    }

    handleAck(ack) {
      if (!ack) return null;
      const { session_epoch, generation, scan_id, status } = ack;

      // Validate matching session_epoch, generation, scan_id
      const isMatch = session_epoch === this.sessionEpoch &&
                      generation === this.generation &&
                      scan_id === this.currentScanId;

      if (!isMatch) {
        return null;
      }

      if (status === 'committed' || status === 'duplicate') {
        this.state = 'READY';
        const flushed = [...this.realtimeBuffer];
        this.realtimeBuffer = [];
        return flushed;
      }

      // If retry_required or error, increment generation and retry
      this.generation += 1;
      this.currentScanId = generateUuid();
      this.state = 'BASELINING';
      return {
        thread_id: this.threadId,
        session_epoch: this.sessionEpoch,
        generation: this.generation,
        scan_id: this.currentScanId,
        retry: true
      };
    }

    reset() {
      this.state = 'UNINITIALIZED';
      this.sessionEpoch = generateUuid();
      this.generation = 0;
      this.currentScanId = null;
      this.realtimeBuffer = [];
    }
  }

  return {
    ThreadScanStateMachine
  };
});
