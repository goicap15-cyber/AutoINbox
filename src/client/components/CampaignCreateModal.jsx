import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getPhoneAutomationRecommendation } from '../utils/campaignPhoneAutomation.js';
import {
  ArrowRight,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Facebook,
  HelpCircle,
  Info,
  ListOrdered,
  MessageSquare,
  Plus,
  Repeat,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Timer,
  Trash2,
  Type,
  Users,
  X
} from 'lucide-react';

function statusLabel(status) {
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
  return labels[status] || status;
}

function statusClass(status) {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-600';
  if (status === 'running' || status === 'ready') return 'bg-blue-50 text-blue-600';
  if (status === 'failed' || status === 'completed_with_errors') return 'bg-red-50 text-red-600';
  if (status === 'paused' || status === 'pausing') return 'bg-amber-50 text-amber-600';
  return 'bg-slate-100 text-slate-500';
}

function Tooltip({ text }) {
  return (
    <span className="group relative ml-[4px] inline-flex align-middle" tabIndex="0">
      <HelpCircle className="h-[14px] w-[14px] cursor-help text-slate-300 transition-colors group-hover:text-blue-400 group-focus:text-blue-400" aria-hidden="true" />
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-[6px] hidden w-[220px] -translate-x-1/2 rounded-[8px] bg-slate-800 px-[12px] py-[8px] text-[12px] font-normal leading-relaxed text-white shadow-lg group-hover:block group-focus:block">
        {text}
      </span>
    </span>
  );
}

