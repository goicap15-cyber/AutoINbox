/* FbCrmPageIdentityGate - pure helpers for the post-navigation identity check.
 *
 * Reproduce 2026-09-29: CRM-initiated page thread sync scraped nothing because
 * the header reader collected the conversation ACTION-BUTTON label
 * ("Chuyen den thu muc Spam") as a candidate contact name; a cold
 * (never-opened) conversation renders its title later than that button, the
 * reader saw only button labels, loose matching failed and the sync aborted
 * with thread_route_mismatch. Filtering action labels lets a label-only
 * header become an unreadable header, which the existing policy already
 * treats as "trust the navigation" instead of aborting.
 *
 * Labels are written with unicode escapes so this source stays ASCII-safe.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FbCrmPageIdentityGate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ACTION_LABEL_RE = new RegExp('^(' + [
    'chuy\u1ec3n \u0111\u1ebfn th\u01b0 m\u1ee5c', // chuyen den thu muc (move to folder)
    'g\u00e1n nh\u00e3n',                          // gan nhan (assign label)
    '\u0111\u00e1nh d\u1ea5u',                     // danh dau (mark)
    'di chuy\u1ec3n',                              // di chuyen (move)
    'b\u00e1o c\u00e1o',                           // bao cao (report)
    'x\u00f3a',                                    // xoa (delete)
    'ch\u1ec9nh s\u1eeda',                         // chinh sua (edit)
    '\u1ea9n',                                     // an (hide)
    'th\u00eam',                                   // them (add)
    't\u1ea1o'                                     // tao (create)
  ].join('|') + ')', 'i');

  function isActionLabel(text) {
    return ACTION_LABEL_RE.test(String(text || '').trim());
  }

  function filterCandidateNames(names) {
    var out = [];
    var list = Array.isArray(names) ? names : [];
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i] || '').trim();
      if (!t || isActionLabel(t)) continue;
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  return {
    isActionLabel: isActionLabel,
    filterCandidateNames: filterCandidateNames
  };
});
