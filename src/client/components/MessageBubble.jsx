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

// Biến URL trong nội dung tin nhắn thành liên kết bấm được (mở bằng trình
// duyệt hệ thống qua setWindowOpenHandler của Electron). Yêu cầu 2026-09-18:
// khách/operator gửi link facebook.com/share/v/... chỉ hiện chữ, không bấm được.
const CRM_URL_RE = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
function renderRichContent(text) {
  const str = String(text || '');
  const parts = [];
  let last = 0;
  let key = 0;
  let match;
  CRM_URL_RE.lastIndex = 0;
  while ((match = CRM_URL_RE.exec(str)) !== null) {
    let raw = match[0];
    // Tách dấu câu cuối (dấu chấm/dấu ngoặc sau link không thuộc link)
    const trail = raw.match(/[.,;:!?)\]]+$/);
    const trailing = trail ? trail[0] : '';
    if (trailing) raw = raw.slice(0, raw.length - trailing.length);
    if (match.index > last) parts.push(str.slice(last, match.index));
    const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    // URL dai rat de bubble bi xuong dong lung tung (nhin tach roia). Hien thi
    // rut gon o giua (gio…cuoi) - link that van nguyen ven khi bam.
    const display = raw.length > 52
      ? raw.slice(0, 34).replace(/^https?:\/\//i, '') + '…' + raw.slice(-14)
      : raw;
    parts.push(
      <a
        key={`lnk-${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href}
        onClick={(event) => {
          event.preventDefault();
          try { window.open(href, '_blank'); } catch (_) {}
        }}
        className="inline underline underline-offset-2 font-medium hover:opacity-80 cursor-pointer"
      >
        {display}
      </a>
    );
    if (trailing) parts.push(trailing);
    last = match.index + match[0].length;
  }
  if (last < str.length) parts.push(str.slice(last));
  return parts;
}

export default function MessageBubble({ msg, activeThread, onRetry }) {
  const [isTimePinned, setIsTimePinned] = useState(false);
  const isPendingDirection = msg.direction_status === 'pending';
  const isBoolOutgoing = (msg.is_outgoing === true || msg.is_outgoing === 1 || String(msg.is_outgoing || '').toLowerCase() === 'true' || String(msg.is_outgoing || '') === '1') || msg.from === 'me' || msg.sender_type === 'staff' || msg.sender_type === 'ai';
  const isOutgoing = isConfirmedOutgoing(msg) || (!isPendingDirection && Boolean(isBoolOutgoing));
  const isUnsent = Boolean(msg.is_unsent || msg.unsent);
  const content = msg.content || msg.text_content || msg.text || msg.message || '';
  const senderName = msg.sender_name || (isOutgoing ? (msg.is_ai || msg.sender_type === 'ai' ? 'AI' : 'Bạn') : activeThread?.contact_name || 'Khách hàng');
  // Persisted delivery_status is authoritative. A stale optimistic status can
  // remain 'pending' after the backend has confirmed the Messenger media.
  const status = msg.delivery_status || msg.status || (msg.is_failed ? 'failed' : msg.is_sending ? 'sending' : 'sent');
  // 'Đã xem': tin đi của operator có id <= mốc last_seen_message_id mà
  // extension bắt được từ DOM hội thoại đang mở trên tab Facebook.
  const seenUpTo = Number(activeThread?.last_seen_message_id || 0);
  const isSeenByCustomer = isOutgoing
    && seenUpTo > 0
    && Number(msg.id) > 0
    && Number(msg.id) <= seenUpTo
    && status !== 'sending' && status !== 'pending' && status !== 'failed';
  const displayTime = getMessageDisplayTime(msg);
  const avatarUrl = activeThread?.avatar_url || msg.sender_avatar_url || msg.sender_avatar || msg.avatar_url;
  const avatarSeed = String(senderName || activeThread?.contact_name || '').trim();
  const avatarInitial = (Array.from(avatarSeed)[0] || 'K').toUpperCase();
  const avatarColor = pickAvatarColor(activeThread?.id || senderName);

  const lowerContent = content.toLowerCase();
  const mediaUrl = msg.media_url || msg.attachment?.preview_url || msg.attachment?.media_url || null;
  const mediaType = msg.media_type || msg.attachment?.media_type || null;
  const hasRenderableMedia = Boolean(
    msg.local_media_path || mediaUrl || msg.attachment_id ||
    Boolean(msg.attachment?.preview_url || msg.attachment?.media_url || msg.attachment?.local_media_path || msg.attachment?.id)
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
  // Messenger can echo stale composer text as an image caption even though
  // CRM sent the image separately. Hide that transport artefact.
  // Facebook can surface a transport caption as a second text bubble beside an outgoing
  // image/video. The media bubble is the canonical representation in CRM.
  const isMediaPlaceholderText = (
    /^\s*\[?(?:Ảnh|Photo|Image|Video|Tệp|File|Sticker|Nhãn dán|Attachment|GIF)\]?\s*$/i.test(String(content || '').trim()) ||
    /^\s*(?:(?:Thứ\s*(?:[2-7]|Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|T[2-7]|CN),?\s*)?(?:\d{1,2}:\d{2}(?:\s*(?:ch|sa|am|pm|chiều|sáng|tối))?|\d{1,2}\s*(?:ch|sa|am|pm|chiều|sáng|tối))\s*$/i.test(String(content || '').trim()) ||
    /^\s*(?:(?:Thứ\s*(?:[2-7]|Hai|Ba|Tư|Năm|Sáu|Bảy)|Chủ Nhật|T[2-7]|CN),?\s*)?(?:\d{1,2}(?::\d{2})?(?:\s*(?:ch|sa|am|pm))?\s+)?\d{1,2}\s+(?:Tháng|thg)\s+\d{1,2}(?:,?\s*\d{4})?\s*$/i.test(String(content || '').trim())
  );
  const visibleContent = (hasMedia && (isOutgoing || isMediaPlaceholderText)) ? '' : content;
  const isLikeText = (content?.trim() === '👍' || /^(?:thích|like|biểu tượng thích)$/i.test(content?.trim() || '')) ||
                     (visibleContent?.trim() === '👍' || /^(?:thích|like|biểu tượng thích)$/i.test(visibleContent?.trim() || ''));
  const isQuickLike = !isCallMessage && !isUnsent && !hasMedia && isLikeText;
  const displayUrl = msg.local_media_path || mediaUrl || msg.attachment?.local_media_path || null;
  // Never render an empty placeholder bubble.
  // A valid bubble must carry visible content text, playable media (displayUrl), or a call payload.
  if (!visibleContent && !displayUrl && !isCallMessage && !isQuickLike) return null;

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
                  {msg.link_preview && !hasMedia && (
                    <a
                      href={msg.link_preview.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        try { window.open(msg.link_preview.url, "_blank"); } catch (_) {}
                      }}
                      className="block mt-2 mb-1 rounded-xl overflow-hidden border border-black/10 bg-black/5 dark:bg-white/5 hover:opacity-90 transition-opacity cursor-pointer"
                    >
                      {msg.link_preview.image_url && (
                        <img
                          src={msg.link_preview.image_url}
                          alt=""
                          className="w-full max-h-56 object-cover"
                          onError={(ev) => { ev.currentTarget.style.display = "none"; }}
                        />
                      )}
                      <div className="px-2.5 py-1.5">
                        {(() => {
                          // Link share ẢNH (/share/p/): Messenger hiển thị chú
                          // thích "Tên đã thêm một ảnh mới." - tái tạo đúng định
                          // dạng đó từ og:title (tên người đăng).
                          const isPhotoShare = /facebook\.com\/share\/p\//i.test(msg.link_preview.url || '');
                          let cardTitle = msg.link_preview.title || '';
                          if (isPhotoShare && cardTitle && !/\bảnh\b/i.test(cardTitle)) {
                            cardTitle = cardTitle + ' đã thêm một ảnh mới.';
                          }
                          return cardTitle ? <div className="text-[11px] font-semibold leading-snug line-clamp-2">{cardTitle}</div> : null;
                        })()}
                        {msg.link_preview.site_name && <div className="text-[10px] opacity-60 truncate mt-0.5">{msg.link_preview.site_name}</div>}
                      </div>
                    </a>
                  )}
                  <MediaViewer mediaType={mediaType} mediaUrl={mediaUrl} localMediaPath={msg.local_media_path} />
                  {visibleContent && <p className={`text-inherit leading-relaxed whitespace-pre-wrap break-words select-text ${hasMedia ? 'mt-1.5' : ''}`}>{renderRichContent(visibleContent)}</p>}
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
            isSeenByCustomer || status === 'read' || status === 'delivered' ? (
              <span className="inline-flex items-center gap-1 text-[var(--color-accent)] font-medium">
                <CheckCheck size={13} strokeWidth={1.75} />
                Đã xem
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Check size={13} className="text-[var(--color-text-muted)]" strokeWidth={1.75} />
                Đã gửi
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}