export default function CampaignCreateModal({
  selectedThreads = [],
  onClose,
  onStartSelection,
  onCreated,
  onOpenCampaign,
  leadStatuses = []
}) {
  const [config, setConfig] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [name, setName] = useState('');
  const [messages, setMessages] = useState([
    { id: 'msg_init_1', text_content: '' }
  ]);
  const newlyAddedIdRef = useRef(null);
  const [direction, setDirection] = useState('asc');
  const [startPosition, setStartPosition] = useState(1);
  const [pacingMs, setPacingMs] = useState(5000);
  const [maxRetries, setMaxRetries] = useState(0);
  const [phoneCapturePolicy, setPhoneCapturePolicy] = useState('continue');
  const [phoneCaptureThankYouText, setPhoneCaptureThankYouText] = useState('Cảm ơn bạn, bên mình đã nhận được số điện thoại.');
  const [phoneCaptureStatusId, setPhoneCaptureStatusId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const phoneAutomationTouchedRef = useRef(false);
  const phoneAutomationRecommendedRef = useRef(false);
  const recommendation = useMemo(() => getPhoneAutomationRecommendation(leadStatuses), [leadStatuses]);
  const recommendedPhoneStatusName = recommendation.statusName;

  const handleAddMessage = () => {
    if (messages.length >= 5) return;
    const newId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    newlyAddedIdRef.current = newId;
    setMessages((prev) => [...prev, { id: newId, text_content: '' }]);
  };

  const handleUpdateMessage = (id, text) => {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, text_content: text } : m));
  };

  const handleRemoveMessage = (id) => {
    if (messages.length <= 1) return;
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  useEffect(() => {
    if (newlyAddedIdRef.current) {
      const el = document.getElementById('campaign-message-' + newlyAddedIdRef.current);
      if (el) {
        el.focus();
      }
      newlyAddedIdRef.current = null;
    }
  }, [messages]);

  const hasSelection = selectedThreads.length > 0;
  const pageThreads = useMemo(
    () => selectedThreads.filter((thread) => thread.source_type === 'page_messenger'),
    [selectedThreads]
  );
  const personalThreads = useMemo(
    () => selectedThreads.filter((thread) => thread.source_type === 'personal_messenger' || (!thread.source_type && !thread.source_id)),
    [selectedThreads]
  );
  const pageCount = useMemo(() => {
    const pageIds = pageThreads.map((thread) => thread.source_id || thread.account_id).filter(Boolean);
    return new Set(pageIds).size;
  }, [pageThreads]);
  const personalCount = personalThreads.length;
  const hasOverlengthMessage = messages.some((m) => m.text_content.length > 2000);
  const hasValidMessages = messages.length > 0 && messages.every((m) => {
    const trimmed = m.text_content.trim();
    return trimmed.length > 0 && trimmed.length <= 2000;
  });
  const canSubmit = hasSelection && !!config?.enabled && !!name.trim() && hasValidMessages
    && (phoneCapturePolicy !== 'thank_then_stop' || !!phoneCaptureThankYouText.trim()) && !submitting;
  const pacingSeconds = Number.isFinite(Number(pacingMs)) ? Number(pacingMs) / 1000 : 0;

  useEffect(() => {
    Promise.all([
      fetch('/api/campaigns/config').then((response) => response.json()),
      fetch('/api/campaigns?limit=20').then((response) => response.json())
    ]).then(([nextConfig, nextCampaigns]) => {
      setConfig(nextConfig);
      setCampaigns(Array.isArray(nextCampaigns) ? nextCampaigns : []);
    }).catch(() => setError('Không tải được cấu hình campaign.'));
  }, []);

  useEffect(() => {
    if (!hasSelection || phoneAutomationTouchedRef.current || phoneAutomationRecommendedRef.current || !recommendation.statusId) return;
    setPhoneCapturePolicy(recommendation.policy);
    setPhoneCaptureStatusId(recommendation.statusId);
    phoneAutomationRecommendedRef.current = true;
  }, [hasSelection, recommendation]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const createCampaign = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          thread_ids: selectedThreads.map((thread) => thread.id),
          messages: messages.map((m) => ({ text_content: m.text_content.trim() })),
          start_position: Number(startPosition),
          direction,
          pacing_ms: Number(pacingMs),
          max_retries: Number(maxRetries),
          send_cap: selectedThreads.length,
          phone_capture_policy: phoneCapturePolicy,
          phone_capture_thank_you_text: phoneCapturePolicy === 'thank_then_stop' ? phoneCaptureThankYouText.trim() : null,
          phone_capture_status_id: phoneCapturePolicy === 'continue' || !phoneCaptureStatusId ? null : Number(phoneCaptureStatusId)
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Không tạo được campaign.');
      onCreated(payload);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-overlay)] p-[12px] sm:p-[24px]" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[92dvh] w-full max-w-[680px] flex-col overflow-hidden rounded-[16px] border border-slate-200 bg-white font-sans text-slate-800 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="campaign-create-title">
        <header className="relative shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-[24px] py-[18px]">
          <button type="button" onClick={onClose} aria-label="Đóng" className="absolute right-[16px] top-[16px] rounded-[8px] p-[6px] text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
            <X size={20} />
          </button>
          <div className="flex items-center gap-[12px] pr-[36px]">
            <div className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] bg-white/20 shadow-inner backdrop-blur">
              <Send size={21} className="text-white" />
            </div>
            <div className="min-w-0">
              <h2 id="campaign-create-title" className="truncate text-[18px] font-bold leading-tight text-white">
                {hasSelection ? 'Tạo chiến dịch mới' : 'Chiến dịch tin nhắn'}
              </h2>
              <p className="mt-[3px] flex items-center gap-[6px] truncate text-[12px] text-blue-100">
                <Facebook size={14} />
                {hasSelection
                  ? `${selectedThreads.length} hội thoại đã chọn (${pageThreads.length} Page, ${personalCount} Messenger cá nhân)`
                  : 'Tạo snapshot, theo dõi tiến độ và lịch sử gửi'}
              </p>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-[16px] overflow-y-auto px-[24px] py-[20px]">
          {config && !config.enabled && (
            <div className="flex gap-[10px] rounded-[10px] border border-amber-200 bg-amber-50 px-[12px] py-[10px] text-amber-800">
              <ShieldAlert size={18} className="mt-[1px] shrink-0" />
              <div>
                <p className="text-[13px] font-semibold">Campaign đang ở chế độ an toàn</p>
                <p className="mt-[2px] text-[11px] leading-relaxed">Backend chưa bật CAMPAIGN_FEATURE_ENABLED=true nên không thể tạo hoặc gửi chiến dịch.</p>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-[10px] border border-red-200 bg-red-50 px-[12px] py-[9px] text-[12px] text-red-600">
              {error}
            </div>
          )}

          {!hasSelection ? (
            <div className="space-y-[20px]">
              <div className="rounded-[14px] border border-dashed border-blue-200 bg-blue-50/60 px-[24px] py-[22px] text-center">
                <div className="mx-auto flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-white text-blue-500 shadow-sm">
                  <Users size={25} />
                </div>
                <h3 className="mt-[12px] text-[14px] font-bold text-slate-700">Tạo snapshot người nhận từ inbox</h3>
                <p className="mx-auto mt-[5px] max-w-[460px] text-[12px] leading-relaxed text-slate-400">Chọn các hội thoại từ Facebook Page hoặc Messenger cá nhân. Danh sách đã chọn sẽ được lưu snapshot bất biến.</p>
                <button type="button" onClick={onStartSelection} disabled={!config?.enabled} className="mt-[14px] inline-flex h-[40px] items-center justify-center gap-[7px] rounded-[11px] bg-blue-600 px-[16px] text-[13px] font-bold text-white shadow-md shadow-blue-200 transition-all hover:bg-blue-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none">
                  Chọn người nhận <ArrowRight size={16} />
                </button>
              </div>

              <div>
                <div className="mb-[8px] flex items-center justify-between">
                  <h3 className="text-[14px] font-bold text-slate-700">Chiến dịch gần đây</h3>
                  <span className="text-[11px] text-slate-400">{campaigns.length} mục</span>
                </div>
                <div className="max-h-[260px] divide-y divide-slate-100 overflow-y-auto rounded-[12px] border border-slate-200">
                  {campaigns.length === 0 ? (
                    <p className="p-[20px] text-center text-[12px] text-slate-400">Chưa có chiến dịch.</p>
                  ) : campaigns.map((campaign) => (
                    <button key={campaign.id} type="button" onClick={() => onOpenCampaign(campaign.id)} className="flex w-full items-center gap-[10px] bg-white px-[14px] py-[10px] text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-200">
                      <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[9px] bg-slate-100 text-slate-500">
                        <Clock3 size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-slate-700">{campaign.name || 'Chưa đặt tên'}</span>
                        <span className="mt-[2px] block text-[11px] text-slate-400">{campaign.recipient_count || 0} người nhận · {campaign.sent_count || 0} đã gửi</span>
                      </span>
                      <span className={'shrink-0 rounded-full px-[9px] py-[4px] text-[10px] font-semibold ' + statusClass(campaign.status)}>{statusLabel(campaign.status)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <form id="campaign-create-form" onSubmit={createCampaign} className="space-y-[20px]">
              <div>
                <label htmlFor="campaign-name" className="mb-[7px] flex items-center gap-[8px]">
                  <span className="flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-600">1</span>
                  <span className="flex items-center text-[14px] font-bold text-slate-700">
                    <Type size={16} className="mr-[6px] text-slate-400" />
                    Đặt tên chiến dịch
                    <Tooltip text="Tên giúp bạn dễ tìm lại chiến dịch này sau này. Chỉ bạn nhìn thấy, khách hàng không thấy." />
                  </span>
                </label>
                <input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ví dụ: Chăm sóc khách hàng tháng 8" className="h-[42px] w-full rounded-[11px] border border-slate-200 bg-slate-50 px-[14px] text-[14px] text-slate-700 outline-none transition-all placeholder:text-slate-300 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100" autoFocus required />
                <p className="mt-[5px] pl-[3px] text-[11px] text-slate-400">💡 Chỉ để bạn quản lý — khách hàng sẽ không nhìn thấy tên này</p>
              </div>

              <div className="space-y-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-[8px]">
                    <span className="flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-600">2</span>
                    <span className="flex items-center text-[14px] font-bold text-slate-700">
                      <MessageSquare size={16} className="mr-[6px] text-slate-400" />
                      Viết tin nhắn gửi đi
                      <Tooltip text="Các tin nhắn sẽ được gửi lần lượt theo thứ tự bên dưới tới từng khách hàng." />
                    </span>
                  </div>
                  {messages.length < 5 ? (
                    <button
                      type="button"
                      onClick={handleAddMessage}
                      className="inline-flex items-center gap-1 rounded-[8px] border border-blue-200 bg-blue-50/70 px-[10px] py-[4px] text-[12px] font-semibold text-blue-600 transition-colors hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                    >
                      <Plus size={14} />
                      <span>Thêm tin nhắn</span>
                    </button>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                      Tối đa 5 tin
                    </span>
                  )}
                </div>

                <div className="space-y-[10px]">
                  {messages.map((item, index) => {
                    const messageId = item.id;
                    const isFirst = index === 0;
                    const placeholder = isFirst
                      ? 'Ví dụ: Chào bạn! Bên mình đang có chương trình ưu đãi tháng này, bạn có muốn tham khảo không ạ? 😊'
                      : index === 1
                        ? 'Ví dụ: Chi tiết chương trình ưu đãi gồm giảm 20% và tặng kèm voucher...'
                        : `Ví dụ: Nội dung tin nhắn tiếp theo (${index + 1})...`;

                        const isOverLength = item.text_content.length > 2000;
                    return (
                      <div
                        key={messageId}
                        className={`rounded-[12px] border ${isOverLength ? 'border-red-300 bg-red-50/30' : 'border-slate-200 bg-slate-50/70'} p-[12px] transition-all focus-within:border-blue-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100`}
                      >
                        <div className="mb-[6px] flex items-center justify-between">
                          <label
                            htmlFor={'campaign-message-' + messageId}
                            className="flex items-center gap-[6px] text-[12px] font-bold text-slate-700 cursor-pointer"
                          >
                            <span className="inline-flex h-[18px] items-center rounded bg-blue-100 px-[6px] text-[11px] font-extrabold text-blue-700">
                              Tin {index + 1}
                            </span>
                            {!isFirst && (
                              <span className="text-[11px] font-normal text-slate-400">
                                (gửi sau tin {index} với khoảng nghỉ)
                              </span>
                            )}
                          </label>
                          {messages.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveMessage(messageId)}
                              aria-label={`Xóa tin nhắn ${index + 1}`}
                              className="rounded-[6px] p-[4px] text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                        <div className="relative">
                          <textarea
                            id={'campaign-message-' + messageId}
                            value={item.text_content}
                            onChange={(event) => handleUpdateMessage(messageId, event.target.value)}
                            rows={isFirst ? 3 : 2}
                            placeholder={placeholder}
                            className={`w-full resize-y rounded-[9px] border ${isOverLength ? 'border-red-400 focus:border-red-500' : 'border-slate-200 focus:border-blue-400'} bg-white px-[12px] py-[9px] pb-[24px] text-[13px] leading-relaxed text-slate-700 outline-none transition-all placeholder:text-slate-300`}
                            required
                          />
                          <span className={`pointer-events-none absolute bottom-[6px] right-[10px] text-[11px] font-medium ${isOverLength ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                            {item.text_content.length}/2000 ký tự
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-start gap-[6px] pl-[3px] text-[11px] leading-relaxed text-slate-400">
                  <Sparkles size={14} className="mt-[1px] shrink-0 text-amber-400" />
                  <span>Mẹo: viết ngắn gọn, thân thiện và chia thành các tin ngắn để khách hàng dễ đọc và trả lời hơn</span>
                </div>
              </div>

              <section className="rounded-[12px] border border-emerald-200 bg-emerald-50/70 p-[14px]" aria-labelledby="campaign-phone-automation-title">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 id="campaign-phone-automation-title" className="text-[14px] font-bold text-emerald-900">Khi khách gửi số điện thoại</h3>
                    <p className="mt-[3px] text-[11px] leading-relaxed text-emerald-800/75">Tự động đánh dấu khách đã để số để bạn lọc lại ngay sau chiến dịch.</p>
                  </div>
                  {recommendedPhoneStatusName && <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-emerald-700 shadow-sm">Gợi ý: {recommendedPhoneStatusName}</span>}
                </div>
                <div className="mt-3 grid gap-[10px] sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="mb-[5px] block text-[11px] font-semibold text-slate-600">Hành động sau khi nhận số</span>
                    <select value={phoneCapturePolicy} onChange={(event) => { phoneAutomationTouchedRef.current = true; setPhoneCapturePolicy(event.target.value); }} className="h-[40px] w-full rounded-[9px] border border-emerald-200 bg-white px-[11px] text-[13px] font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-emerald-200">
                      <option value="continue">Chỉ lưu số, tiếp tục chiến dịch</option>
                      <option value="stop_remaining">Đánh dấu và dừng các tin chưa gửi</option>
                      <option value="thank_then_stop">Đánh dấu, cảm ơn rồi dừng</option>
                    </select>
                  </label>
                  {phoneCapturePolicy !== 'continue' && <label className="block">
                    <span className="mb-[5px] block text-[11px] font-semibold text-slate-600">Đổi trạng thái thành</span>
                    <select value={phoneCaptureStatusId} onChange={(event) => { phoneAutomationTouchedRef.current = true; setPhoneCaptureStatusId(event.target.value); }} className="h-[40px] w-full rounded-[9px] border border-emerald-200 bg-white px-[11px] text-[13px] font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-emerald-200">
                      <option value="">Chỉ lưu số, không đổi trạng thái</option>
                      {leadStatuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
                    </select>
                  </label>}
                  {phoneCapturePolicy === 'thank_then_stop' && <label className="block sm:col-span-2">
                    <span className="mb-[5px] block text-[11px] font-semibold text-slate-600">Tin nhắn cảm ơn</span>
                    <textarea value={phoneCaptureThankYouText} onChange={(event) => { phoneAutomationTouchedRef.current = true; setPhoneCaptureThankYouText(event.target.value); }} rows="3" required className="w-full resize-y rounded-[9px] border border-emerald-200 bg-white px-[11px] py-[9px] text-[13px] text-slate-700 outline-none focus:ring-2 focus:ring-emerald-200" />
                  </label>}
                </div>
                <p className="mt-3 rounded-[8px] bg-white/75 px-3 py-2 text-[11px] leading-relaxed text-slate-600">{phoneCapturePolicy === 'continue' ? 'Kết quả: CRM lưu số và nguồn tin nhắn, nhưng không đổi trạng thái hoặc dừng tin.' : phoneCaptureStatusId ? 'Kết quả: khách sẽ được đánh dấu trạng thái đã chọn ngay khi gửi số; bạn có thể lọc nhóm này trong danh sách hội thoại.' : 'Kết quả: CRM sẽ dừng theo lựa chọn, nhưng chưa đổi trạng thái vì bạn chưa chọn trạng thái đích.'}</p>
              </section>

              <div className="overflow-hidden rounded-[12px] border border-slate-200">
                <button type="button" onClick={() => setShowAdvanced((current) => !current)} aria-expanded={showAdvanced} className="flex w-full items-center justify-between gap-[12px] bg-slate-50 px-[14px] py-[11px] text-left transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-200">
                  <span className="flex min-w-0 items-center gap-[8px] text-[13px] font-semibold text-slate-600">
                    <Settings2 size={16} className="shrink-0 text-slate-400" />
                    <span>Cài đặt nâng cao <span className="font-normal text-slate-400">(không bắt buộc — đã có giá trị phù hợp)</span></span>
                  </span>
                  <ChevronDown size={16} className={'shrink-0 text-slate-400 transition-transform ' + (showAdvanced ? 'rotate-180' : '')} />
                </button>

                {showAdvanced && (
                  <div className="grid grid-cols-1 gap-[14px] bg-white px-[14px] py-[14px] sm:grid-cols-2">
                    <label>
                      <span className="mb-[5px] flex items-center text-[12px] font-semibold text-slate-600">
                        <ListOrdered size={14} className="mr-[5px] text-slate-400" />
                        Bắt đầu từ vị trí
                        <Tooltip text="Gửi từ người thứ mấy trong danh sách. Để mặc định là 1 để gửi từ người đầu tiên." />
                      </span>
                      <input type="number" min="1" max={selectedThreads.length} value={startPosition} onChange={(event) => setStartPosition(event.target.value)} className="h-[38px] w-full rounded-[9px] border border-slate-200 bg-slate-50 px-[11px] text-[13px] text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-blue-100" />
                    </label>

                    <label>
                      <span className="mb-[5px] flex items-center text-[12px] font-semibold text-slate-600">
                        <ArrowUpDown size={14} className="mr-[5px] text-slate-400" />
                        Chiều gửi
                        <Tooltip text="Tăng dần: gửi từ đầu danh sách xuống. Giảm dần: gửi từ cuối lên." />
                      </span>
                      <span className="relative block">
                        <select value={direction} onChange={(event) => setDirection(event.target.value)} className="h-[38px] w-full appearance-none rounded-[9px] border border-slate-200 bg-slate-50 px-[11px] pr-[30px] text-[13px] text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-blue-100">
                          <option value="asc">Tăng dần</option>
                          <option value="desc">Giảm dần</option>
                        </select>
                        <ChevronDown size={14} className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-slate-400" />
                      </span>
                    </label>

                    <label>
                      <span className="mb-[5px] flex items-center text-[12px] font-semibold text-slate-600">
                        <Timer size={14} className="mr-[5px] text-slate-400" />
                        Khoảng nghỉ (ms)
                        <Tooltip text="Thời gian chờ giữa hai lần gửi. Nghỉ lâu hơn sẽ an toàn hơn, tránh bị Facebook giới hạn." />
                      </span>
                      <input type="number" min={config?.minimumPacingMs || 0} step="500" value={pacingMs} onChange={(event) => setPacingMs(event.target.value)} className="h-[38px] w-full rounded-[9px] border border-slate-200 bg-slate-50 px-[11px] text-[13px] text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-blue-100" />
                      <p className="mt-[3px] text-[11px] text-slate-400">= nghỉ {pacingSeconds} giây giữa mỗi tin</p>
                    </label>

                    <label>
                      <span className="mb-[5px] flex items-center text-[12px] font-semibold text-slate-600">
                        <Repeat size={14} className="mr-[5px] text-slate-400" />
                        Số lần retry tối đa
                        <Tooltip text="Nếu gửi lỗi, hệ thống sẽ tự thử lại tối đa bấy nhiêu lần. Để 0 nếu không muốn gửi lại." />
                      </span>
                      <input type="number" min="0" max="3" value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} className="h-[38px] w-full rounded-[9px] border border-slate-200 bg-slate-50 px-[11px] text-[13px] text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-blue-100" />
                    </label>


                  </div>
                )}
              </div>

              <div className="flex items-start gap-[9px] rounded-[11px] border border-blue-100 bg-blue-50 px-[13px] py-[11px]">
                <Info size={16} className="mt-[1px] shrink-0 text-blue-500" />
                <div className="text-[12px] leading-relaxed text-blue-700">
                  <span className="font-bold">Tóm tắt:</span> Chiến dịch gồm <span className="font-bold">{messages.length} tin nhắn</span> sẽ được gửi lần lượt tới <span className="font-bold">{selectedThreads.length} hội thoại</span> ({pageThreads.length} Page, {personalCount} Messenger cá nhân), theo chiều <span className="font-bold">{direction === 'desc' ? 'giảm dần' : 'tăng dần'}</span>, nghỉ ít nhất <span className="font-bold">{pacingSeconds} giây</span> sau mỗi tin. Bạn sẽ được xem lại trước khi gửi thật.
                </div>
              </div>
            </form>
          )}
        </div>

        {hasSelection && (
          <footer className="flex shrink-0 flex-col-reverse items-stretch justify-between gap-[10px] border-t border-slate-100 bg-slate-50 px-[24px] py-[14px] sm:flex-row sm:items-center">
            <div className="flex items-center gap-[6px] text-[11px] text-slate-400">
              <CheckCircle2 size={16} className={canSubmit ? 'text-emerald-500' : 'text-slate-300'} />
              {!config?.enabled
                ? 'Campaign đang khóa ở backend'
                : hasOverlengthMessage
                  ? 'Tin nhắn không được vượt quá 2000 ký tự'
                  : canSubmit
                    ? 'Sẵn sàng tạo snapshot!'
                    : 'Điền tên và tin nhắn để tiếp tục'}
            </div>
            <div className="flex items-center justify-end gap-[8px]">
              <button type="button" onClick={onClose} className="h-[40px] rounded-[10px] px-[15px] text-[13px] font-semibold text-slate-500 transition-colors hover:bg-slate-200">Hủy</button>
              <button form="campaign-create-form" type="submit" disabled={!canSubmit} className="inline-flex h-[40px] items-center gap-[8px] rounded-[10px] bg-blue-600 px-[18px] text-[13px] font-bold text-white shadow-md shadow-blue-200 transition-all hover:bg-blue-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none">
                {submitting ? 'Đang tạo...' : 'Tạo snapshot'}
                <ArrowRight size={16} />
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
