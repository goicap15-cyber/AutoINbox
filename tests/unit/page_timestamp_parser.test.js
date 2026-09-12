const test = require('node:test');
const assert = require('node:assert/strict');

// We test both CommonJS direct require and window global UMD execution
const { parsePageTimestamp, parseTimeFromLabel, parseDateSeparator } = require('../../src/extension/pageTimestampParser.js');

test('T001: bóc tách timestamp từ data-utime hoặc time[datetime]', () => {
  const nodeWithUtime = {
    getAttribute: (attr) => attr === 'data-utime' ? '1787114507' : null,
    querySelector: () => null
  };
  const res1 = parsePageTimestamp(nodeWithUtime);
  assert.equal(res1.timestamp_source, 'facebook_timestamp');
  assert.equal(res1.timestamp_ms, 1787114507000);

  const nodeWithTimeTag = {
    getAttribute: () => null,
    querySelector: (sel) => sel === 'time' ? {
      getAttribute: (attr) => attr === 'datetime' ? '2026-09-10T08:30:00.000Z' : null
    } : null
  };
  const res2 = parsePageTimestamp(nodeWithTimeTag);
  assert.equal(res2.timestamp_source, 'facebook_timestamp');
  assert.equal(res2.timestamp_ms, new Date('2026-09-10T08:30:00.000Z').getTime());
});

test('T001: bóc tách timestamp từ aria-label và data-tooltip-content', () => {
  const nodeWithAria = {
    getAttribute: (attr) => {
      if (attr === 'aria-label') return 'Tin nhắn gửi lúc 14:35, 10 Tháng 9, 2026';
      return null;
    },
    querySelector: () => null
  };
  const res1 = parsePageTimestamp(nodeWithAria);
  assert.equal(res1.timestamp_source, 'facebook_label');
  assert.ok(res1.timestamp_ms > 0);
  const d = new Date(res1.timestamp_ms);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 35);

  const nodeWithTooltipEn = {
    getAttribute: (attr) => {
      if (attr === 'data-tooltip-content') return 'Sent at 9:15 AM, Sep 10, 2026';
      return null;
    },
    querySelector: () => null
  };
  const res2 = parsePageTimestamp(nodeWithTooltipEn);
  assert.equal(res2.timestamp_source, 'facebook_label');
  assert.ok(res2.timestamp_ms > 0);
  const d2 = new Date(res2.timestamp_ms);
  assert.equal(d2.getHours(), 9);
  assert.equal(d2.getMinutes(), 15);
});

test('T001: bóc tách separator + bubble clock tiếng Việt & Anh', () => {
  const baseDate = new Date('2026-09-10T10:00:00.000Z');
  
  // Hôm nay 07:34
  const resToday = parseDateSeparator('Hôm nay', '07:34', baseDate);
  assert.equal(resToday.timestamp_source, 'separator_date_clock');
  const dToday = new Date(resToday.timestamp_ms);
  assert.equal(dToday.getHours(), 7);
  assert.equal(dToday.getMinutes(), 34);

  // Hôm qua 23:55 (xuyên nửa đêm)
  const resYesterday = parseDateSeparator('Hôm qua', '23:55', baseDate);
  assert.equal(resYesterday.timestamp_source, 'separator_date_clock');
  const dYest = new Date(resYesterday.timestamp_ms);
  assert.equal(dYest.getHours(), 23);
  assert.equal(dYest.getMinutes(), 55);
  assert.ok(resYesterday.timestamp_ms < resToday.timestamp_ms);

  // Yesterday 11:20 PM
  const resEn = parseDateSeparator('Yesterday', '11:20 PM', baseDate);
  assert.equal(resEn.timestamp_source, 'separator_date_clock');
  const dEn = new Date(resEn.timestamp_ms);
  assert.equal(dEn.getHours(), 23);
  assert.equal(dEn.getMinutes(), 20);

  // Thiếu năm: "24 Thg 4" -> tự suy luận năm
  const resNoYear = parseDateSeparator('24 Thg 4', '08:00', baseDate);
  assert.equal(resNoYear.timestamp_source, 'separator_date_clock');
  const dNoYear = new Date(resNoYear.timestamp_ms);
  assert.equal(dNoYear.getDate(), 24);
  assert.equal(dNoYear.getMonth(), 3); // 0-indexed: 3 = tháng 4
});

test('T001: bóc tách separator dạng gộp thời gian + thứ/ngày của Meta Business Suite', () => {
  // baseDate là Thứ Năm (Thursday, 10/09/2026)
  const baseDate = new Date('2026-09-11T14:00:00.000+07:00'); // Thứ Sáu (Friday, day 5)

  // "14:04 T5" -> Thứ Năm lúc 14:04
  const resT5 = parseDateSeparator('14:04 T5', null, baseDate);
  assert.equal(resT5.timestamp_source, 'separator_date_clock');
  const dT5 = new Date(resT5.timestamp_ms);
  assert.equal(dT5.getHours(), 14);
  assert.equal(dT5.getMinutes(), 4);
  assert.equal(dT5.getDay(), 4); // Thứ Năm (Thursday = 4)

  // "13:52 6 Tháng 8, 2026"
  const resAug = parseDateSeparator('13:52 6 Tháng 8, 2026', null, baseDate);
  assert.equal(resAug.timestamp_source, 'separator_date_clock');
  const dAug = new Date(resAug.timestamp_ms);
  assert.equal(dAug.getHours(), 13);
  assert.equal(dAug.getMinutes(), 52);
  assert.equal(dAug.getDate(), 6);
  assert.equal(dAug.getMonth(), 7); // Tháng 8 = index 7
  assert.equal(dAug.getFullYear(), 2026);

  // parseTimeFromLabel cũng bóc tách được "14:04 T5"
  const msT5 = parseTimeFromLabel('14:04 T5', baseDate);
  assert.ok(msT5 > 0);
  assert.equal(new Date(msT5).getMinutes(), 4);
});

test('T001: trả về timestamp_ms = 0 và unknown khi không có bằng chứng thời gian', () => {
  const emptyNode = {
    getAttribute: () => null,
    querySelector: () => null
  };
  const res = parsePageTimestamp(emptyNode);
  assert.equal(res.timestamp_ms, 0);
  assert.equal(res.timestamp_source, 'unknown');
});
