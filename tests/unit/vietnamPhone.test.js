const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  RULE_VERSION,
  isPrefixActive,
  normalizeVietnamMobile,
  findPhoneNumbers
} = require('../../src/server/utils/vietnamPhone');

describe('vietnamPhone.js', () => {
  describe('RULE_VERSION', () => {
    test('exposes a numeric rule version', () => {
      assert.equal(typeof RULE_VERSION, 'number');
      assert.ok(RULE_VERSION >= 1);
    });
  });

  describe('isPrefixActive', () => {
    test('accepts every whitelisted range from FR-002', () => {
      const active = ['032', '033', '034', '035', '036', '037', '038', '039',
        '052', '055', '056', '058', '059',
        '070', '076', '077', '078', '079',
        '081', '082', '083', '084', '085', '086', '087', '088', '089',
        '090', '091', '092', '093', '094', '095',
        '096', '097', '098', '099'];
      for (const prefix of active) {
        assert.equal(isPrefixActive(prefix), true, `expected ${prefix} to be active`);
      }
    });

    test('rejects gaps just outside the whitelisted ranges', () => {
      for (const prefix of ['030', '031', '040', '050', '051', '053', '054', '057',
        '071', '072', '073', '074', '075', '080']) {
        assert.equal(isPrefixActive(prefix), false, `expected ${prefix} to be inactive`);
      }
    });

    test('095 is active (Viettel allocation live since 07/2026 - enabled 2026-09-17)', () => {
      assert.equal(isPrefixActive('095'), true);
    });
  });

  describe('normalizeVietnamMobile', () => {
    test('accepts the four documented formats and normalizes to the same domestic number', () => {
      for (const raw of ['0345 678 901', '034.567.8901', '+84 345 678 901', '84 345 678 901']) {
        const result = normalizeVietnamMobile(raw);
        assert.equal(result.valid, true, `expected "${raw}" to be valid`);
        assert.equal(result.normalized, '0345678901');
        assert.equal(result.prefix, '034');
      }
    });

    test('accepts plain unformatted domestic input', () => {
      const result = normalizeVietnamMobile('0912345678');
      assert.equal(result.valid, true);
      assert.equal(result.normalized, '0912345678');
      assert.equal(result.prefix, '091');
    });

    test('rejects a 10-digit sequence with an invalid prefix', () => {
      assert.equal(normalizeVietnamMobile('0301234567').valid, false);
      assert.equal(normalizeVietnamMobile('0301234567').reason, 'INVALID_PREFIX');
      assert.equal(normalizeVietnamMobile('0801234567').valid, false);
    });

    test('rejects wrong lengths (9 and 11 digits)', () => {
      assert.equal(normalizeVietnamMobile('034567890').valid, false);
      assert.equal(normalizeVietnamMobile('0345678901').valid, true); // sanity: 10 is fine
      assert.equal(normalizeVietnamMobile('03456789012').valid, false);
    });

    test('rejects malformed/non-phone input without throwing', () => {
      assert.equal(normalizeVietnamMobile('').valid, false);
      assert.equal(normalizeVietnamMobile('not a phone').valid, false);
      assert.equal(normalizeVietnamMobile(null).valid, false);
      assert.equal(normalizeVietnamMobile(undefined).valid, false);
      assert.equal(normalizeVietnamMobile(12345).valid, false);
    });

    test('rejects a value that does not start with a 0 or 84/+84 marker', () => {
      assert.equal(normalizeVietnamMobile('345678901').valid, false);
    });
  });

  describe('findPhoneNumbers', () => {
    test('finds a single valid number inside a sentence', () => {
      const found = findPhoneNumbers('Alo, số của em là 0345 678 901 nhé anh.');
      assert.equal(found.length, 1);
      assert.equal(found[0].normalized, '0345678901');
      assert.equal(found[0].raw, '0345 678 901');
    });

    test('finds multiple distinct valid candidates in one message', () => {
      const found = findPhoneNumbers('Gọi 0912345678 hoặc 0987654321 giúp em nhé.');
      assert.equal(found.length, 2);
      assert.deepEqual(found.map((f) => f.normalized), ['0912345678', '0987654321']);
    });

    test('ignores a valid-looking prefix embedded inside a longer digit run', () => {
      // "0345678901" appears as a substring but is surrounded by other digits,
      // so it must never be extracted as if it were a standalone phone number.
      const found = findPhoneNumbers('Mã đơn hàng: 990345678901123');
      assert.deepEqual(found, []);
    });

    test('does not extract an invalid-prefix number even when well formatted', () => {
      assert.deepEqual(findPhoneNumbers('SĐT: 030 123 4567'), []);
      assert.deepEqual(findPhoneNumbers('SĐT: 080 123 4567'), []);
    });

    test('does not extract 9-digit or 11-digit sequences', () => {
      assert.deepEqual(findPhoneNumbers('034 567 890'), []);
      assert.deepEqual(findPhoneNumbers('0345 678 9012'), []);
    });

    test('returns empty array for empty/non-string input without throwing', () => {
      assert.deepEqual(findPhoneNumbers(''), []);
      assert.deepEqual(findPhoneNumbers(null), []);
      assert.deepEqual(findPhoneNumbers(undefined), []);
    });

    test('normalizes +84 and 84 forms to the domestic candidate', () => {
      const found = findPhoneNumbers('Liên hệ +84 345 678 901 hoặc 84 912 345 678');
      assert.deepEqual(found.map((f) => f.normalized), ['0345678901', '0912345678']);
    });
  });
});
