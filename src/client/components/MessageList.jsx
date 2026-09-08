import React, { useRef, useEffect, useLayoutEffect } from 'react';
import MessageBubble from './MessageBubble.jsx';
import { MessageSquare, RefreshCw } from 'lucide-react';

export default function MessageList({ messages = [], activeThread, onSyncThread, onRetryMessage, onViewportScroll, historySyncing = false }) {
  const containerRef = useRef(null);
  const previousThreadIdRef = useRef(null);
  const previousHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const nearBottomRef = useRef(true);
  const suppressScrollRef = useRef(false);
  const pendingDeltaRef = useRef(0);
  const pendingOlderSyncRef = useRef(false);
  const scrollTimerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    const threadId = String(activeThread?.id || '');
    if (!container || !threadId || previousThreadIdRef.current === threadId) return;

    previousThreadIdRef.current = threadId;
    pendingDeltaRef.current = 0;
    pendingOlderSyncRef.current = false;
    suppressScrollRef.current = true;
    const timer = setTimeout(() => {
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
      previousHeightRef.current = container.scrollHeight;
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
    suppressScrollRef.current = true;

    if (pendingOlderSyncRef.current && oldHeight > 0 && newHeight > oldHeight) {
      // Older rows were prepended while Messenger moved to the preceding
      // viewport. Show that newly synchronized CRM page as well. Keep the
      // flag active across consecutive history batches; it is cleared only
      // when the operator deliberately scrolls down again.
      container.scrollTop = 0;
    } else if (nearBottomRef.current) {
      container.scrollTop = newHeight;
    } else if (oldHeight > 0 && newHeight > oldHeight) {
      // Older Messenger rows are inserted above the current CRM viewport.
      // Keep the same visible bubble in place without treating this React
      // layout correction as an operator scroll.
      container.scrollTop += newHeight - oldHeight;
    }

    lastScrollTopRef.current = container.scrollTop;
    previousHeightRef.current = newHeight;
    const release = requestAnimationFrame(() => { suppressScrollRef.current = false; });
    return () => cancelAnimationFrame(release);
  }, [messages]);

  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, []);

  const queueViewportDelta = (delta) => {
    if (!delta || !onViewportScroll) return;
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
    }, 180);
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const currentTop = container.scrollTop;
    const delta = currentTop - lastScrollTopRef.current;
    lastScrollTopRef.current = currentTop;
    nearBottomRef.current = container.scrollHeight - currentTop - container.clientHeight < 80;
    if (suppressScrollRef.current || !delta || !onViewportScroll) return;

    queueViewportDelta(delta);
  };

  const handleWheel = (event) => {
    const container = containerRef.current;
    if (!container || suppressScrollRef.current) return;
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
        {messages.length === 0 ? (
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
          <div className="py-2 space-y-4">
            {historySyncing && (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-panel)] border border-[var(--color-border)] rounded-full px-3 py-1.5 mx-auto w-fit">
                <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" />
                <span>Đang tải thêm lịch sử cũ hơn…</span>
              </div>
            )}
            {messages.map((msg, index) => {
              return (
                <div key={msg.id || msg.client_message_id || `${msg.fb_message_id}-${msg.created_at || msg.time || index}`}>
                  <MessageBubble msg={msg} activeThread={activeThread} onRetry={onRetryMessage} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
