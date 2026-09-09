import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_TYPE_KEYS,
  createDefaultFilters,
  cloneFilters,
  countActiveFilters,
  hasActiveFilters,
  areFiltersEqual,
  sanitizeFilters,
  matchesConversationFilters
} from '../../src/client/utils/conversationFilters.js';

describe('conversationFilters.js pure utility', () => {
  describe('Basic constructors & counters', () => {
    test('createDefaultFilters returns empty state', () => {
      assert.deepEqual(createDefaultFilters(), { sourceKeys: [], statusIds: [] });
    });

    test('cloneFilters creates independent copy', () => {
      const original = { sourceKeys: ['type:personal_messenger'], statusIds: ['1', '2'] };
      const cloned = cloneFilters(original);
      assert.deepEqual(cloned, original);
      assert.notEqual(cloned, original);
      cloned.sourceKeys.push('type:page_messenger');
      assert.equal(original.sourceKeys.length, 1);
    });

    test('normalizes valid source keys and drops malformed or duplicate keys', () => {
      const cloned = cloneFilters({
        sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL, 'source:page-1', 'source:page-1', 'type:unknown', 'source:'],
        statusIds: [1, '1', ' 2 ', '', null]
      });

      assert.deepEqual(cloned, {
        sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL, 'source:page-1'],
        statusIds: ['1', '2']
      });
    });

    test('countActiveFilters and hasActiveFilters calculate correctly', () => {
      assert.equal(countActiveFilters(null), 0);
      assert.equal(hasActiveFilters(null), false);
      assert.equal(countActiveFilters({ sourceKeys: ['type:personal_messenger'], statusIds: ['1', '2'] }), 3);
      assert.equal(hasActiveFilters({ sourceKeys: ['type:personal_messenger'], statusIds: [] }), true);
    });

    test('areFiltersEqual checks order-independent equality', () => {
      const a = { sourceKeys: ['type:personal_messenger', 'source:s1'], statusIds: ['1', '2'] };
      const b = { sourceKeys: ['source:s1', 'type:personal_messenger'], statusIds: ['2', '1'] };
      const c = { sourceKeys: ['source:s1'], statusIds: ['1', '2'] };

      assert.equal(areFiltersEqual(a, b), true);
      assert.equal(areFiltersEqual(a, c), false);
      assert.equal(areFiltersEqual(createDefaultFilters(), { sourceKeys: [], statusIds: [] }), true);
    });
  });

  describe('sanitizeFilters', () => {
    test('drops removed sources and statuses safely while retaining valid options', () => {
      const filters = {
        sourceKeys: [
          'type:personal_messenger',
          'source:valid-source-1',
          'source:deleted-source'
        ],
        statusIds: ['1', '999'] // 1 is valid, 999 was deleted
      };

      const availableSources = [
        { id: 'personal-1', source_type: 'personal_messenger', display_name: 'Messenger' },
        { id: 'valid-source-1', source_type: 'page_messenger', display_name: 'Page A' }
      ];
      const availableStatuses = [{ id: 1, name: 'Mới' }, { id: 2, name: 'Đã chốt' }];

      const sanitized = sanitizeFilters(filters, availableSources, availableStatuses);
      assert.deepEqual(sanitized, {
        sourceKeys: ['type:personal_messenger', 'source:valid-source-1'],
        statusIds: ['1']
      });
    });

    test('always retains core source type keys (PERSONAL and PAGE) regardless of available sources', () => {
      // type:personal_messenger and type:page_messenger are core selectors that are always valid.
      // They should never be stripped by sanitizeFilters even if no inbox_sources row matches.
      const sanitized = sanitizeFilters(
        { sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL, SOURCE_TYPE_KEYS.PAGE, SOURCE_TYPE_KEYS.PAGE], statusIds: [] },
        [{ id: 'personal-1', source_type: 'personal_messenger' }],
        []
      );

      assert.deepEqual(sanitized, { sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL, SOURCE_TYPE_KEYS.PAGE], statusIds: [] });
    });

    test('spec 044: drops account: key once the account is removed, mirroring source: keys for Pages', () => {
      const filters = {
        sourceKeys: ['account:acc-1', 'account:acc-removed'],
        statusIds: []
      };
      const availableAccounts = [{ id: 'acc-1', name: 'Nguyễn Văn A' }];

      const sanitized = sanitizeFilters(filters, [], [], availableAccounts);
      assert.deepEqual(sanitized, { sourceKeys: ['account:acc-1'], statusIds: [] });
    });
  });

  describe('matchesConversationFilters', () => {
    const threadPersonal = { id: 't1', source_type: 'personal_messenger', source_id: 'acct-1', status_id: 1 };
    const threadPageA = { id: 't2', source_type: 'page_messenger', source_id: 'page-100', status_id: 2 };
    const threadPageB = { id: 't3', source_type: 'page_messenger', source_id: 'page-200', status_id: null };

    test('returns true for empty filters', () => {
      assert.equal(matchesConversationFilters(threadPersonal, createDefaultFilters()), true);
      assert.equal(matchesConversationFilters(threadPageA, null), true);
    });

    test('filters by source type', () => {
      const filterPersonal = { sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL], statusIds: [] };
      const filterPage = { sourceKeys: [SOURCE_TYPE_KEYS.PAGE], statusIds: [] };

      assert.equal(matchesConversationFilters(threadPersonal, filterPersonal), true);
      assert.equal(matchesConversationFilters(threadPageA, filterPersonal), false);
      assert.equal(matchesConversationFilters(threadPageA, filterPage), true);
      assert.equal(matchesConversationFilters(threadPersonal, filterPage), false);
    });

    test('filters by specific source ID', () => {
      const filterPage100 = { sourceKeys: ['source:page-100'], statusIds: [] };

      assert.equal(matchesConversationFilters(threadPageA, filterPage100), true);
      assert.equal(matchesConversationFilters(threadPageB, filterPage100), false);
      assert.equal(matchesConversationFilters(threadPersonal, filterPage100), false);
    });

    test('spec 044: filters by specific personal account ID', () => {
      const threadAccountA = { id: 't4', source_type: 'personal_messenger', account_id: 'acc-a', status_id: 1 };
      const threadAccountB = { id: 't5', source_type: 'personal_messenger', account_id: 'acc-b', status_id: 1 };
      const filterAccountA = { sourceKeys: ['account:acc-a'], statusIds: [] };

      assert.equal(matchesConversationFilters(threadAccountA, filterAccountA), true);
      assert.equal(matchesConversationFilters(threadAccountB, filterAccountA), false);
      // A page thread never matches an account: key even if IDs happened to collide.
      assert.equal(matchesConversationFilters(threadPageA, { sourceKeys: ['account:acc-1'], statusIds: [] }), false);
    });

    test('OR matching within source group', () => {
      const filterMultiSource = {
        sourceKeys: [SOURCE_TYPE_KEYS.PERSONAL, 'source:page-100'],
        statusIds: []
      };

      assert.equal(matchesConversationFilters(threadPersonal, filterMultiSource), true);
      assert.equal(matchesConversationFilters(threadPageA, filterMultiSource), true);
      assert.equal(matchesConversationFilters(threadPageB, filterMultiSource), false);
    });

    test('filters by status ID (OR within status group)', () => {
      const filterStatus1Or2 = { sourceKeys: [], statusIds: ['1', '2'] };
      const filterStatus2 = { sourceKeys: [], statusIds: ['2'] };

      assert.equal(matchesConversationFilters(threadPersonal, filterStatus1Or2), true);
      assert.equal(matchesConversationFilters(threadPageA, filterStatus1Or2), true);
      assert.equal(matchesConversationFilters(threadPageB, filterStatus1Or2), false); // threadPageB has status_id: null

      assert.equal(matchesConversationFilters(threadPersonal, filterStatus2), false);
      assert.equal(matchesConversationFilters(threadPageA, filterStatus2), true);
    });

    test('AND matching across Source and Status groups', () => {
      // Must be (Page) AND (status 2)
      const filterCombined = {
        sourceKeys: [SOURCE_TYPE_KEYS.PAGE],
        statusIds: ['2']
      };

      assert.equal(matchesConversationFilters(threadPageA, filterCombined), true); // Page + status 2
      assert.equal(matchesConversationFilters(threadPageB, filterCombined), false); // Page + status null
      assert.equal(matchesConversationFilters(threadPersonal, filterCombined), false); // Personal + status 1
    });

    test('handles threads with missing or null attributes safely', () => {
      const badThread = { id: 'bad' };
      assert.equal(matchesConversationFilters(badThread, { sourceKeys: [SOURCE_TYPE_KEYS.PAGE], statusIds: [] }), false);
      assert.equal(matchesConversationFilters(badThread, { sourceKeys: [], statusIds: ['1'] }), false);
      assert.equal(matchesConversationFilters(badThread, createDefaultFilters()), true);
      assert.equal(matchesConversationFilters(null, createDefaultFilters()), false);
    });
  });
});
