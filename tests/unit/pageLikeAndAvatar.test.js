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

test('rawUnits sorting keeps interleaved text and like messages in strict DOM order', () => {
  // Mô phỏng 8 phần tử xuất hiện trong DOM từ trên xuống dưới
  const domPositions = [
    { id: 'msg-co-thay-tin-ko', text: 'có thấy tin ko', domIndex: 1 },
    { id: 'like-khach-1', text: '👍', domIndex: 2 },
    { id: 'like-page-1', text: '👍', domIndex: 3 },
    { id: 'msg-ko', text: 'Ko', domIndex: 4 },
    { id: 'like-khach-2', text: '👍', domIndex: 5 },
    { id: 'msg-ok-ko', text: 'Ok ko', domIndex: 6 },
    { id: 'like-khach-3', text: '👍', domIndex: 7 },
    { id: 'like-khach-4', text: '👍', domIndex: 8 },
    { id: 'like-page-2', text: '👍', domIndex: 9 }
  ];

  // Giả lập danh sách bị gom riêng text rồi tới like
  const unorganized = [
    domPositions[0], // có thấy tin ko
    domPositions[3], // Ko
    domPositions[5], // Ok ko
    domPositions[1], // like 1
    domPositions[2], // like 2
    domPositions[4], // like 3
    domPositions[6], // like 4
    domPositions[7], // like 5
    domPositions[8]  // like 6
  ];

  // Sort theo mock compareDocumentPosition
  const sorted = [...unorganized].sort((a, b) => a.domIndex - b.domIndex);

  assert.equal(sorted.length, 9);
  assert.equal(sorted[0].id, 'msg-co-thay-tin-ko');
  assert.equal(sorted[1].id, 'like-khach-1');
  assert.equal(sorted[2].id, 'like-page-1');
  assert.equal(sorted[3].id, 'msg-ko');
  assert.equal(sorted[4].id, 'like-khach-2');
  assert.equal(sorted[5].id, 'msg-ok-ko');
  assert.equal(sorted[6].id, 'like-khach-3');
  assert.equal(sorted[7].id, 'like-khach-4');
  assert.equal(sorted[8].id, 'like-page-2');
});

