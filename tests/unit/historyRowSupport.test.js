const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/extension/historyRowSupport.js', 'utf8'), context);
const { resolveDirectionFromLabel } = context.FbCrmHistoryRowSupport;

test('history scraper guards an image timestamp minute from becoming a caption', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /\(mediaUrl \|\| isVideoMessage\).*\^\\d\{2\}\$/s);
  assert.match(background, /Number\(cleaned\) === \(Number\(clockMinutes\) % 60\)/);
});

test('older-history loader detects a virtual page swap with unchanged scroll geometry', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /const beforeViewportIdentity = historyViewportIdentity\(container\)/);
  assert.match(background, /afterViewportIdentity !== beforeViewportIdentity/);
  assert.match(background, /afterViewportIdentity === lastViewportIdentity/);
});

test('personal Messenger history reads emoji image labels before timestamp minute fragments', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /function extractHistoryBubbleEmoji\(container\)/);
  assert.match(background, /rawEmojiContent = extractHistoryBubbleEmoji\(leafBubble\)/);
  assert.match(background, /emojiContent && \(!textContent \|\| minuteFragment\)/);
});

test('personal Messenger keeps icon-only likes and semantic-only videos', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(content, /rowEmojiContent && \(finalBubbles\.length === 0 \|\| hasOnlyClockFragments\)/);
  assert.match(content, /const semanticVideo = Array\.from/);
  assert.match(background, /rowEmojiContent && \(leafBubbles\.length === 0 \|\| hasOnlyClockFragments\)/);
  assert.match(background, /videoElement \|\| semanticVideoElement/);
  assert.match(background, /mediaElement \|\| mediaAnchor \|\| semanticVideoElement \|\| row/);
});

test('personal Messenger treats glued minute suffixes as timestamp chrome', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(content, /\(\?:sáng\|chiều\|tối\|am\|pm\|sa\|ch\)\?/i);
  assert.match(background, /\(\?:sáng\|chiều\|tối\|am\|pm\|sa\|ch\)\?/i);
});

test('personal Messenger accepts the exact received-like SVG title inside a clickable bubble', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(content, /exactReceivedLikeTitle/);
  assert.match(background, /exactReceivedLikeTitle/);
});

test('realtime sidebar recognizes icon-only Like without relying on unread dot', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /const sidebarLike = Array\.from/);
  assert.match(background, /if \(sidebarLike\) last_message = '👍'/);
});

test('personal Messenger replaces a timestamp-only SVG row with a Like glyph', () => {
  const content = fs.readFileSync('src/extension/content.js', 'utf8');
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(content, /hasOnlyClockFragments && messageRow\.querySelector\?\.\('svg'\).*rowEmojiContent = '👍'/);
  assert.match(background, /hasOnlyClockFragments && row\.querySelector\('svg'\).*rowEmojiContent = '👍'/);
});

test('history sync rejects DOM results when the tab changes user during parsing', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(background, /thread_changed_during_parse/);
  assert.match(background, /verifiedThreadAfterParse/);
});

test('a blank first-open conversation activates history and remains scroll-recoverable', () => {
  const background = fs.readFileSync('src/extension/background.js', 'utf8');
  const app = fs.readFileSync('src/client/App.jsx', 'utf8');
  assert.match(background, /\['ondemand_initial', 'ondemand_viewport', 'ondemand_older'\]\.includes\(mode\)/);
  assert.match(background, /emptyConfirmationMs = mode === 'ondemand_initial' \? 4000 : 1200/);
  assert.match(background, /domReadyStatus\.empty && mode === 'ondemand_older'[\s\S]+?loadOlderMessages\(mainContainer, mode\)/);
  assert.match(app, /onSyncThread=\{\(\) => requestThreadMessageSync\(activeThreadId, 'initial'\)\}/);
});

test('old label format: "Tin nhắn do Bạn gửi lúc..." -> outgoing (no regression)', () => {
  const r = resolveDirectionFromLabel('Tin nhắn do Bạn gửi lúc 10:09 sáng: xin chào', 'Người dùng Facebook');
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, true);
  assert.equal(r.senderName, 'Bạn');
});

test('old label format: "Tin nhắn do <ten khach> gửi lúc..." -> incoming (no regression)', () => {
  const r = resolveDirectionFromLabel('Tin nhắn do Nguyễn Trường gửi lúc 10:09 sáng: chào shop', null);
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, false);
  assert.equal(r.senderName, 'Nguyễn Trường');
});

test('new role=article label matching contact_name -> incoming', () => {
  const r = resolveDirectionFromLabel('Lúc 14:38, Người dùng Facebook: chào shop', 'Người dùng Facebook');
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, false);
  assert.equal(r.senderName, 'Người dùng Facebook');
});

test('new role=article label NOT matching contact_name -> outgoing (exclusion inference)', () => {
  const r = resolveDirectionFromLabel('Lúc 14:38, Người dùng Facebook: Em chào chị...', 'Người dùng Facebook thật khác');
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, true);
  assert.equal(r.senderName, 'Bạn');
});

test('new role=article label with no contact_name to compare against -> unmatched, caller must skip', () => {
  const r = resolveDirectionFromLabel('Lúc 14:38, Người dùng Facebook: Em chào chị...', null);
  assert.equal(r.matched, false);
});

test('empty/null label -> unmatched', () => {
  assert.equal(resolveDirectionFromLabel('', 'X').matched, false);
  assert.equal(resolveDirectionFromLabel(null, 'X').matched, false);
});

test('name comparison is case-insensitive and trims whitespace', () => {
  const r = resolveDirectionFromLabel('Lúc 08:00,  nguyễn trường  : hi', 'Nguyễn Trường');
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, false);
  assert.equal(r.senderName, 'nguyễn trường');
});

test('real DOM-captured label from live investigation (2026-08-19): date+comma inside the label must not break sender extraction', () => {
  const r = resolveDirectionFromLabel(
    'Lúc 14:38 29 Tháng 3, 2025, Người dùng Facebook: Em chào chị hiện tại bên em có chương trình VOCHER...',
    'Người dùng Facebook'
  );
  assert.equal(r.matched, true);
  assert.equal(r.senderName, 'Người dùng Facebook');
  // Confirmed with the user (2026-08-19): this message was genuinely sent BY
  // "Người dùng Facebook" (a spam/scam message into the Page), not by the
  // business account - name-matches-contact_name really does mean incoming.
  assert.equal(r.isOutgoing, false);
});

test('real DOM-captured label for a self-sent test message (2026-08-19): "Bạn:" name resolves to outgoing via exclusion', () => {
  const r = resolveDirectionFromLabel(
    'Lúc 16:36 30 Tháng 7, 2026, Bạn: anh ơi em test nha ',
    'Nguyễn Trường'
  );
  assert.equal(r.matched, true);
  assert.equal(r.isOutgoing, true);
  assert.equal(r.senderName, 'Bạn');
});
