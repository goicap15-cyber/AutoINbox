import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CirclePause,
  CirclePlay,
  Clock3,
  Copy,
  History,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  SkipForward,
  Users,
  X,
  XCircle
} from 'lucide-react';
import CampaignComposer from './CampaignComposer.jsx';
import CampaignRecipientTable from './CampaignRecipientTable.jsx';
import CampaignResponseStatsModal from './CampaignResponseStatsModal.jsx';

const labels = {
  draft: 'Nháp',
  ready: 'Sẵn sàng',
  running: 'Đang chạy',
  pausing: 'Đang tạm dừng',
  paused: 'Đã tạm dừng',
  cancelling: 'Đang hủy',
  cancelled: 'Đã hủy',
  completed: 'Hoàn tất',
  completed_with_errors: 'Hoàn tất có lỗi',
  failed: 'Thất bại'
};

function statusClass(status) {
  if (status === 'completed' || status === 'sent') return 'border-emerald-200 bg-emerald-50 text-emerald-600';
  if (status === 'running' || status === 'ready' || status === 'processing') return 'border-blue-200 bg-blue-50 text-blue-600';
  if (status === 'failed' || status === 'completed_with_errors') return 'border-red-200 bg-red-50 text-red-600';
  if (status === 'paused' || status === 'pausing' || status === 'cancelling') return 'border-amber-200 bg-amber-50 text-amber-600';
  return 'border-slate-200 bg-slate-100 text-slate-600';
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('vi-VN');
}

const phonePolicyLabels = {
  continue: 'Chỉ lưu số, tiếp tục chiến dịch',
  stop_remaining: 'Dừng các tin chưa gửi',
  thank_then_stop: 'Cảm ơn rồi dừng các tin chưa gửi'
};

const auditLabels = {
  phone_captured: 'Khách đã gửi số điện thoại',
  phone_capture_stop_applied: 'Đã dừng các tin chưa gửi',
  phone_capture_thank_queued: 'Đã xếp hàng tin cảm ơn',
  phone_capture_thank_confirmed: 'Tin cảm ơn đã gửi',
  phone_capture_thank_failed: 'Không gửi được tin cảm ơn',
  phone_capture_status_unavailable: 'Không thể đổi trạng thái'
};

function auditLabel(eventType = '') {
  return auditLabels[eventType] || eventType;
}

