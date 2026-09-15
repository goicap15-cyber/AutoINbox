import React, { useState, useRef, useEffect } from 'react';
import { Send, AlertTriangle, UserCheck, Bot, CheckCircle2, PauseCircle, PlayCircle } from 'lucide-react';
import MediaViewer from './MediaViewer.jsx';

export default function ChatArea({
  activeThread,
  messages,
  onSendMessage,
  onAssignStaff,
  onCompleteThread,
  onPauseAi,
  onResumeAi
}) {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      chatContainerRef.current?.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }, 50);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText);
    setInputText('');
  };

  if (!activeThread) {
    return (
      <div className="flex-1 bg-[#0B0D12] flex flex-col items-center justify-center">
        <div className="relative mb-4">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500/20 to-blue-600/20 flex items-center justify-center border border-white/[0.05]">
            <Bot size={36} className="text-indigo-400/60" strokeWidth={1.5} />
          </div>
          <div className="absolute -inset-3 rounded-full bg-indigo-500/[0.05] animate-ping" style={{ animationDuration: '3s' }} />
        </div>
        <p className="text-sm text-[#626C7C] font-medium">Chọn hội thoại để bắt đầu</p>
        <p className="text-xs text-[#4A5060] mt-1">Tin nhắn từ Facebook Messenger sẽ hiển thị tại đây</p>
      </div>
    );
  }

  const isAiPaused = activeThread.ai_paused_until && new Date(activeThread.ai_paused_until) > new Date();

  // Group messages by date
  const groupedMessages = [];
  let currentDate = '';
  
  messages.forEach((msg) => {
    const displayTime = msg.timestamp_ms || msg.created_at;
    const msgDate = displayTime ? new Date(displayTime).toLocaleDateString('vi-VN') : 'Hôm nay';
    
    if (msgDate !== currentDate) {
      currentDate = msgDate;
      groupedMessages.push({ type: 'date', date: msgDate });
    }
    groupedMessages.push({ type: 'message', msg });
  });

  return (
    <div className="flex-1 bg-[#0B0D12] flex flex-col h-full overflow-hidden relative">
      {/* Header */}
      <div className="h-14 border-b border-white/[0.06] px-5 flex items-center justify-between bg-[#12151D]/80 backdrop-blur-md select-none shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <span className="text-sm font-bold text-white">
              {(activeThread.contact_name || 'K').charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[#F2F4F8]">{activeThread.contact_name || 'Khách hàng FB'}</h3>
              <span
                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                  isAiPaused
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                }`}
              >
                <Bot size={10} />
                {isAiPaused ? 'AI Tạm dừng' : 'AI Active'}
              </span>
            </div>
            <span className="text-[10px] text-[#626C7C] font-mono">ID: {activeThread.id}</span>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-1">
          {isAiPaused ? (
            <button
              onClick={() => onResumeAi?.(activeThread.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-400 text-xs font-semibold rounded-lg border border-emerald-500/20 transition-all"
            >
              <PlayCircle size={13} />
              <span>Bật AI</span>
            </button>
          ) : (
            <button
              onClick={() => onPauseAi?.(activeThread.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-white/[0.03] hover:bg-white/[0.06] text-amber-400 text-xs font-semibold rounded-lg border border-white/[0.06] transition-all"
            >
              <PauseCircle size={13} />
              <span>Dừng AI</span>
            </button>
          )}

          <button
            onClick={() => onAssignStaff(activeThread.id)}
            className="p-1.5 text-[#9AA3B2] hover:bg-white/[0.05] hover:text-[#F2F4F8] rounded-lg transition-all"
          >
            <UserCheck size={15} strokeWidth={2} />
          </button>

          <button
            onClick={() => onCompleteThread(activeThread.id)}
            className="p-1.5 text-[#9AA3B2] hover:bg-emerald-500/10 hover:text-emerald-400 rounded-lg transition-all"
          >
            <CheckCircle2 size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Messages Area */}
      <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        {/* Background subtle pattern */}
        <div className="absolute inset-0 opacity-[0.015] pointer-events-none"
             style={{
               backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
             }}
        />
        
        <div className="relative space-y-4">
          {groupedMessages.map((item, idx) => {
            if (item.type === 'date') {
              return (
                <div key={`date-${idx}`} className="flex items-center gap-3 my-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
                  <span className="text-[10px] text-[#626C7C] font-semibold uppercase tracking-wider">
                    {item.date === new Date().toLocaleDateString('vi-VN') ? 'Hôm nay' : item.date}
                  </span>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
                </div>
              );
            }

            const { msg } = item;
            const isPendingDirection = msg.direction_status === 'pending';
            const isOutgoing = !isPendingDirection && (msg.is_outgoing === true || msg.is_outgoing === 1 || String(msg.is_outgoing || '').toLowerCase() === 'true' || String(msg.is_outgoing || '') === '1');
            const alignmentClass = isPendingDirection ? 'items-center' : (isOutgoing ? 'items-end' : 'items-start');
            const isUnsent = msg.is_unsent;

            return (
              <div
                key={msg.id || `${msg.fb_message_id}-${idx}`}
                className={`flex flex-col gap-1 ${alignmentClass}`}
              >
                {/* Sender info */}
                {!isOutgoing && !isPendingDirection && (msg.sender_name || msg.sender_avatar) && (
                  <div className="flex items-center gap-2 ml-1">
                    {msg.sender_avatar ? (
                      <img src={msg.sender_avatar} alt="" className="w-5 h-5 rounded-full object-cover ring-1 ring-white/[0.05]" />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500/80 to-indigo-600/80 flex items-center justify-center">
                        <span className="text-[9px] font-bold text-white">{(msg.sender_name || 'K').charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    {msg.sender_name && <span className="text-[10px] font-medium text-[#9AA3B2]">{msg.sender_name}</span>}
                  </div>
                )}

                <div className={`flex items-end gap-2 ${isPendingDirection ? 'justify-center' : (isOutgoing ? 'flex-row-reverse' : '')}`}>
                  {/* Bubble */}
                  <div
                    className={`relative max-w-[75%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed shadow-sm ${
                      isUnsent
                        ? 'bg-red-500/10 border border-red-500/20 text-red-400 rounded-bl-none'
                        : isPendingDirection
                        ? 'bg-slate-700/60 border border-dashed border-amber-400/30 text-slate-200'
                        : isOutgoing
                        ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-bl-none shadow-blue-500/20'
                        : 'bg-gradient-to-br from-slate-800/90 to-slate-900/90 text-[#F2F4F8] border border-white/[0.06] rounded-br-none shadow-black/20'
                    }`}
                  >
                    {isUnsent && (
                      <div className="flex items-center gap-1.5 text-[10px] text-red-400/80 font-medium mb-1.5 pb-1.5 border-b border-red-500/20">
                        <AlertTriangle size={11} strokeWidth={2} />
                        <span>Khách hàng đã thu hồi</span>
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    <MediaViewer mediaType={msg.media_type} mediaUrl={msg.media_url} localMediaPath={msg.local_media_path} />
                  </div>

                  {/* Status */}
                  {isOutgoing && !isPendingDirection && !isUnsent && (
                    <span className="pb-0.5">
                      <CheckCircle2 size={12} className="text-blue-300/50" strokeWidth={2} />
                    </span>
                  )}
                </div>

                {/* Timestamp */}
                <div className="flex items-center gap-1.5 ml-1">
                  {msg.created_at && (
                    <span className="text-[9px] text-[#626C7C] font-medium tabular-nums">
                      {new Date(msg.timestamp_ms || msg.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {msg.source === 'dom_observer' && (
                    <span className="text-[8px] px-1 py-0 rounded bg-yellow-500/10 text-yellow-500/60 font-medium">DOM</span>
                  )}
                  {msg.source === 'websocket' && (
                    <span className="text-[8px] px-1 py-0 rounded bg-green-500/10 text-green-500/60 font-medium">WS</span>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer */}
      <form onSubmit={handleSend} className="p-3 border-t border-white/[0.06] bg-[#12151D]/80 backdrop-blur-sm flex items-center gap-2.5 shrink-0">
        <input
          type="text"
          placeholder="Nhập tin nhắn..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="flex-1 bg-[#0B0D12] text-[#F2F4F8] text-sm px-4 py-2.5 rounded-xl border border-white/[0.06] focus:outline-none focus:border-indigo-500/40 focus:ring-1 focus:ring-indigo-500/20 transition-all placeholder:text-[#626C7C]"
        />
        <button
          type="submit"
          disabled={!inputText.trim()}
          className="p-2.5 bg-gradient-to-br from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 disabled:opacity-30 disabled:hover:from-blue-500 disabled:hover:to-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-500/20 transition-all duration-150 active:scale-95"
        >
          <Send size={16} strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}
