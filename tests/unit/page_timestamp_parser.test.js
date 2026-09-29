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

test('T002: Video player duration text (0:00 / 0:19, 0:03, 0:19) không bị nhận nhầm thành date separator', () => {
  const res1 = parseDateSeparator('0:00 / 0:19');
  assert.equal(res1.timestamp_ms, 0);
  assert.equal(res1.timestamp_source, 'unknown');

  const res2 = parseDateSeparator('0:19');
  assert.equal(res2.timestamp_ms, 0);
  assert.equal(res2.timestamp_source, 'unknown');

  const res3 = parseDateSeparator('0:03');
  assert.equal(res3.timestamp_ms, 0);
  assert.equal(res3.timestamp_source, 'unknown');
});


// ── 2026-09-28: separator DD/MM/YYYY + Thứ-N-số + giờ tương đối ────────────
// (cả khối lịch sử page mới bị dán giờ-cào vì separator "26/09/2026" không
// parse được - reproduce 2026-09-28, thread Đặng Thanh Nhàn #7264)
const BASE_28_09_2026 = new Date('2026-09-28T03:00:00.000Z'); // 10:00 giờ VN

test('T-Sep: parseDateSeparator đọc DD/MM/YYYY (kèm và không kèm giờ)', () => {
  const r1 = parseDateSeparator('26/09/2026', null, BASE_28_09_2026);
  assert.equal(r1.timestamp_source, 'separator_date_clock');
  // 26/09 00:00 giờ VN = 25/09 17:00 UTC
  assert.equal(new Date(r1.timestamp_ms).toISOString(), '2026-09-25T17:00:00.000Z');

  const r2 = parseDateSeparator('26/09/2026 14:53', null, BASE_28_09_2026);
  assert.equal(r2.timestamp_source, 'separator_date_clock');
  assert.equal(new Date(r2.timestamp_ms).toISOString(), '2026-09-26T07:53:00.000Z');

  // DD/MM không năm: tháng tương lai -> năm trước
  const r3 = parseDateSeparator('25/12', null, BASE_28_09_2026);
  assert.equal(r3.timestamp_source, 'separator_date_clock');
  assert.equal(new Date(r3.timestamp_ms).getUTCFullYear(), 2025);
});

test('T-Sep: regression các format đã hoạt động (14:53 T7, Hôm Nay, video guard)', () => {
  const r1 = parseDateSeparator('14:53 T7', null, BASE_28_09_2026);
  assert.equal(r1.timestamp_ms, new Date('2026-09-26T07:53:00.000Z').getTime()); // T7 27/09 VN

  const r2 = parseDateSeparator('Hôm Nay', null, BASE_28_09_2026);
  assert.equal(new Date(r2.timestamp_ms).toISOString(), '2026-09-27T17:00:00.000Z'); // 28/09 00:00 VN

  const r3 = parseDateSeparator('0:00 / 0:19', null, BASE_28_09_2026);
  assert.equal(r3.timestamp_ms, 0);
  assert.equal(r3.timestamp_source, 'unknown');
});

test('T-Sep: giờ tương đối (N phút / N giờ / N ngày)', () => {
  const r1 = parseDateSeparator('2 giờ', null, BASE_28_09_2026);
  assert.equal(r1.timestamp_ms, BASE_28_09_2026.getTime() - 2 * 3600000);

  const r2 = parseDateSeparator('45 phút', null, BASE_28_09_2026);
  assert.equal(r2.timestamp_ms, BASE_28_09_2026.getTime() - 45 * 60000);

  const r3 = parseDateSeparator('3 ngày', null, BASE_28_09_2026);
  assert.equal(r3.timestamp_ms, BASE_28_09_2026.getTime() - 3 * 86400000);
});

test('T-Sep: Thứ 2 dạng số (digit weekday) parse được', () => {
  const r = parseDateSeparator('Thứ 2', null, BASE_28_09_2026);
  assert.equal(r.timestamp_source, 'separator_date_clock');
  // 28/09/2026 là thứ Hai; Thứ 2 gần nhất = 21/09
  assert.equal(new Date(r.timestamp_ms).getUTCDate(), 20); // 21/09 00:00 VN = 20/09 17:00 UTC
});
