import React, { useState, useEffect } from 'react';
import { X, Key, ShieldAlert, ShieldCheck, LogOut, RefreshCw, PlusCircle } from 'lucide-react';

export default function LicenseManagerModal({ isOpen, onClose, onOpenPayment }) {
  const [keyInput, setKeyInput] = useState('');
  const [licenseInfo, setLicenseInfo] = useState(null);
  const [currentKey, setCurrentKey] = useState('');
  const [machineId, setMachineId] = useState('Được quản lý bởi Backend');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadLicenseStatus = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/license/status');
      const json = await res.json();
      const status = json.data;

      if (res.ok && json.success && status?.isLicensed) {
        setCurrentKey(status.key || '');
        setLicenseInfo(status);
      } else {
        setCurrentKey('');
        setLicenseInfo(null);
        setErrorMsg(status?.message || json.message || 'Máy tính này chưa được kích hoạt Key.');
      }
    } catch (err) {
      setCurrentKey('');
      setLicenseInfo(null);
      setErrorMsg('Không thể kiểm tra bản quyền: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setErrorMsg('');
      setSuccessMsg('');
      loadLicenseStatus();
    }
  }, [isOpen]);

  const handleActivateNewKey = async (e) => {
    e.preventDefault();
    if (!keyInput.trim()) return;

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyInput.trim() })
      });
      const json = await res.json();

      if (res.ok && json.success) {
        setSuccessMsg(json.message || 'Kích hoạt thành công!');
        setKeyInput('');
        await loadLicenseStatus();
      } else {
        setErrorMsg(json.message || json.error || 'Kích hoạt thất bại.');
      }
    } catch (err) {
      setErrorMsg('Lỗi kết nối Server: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivate = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/license/deactivate', { method: 'POST' }).catch(() => ({}));
      setCurrentKey('');
      setLicenseInfo(null);
      setSuccessMsg('Đã đăng xuất Key thành công!');
    } catch (err) {
      setErrorMsg('Lỗi đăng xuất Key: ' + err.message);
    } finally {
      setLoading(false);
      window.location.reload();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-[var(--color-border,#284057)] bg-[var(--color-bg-panel,#0f1b2b)] text-[var(--color-text-primary,#f8fafc)] shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border,#284057)] bg-[var(--color-bg-sidebar,#0b1624)]">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <Key className="w-5 h-5 text-[var(--color-accent,#0ea5e9)]" />
            <span>Quản Lý Bản Quyền App</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--color-bg-surface,#132235)] text-[var(--color-text-muted,#7f95aa)] transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          
          {/* Thông báo lỗi / Thành công */}
          {errorMsg && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
          {successMsg && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* HIỂN THỊ THÔNG TIN KEY HIỆN TẠI (NẾU ĐÃ KÍCH HOẠT) */}
          {currentKey && licenseInfo ? (
            <div className="p-4 rounded-xl bg-[var(--color-bg-surface,#132235)] border border-[var(--color-border,#284057)] space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-text-muted,#7f95aa)] uppercase tracking-wider">Trạng Thái Bản Quyền</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <ShieldCheck className="w-3.5 h-3.5" /> Đã Kích Hoạt
                </span>
              </div>

              <div>
                <div className="text-xs text-[var(--color-text-muted,#7f95aa)]">Mã Key Hiện Tại:</div>
                <div className="font-mono font-bold text-lg text-[var(--color-accent,#0ea5e9)]">{currentKey}</div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="p-2.5 rounded-lg bg-[var(--color-bg-panel,#0f1b2b)] border border-[var(--color-border,#284057)]">
                  <div className="text-xs text-[var(--color-text-muted,#7f95aa)]">Thời hạn còn lại</div>
                  <div className="font-bold text-emerald-400 text-base">{licenseInfo.daysRemaining} ngày</div>
                </div>
                <div className="p-2.5 rounded-lg bg-[var(--color-bg-panel,#0f1b2b)] border border-[var(--color-border,#284057)]">
                  <div className="text-xs text-[var(--color-text-muted,#7f95aa)]">Số máy mua (Slots)</div>
                  <div className="font-bold text-amber-400 text-base">{licenseInfo.machines} máy</div>
                </div>
              </div>

              {/* Nút Đăng xuất Key khỏi máy */}
              <button
                onClick={handleDeactivate}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-medium text-sm transition flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span>Đăng Xuất Key Khỏi Máy Này (Giải phóng Slot)</span>
              </button>
            </div>
          ) : (
            /* FORM NHẬP KEY MỚI */
            <form onSubmit={handleActivateNewKey} className="space-y-3">
              <label className="block text-sm font-medium">Nhập Mã License Key để kích hoạt:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="KEY-XXXX-XXXX-XXXX-XXXX"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  className="flex-1 px-3.5 py-2.5 rounded-lg border border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] text-sm font-mono focus:outline-none focus:border-[var(--color-accent,#0ea5e9)]"
                />
                <button
                  type="submit"
                  disabled={loading || !keyInput.trim()}
                  className="px-4 py-2.5 rounded-lg bg-[var(--color-accent,#0ea5e9)] hover:bg-sky-400 text-white font-medium text-sm transition flex items-center gap-1.5"
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Kích Hoạt'}
                </button>
              </div>
            </form>
          )}

          {/* Machine Hardware ID Footer */}
          <div className="pt-3 border-t border-[var(--color-border,#284057)] flex items-center justify-between text-xs text-[var(--color-text-muted,#7f95aa)]">
            <span>Machine ID máy này:</span>
            <code className="font-mono bg-[var(--color-bg-surface,#132235)] px-2 py-0.5 rounded border border-[var(--color-border,#284057)]">
              {machineId.substring(0, 16)}...
            </code>
          </div>

          {/* Button Mua License Mới */}
          <button
            onClick={() => {
              onClose();
              if (onOpenPayment) onOpenPayment();
            }}
            className="w-full py-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-sm transition flex items-center justify-center gap-2"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Mua / Gia Hạn Bản Quyền Mới Qua VietQR</span>
          </button>

        </div>

      </div>
    </div>
  );
}
