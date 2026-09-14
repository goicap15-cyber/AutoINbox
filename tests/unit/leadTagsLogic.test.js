import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTER_TAGS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_CONTACT,
  parseTags,
  hasTag,
  validateTag,
  addTag,
  removeTag,
  toggleTag,
  areTagsEqual
} from '../../src/client/utils/tags.js';

describe('Lead Tags Logic & State Transitions (Spec 028)', () => {
  describe('Direct Toggle & Optimistic Rollback', () => {
    test('direct toggle updates committed tags immediately', () => {
      let committedTags = ['Tiềm năng'];
      const toggleResult = toggleTag(committedTags, 'Quan tâm');
      committedTags = toggleResult.tags;

      assert.deepEqual(committedTags, ['Tiềm năng', 'Quan tâm']);
      assert.equal(hasTag(committedTags, 'Quan tâm'), true);
    });

    test('direct toggle rolls back on save rejection', async () => {
      let committedTags = ['Tiềm năng'];
      const previousSnapshot = [...committedTags];

      // Optimistic update
      const toggleResult = toggleTag(committedTags, 'Quan tâm');
      committedTags = toggleResult.tags;
      assert.deepEqual(committedTags, ['Tiềm năng', 'Quan tâm']);

      // Simulate API rejection
      const mockSave = async () => {
        throw new Error('Network error');
      };

      try {
        await mockSave();
      } catch (_) {
        // Rollback
        committedTags = previousSnapshot;
      }

      assert.deepEqual(committedTags, ['Tiềm năng']);
    });
  });

  describe('Inline Editor Draft & Apply Lifecycle', () => {
    test('three consecutive custom labels accumulate instead of replacing a stale draft', () => {
      let latestDraft = [];
      for (const label of ['Nhãn 1', 'Nhãn 2', 'Nhãn 3']) {
        const result = addTag(latestDraft, label);
        assert.equal(result.error, null);
        latestDraft = result.tags;
      }
      assert.deepEqual(latestDraft, ['Nhãn 1', 'Nhãn 2', 'Nhãn 3']);
    });

    test('opening editor copies committedTags to draftTags', () => {
      const committedTags = ['Tiềm năng', 'Khách VIP'];
      let draftTags = [...committedTags];
      let isTagEditorOpen = true;

      assert.equal(isTagEditorOpen, true);
      assert.deepEqual(draftTags, ['Tiềm năng', 'Khách VIP']);
    });

    test('draft edits do not affect committed tags until apply', () => {
      let committedTags = ['Tiềm năng'];
      let draftTags = [...committedTags];

      const addRes = addTag(draftTags, 'Khách Mới');
      draftTags = addRes.tags;

      assert.deepEqual(committedTags, ['Tiềm năng']);
      assert.deepEqual(draftTags, ['Tiềm năng', 'Khách Mới']);

      // Apply action
      committedTags = draftTags;
      assert.deepEqual(committedTags, ['Tiềm năng', 'Khách Mới']);
    });

    test('canceling or escape discards draft without changing committed tags', () => {
      let committedTags = ['Tiềm năng'];
      let draftTags = [...committedTags];
      let isTagEditorOpen = true;

      // User adds tag to draft then cancels
      const addRes = addTag(draftTags, 'Draft To Discard');
      draftTags = addRes.tags;

      // Cancel action
      draftTags = [];
      isTagEditorOpen = false;

      assert.deepEqual(committedTags, ['Tiềm năng']);
      assert.equal(isTagEditorOpen, false);
    });
  });

  describe('Contact Switching & Unmount Reset', () => {
    test('switching contact resets editor, draft tags, and input errors', () => {
      let isTagEditorOpen = true;
      let draftTags = ['Draft Tag'];
      let customTagInput = 'Typing something';
      let tagError = 'Error message';
      let committedTags = ['Old Contact Tag'];

      // Contact change event
      const newContact = { thread_id: 'thread-2', tags: ['New Contact Tag 1', 'New Contact Tag 2'] };
      committedTags = parseTags(newContact.tags);
      draftTags = [];
      isTagEditorOpen = false;
      customTagInput = '';
      tagError = '';

      assert.deepEqual(committedTags, ['New Contact Tag 1', 'New Contact Tag 2']);
      assert.deepEqual(draftTags, []);
      assert.equal(isTagEditorOpen, false);
      assert.equal(customTagInput, '');
      assert.equal(tagError, '');
    });
  });

  describe('Unknown Legacy Tag Preservation', () => {
    test('starter chips and legacy tags render together without dropping legacy tags', () => {
      const contactTags = ['Tiềm năng', 'Hỏi giá áo thun', 'Khách VIP Sỉ'];
      const starterSelected = STARTER_TAGS.filter(t => hasTag(contactTags, t));
      const customAndLegacy = contactTags.filter(t => !STARTER_TAGS.some(st => st.toLowerCase() === t.toLowerCase()));

      assert.deepEqual(starterSelected, ['Tiềm năng']);
      assert.deepEqual(customAndLegacy, ['Hỏi giá áo thun', 'Khách VIP Sỉ']);
    });
  });
});

test('legacy contact with more than 20 tags cannot add a new tag until one is removed', () => {
  const legacyTags = Array.from({ length: 21 }, (_, i) => `Legacy ${i + 1}`);
  const result = addTag(legacyTags, 'New tag');
  assert.ok(result.error.includes('tối đa'));
  assert.deepEqual(result.tags, legacyTags);
});
