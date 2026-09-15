import React, { useState, useEffect, useRef } from 'react';
import { Search, Edit, Filter, Megaphone, RefreshCw, X }  from 'lucide-react';
import ConversationFilters from './ConversationFilters.jsx';
import ConversationItem from './ConversationItem.jsx';
import ConversationFilterPopover from './ConversationFilterPopover.jsx';
import EmptyState from './EmptyState.jsx';
import {
  createDefaultFilters,
  countActiveFilters,
  getAvailableTagOptions,
  matchesConversationFilters,
  normalizeFilters
} from '../utils/conversationFilters.js';
import { sortDueReminders } from '../utils/reminderPresentation.js';

export default function ConversationSidebar({
  threads = [], activeThreadId, onSelectThread,
  activeTab, onTabChange, searchQuery, onSearchChange, isConnected, onOpenSearch,
  sidebarSyncActive = false, sidebarSyncSecondsRemaining = 0, onToggleSidebarSync,
  waitingCount = 0,
  accounts = [],
  inboxSources = [],
  leadStatuses = [],
  campaignSelectionMode = false,
  selectedCampaignThreadIds = [],
  onToggleCampaignThread,
  onStartCampaignSelection, onCancelCampaignSelection, onCreateCampaign,
  onBulkHistorySync, onContinueFacebookSync, onCancelFacebookSync, bulkHistoryProgress
}) {
  const [appliedFilters, setAppliedFilters] = useState(() => normalizeFilters(createDefaultFilters()));
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
  const [isSyncMenuOpen, setIsSyncMenuOpen] = useState(false);
  const filterButtonRef = useRef(null);

  const activeFilterCount = countActiveFilters(appliedFilters);
  const hasFilterActive = activeFilterCount > 0;
  const filterButtonAriaLabel = hasFilterActive
    ? `Bộ lọc (${activeFilterCount} điều kiện đang bật)`
    : 'Bộ lọc';

  const visibleThreads = threads.filter((thread) => {
    if (!matchesConversationFilters(thread, appliedFilters)) return false;
    const isMessageRequest = ['MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE'].includes(String(thread.inbox_folder || 'INBOX'));
    if (activeTab === 'WAITING' && !isMessageRequest) return false;
    if (activeTab !== 'WAITING' && isMessageRequest) return false;
    if (activeTab === 'ASSIGNED' && thread.status !== 'ASSIGNED') return false;
    if (activeTab === 'UNPROCESSED' && thread.status !== 'UNPROCESSED') return false;
    if (activeTab === 'COMPLETED' && thread.status !== 'COMPLETED') return false;

    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return `${thread.contact_name || ''} ${thread.last_message || ''}`.toLowerCase().includes(query);
  });

  // Keep view membership intact, then promote due conversations with stable order.
  const filteredThreads = sortDueReminders(visibleThreads);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      if (filteredThreads.length === 0) return;

      const currentIndex = filteredThreads.findIndex((thread) => String(thread.id) === String(activeThreadId));
      const nextIndex = event.key === 'ArrowUp'
        ? (currentIndex > 0 ? currentIndex - 1 : filteredThreads.length - 1)
        : (currentIndex < filteredThreads.length - 1 ? currentIndex + 1 : 0);
      onSelectThread(filteredThreads[nextIndex].id);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredThreads, activeThreadId, onSelectThread]);

  return (
    <aside className="w-[var(--conversation-width)] min-w-[var(--conversation-width)] max-w-[var(--conversation-width)] bg-[var(--color-bg-panel)] border-r border-[var(--color-border)] flex flex-col h-full min-h-0 max-h-full overflow-visible shrink-0 select-none">
      <div className="px-4 pt-4 pb-3.5 bg-[var(--color-bg-panel)] border-b border-[var(--color-border)] shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 bg-[var(--color-accent)] rounded-full flex items-center justify-center shadow-sm shrink-0">
              <span className="text-[var(--color-text-on-accent)] text-xs font-bold">M</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-[var(--color-text-primary)] truncate">MISSPRICE CRM</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'}`} />
                <span className="text-xs text-[var(--color-text-muted)]">Facebook ({accounts.length || 0})</span>
              </div>
            </div>
          </div>

          <div className="flex gap-1.5 shrink-0 items-center">
            <div className="relative">
              <button
                type="button"
                onClick={() => { setIsSyncMenuOpen(false); onToggleSidebarSync?.(); }}
                disabled={!isConnected}
                className={`relative p-1.5 rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${sidebarSyncActive ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]' : 'hover:bg-[var(--color-bg-hover)]'}`}
                title={sidebarSyncActive
                  ? `\u0110ang \u0111\u1ed3ng b\u1ed9 H\u1ed9i tho\u1ea1i + Tin nh\u1eafn ch\u1edd (c\u00f2n ${sidebarSyncSecondsRemaining}s). B\u1ea5m \u0111\u1ec3 t\u1eaft.`
                  : 'B\u1eadt \u0111\u1ed3ng b\u1ed9 H\u1ed9i tho\u1ea1i + Tin nh\u1eafn ch\u1edd trong 1 ph\u00fat'}
                aria-label={sidebarSyncActive ? 'T\u1eaft \u0111\u1ed3ng b\u1ed9 H\u1ed9i tho\u1ea1i v\u00e0 Tin nh\u1eafn ch\u1edd' : 'B\u1eadt \u0111\u1ed3ng b\u1ed9 H\u1ed9i tho\u1ea1i v\u00e0 Tin nh\u1eafn ch\u1edd trong 1 ph\u00fat'}
                aria-pressed={sidebarSyncActive}
              >
                <RefreshCw size={17} className={sidebarSyncActive ? 'animate-spin text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'} strokeWidth={1.75} />
                {sidebarSyncActive && (
                  <span className="absolute -right-2 -bottom-2 min-w-[22px] h-4 px-1 rounded-full bg-[var(--color-accent)] text-[var(--color-text-on-accent)] text-[8px] font-bold flex items-center justify-center shadow-sm">
                    {sidebarSyncSecondsRemaining}s
                  </span>
                )}
              </button>
              {isSyncMenuOpen && (
                <div role="menu" className="absolute right-0 top-9 z-50 w-40 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-panel)] p-1.5 shadow-xl">
                  <button type="button" role="menuitem" onClick={() => { setIsSyncMenuOpen(false); onContinueFacebookSync?.(); }} className="w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Đồng bộ tiếp</button>
                  <button type="button" role="menuitem" onClick={() => { setIsSyncMenuOpen(false); onCancelFacebookSync?.(); }} className="w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--color-danger)] hover:bg-red-50">Hủy đồng bộ</button>
                </div>
              )}
            </div>
            <button onClick={onOpenSearch} className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded-full transition-colors cursor-pointer" title="Tìm kiếm nhanh" aria-label="Tìm kiếm nhanh">
              <Edit size={17} className="text-[var(--color-text-muted)]" strokeWidth={1.75} />
            </button>
            <button onClick={onStartCampaignSelection} className={'p-1.5 rounded-full transition-colors cursor-pointer ' + (campaignSelectionMode ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]' : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]')} title="Chọn người nhận campaign" aria-label="Chọn người nhận campaign">
              <Megaphone size={17} strokeWidth={1.75} />
            </button>
            <div className="relative">
              <button
                ref={filterButtonRef}
                type="button"
                onClick={() => setIsFilterPopoverOpen((prev) => !prev)}
                aria-haspopup="dialog"
                aria-expanded={isFilterPopoverOpen}
                aria-label={filterButtonAriaLabel}
                title={filterButtonAriaLabel}
                className={`relative p-1.5 rounded-full transition-colors cursor-pointer ${
                  isFilterPopoverOpen || hasFilterActive
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30'
                    : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
                }`}
              >
                <Filter size={17} strokeWidth={1.75} />
                {hasFilterActive && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-accent)] text-[var(--color-text-on-accent)] text-[10px] font-bold flex items-center justify-center shadow-xs animate-in zoom-in-75 duration-100"
                    aria-hidden="true"
                  >
                    {activeFilterCount}
                  </span>
                )}
              </button>

              <ConversationFilterPopover
                isOpen={isFilterPopoverOpen}
                appliedFilters={appliedFilters}
                inboxSources={inboxSources}
                accounts={accounts}
                leadStatuses={leadStatuses}
                tagOptions={getAvailableTagOptions(threads)}
                onApply={(nextFilters) => setAppliedFilters(nextFilters)}
                onClose={() => setIsFilterPopoverOpen(false)}
                openerRef={filterButtonRef}
              />
            </div>
          </div>
        </div>

        <div className="relative">
          <input
            type="text"
            placeholder="Tìm kiếm hội thoại..."
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            className="w-full h-9 pl-4 pr-10 bg-[var(--color-bg-surface)] rounded-full text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] border border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/20 transition-all"
          />
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" strokeWidth={1.75} />
        </div>

        <ConversationFilters activeTab={activeTab} onTabChange={onTabChange} waitingCount={waitingCount} />
        {bulkHistoryProgress && (
          <div className="flex items-center justify-between rounded-lg bg-[var(--color-bg-surface)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">
            <span>
              {bulkHistoryProgress.status === 'running'
                ? 'Đang đồng bộ tất cả tin nhắn'
                : `Đồng bộ xong${bulkHistoryProgress.failed ? `, lỗi ${bulkHistoryProgress.failed}` : ''}`}
            </span>
            <span className="font-semibold tabular-nums text-[var(--color-text-primary)]">
              {Number(bulkHistoryProgress.completed || 0) + Number(bulkHistoryProgress.failed || 0)}/{Number(bulkHistoryProgress.total || 0)}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y bg-[var(--color-bg-panel)]">
        {filteredThreads.length === 0 ? (
          <EmptyState title="Không tìm thấy hội thoại" description="Thử đổi bộ lọc hoặc từ khóa tìm kiếm." />
        ) : (
          filteredThreads.map((thread) => (
            <ConversationItem
              key={thread.thread_key || thread.id}
              thread={thread}
              accounts={accounts}
              inboxSources={inboxSources}
              isSelected={String(thread.id) === String(activeThreadId)}
              onSelect={() => onSelectThread(thread.id)}
              selectionMode={campaignSelectionMode}
              isChecked={selectedCampaignThreadIds.some((threadId) => String(threadId) === String(thread.id))}
              onToggle={() => onToggleCampaignThread(thread.id)}
            />
          ))
        )}
      </div>
      {campaignSelectionMode && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
          <button type="button" onClick={onCancelCampaignSelection} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold hover:bg-[var(--color-bg-hover)]"><X size={14} /> Hủy</button>
          <button type="button" onClick={onCreateCampaign} disabled={selectedCampaignThreadIds.length === 0} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-bold text-[var(--color-text-on-accent)] disabled:cursor-not-allowed disabled:opacity-45">
            <Megaphone size={14} /> Tạo ({selectedCampaignThreadIds.length})
          </button>
        </div>
      )}
    </aside>
  );
}
