import React, { useState, useEffect } from 'react';
import { X, ExternalLink, ShieldAlert, RefreshCw, PlusCircle, Trash2, Monitor } from 'lucide-react';
import ConfirmModal from './ConfirmModal';

export default function AccountManagerModal({ onClose, onSourcesChanged, onFacebookSyncStart, socket, sessionUser }) {
  const isCompanyAdmin = sessionUser?.company_role === 'ADMIN';
  const [accounts, setAccounts] = useState([]);
  const genericPageName = /^Page \d+$/i;
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState(null);
  const [displayActionId, setDisplayActionId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [accountToDelete, setAccountToDelete] = useState(null);
  const [accountActionError, setAccountActionError] = useState('');
  const [addingSession, setAddingSession] = useState(false);
  const [pendingKey, setPendingKey] = useState(null);
  const [inboxSources, setInboxSources] = useState([]);
  const [pageToken, setPageToken] = useState('');
  const [pageOwnerAccountId, setPageOwnerAccountId] = useState('');
  const [pageConnectError, setPageConnectError] = useState('');
  const [pageConnectLoading, setPageConnectLoading] = useState(false);
  const [initialAccountIds, setInitialAccountIds] = useState(null);
  const [initialDisconnectedAccountIds, setInitialDisconnectedAccountIds] = useState(null);

  const loadInboxSources = async () => {
    try {
      const res = await fetch('/api/inbox-sources');
      const data = await res.json();
      setInboxSources(Array.isArray(data) ? data : []);
    } catch {
      setInboxSources([]);
    }
  };

  const loadAccounts = async () => {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      setAccounts(data);
      return data;
    } catch {
      setAccounts([]);
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    loadInboxSources();
    const interval = setInterval(() => { loadAccounts(); loadInboxSources(); }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Lắng nghe ACCOUNT_STATUS_CHANGED từ socket để biết ngay khi tài khoản mới được đăng ký
  useEffect(() => {
    if (!socket) return;
    const handleAccountStatus = (data) => {
      const belongsToCurrentSetup = Boolean(
        addingSession && pendingKey && data?.pending_key === pendingKey
      );
      const isNewAccount = Boolean(
        addingSession && initialAccountIds && !initialAccountIds.has(data?.account_id)
      );
      if (belongsToCurrentSetup || isNewAccount) {
        // Tài khoản mới đã được backend xác nhận
        setAddingSession(false);
        setPendingKey(null);
        setInitialAccountIds(null);
        loadAccounts();
        onSourcesChanged?.();
      } else {
        loadAccounts();
      }
    };
    const handleExtensionConnection = ({ account_id, is_connected }) => {
      setAccounts((currentAccounts) => currentAccounts.map((account) => (
        String(account.id) === String(account_id)
          ? { ...account, is_extension_connected: is_connected === true }
          : account
      )));
      if (
        addingSession
        && is_connected === true
        && initialDisconnectedAccountIds?.has(String(account_id))
      ) {
        setAddingSession(false);
        setPendingKey(null);
        setInitialAccountIds(null);
        setInitialDisconnectedAccountIds(null);
        loadAccounts();
        onSourcesChanged?.();
      }
    };
    const handleAccountLinkFailed = (data) => {
      if (!pendingKey || data?.pending_key !== pendingKey) return;
      setAccountActionError(data.error || 'Không thể liên kết tài khoản Facebook');
      setAddingSession(false);
      setPendingKey(null);
      setInitialAccountIds(null);
    };
    socket.on('ACCOUNT_STATUS_CHANGED', handleAccountStatus);
    socket.on('EXTENSION_CONNECTION_CHANGED', handleExtensionConnection);
    socket.on('ACCOUNT_LINK_FAILED', handleAccountLinkFailed);
    return () => {
      socket.off('ACCOUNT_STATUS_CHANGED', handleAccountStatus);
      socket.off('EXTENSION_CONNECTION_CHANGED', handleExtensionConnection);
      socket.off('ACCOUNT_LINK_FAILED', handleAccountLinkFailed);
    };
  }, [socket, addingSession, pendingKey, initialAccountIds, initialDisconnectedAccountIds, onSourcesChanged]);

  // Socket events can arrive before the POST /new-session response updates
  // pendingKey. Polling already refreshes accounts, so use that data as a
  // reliable fallback when an existing disconnected account reconnects.
  useEffect(() => {
    if (!addingSession || !initialDisconnectedAccountIds) return;
    const reconnected = accounts.some((account) => (
      account.is_extension_connected === true
      && initialDisconnectedAccountIds.has(String(account.id))
    ));
    if (!reconnected) return;
    setAddingSession(false);
    setPendingKey(null);
    setInitialAccountIds(null);
    setInitialDisconnectedAccountIds(null);
    onSourcesChanged?.();
  }, [accounts, addingSession, initialDisconnectedAccountIds, onSourcesChanged]);

  useEffect(() => {
    if (!addingSession || !pendingKey) return;
    let stopped = false;
    const checkCompletion = async () => {
      try {
        const res = await fetch(`/api/facebook-setup/${encodeURIComponent(pendingKey)}/status`);
        const data = await res.json();
        if (stopped || !res.ok || data?.completed !== true) return;
        setAddingSession(false);
        setPendingKey(null);
        setInitialAccountIds(null);
        setInitialDisconnectedAccountIds(null);
        await loadAccounts();
        onSourcesChanged?.();
      } catch (_) {}
    };
    checkCompletion();
    const timer = setInterval(checkCompletion, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [addingSession, pendingKey, onSourcesChanged]);

  const handleAddNewAccount = async () => {
    setAccountActionError('');
    const currentAccounts = await loadAccounts();
    const currentIds = new Set(currentAccounts.map((a) => a.id));
    const disconnectedIds = new Set(
      currentAccounts
        .filter((account) => account.is_extension_connected !== true)
        .map((account) => String(account.id))
    );
    setInitialAccountIds(currentIds);
    setInitialDisconnectedAccountIds(disconnectedIds);
    setAddingSession(true);
    try {
      const res = await fetch('/api/accounts/new-session', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        setPendingKey(data.pending_key);
      } else {
        setAccountActionError(data.error || 'Không thể mở Chrome để thêm tài khoản Facebook');
        setAddingSession(false);
        setInitialAccountIds(null);
        setInitialDisconnectedAccountIds(null);
      }
    } catch (e) {
      console.error(e);
      setAccountActionError(e.message || 'Không thể kết nối backend để thêm tài khoản');
      setAddingSession(false);
      setInitialAccountIds(null);
      setInitialDisconnectedAccountIds(null);
    }
  };

  const handleStartChrome = async (accountId) => {
    setStartingId(accountId);
    onFacebookSyncStart?.(accountId, true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/start`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Không thể mở Chrome');
      await loadAccounts();
    } catch (error) {
      onFacebookSyncStart?.(accountId, false);
      setAccountActionError(error.message || 'Không thể mở Chrome');
    } finally {
      setStartingId(null);
    }
  };

  const handleChromeDisplayChange = async (account, nextVisible) => {
    const accountId = String(account.id);
    const shouldStartChrome = nextVisible && account.is_chrome_running !== true;
    setAccountActionError('');
    setDisplayActionId(accountId);
    setAccounts((current) => current.map((item) => (
      String(item.id) === accountId
        ? {
            ...item,
            is_chrome_running: nextVisible ? true : item.is_chrome_running,
            chrome_display_mode: nextVisible ? 'VISIBLE' : 'BACKGROUND'
          }
        : item
    )));
    if (shouldStartChrome) onFacebookSyncStart?.(accountId, true);
    try {
      if (shouldStartChrome) {
        const startRes = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/start`, { method: 'POST' });
        const startData = await startRes.json().catch(() => ({}));
        if (!startRes.ok || !startData.success) throw new Error(startData.error || 'Không thể khởi động Chrome');
      }
      const action = nextVisible ? 'open' : 'background';
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Không thể đổi chế độ hiển thị Chrome');
      await loadAccounts();
    } catch (error) {
      if (shouldStartChrome) onFacebookSyncStart?.(accountId, false);
      await loadAccounts();
      setAccountActionError(error.message || 'Không thể đổi chế độ hiển thị Chrome');
    } finally {
      setDisplayActionId(null);
    }
  };
  const handleDeleteAccount = (account) => {
    setAccountToDelete(account);
  };

  const executeDeleteAccount = async () => {
    if (!accountToDelete) return;
    const account = accountToDelete;
    setAccountActionError('');
    setDeletingId(account.id);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Không thể xóa tài khoản');
      }
      setAccounts((currentAccounts) => currentAccounts.filter(
        (currentAccount) => String(currentAccount.id) !== String(account.id)
      ));
      await loadInboxSources();
      onSourcesChanged?.();
      setAccountToDelete(null);
    } catch (error) {
      setAccountActionError(error.message || 'Không thể xóa tài khoản');
    } finally {
      setDeletingId(null);
    }
  };

  const handleConnectPage = async () => {
    setPageConnectError('');
    if (!pageToken.trim()) {
      setPageConnectError('Thiếu Page access token');
      return;
    }
    setPageConnectLoading(true);
    try {
      const res = await fetch('/api/inbox-sources/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_access_token: pageToken.trim(), owner_account_id: pageOwnerAccountId || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không kết nối được Page');
      setPageToken('');
      await loadInboxSources();
      onSourcesChanged?.();
    } catch (err) {
      setPageConnectError(err.message);
    } finally {
      setPageConnectLoading(false);
    }
  };

  const handleDisconnectSource = async (sourceId) => {
    await fetch(`/api/inbox-sources/${sourceId}`, { method: 'DELETE' });
    await loadInboxSources();
    onSourcesChanged?.();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <ShieldAlert size={18} className="text-slate-300" />
            <h3 className="text-xs font-semibold text-slate-100 uppercase tracking-wider">Quản lý Tài khoản Facebook &amp; Checkpoint</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className={'flex items-center justify-between gap-3 ' + (!isCompanyAdmin ? 'hidden' : '')}>
            <p className="text-xs text-slate-400 leading-relaxed flex-1">
              Mở cửa sổ Chrome Portable để kết nối tài khoản mới hoặc xử lý Checkpoint/OTP 2FA.
            </p>
            <button
              onClick={handleAddNewAccount}
              disabled={addingSession}
              className="px-3 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-[var(--color-text-on-accent)] rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 transition-colors shadow-sm"
            >
              {addingSession ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  <span>Đang mở Chrome...</span>
                </>
              ) : (
                <>
                  <PlusCircle size={15} />
                  <span>+ Thêm tài khoản Facebook</span>
                </>
              )}
            </button>
          </div>

          {addingSession && pendingKey && (
            <div className="p-3 bg-sky-950/40 border border-sky-500/30 rounded-xl flex items-center justify-between gap-2.5 text-xs text-sky-200">
              <div className="flex items-start gap-2.5">
                <RefreshCw size={15} className="animate-spin text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sky-300">Đang chờ đăng nhập Facebook...</p>
                  <p className="text-[11px] text-sky-300/80 mt-0.5">
                    Tiện ích đã được cài tự động. Hãy đăng nhập và nhập PIN; CRM sẽ tự nhận tài khoản khi hoàn tất.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setAddingSession(false); setPendingKey(null); setInitialAccountIds(null); }}
                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium shrink-0 border border-slate-700/60 transition-colors"
              >
                Hủy
              </button>
            </div>
          )}

          {/* Kết nối Page Messenger */}
          <div className={'border-t border-slate-800 pt-4 space-y-3 ' + (!isCompanyAdmin ? 'hidden' : '')}>
            <div>
              <h4 className="text-xs font-semibold text-slate-100 uppercase tracking-wider">Kết nối Page Messenger</h4>
              <p className="text-[11px] text-slate-500 mt-1">Dán Link Page, ID Page, hoặc Page Access Token để kết nối. Không cần API token vì Extension sẽ lo việc gửi/nhận.</p>
            </div>
            <div className="grid gap-2">
              <select
                value={pageOwnerAccountId}
                onChange={(event) => setPageOwnerAccountId(event.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500/60"
              >
                <option value="">Không gắn owner account</option>
                {accounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.name || acc.id}</option>)}
              </select>
              <textarea
                value={pageToken}
                onChange={(event) => setPageToken(event.target.value)}
                rows={2}
                placeholder="Ví dụ: https://www.facebook.com/profile.php?id=123456789 hoặc 123456789"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60 resize-none"
              />
              {pageConnectError && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{pageConnectError}</div>}
              <button
                type="button"
                onClick={handleConnectPage}
                disabled={pageConnectLoading}
                className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
              >
                {pageConnectLoading ? <RefreshCw size={14} className="animate-spin" /> : <PlusCircle size={15} />}
                <span>Kết nối Page</span>
              </button>
            </div>
            <div className="space-y-2">
              {inboxSources.filter((source) => source.source_type === 'page_messenger').map((source) => (
                <div key={source.id} className="p-3 rounded-lg border border-violet-500/20 bg-violet-500/5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="relative w-9 h-9 shrink-0 overflow-hidden rounded-full bg-violet-500/20 text-violet-200 font-bold text-xs flex items-center justify-center border border-violet-500/30">
                      {(source.display_name || 'P').replace(/^Page\s*/i, '').charAt(0).toUpperCase()}
                      {source.avatar_url && <img src={source.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
                    </span>
                    <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-100 truncate">{source.display_name && !genericPageName.test(source.display_name) ? source.display_name : 'Page · ' + (source.display_name || source.external_id)}</div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">{source.external_id} · {source.status}</div>
                    </div>
                  </div>
                  <button type="button" onClick={() => handleDisconnectSource(source.id)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 border border-slate-700/60">Ngắt</button>
                </div>
              ))}
            </div>
          </div>

          {/* Danh sách tài khoản cá nhân */}
          {accountActionError && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {accountActionError}
            </div>
          )}
          {loading ? (
            <div className="py-8 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
              <RefreshCw size={14} className="animate-spin" /> Đang tải danh sách...
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-xs">
              {isCompanyAdmin
                ? 'Chưa có tài khoản Facebook kết nối. Bấm "+ Thêm tài khoản Facebook" để kết nối tài khoản đầu tiên.'
                : 'Admin doanh nghiệp chưa cấp tài khoản Facebook cho bạn.'}
            </div>
          ) : (
            <div className="space-y-2.5">
              {accounts.map((acc) => {
                const isCheckpoint = acc.status === 'CHECKPOINT';
                const isConnected = acc.is_extension_connected === true;
                const isChromeVisible = acc.is_chrome_running === true && acc.chrome_display_mode === 'VISIBLE';
                const isChangingDisplay = displayActionId === String(acc.id);
                return (
                  <div
                    key={acc.id}
                    className={`p-3.5 rounded-lg border ${
                      isCheckpoint ? 'bg-slate-950 border-red-500/40' : 'bg-slate-950 border-slate-800'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="relative w-10 h-10 shrink-0 overflow-hidden rounded-full bg-slate-800 text-slate-300 font-semibold text-xs flex items-center justify-center border border-slate-700/50">
                        {(acc.name || 'F').charAt(0).toUpperCase()}
                        {acc.avatar_url && <img src={acc.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-xs font-semibold text-slate-100 break-words">{acc.name || 'Tài khoản Facebook'}</h4>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5 break-all">ID: {acc.id}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              isConnected
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-slate-500/10 text-slate-400 border border-slate-500/20'
                            }`}
                          >
                            {isConnected ? 'Đã kết nối' : 'Chưa kết nối'}
                          </span>
                          {acc.is_chrome_running && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                              Chrome đang chạy
                            </span>
                          )}
                          {isCheckpoint && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                              Checkpoint / 2FA
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Monitor size={14} className={isChromeVisible ? 'text-sky-400' : 'text-slate-500'} />
                        <span className="text-[11px] text-slate-300">Hiện Chrome</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isChromeVisible}
                          aria-label={`${isChromeVisible ? 'Ẩn' : 'Hiện'} Chrome của ${acc.name || acc.id}`}
                          title={isChromeVisible ? 'OFF: Ẩn cửa sổ Chrome' : 'ON: Mở Chrome ra màn hình'}
                          onClick={() => handleChromeDisplayChange(acc, !isChromeVisible)}
                          disabled={isChangingDisplay || deletingId === acc.id}
                          className={`relative inline-flex h-6 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${
                            isChromeVisible
                              ? 'bg-sky-500 border-sky-400'
                              : 'bg-slate-800 border-slate-700'
                          }`}
                        >
                          <span className={`absolute text-[8px] font-bold ${isChromeVisible ? 'left-1 text-white' : 'right-1 text-slate-400'}`}>
                            {isChangingDisplay ? '...' : (isChromeVisible ? 'ON' : 'OFF')}
                          </span>
                          <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${isChromeVisible ? 'translate-x-7' : 'translate-x-1'}`} />
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                        <button
                          type="button"
                          onClick={() => handleStartChrome(acc.id)}
                          disabled={startingId === acc.id || deletingId === acc.id || isChangingDisplay}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors border disabled:opacity-50 ${
                            isCheckpoint
                              ? 'bg-red-600 hover:bg-red-500 text-white border-red-500'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700/60'
                          }`}
                        >
                          {startingId === acc.id ? <RefreshCw size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                          <span>{startingId === acc.id ? 'Đang kết nối...' : (isCompanyAdmin ? 'Kết nối Facebook' : 'Kết nối')}</span>
                        </button>
                        {isCompanyAdmin && <button
                          type="button"
                          onClick={() => handleDeleteAccount(acc)}
                          disabled={deletingId === acc.id || startingId === acc.id || isChangingDisplay}
                          aria-label={`Xóa tài khoản ${acc.name || acc.id}`}
                          title="Xóa tài khoản khỏi CRM"
                          className="p-1.5 rounded-md text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                        >
                          {deletingId === acc.id
                            ? <RefreshCw size={13} className="animate-spin" />
                            : <Trash2 size={13} />}
                        </button>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/40 text-right">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs font-medium transition-colors border border-slate-700/60"
          >
            Đóng
          </button>
        </div>
      </div>

      <ConfirmModal
        isOpen={Boolean(accountToDelete)}
        title="Xóa tài khoản Facebook"
        message={
          accountToDelete
            ? `Bạn có chắc chắn muốn xóa tài khoản "${accountToDelete.name || accountToDelete.id}" khỏi CRM?\n\n` +
              '• Hội thoại, tin nhắn và cấu hình riêng của tài khoản này sẽ bị xóa vĩnh viễn.\n' +
              '• Thư mục Chrome profile của tài khoản cũng sẽ được dọn dẹp khỏi máy tính.'
            : ''
        }
        confirmText="Xóa tài khoản"
        cancelText="Hủy"
        variant="danger"
        isLoading={Boolean(deletingId)}
        onConfirm={executeDeleteAccount}
        onClose={() => !deletingId && setAccountToDelete(null)}
      />
    </div>
  );
}
