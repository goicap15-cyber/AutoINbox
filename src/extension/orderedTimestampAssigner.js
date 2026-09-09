// AutoChatbot - page_content.js's synthetic dom-order timestamp assignment.
//
// Mirrors (and must be kept in sync with) assignOrderedTimestamps() in
// page_content.js. That closure captures module-level state (knownMessageTimestamps,
// Date.now()) directly and can't require() this file, so this exists to make
// the assignment logic testable in isolation - same duplication pattern as
// historyRowSupport.js / domMessageDedup.js.
//
// Spec: specs/047-page-timestamp-ordering-fix/spec.md

(function () {
  const DEFAULT_ORDER_GAP_MS = 1000;
  // How far behind `now` a forward-extrapolated timestamp is allowed to drift
  // before it's treated as an untrustworthy stale anchor rather than a real
  // recent time. Live evidence (2026-08-19): a message captured at 09:33 was
  // assigned a synthetic timestamp of 04:41 by unbounded extrapolation from a
  // ~5-hour-old anchor - this bound catches exactly that class of drift.
  const DEFAULT_STALE_ANCHOR_MS = 5 * 60 * 1000;

  /**
   * @param {Array<string|null>} orderedIds - message ids in current DOM order.
   * @param {Map<string, number>} knownMessageTimestamps - mutated in place, same as the live code.
   * @param {object} [opts]
   * @param {number} [opts.orderGapMs]
   * @param {number} [opts.staleAnchorMs]
   * @param {() => number} [opts.now] - injectable clock for tests.
   */
  function assignOrderedTimestamps(orderedIds, knownMessageTimestamps, opts = {}) {
    const orderGapMs = opts.orderGapMs ?? DEFAULT_ORDER_GAP_MS;
    const staleAnchorMs = opts.staleAnchorMs ?? DEFAULT_STALE_ANCHOR_MS;
    const now = opts.now ?? Date.now;

    let lastKnownIdx = -1;
    let lastKnownTs = null;

    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!id) continue;
      if (knownMessageTimestamps.has(id)) {
        lastKnownIdx = i;
        lastKnownTs = knownMessageTimestamps.get(id);
        continue;
      }

      let nextKnownIdx = -1;
      let nextKnownTs = null;
      for (let j = i + 1; j < orderedIds.length; j++) {
        if (orderedIds[j] && knownMessageTimestamps.has(orderedIds[j])) {
          nextKnownIdx = j;
          nextKnownTs = knownMessageTimestamps.get(orderedIds[j]);
          break;
        }
      }

      let assigned;
      if (lastKnownTs !== null && nextKnownTs !== null && nextKnownTs > lastKnownTs) {
        const span = nextKnownIdx - lastKnownIdx;
        const pos = i - lastKnownIdx;
        assigned = Math.round(lastKnownTs + (nextKnownTs - lastKnownTs) * (pos / span));
        if (assigned <= lastKnownTs) assigned = lastKnownTs + 1;
        if (assigned >= nextKnownTs) assigned = nextKnownTs - 1;
      } else if (lastKnownTs !== null) {
        assigned = lastKnownTs + orderGapMs * (i - lastKnownIdx);
        if (now() - assigned > staleAnchorMs) {
          assigned = now() - orderGapMs * (orderedIds.length - i);
        }
      } else if (nextKnownTs !== null) {
        assigned = nextKnownTs - orderGapMs * (nextKnownIdx - i);
      } else {
        assigned = now() - orderGapMs * (orderedIds.length - i);
      }

      knownMessageTimestamps.set(id, assigned);
      lastKnownIdx = i;
      lastKnownTs = assigned;
    }
  }

  globalThis.FbCrmOrderedTimestampAssigner = { assignOrderedTimestamps, DEFAULT_ORDER_GAP_MS, DEFAULT_STALE_ANCHOR_MS };
})();