test('like color evidence classifies page yellow/gold like as outgoing and blue like as incoming', () => {
  const detectLikeDirection = (likeNode) => {
    const combined = ((likeNode.fill || '') + ' ' + (likeNode.style || '')).toLowerCase();
    if (/f7b125|fa3e3e|fa7b25|rgb\(\s*247|rgb\(\s*250|yellow|gold|amber|orange/i.test(combined)) {
      return { direction: true, source: 'like_color_page' };
    }
    if (/0084ff|0080ff|0a7cff|rgb\(\s*0,\s*132|rgb\(\s*0,\s*128|blue/i.test(combined)) {
      return { direction: false, source: 'like_color_customer' };
    }
    return { direction: null, source: 'unknown' };
  };

  const pageGoldLike = { fill: '#f7b125', style: 'color: rgb(247, 177, 37);' };
  const custBlueLike = { fill: '#0084ff', style: 'color: rgb(0, 132, 255);' };
  const unknownLike = { fill: '', style: '' };

  assert.equal(detectLikeDirection(pageGoldLike).direction, true);
  assert.equal(detectLikeDirection(pageGoldLike).source, 'like_color_page');

  assert.equal(detectLikeDirection(custBlueLike).direction, false);
  assert.equal(detectLikeDirection(custBlueLike).source, 'like_color_customer');

  assert.equal(detectLikeDirection(unknownLike).direction, null);
});

test('deterministic contextual like IDs remain stable across viewport shifts', () => {
  const generateBatchIds = (rawUnits, currentThread) => {
    const list = [];
    let lastKnownMsgId = null;
    let likeCounterAfterAnchor = 0;
    for (let i = 0; i < rawUnits.length; i++) {
      const unit = rawUnits[i];
      let fbMessageId = unit.fbMessageId;
      if (fbMessageId && !unit.isStandaloneLike) {
        lastKnownMsgId = fbMessageId;
        likeCounterAfterAnchor = 0;
      } else if (!fbMessageId || list.some(item => item.fb_message_id === fbMessageId)) {
        likeCounterAfterAnchor++;
        const anchorKey = lastKnownMsgId ? `after_${lastKnownMsgId}` : 'prefix';
        fbMessageId = `page_like_${currentThread}_${anchorKey}_${likeCounterAfterAnchor}`;
      }
      list.push({ fb_message_id: fbMessageId });
    }
    return list.map(x => x.fb_message_id);
  };

  const fullUnits = [
    { fbMessageId: 'mid.co_thay_tin_ko', isStandaloneLike: false },
    { fbMessageId: null, isStandaloneLike: true },
    { fbMessageId: 'mid.ko', isStandaloneLike: false },
    { fbMessageId: null, isStandaloneLike: true },
    { fbMessageId: 'mid.ok_ko', isStandaloneLike: false },
    { fbMessageId: null, isStandaloneLike: true },
    { fbMessageId: null, isStandaloneLike: true }
  ];

  const fullIds = generateBatchIds(fullUnits, 'th1');
  assert.equal(fullIds[1], 'page_like_th1_after_mid.co_thay_tin_ko_1');
  assert.equal(fullIds[3], 'page_like_th1_after_mid.ko_1');
  assert.equal(fullIds[5], 'page_like_th1_after_mid.ok_ko_1');
  assert.equal(fullIds[6], 'page_like_th1_after_mid.ok_ko_2');

  // Khi viewport chỉ mount từ mid.ko trở xuống (ảo hóa unmount phần trên):
  const scrolledUnits = [
    { fbMessageId: 'mid.ko', isStandaloneLike: false },
    { fbMessageId: null, isStandaloneLike: true },
    { fbMessageId: 'mid.ok_ko', isStandaloneLike: false },
    { fbMessageId: null, isStandaloneLike: true },
    { fbMessageId: null, isStandaloneLike: true }
  ];

  const scrolledIds = generateBatchIds(scrolledUnits, 'th1');
  // Nút Like sau mid.ko và mid.ok_ko vẫn giữ NGUYÊN ID chính xác!
  assert.equal(scrolledIds[1], 'page_like_th1_after_mid.ko_1');
  assert.equal(scrolledIds[3], 'page_like_th1_after_mid.ok_ko_1');
  assert.equal(scrolledIds[4], 'page_like_th1_after_mid.ok_ko_2');
});

test('reconcileBatchWithAnchors preserves exact interleaved order of text and like messages', () => {
  const ConversationRepository = require('../../src/server/repositories/ConversationRepository');

  const existingRows = [
    { fb_message_id: 'msg_co_thay_tin_ko', content: 'có thấy tin ko', sequence_order: 1 },
    { fb_message_id: 'msg_ko', content: 'Ko', sequence_order: 2 },
    { fb_message_id: 'msg_ok_ko', content: 'Ok ko', sequence_order: 3 },
    { fb_message_id: 'page_like_old_stale_1', content: '👍', sequence_order: 4 } // rác cũ ở đuôi
  ];

  // Batch mới từ DOM có đầy đủ các nút Like xen kẽ chuẩn xác
  const incomingBatch = [
    { fb_message_id: 'msg_co_thay_tin_ko', content: 'có thấy tin ko', is_outgoing: true, dom_order: 0 },
    { fb_message_id: 'like_khach_1', content: '👍', is_outgoing: false, dom_order: 1 },
    { fb_message_id: 'msg_ko', content: 'Ko', is_outgoing: false, dom_order: 2 },
    { fb_message_id: 'like_page_1', content: '👍', is_outgoing: true, dom_order: 3 },
    { fb_message_id: 'like_khach_2', content: '👍', is_outgoing: false, dom_order: 4 },
    { fb_message_id: 'msg_ok_ko', content: 'Ok ko', is_outgoing: false, dom_order: 5 },
    { fb_message_id: 'like_khach_3', content: '👍', is_outgoing: false, dom_order: 6 },
    { fb_message_id: 'like_page_2', content: '👍', is_outgoing: true, dom_order: 7 }
  ];

  const res = ConversationRepository.reconcileBatchWithAnchors(existingRows, incomingBatch, { mode: 'page_initial' });
  assert.equal(res.status, 'committed');

  const ids = res.mergedList.map(m => m.fb_message_id);
  assert.deepEqual(ids, [
    'msg_co_thay_tin_ko',
    'like_khach_1',
    'msg_ko',
    'like_page_1',
    'like_khach_2',
    'msg_ok_ko',
    'like_khach_3',
    'like_page_2'
  ]);

  // Đảm bảo không còn tồn tại tin like rác cũ 'page_like_old_stale_1' ở đuôi
  assert.equal(ids.includes('page_like_old_stale_1'), false);
});