function auditMeta(eventType = '') {
  if (eventType === 'phone_capture_stop_applied' || eventType === 'phone_capture_thank_confirmed') return { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-600' };
  if (eventType === 'phone_capture_thank_failed' || eventType === 'phone_capture_status_unavailable') return { dot: 'bg-red-500', badge: 'bg-red-50 text-red-600' };
  if (eventType === 'phone_captured' || eventType === 'phone_capture_thank_queued') return { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-600' };
  if (eventType === 'completed') return { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-600' };
  if (eventType.includes('confirmed') || eventType.includes('sent')) return { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-600' };
  if (eventType.includes('dispatch') || eventType.includes('queue')) return { dot: 'bg-indigo-500', badge: 'bg-indigo-50 text-indigo-600' };
  if (eventType.includes('start') || eventType.includes('pause')) return { dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700' };
  if (eventType.includes('fail') || eventType.includes('cancel')) return { dot: 'bg-red-500', badge: 'bg-red-50 text-red-600' };
  if (eventType === 'created') return { dot: 'bg-purple-500', badge: 'bg-purple-50 text-purple-600' };
  return { dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-600' };
}

export default function CampaignDetail({ campaignId, refreshVersion = 0, onClose, onBackToList, leadStatuses = [], socket = null }) {
  const [campaign, setCampaign] = useState(null);
  const [config, setConfig] = useState(null);
  const [busyAction, setBusyAction] = useState('');
  const [busyRecipientId, setBusyRecipientId] = useState(null);
  const [expandedLog, setExpandedLog] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [responseStatsOpen, setResponseStatsOpen] = useState(false);

  const loadCampaign = useCallback(async () => {
    try {
      const [campaignResponse, configResponse] = await Promise.all([
        fetch('/api/campaigns/' + campaignId),
        fetch('/api/campaigns/config')
      ]);
      const nextCampaign = await campaignResponse.json();
      const nextConfig = await configResponse.json();
      if (!campaignResponse.ok) throw new Error(nextCampaign?.error?.message || 'Không tải được campaign.');
      setCampaign(nextCampaign);
      setConfig(nextConfig);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [campaignId]);

  useEffect(() => {
    loadCampaign();
  }, [loadCampaign, refreshVersion]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      if (responseStatsOpen) setResponseStatsOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, responseStatsOpen]);

  const runAction = async (action) => {
    setBusyAction(action);
    setError('');
    try {
      const response = await fetch('/api/campaigns/' + campaignId + '/' + action, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Không thể ' + action + ' campaign.');
      setCampaign(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  };

  const retryRecipient = async (recipientId) => {
    setBusyRecipientId(recipientId);
    setError('');
    try {
      const response = await fetch('/api/campaigns/' + campaignId + '/recipients/' + recipientId + '/retry', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Không retry được recipient.');
      setCampaign(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyRecipientId(null);
    }
  };

  const copyCampaignId = async () => {
    try {
      await navigator.clipboard.writeText(campaignId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const progress = useMemo(() => {
    if (!campaign) return 0;
    const total = Number(campaign.counts?.eligible || 0);
    const settled = Number(campaign.counts?.sent || 0) + Number(campaign.counts?.failed || 0) + Number(campaign.counts?.cancelled || 0);
    return total ? Math.min(100, Math.round((settled / total) * 100)) : 0;
  }, [campaign]);

  const stats = useMemo(() => {
    const counts = campaign?.counts || {};
    return [
      { label: 'Tổng', value: counts.total, icon: Users, color: 'text-slate-700', bg: 'bg-slate-100' },
      { label: 'Đủ điều kiện', value: counts.eligible, icon: CheckCircle2, color: 'text-blue-600', bg: 'bg-blue-50' },
      { label: 'Chờ', value: counts.pending, icon: Clock3, color: 'text-amber-600', bg: 'bg-amber-50' },
      { label: 'Đang gửi', value: counts.processing, icon: Send, color: 'text-indigo-600', bg: 'bg-indigo-50' },
      { label: 'Đã gửi', value: counts.sent, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
      { label: 'Lỗi', value: counts.failed, icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
      { label: 'Bỏ qua / hủy', value: Number(counts.skipped || 0) + Number(counts.cancelled || 0), icon: SkipForward, color: 'text-slate-500', bg: 'bg-slate-100' }
    ];
  }, [campaign]);

  const auditEvents = useMemo(() => (campaign?.audit || []).slice().reverse(), [campaign]);
  const sentCount = Number(campaign?.counts?.sent || 0);
  const eligibleCount = Number(campaign?.counts?.eligible || 0);
  const phoneTargetStatus = useMemo(() => leadStatuses.find((status) => String(status.id) === String(campaign?.phone_capture_status_id)) || null, [campaign?.phone_capture_status_id, leadStatuses]);

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] bg-slate-50 font-sans text-slate-800" role="dialog" aria-modal="true" aria-labelledby="campaign-detail-title">
      <div className="flex h-full flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 shadow-sm sm:px-5">
          <button type="button" onClick={onBackToList} aria-label="Về danh sách chiến dịch" title="Về danh sách" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
            <ChevronLeft size={19} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm sm:flex">
              <Send className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="campaign-detail-title" className="truncate text-base font-bold text-slate-800 sm:text-lg">{campaign?.name || 'Đang tải campaign...'}</h2>
                {campaign && (
                  <span className={'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ' + statusClass(campaign.status)}>
                    {campaign.status === 'completed' && <CheckCircle2 size={12} />}
                    {labels[campaign.status] || campaign.status}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
                <p className="truncate text-[11px] text-slate-400 sm:text-xs">{campaignId}</p>
                <button type="button" onClick={copyCampaignId} aria-label="Sao chép mã campaign" title={copied ? 'Đã sao chép' : 'Sao chép mã'} className="shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
                  {copied ? <CheckCircle2 size={12} className="text-emerald-500" /> : <Copy size={12} />}
                </button>
                {campaign?.source_counts && (
                  <span className="hidden items-center gap-1 text-[11px] text-slate-400 sm:inline-flex">
                    · <span className="font-medium text-blue-600">{campaign.source_counts.page_messenger || 0} Page</span>
                    · <span className="font-medium text-indigo-600">{campaign.source_counts.personal_messenger || 0} Cá nhân</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <button type="button" onClick={() => setResponseStatsOpen(true)} aria-label="Thống kê phản hồi" title="Thống kê phản hồi" className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
            <BarChart3 size={18} />
            <span>Thống kê</span>
          </button>
          <button type="button" onClick={loadCampaign} aria-label="Làm mới" title="Làm mới" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
            <RefreshCw size={17} />
          </button>
          <button type="button" onClick={onClose} aria-label="Đóng" title="Đóng" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
            <X size={19} />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full space-y-4 p-3 sm:p-5">
            {!campaign && !error && <div className="flex min-h-64 items-center justify-center text-slate-400"><LoaderCircle size={25} className="animate-spin" /></div>}
            {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

            {campaign && (
              <>
                {!config?.enabled && (
                  <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <ShieldAlert size={18} className="shrink-0" />
                    <span>Feature flag đang tắt. Có thể xem dữ liệu nhưng mọi hành động tạo/gửi đều bị backend chặn.</span>
                  </div>
                )}

                <section aria-label="Tổng quan chiến dịch">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {stats.map((stat) => {
                      const Icon = stat.icon;
                      return (
                        <div key={stat.label} className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                          <div className={'mb-2 flex h-7 w-7 items-center justify-center rounded-lg ' + stat.bg}><Icon className={'h-4 w-4 ' + stat.color} /></div>
                          <p className={'text-xl font-bold leading-none ' + stat.color}>{Number(stat.value || 0).toLocaleString('vi-VN')}</p>
                          <p className="mt-1.5 truncate text-[11px] text-slate-400">{stat.label}</p>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-600">Tiến độ gửi</span>
                      <span className="text-sm font-bold text-emerald-600">{progress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Tiến độ gửi" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
                      <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-[width] duration-700" style={{ width: progress + '%' }} />
                    </div>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="flex items-center gap-1.5 text-xs text-slate-400">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        {campaign.status === 'completed' ? `Chiến dịch đã hoàn tất — ${sentCount}/${eligibleCount} tin nhắn gửi thành công` : `${sentCount}/${eligibleCount} người nhận đã gửi thành công`}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {campaign.status === 'ready' && <button type="button" onClick={() => runAction('start')} disabled={!config?.enabled || !!busyAction} className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"><Send size={14} /> {busyAction === 'start' ? 'Đang bắt đầu' : 'Bắt đầu gửi'}</button>}
                        {campaign.status === 'running' && <button type="button" onClick={() => runAction('pause')} disabled={!!busyAction} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-45"><CirclePause size={14} /> Tạm dừng</button>}
                        {campaign.status === 'paused' && <button type="button" onClick={() => runAction('resume')} disabled={!config?.enabled || !!busyAction} className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-45"><CirclePlay size={14} /> Tiếp tục</button>}
                        {['running', 'pausing', 'paused'].includes(campaign.status) && <button type="button" onClick={() => runAction('cancel')} disabled={!!busyAction} className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-45"><Ban size={14} /> Hủy chiến dịch</button>}
                        {campaign.status === 'completed' && <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 text-xs font-bold text-emerald-600"><CheckCircle2 size={14} /> Đã hoàn tất</span>}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 shadow-sm" aria-label="Tự động hóa khi khách gửi số">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="text-sm font-bold text-emerald-900">Khi khách gửi số điện thoại</p><p className="mt-1 text-xs text-emerald-800/75">{phonePolicyLabels[campaign.phone_capture_policy] || phonePolicyLabels.continue}</p></div>
                    {phoneTargetStatus ? <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-700 shadow-sm">→ {phoneTargetStatus.name}</span> : <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500">Không đổi trạng thái</span>}
                  </div>
                </section>

                <CampaignComposer campaign={campaign} config={config} onChanged={setCampaign} leadStatuses={leadStatuses} />
                <CampaignRecipientTable campaign={campaign} onRetry={retryRecipient} busyRecipientId={busyRecipientId} />

                <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm" aria-labelledby="campaign-audit-title">
                  <h3 id="campaign-audit-title" className="flex items-center gap-2 text-sm font-bold text-slate-700"><History className="h-4 w-4 text-purple-500" /> Audit timeline</h3>
                  {auditEvents.length > 0 ? (
                    <div className="relative mt-4 pl-5">
                      <div className="absolute bottom-1 left-1.5 top-1 w-px bg-slate-200" />
                      <div className="space-y-1">
                        {auditEvents.map((event, index) => {
                          const meta = auditMeta(event.event_type);
                          const isExpanded = expandedLog === index;
                          return (
                            <div key={event.id || index} className="relative">
                              <span className={'absolute -left-5 top-2.5 h-3 w-3 rounded-full ring-4 ring-white ' + meta.dot} />
                              <button type="button" onClick={() => setExpandedLog(isExpanded ? -1 : index)} aria-expanded={isExpanded} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200">
                                <span className="flex min-w-0 items-center gap-2"><span className={'truncate rounded-md px-2 py-0.5 text-xs font-bold ' + meta.badge} title={event.event_type}>{auditLabel(event.event_type)}</span><span className="hidden text-xs text-slate-400 sm:inline">bởi {event.actor_type || 'system'}</span></span>
                                <span className="flex shrink-0 items-center gap-2"><time className="hidden font-mono text-[11px] text-slate-400 sm:inline">{formatDate(event.created_at)}</time><ChevronDown className={'h-3.5 w-3.5 text-slate-300 transition-transform ' + (isExpanded ? 'rotate-180' : '')} /></span>
                              </button>
                              {isExpanded && (
                                <div className="mx-3 mb-2 overflow-x-auto rounded-lg bg-slate-900 p-3 shadow-inner">
                                  <div className="mb-1 flex items-center justify-between gap-3 sm:hidden"><span className="text-[11px] text-slate-400">{event.actor_type || 'system'}</span><time className="font-mono text-[10px] text-slate-500">{formatDate(event.created_at)}</time></div>
                                  <code className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-emerald-300">{JSON.stringify(event.payload || {}, null, 2)}</code>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : <p className="py-7 text-center text-xs text-slate-400">Chưa có audit event.</p>}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
      {responseStatsOpen && (
        <CampaignResponseStatsModal
          campaignId={campaignId}
          campaignName={campaign?.name}
          socket={socket}
          onClose={() => setResponseStatsOpen(false)}
        />
      )}
    </div>
  );
}
