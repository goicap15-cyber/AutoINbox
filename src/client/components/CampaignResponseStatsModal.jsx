import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, MessageCircleReply, Phone, RefreshCw, UserRoundX, Users, X } from 'lucide-react';

const filters = [
  { id: 'replied', label: 'Đã trả lời' },
  { id: 'phone', label: 'Có số điện thoại' },
  { id: 'unanswered', label: 'Chưa trả lời' }
];

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('vi-VN');
}

export default function CampaignResponseStatsModal({ campaignId, campaignName, onClose, socket = null }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('replied');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const realtimeRefreshTimerRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/response-stats?_=${Date.now()}`, {
        cache: 'no-store'
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Không tải được thống kê phản hồi.');
      setData(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [campaignId]);

  // Socket delivery can be missed during extension reconnects and the first
  // reply may be persisted before this modal subscribes. Poll lightly while
  // the modal is visible so one customer message is sufficient to update
  // statistics; no second message or manual refresh is required.
  useEffect(() => {
    const interval = setInterval(() => load(), 1000);
    return () => clearInterval(interval);
  }, [campaignId]);

  // Keep response statistics live while this modal remains open. Incoming
  // messages are persisted before NEW_MESSAGE is emitted, so the refreshed
  // API result is already authoritative. Debounce the related events because
  // one reply containing a phone number also emits PHONE_CAPTURED.
  useEffect(() => {
    if (!socket) return undefined;
    const scheduleRefresh = () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = setTimeout(() => load(), 180);
    };
    const handleNewMessage = (message = {}) => {
      if (message.is_outgoing === true || message.is_outgoing === 1) return;
      scheduleRefresh();
    };
    const handleCampaignResponse = (event = {}) => {
      if (event.campaign_id && String(event.campaign_id) !== String(campaignId)) return;
      scheduleRefresh();
    };
    socket.on('NEW_MESSAGE', handleNewMessage);
    socket.on('PHONE_CAPTURED', scheduleRefresh);
    socket.on('CAMPAIGN_RESPONSE_UPDATED', handleCampaignResponse);
    return () => {
      socket.off('NEW_MESSAGE', handleNewMessage);
      socket.off('PHONE_CAPTURED', scheduleRefresh);
      socket.off('CAMPAIGN_RESPONSE_UPDATED', handleCampaignResponse);
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
    };
  }, [socket, campaignId]);

  const rows = useMemo(() => (data?.recipients || []).filter((recipient) => {
    if (filter === 'phone') return recipient.has_phone;
    if (filter === 'unanswered') return !recipient.replied;
    return recipient.replied;
  }), [data, filter]);

  const cards = [
    { label: 'Đã gửi', value: data?.counts?.sent, icon: Users, className: 'bg-blue-50 text-blue-600' },
    { label: 'Đã trả lời', value: data?.counts?.replied, icon: MessageCircleReply, className: 'bg-emerald-50 text-emerald-600' },
    { label: 'Đã đưa SĐT', value: data?.counts?.with_phone, icon: Phone, className: 'bg-purple-50 text-purple-600' },
    { label: 'Chưa trả lời', value: data?.counts?.unanswered, icon: UserRoundX, className: 'bg-amber-50 text-amber-600' }
  ];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="campaign-response-stats-title">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><MessageCircleReply size={20} /></div>
          <div className="min-w-0 flex-1">
            <h3 id="campaign-response-stats-title" className="font-bold text-slate-800">Thống kê phản hồi chiến dịch</h3>
            <p className="truncate text-xs text-slate-400">{campaignName || campaignId}</p>
          </div>
          <button type="button" onClick={load} title="Làm mới" aria-label="Làm mới thống kê" className="rounded-lg p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-600"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
          <button type="button" onClick={onClose} title="Đóng" aria-label="Đóng thống kê" className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"><X size={19} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && !data ? <div className="flex min-h-56 items-center justify-center text-slate-400"><LoaderCircle className="animate-spin" size={26} /></div> : null}
          {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div> : null}
          {data ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {cards.map(({ label, value, icon: Icon, className }) => (
                  <div key={label} className="rounded-xl border border-slate-200 p-4 shadow-sm">
                    <div className={`mb-3 flex h-8 w-8 items-center justify-center rounded-lg ${className}`}><Icon size={17} /></div>
                    <p className="text-2xl font-bold text-slate-800">{Number(value || 0).toLocaleString('vi-VN')}</p>
                    <p className="mt-1 text-xs text-slate-400">{label}</p>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-emerald-50 px-4 py-3"><p className="text-xs text-emerald-700">Tỷ lệ phản hồi</p><p className="mt-1 text-xl font-bold text-emerald-700">{data.rates.reply_rate}%</p></div>
                <div className="rounded-xl bg-purple-50 px-4 py-3"><p className="text-xs text-purple-700">Tỷ lệ thu SĐT</p><p className="mt-1 text-xl font-bold text-purple-700">{data.rates.phone_rate}%</p></div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
                {filters.map((item) => (
                  <button key={item.id} type="button" onClick={() => setFilter(item.id)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${filter === item.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{item.label}</button>
                ))}
              </div>

              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3">Khách hàng</th><th className="px-4 py-3">Phản hồi đầu tiên</th><th className="px-4 py-3">Số điện thoại</th><th className="px-4 py-3">Thời gian</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((recipient) => (
                      <tr key={recipient.recipient_id} className="hover:bg-slate-50">
                        <td className="px-4 py-3"><p className="font-semibold text-slate-700">{recipient.contact_name}</p><p className="mt-0.5 text-[10px] text-slate-400">{recipient.thread_id}</p></td>
                        <td className="max-w-72 px-4 py-3 text-slate-600">{recipient.replied ? <span className="flex items-start gap-1.5"><CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" /><span className="line-clamp-2">{recipient.reply_preview || 'Đã phản hồi'}</span></span> : <span className="text-slate-300">Chưa phản hồi</span>}</td>
                        <td className="px-4 py-3 font-semibold text-purple-600">{recipient.phone || '—'}</td>
                        <td className="px-4 py-3 text-slate-400">{formatDate(recipient.phone_captured_at || recipient.replied_at)}</td>
                      </tr>
                    ))}
                    {!rows.length ? <tr><td colSpan="4" className="px-4 py-10 text-center text-slate-400">Không có khách hàng trong nhóm này.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
