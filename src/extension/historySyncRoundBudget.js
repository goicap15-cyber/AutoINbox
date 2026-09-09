// AutoChatbot - History sync round-budget & stop-reason logic.
//
// This mirrors (and must be kept in sync with) the literal copy inlined
// inside the chrome.scripting.executeScript closure in background.js
// (handleSyncThreadMessages -> loadOlderMessages). That closure is injected
// into the Facebook tab and cannot require()/importScripts() this file, so
// the values here exist to make the mapping testable in isolation - same
// duplication pattern as textFilter.js (extension copy vs server copy).

(function () {
  const ROUND_BUDGET = { incremental: 1, initial: 12, deep_backfill: 20 };
  const DEFAULT_MAX_ROUNDS = 5;

  function getMaxRounds(mode) {
    return ROUND_BUDGET[mode] || DEFAULT_MAX_ROUNDS;
  }

  function decideStopReason({ boundaryReached, noScrollGrowth }) {
    if (boundaryReached) return 'boundary_reached';
    if (noScrollGrowth) return 'no_scroll_growth';
    return 'max_rounds_hit';
  }

  globalThis.FbCrmHistorySyncRoundBudget = {
    ROUND_BUDGET,
    DEFAULT_MAX_ROUNDS,
    getMaxRounds,
    decideStopReason
  };
})();
