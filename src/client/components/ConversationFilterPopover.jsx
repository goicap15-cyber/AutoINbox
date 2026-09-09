import React, { useEffect, useRef, useState } from 'react';
import { Archive, BellRing, Check, ChevronDown, CircleDot, Filter, Globe, Mail, MessageCircle, RotateCcw, Tag, User, X } from 'lucide-react';
import ConversationFilterRuleBuilder from './ConversationFilterRuleBuilder.jsx';
import {
  SOURCE_TYPE_KEYS,
  cloneFilters,
  countActiveFilters,
  createDefaultFilters,
  getAvailableSourceTypeKeys,
  isManualRuleComplete,
  normalizeFilters,
  sanitizeFilters,
  toggleQuickFilter
} from '../utils/conversationFilters.js';

const WORKFLOW_OPTIONS = [
  { value: 'UNPROCESSED', label: 'Chưa xử lý', color: 'bg-sky-500' },
  { value: 'ASSIGNED', label: 'Đang xử lý', color: 'bg-amber-500' },
  { value: 'COMPLETED', label: 'Đã chốt', color: 'bg-emerald-500' }
];
const QUICK_OPTIONS = [
  { value: 'due', label: 'Cần nhắc', icon: BellRing },
  { value: 'unread', label: 'Chưa đọc', icon: Mail },
  { value: 'vip', label: 'VIP', icon: Tag },
  { value: 'needs_work', label: 'Cần xử lý', icon: CircleDot }
];

function ToggleOption({ selected, onClick, children, className = '' }) {
  return <button type="button" onClick={onClick} aria-pressed={selected} className={'flex min-h-8 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/25 ' + (selected ? 'border-[var(--color-accent)]/35 bg-[var(--color-accent-subtle)] text-[var(--color-accent)]' : 'border-transparent bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]') + ' ' + className}>
    {selected && <Check size={12} strokeWidth={2.5} className="shrink-0" />}{children}
  </button>;
}

function FilterSection({ title, icon: Icon, children }) {
  return <section className="border-t border-[var(--color-border)] pt-3 first:border-t-0 first:pt-0">
    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-secondary)]"><Icon size={12} className="text-[var(--color-accent)]" />{title}</h3>
    {children}
  </section>;
}

