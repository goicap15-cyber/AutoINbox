import React, { useEffect } from 'react';
import { MessageSquare, X, ArrowRight } from 'lucide-react';

export function NotificationToastContainer({ toasts = [], onDismiss, onSelectThread }) {
  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 max-w-sm w-full pointer-events-none select-none">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
          onSelect={() => {
            onSelectThread(toast.thread_id);
            onDismiss(toast.id);
          }}
        />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss, onSelect }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss();
    }, toast.duration || 6000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const avatarUrl = toast.avatar_url
    ? (String(toast.avatar_url).startsWith('http') ? toast.avatar_url : `/api/avatars/${toast.avatar_url}`)
    : null;

  return (
    <div
      role="alert"
      onClick={onSelect}
      className="pointer-events-auto relative overflow-hidden flex items-start gap-3 p-3.5 rounded-2xl bg-[var(--color-bg-panel)] border border-[var(--color-accent)]/40 shadow-2xl shadow-blue-500/10 cursor-pointer group hover:border-[var(--color-accent)] hover:shadow-blue-500/20 transition-all duration-300 transform hover:-translate-y-0.5 animate-in slide-in-from-bottom-5 fade-in"
    >
      {/* Avatar or Icon */}
      <div className="relative shrink-0 mt-0.5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-10 h-10 rounded-full object-cover border border-black/10 dark:border-white/10"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)] flex items-center justify-center font-bold text-sm">
            {toast.name ? toast.name.charAt(0).toUpperCase() : <MessageSquare size={18} />}
          </div>
        )}
        <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-[var(--color-success)] rounded-full border-2 border-[var(--color-bg-panel)] animate-pulse" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pr-6">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-[var(--color-accent)] uppercase tracking-wider">Tin nhắn mới</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">· vừa xong</span>
        </div>
        <h5 className="font-bold text-sm text-[var(--color-text-primary)] truncate mt-0.5">
          {toast.name || 'Khách hàng'}
        </h5>
        <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2 mt-0.5 break-words font-medium">
          {toast.content || 'Đã gửi một tin nhắn'}
        </p>
        <div className="mt-2 flex items-center gap-1 text-xs font-bold text-[var(--color-accent)] group-hover:underline">
          <span>Xem ngay</span>
          <ArrowRight size={13} className="transition-transform group-hover:translate-x-1" />
        </div>
      </div>

      {/* Close button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="absolute top-2.5 right-2.5 p-1 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        aria-label="Đóng thông báo"
      >
        <X size={14} />
      </button>

      {/* Progress countdown bar */}
      <div
        className="absolute bottom-0 left-0 right-0 h-1 bg-[var(--color-accent)]/80 origin-left"
        style={{
          animation: `shrinkWidth ${toast.duration || 6000}ms linear forwards`
        }}
      />
      <style>{`
        @keyframes shrinkWidth {
          from { transform: scaleX(1); }
          to { transform: scaleX(0); }
        }
      `}</style>
    </div>
  );
}
