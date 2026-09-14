import React from 'react';
import {
  Search,
  ExternalLink,
  UserCheck,
  CheckCircle2,
  PlayCircle,
  PauseCircle,
  ArrowLeft,
  Phone,
  Video,
  Info,
  Eye,
  EyeOff,
  RefreshCw
} from 'lucide-react';

const AVATAR_COLORS = ['#2684ff', '#a855f7', '#0fbd74', '#ec4899', '#ff6b2c', '#00b8a9', '#6366f1', '#ff3b4f'];

function pickAvatarColor(value) {
  const text = String(value || 'K');
  const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function HeaderIconButton({ children, onClick, href, title, className = '' }) {
  const baseClass = `w-9 h-9 inline-flex items-center justify-center rounded-full text-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] transition-colors ${className}`;
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className={baseClass} title={title} aria-label={title}>{children}</a>;
  }
  return <button type="button" onClick={onClick} className={baseClass} title={title} aria-label={title}>{children}</button>;
}

export default function ChatHeader({
  activeThread,
  accounts = [],
  inboxSources = [],
  onAssignStaff,
  onCompleteThread,
  onPauseAi,
  onResumeAi,
  onOpenSearch,
  onShowLeadPanel,
  onStartCall,
  showBackButton = false,
  onGoBack
}) {
  if (!activeThread) return null;

  const isAiPaused = activeThread.ai_paused_until && new Date(activeThread.ai_paused_until) > new Date();
  const account = accounts.find((item) => String(item.id) === String(activeThread.account_id));
  const source = inboxSources.find((item) => String(item.id) === String(activeThread.source_id));
  const accountName = account ? (account.name || account.id) : (activeThread.account_id || 'Facebook');
  const sourceType = activeThread.source_type || source?.source_type || 'personal_messenger';
  const sourceName = activeThread.source_name || source?.display_name || accountName;
  const senderAccountName = sourceType === 'page_messenger' ? sourceName : accountName;
  const senderAccountId = sourceType === 'page_messenger' ? (source?.external_id || activeThread.source_external_id || activeThread.source_id) : activeThread.account_id;
  const senderAccountSuffix = String(senderAccountId || '').slice(-4);
  const senderAvatarUrl = sourceType === 'page_messenger' ? source?.avatar_url : (account?.avatar_url || source?.avatar_url);
  const sourceLabel = sourceType === 'page_messenger' ? `Gửi bằng Page: ${senderAccountName}` : `Gửi bằng: ${senderAccountName}`;
  const sourceStatus = activeThread.source_status || source?.status || 'ACTIVE';
  const isExtConnected = sourceType === 'page_messenger' ? sourceStatus === 'ACTIVE' : (account ? account.is_extension_connected !== false : true);
  const customerName = activeThread.nickname || activeThread.contact_name || activeThread.name || 'Khách hàng';
  const avatarColor = pickAvatarColor(activeThread.id || customerName);
  const showAccountPill = accounts.length > 1;
  const messengerUrl = sourceType === 'page_messenger' ? null : (activeThread.thread_url || `https://facebook.com/messages/t/${activeThread.external_thread_id || activeThread.id}`);
  const [chromeToggling, setChromeToggling] = React.useState(false);
  const isChromeRunning = account?.is_chrome_running === true;
  const isChromeHidden = account?.chrome_display_mode === 'BACKGROUND';

  const handleToggleChromeWindow = async () => {
    if (!account || chromeToggling) return;
    setChromeToggling(true);
    try {
      const endpoint = isChromeHidden
        ? `/api/accounts/${account.id}/open`
        : `/api/accounts/${account.id}/background`;
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        const errorMsg = data?.error || (isChromeHidden ? 'Không thể hiện cửa sổ Chrome' : 'Không thể ẩn cửa sổ Chrome');
        console.error('Lỗi chuyển đổi hiển thị Chrome:', errorMsg);
        alert(errorMsg);
      }
    } catch (err) {
      console.error('Lỗi chuyển đổi hiển thị Chrome:', err);
      alert('Lỗi kết nối khi chuyển đổi hiển thị Chrome: ' + err.message);
    } finally {
      setChromeToggling(false);
    }
  };

  return (
    <div className="h-[var(--header-height)] border-b border-[var(--color-border)] px-4 flex items-center justify-between bg-[var(--color-bg-panel)] shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0">
        {showBackButton && (
          <button
            type="button"
            onClick={onGoBack}
            title="Quay lại"
            aria-label="Quay lại"
            className="w-9 h-9 inline-flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] rounded-full transition-colors shrink-0"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
        )}

        <div className="relative shrink-0">
          {activeThread.avatar_url ? (
            <img
              src={String(activeThread.avatar_url).startsWith('http') ? activeThread.avatar_url : `/api/avatars/${activeThread.avatar_url}`}
              alt=""
              className="w-11 h-11 rounded-full object-cover border border-[var(--color-border)] shadow-sm"
            />
          ) : (
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center text-[var(--color-text-on-accent)] font-semibold shadow-sm"
              style={{ backgroundColor: avatarColor }}
            >
              {customerName.charAt(0).toUpperCase()}
            </div>
          )}
          <span
            className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[var(--color-bg-panel)] ${isExtConnected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`}
            title={isExtConnected ? `Extension Live - ${accountName}` : `Extension mất kết nối - ${accountName}`}
          />
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-bold text-[var(--color-text-primary)] text-base truncate">{customerName}</h2>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className={`w-2 h-2 shrink-0 rounded-full ${isExtConnected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
            {(showAccountPill || activeThread.source_id) ? (
              <span
                className={`inline-flex min-w-0 max-w-[260px] items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-[11px] font-bold ${sourceType === 'page_messenger' ? 'border-violet-500/25 bg-violet-500/10 text-violet-500' : 'border-[var(--color-accent)]/25 bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'}`}
                title={`${sourceLabel} · ID ${sourceType === 'page_messenger' ? (source?.external_id || '') : (activeThread.account_id || '')}`}
              >
                <span className="relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-accent)] text-[9px] font-extrabold text-white">
                  {String(senderAccountName || 'F').charAt(0).toUpperCase()}
                  {senderAvatarUrl && <img src={senderAvatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
                </span>
                <span className="min-w-0 truncate">{sourceLabel}</span>
                {senderAccountSuffix && <span className="shrink-0 font-mono text-[9px] opacity-75">#{senderAccountSuffix}</span>}
              </span>
            ) : (
              <span className="text-xs text-[var(--color-text-muted)]">{isExtConnected ? 'Đang hoạt động' : 'Không hoạt động'}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 ml-3">
        <HeaderIconButton title="Gọi điện thoại Messenger" onClick={() => onStartCall?.('audio')}>
          <Phone size={19} strokeWidth={1.9} />
        </HeaderIconButton>
        <HeaderIconButton title="Gọi video Messenger" onClick={() => onStartCall?.('video')}>
          <Video size={19} strokeWidth={1.9} />
        </HeaderIconButton>
        <HeaderIconButton title="Tìm trong hội thoại" onClick={onOpenSearch} className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
          <Search size={19} strokeWidth={1.75} />
        </HeaderIconButton>
        {messengerUrl && (
          <HeaderIconButton title="Mở Messenger" href={messengerUrl} className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
            <ExternalLink size={18} strokeWidth={1.75} />
          </HeaderIconButton>
        )}
        {sourceType === 'personal_messenger' && isChromeRunning && (
          <HeaderIconButton
            title={isChromeHidden ? "Hiện cửa sổ Chrome" : "Ẩn cửa sổ Chrome"}
            onClick={handleToggleChromeWindow}
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"
          >
            {chromeToggling ? (
              <RefreshCw size={17} className="animate-spin" />
            ) : isChromeHidden ? (
              <Eye size={18} strokeWidth={1.75} />
            ) : (
              <EyeOff size={18} strokeWidth={1.75} />
            )}
          </HeaderIconButton>
        )}
        <HeaderIconButton title="Thông tin khách hàng" onClick={() => onShowLeadPanel?.()}>
          <Info size={19} strokeWidth={1.9} />
        </HeaderIconButton>

        <div className="hidden 2xl:flex items-center gap-1 ml-1 pl-2 border-l border-[var(--color-border)]">
          <HeaderIconButton title="Nhận xử lý" onClick={() => onAssignStaff?.(activeThread.id)} className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
            <UserCheck size={18} strokeWidth={1.75} />
          </HeaderIconButton>
          <HeaderIconButton title="Đánh dấu đã chốt" onClick={() => onCompleteThread?.(activeThread.id)} className="text-[var(--color-success)] hover:bg-[var(--color-success-subtle)]">
            <CheckCircle2 size={18} strokeWidth={1.75} />
          </HeaderIconButton>
          {isAiPaused ? (
            <HeaderIconButton title="Bật lại AI" onClick={() => onResumeAi?.(activeThread.id)} className="text-[var(--color-success)] hover:bg-[var(--color-success-subtle)]">
              <PlayCircle size={18} strokeWidth={1.75} />
            </HeaderIconButton>
          ) : (
            <HeaderIconButton title="Tạm dừng AI" onClick={() => onPauseAi?.(activeThread.id)} className="text-[var(--color-text-secondary)] hover:text-[var(--color-warning)] hover:bg-[var(--color-warning-subtle)]">
              <PauseCircle size={18} strokeWidth={1.75} />
            </HeaderIconButton>
          )}
        </div>
      </div>
    </div>
  );
}
