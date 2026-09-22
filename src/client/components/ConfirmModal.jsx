import React, { useEffect } from 'react';
import { AlertTriangle, AlertCircle, Info, Trash2, X, Loader2 } from 'lucide-react';

export default function ConfirmModal({
  isOpen,
  title = 'Xác nhận hành động',
  message,
  confirmText = 'Xác nhận',
  cancelText = 'Hủy bỏ',
  variant = 'danger', // 'danger' | 'warning' | 'info'
  isLoading = false,
  onConfirm,
  onClose,
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isLoading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;

  const getVariantStyles = () => {
    switch (variant) {
      case 'danger':
        return {
          iconBadge: 'bg-red-500/10 border-red-500/20 text-red-400',
          icon: <Trash2 size={24} className="text-red-400" />,
          confirmBtn: 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-lg shadow-red-900/30 focus:ring-red-500/50',
        };
      case 'warning':
        return {
          iconBadge: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
          icon: <AlertTriangle size={24} className="text-amber-400" />,
          confirmBtn: 'bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white shadow-lg shadow-amber-900/30 focus:ring-amber-500/50',
        };
      case 'info':
      default:
        return {
          iconBadge: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
          icon: <Info size={24} className="text-blue-400" />,
          confirmBtn: 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white shadow-lg shadow-blue-900/30 focus:ring-blue-500/50',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={() => !isLoading && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div
        className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6 relative text-slate-100 transform transition-all animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isLoading}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
          aria-label="Đóng"
        >
          <X size={18} />
        </button>

        <div className="flex gap-4 items-start">
          {/* Icon Badge */}
          <div className={`p-3 rounded-xl border shrink-0 flex items-center justify-center ${styles.iconBadge}`}>
            {styles.icon}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 id="confirm-modal-title" className="text-base font-semibold text-slate-100 leading-snug">
              {title}
            </h3>
            {message && (
              <div className="mt-2 text-sm text-slate-300 whitespace-pre-line leading-relaxed">
                {message}
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-slate-100 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 disabled:opacity-60 focus:outline-none focus:ring-2 ${styles.confirmBtn}`}
          >
            {isLoading && <Loader2 size={16} className="animate-spin" />}
            <span>{confirmText}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
