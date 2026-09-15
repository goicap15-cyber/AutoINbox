import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCheck, RefreshCw, Loader2, Phone, Video, PhoneMissed, PhoneCall, PhoneIncoming } from 'lucide-react';
import MediaViewer from './MediaViewer.jsx';
import { getMessageDisplayTime, isConfirmedOutgoing } from '../utils/messageTimestampPresentation.js';

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#ef4444'];

function pickAvatarColor(value) {
  const text = String(value || 'K');
  const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function IncomingAvatar({ url, initial, color, threadId }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url, threadId]);

  if (url && !failed) {
    const source = String(url).startsWith('/api/') || /^https?:/i.test(String(url))
      ? String(url)
      : `/api/avatars/${String(url)}`;
    return (
      <img
        key={`${threadId || ''}:${source}`}
        src={source}
        alt=""
        className="w-8 h-8 rounded-full object-cover border border-[var(--color-border)] shadow-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-[var(--color-text-on-accent)] text-xs font-semibold shadow-sm"
      style={{ backgroundColor: color }}
    >
      {initial}
    </div>
  );
}

export default function MessageBubble({ msg, activeThread, onRetry }) {
  const [isTimePinned, setIsTimePinned] = useState(false);
  const isPendingDirection = msg.direction_status === 'pending';
  const isOutgoing = isConfirmedOutgoing(msg) || (!isPendingDirection && Boolean(msg.is_outgoing || msg.from === 'me' || msg.sender_type === 'staff' || msg.sender_type === 'ai'));
  const isUnsent = Boolean(msg.is_unsent || msg.unsent);
  const content = msg.content || msg.text || msg.message || '';
  const senderName = msg.sender_name || (isOutgoing ? (msg.is_ai || msg.sender_type === 'ai' ? 'AI' : 'Bạn') : activeThread?.contact_name || 'Khách hàng');
  // Persisted delivery_status is authoritative. A stale optimistic status can
  // remain 'pending' after the backend has confirmed the Messenger media.
  const status = msg.delivery_status || msg.status || (msg.is_failed ? 'failed' : msg.is_sending ? 'sending' : 'sent');
  const displayTime = getMessageDisplayTime(msg);
  const avatarUrl = activeThread?.avatar_url || msg.sender_avatar_url || msg.sender_avatar || msg.avatar_url;
  const avatarSeed = String(senderName || activeThread?.contact_name || '').trim();
  const avatarInitial = (Array.from(avatarSeed)[0] || 'K').toUpperCase();
  const avatarColor = pickAvatarColor(activeThread?.id || senderName);

  const lowerContent = content.toLowerCase();
  const mediaUrl = msg.media_url || msg.attachment?.preview_url || msg.attachment?.media_url || null;
  const mediaType = msg.media_type || msg.attachment?.media_type || null;
  const hasRenderableMedia = Boolean(
    msg.local_media_path || mediaUrl || msg.attachment_id || msg.attachment ||
    (mediaType && mediaType !== 'text' && mediaType !== 'call')
  );
  const hasCallText = /(?:cuộc gọi|gọi thoại|bỏ lỡ cuộc gọi|nhỡ cuộc|audio call|video call|missed call|missed audio|missed video|call ended)/i.test(content);
  const isCallMessage = Boolean(
    msg.media_type === 'call' ||
    (!hasRenderableMedia && (
      (msg.fb_message_id && String(msg.fb_message_id).startsWith('call_')) || hasCallText
    ))
  );
  const isMissedCall = lowerContent.includes('bỏ lỡ') || lowerContent.includes('nhỡ') || lowerContent.includes('missed');
  const isVideoCall = lowerContent.includes('video');

  const hasMedia = hasRenderableMedia;
  const visibleContent = isOutgoing && hasMedia && mediaType === 'image' ? '' : content;
  const isQuickLike = !isCallMessage && !isUnsent && !hasMedia && (visibleContent?.trim() === '👍' || /^(?:thích|like)$/i.test(visibleContent?.trim() || ''));

  if (!content && !hasMedia && !isUnsent) return null;

  return (
    <div
      onClick={() => setIsTimePinned((current) => !current)}
      className={`group flex ${isOutgoing ? 'justify-end' : 'justify-start'} items-end gap-2 cursor-pointer select-none`}
    >
      {!isOutgoing && (
        <div className="relative flex-shrink-0">
          <IncomingAvatar
            url={avatarUrl}
            initial={avatarInitial}
            color={avatarColor}
            threadId={activeThread?.id || msg.thread_id}
          />
        </div>
      )}

      <div className={`flex flex-col max-w-[min(78%,560px)] ${isOutgoing ? 'items-end' : 'items-start'}`}>
        <div
          className={`message-bubble ${
            isQuickLike || (hasMedia && !visibleContent)
              ? 'p-0 bg-transparent border-0 shadow-none'
              : `px-4 py-2.5 text-sm shadow-sm ${
                  isUnsent
                    ? 'bg-[var(--color-danger-subtle)] border border-[var(--color-danger)]/35 text-[var(--color-danger)] rounded-2xl'
                    : isOutgoing
                    ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)] rounded-2xl rounded-br-sm'
                    : 'bg-[var(--color-bg-panel)] text-[var(--color-text-primary)] rounded-2xl rounded-bl-sm border border-[var(--color-border)]'
                }`
          } ${status === 'sending' ? 'opacity-70' : ''} ${status === 'failed' ? 'ring-2 ring-[var(--color-danger)]/50' : ''}`}
        >
          {isQuickLike ? (
            <div
              className="inline-flex items-center justify-center select-none py-1 transition-transform hover:scale-110 active:scale-95 duration-150"
              role="img"
              aria-label="Thích"
              title="Thích"
            >
              <svg
                viewBox="0 0 24 24"
                className={`w-9 h-9 ${isOutgoing ? 'fill-[#f7b125] stroke-[#f7b125]' : 'fill-[#0084ff] stroke-[#0084ff]'} stroke-1 drop-shadow-sm`}
              >
                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
              </svg>
            </div>
          ) : (
            <>
              {isUnsent && (
                <div className="flex items-center gap-1.5 text-xs font-medium mb-1.5 pb-1.5 border-b border-[var(--color-danger)]/20">
                  <AlertTriangle size={13} strokeWidth={1.75} />
                  <span>Khách đã thu hồi</span>
                </div>
              )}
              {isCallMessage ? (
                <div className="flex items-center gap-2.5 py-0.5">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isOutgoing ? 'bg-white/20 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                    {isMissedCall ? <PhoneMissed size={16} /> : isVideoCall ? <Video size={16} /> : isOutgoing ? <PhoneCall size={16} /> : <PhoneIncoming size={16} />}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-semibold text-xs leading-tight">{content}</span>
                  </div>
                </div>
              ) : (
                <>
                  <MediaViewer mediaType={mediaType} mediaUrl={mediaUrl} localMediaPath={msg.local_media_path} />
                  {visibleContent && <p className={`text-inherit leading-relaxed whitespace-pre-wrap break-words select-text ${hasMedia ? 'mt-1.5' : ''}`}>{visibleContent}</p>}
                </>
              )}
            </>
          )}
        </div>

        <div
          className={`flex items-center gap-1 text-xs text-[var(--color-text-muted)] transition-all duration-200 ease-out overflow-hidden ${
            isTimePinned || status === 'sending' || status === 'pending' || status === 'failed'
              ? 'max-h-6 opacity-100 mt-1 translate-y-0'
              : 'max-h-0 opacity-0 mt-0 -translate-y-1 group-hover:max-h-6 group-hover:opacity-100 group-hover:mt-1 group-hover:translate-y-0'
          } ${isOutgoing ? 'justify-end' : 'justify-start'}`}
        >
          {isOutgoing && <span className="font-medium">{senderName}</span>}
          {displayTime ? (
            <time
              className="font-mono"
              dateTime={msg.created_at || undefined}
              title={new Date(Number(msg.timestamp_ms) || msg.created_at || msg.time || 0).toLocaleString('vi-VN')}
            >
              {displayTime}
            </time>
          ) : (
            isTimePinned && <span className="font-mono text-[10px] text-[var(--color-text-muted)] italic">Không rõ thời gian</span>
          )}
          {isOutgoing && (status === 'sending' || status === 'pending') && (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
              {hasMedia ? (mediaType === 'video' ? 'Đang gửi video...' : 'Đang gửi ảnh...') : 'Đang gửi'}
            </span>
          )}
          {isOutgoing && status === 'failed' && (
            <button onClick={() => onRetry?.(msg)} className="inline-flex items-center gap-1 text-[var(--color-danger)] font-medium hover:underline">
              <RefreshCw size={12} strokeWidth={1.75} />
              Thử lại
            </button>
          )}
          {isOutgoing && status !== 'sending' && status !== 'pending' && status !== 'failed' && (
            status === 'read' || status === 'delivered' ? (
              <CheckCheck size={13} className="text-[var(--color-accent)]" strokeWidth={1.75} />
            ) : (
              <Check size={13} className="text-[var(--color-text-muted)]" strokeWidth={1.75} />
            )
          )}
        </div>
      </div>
    </div>
  );
}
