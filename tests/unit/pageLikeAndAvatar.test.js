const test = require('node:test');
const assert = require('node:assert/strict');

test('like button aria-label matching identifies thumbs-up correctly', () => {
  const isLikeAria = (label) => {
    if (!label) return false;
    const l = label.toLowerCase().trim();
    return l === 'thích' || l === 'like' || l.includes('biểu tượng thích') || l.includes('thumbs up');
  };

  assert.equal(isLikeAria('Thích'), true);
  assert.equal(isLikeAria('like'), true);
  assert.equal(isLikeAria('Gửi biểu tượng thích'), true);
  assert.equal(isLikeAria('Biểu tượng thích'), true);
  assert.equal(isLikeAria('thumbs up'), true);
  assert.equal(isLikeAria('xin chào'), false);
  assert.equal(isLikeAria(null), false);
});

test('cleanMessageText normalizes like phrases to 👍', () => {
  const { cleanMessageText } = require('../../src/server/utils/textFilter');

  assert.equal(cleanMessageText('Thích'), '👍');
  assert.equal(cleanMessageText('like'), '👍');
  assert.equal(cleanMessageText('Biểu tượng thích'), '👍');
  assert.equal(cleanMessageText('Biểu tượng cảm xúc thích'), '👍');
  assert.equal(cleanMessageText('Gửi biểu tượng thích'), '👍');
  assert.equal(cleanMessageText('Tin nhắn do Phạm Hùng gửi lúc 09:55: Thích'), '👍');
  assert.equal(cleanMessageText('Message sent by John at 10:00: like'), '👍');
  // Regular message containing the word 'thích' should NOT be normalized to 👍
  assert.equal(cleanMessageText('Tôi rất thích sản phẩm này'), 'Tôi rất thích sản phẩm này');
});

test('avatar multi-tier hierarchy prioritizes right details pane over sidebar and header', () => {
  const resolveCandidateTier = ({ rightPaneImg, headerImg, sidebarImg }) => {
    if (rightPaneImg && !rightPaneImg.includes('rsrc.php')) {
      return { url: rightPaneImg, tier: 2 };
    }
    if (headerImg && !headerImg.includes('rsrc.php')) {
      return { url: headerImg, tier: 1 };
    }
    if (sidebarImg && !sidebarImg.includes('rsrc.php')) {
      return { url: sidebarImg, tier: 1 };
    }
    return null;
  };

  // Case 1: Only sidebar has silhouette
  const r1 = resolveCandidateTier({
    sidebarImg: 'https://scontent.xx.fbcdn.net/v/silhouette.jpg'
  });
  assert.equal(r1.tier, 1);
  assert.equal(r1.url, 'https://scontent.xx.fbcdn.net/v/silhouette.jpg');

  // Case 2: Right pane mounts with anime photo -> Tier 2 wins
  const r2 = resolveCandidateTier({
    sidebarImg: 'https://scontent.xx.fbcdn.net/v/silhouette.jpg',
    headerImg: 'https://scontent.xx.fbcdn.net/v/silhouette.jpg',
    rightPaneImg: 'https://scontent.xx.fbcdn.net/v/anime_real_avatar.jpg'
  });
  assert.equal(r2.tier, 2);
  assert.equal(r2.url, 'https://scontent.xx.fbcdn.net/v/anime_real_avatar.jpg');
});

test('direction resolution matches contact avatar by name or generic alt', () => {
  const detectDirection = ({ contactName, imgAlt, bubbleLeft, containerWidth }) => {
    if (imgAlt && contactName && imgAlt.toLowerCase().includes(contactName.toLowerCase())) {
      return { direction: false, source: 'avatar_contact_match' };
    }
    if (imgAlt && /đại diện|profile/i.test(imgAlt)) {
      return { direction: false, source: 'avatar_contact_match' };
    }
    const containerCenter = containerWidth * 0.52;
    if (bubbleLeft < containerCenter - 15) {
      return { direction: false, source: 'container_centerline' };
    }
    return { direction: true, source: 'container_centerline' };
  };

  // Nút Like có avatar mang tên "Phạm Hùng" -> Incoming (false)
  const res1 = detectDirection({
    contactName: 'Phạm Hùng',
    imgAlt: 'Ảnh của Phạm Hùng',
    bubbleLeft: 45,
    containerWidth: 900
  });
  assert.equal(res1.direction, false);
  assert.equal(res1.source, 'avatar_contact_match');

  // Nút Like nằm ở nửa bên trái (45px < 468px) dù không có text alt -> Incoming (false)
  const res2 = detectDirection({
    contactName: 'Phạm Hùng',
    imgAlt: '',
    bubbleLeft: 45,
    containerWidth: 900
  });
  assert.equal(res2.direction, false);
  assert.equal(res2.source, 'container_centerline');

  // Nút Like hoặc tin nhắn gửi đi nằm ở nửa bên phải (750px > 468px) -> Outgoing (true)
  const res3 = detectDirection({
    contactName: 'Phạm Hùng',
    imgAlt: '',
    bubbleLeft: 750,
    containerWidth: 900
  });
  assert.equal(res3.direction, true);
  assert.equal(res3.source, 'container_centerline');
});

test('isLikeElementOrWrapper logic identifies thumbs-up inside role="button" message bubble', () => {
  const isLike = (node, rawText) => {
    if (!node) return false;
    const trimmed = (rawText || '').trim();
    if (trimmed === '👍') return true;

    const wrapperAria = (node.ariaLabel || '').toLowerCase();
    if (wrapperAria.includes('thích') || wrapperAria.includes('thumbs up') || wrapperAria.includes('like')) {
      return true;
    }

    const svgs = node.tagName === 'svg' ? [node] : (node.svgs || []);
    for (const svg of svgs) {
      if (svg.isActionMenu) continue;
      const vb = svg.viewBox || '';
      const aria = (svg.ariaLabel || '').toLowerCase();
      if (aria.includes('thích') || aria.includes('like') || aria.includes('thumbs up')) return true;
      if (vb.includes('24') || vb.includes('20') || vb.includes('16')) {
        const fill = (svg.fill || '').toLowerCase();
        if (fill.includes('0084ff') || fill.includes('currentcolor') || fill.includes('blue')) {
          return true;
        }
      }
    }
    return false;
  };

  // Case 1: Thumbs-up SVG inside an incoming message bubble with role="button"
  const incomingLikeBubble = {
    tagName: 'div',
    role: 'button',
    ariaLabel: '',
    svgs: [
      {
        tagName: 'svg',
        viewBox: '0 0 24 24',
        fill: '#0084ff',
        ariaLabel: '',
        isActionMenu: false
      }
    ]
  };
  assert.equal(isLike(incomingLikeBubble, ''), true);

  // Case 2: SVG inside an action menu (like reaction smiley button) should NOT be counted as Like message
  const actionMenuButton = {
    tagName: 'div',
    svgs: [
      {
        tagName: 'svg',
        viewBox: '0 0 24 24',
        fill: '#0084ff',
        ariaLabel: 'Bày tỏ cảm xúc',
        isActionMenu: true
      }
    ]
  };
  assert.equal(isLike(actionMenuButton, ''), false);
});


