import React from 'react';
import { BellRing, Clock3, Archive } from 'lucide-react';
import { getStatusBadgeStyle } from '../utils/color.js';
import { getReminderDueAriaLabel, getReminderDueState } from '../utils/reminderPresentation.js';

const AVATAR_COLORS = ['#2684ff', '#a855f7', '#0fbd74', '#ec4899', '#ff6b2c', '#00b8a9', '#6366f1', '#ff3b4f', '#f5b51b', '#06b6d4'];

function pickAvatarColor(id) {
  const text = String(id || '0');
  const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function formatTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export default function ConversationItem({ thread, isSelected, onSelect, accounts = [], inboxSources = [], selectionMode = false, isChecked = false, onToggle }) {
  const account = accounts.find((item) => String(item.id) === String(thread.account_id));
  const source = inboxSources.find((item) => String(item.id) === String(thread.source_id));
  const isOnline = account ? account.is_extension_connected !== false : true;
  const unreadCount = Number(thread.unread_count || (thread.is_unread ? 1 : 0));
  const avatarColor = pickAvatarColor(thread.id || thread.nickname || thread.contact_name);
  const title = thread.nickname || thread.contact_name || thread.name || 'Khách hàng';
  const preview = thread.last_message || 'Chưa có tin nhắn';
  const showAccountName = accounts.length > 1;
  const accountName = account ? (account.name || account.id) : (thread.account_id || 'Facebook');
  const sourceType = thread.source_type || source?.source_type || 'personal_messenger';
  const sourceName = thread.source_name || source?.display_name || accountName;
  const sourceLabel = sourceType === 'page_messenger' ? 'Page · ' + sourceName : 'Messenger · ' + sourceName;
  const sourceClass = sourceType === 'page_messenger'
    ? 'bg-violet-500/10 text-violet-500 border border-violet-500/20'
    : 'bg-sky-500/10 text-sky-500 border border-sky-500/20';
  const statusMap = {
    UNPROCESSED: { label: 'Chưa xử lý', className: 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)]' },
    ASSIGNED: { label: 'Đang xử lý', className: 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]' },
    COMPLETED: { label: 'Đã chốt', className: 'bg-[var(--color-success-subtle)] text-[var(--color-success)]' }
  };
  const status = statusMap[thread.status] || statusMap.UNPROCESSED;
  const reminderState = getReminderDueState(thread);
  const isReminderDue = reminderState.isDue;
  const reminderAriaLabel = getReminderDueAriaLabel(thread);
  const isSelectedState = selectionMode ? isChecked : isSelected;
  const rowClassName = [
    'w-full flex items-center gap-3 px-3 py-3 min-h-[82px] cursor-pointer text-left transition-colors border-b border-[var(--color-border)]',
    isSelectedState
      ? (isReminderDue
        ? 'bg-[var(--color-accent-subtle)] border-l-4 border-l-[var(--color-danger)] pl-2 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.28)]'
        : 'bg-[var(--color-accent-subtle)] border-l-4 border-l-[var(--color-accent)] pl-2')
      : (isReminderDue
        ? 'border-l-4 border-l-[var(--color-danger)] bg-[var(--color-danger-subtle)] shadow-[inset_0_0_0_1px_rgba(239,68,68,0.18)] hover:brightness-[0.98]'
        : 'border-l-4 border-l-transparent hover:bg-[var(--color-bg-hover)]')
  ].join(' ');

  return (
    <button
      type="button"
      onClick={selectionMode ? onToggle : onSelect}
      aria-pressed={selectionMode ? isChecked : undefined}
      aria-label={isReminderDue ? title + '. ' + reminderAriaLabel : title}
      className={rowClassName}
    >
      {selectionMode && (
        <span aria-hidden="true" className={'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold ' + (isChecked ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)] bg-[var(--color-bg-surface)]')}>
          {isChecked ? '✓' : ''}
        </span>
      )}
      <div className="relative flex-shrink-0">
        {thread.avatar_url ? (
          <img src={String(thread.avatar_url).startsWith('http') ? thread.avatar_url : '/api/avatars/' + thread.avatar_url} alt="" className="w-11 h-11 rounded-full object-cover border border-[var(--color-border)] shadow-sm" />
        ) : (
          <div className="w-11 h-11 rounded-full flex items-center justify-center text-[var(--color-text-on-accent)] font-semibold text-sm shadow-sm" style={{ backgroundColor: avatarColor }}>
            {title.charAt(0).toUpperCase()}
          </div>
        )}
        {isReminderDue && (
          <span className="reminder-due-pulse absolute -left-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--color-bg-panel)] bg-[var(--color-danger)] text-[var(--color-text-on-accent)] shadow-sm" title={reminderAriaLabel} aria-hidden="true"><BellRing size={12} strokeWidth={2.4} /></span>
        )}
        <span className={'absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[var(--color-bg-panel)] ' + (isOnline ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]')} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className={'text-sm truncate ' + (unreadCount > 0 ? 'font-bold' : 'font-semibold') + ' text-[var(--color-text-primary)]'}>{title}</span>
          <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0 font-mono">{formatTime(thread.last_activity)}</span>
        </div>
        <p className={'text-xs truncate mb-1.5 ' + (unreadCount > 0 ? 'text-[var(--color-text-secondary)] font-medium' : 'text-[var(--color-text-muted)]')}>{preview}</p>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + status.className}>{status.label}</span>
            {isReminderDue && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-danger)]/30 bg-[var(--color-danger)] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.04em] text-[var(--color-text-on-accent)] shadow-sm" title={reminderAriaLabel}>
                <Clock3 size={12} strokeWidth={2.4} /> Cần nhắc <span className="rounded bg-white/20 px-1 py-px normal-case tracking-normal">{reminderState.label}</span>
              </span>
            )}
            {thread.archived_at && (<span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]" title="Đã lưu trữ"><Archive size={11} /> Lưu</span>)}
            {thread.status_name && (<span className="text-xs px-2 py-0.5 rounded-full font-medium truncate max-w-[100px]" style={getStatusBadgeStyle(thread.status_color)} title={thread.status_name}>{thread.status_name}</span>)}
            {(showAccountName || thread.source_id) && (<span className={'text-[11px] px-1.5 py-0.5 rounded-full truncate max-w-[145px] ' + sourceClass} title={sourceLabel}>{sourceLabel}</span>)}
          </div>
          {unreadCount > 0 && <span className="bg-[var(--color-accent)] text-[var(--color-text-on-accent)] text-xs rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center font-bold shadow-sm">{unreadCount}</span>}
        </div>
      </div>
    </button>
  );
}
