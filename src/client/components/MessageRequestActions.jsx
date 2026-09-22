import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, ShieldBan, Trash2, X } from 'lucide-react';
import ConfirmModal from './ConfirmModal';

const ACTION_META = {
  continue: { label: 'Tiếp tục', icon: Check, className: 'bg-[var(--color-accent)] text-white hover:brightness-95' },
  accept: { label: 'Chấp nhận', icon: Check, className: 'bg-[var(--color-accent)] text-white hover:brightness-95' },
  decline: { label: 'Từ chối', icon: X, className: 'bg-[var(--color-bg-surface)] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10' },
  delete: { label: 'Xóa', icon: Trash2, className: 'bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]' },
  block: { label: 'Chặn', icon: ShieldBan, className: 'bg-[var(--color-bg-surface)] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10' },
};

const makeRequestId = () => globalThis.crypto?.randomUUID?.() || `request_${Date.now()}_${Math.random()}`;

export default function MessageRequestActions({ thread, socket, isConnected }) {
  const [availableActions, setAvailableActions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [error, setError] = useState('');
  const [contactUnavailable, setContactUnavailable] = useState(false);
  const requestIdRef = useRef(null);

  const sendCommand = useCallback((action) => {
    if (!socket || !isConnected || !thread?.id) {
      setError('Extension Facebook chưa được kết nối.');
      setIsLoading(false);
      return;
    }
    const requestId = makeRequestId();
    requestIdRef.current = requestId;
    setError('');
    if (action === 'query') setIsLoading(true);
    else setPendingAction(action);
    socket.emit('MESSAGE_REQUEST_ACTION', {
      request_id: requestId,
      thread_id: thread.id,
      action
    });
  }, [socket, isConnected, thread?.id]);

  useEffect(() => {
    if (!socket) return undefined;
    const onResult = (result = {}) => {
      if (String(result.request_id || '') !== String(requestIdRef.current || '')) return;
      setIsLoading(false);
      setPendingAction(null);
      if (!result.success) {
        setError(result.error || 'Không điều khiển được Tin nhắn đang chờ.');
        return;
      }
      setError('');
      setContactUnavailable(Boolean(result.contact_unavailable));
      if (Array.isArray(result.available_actions)) {
        setAvailableActions(result.available_actions);
      }
    };
    socket.on('MESSAGE_REQUEST_ACTION_RESULT', onResult);
    return () => socket.off('MESSAGE_REQUEST_ACTION_RESULT', onResult);
  }, [socket]);

  useEffect(() => {
    setAvailableActions([]);
    setContactUnavailable(false);
    setError('');
    sendCommand('query');
  }, [thread?.id, sendCommand]);

  const handleAction = (action) => {
    const contactName = thread?.contact_name || thread?.name || 'khách này';
    if (action === 'delete') {
      setConfirmDialog({
        action,
        title: 'Xóa tin nhắn đang chờ',
        message: `Bạn có chắc muốn xóa tin nhắn đang chờ của "${contactName}" trên Messenger không?`,
        confirmText: 'Xóa tin nhắn',
        variant: 'danger',
      });
      return;
    }
    if (action === 'decline') {
      setConfirmDialog({
        action,
        title: 'Từ chối tin nhắn',
        message: `Bạn có chắc muốn từ chối tin nhắn của "${contactName}" trên Messenger không?`,
        confirmText: 'Từ chối',
        variant: 'warning',
      });
      return;
    }
    if (action === 'block') {
      setConfirmDialog({
        action,
        title: 'Chặn người dùng',
        message: `Bạn có chắc muốn chặn "${contactName}" trên Messenger không? Người này sẽ không thể gửi tin nhắn cho bạn nữa.`,
        confirmText: 'Chặn',
        variant: 'danger',
      });
      return;
    }
    sendCommand(action);
  };

  const handleConfirmModalAction = () => {
    if (!confirmDialog) return;
    const action = confirmDialog.action;
    setConfirmDialog(null);
    sendCommand(action);
  };

  // Facebook can report that a request is no longer reachable even if a
  // previous response contained controls. Never leave stale controls visible
  // for that terminal state.
  const actionsToRender = contactUnavailable
    ? []
    : [...new Set(availableActions)].filter((action) => ACTION_META[action]);

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] px-4 py-3">
      {isLoading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-2 text-[var(--color-text-muted)]">
          <LoaderCircle size={20} className="animate-spin text-[var(--color-accent)]" />
          <span className="text-xs">Đang đồng bộ nút từ Facebook...</span>
        </div>
      ) : (
        <>
          <div className="mb-2 text-center text-xs text-[var(--color-text-muted)]">
            {contactUnavailable
              ? 'Hiện không liên lạc được với người này trên Messenger.'
              : actionsToRender.length > 0
                ? 'Chọn thao tác cho tin nhắn đang chờ. CRM sẽ bấm nút thật trên Messenger.'
                : 'Messenger hiện không có nút thao tác cho tin nhắn này.'}
          </div>
          {error && (
        <div className="mb-2 flex flex-col items-center justify-center gap-2 text-xs text-[var(--color-danger)]">
          <div className="flex items-center justify-center gap-2">
            <span>{error}</span>
            <button type="button" onClick={() => sendCommand('query')} className="inline-flex items-center gap-1 font-semibold underline">
              <RefreshCw size={12} /> Thử lại
            </button>
          </div>
        </div>
      )}
      {!error && !isLoading && availableActions.length === 0 && (
        <div className="mt-1 text-center text-[11px] text-[var(--color-text-muted)]">Hãy xử lý yêu cầu trực tiếp trên Messenger nếu Facebook không cung cấp nút.</div>
      )}
      {actionsToRender.length > 0 && (
        <div
          className={`grid gap-2 ${actionsToRender.length === 1 ? 'max-w-sm mx-auto' : ''}`}
          style={{ gridTemplateColumns: `repeat(${Math.min(actionsToRender.length, 3)}, minmax(0, 1fr))` }}
        >
          {actionsToRender.map((action) => {
            const meta = ACTION_META[action];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <button
                key={action}
                type="button"
                disabled={Boolean(pendingAction)}
                onClick={() => handleAction(action)}
                className={`h-11 rounded-lg inline-flex items-center justify-center gap-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${meta.className}`}
              >
                {pendingAction === action ? <LoaderCircle size={17} className="animate-spin" /> : <Icon size={17} />}
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
        </>
      )}

      <ConfirmModal
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText || 'Xác nhận'}
        variant={confirmDialog?.variant || 'danger'}
        onConfirm={handleConfirmModalAction}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