export default function ConversationFilterPopover({ isOpen, appliedFilters, inboxSources = [], accounts = [], leadStatuses = [], tagOptions = [], onApply, onClose, openerRef }) {
  const [draftFilters, setDraftFilters] = useState(() => normalizeFilters(appliedFilters));
  const [validationMessage, setValidationMessage] = useState('');
  const [expandedSourceGroup, setExpandedSourceGroup] = useState(null); // 'personal' | 'page' | null
  const popoverRef = useRef(null);

  useEffect(() => {
    if (isOpen) { setDraftFilters(normalizeFilters(cloneFilters(appliedFilters))); setValidationMessage(''); setExpandedSourceGroup(null); }
  }, [isOpen, appliedFilters]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose?.(); openerRef?.current?.focus(); }
    };
    const handlePointerDown = (event) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target) && openerRef?.current && !openerRef.current.contains(event.target)) onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); document.removeEventListener('pointerdown', handlePointerDown); };
  }, [isOpen, onClose, openerRef]);

  if (!isOpen) return null;

  const toggle = (field, value) => setDraftFilters((previous) => {
    const current = previous[field] || [];
    return { ...previous, [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] };
  });
  const changeSingle = (field, value) => setDraftFilters((previous) => ({ ...previous, [field]: value }));
  const invalidRuleCount = (draftFilters.rules || []).filter((rule) => !isManualRuleComplete(rule)).length;
  const handleApply = () => {
    if (invalidRuleCount) { setValidationMessage('Hoàn thiện hoặc xóa điều kiện tự nhập trước khi áp dụng.'); return; }
    onApply?.(sanitizeFilters(draftFilters, inboxSources, leadStatuses, accounts));
    onClose?.();
    openerRef?.current?.focus();
  };
  const sourceTypes = getAvailableSourceTypeKeys(inboxSources);
  const activeDraftCount = countActiveFilters(draftFilters);

  return <div ref={popoverRef} role="dialog" aria-modal="false" aria-label="Bộ lọc hội thoại" className="absolute left-0 top-11 z-50 flex max-h-[calc(100vh-5rem)] w-[28rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-panel)] shadow-2xl max-sm:fixed max-sm:inset-3 max-sm:top-3 max-sm:right-3 max-sm:w-auto max-sm:max-w-none">
    <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-3">
      <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"><Filter size={14} /></span><div><h2 className="text-xs font-bold text-[var(--color-text-primary)]">Bộ lọc hội thoại</h2><p className="text-[10px] text-[var(--color-text-muted)]">{activeDraftCount ? activeDraftCount + ' điều kiện đang chọn' : 'Chọn điều kiện để lọc'}</p></div></div>
      <button type="button" onClick={() => { onClose?.(); openerRef?.current?.focus(); }} aria-label="Đóng bộ lọc" className="rounded-full p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X size={15} /></button>
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
      <FilterSection title="Bộ lọc nhanh" icon={Filter}><div className="flex flex-wrap gap-1.5">{QUICK_OPTIONS.map(({ value, label, icon: Icon }) => <ToggleOption key={value} selected={draftFilters.quickFilters.includes(value)} onClick={() => setDraftFilters((current) => toggleQuickFilter(current, value))}><Icon size={12} />{label}</ToggleOption>)}</div></FilterSection>
      <FilterSection title="Phạm vi" icon={Archive}><div className="grid grid-cols-3 gap-1">{[{ value: 'inbox', label: 'Inbox' }, { value: 'archived', label: 'Đã lưu' }, { value: 'all', label: 'Tất cả' }].map((option) => <ToggleOption key={option.value} selected={draftFilters.archiveScope === option.value} onClick={() => changeSingle('archiveScope', option.value)} className="justify-center">{option.label}</ToggleOption>)}</div></FilterSection>
      <FilterSection title="Nguồn hội thoại" icon={Globe}>
        {(() => {
          const personalKeys = draftFilters.sourceKeys.filter((key) => key === SOURCE_TYPE_KEYS.PERSONAL || key.startsWith('account:'));
          const pageKeys = draftFilters.sourceKeys.filter((key) => key === SOURCE_TYPE_KEYS.PAGE || key.startsWith('source:'));
          const pageSources = inboxSources.filter((s) => s && s.source_type === 'page_messenger');
          const personalAccounts = accounts.filter((account) => account?.id != null);
          return <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <ToggleOption
                selected={expandedSourceGroup === 'personal'}
                onClick={() => setExpandedSourceGroup((current) => (current === 'personal' ? null : 'personal'))}
              >
                <User size={12} />Cá nhân{personalKeys.length > 0 ? ` (${personalKeys.length})` : ''}
                <ChevronDown size={12} className={'ml-auto transition-transform ' + (expandedSourceGroup === 'personal' ? 'rotate-180' : '')} />
              </ToggleOption>
              <ToggleOption
                selected={expandedSourceGroup === 'page'}
                onClick={() => setExpandedSourceGroup((current) => (current === 'page' ? null : 'page'))}
              >
                <MessageCircle size={12} />Fanpage{pageKeys.length > 0 ? ` (${pageKeys.length})` : ''}
                <ChevronDown size={12} className={'ml-auto transition-transform ' + (expandedSourceGroup === 'page' ? 'rotate-180' : '')} />
              </ToggleOption>
            </div>
            {expandedSourceGroup === 'personal' && (
              <div className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1.5">
                <ToggleOption selected={draftFilters.sourceKeys.includes(SOURCE_TYPE_KEYS.PERSONAL)} onClick={() => toggle('sourceKeys', SOURCE_TYPE_KEYS.PERSONAL)} className="w-full">
                  <User size={12} />Tất cả tài khoản cá nhân
                </ToggleOption>
                {personalAccounts.length === 0 && <p className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">Chưa có tài khoản cá nhân nào.</p>}
                {personalAccounts.map((account) => (
                  <ToggleOption key={'account:' + account.id} selected={draftFilters.sourceKeys.includes('account:' + account.id)} onClick={() => toggle('sourceKeys', 'account:' + account.id)} className="w-full">
                    <User size={11} /><span className="truncate">{account.name || account.id}</span>
                  </ToggleOption>
                ))}
              </div>
            )}
            {expandedSourceGroup === 'page' && (
              <div className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1.5">
                <ToggleOption selected={draftFilters.sourceKeys.includes(SOURCE_TYPE_KEYS.PAGE)} onClick={() => toggle('sourceKeys', SOURCE_TYPE_KEYS.PAGE)} className="w-full">
                  <MessageCircle size={12} />Tất cả Fanpage
                </ToggleOption>
                {pageSources.length === 0 && <p className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">Chưa có Fanpage nào kết nối.</p>}
                {pageSources.map((source) => (
                  <ToggleOption key={source.id} selected={draftFilters.sourceKeys.includes('source:' + source.id)} onClick={() => toggle('sourceKeys', 'source:' + source.id)} className="w-full">
                    <span className="truncate">{source.display_name || source.name || source.external_id || 'Nguồn hội thoại'}</span>
                  </ToggleOption>
                ))}
              </div>
            )}
          </div>;
        })()}
      </FilterSection>
      <FilterSection title="Trạng thái xử lý" icon={CircleDot}><div className="grid grid-cols-3 gap-1">{WORKFLOW_OPTIONS.map((option) => <ToggleOption key={option.value} selected={draftFilters.workflowStates.includes(option.value)} onClick={() => toggle('workflowStates', option.value)} className="justify-center"><span className={'h-2 w-2 rounded-full ' + option.color} />{option.label}</ToggleOption>)}</div></FilterSection>
      {leadStatuses.length > 0 && <FilterSection title="Trạng thái khách hàng" icon={CircleDot}><div className="flex flex-wrap gap-1.5">{leadStatuses.map((status) => <ToggleOption key={status.id} selected={draftFilters.statusIds.includes(String(status.id))} onClick={() => toggle('statusIds', String(status.id))}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color || 'var(--color-accent)' }} />{status.name}</ToggleOption>)}</div></FilterSection>}
      <FilterSection title="Nhãn" icon={Tag}><div className="flex flex-wrap gap-1.5">{tagOptions.length ? tagOptions.map((tag) => <ToggleOption key={tag.value} selected={draftFilters.tagNames.includes(tag.value)} onClick={() => toggle('tagNames', tag.value)}><Tag size={11} />{tag.label}</ToggleOption>) : <p className="text-[11px] text-[var(--color-text-muted)]">Chưa có nhãn trong danh sách.</p>}</div></FilterSection>
      <FilterSection title="Tin nhắn & nhắc" icon={BellRing}><div className="grid grid-cols-2 gap-1.5"><ToggleOption selected={draftFilters.unreadStates.includes('unread')} onClick={() => toggle('unreadStates', 'unread')}><Mail size={12} />Chưa đọc</ToggleOption><ToggleOption selected={draftFilters.unreadStates.includes('read')} onClick={() => toggle('unreadStates', 'read')}><Mail size={12} />Đã đọc</ToggleOption>{[{ value: 'due', label: 'Đến hạn' }, { value: 'today', label: 'Hôm nay' }, { value: 'future', label: 'Sắp tới' }, { value: 'none', label: 'Không có nhắc' }].map((option) => <ToggleOption key={option.value} selected={draftFilters.reminderStates.includes(option.value)} onClick={() => toggle('reminderStates', option.value)}>{option.label}</ToggleOption>)}</div></FilterSection>
      <FilterSection title="Thông tin & hoạt động" icon={Mail}><div className="mb-2 flex flex-wrap gap-1.5">{[{ value: 'phone', label: 'Có số điện thoại' }, { value: 'email', label: 'Có email' }, { value: 'address', label: 'Có địa chỉ' }].map((option) => <ToggleOption key={option.value} selected={draftFilters.contactFields.includes(option.value)} onClick={() => toggle('contactFields', option.value)}>{option.label}</ToggleOption>)}</div><div className="grid grid-cols-2 gap-1.5">{[{ value: 'all', label: 'Mọi lúc' }, { value: 'today', label: 'Hôm nay' }, { value: 'last7', label: '7 ngày qua' }, { value: 'last30', label: '30 ngày qua' }].map((option) => <ToggleOption key={option.value} selected={draftFilters.activityRange.type === option.value} onClick={() => changeSingle('activityRange', { type: option.value })}>{option.label}</ToggleOption>)}</div></FilterSection>
      <ConversationFilterRuleBuilder rules={draftFilters.rules} tagOptions={tagOptions} onChange={(rules) => { setValidationMessage(''); setDraftFilters((current) => ({ ...current, rules })); }} />
    </div>
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3">
      {validationMessage && <p role="alert" className="mb-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-700">{validationMessage}</p>}
      <div className="flex items-center justify-between gap-2"><button type="button" disabled={!activeDraftCount} onClick={() => { setValidationMessage(''); setDraftFilters(normalizeFilters(createDefaultFilters())); }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw size={12} />Xóa tất cả</button><div className="flex gap-1.5"><button type="button" onClick={() => { onClose?.(); openerRef?.current?.focus(); }} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Hủy</button><button type="button" onClick={handleApply} className="rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-[11px] font-bold text-[var(--color-text-on-accent)] hover:bg-[var(--color-accent-hover)]">Áp dụng</button></div></div>
    </div>
  </div>;
}
