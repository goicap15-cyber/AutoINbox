// AutoChatbot - DOM realtime observer message-id/dedup logic.
//
// Mirrors (and must be kept in sync with) makeDomMessageId() and the
// lastObservedMessages Map decision in content.js's chatObserver callback.
// content.js can't be require()'d directly (top-level DOM/service-worker
// side effects), so this exists to make the id/dedup logic testable in
// isolation - same duplication pattern as historyRowSupport.js /
// historySyncRoundBudget.js.
//
// Spec: specs/045-ghost-duplicate-message-investigation/spec.md

(function () {
  // is_outgoing/sender_name/effective_label deliberately excluded from the
  // hash: all three are derived from the message row's aria-label, which can
  // still be hydrating on a MutationObserver's first pass, so a re-scan of
  // the SAME message that read a different label produced a DIFFERENT id -
  // landing as a ghost duplicate row with a flipped direction (spec 045).
  function makeDomMessageId(thread_id, parsed) {
    let textHash = 0;
    const strToHash = `${thread_id}|${parsed.content}`;
    for (let i = 0; i < strToHash.length; i++) {
      textHash = Math.imul(31, textHash) + strToHash.charCodeAt(i) | 0;
    }
    const stableId = parsed.native_id || `hash_${Math.abs(textHash)}`;
    return `dom_${thread_id}_${stableId}_${parsed.bubble_idx}`;
  }

  // Returns true when this reading should be SKIPPED (already forwarded with
  // the same id AND same direction). A same-id reading that now disagrees on
  // direction is NOT skipped - it must still reach the server (with the same
  // fbMessageId) so the existing reconcile/hysteresis path (spec 019) can
  // settle it, instead of a duplicate row or a silently-dropped correction.
  function shouldSkipObservation(lastObservedMessages, fbMessageId, isOutgoing) {
    return lastObservedMessages.get(fbMessageId) === isOutgoing;
  }

  globalThis.FbCrmDomMessageDedup = { makeDomMessageId, shouldSkipObservation };
})();
