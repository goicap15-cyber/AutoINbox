import React, { useState } from 'react';
import { ShieldAlert, Key, CreditCard, RefreshCw, CheckCircle2 } from 'lucide-react';

export default function LicenseLockScreen({ status, onOpenPayment, onBackToLogin, sessionUser }) {
  const [inputKey, setInputKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const isEmployee = sessionUser?.company_role === 'EMPLOYEE';

  const handleActivate = async (e) => {
    e.preventDefault();
    if (!inputKey.trim()) return;

    setLoading(true);
    setError('');
    setSuccessMsg('');

    try {
      const resLocal = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: inputKey.trim() })
      });
      const jsonLocal = await resLocal.json();

      if (resLocal.ok && jsonLocal.success) {
        setSuccessMsg('Kích hoạt bản quyền thành công! Đang tải lại ứng dụng...');
        // Reload the whole page instead of just flipping licenseStatus: the
        // account/thread/inbox-source/lead-status fetches only ever run once
        // on mount, before activation - they all failed with 402 back then
        // and never got a reason to re-fetch afterward, so the UI stayed
        // empty even after the lock screen itself correctly went away. A
        // full reload re-runs every one of those fetches from scratch.
        setTimeout(() => {
          window.location.reload();
        }, 600);
      } else {
        setError(jsonLocal.message || jsonLocal.error || 'Kích hoạt Key không thành công.');
      }
    } catch (err) {
      setError('Không thể kết nối đến License Server: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 backdrop-blur-xl p-4 select-none">
      <div className="relative w-full max-w-lg rounded-2xl border border-[var(--color-border,#284057)] bg-[var(--color-bg-panel,#0f1b2b)] text-[var(--color-text-primary,#f8fafc)] shadow-2xl p-8 text-center space-y-6">
        
        {/* Shield Icon Header */}
        <div className="w-20 h-20 rounded-full bg-amber-500/10 border-2 border-amber-500/40 text-amber-400 flex items-center justify-center mx-auto shadow-lg shadow-amber-500/10">
          <ShieldAlert className="w-10 h-10" />
        </div>

        {/* Title & Description */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">
            {isEmployee ? 'Chờ Kích Hoạt Bản Quyền Doanh Nghiệp' : 'Ứng Dụng Chưa Được Kích Hoạt'}
          </h2>
          <p className="text-sm text-[var(--color-text-muted,#7f95aa)] max-w-sm mx-auto leading-relaxed">
            {isEmployee
              ? 'Tài khoản nhân viên của bạn phụ thuộc vào License Key từ Admin doanh nghiệp. Vui lòng liên hệ Admin để kiểm tra gói bản quyền.'
              : (status?.message || 'Vui lòng kích hoạt License Key để tiếp tục sử dụng tất cả tính năng nhắn tin & chăm sóc khách hàng.')}
          </p>
        </div>

        {/* Alert Error / Success */}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-medium">
            ⚠️ {error}
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-medium flex items-center justify-center gap-2">
            <CheckCircle2 className="w-5 h-5" />
            <span>{successMsg}</span>
          </div>
        )}

        {!isEmployee && (
          <>
            {/* Input Form */}
            <form onSubmit={handleActivate} className="space-y-3 text-left">
              <label className="block text-xs font-semibold text-[var(--color-text-muted,#7f95aa)] uppercase tracking-wider">
                Nhập Mã License Key Của Bạn:
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Key className="w-4 h-4 absolute left-3.5 top-3.5 text-[var(--color-text-muted,#7f95aa)]" />
                  <input
                    type="text"
                    placeholder="KEY-XXXX-XXXX-XXXX-XXXX"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] text-sm font-mono tracking-wider focus:outline-none focus:border-[var(--color-accent,#0ea5e9)]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !inputKey.trim()}
                  className="px-5 py-2.5 rounded-xl bg-[var(--color-accent,#0ea5e9)] hover:bg-sky-400 text-white font-semibold text-sm shadow-md transition flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Kích Hoạt'}
                </button>
              </div>
            </form>

            <div className="relative flex py-1 items-center">
              <div className="flex-grow border-t border-[var(--color-border,#284057)]"></div>
              <span className="flex-shrink mx-3 text-xs text-[var(--color-text-muted,#7f95aa)]">Hoặc</span>
              <div className="flex-grow border-t border-[var(--color-border,#284057)]"></div>
            </div>

            {/* Mua Key Qua VietQR Button */}
            <button
              onClick={onOpenPayment}
              className="w-full py-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg"
            >
              <CreditCard className="w-5 h-5" />
              <span>Mua Bản Quyền Mới Qua Mã QR Ngân Hàng (Tự Động 1s)</span>
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onBackToLogin}
          className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition"
        >
          Quay lại trang đăng nhập
        </button>
      </div>
    </div>
  );
}
