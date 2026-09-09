import { getReminderDueState } from './reminderPresentation.js';

export const SOURCE_TYPE_KEYS = {
  PERSONAL: 'type:personal_messenger',
  PAGE: 'type:page_messenger'
};

const KNOWN_SOURCE_TYPE_KEYS = new Set(Object.values(SOURCE_TYPE_KEYS));
const WORKFLOW_STATES = new Set(['UNPROCESSED', 'ASSIGNED', 'COMPLETED']);
const REMINDER_STATES = new Set(['due', 'today', 'future', 'none']);
const CONTACT_FIELDS = new Set(['phone', 'email', 'address']);
const ARCHIVE_SCOPES = new Set(['inbox', 'archived', 'all']);
const ACTIVITY_TYPES = new Set(['all', 'today', 'last7', 'last30', 'range']);
const QUICK_FILTERS = new Set(['due', 'unread', 'vip', 'needs_work']);

export function normalizeSourceKey(value) {
  const key = String(value || '').trim();
  if (KNOWN_SOURCE_TYPE_KEYS.has(key)) return key;
  if (key.startsWith('source:') && key.slice('source:'.length).trim()) return key;
  if (key.startsWith('account:') && key.slice('account:'.length).trim()) return key;
  return null;
}

export function getAvailableSourceTypeKeys(availableSources = []) {
  const available = new Set();
  for (const source of Array.isArray(availableSources) ? availableSources : []) {
    const key = normalizeSourceKey('type:' + (source?.source_type || ''));
    if (key) available.add(key);
  }
  return [...available];
}

function uniqueStrings(values, normalize = (value) => String(value || '').trim()) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeTag(value) {
  return String(value || '').trim().toLocaleLowerCase('vi-VN');
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(new Date(text + 'T00:00:00').getTime()) ? text : '';
}

function normalizeActivityRange(value) {
  const type = ACTIVITY_TYPES.has(value?.type) ? value.type : 'all';
  if (type !== 'range') return { type };
  const from = normalizeDate(value?.from);
  const to = normalizeDate(value?.to);
  if (!from && !to) return { type: 'all' };
  return { type, from, to };
}

function normalizeRule(rule) {
  const field = String(rule?.field || '').trim();
  const operator = String(rule?.operator || '').trim();
  const value = rule?.value;
  const id = String(rule?.id || '').trim() || String(Date.now()) + Math.random().toString(36).slice(2);
  if (field === 'tag' && ['has', 'not_has'].includes(operator)) {
    const tag = normalizeTag(value);
    return tag ? { id, field, operator, value: tag } : null;
  }
  if (field === 'contact' && ['has', 'not_has'].includes(operator) && CONTACT_FIELDS.has(String(value))) {
    return { id, field, operator, value: String(value) };
  }
  if (field === 'activity' && ['before', 'after'].includes(operator) && normalizeDate(value)) {
    return { id, field, operator, value: normalizeDate(value) };
  }
  if (field === 'activity' && operator === 'between' && normalizeDate(value?.from) && normalizeDate(value?.to)) {
    return { id, field, operator, value: { from: normalizeDate(value.from), to: normalizeDate(value.to) } };
  }
  if (field === 'reminder' && operator === 'is' && REMINDER_STATES.has(String(value))) {
    return { id, field, operator, value: String(value) };
  }
  if (field === 'archive' && operator === 'is' && ARCHIVE_SCOPES.has(String(value))) {
    return { id, field, operator, value: String(value) };
  }
  return null;
}

export function createDefaultFilters() {
  // Keep the Spec 029 public default shape for callers/tests that only need
  // source and lead-status filtering. Advanced callers use normalizeFilters.
  return { sourceKeys: [], statusIds: [] };
}

export function normalizeFilters(filters) {
  const base = { archiveScope: 'inbox' };
  const sourceKeys = uniqueStrings(filters?.sourceKeys, normalizeSourceKey);
  const statusIds = uniqueStrings(filters?.statusIds);
  const workflowStates = uniqueStrings(filters?.workflowStates).filter((value) => WORKFLOW_STATES.has(value));
  const tagNames = uniqueStrings(filters?.tagNames, normalizeTag);
  const quickFilters = uniqueStrings(filters?.quickFilters).filter((value) => QUICK_FILTERS.has(value));
  const unreadStates = uniqueStrings(filters?.unreadStates).filter((value) => value === 'unread' || value === 'read');
  const reminderStates = uniqueStrings(filters?.reminderStates).filter((value) => REMINDER_STATES.has(value));
  const contactFields = uniqueStrings(filters?.contactFields).filter((value) => CONTACT_FIELDS.has(value));
  const archiveScope = ARCHIVE_SCOPES.has(filters?.archiveScope) ? filters.archiveScope : base.archiveScope;
  const rules = (Array.isArray(filters?.rules) ? filters.rules : []).map(normalizeRule).filter(Boolean);
  return { sourceKeys, statusIds, workflowStates, tagNames, quickFilters, unreadStates, reminderStates, contactFields, archiveScope, activityRange: normalizeActivityRange(filters?.activityRange), rules };
}

