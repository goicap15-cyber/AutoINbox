import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, BarChart3, Eye, EyeOff, KeyRound, LockKeyhole, LogIn, MessageCircle,
  ShieldCheck, UserPlus, Users
} from 'lucide-react';
import { useSocket } from '../hooks/useSocket.js';

export default function AuthScreen({ onAuthenticated }) {
  const { socket } = useSocket(true);
  const googleButtonRef = useRef(null);
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (otpCooldown <= 0) return undefined;
    const timer = setInterval(() => setOtpCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [otpCooldown]);

  const requestOtp = async () => {
    const email = username.trim().toLowerCase();
    if (!email.endsWith('@gmail.com')) {
      setError('Vui lòng nhập địa chỉ @gmail.com hợp lệ.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const endpoint = mode === 'forgot' ? '/api/auth/reset-password-otp' : '/api/auth/register-otp';
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.message || 'Không thể gửi mã OTP.');
      setOtpSent(true);
      setOtpCooldown(60);
    } catch (otpError) {
      setError(otpError.message);
    } finally {
      setLoading(false);
    }
  };

  const isElectron = typeof window !== 'undefined' && (
    window.location.search.includes('desktop=1') ||
    navigator.userAgent.includes('FB-CRM-Desktop') ||
    navigator.userAgent.includes('Electron') ||
    Boolean(window.electronAPI)
  );

  const handleExternalGoogleLogin = () => {
    const url = `${window.location.origin}/google-auth-external`;
    window.open(url, '_blank');
  };

  useEffect(() => {
    if (!socket) return;
    const handleAuthSuccess = async (data) => {
      if (data?.token) {
        try {
          await fetch('/api/auth/claim-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: data.token })
          });
        } catch (_) {}
      }
      if (data?.user) {
        onAuthenticated(data.user);
      }
    };
    socket.on('AUTH_SUCCESS', handleAuthSuccess);
    return () => {
      socket.off('AUTH_SUCCESS', handleAuthSuccess);
    };
  }, [socket, onAuthenticated]);

  useEffect(() => {
    let authPollTimer = null;
    const pollAuthStatus = async () => {
      try {
        const localRes = await fetch('/api/auth/latest-local-session', { credentials: 'include' });
        const localData = await localRes.json().catch(() => ({}));
        if (localRes.ok && localData.success && localData.user) {
          onAuthenticated(localData.user);
          return;
        }

        const res = await fetch('/api/auth/me', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success && data.user) {
          onAuthenticated(data.user);
        }
      } catch (_) {}
    };

    authPollTimer = setInterval(pollAuthStatus, 1000);
    return () => {
      if (authPollTimer) clearInterval(authPollTimer);
    };
  }, [onAuthenticated]);

  useEffect(() => {
    if (mode === 'forgot' || isElectron) return;
    let cancelled = false;
    let retryTimer = null;
    const renderGoogleButton = () => {
      if (cancelled || !googleButtonRef.current) return;
      if (!window.google?.accounts?.id) {
        retryTimer = setTimeout(renderGoogleButton, 150);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: '436041288370-9v5egma47gmsbi2pgalj77un535j15r7.apps.googleusercontent.com',
        callback: async ({ credential }) => {
          setLoading(true);
          setError('');
          try {
            const response = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) throw new Error(result.message || 'Không thể đăng nhập bằng Google.');
            onAuthenticated(result.user);
          } catch (googleError) {
            setError(googleError.message);
          } finally {
            setLoading(false);
          }
        }
      });
      googleButtonRef.current.replaceChildren();
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: mode === 'register' ? 'signup_with' : 'signin_with',
        shape: 'rectangular',
        width: 384
      });
    };
    renderGoogleButton();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [mode, onAuthenticated, isElectron]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setSuccessMsg('');

    if (mode === 'forgot') {
      if (password !== confirmPassword) {
        setError('Mật khẩu xác nhận không khớp.');
        return;
      }
      setLoading(true);
      try {
        const email = username.trim().toLowerCase();
        const response = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, otp, password })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.message || 'Không thể đặt lại mật khẩu.');
        setSuccessMsg(result.message || 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập với mật khẩu mới.');
        switchMode('login');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === 'register' && password !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? { username: username.trim().toLowerCase(), email: username.trim().toLowerCase(), password, otp } : { username: username.trim().toLowerCase(), password })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.message || 'Không thể xác thực tài khoản.');
      onAuthenticated(result.user);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError('');
    setPassword('');
    setConfirmPassword('');
    setOtp('');
    setOtpSent(false);
    setOtpCooldown(0);
  };

  const inputClass = 'w-full h-12 rounded-lg border border-slate-400 bg-white px-4 text-base font-normal text-slate-900 placeholder:text-slate-500 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15';

  return (
    <main className="min-h-screen bg-white flex">
      <section className="w-full min-h-screen overflow-hidden bg-white grid lg:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col px-7 py-8 sm:px-14 lg:px-[8vw] lg:py-12">
          <div className="flex items-center gap-2.5 text-slate-950">
            <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/20">
              <MessageCircle size={20} fill="currentColor" />
            </div>
            <div>
              <div className="font-bold tracking-tight leading-none">MISSPRICE</div>
              <div className="text-[10px] tracking-[0.24em] text-slate-500 mt-1">CRM</div>
            </div>
          </div>

          <div className="flex-1 flex items-center py-12">
            <div className="w-full max-w-sm mx-auto">
              <div className="mb-8">
                <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-700 mb-3">
                  {mode === 'login' ? 'Chào mừng trở lại' : mode === 'register' ? 'Tạo tài khoản mới' : 'Khôi phục tài khoản'}
                </p>
                <h1 className="text-4xl font-bold tracking-tight text-slate-950">
                  {mode === 'login' ? 'Đăng nhập tài khoản' : mode === 'register' ? 'Đăng ký tài khoản' : 'Quên mật khẩu'}
                </h1>
                <p className="mt-3 text-base leading-7 font-normal text-slate-600">
                  {mode === 'login'
                    ? 'Nhập thông tin của bạn để tiếp tục vào hệ thống CRM.'
                    : mode === 'register'
                      ? 'Tạo tài khoản nhân viên để bắt đầu sử dụng hệ thống.'
                      : 'Nhập Gmail đăng ký để nhận mã OTP và đặt lại mật khẩu mới.'}
                </p>
              </div>

              {mode !== 'forgot' ? (
                <div className="mb-6 grid grid-cols-2 border-b border-slate-200" role="tablist" aria-label="Chọn hình thức xác thực">
                  <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => switchMode('login')} className={`pb-3 text-base font-medium border-b-2 transition ${mode === 'login' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>Đăng nhập</button>
                  <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => switchMode('register')} className={`pb-3 text-base font-medium border-b-2 transition ${mode === 'register' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>Đăng ký</button>
                </div>
              ) : (
                <div className="mb-6 pb-2 border-b border-slate-200">
                  <button type="button" onClick={() => switchMode('login')} className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-blue-600 transition-colors">
                    <ArrowLeft size={16} /> Quay lại đăng nhập
                  </button>
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                {successMsg && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 font-medium">{successMsg}</div>}
                {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</div>}

                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">{mode === 'login' ? 'Tên đăng nhập hoặc Gmail' : 'Gmail đăng ký'}</span>
                  <input type={mode === 'login' ? 'text' : 'email'} autoFocus autoComplete="username" value={username} onChange={(event) => { setUsername(event.target.value); if (mode !== 'login') { setOtpSent(false); setOtp(''); } }} minLength={3} maxLength={254} required className={inputClass} placeholder={mode === 'login' ? 'Nhập tên đăng nhập hoặc Gmail' : 'example@gmail.com'} />
                </label>

                {mode !== 'login' && (
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium text-slate-700">Mã OTP</span>
                    <div className="flex gap-2">
                      <input inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} minLength={6} maxLength={6} required className={`${inputClass} tracking-[0.35em] font-semibold`} placeholder="Nhập 6 số" />
                      <button type="button" onClick={requestOtp} disabled={loading || otpCooldown > 0} className="shrink-0 rounded-lg border border-blue-600 px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">{otpCooldown > 0 ? `${otpCooldown}s` : otpSent ? 'Gửi lại' : 'Lấy OTP'}</button>
                    </div>
                    {otpSent && <span className="text-xs text-slate-500">Mã OTP đã gửi tới Gmail và có hiệu lực trong 5 phút.</span>}
                  </label>
                )}

                <div>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium text-slate-700">{mode === 'forgot' ? 'Mật khẩu mới' : 'Mật khẩu'}</span>
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode !== 'login' ? 8 : undefined} required className={`${inputClass} pr-11`} placeholder={mode !== 'login' ? 'Tối thiểu 8 ký tự' : 'Nhập mật khẩu'} />
                      <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} className="absolute right-3.5 top-3.5 text-slate-500 hover:text-slate-800">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
                    </div>
                  </label>
                  {mode === 'login' && (
                    <div className="flex justify-end pt-1.5">
                      <button type="button" onClick={() => switchMode('forgot')} className="text-xs font-semibold text-blue-600 hover:underline">Quên mật khẩu?</button>
                    </div>
                  )}
                </div>

                {mode !== 'login' && (
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium text-slate-700">{mode === 'forgot' ? 'Xác nhận mật khẩu mới' : 'Xác nhận mật khẩu'}</span>
                    <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required className={inputClass} placeholder="Nhập lại mật khẩu" />
                  </label>
                )}

                <button disabled={loading || (mode !== 'login' && (!otpSent || otp.length !== 6))} className="w-full h-12 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 text-white text-base font-semibold shadow-lg shadow-blue-600/20 transition flex items-center justify-center gap-2">
                  {mode === 'login' ? <LogIn size={17} /> : mode === 'register' ? <UserPlus size={17} /> : <KeyRound size={17} />}
                  {loading ? 'Đang xử lý...' : mode === 'login' ? 'Đăng nhập' : mode === 'register' ? 'Tạo tài khoản' : 'Đặt lại mật khẩu'}
                </button>
              </form>

              {mode !== 'forgot' && (
                <>
                  <div className="my-5 flex items-center gap-3" aria-hidden="true">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="text-sm text-slate-500">hoặc</span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                  {isElectron ? (
                    <button
                      type="button"
                      onClick={handleExternalGoogleLogin}
                      className="w-full h-11 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold shadow-sm transition flex items-center justify-center gap-3 cursor-pointer"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                      </svg>
                      {mode === 'register' ? 'Đăng ký bằng Google' : 'Đăng nhập bằng Google'}
                    </button>
                  ) : (
                    <div ref={googleButtonRef} className="min-h-11 flex justify-center" aria-label="Đăng nhập bằng Google" />
                  )}
                </>
              )}
            </div>
          </div>

          <p className="text-center text-sm font-medium text-slate-500">Đăng nhập an toàn · Dữ liệu được lưu trên máy của bạn</p>
        </div>

        <aside className="relative hidden lg:flex overflow-hidden bg-gradient-to-br from-blue-800 via-blue-600 to-sky-400 text-white p-14 flex-col" aria-label="Giới thiệu MISSPRICE CRM">
          <div className="absolute -top-28 -right-24 w-80 h-80 rounded-full border-[46px] border-white/5" />
          <div className="absolute top-24 -left-40 w-[520px] h-[520px] rounded-full border-[72px] border-white/[0.04]" />
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm">
              <ShieldCheck size={15} /> Facebook Messenger CRM
            </div>
            <h2 className="mt-8 max-w-xl text-5xl font-bold leading-tight tracking-tight">Chăm sóc khách hàng hiệu quả hơn mỗi ngày</h2>
            <p className="mt-5 max-w-xl text-lg font-medium leading-8 text-blue-50">Quản lý hội thoại, khách hàng và chiến dịch trong một không gian làm việc thống nhất.</p>
          </div>

          <div className="relative z-10 mt-auto translate-x-8 translate-y-12 rotate-[-4deg] rounded-2xl border border-white/30 bg-slate-50 p-4 text-slate-900 shadow-2xl shadow-blue-950/30">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2"><div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center"><MessageCircle size={15} /></div><span className="text-xs font-bold">Trung tâm hội thoại</span></div>
              <div className="h-7 w-24 rounded-md bg-slate-100" />
            </div>
            <div className="grid grid-cols-[150px_1fr] gap-3 pt-3">
              <div className="space-y-2">
                {[['Lan Anh', 'Cần tư vấn sản phẩm'], ['Minh Tuấn', 'Đã gửi số điện thoại'], ['Ngọc Mai', 'Cảm ơn shop nhé']].map(([name, message], index) => (
                  <div key={name} className={`rounded-lg p-2.5 ${index === 0 ? 'bg-blue-50 border border-blue-100' : 'bg-slate-100'}`}><div className="text-[10px] font-bold">{name}</div><div className="mt-1 text-[8px] text-slate-500 truncate">{message}</div></div>
                ))}
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex gap-2">
                  {[{ icon: Users, value: '248', label: 'Khách hàng' }, { icon: MessageCircle, value: '64', label: 'Hội thoại' }, { icon: BarChart3, value: '92%', label: 'Phản hồi' }].map(({ icon: Icon, value, label }) => (
                    <div key={label} className="flex-1 rounded-lg bg-slate-50 p-2"><Icon size={13} className="text-blue-600" /><div className="mt-2 text-sm font-bold">{value}</div><div className="text-[7px] text-slate-500">{label}</div></div>
                  ))}
                </div>
                <div className="mt-4 space-y-2.5"><div className="h-2 w-3/4 rounded bg-slate-100" /><div className="h-2 w-full rounded bg-slate-100" /><div className="h-2 w-5/6 rounded bg-blue-100" /><div className="mt-5 h-24 rounded-lg bg-gradient-to-t from-blue-100 to-blue-50" /></div>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
