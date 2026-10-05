import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import MessageBubble from './MessageBubble.jsx';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { collapseMessengerMediaCompanions } from '../utils/messageDedup.js';
import { getMessageDateKey, formatDateSeparatorLabel } from '../utils/messageTimestampPresentation.js';

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#ef4444'];

export default function MessageList({ messages = [], activeThread, onSyncThread, onRetryMessage, onViewportScroll, historySyncing = false, jumpToDate = null }) {
  const containerRef = useRef(null);
  const previousThreadIdRef = useRef(null);
  const previousHeightRef = useRef(0);
  const previousFirstMessageRef = useRef('');
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  // Neo giữ vị trí: bong bóng đầu tiên đang xem + offset của nó lúc cuộn cuối.
  // Dùng thay cho phép bù "scrollTop += chênh lệch chiều cao" - phép bù đó trượt
  // vị trí khi sync về vừa prepend tin cũ vừa append tin mới (reproduced
  // 2026-09-17: operator đang đọc lịch sử bị đẩy xuống dưới).
  const scrollAnchorRef = useRef(null);
  // Nhảy tới ngày đang lọc: mở hội thoại khi bộ lọc ngày bật → chat tự cuộn
  // tới tin nhắn đầu tiên của ngày đó (nếu đã có trong DB).
  const jumpStateRef = useRef({ done: false, attempts: 0 });
  const nearBottomRef = useRef(true);
  const suppressScrollRef = useRef(false);
  const pendingDeltaRef = useRef(0);
  const pendingOlderSyncRef = useRef(false);
  const historyRequestInFlightRef = useRef(false);
  const scrollTimerRef = useRef(null);
  const syncWasActiveRef = useRef(false);
  const localSyncTimeoutRef = useRef(null);
  // Wheel lên của operator gần nhất - dùng phân biệt với scrollTop bị trình
  // duyệt clamp khi nội dung co lại giữa chừng render (không phải thao tác user).
  const pendingUserWheelUpRef = useRef(false);
  const [localHistorySyncing, setLocalHistorySyncing] = useState(false);
  const displayMessages = collapseMessengerMediaCompanions(messages).filter((msg) => {
    // A Messenger media row can arrive before its URL is hydrated. Keep that
    // row only when it has a real media identity; never render empty text
    // placeholders produced by the transient video shell.
    const content = String(msg?.content ?? msg?.text_content ?? msg?.text ?? msg?.message ?? '').trim();
    // media_type alone is not enough to render a message. Messenger emits
    // empty placeholder rows before the actual attachment URL arrives.
    const media = Boolean(msg?.media_url || msg?.local_media_path || msg?.attachment_id
      || msg?.attachment?.preview_url || msg?.attachment?.media_url
      || msg?.attachment?.local_media_path || msg?.attachment?.id
      || msg?.media_type === 'call');
    // A standalone contact heading occasionally arrives as a DOM message.
    // Never show it as an incoming chat bubble when it has no real media.
    const contactName = String(activeThread?.contact_name || '').trim().toLocaleLowerCase('vi-VN');
    const isContactHeading = !Boolean(msg?.is_outgoing) && Boolean(content) && !media
      && contactName && content.toLocaleLowerCase('vi-VN') === contactName;
    return Boolean((content || media) && !isContactHeading);
  });
  // CRM-owned bubbles keep the client identity for their whole lifecycle.
  // The database id and Facebook mid arrive later and must not remount the
  // DOM node or make React treat the same image as a new bubble.
  const messageIdentity = (msg, index) => String(msg?.ui_render_key || msg?.client_message_id || msg?.id || msg?.fb_message_id || `${msg?.created_at || msg?.time || ''}:${index}`);

  useEffect(() => {
    const container = containerRef.current;
    const threadId = String(activeThread?.id || '');
    if (!container || !threadId || previousThreadIdRef.current === threadId) return;

    previousThreadIdRef.current = threadId;
    jumpStateRef.current = { done: false, attempts: 0 };
    pendingDeltaRef.current = 0;
    pendingOlderSyncRef.current = false;
    historyRequestInFlightRef.current = false;
    setLocalHistorySyncing(false);
    suppressScrollRef.current = true;
    const timer = setTimeout(() => {
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
      previousHeightRef.current = container.scrollHeight;
      previousFirstMessageRef.current = displayMessages.length ? messageIdentity(displayMessages[0], 0) : '';
      nearBottomRef.current = true;
      suppressScrollRef.current = false;
    }, 50);
    return () => clearTimeout(timer);
  }, [activeThread?.id]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const oldHeight = previousHeightRef.current;
    const newHeight = container.scrollHeight;
    const nextFirst = displayMessages.length ? messageIdentity(displayMessages[0], 0) : '';
    const firstChanged = Boolean(previousFirstMessageRef.current && nextFirst && previousFirstMessageRef.current !== nextFirst);
    suppressScrollRef.current = true;

    const anchor = scrollAnchorRef.current;
    let anchored = false;
    if (!nearBottomRef.current && anchor && anchor.scrollTop > 0) {
      try {
        const el = container.querySelector(`[data-anchor-key="${String(anchor.key).replace(/"/g, '\\"')}"]`);
        if (el) {
          container.scrollTop = el.offsetTop - (anchor.offsetTop - anchor.scrollTop);
          scrollAnchorRef.current = { key: anchor.key, offsetTop: el.offsetTop, scrollTop: container.scrollTop };
          anchored = true;
        }
      } catch (_) {}
    }
    if (!anchored) {
      if (pendingOlderSyncRef.current && firstChanged && oldHeight > 0 && newHeight > oldHeight) {
        // Older rows were prepended while Messenger moved to the preceding
        // viewport. Show that newly synchronized CRM page as well. Keep the
        // flag active across consecutive history batches; it is cleared only
        // when the operator deliberately scrolls down again.
        container.scrollTop += newHeight - oldHeight;
      } else if (nearBottomRef.current) {
        container.scrollTop = newHeight;
      } else if (firstChanged && oldHeight > 0 && newHeight > oldHeight) {
        // Compensate only for genuinely prepended history. A realtime message
        // appended at the bottom must not drag the operator down from history.
        container.scrollTop += newHeight - oldHeight;
      }
    }

    // Jump-to-date: nếu bộ lọc ngày đang bật mà ngày đó chưa nhảy thì cuộn tới
    // tin đầu tiên của ngày (element phải đã mount trong DOM).
    if (jumpToDate && !jumpStateRef.current.done) {
      const el = container.querySelector(`[data-msg-date="${String(jumpToDate).replace(/"/g, '')}"]`);
      if (el) {
        container.scrollTop = el.offsetTop - 8;
        lastScrollTopRef.current = container.scrollTop;
        scrollAnchorRef.current = { key: el.getAttribute('data-anchor-key'), offsetTop: el.offsetTop, scrollTop: container.scrollTop };
        nearBottomRef.current = false;
        jumpStateRef.current.done = true;
      } else if (jumpStateRef.current.attempts >= 10) {
        jumpStateRef.current.done = true;
      } else {
        jumpStateRef.current.attempts += 1;
      }
    }

    lastScrollTopRef.current = container.scrollTop;
    previousHeightRef.current = newHeight;
    previousFirstMessageRef.current = nextFirst;
    const release = requestAnimationFrame(() => { suppressScrollRef.current = false; });
    return () => cancelAnimationFrame(release);
  }, [messages, jumpToDate]);

  // Keep the viewport pinned to the newest message when media/layout
  // finishes loading. Do not disturb an operator who is reading history.
  useEffect(() => {
    const container = containerRef.current;
    const content = container?.firstElementChild;
    if (!container || !content || typeof ResizeObserver === 'undefined') return;
    const keepAtBottom = () => {
      if (suppressScrollRef.current || !nearBottomRef.current) return;
      // Chốt an toàn thứ hai: nếu khoảng cách thực tới đáy đã xa (operator
      // đang đọc lịch sử) thì cờ nearBottom là stale - tắt nó thay vì kéo
      // view xuống đáy.
      if (container.scrollHeight - container.scrollTop - container.clientHeight > 120) {
        nearBottomRef.current = false;
        return;
      }
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
      previousHeightRef.current = container.scrollHeight;
    };
    const observer = new ResizeObserver(keepAtBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [activeThread?.id]);

  useEffect(() => {
    jumpStateRef.current = { done: false, attempts: 0 };
  }, [jumpToDate]);

  useEffect(() => {
    if (historySyncing) syncWasActiveRef.current = true;
    else if (syncWasActiveRef.current) {
      syncWasActiveRef.current = false;
      historyRequestInFlightRef.current = false;
      setLocalHistorySyncing(false);
      if (localSyncTimeoutRef.current) clearTimeout(localSyncTimeoutRef.current);
      localSyncTimeoutRef.current = null;
    }
  }, [historySyncing]);

  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    if (localSyncTimeoutRef.current) clearTimeout(localSyncTimeoutRef.current);
  }, []);

  const queueViewportDelta = (delta) => {
    if (!delta || !onViewportScroll) return;
    if (delta < 0 && activeThread?.history_completed === 1) return;
    // History synchronization is one-way: only an upward gesture can reveal
    // rows older than the current CRM snapshot. A downward sync used to let
    // Messenger's newer viewport overwrite the persisted oldest cursor.
    if (delta > 0) {
      pendingOlderSyncRef.current = false;
      return;
    }
    if (delta < 0 && historyRequestInFlightRef.current) return;
    if (delta < 0) {
      historyRequestInFlightRef.current = true;
      // Give immediate feedback on the first upward gesture. The parent state
      // turns on once the request is dispatched; this local state covers the
      // debounce gap so the operator never has to scroll down/up repeatedly.
      pendingOlderSyncRef.current = true;
      setLocalHistorySyncing(true);
      if (localSyncTimeoutRef.current) clearTimeout(localSyncTimeoutRef.current);
      localSyncTimeoutRef.current = setTimeout(() => {
        historyRequestInFlightRef.current = false;
        setLocalHistorySyncing(false);
      }, 15000);
    }
    pendingDeltaRef.current += delta;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      const pendingDelta = pendingDeltaRef.current;
      pendingDeltaRef.current = 0;
      scrollTimerRef.current = null;
      if (pendingDelta) {
        if (pendingDelta < 0) pendingOlderSyncRef.current = true;
        else if (pendingDelta > 0) pendingOlderSyncRef.current = false;
        onViewportScroll(pendingDelta);
      }
    }, 80);
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const currentTop = container.scrollTop;
    const delta = currentTop - lastScrollTopRef.current;
    lastScrollTopRef.current = currentTop;
    const currentHeight = container.scrollHeight;
    const contentShrank = currentHeight < lastScrollHeightRef.current;
    lastScrollHeightRef.current = currentHeight;
    // nearBottom chỉ cập nhật từ lượt cuộn THẬT của người dùng. Hai trường hợp
    // không được phép bật cờ này: (1) scroll do chương trình (suppress), (2)
    // scroll do trình duyệt clamp scrollTop khi nội dung CO LẠI tạm thời
    // (bubble remount/ảnh đang tải giữa chừng sync) - lúc đó viewport rơi gần
    // đáy là ảo, nếu bật cờ thì cơ chế bám đáy sẽ kéo operator xuống đáy khi
    // họ đang đọc lịch sử (reproduced 2026-09-17, hai lần).
    if (!suppressScrollRef.current && delta !== 0) {
      const distanceToBottom = currentHeight - currentTop - container.clientHeight;
      if (distanceToBottom < 80) {
        if (!contentShrank) nearBottomRef.current = true;
      } else {
        nearBottomRef.current = false;
      }
    }
    if (!suppressScrollRef.current && delta !== 0) {
      try {
        const containerRect = container.getBoundingClientRect();
        for (const el of container.querySelectorAll('[data-anchor-key]')) {
          if (el.getBoundingClientRect().bottom > containerRect.top + 24) {
            scrollAnchorRef.current = { key: el.getAttribute('data-anchor-key'), offsetTop: el.offsetTop, scrollTop: currentTop };
            break;
          }
        }
      } catch (_) {}
    }
    if (suppressScrollRef.current || !delta || !onViewportScroll) {
      pendingUserWheelUpRef.current = false;
      return;
    }
    // 2026-10-03: khi nội dung CO LẠI giữa chừng render (dedupe/reconcile),
    // trình duyệt tự clamp scrollTop xuống để giữ khung hình - sự kiện đó
    // KHÔNG phải thao tác cuộn. Trước đây delta âm này bị hiểu là "cuộn lên"
    // -> gửi crm_scroll_older mỗi khi sync trả dữ liệu về -> tab history bị
    // giành liên tục, tin khách nghẽn ~10s (reproduce 2026-10-03).
    const clampedByContentShrink = delta < 0 && contentShrank && !pendingUserWheelUpRef.current;
    pendingUserWheelUpRef.current = false;
    if (clampedByContentShrink) return;

    queueViewportDelta(delta);
  };

  const handleWheel = (event) => {
    const container = containerRef.current;
    if (!container || suppressScrollRef.current) return;
    if (event.deltaY < 0 && activeThread?.history_completed === 1) return;
    if (event.deltaY < 0) pendingUserWheelUpRef.current = true;
    // At scrollTop=0 another upward wheel does not change scrollTop, therefore
    // React's onScroll never fires. Forward that boundary gesture explicitly
    // so each additional wheel requests the next Messenger history page.
    if (container.scrollTop <= 2 && event.deltaY < 0) {
      queueViewportDelta(event.deltaY);
    }
  };

  return (
    <div ref={containerRef} onScroll={handleScroll} onWheel={handleWheel} className="chat-messages bg-[var(--color-bg-app)] flex-1 overflow-y-auto px-4 py-5">
      <div className="chat-content-wrapper relative max-w-3xl mx-auto">
        {activeThread?.history_completed === 1 && displayMessages.length > 0 && (
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-panel)] border border-[var(--color-border)] rounded-full px-3 py-1.5 mx-auto mb-3 w-fit select-none">
            <span>Đã tải hết toàn bộ lịch sử</span>
          </div>
        )}
        {(historySyncing || localHistorySyncing) && activeThread?.history_completed !== 1 && (
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-panel)] border border-[var(--color-border)] rounded-full px-3 py-1.5 mx-auto mb-3 w-fit">
            <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" />
            <span>Đang tải thêm lịch sử cũ hơn…</span>
          </div>
        )}
        {displayMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center select-none min-h-[360px]">
            <div className="w-14 h-14 rounded-full bg-[var(--color-bg-panel)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-muted)] mb-3 shadow-sm">
              <MessageSquare size={26} strokeWidth={1.5} />
            </div>
            <h4 className="text-base font-semibold text-[var(--color-text-primary)] mb-1">Chưa có tin nhắn</h4>
            <p className="text-sm text-[var(--color-text-secondary)] max-w-xs mb-3 leading-relaxed">
              Hội thoại này chưa có nội dung hoặc dữ liệu chưa được đồng bộ từ Facebook.
            </p>
            {onSyncThread && (
              <button
                type="button"
                onClick={onSyncThread}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] text-sm font-medium rounded-full transition-colors shadow-sm"
              >
                <RefreshCw size={14} strokeWidth={1.75} />
                <span>Đồng bộ lại hội thoại</span>
              </button>
            )}
          </div>
        ) : (
          <div className="py-2 space-y-1.5">
            {displayMessages.map((msg, index) => {
              const currentDateKey = getMessageDateKey(msg);
              const previousDateKey = index > 0 ? getMessageDateKey(displayMessages[index - 1]) : null;
              const showDateDivider = currentDateKey && currentDateKey !== previousDateKey;

              return (
                <React.Fragment key={messageIdentity(msg, index)}>
                  {showDateDivider && (
                    <div className="flex items-center gap-3 my-4 select-none">
                      <div className="flex-1 h-px bg-[var(--color-border)]/60" />
                      <span className="text-[11px] font-medium text-[var(--color-text-muted)] px-3 py-0.5 rounded-full bg-[var(--color-bg-panel)] border border-[var(--color-border)] shadow-xs capitalize">
                        {formatDateSeparatorLabel(msg)}
                      </span>
                      <div className="flex-1 h-px bg-[var(--color-border)]/60" />
                    </div>
                  )}
                  <div data-anchor-key={messageIdentity(msg, index)} data-msg-date={getMessageDateKey(msg) || ''}>
                    <MessageBubble msg={msg} activeThread={activeThread} onRetry={onRetryMessage} />
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
