import React, { useEffect } from 'react';
import { PhoneCall, PhoneOff, Check, X } from 'lucide-react';

export default function IncomingCallModal({ callInfo, onClose, onSelectThread, onAnswerCall }) {
  useEffect(() => {
    if (!callInfo) return undefined;
    const timer = setTimeout(() => onClose?.(), 30000);
    return () => clearTimeout(timer);
  }, [callInfo, onClose]);

  if (!callInfo) return null;

  const answer = (action) => {
    if (callInfo.thread_id) onSelectThread?.(callInfo.thread_id);
    onAnswerCall?.(action, callInfo.thread_id || callInfo.external_thread_id);
    onClose?.();
  };

  return (
    <div className="fixed top-5 right-5 z-[9999]">
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-4 shadow-2xl border border-white/20 flex items-center gap-4 min-w-[340px] max-w-[440px]">
        <div className="w-12 h-12 rounded-full bg-emerald-500 flex items-center justify-center"><PhoneCall size={24} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between"><span className="text-xs font-bold text-emerald-300">📞 CUỘC GỌI ĐANG REO...</span><button onClick={onClose}><X size={16} /></button></div>
          <h4 className="font-semibold text-sm truncate mt-1.5">{callInfo.caller_name || 'Khách hàng'}</h4>
          <p className="text-xs text-white/70">Khách đang gọi đến trên Facebook Messenger</p>
          <div className="flex gap-2 mt-3.5">
            <button onClick={() => answer('accept')} className="flex-1 bg-emerald-600 text-xs font-semibold px-3 py-2 rounded-xl flex justify-center gap-1.5"><Check size={16} />Chấp nhận</button>
            <button onClick={() => answer('decline')} className="flex-1 bg-rose-600 text-xs font-semibold px-3 py-2 rounded-xl flex justify-center gap-1.5"><PhoneOff size={16} />Từ chối</button>
          </div>
        </div>
      </div>
    </div>
  );
}
