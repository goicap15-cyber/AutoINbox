import React, { useState, useEffect, useMemo } from 'react';
import { X, RefreshCw, ExternalLink, Check, CheckSquare, Square, Search, Flag, Layers, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function PageSelectorModal({ account, onClose, onSourcesChanged, socket }) {
  const accountId = String(account?.id || '');
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [opening, setOpening] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Load danh sách Fanpage từ backend
  const loadPages = async () => {
    if (!accountId) return;
    try {
      setErrorMsg('');
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/pages`);
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.pages)) {
        setPages(data.pages);
        // Mặc định chọn các page chưa kết nối hoặc tất cả nếu chưa có trang nào kết nối
        const preSelected = new Set();
        data.pages.forEach((p) => {
          if (p.is_connected) {
            preSelected.add(String(p.page_id));
          }
        });
        setSelectedIds(preSelected);
      } else {
        setErrorMsg(data.error || 'Không thể tải danh sách Fanpage');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Lỗi kết nối khi tải danh sách Fanpage');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPages();
  }, [accountId]);

  // Lắng nghe realtime sự kiện PAGES_DISCOVERED từ Socket.io
  useEffect(() => {
    if (!socket) return;
    const handleDiscovered = (data) => {
      if (String(data?.account_id) === accountId && Array.isArray(data?.pages)) {
        console.log('[PageSelector] Nhận PAGES_DISCOVERED từ socket:', data.pages.length);
        loadPages();
        setRefreshing(false);
        setSuccessMsg(`Đã phát hiện ${data.pages.length} Fanpage từ Facebook.`);
        setTimeout(() => setSuccessMsg(''), 4000);
      }
    };
    socket.on('PAGES_DISCOVERED', handleDiscovered);
    return () => {
      socket.off('PAGES_DISCOVERED', handleDiscovered);
    };
  }, [socket, accountId]);

  // Bộ đếm countdown cooldown nút quét lại
  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setInterval(() => {
      setRefreshCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [refreshCooldown]);

  // Xử lý bấm nút "Quét lại"
  const handleRefresh = async () => {
    if (refreshCooldown > 0 || refreshing) return;
    setErrorMsg('');
    setSuccessMsg('');
    setRefreshing(true);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/pages/refresh`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Không thể gửi yêu cầu quét lại');
      }
      setRefreshCooldown(10);
      setSuccessMsg('Đang gửi lệnh quét tới Chrome... Vui lòng đợi trong giây lát.');
    } catch (err) {
      setErrorMsg(err.message);
      setRefreshing(false);
    }
  };

  // Toggle chọn 1 page
  const handleToggleSelect = (pageId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
  };

  // Lọc theo từ khóa tìm kiếm
  const filteredPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((p) =>
      String(p.name || '').toLowerCase().includes(q) ||
      String(p.page_id || '').toLowerCase().includes(q) ||
      String(p.category || '').toLowerCase().includes(q)
    );
  }, [pages, searchQuery]);

  // Toggle chọn tất cả
  const allFilteredSelected = useMemo(() => {
    if (filteredPages.length === 0) return false;
    return filteredPages.every((p) => selectedIds.has(String(p.page_id)));
  }, [filteredPages, selectedIds]);

  const handleToggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredPages.forEach((p) => next.delete(String(p.page_id)));
      } else {
        filteredPages.forEach((p) => next.add(String(p.page_id)));
      }
      return next;
    });
  };

  // Xử lý bấm "Mở các Page đã chọn"
  const handleBatchOpen = async () => {
    const idsToOpen = Array.from(selectedIds);
    if (idsToOpen.length === 0) {
      setErrorMsg('Vui lòng chọn ít nhất 1 Fanpage để mở.');
      return;
    }
    setErrorMsg('');
    setOpening(true);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/pages/batch-open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_ids: idsToOpen })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Không thể mở các Fanpage đã chọn');
      }
      onSourcesChanged?.();
      await loadPages();
      let msg = `Đã mở thành công ${data.opened_count} Fanpage trong Chrome và tích hợp vào CRM!`;
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        msg += ` (${data.errors.length} page bị bỏ qua: ${data.errors.slice(0, 2).join(' | ')}${data.errors.length > 2 ? '...' : ''})`;
      }
      setSuccessMsg(msg);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setErrorMsg(err.message || 'Lỗi khi mở các Fanpage');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-[var(--color-bg-panel,#0f1b2b)] border border-[var(--color-border,#284057)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative w-9 h-9 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-elevated,#172b42)] border border-[var(--color-border,#284057)] flex items-center justify-center text-xs font-bold text-[var(--color-text-primary,#f8fafc)]">
              {(account?.name || 'F').charAt(0).toUpperCase()}
              {account?.avatar_url && (
                <img
                  src={account.avatar_url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-[var(--color-text-primary,#f8fafc)] truncate">
                  Fanpage của {account?.name || 'tài khoản Facebook'}
                </h3>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-bg-elevated,#172b42)] text-[var(--color-text-muted,#7f95aa)] border border-[var(--color-border,#284057)]">
                  {account?.id}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted,#7f95aa)] truncate mt-0.5">
                Chọn các Fanpage bạn muốn mở tab quản lý và đồng bộ vào CRM
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted,#7f95aa)] hover:text-[var(--color-text-primary,#f8fafc)] p-1.5 rounded-lg hover:bg-[var(--color-bg-elevated,#172b42)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Toolbar & Search */}
        <div className="px-5 py-3 border-b border-[var(--color-border,#284057)] bg-[var(--color-bg-panel,#0f1b2b)] flex items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted,#7f95aa)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo tên Page hoặc ID..."
              className="w-full bg-[var(--color-bg-surface,#132235)] border border-[var(--color-border,#284057)] rounded-xl pl-8 pr-3 py-1.5 text-xs text-[var(--color-text-primary,#f8fafc)] placeholder:text-[var(--color-text-muted,#7f95aa)] focus:outline-none focus:border-[var(--color-accent,#0ea5e9)] transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshCooldown > 0 || refreshing}
            className="px-3 py-1.5 bg-[var(--color-bg-surface,#132235)] hover:bg-[var(--color-bg-elevated,#172b42)] disabled:opacity-50 text-xs font-medium text-[var(--color-text-primary,#f8fafc)] border border-[var(--color-border,#284057)] rounded-xl flex items-center gap-1.5 transition-colors shrink-0"
            title="Quét lại danh sách Fanpage từ tài khoản Facebook này"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin text-[var(--color-accent,#0ea5e9)]' : ''} />
            <span>
              {refreshing
                ? 'Đang quét...'
                : refreshCooldown > 0
                ? `Quét lại (${refreshCooldown}s)`
                : 'Quét lại'}
            </span>
          </button>
        </div>

        {/* Sub-header: Select All & Counters */}
        <div className="px-5 py-2.5 bg-[var(--color-bg-panel,#0f1b2b)]/50 border-b border-[var(--color-border,#284057)] flex items-center justify-between text-xs text-[var(--color-text-muted,#7f95aa)]">
          <button
            type="button"
            onClick={handleToggleSelectAll}
            disabled={filteredPages.length === 0}
            className="flex items-center gap-2 hover:text-[var(--color-text-primary,#f8fafc)] transition-colors disabled:opacity-40"
          >
            {allFilteredSelected ? (
              <CheckSquare size={15} className="text-[var(--color-accent,#0ea5e9)]" />
            ) : (
              <Square size={15} className="text-[var(--color-text-muted,#7f95aa)]" />
            )}
            <span className="font-semibold">
              {allFilteredSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
            </span>
          </button>

          <span className="font-mono">
            Đã chọn <strong className="text-[var(--color-accent,#0ea5e9)] font-semibold">{selectedIds.size}</strong>/{pages.length} trang
          </span>
        </div>

        {/* Messages */}
        {errorMsg && (
          <div className="mx-5 mt-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="mx-5 mt-3 p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400 flex items-center gap-2">
            <CheckCircle2 size={15} className="shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Page List */}
        <div className="p-5 overflow-y-auto space-y-2 flex-1 max-h-[50vh]">
          {loading ? (
            <div className="py-12 text-center text-xs text-[var(--color-text-muted,#7f95aa)] flex flex-col items-center justify-center gap-3">
              <RefreshCw size={20} className="animate-spin text-[var(--color-accent,#0ea5e9)]" />
              <span>Đang tải danh sách Fanpage từ hệ thống...</span>
            </div>
          ) : filteredPages.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--color-text-muted,#7f95aa)] flex flex-col items-center justify-center gap-2">
              <Layers size={28} className="opacity-30 mb-1" />
              <p className="font-medium text-[var(--color-text-secondary,#cbd5e1)]">
                {searchQuery ? 'Không tìm thấy Fanpage nào khớp với từ khóa.' : 'Chưa phát hiện Fanpage nào cho tài khoản này.'}
              </p>
              {!searchQuery && (
                <p className="max-w-xs text-[11px] opacity-75">
                  Hãy đảm bảo tài khoản đã đăng nhập trong Chrome và bấm nút <strong>"Quét lại"</strong> ở trên để cập nhật danh sách trang.
                </p>
              )}
            </div>
          ) : (
            filteredPages.map((p) => {
              const isSelected = selectedIds.has(String(p.page_id));
              const isConnected = Boolean(p.is_connected);

              return (
                <div
                  key={p.page_id}
                  onClick={() => handleToggleSelect(String(p.page_id))}
                  className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center gap-3.5 select-none ${
                    isSelected
                      ? 'bg-[var(--color-accent-subtle,rgba(14,165,233,0.1))] border-[var(--color-accent,#0ea5e9)]/50 shadow-sm'
                      : 'bg-[var(--color-bg-surface,#132235)] border-[var(--color-border,#284057)] hover:border-[var(--color-border,#284057)]/80'
                  }`}
                >
                  {/* Checkbox */}
                  <div className="shrink-0">
                    {isSelected ? (
                      <div className="w-5 h-5 rounded-md bg-[var(--color-accent,#0ea5e9)] text-white flex items-center justify-center">
                        <Check size={14} strokeWidth={3} />
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-md border border-[var(--color-border,#284057)] bg-[var(--color-bg-elevated,#172b42)]" />
                    )}
                  </div>

                  {/* Page Avatar */}
                  <div className="relative w-10 h-10 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-elevated,#172b42)] border border-[var(--color-border,#284057)] flex items-center justify-center text-xs font-bold text-[var(--color-text-primary,#f8fafc)]">
                    {(p.name || 'P').charAt(0).toUpperCase()}
                    {p.avatar_url && (
                      <img
                        src={p.avatar_url}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[var(--color-text-primary,#f8fafc)] truncate">
                        {p.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--color-text-muted,#7f95aa)]">
                      <span className="font-mono">ID: {p.page_id}</span>
                      <span>•</span>
                      <span className="truncate">{p.category || 'Trang Facebook'}</span>
                    </div>
                  </div>

                  {/* Status Badge */}
                  <div className="shrink-0">
                    {isConnected ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        Đang hoạt động
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
                        Chưa mở
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-[var(--color-border,#284057)] bg-[var(--color-bg-surface,#132235)] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={opening}
            className="px-4 py-2 bg-[var(--color-bg-elevated,#172b42)] hover:bg-[var(--color-bg-panel,#0f1b2b)] text-[var(--color-text-secondary,#cbd5e1)] rounded-xl text-xs font-semibold transition-colors border border-[var(--color-border,#284057)]"
          >
            Đóng
          </button>

          <button
            type="button"
            onClick={handleBatchOpen}
            disabled={opening || selectedIds.size === 0}
            className="px-4 py-2 bg-[var(--color-accent,#0ea5e9)] hover:bg-[var(--color-accent-hover,#38bdf8)] disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-md active:scale-98"
          >
            {opening ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                <span>Đang mở các tab Business Suite...</span>
              </>
            ) : (
              <>
                <ExternalLink size={14} />
                <span>Mở {selectedIds.size} Page đã chọn</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
