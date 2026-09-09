import React, { useEffect, useState } from 'react';
import { Check, CheckSquare, ChevronRight, Eye, Plus, RefreshCw, Square, Trash2, UserPlus, Users, X } from 'lucide-react';

// Module-level cache: giữ data giữa các lần mount/unmount
let _cachedData = null;
let _cacheLoaded = false;

export default function EmployeeManagementModal() {
  const [data, setData] = useState(_cachedData || { employees: [], accounts: [], assignments: {} });
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!_cacheLoaded); // nếu đã có cache thì không cần loading
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [assigningEmployee, setAssigningEmployee] = useState(null);
  const [assignmentViewMode, setAssignmentViewMode] = useState('edit');

  // Multi-select state
  const [selected, setSelected] = useState(new Set());
  const [deletingBulk, setDeletingBulk] = useState(false);

  const load = async () => {
    const response = await fetch('/api/company/employees');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || 'Không tải được danh sách nhân viên.');
    }
    // Cập nhật cache module-level
    _cachedData = payload;
    _cacheLoaded = true;
    setData(payload);
    setSelected(new Set()); // clear selection on reload
  };

  useEffect(() => {
    if (_cacheLoaded) return; // đã có cache, không gọi lại API
    setLoading(true);
    load()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);

  // --- Selection helpers ---
  const allIds = data.employees.map((e) => e.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  };

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // --- Bulk delete ---
  const removeSelected = async () => {
    if (selected.size === 0) return;
    const names = data.employees
      .filter((e) => selected.has(e.id))
      .map((e) => e.username)
      .join(', ');
    if (!window.confirm(`Xóa ${selected.size} nhân viên: ${names}?`)) return;

    setDeletingBulk(true);
    setError('');
    try {
      await Promise.all(
        [...selected].map((id) =>
          fetch(`/api/company/employees/${id}`, { method: 'DELETE' }).then((r) => r.json())
        )
      );
      await load();
    } catch (bulkError) {
      setError(bulkError.message);
    } finally {
      setDeletingBulk(false);
    }
  };

  const create = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/company/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Không tạo được nhân viên.');
      }
      setForm({ username: '', password: '' });
      setShowCreate(false);
      await load();
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  const assign = async (employee, accountId) => {
    const accountIds = new Set((data.assignments?.[employee.id] || []).map(String));
    if (accountIds.has(String(accountId))) accountIds.delete(String(accountId));
    else accountIds.add(String(accountId));

    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/company/employees/${employee.id}/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: [...accountIds] })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Không lưu được phân quyền.');
      }
      await load();
    } catch (assignError) {
      setError(assignError.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (employee) => {
    if (!window.confirm(`Xóa nhân viên ${employee.username}?`)) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/company/employees/${employee.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Không xóa được nhân viên.');
      }
      await load();
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="employee-management-page col-start-2 col-end-[-1] row-start-1 h-full min-h-0 overflow-y-auto bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-blue-600">
            <Users size={22} />
          </span>
          <div>
            <h1 className="text-xl font-bold">Quản lý nhân viên</h1>
            <p className="mt-0.5 text-sm text-slate-500">Tạo tài khoản và cấp tài khoản Facebook cho từng nhân viên.</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 p-6">
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {/* Table header bar */}
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="font-semibold">Danh sách nhân viên</h2>
              <p className="mt-1 text-xs text-slate-500">Quản lý tài khoản đăng nhập và Facebook được phép sử dụng.</p>
            </div>
            <div className="flex items-center gap-2">
              {/* Bulk delete button — shown when something is selected */}
              {selected.size > 0 && (
                <button
                  type="button"
                  disabled={deletingBulk}
                  onClick={removeSelected}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  {deletingBulk
                    ? <RefreshCw size={16} className="animate-spin" />
                    : <Trash2 size={16} />}
                  Xóa {selected.size} nhân viên
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Plus size={18} /> Thêm nhân viên
              </button>
            </div>
          </div>

          {loading ? (
            <div className="grid min-h-52 place-items-center"><RefreshCw className="animate-spin text-blue-600" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    {/* Checkbox select-all column */}
                    <th className="w-12 px-4 py-3.5">
                      <button
                        type="button"
                        aria-label={allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                        onClick={toggleAll}
                        disabled={!allIds.length}
                        className="flex items-center justify-center text-slate-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                      >
                        {allSelected
                          ? <CheckSquare size={18} className="text-blue-600" />
                          : someSelected
                            ? <span className="relative flex h-[18px] w-[18px] items-center justify-center rounded border-2 border-blue-400 bg-white">
                                <span className="h-[8px] w-[8px] rounded-sm bg-blue-500" />
                              </span>
                            : <Square size={18} />}
                      </button>
                    </th>
                    <th className="w-14 px-3 py-3.5">STT</th>
                    <th className="px-5 py-3.5">Tên đăng nhập</th>
                    <th className="px-5 py-3.5">Tài khoản Facebook đã gán</th>
                    <th className="w-52 px-5 py-3.5">Gán tài khoản FB</th>
                    <th className="w-28 px-5 py-3.5 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.employees.map((employee, index) => {
                    const isChecked = selected.has(employee.id);
                    return (
                      <tr
                        key={employee.id}
                        className={`align-top transition-colors ${isChecked ? 'bg-blue-50/60' : 'hover:bg-slate-50/70'}`}
                      >
                        {/* Row checkbox */}
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            aria-label={`Chọn ${employee.username}`}
                            onClick={() => toggleOne(employee.id)}
                            className="flex items-center justify-center text-slate-400 hover:text-blue-600 transition-colors"
                          >
                            {isChecked
                              ? <CheckSquare size={18} className="text-blue-600" />
                              : <Square size={18} />}
                          </button>
                        </td>
                        <td className="px-3 py-4 text-sm text-slate-500">{index + 1}</td>
                        <td className="px-5 py-4">
                          <strong className="text-sm text-slate-900">{employee.username}</strong>
                          <span className="mt-1 block text-xs text-slate-500">Nhân viên</span>
                        </td>
                        <td className="px-5 py-4">
                          <button
                            type="button"
                            title="Xem danh sách tài khoản Facebook đã gán"
                            onClick={() => { setAssignmentViewMode('view'); setAssigningEmployee(employee); }}
                            className="group inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                          >
                            <Eye size={15} className="text-blue-600" />
                            {(data.assignments?.[employee.id] || []).length
                              ? `Xem ${(data.assignments?.[employee.id] || []).length} tài khoản`
                              : 'Chưa gán tài khoản'}
                            <ChevronRight size={14} className="text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-600" />
                          </button>
                        </td>
                        <td className="px-5 py-4">
                          <button
                            type="button"
                            onClick={() => { setAssignmentViewMode('edit'); setAssigningEmployee(employee); }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                          >
                            <Plus size={15} /> Gán tài khoản
                          </button>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            title="Xóa nhân viên"
                            aria-label={`Xóa nhân viên ${employee.username}`}
                            disabled={busy || deletingBulk}
                            onClick={() => remove(employee)}
                            className="inline-grid h-9 w-9 place-items-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!data.employees.length && (
                    <tr><td colSpan="6" className="px-5 py-16 text-center text-sm text-slate-500">Chưa có nhân viên. Bấm "Thêm nhân viên" để tạo tài khoản đầu tiên.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Selection info bar */}
          {selected.size > 0 && (
            <div className="flex items-center justify-between border-t border-slate-200 bg-blue-50 px-5 py-3">
              <span className="text-sm text-blue-700 font-medium">
                Đã chọn <strong>{selected.size}</strong> / {data.employees.length} nhân viên
              </span>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-blue-600 hover:underline"
              >
                Bỏ chọn tất cả
              </button>
            </div>
          )}
        </section>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-slate-950/50 p-4" onMouseDown={(event) => event.target === event.currentTarget && setShowCreate(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="create-employee-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="flex items-center gap-2.5"><UserPlus size={20} className="text-blue-600" /><h2 id="create-employee-title" className="font-bold">Tạo tài khoản nhân viên</h2></div>
              <button type="button" aria-label="Đóng" onClick={() => setShowCreate(false)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
            </header>
            <form onSubmit={create} className="space-y-4 p-5">
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">Tên đăng nhập<input autoFocus required minLength={3} maxLength={32} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="Nhập tên đăng nhập" className="rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /></label>
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">Mật khẩu<input required minLength={8} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Tối thiểu 8 ký tự" className="rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /></label>
              <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Hủy</button><button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{busy ? <RefreshCw size={16} className="animate-spin" /> : <UserPlus size={16} />} Tạo nhân viên</button></div>
            </form>
          </section>
        </div>
      )}

      {assigningEmployee && (
        <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-slate-950/50 p-4" onMouseDown={(event) => event.target === event.currentTarget && setAssigningEmployee(null)}>
          <section role="dialog" aria-modal="true" aria-labelledby="assign-facebook-title" className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h2 id="assign-facebook-title" className="font-bold">{assignmentViewMode === 'view' ? 'Tài khoản Facebook đã gán' : 'Gán tài khoản Facebook'}</h2>
                <p className="mt-1 text-xs text-slate-500">Nhân viên: <strong className="text-slate-700">{assigningEmployee.username}</strong></p>
              </div>
              <button type="button" aria-label="Đóng" onClick={() => setAssigningEmployee(null)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
            </header>
            <div className="max-h-[55vh] space-y-2 overflow-y-auto p-5">
              {data.accounts.filter((account) => assignmentViewMode !== 'view' || (data.assignments?.[assigningEmployee.id] || []).map(String).includes(String(account.id))).map((account) => {
                const checked = (data.assignments?.[assigningEmployee.id] || []).map(String).includes(String(account.id));
                return (
                  <label key={account.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ${assignmentViewMode === 'edit' ? 'cursor-pointer' : ''} ${checked ? 'border-blue-300 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                    <input className="sr-only" type="checkbox" checked={checked} disabled={busy || assignmentViewMode === 'view'} onChange={() => assign(assigningEmployee, account.id)} />
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'}`}>{checked && <Check size={13} />}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{account.name || `FB Account (${account.id})`}</span>
                    {busy && <RefreshCw size={14} className="animate-spin text-blue-600" />}
                  </label>
                );
              })}
              {(assignmentViewMode === 'view' ? !(data.assignments?.[assigningEmployee.id] || []).length : !data.accounts.length) && <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">{assignmentViewMode === 'view' ? 'Nhân viên này chưa được gán tài khoản Facebook.' : 'Công ty chưa có tài khoản Facebook để gán.'}</div>}
            </div>
            <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4">
              <span className="text-xs text-slate-500">Đã chọn {(data.assignments?.[assigningEmployee.id] || []).length} tài khoản</span>
              <button type="button" onClick={() => setAssigningEmployee(null)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Xong</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
