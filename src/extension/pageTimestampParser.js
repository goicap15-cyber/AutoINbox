/**
 * pageTimestampParser.js
 * Helper bÃ³c tÃ¡ch thá»i gian Page DOM tÆ°Æ¡ng thÃ­ch UMD (Browser Extension & CommonJS Node.js)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbPageTimestampParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * PhÃ¢n tÃ­ch chuá»—i giá» phÃºt (hh:mm [AM|PM])
   */
  function parseClockString(clockStr) {
    if (!clockStr) return null;
    const trimmed = clockStr.trim();
    // 12-hour: 11:20 PM, 9:15 AM
    const match12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
      let hours = parseInt(match12[1], 10);
      const minutes = parseInt(match12[2], 10);
      const meridiem = match12[3].toUpperCase();
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
      return { hours, minutes };
    }
    // 24-hour: 07:34, 14:35, 23:55
    const match24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
      return {
        hours: parseInt(match24[1], 10),
        minutes: parseInt(match24[2], 10)
      };
    }
    return null;
  }

  /**
   * PhÃ¢n tÃ­ch nhÃ£n tá»± nhiÃªn (aria-label, tooltip, text) tiáº¿ng Viá»‡t hoáº·c tiáº¿ng Anh
   * VÃ­ dá»¥:
   * "Tin nháº¯n gá»­i lÃºc 14:35, 10 ThÃ¡ng 9, 2026"
   * "Sent at 9:15 AM, Sep 10, 2026"
   * "14:04 T5"
   */
  function parseTimeFromLabel(labelStr, baseDate = new Date()) {
    if (!labelStr || typeof labelStr !== 'string') return null;
    const str = labelStr.trim();

    // 1. Check if ISO string or parseable directly
    const directTime = Date.parse(str);
    if (!isNaN(directTime) && str.match(/\d{4}/)) {
      return directTime;
    }

    // 2. Tiáº¿ng Viá»‡t: "14:35, 10 ThÃ¡ng 9, 2026" hoáº·c "14:35, 10 Thg 9, 2026" hoáº·c "10 ThÃ¡ng 9, 2026 lÃºc 14:35"
    const viMatch = str.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*,\s*(\d{1,2})\s*(?:ThÃ¡ng|Thg)\s*(\d{1,2})(?:[,\s]+(\d{4}))?/i) ||
                    str.match(/(\d{1,2})\s*(?:ThÃ¡ng|Thg)\s*(\d{1,2})(?:[,\s]+(\d{4}))?\s*(?:lÃºc|vÃ o lÃºc)?\s*(\d{1,2}):(\d{2})/i);
    
    if (viMatch) {
      let hours, minutes, day, month, year;
      if (str.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*,\s*(\d{1,2})\s*(?:ThÃ¡ng|Thg)/i)) {
        hours = parseInt(viMatch[1], 10);
        minutes = parseInt(viMatch[2], 10);
        day = parseInt(viMatch[3], 10);
        month = parseInt(viMatch[4], 10) - 1; // 0-indexed
        year = viMatch[5] ? parseInt(viMatch[5], 10) : baseDate.getFullYear();
      } else {
        day = parseInt(viMatch[1], 10);
        month = parseInt(viMatch[2], 10) - 1;
        year = viMatch[3] ? parseInt(viMatch[3], 10) : baseDate.getFullYear();
        hours = parseInt(viMatch[4], 10);
        minutes = parseInt(viMatch[5], 10);
      }
      const d = new Date(year, month, day, hours, minutes, 0, 0);
      return d.getTime();
    }

    // 3. Tiáº¿ng Anh: "9:15 AM, Sep 10, 2026" or "Sep 10, 2026 at 9:15 AM"
    const enMatch = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*,\s*([A-Za-z]+)\s*(\d{1,2})(?:[,\s]+(\d{4}))?/i);
    if (enMatch) {
      let hours = parseInt(enMatch[1], 10);
      const minutes = parseInt(enMatch[2], 10);
      const meridiem = enMatch[3].toUpperCase();
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
      const monthStr = enMatch[4].toLowerCase();
      const day = parseInt(enMatch[5], 10);
      const year = enMatch[6] ? parseInt(enMatch[6], 10) : baseDate.getFullYear();

      const months = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
      };
      const monthPrefix = monthStr.substring(0, 3);
      const month = months[monthPrefix] !== undefined ? months[monthPrefix] : baseDate.getMonth();

      const d = new Date(year, month, day, hours, minutes, 0, 0);
      return d.getTime();
    }

    // 4. Integrated separator formats like "14:04 T5", "16:36 T5", "13:52 6 ThÃ¡ng 8, 2026"
    const parsedSep = parseDateSeparator(str, null, baseDate);
    if (parsedSep && parsedSep.timestamp_ms > 0) {
      return parsedSep.timestamp_ms;
    }

    return null;
  }

  /**
   * PhÃ¢n tÃ­ch dÃ²ng ngÄƒn cÃ¡ch ngÃ y (separator) káº¿t há»£p vá»›i giá» hiá»ƒn thá»‹ trong bubble hoáº·c gá»™p sáºµn
   */
  function parseDateSeparator(separatorText, clockText, baseDate = new Date()) {
    if (!separatorText && !clockText) {
      return { timestamp_ms: 0, timestamp_source: 'unknown' };
    }

    let sep = (separatorText || '').trim();

    // Guard: Video player duration text (0:00 / 0:19, 0:03, 0:19) is never a date separator!
    if (/^\d{1,2}(?::\d{2}){1,2}\s*\/\s*\d{1,2}(?::\d{2}){1,2}$/.test(sep) || /^0:\d{2}$/.test(sep)) {
      return { timestamp_ms: 0, timestamp_source: 'unknown' };
    }

    let clock = clockText ? parseClockString(clockText) : null;

    // Náº¿u clockText khÃ´ng Ä‘Æ°á»£c truyá»n, kiá»ƒm tra xem trong separatorText cÃ³ chá»©a giá» hay khÃ´ng
    if (!clock && sep) {
      const clockMatch = sep.match(/\b(\d{1,2}:\d{2})(?:\s*(AM|PM))?\b/i);
      if (clockMatch) {
        clock = parseClockString(clockMatch[0]);
        sep = sep.replace(clockMatch[0], '').trim();
      }
    }

    // Náº¿u váº«n khÃ´ng cÃ³ clock thÃ¬ máº·c Ä‘á»‹nh lÃ  00:00 (hoáº·c náº¿u sep rá»—ng mÃ  cÃ³ clock thÃ¬ lÃ  ngÃ y hÃ´m nay)
    if (!clock) {
      clock = { hours: 0, minutes: 0 };
    }

    const trimmedSep = sep.toLowerCase();
    const d = new Date(baseDate.getTime());

    if (!trimmedSep || trimmedSep === 'hÃ´m nay' || trimmedSep === 'today') {
      d.setHours(clock.hours, clock.minutes, 0, 0);
      return {
        timestamp_ms: d.getTime(),
        timestamp_source: 'separator_date_clock'
      };
    }

    if (trimmedSep === 'hÃ´m qua' || trimmedSep === 'yesterday') {
      d.setDate(d.getDate() - 1);
      d.setHours(clock.hours, clock.minutes, 0, 0);
      return {
        timestamp_ms: d.getTime(),
        timestamp_source: 'separator_date_clock'
      };
    }

    // Thá»© hai, Thá»© ba... / T2, T3, T4, T5, T6, T7, CN / Monday, Tuesday...
    const dayOfWeekVi = {
      'chá»§ nháº­t': 0, 'cn': 0,
      'thá»© hai': 1, 'thá»© 2': 1, 't2': 1,
      'thá»© ba': 2, 'thá»© 3': 2, 't3': 2,
      'thá»© tÆ°': 3, 'thá»© 4': 3, 't4': 3,
      'thá»© nÄƒm': 4, 'thá»© 5': 4, 't5': 4,
      'thá»© sÃ¡u': 5, 'thá»© 6': 5, 't6': 5,
      'thá»© báº£y': 6, 'thá»© 7': 6, 't7': 6
    };
    const dayOfWeekEn = {
      sunday: 0, sun: 0,
      monday: 1, mon: 1,
      tuesday: 2, tue: 2,
      wednesday: 3, wed: 3,
      thursday: 4, thu: 4,
      friday: 5, fri: 5,
      saturday: 6, sat: 6
    };
    
    if (dayOfWeekVi[trimmedSep] !== undefined || dayOfWeekEn[trimmedSep] !== undefined) {
      const targetDay = dayOfWeekVi[trimmedSep] !== undefined ? dayOfWeekVi[trimmedSep] : dayOfWeekEn[trimmedSep];
      const currentDay = d.getDay();
      let diff = currentDay - targetDay;
      if (diff <= 0) diff += 7; // NgÃ y trong tuáº§n trÆ°á»›c
      d.setDate(d.getDate() - diff);
      d.setHours(clock.hours, clock.minutes, 0, 0);
      return {
        timestamp_ms: d.getTime(),
        timestamp_source: 'separator_date_clock'
      };
    }

    // NgÃ y thÃ¡ng cá»¥ thá»ƒ: "24 Thg 4", "24 ThÃ¡ng 4, 2026", "24 Apr", "Apr 24, 2026"
    const viDateMatch = trimmedSep.match(/(\d{1,2})\s*(?:thÃ¡ng|thg)\s*(\d{1,2})(?:[,\s]+(\d{4}))?/i);
    if (viDateMatch) {
      const day = parseInt(viDateMatch[1], 10);
      const month = parseInt(viDateMatch[2], 10) - 1;
      let year = viDateMatch[3] ? parseInt(viDateMatch[3], 10) : baseDate.getFullYear();
      if (!viDateMatch[3] && month > baseDate.getMonth()) {
        year -= 1; // Náº¿u thÃ¡ng lá»›n hÆ¡n thÃ¡ng hiá»‡n táº¡i mÃ  khÃ´ng cÃ³ nÄƒm -> nÄƒm trÆ°á»›c
      }
      const target = new Date(year, month, day, clock.hours, clock.minutes, 0, 0);
      return {
        timestamp_ms: target.getTime(),
        timestamp_source: 'separator_date_clock'
      };
    }

    const enDateMatch = trimmedSep.match(/(?:(\d{1,2})\s+([a-z]+)|([a-z]+)\s+(\d{1,2}))(?:[,\s]+(\d{4}))?/i);
    if (enDateMatch) {
      const day = parseInt(enDateMatch[1] || enDateMatch[4], 10);
      const monthStr = (enDateMatch[2] || enDateMatch[3]).toLowerCase().substring(0, 3);
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = months[monthStr] !== undefined ? months[monthStr] : baseDate.getMonth();
      let year = enDateMatch[5] ? parseInt(enDateMatch[5], 10) : baseDate.getFullYear();
      if (!enDateMatch[5] && month > baseDate.getMonth()) {
        year -= 1;
      }
      const target = new Date(year, month, day, clock.hours, clock.minutes, 0, 0);
      return {
        timestamp_ms: target.getTime(),
        timestamp_source: 'separator_date_clock'
      };
    }

    return {
      timestamp_ms: 0,
      timestamp_source: 'unknown'
    };
  }

  /**
   * BÃ³c tÃ¡ch timestamp tá»« má»™t pháº§n tá»­ DOM tin nháº¯n Page
   */
  function parsePageTimestamp(domNode) {
    if (!domNode) {
      return { timestamp_ms: 0, timestamp_source: 'unknown' };
    }

    // 1. data-utime (Facebook Unix timestamp in seconds)
    if (typeof domNode.getAttribute === 'function') {
      const utime = domNode.getAttribute('data-utime');
      if (utime && !isNaN(Number(utime)) && Number(utime) > 0) {
        return {
          timestamp_ms: Number(utime) * 1000,
          timestamp_source: 'facebook_timestamp'
        };
      }
    }

    // 2. <time datetime="..."> tag
    if (typeof domNode.querySelector === 'function') {
      const timeEl = domNode.querySelector('time');
      if (timeEl && typeof timeEl.getAttribute === 'function') {
        const datetime = timeEl.getAttribute('datetime');
        if (datetime) {
          const parsedTime = Date.parse(datetime);
          if (!isNaN(parsedTime) && parsedTime > 0) {
            return {
              timestamp_ms: parsedTime,
              timestamp_source: 'facebook_timestamp'
            };
          }
        }
      }
    }

    // 3. aria-label hoáº·c data-tooltip-content
    if (typeof domNode.getAttribute === 'function') {
      const ariaLabel = domNode.getAttribute('aria-label');
      if (ariaLabel) {
        const labelTime = parseTimeFromLabel(ariaLabel);
        if (labelTime && labelTime > 0) {
          return {
            timestamp_ms: labelTime,
            timestamp_source: 'facebook_label'
          };
        }
      }

      const tooltip = domNode.getAttribute('data-tooltip-content');
      if (tooltip) {
        const tooltipTime = parseTimeFromLabel(tooltip);
        if (tooltipTime && tooltipTime > 0) {
          return {
            timestamp_ms: tooltipTime,
            timestamp_source: 'facebook_label'
          };
        }
      }
    }

    return {
      timestamp_ms: 0,
      timestamp_source: 'unknown'
    };
  }

  return {
    parsePageTimestamp,
    parseTimeFromLabel,
    parseDateSeparator,
    parseClockString
  };
});


