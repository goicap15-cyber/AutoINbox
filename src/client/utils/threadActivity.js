const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

// SQLite CURRENT_TIMESTAMP is UTC even though it is stored without a timezone.
// Browsers otherwise interpret this shape as local time, which moves a freshly
// active thread backwards and breaks sidebar ordering.
export function normalizeThreadTimestamp(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return SQLITE_UTC_TIMESTAMP.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
}

export function threadActivityTime(thread) {
  const value = thread?.last_activity || thread?.updated_at || thread?.created_at || 0;
  const numeric = Number(value);
  if (typeof value !== 'string' && Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(normalizeThreadTimestamp(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortThreadsByActivity(threads = []) {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((left, right) => {
      const delta = threadActivityTime(right.thread) - threadActivityTime(left.thread);
      return delta || left.index - right.index;
    })
    .map(({ thread }) => thread);
}