export function cloneFilters(filters) {
  const clean = normalizeFilters(filters);
  const advancedKeys = ['workflowStates', 'tagNames', 'quickFilters', 'unreadStates', 'reminderStates', 'contactFields', 'archiveScope', 'activityRange', 'rules'];
  const isAdvanced = advancedKeys.some((key) => Object.prototype.hasOwnProperty.call(filters || {}, key));
  if (!isAdvanced) return { sourceKeys: clean.sourceKeys, statusIds: clean.statusIds };
  return { ...clean, activityRange: { ...clean.activityRange }, rules: clean.rules.map((rule) => ({ ...rule, value: typeof rule.value === 'object' ? { ...rule.value } : rule.value })) };
}

export function countActiveFilters(filters) {
  const clean = normalizeFilters(filters);
  return clean.sourceKeys.length + clean.statusIds.length + clean.workflowStates.length + clean.tagNames.length + clean.quickFilters.length + clean.unreadStates.length + clean.reminderStates.length + clean.contactFields.length + clean.rules.length + (clean.archiveScope !== 'inbox' ? 1 : 0) + (clean.activityRange.type !== 'all' ? 1 : 0);
}

export function hasActiveFilters(filters) { return countActiveFilters(filters) > 0; }

export function areFiltersEqual(a, b) {
  const canonicalize = (filters) => {
    const clean = normalizeFilters(filters);
    return {
      ...clean,
      sourceKeys: [...clean.sourceKeys].sort(), statusIds: [...clean.statusIds].sort(), workflowStates: [...clean.workflowStates].sort(),
      tagNames: [...clean.tagNames].sort(), quickFilters: [...clean.quickFilters].sort(), unreadStates: [...clean.unreadStates].sort(),
      reminderStates: [...clean.reminderStates].sort(), contactFields: [...clean.contactFields].sort(),
      rules: [...clean.rules].sort((left, right) => left.id.localeCompare(right.id))
    };
  };
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function toggleQuickFilter(filters, key) {
  const clean = normalizeFilters(filters);
  // Keep an in-progress manual rule intact while the user tests a quick filter.
  // Validation happens only on Apply, never as a side effect of another draft edit.
  if (Array.isArray(filters?.rules)) clean.rules = filters.rules.map((rule) => ({ ...rule, value: typeof rule?.value === 'object' && rule.value ? { ...rule.value } : rule?.value }));
  if (!QUICK_FILTERS.has(key)) return clean;
  clean.quickFilters = clean.quickFilters.includes(key) ? clean.quickFilters.filter((item) => item !== key) : [...clean.quickFilters, key];
  return clean;
}

export function sanitizeFilters(filters, availableSources = [], availableStatuses = [], availableAccounts = []) {
  const clean = normalizeFilters(filters);
  // type:personal_messenger and type:page_messenger are always valid — they are core source type keys,
  // not dependent on what inboxSources are loaded (personal threads have no inbox_sources row).
  const validSourceKeys = new Set([
    SOURCE_TYPE_KEYS.PERSONAL,
    SOURCE_TYPE_KEYS.PAGE,
    ...getAvailableSourceTypeKeys(availableSources),
    ...(Array.isArray(availableSources) ? availableSources : []).filter((source) => source?.id != null && String(source.id).trim()).map((source) => 'source:' + source.id),
    // account:<id> keys mirror source:<id> for Pages, but scoped to currently
    // connected personal Facebook accounts - removing an account drops its
    // filter key here too instead of leaving a stale selection with no effect.
    ...(Array.isArray(availableAccounts) ? availableAccounts : []).filter((account) => account?.id != null && String(account.id).trim()).map((account) => 'account:' + account.id)
  ]);
  const validStatusIds = new Set((Array.isArray(availableStatuses) ? availableStatuses : []).map((status) => String(status.id)));
  clean.sourceKeys = clean.sourceKeys.filter((key) => validSourceKeys.has(key));
  clean.statusIds = clean.statusIds.filter((id) => validStatusIds.has(id));
  const advancedKeys = ['workflowStates', 'tagNames', 'quickFilters', 'unreadStates', 'reminderStates', 'contactFields', 'archiveScope', 'activityRange', 'rules'];
  const isAdvanced = advancedKeys.some((key) => Object.prototype.hasOwnProperty.call(filters || {}, key));
  return isAdvanced ? clean : { sourceKeys: clean.sourceKeys, statusIds: clean.statusIds };
}

export function isManualRuleComplete(rule) {
  return Boolean(normalizeRule(rule));
}

export function getAvailableTagOptions(threads = []) {
  const options = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    let rawTags = [];
    try { rawTags = Array.isArray(thread?.tags) ? thread.tags : JSON.parse(thread?.tags || '[]'); } catch (_) { rawTags = []; }
    for (const rawTag of Array.isArray(rawTags) ? rawTags : []) {
      const label = String(rawTag || '').trim();
      const value = normalizeTag(label);
      if (value && !options.has(value)) options.set(value, label);
    }
  }
  return [...options.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label, 'vi'));
}

