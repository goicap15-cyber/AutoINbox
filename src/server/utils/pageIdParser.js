// Parses the "Kết nối Page" input field, which only ever advertises two
// accepted formats (per its own placeholder text): a raw numeric Page ID, or
// a facebook.com/profile.php?id=<id> link. No Graph API call is involved -
// the extension handles send/receive via DOM automation, so a vanity-name
// Page URL (facebook.com/somepagename) cannot be resolved to a numeric ID
// without an API token this flow deliberately doesn't require; such input
// correctly returns null rather than guessing.
function parsePageIdFromInput(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/profile\.php\?id=(\d+)/) || raw.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

module.exports = { parsePageIdFromInput };
