import React from 'react';

export default function ConversationFilters({ activeTab, onTabChange, waitingCount = 0 }) {
  const tabs = [
    { id: 'ALL', label: 'Hội thoại' },
    { id: 'WAITING', label: 'Tin nhắn chờ', count: Math.max(0, Number(waitingCount) || 0) }
  ];

  return (
    <div className="flex gap-1.5 bg-[var(--color-bg-panel)] pt-1 pb-1">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 h-8.5 text-xs font-medium rounded-lg transition-colors px-2 inline-flex items-center justify-center gap-1.5 min-w-0 ${
              isActive
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] font-semibold'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <span className="truncate">{tab.label}</span>
            {tab.count > 0 && (
              <span
                className="inline-flex min-w-5 h-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold leading-none text-white tabular-nums"
                aria-label={`${tab.count} người trong tin nhắn chờ`}
              >
                {tab.count > 999 ? '999+' : tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
