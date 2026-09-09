import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Search, Zap, Megaphone, Cpu, UserCheck, Users, ShieldAlert, ChevronLeft, ChevronRight, Sun, Moon, Phone, Key, CreditCard, LogOut } from 'lucide-react';
import { SIDEBAR_CLOSE_DELAY_MS, shouldKeepSidebarExpanded } from '../utils/appSidebarPresentation.js';

const ICON_SIZE = 18;
const ICON_STROKE = 1.75;
const BTN_SIZE = 36;

function supportsPointerHover() {
  return typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(hover: hover)').matches;
}

export default function AppSidebar({ activeView, onSelectView, onOpenModal, theme, onToggleTheme, hasCheckpoint = false, collapsed = false, onToggleCollapse, sessionUser, onLogout }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const sidebarRef = useRef(null);
  const closeTimerRef = useRef(null);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);

  const isCompanyAdmin = sessionUser?.company_role !== 'EMPLOYEE';

  const navItems = [
    { id: 'chat', label: 'Hội thoại', icon: MessageSquare },
    { id: 'search', label: 'Tìm kiếm', icon: Search, isModal: true },
    { id: 'autoReply', label: 'Tự động hóa', icon: Zap, isModal: true },
    { id: 'campaigns', label: 'Chiến dịch', icon: Megaphone, isModal: true },
    { id: 'aiConfig', label: 'Cài đặt AI', icon: Cpu, isModal: true },
    { id: 'phoneAutomation', label: 'Tự động số điện thoại', icon: Phone, isModal: true },
  ];

  if (isCompanyAdmin) {
    navItems.push(
      { id: 'license', label: 'Bản quyền Key', icon: Key, isModal: true },
      { id: 'payment', label: 'Mua License', icon: CreditCard, isModal: true }
    );
  }

  navItems.push({ id: 'accounts', label: 'Quản lý', icon: UserCheck, isModal: true });

  if (isCompanyAdmin) {
    navItems.push({ id: 'employees', label: 'Nhân viên', icon: Users });
  }

  const cancelScheduledCollapse = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const keepExpanded = () => shouldKeepSidebarExpanded({
    pointerInside: pointerInsideRef.current,
    focusInside: focusInsideRef.current
  });

  const scheduleCollapse = () => {
    cancelScheduledCollapse();
    if (keepExpanded()) return;
    closeTimerRef.current = window.setTimeout(() => {
      if (!keepExpanded()) setIsExpanded(false);
      closeTimerRef.current = null;
    }, SIDEBAR_CLOSE_DELAY_MS);
  };

  useEffect(() => () => cancelScheduledCollapse(), []);

  const handlePointerEnter = () => {
    if (!supportsPointerHover()) return;
    pointerInsideRef.current = true;
    cancelScheduledCollapse();
    setIsExpanded(true);
  };

  const handlePointerLeave = () => {
    if (!supportsPointerHover()) return;
    pointerInsideRef.current = false;
    scheduleCollapse();
  };

  const handleFocusCapture = () => {
    focusInsideRef.current = true;
    cancelScheduledCollapse();
    setIsExpanded(true);
  };

  const handleBlurCapture = () => {
    window.requestAnimationFrame(() => {
      if (!sidebarRef.current?.contains(document.activeElement)) {
        focusInsideRef.current = false;
        scheduleCollapse();
      }
    });
  };

  const activeClass = 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:bg-[var(--color-accent)] before:rounded-r';
  const idleClass = 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]';

  return (
    <aside
      ref={sidebarRef}
      className={'app-sidebar-shell ' + (isExpanded ? 'is-expanded' : '')}
      aria-label="Điều hướng chính"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      <div className="app-sidebar-surface">
        <div className="app-sidebar-brand">
          <div className="app-sidebar-logo">FB</div>
          <div className="app-sidebar-label app-sidebar-brand-copy" aria-hidden={!isExpanded}>
            <strong>MISSPRICE CRM</strong>
            <span>Facebook workspace</span>
          </div>
        </div>

        <nav className="app-sidebar-nav" aria-label="Chức năng CRM">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = !item.isModal && activeView === item.id;
            const isCheckpointBtn = item.id === 'accounts' && hasCheckpoint;
            return (
              <button
                key={item.id}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (item.isModal) {
                    onOpenModal?.(item.id);
                  } else {
                    onSelectView?.(item.id);
                  }
                }}
                title={isExpanded ? undefined : item.label}
                aria-label={item.label}
                style={{ minWidth: BTN_SIZE, minHeight: BTN_SIZE }}
                className={'app-sidebar-nav-item group relative flex items-center rounded-lg linear-transition cursor-pointer select-none ' + (isActive ? activeClass : idleClass)}
              >
                {isCheckpointBtn
                  ? <ShieldAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0 text-[var(--color-danger)]" />
                  : <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" />}
                <span className="app-sidebar-label" aria-hidden={!isExpanded}>{item.label}</span>
                {isCheckpointBtn && <span className="app-sidebar-checkpoint-dot" aria-label="Có cảnh báo cần xử lý" />}
                <span role="tooltip" className="app-sidebar-tooltip">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="app-sidebar-bottom">
          <button
            type="button"
            onClick={onToggleTheme}
            title={isExpanded ? undefined : 'Giao diện (' + (theme === 'dark' ? 'Sáng' : 'Tối') + ')'}
            aria-label={'Giao diện (' + (theme === 'dark' ? 'Sáng' : 'Tối') + ')'}
            style={{ minWidth: BTN_SIZE, minHeight: BTN_SIZE }}
            className="app-sidebar-control"
          >
            {theme === 'dark'
              ? <Sun size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0 text-[var(--color-warning)]" />
              : <Moon size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" />}
            <span className="app-sidebar-label" aria-hidden={!isExpanded}>Giao diện</span>
          </button>

          <div title={sessionUser?.username || 'Tài khoản'} className="app-sidebar-account">
            <span className="app-sidebar-account-avatar">{String(sessionUser?.username || 'U').slice(0, 2).toUpperCase()}</span>
            <span className="app-sidebar-label" aria-hidden={!isExpanded}>{sessionUser?.username || 'Tài khoản'}</span>
          </div>

          <button type="button" onClick={onLogout} title={isExpanded ? undefined : 'Đăng xuất'} aria-label="Đăng xuất" style={{ minWidth: BTN_SIZE, minHeight: BTN_SIZE }} className="app-sidebar-control">
            <LogOut size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" />
            <span className="app-sidebar-label" aria-hidden={!isExpanded}>Đăng xuất</span>
          </button>

          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={isExpanded ? undefined : (collapsed ? 'Mở rộng bảng Lead' : 'Thu gọn bảng Lead')}
              aria-label={collapsed ? 'Mở rộng bảng Lead' : 'Thu gọn bảng Lead'}
              style={{ minWidth: BTN_SIZE, minHeight: BTN_SIZE }}
              className="app-sidebar-control"
            >
              {collapsed ? <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" /> : <ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" />}
              <span className="app-sidebar-label" aria-hidden={!isExpanded}>{collapsed ? 'Mở rộng bảng Lead' : 'Thu gọn bảng Lead'}</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
