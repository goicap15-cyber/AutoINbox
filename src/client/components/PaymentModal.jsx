import React, { useState, useEffect } from 'react';
import { setStoredLicenseKey } from '../utils/machineId';
import { X, Check, Copy, RefreshCw, CreditCard, ShieldCheck, Laptop, Calendar } from 'lucide-react';

const LICENSE_SERVER_URL = 'https://genblackmmoonline.online/license_server';

export default function PaymentModal({ isOpen, onClose, onActivated, existingLicense = null }) {
  const isUpgrade = Boolean(existingLicense?.key);
  const [step, setStep] = useState(1); // 1: Configure, 2: Payment QR, 3: Success
  const [months, setMonths] = useState(1);
  const [machines, setMachines] = useState(1);
  const [loading, setLoading] = useState(false);
  
  // Payment Order State
  const [orderData, setOrderData] = useState(null);
  const [copiedField, setCopiedField] = useState(null);
  const [activatedKey, setActivatedKey] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyError, setCompanyError] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);
  const [pricing, setPricing] = useState(null);
  const [pricingError, setPricingError] = useState('');

  // Reset state when opening modal
  useEffect(() => {
    if (isOpen) {
      setMonths(1);
      setMachines(isUpgrade ? 0 : 1);
      setStep(1);
      setOrderData(null);
      setCopiedField(null);
      setActivatedKey('');
      setCompanyName('');
      setCompanyError('');
      setSavingCompany(false);
    }
  }, [isOpen, isUpgrade]);

  useEffect(() => {
    if (!isOpen) return;
    setPricing(null);
    setPricingError('');
    fetch(`${LICENSE_SERVER_URL}/api/pricing`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || 'Không thể tải bảng giá');
        setPricing(json.data);
      })
      .catch((err) => setPricingError(err.message));
  }, [isOpen]);

  // Polling check status khi đang ở bước 2
  useEffect(() => {

    if (step !== 2 || !orderData?.orderCode) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${LICENSE_SERVER_URL}/api/orders/status/${orderData.orderCode}`);
        const json = await res.json();

        if (json.success && json.data.status === 'PAID' && json.data.keyValue) {
          clearInterval(interval);
          const keyValue = json.data.keyValue;
          setActivatedKey(keyValue);
          setStoredLicenseKey(keyValue);

          // Kích hoạt qua Local Backend để dùng đúng Machine ID của ứng dụng.
          const activateRes = await fetch('/api/license/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: keyValue })
          });
          const activateJson = await activateRes.json();

          if (!activateRes.ok || !activateJson.success) {
            throw new Error(activateJson.message || activateJson.error || 'Không thể tự động kích hoạt Key');
          }

          // Giữ nguyên bước thành công để khách hàng nhìn thấy và sao chép Key.
          setStep(3);
        }
      } catch (err) {
        console.error('Polling payment status error:', err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [step, orderData]);

  if (!isOpen) return null;

  // Giá xem trước lấy từ Central License Server; số tiền chính thức luôn do server trả về.
  const UNIT_PRICE = pricing?.unitPrice || 0;
  const EXTRA_SLOT_PRICE = pricing?.extraSlotPrice || 0;
  const discountPercent = pricing?.discounts?.[months] ?? 0;
  const remainingMonths = Math.max(1, Math.ceil((existingLicense?.daysRemaining || 0) / 30) + months);
  const rawTotal = isUpgrade
    ? months * (UNIT_PRICE + Math.max(0, (existingLicense?.machines || 1) - 1) * EXTRA_SLOT_PRICE) + machines * EXTRA_SLOT_PRICE * remainingMonths
    : months * (UNIT_PRICE + Math.max(0, machines - 1) * EXTRA_SLOT_PRICE);
  const finalTotal = Math.floor(rawTotal * (1 - discountPercent / 100));

  // Tạo đơn hàng thanh toán
  const handleCreateOrder = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${LICENSE_SERVER_URL}/api/orders/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months, machines, licenseKey: isUpgrade ? existingLicense.key : undefined })
      });
      const json = await res.json();
      if (json.success) {
        setOrderData(json.data);
        setStep(2);
      } else {
        alert('Tạo đơn hàng thất bại: ' + (json.error || 'Lỗi kết nối'));
      }
    } catch (err) {
      alert('Không thể kết nối đến Central License Server (5055): ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleSaveCompany = async (event) => {
    event.preventDefault();
    const normalizedName = companyName.trim().replace(/\s+/g, ' ');
    if (normalizedName.length < 2) {
      setCompanyError('Vui lòng nhập tên công ty có ít nhất 2 ký tự.');
      return;
    }

    setSavingCompany(true);
    setCompanyError('');
    try {
      const response = await fetch('/api/license/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: normalizedName })
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Không thể lưu tên công ty');
      }
      await onActivated?.();
      onClose();
    } catch (error) {
      setCompanyError(error.message || 'Không thể lưu tên công ty. Vui lòng thử lại.');
    } finally {
      setSavingCompany(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-[var(--color-border,#284057)] bg-[var(--color-bg-panel,#0f1b2b)] text-[var(--color-text-primary,#f8fafc)] shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border,#284057)] bg-[var(--color-bg-sidebar,#0b1624)]">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <CreditCard className="w-5 h-5 text-[var(--color-accent,#0ea5e9)]" />
            <span>{isUpgrade ? 'Gia Hạn / Nâng Cấp Bản Quyền' : 'Đăng Ký Bản Quyền CRM'}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--color-bg-surface,#132235)] text-[var(--color-text-muted,#7f95aa)] transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6">
          
          {/* STEP 1: CHỌN GÓI */}
          {step === 1 && (
            <div className="space-y-6">
              
              {/* Chọn số tháng */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted,#7f95aa)] uppercase tracking-wider mb-2">
                  1. {isUpgrade ? 'Cộng Thêm Thời Hạn' : 'Chọn Thời Hạn'} (Tháng)
                </label>
                <div className={`grid ${isUpgrade ? 'grid-cols-5' : 'grid-cols-4'} gap-2`}>
                  {[
                    ...(isUpgrade ? [{ m: 0, label: 'Không thêm', discount: 0 }] : []),
                    { m: 1, label: '1 Tháng', discount: pricing?.discounts?.[1] || 0 },
                    { m: 3, label: '3 Tháng', discount: pricing?.discounts?.[3] || 0 },
                    { m: 6, label: '6 Tháng', discount: pricing?.discounts?.[6] || 0 },
                    { m: 12, label: '1 Năm', discount: pricing?.discounts?.[12] || 0 }
                  ].map(item => (
                    <button
                      key={item.m}
                      onClick={() => setMonths(item.m)}
                      className={`relative flex flex-col items-center justify-center p-3 rounded-lg border text-sm font-medium transition ${
                        months === item.m
                          ? 'border-[var(--color-accent,#0ea5e9)] bg-[var(--color-accent-subtle,rgba(14,165,233,0.14))] text-[var(--color-accent,#0ea5e9)]'
                          : 'border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] hover:border-gray-500'
                      }`}
                    >
                      <span>{item.label}</span>
                      {item.discount > 0 && (
                        <span className="mt-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">
                          -{item.discount}%
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Chọn số máy */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted,#7f95aa)] uppercase tracking-wider mb-2">
                  2. {isUpgrade ? 'Cộng Thêm Slot Máy' : 'Chọn Số Máy'}
                </label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setMachines(Math.max(isUpgrade ? 0 : 1, machines - 1))}
                    className="w-10 h-10 rounded-lg border border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] hover:bg-[var(--color-bg-elevated,#172b42)] font-bold text-lg"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={isUpgrade ? 0 : 1}
                    max="100"
                    value={machines}
                    onChange={(e) => setMachines(Math.max(isUpgrade ? 0 : 1, parseInt(e.target.value) || 0))}
                    className="w-24 h-10 text-center rounded-lg border border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] text-lg font-bold focus:outline-none focus:border-[var(--color-accent,#0ea5e9)]"
                  />
                  <button
                    onClick={() => setMachines(machines + 1)}
                    className="w-10 h-10 rounded-lg border border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] hover:bg-[var(--color-bg-elevated,#172b42)] font-bold text-lg"
                  >
                    +
                  </button>
                  <span className="text-sm text-[var(--color-text-muted,#7f95aa)]">{isUpgrade ? 'slot máy cộng thêm' : 'máy tính sử dụng'}</span>
                </div>
              </div>

              {/* Tổng tiền & Chi tiết */}
              <div className="p-4 rounded-xl bg-[var(--color-bg-surface,#132235)] border border-[var(--color-border,#284057)] space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-text-muted,#7f95aa)]">Đơn giá gốc:</span>
                  <span>{pricing ? `${UNIT_PRICE.toLocaleString('vi-VN')}đ / máy đầu tiên / tháng` : 'Đang tải bảng giá...'}</span>
                </div>
                {pricing && machines > (isUpgrade ? 0 : 1) && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--color-text-muted,#7f95aa)]">{isUpgrade ? machines : machines - 1} slot máy bổ sung:</span>
                    <span>{EXTRA_SLOT_PRICE.toLocaleString('vi-VN')}đ / slot / tháng</span>
                  </div>
                )}
                {discountPercent > 0 && (
                  <div className="flex justify-between text-sm text-emerald-400">
                    <span>Ưu đãi giảm giá ({discountPercent}%):</span>
                    <span>-{(rawTotal - finalTotal).toLocaleString('vi-VN')}đ</span>
                  </div>
                )}
                <div className="flex justify-between items-center pt-2 border-t border-[var(--color-border,#284057)]">
                  <span className="font-semibold text-base">Tổng thanh toán:</span>
                  <span className="text-2xl font-bold text-[var(--color-accent,#0ea5e9)]">
                    {finalTotal.toLocaleString('vi-VN')}đ
                  </span>
                </div>
              </div>

              {pricingError && <p className="text-sm text-red-400">{pricingError}. Vui lòng đóng và mở lại bảng thanh toán.</p>}
              <button
                onClick={handleCreateOrder}
                disabled={loading || !pricing || Boolean(pricingError) || (isUpgrade && months === 0 && machines === 0)}
                className="w-full py-3 rounded-lg bg-[var(--color-accent,#0ea5e9)] hover:bg-sky-400 text-white font-semibold text-base shadow-lg transition flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : 'Tiếp Tục Thanh Toán VietQR ➔'}
              </button>

            </div>
          )}

          {/* STEP 2: VIETQR PAYMENT */}
          {step === 2 && orderData && (
            <div className="space-y-4 text-center">
              
              <div className="inline-block p-2 rounded-2xl bg-white shadow-xl">
                <img
                  src={orderData.qrCodeUrl}
                  alt="VietQR Code"
                  className="w-52 h-52 object-contain mx-auto"
                />
              </div>

              <div className="flex items-center justify-center gap-2 text-xs font-semibold text-emerald-400">
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Đang chờ chuyển khoản... Sau khi chuyển khoản, vui lòng đợi khoảng 5 giây để hệ thống xác nhận và cấp Key tự động.</span>
              </div>

              {/* Chi tiết thông tin CK */}
              <div className="text-left space-y-2.5 p-3.5 rounded-lg bg-[var(--color-bg-surface,#132235)] border border-[var(--color-border,#284057)] text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-muted,#7f95aa)]">Ngân hàng:</span>
                  <span className="font-semibold">{orderData.bankName}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-muted,#7f95aa)]">Số tài khoản:</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold">{orderData.bankNo}</span>
                    <button
                      onClick={() => copyToClipboard(orderData.bankNo, 'bankNo')}
                      className="p-1 text-xs text-[var(--color-accent,#0ea5e9)] hover:underline flex items-center gap-1"
                    >
                      {copiedField === 'bankNo' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-muted,#7f95aa)]">Chủ tài khoản:</span>
                  <span className="font-semibold">{orderData.accountName}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-muted,#7f95aa)]">Số tiền:</span>
                  <span className="font-bold text-amber-400">{orderData.totalAmount.toLocaleString('vi-VN')}đ</span>
                </div>
                <div className="flex justify-between items-center p-2 rounded bg-amber-500/10 border border-amber-500/30">
                  <span className="text-xs text-amber-300 font-semibold">Nội dung CK:</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-amber-400 text-base">{orderData.orderCode}</span>
                    <button
                      onClick={() => copyToClipboard(orderData.orderCode, 'orderCode')}
                      className="p-1 text-xs text-amber-400 hover:underline flex items-center gap-1"
                    >
                      {copiedField === 'orderCode' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setStep(1)}
                className="w-full py-2 text-sm text-[var(--color-text-muted,#7f95aa)] hover:text-white transition"
              >
                ← Quay lại thay đổi gói
              </button>

            </div>
          )}

          {/* STEP 3: THANH TOÁN THÀNH CÔNG */}
          {step === 3 && (
            <div className="text-center py-4 space-y-6">
              
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/40">
                <ShieldCheck className="w-10 h-10" />
              </div>

              <div>
                <h3 className="text-xl font-bold text-emerald-400">Thanh Toán Thành Công!</h3>
                <p className="text-sm text-[var(--color-text-muted,#7f95aa)] mt-1">
                  Cảm ơn bạn! License Key đã được tự động kích hoạt trên máy tính này.
                </p>
              </div>

              {/* Key Code Box */}
              <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/30 text-center space-y-2">
                <div className="text-xs text-[var(--color-text-muted,#7f95aa)] uppercase tracking-wider">Mã License Key Của Bạn</div>
                <div className="font-mono font-bold text-xl text-[var(--color-accent,#0ea5e9)] tracking-wider">
                  {activatedKey}
                </div>
                <button
                  onClick={() => copyToClipboard(activatedKey, 'key')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-bg-surface,#132235)] hover:bg-[var(--color-bg-elevated,#172b42)] text-xs text-[var(--color-text-primary,#f8fafc)] border border-[var(--color-border,#284057)] transition"
                >
                  {copiedField === 'key' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedField === 'key' ? 'Đã Sao Chép!' : 'Sao Chép Mã Key'}</span>
                </button>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left text-sm text-emerald-700">
                <strong>Key đã được lưu tự động.</strong> Bạn không cần nhập lại Key khi sử dụng CRM trên máy này.
              </div>

              <form onSubmit={handleSaveCompany} className={`${isUpgrade ? 'hidden' : ''} space-y-3 text-left`}>
                <div>
                  <label htmlFor="payment-company-name" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Tên công ty <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="payment-company-name"
                    autoFocus
                    type="text"
                    value={companyName}
                    onChange={(event) => {
                      setCompanyName(event.target.value);
                      if (companyError) setCompanyError('');
                    }}
                    maxLength={120}
                    placeholder="Ví dụ: Công ty TNHH AutoFB"
                    aria-describedby={companyError ? 'payment-company-error' : undefined}
                    aria-invalid={Boolean(companyError)}
                    className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                  <p className="mt-1 text-xs text-slate-500">Bắt buộc nhập để hoàn tất đăng ký bản quyền.</p>
                  {companyError && <p id="payment-company-error" role="alert" className="mt-1 text-xs font-medium text-red-600">{companyError}</p>}
                </div>
                <button
                  type="submit"
                  disabled={savingCompany || companyName.trim().length < 2}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-base font-semibold text-white shadow-lg transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingCompany ? <><RefreshCw className="h-4 w-4 animate-spin" /> Đang lưu tên công ty...</> : 'Xác Nhận & Bắt Đầu Sử Dụng CRM'}
                </button>
              </form>
              {isUpgrade && (
                <button
                  type="button"
                  onClick={async () => { await onActivated?.(); onClose(); }}
                  className="flex w-full items-center justify-center rounded-lg bg-blue-600 py-3 text-base font-semibold text-white shadow-lg transition hover:bg-blue-500"
                >Hoàn Tất Gia Hạn / Nâng Cấp</button>
              )}

            </div>
          )}

        </div>

      </div>
    </div>
  );
}