function parseTags(rawTags) {
  try {
    const values = Array.isArray(rawTags) ? rawTags : JSON.parse(rawTags || '[]');
    return uniqueStrings(values, normalizeTag);
  } catch (_) {
    return [];
  }
}

function hasContactField(thread, field) { return Boolean(String(thread?.[field] || '').trim()); }
function parseTime(value) { const timestamp = new Date(value).getTime(); return Number.isFinite(timestamp) ? timestamp : null; }
function isSameLocalDay(timestamp, now) {
  const a = new Date(timestamp); const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function matchesReminderState(thread, state, now) {
  const dueAt = parseTime(thread?.reminder_due_at);
  const active = !thread?.reminder_status || thread.reminder_status === 'active';
  if (state === 'due') return getReminderDueState(thread, now).isDue;
  if (state === 'today') return Boolean(active && dueAt != null && isSameLocalDay(dueAt, now));
  if (state === 'future') return Boolean(active && dueAt != null && dueAt > now);
  return !active || dueAt == null;
}
function matchesArchiveScope(thread, scope, now) {
  if (scope === 'all') return true;
  if (scope === 'archived') return Boolean(thread?.archived_at);
  return !thread?.archived_at || getReminderDueState(thread, now).isDue;
}
function matchesActivity(thread, range, now) {
  if (range.type === 'all') return true;
  const timestamp = parseTime(thread?.last_activity);
  if (timestamp == null) return false;
  if (range.type === 'today') return isSameLocalDay(timestamp, now);
  if (range.type === 'last7') return timestamp >= now - 7 * 24 * 60 * 60 * 1000;
  if (range.type === 'last30') return timestamp >= now - 30 * 24 * 60 * 60 * 1000;
  const from = range.from ? parseTime(range.from + 'T00:00:00') : null;
  const to = range.to ? parseTime(range.to + 'T23:59:59.999') : null;
  return (from == null || timestamp >= from) && (to == null || timestamp <= to);
}
function matchesRule(thread, rule, now) {
  const tags = parseTags(thread?.tags);
  if (rule.field === 'tag') { const has = tags.includes(rule.value); return rule.operator === 'has' ? has : !has; }
  if (rule.field === 'contact') { const has = hasContactField(thread, rule.value); return rule.operator === 'has' ? has : !has; }
  if (rule.field === 'activity') { const time = parseTime(thread?.last_activity); if (time == null) return false; if (rule.operator === 'before') return time < parseTime(rule.value + 'T00:00:00'); if (rule.operator === 'after') return time >= parseTime(rule.value + 'T00:00:00'); return matchesActivity(thread, { type: 'range', ...rule.value }, now); }
  if (rule.field === 'reminder') return matchesReminderState(thread, rule.value, now);
  if (rule.field === 'archive') return matchesArchiveScope(thread, rule.value, now);
  return true;
}

export function matchesConversationFilters(thread, filters, now = Date.now()) {
  if (!thread) return false;
  const clean = normalizeFilters(filters);
  if (!matchesArchiveScope(thread, clean.archiveScope, now)) return false;
  if (clean.sourceKeys.length) {
    // Determine source type: prefer explicit source_type from JOIN, then fall back by source_id presence.
    // Personal threads: source_id = null AND source_type = null (no inbox_sources row).
    // Page threads: source_id = 'src_page_...' AND source_type = 'page_messenger'.
    const threadSourceType = thread.source_type ||
      (thread.source_id != null && String(thread.source_id).startsWith('src_page_') ? 'page_messenger' : 'personal_messenger');
    const typeKey = 'type:' + threadSourceType;
    const idKey = thread.source_id != null ? 'source:' + thread.source_id : null;
    const accountKey = thread.account_id != null ? 'account:' + thread.account_id : null;
    if (!clean.sourceKeys.some((key) => key === typeKey || (idKey && key === idKey) || (accountKey && key === accountKey))) return false;
  }
  if (clean.statusIds.length && !clean.statusIds.includes(String(thread.status_id ?? ''))) return false;
  if (clean.workflowStates.length && !clean.workflowStates.includes(String(thread.status || ''))) return false;
  const tags = parseTags(thread.tags);
  if (clean.tagNames.length && !clean.tagNames.some((tag) => tags.includes(tag))) return false;
  if (clean.unreadStates.length) { const unread = Number(thread.unread_count || (thread.is_unread ? 1 : 0)) > 0; if (!clean.unreadStates.some((state) => state === (unread ? 'unread' : 'read'))) return false; }
  if (clean.reminderStates.length && !clean.reminderStates.some((state) => matchesReminderState(thread, state, now))) return false;
  if (clean.contactFields.length && !clean.contactFields.some((field) => hasContactField(thread, field))) return false;
  if (!matchesActivity(thread, clean.activityRange, now)) return false;
  if (!clean.quickFilters.every((key) => (key === 'due' ? getReminderDueState(thread, now).isDue : key === 'unread' ? Number(thread.unread_count || (thread.is_unread ? 1 : 0)) > 0 : key === 'vip' ? tags.includes('vip') : ['UNPROCESSED', 'ASSIGNED'].includes(thread.status)))) return false;
  return clean.rules.every((rule) => matchesRule(thread, rule, now));
}
