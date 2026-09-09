import React from 'react';
import { AlertTriangle, Check, CheckCheck, RefreshCw, Loader2, Phone, Video, PhoneMissed, PhoneCall, PhoneIncoming } from 'lucide-react';
import MediaViewer from './MediaViewer.jsx';

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#ef4444'];

function pickAvatarColor(value) {
  const text = String(value || 'K');
  const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function formatDisplayTime(value) {
  if (!value) return '';
  const numericValue = Number(value);
  const date = new Date(Number.isFinite(numericValue) && numericValue > 0 ? numericValue : value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({ msg, activeThread, onRetry }) {
  const isOutgoing = Boolean(msg.is_outgoing || msg.from === 'me' || msg.sender_type === 'staff' || msg.sender_type === 'ai');
  const isUnsent = Boolean(msg.is_unsent || msg.unsent);
  const content = msg.content || msg.text || msg.message || '';
  const senderName = msg.sender_name || (isOutgoing ? (msg.is_ai || msg.sender_type === 'ai' ? 'AI' : 'Bạn') : activeThread?.contact_name || 'Khách hàng');
  const status = msg.status || msg.delivery_status || (msg.is_failed ? 'failed' : msg.is_sending ? 'sending' : 'sent');
  const displayTime = formatDisplayTime(msg.timestamp_ms || msg.created_at || msg.time);
  const avatarUrl = msg.sender_avatar || activeThread?.avatar_url;
  const avatarInitial = (senderName || activeThread?.contact_name || 'K').charAt(0).toUpperCase();
  const avatarColor = pickAvatarColor(activeThread?.id || senderName);

  const lowerContent = content.toLowerCase();
  const isCallMessage = Boolean(
    msg.media_type === 'call' ||
    (msg.fb_message_id && String(msg.fb_message_id).startsWith('call_')) ||
    lowerContent.includes('cuộc gọi') ||
    lowerContent.includes('gọi thoại') ||
    lowerContent.includes('bỏ lỡ cuộc gọi') ||
    lowerContent.includes('nhỡ cuộc') ||
    lowerContent.includes('audio call') ||
    lowerContent.includes('video call') ||
    lowerContent.includes('missed call') ||
    lowerContent.includes('missed audio') ||
    lowerContent.includes('missed video') ||
    lowerContent.includes('call ended') ||
    /\bcall\b/.test(lowerContent)
  );
  const isMissedCall = lowerContent.includes('bỏ lỡ') || lowerContent.includes('nhỡ') || lowerContent.includes('missed');
  const isVideoCall = lowerContent.includes('video');

  const hasMedia = Boolean(msg.local_media_path || msg.media_url);
  // Messenger can echo stale composer text as an image caption even though
  // CRM sent the image separately. Hide that transport artefact.
  const visibleContent = isOutgoing && hasMedia && msg.media_type === 'image' ? '' : content;
  if (!content && !hasMedia && !isUnsent) return null;

  return (
    <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'} items-end gap-2`}>
      {!isOutgoing && (
        <div className="relative flex-shrink-0">
          {avatarUrl ? (
            <img
              src={avatarUrl.startsWith?.('/api/') || avatarUrl.startsWith?.('http') ? avatarUrl : `/api/avatars/${avatarUrl}`}
              alt=""
              className="w-8 h-8 rounded-full object-cover border border-[var(--color-border)] shadow-sm"
            />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[var(--color-text-on-accent)] text-xs font-semibold shadow-sm"
              style={{ backgroundColor: avatarColor }}
            >
              {avatarInitial}
            </div>
          )}
        </div>
      )}

      <div className={`flex flex-col max-w-[min(78%,560px)] ${isOutgoing ? 'items-end' : 'items-start'}`}>
        <div
          className={`message-bubble px-4 py-2.5 text-sm shadow-sm ${
            isUnsent
              ? 'bg-[var(--color-danger-subtle)] border border-[var(--color-danger)]/35 text-[var(--color-danger)] rounded-2xl'
              : isOutgoing
              ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)] rounded-2xl rounded-br-sm'
              : 'bg-[var(--color-bg-panel)] text-[var(--color-text-primary)] rounded-2xl rounded-bl-sm border border-[var(--color-border)]'
          } ${status === 'sending' ? 'opacity-70' : ''} ${status === 'failed' ? 'ring-2 ring-[var(--color-danger)]/50' : ''}`}
        >
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
              <MediaViewer mediaType={msg.media_type} mediaUrl={msg.media_url} localMediaPath={msg.local_media_path} />
              {visibleContent && <p className={`text-inherit leading-relaxed whitespace-pre-wrap break-words ${hasMedia ? 'mt-1.5' : ''}`}>{visibleContent}</p>}
            </>
          )}
        </div>

        <div className={`flex items-center gap-1 mt-1 text-xs text-[var(--color-text-muted)] ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
          {isOutgoing && <span className="font-medium">{senderName}</span>}
          {displayTime && <time className="font-mono" dateTime={msg.created_at || undefined}>{displayTime}</time>}
          {isOutgoing && (status === 'sending' || status === 'pending') && (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
              Đang gửi
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
