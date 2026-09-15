/**
 * threadGuard.js
 * Tiện ích kiểm tra và bảo vệ thread ID chống rác, sentinel và các chuỗi giao diện
 */

const BLACKLISTED_THREAD_IDS = new Set([
  'unknown_thread',
  'unknown_dom',
  'unknown',
  'null',
  'undefined'
]);

function isBlacklistedThreadId(threadId) {
  if (threadId === null || threadId === undefined) return true;
  const str = String(threadId).trim();
  if (!str) return true;
  if (BLACKLISTED_THREAD_IDS.has(str.toLowerCase())) return true;
  return false;
}

module.exports = {
  isBlacklistedThreadId,
  BLACKLISTED_THREAD_IDS
};
