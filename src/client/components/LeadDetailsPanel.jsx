import React, { useState, useEffect, useRef } from 'react';
import {
  Phone,
  Mail,
  Download,
  FileSpreadsheet,
  Activity,
  Star,
  Bell,
  Archive,
  X,
  UserRound,
  MapPin,
  Link2,
  MessageCircle,
  Trash2,
  User,
  Tag,
  FileText,
  Clock,
  Plus,
  Check
} from 'lucide-react';
import EmptyState from './EmptyState.jsx';
import LeadStatusColorPicker from './LeadStatusColorPicker.jsx';
import { ConfirmDialog, Toast } from './CrmFeedback.jsx';
import { getStatusBadgeStyle } from '../utils/color.js';
import {
  STARTER_TAGS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_CONTACT,
  parseTags,
  hasTag,
  validateTag,
  addTag,
  removeTag,
  toggleTag,
  areTagsEqual
} from '../utils/tags.js';
import { parseCustomFields, addCustomField, removeCustomField } from '../utils/customFields.js';

const AVATAR_COLORS = ['#2684ff', '#a855f7', '#0fbd74', '#ec4899', '#ff6b2c', '#00b8a9', '#6366f1', '#ff3b4f'];

function pickAvatarColor(value) {
  const text = String(value || 'K');
  const total = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function pickInitials(name) {
  const parts = String(name || 'K').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'K';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toDateTimeLocal(value) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function SectionTitle({ icon: Icon, children, action }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-[var(--color-text-primary)]">
        {Icon && <Icon size={16} strokeWidth={1.8} className="text-[var(--color-text-muted)]" />}
        {children}
      </h3>
      {action}
    </div>
  );
}

function Divider() {
  return <div className="h-2 bg-[var(--color-bg-surface)] -mx-4 my-4" />;
}

function DetailRow({ icon: Icon, label, value, children }) {
  return (
    <div className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors">
      <Icon size={16} strokeWidth={1.8} className="text-[var(--color-text-muted)] shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[var(--color-text-muted)] mb-0.5">{label}</p>
        {children || (
          <p className={`text-sm truncate ${value && value !== 'Chưa có' ? 'font-semibold text-[var(--color-text-primary)]' : 'italic text-[var(--color-text-muted)]'}`}>
            {value}
          </p>
        )}
      </div>
    </div>
  );
}

function formatCaptureDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('vi-VN');
}

const PHONE_SOURCE_LABELS = {
  manual: 'Nhập tay',
  message_capture: 'Tin nhắn khách gửi',
  legacy: 'Dữ liệu cũ'
};

function HistoryLine({ label, value, mono = false, success = false }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]">
      <span>{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${success ? 'text-[var(--color-success)] font-medium' : 'text-[var(--color-text-secondary)]'} truncate`}>{value}</span>
    </div>
  );
}

function ExportFooter({ onExportLeads }) {
  const btnClass = 'flex-1 h-8 flex items-center justify-center gap-1.5 bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] text-xs font-medium rounded-xl transition-colors border border-[var(--color-border)]';
  return (
    <div className="flex gap-2">
      <button type="button" onClick={() => onExportLeads?.('excel')} className={`${btnClass} text-[var(--color-success)]`}>
        <FileSpreadsheet size={13} strokeWidth={1.75} /> Excel
      </button>
      <button type="button" onClick={() => onExportLeads?.('csv')} className={`${btnClass} text-[var(--color-text-secondary)]`}>
        <Download size={13} strokeWidth={1.75} /> CSV
      </button>
    </div>
  );
}

export default function LeadDetailsPanel({ contactInfo, onSaveContact, onExportLeads, onCloseDrawer, leadStatuses = [], onCreateLeadStatus, onDeleteLeadStatus, onSetReminder, onCompleteReminder, onCancelReminder, onArchiveThread }) {
  const [activeTab, setActiveTab] = useState('INFO');
  const [nickname, setNickname] = useState('');
  const [phone, setPhone] = useState('');
  const [acceptingPhoneCandidateId, setAcceptingPhoneCandidateId] = useState(null);
  const [phoneCandidateError, setPhoneCandidateError] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [statusId, setStatusId] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [notice, setNotice] = useState(null);
  const [isReminderEditorOpen, setIsReminderEditorOpen] = useState(false);
  const [reminderDueAt, setReminderDueAt] = useState(() => toDateTimeLocal());
  const [reminderNote, setReminderNote] = useState('');
  const [reminderError, setReminderError] = useState('');
  const [savingReminder, setSavingReminder] = useState(false);
  const [showCreateStatus, setShowCreateStatus] = useState(false);
  const [newStatusName, setNewStatusName] = useState('');
  const [newStatusColor, setNewStatusColor] = useState('#2684FF');
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [creatingStatus, setCreatingStatus] = useState(false);
  const [createStatusError, setCreateStatusError] = useState('');
  const colorTriggerRef = useRef(null);

  // Tags state (Spec 028)
  const [committedTags, setCommittedTags] = useState(() => parseTags(contactInfo?.tags));
  const [draftTags, setDraftTags] = useState([]);
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false);
  const [customTagInput, setCustomTagInput] = useState('');
  const [tagError, setTagError] = useState('');
  const [tagSaveError, setTagSaveError] = useState('');
  const [vipSaveError, setVipSaveError] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const tagOpenerRef = useRef(null);
  const tagInputRef = useRef(null);
  const activeTagContactRef = useRef('');
  const tagOperationRef = useRef(0);

  // Custom detail fields state ("+ Thêm chi tiết")
  const [committedCustomFields, setCommittedCustomFields] = useState(() => parseCustomFields(contactInfo?.custom_fields));
  const [showAddDetail, setShowAddDetail] = useState(false);
  const [newDetailLabel, setNewDetailLabel] = useState('');
  const [newDetailValue, setNewDetailValue] = useState('');
  const [customFieldError, setCustomFieldError] = useState('');
  const [savingCustomFields, setSavingCustomFields] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const successTimerRef = useRef(null);

  // A tag-save response may only update the customer for which it started.
  const currentTagContactKey = contactInfo?.thread_id == null ? '' : String(contactInfo.thread_id);
  if (activeTagContactRef.current !== currentTagContactKey) {
    activeTagContactRef.current = currentTagContactKey;
    tagOperationRef.current += 1;
  }

  useEffect(() => {
    if (!contactInfo) return;
    setNickname(contactInfo.nickname || '');
    setPhone(contactInfo.phone || '');
    setAcceptingPhoneCandidateId(null);
    setPhoneCandidateError('');
    setEmail(contactInfo.email || '');
    setAddress(contactInfo.address || '');
    setNotes(contactInfo.notes || '');
    setLeadCaptured(Boolean(contactInfo.lead_captured));
    setStatusId(contactInfo.status_id != null ? Number(contactInfo.status_id) : null);
    setShowCreateStatus(false);
    setNewStatusName('');
    setNewStatusColor('#2684FF');
    setIsColorPickerOpen(false);
    setCreatingStatus(false);
    setCreateStatusError('');
    setConfirmation(null);
    setNotice(null);
    setIsReminderEditorOpen(false);
    setReminderDueAt(toDateTimeLocal(contactInfo.reminder_due_at));
    setReminderNote(contactInfo.reminder_note || '');
    setReminderError('');
    setSavingReminder(false);

    // Tags sync & reset on contact switch
    setCommittedTags(parseTags(contactInfo.tags));
    setDraftTags([]);
    setIsTagEditorOpen(false);
    setCustomTagInput('');
    setTagError('');
    setTagSaveError('');
    setVipSaveError('');
    setSavingTags(false);

    // Custom detail fields sync & reset on contact switch
    setCommittedCustomFields(parseCustomFields(contactInfo.custom_fields));
    setShowAddDetail(false);
    setNewDetailLabel('');
    setNewDetailValue('');
    setCustomFieldError('');
    setSavingCustomFields(false);
  }, [
    contactInfo?.thread_id,
    contactInfo?.nickname,
    contactInfo?.phone,
    contactInfo?.email,
    contactInfo?.address,
    contactInfo?.notes,
    contactInfo?.lead_captured,
    contactInfo?.status_id,
    contactInfo?.reminder_due_at,
    contactInfo?.reminder_note,
    contactInfo?.tags,
    contactInfo?.custom_fields
  ]);

  useEffect(() => () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
  }, []);

  const currentStatus = leadStatuses.find((s) => s.id === statusId) || null;

  const savePayload = (override = {}) => ({
    ...contactInfo,
    nickname,
    phone,
    email,
    address,
    notes,
    tags: committedTags,
    lead_captured: leadCaptured,
    status_id: statusId,
    custom_fields: committedCustomFields,
    ...override
  });

  const handleToggleTag = async (tagToToggle, fromVipQuickAction = false) => {
    if (savingTags) return;
    const previousTags = [...committedTags];
    const toggleResult = toggleTag(committedTags, tagToToggle);
    if (toggleResult.error) {
      setTagSaveError(toggleResult.error);
      if (fromVipQuickAction) setVipSaveError(toggleResult.error);
      return;
    }
    if (areTagsEqual(previousTags, toggleResult.tags)) return;

    const operationId = tagOperationRef.current + 1;
    tagOperationRef.current = operationId;
    setCommittedTags(toggleResult.tags);
    setTagSaveError('');
    if (fromVipQuickAction) setVipSaveError('');
    setSavingTags(true);
    try {
      await onSaveContact?.(savePayload({ tags: toggleResult.tags }));
    } catch (err) {
      if (tagOperationRef.current === operationId) {
        const message = 'Không thể lưu thay đổi nhãn. Vui lòng thử lại.';
        setCommittedTags(previousTags);
        setTagSaveError(message);
        if (fromVipQuickAction) setVipSaveError(message);
      }
    } finally {
      if (tagOperationRef.current === operationId) {
        setSavingTags(false);
      }
    }
  };

  const handleOpenTagEditor = (openerElement) => {
    tagOpenerRef.current = openerElement || null;
    setDraftTags([...committedTags]);
    setCustomTagInput('');
    setTagError('');
    setTagSaveError('');
    setIsTagEditorOpen(true);
    setTimeout(() => {
      tagInputRef.current?.focus();
    }, 50);
  };

  const handleCloseTagEditor = () => {
    setIsTagEditorOpen(false);
    setDraftTags([]);
    setCustomTagInput('');
    setTagError('');
    setTagSaveError('');
    if (tagOpenerRef.current && typeof tagOpenerRef.current.focus === 'function') {
      setTimeout(() => {
        try {
          tagOpenerRef.current?.focus();
        } catch (_) {}
      }, 0);
    }
  };

  const handleAddCustomField = async () => {
    if (savingCustomFields) return;
    const previous = committedCustomFields;
    const result = addCustomField(committedCustomFields, { label: newDetailLabel, value: newDetailValue });
    if (result.error) {
      setCustomFieldError(result.error);
      return;
    }
    setCommittedCustomFields(result.fields);
    setCustomFieldError('');
    setSavingCustomFields(true);
    try {
      await onSaveContact?.(savePayload({ custom_fields: result.fields }));
      setShowAddDetail(false);
      setNewDetailLabel('');
      setNewDetailValue('');
    } catch (err) {
      setCommittedCustomFields(previous);
      setCustomFieldError('Không thể lưu trường chi tiết. Vui lòng thử lại.');
    } finally {
      setSavingCustomFields(false);
    }
  };

  const handleRemoveCustomField = async (indexToRemove) => {
    if (savingCustomFields) return;
    const previous = committedCustomFields;
    const updated = removeCustomField(committedCustomFields, indexToRemove);
    setCommittedCustomFields(updated);
    setSavingCustomFields(true);
    try {
      await onSaveContact?.(savePayload({ custom_fields: updated }));
    } catch (err) {
      setCommittedCustomFields(previous);
      setCustomFieldError('Không thể xóa trường chi tiết. Vui lòng thử lại.');
    } finally {
      setSavingCustomFields(false);
    }
  };

  const handleCancelAddDetail = () => {
    setShowAddDetail(false);
    setNewDetailLabel('');
    setNewDetailValue('');
    setCustomFieldError('');
  };

  const handleAddDraftTag = () => {
    const trimmed = customTagInput.trim();
    if (!trimmed) {
      setTagError('Tên nhãn không được để trống.');
      return;
    }
    const result = addTag(draftTags, trimmed);
    if (result.error) {
      setTagError(result.error);
      return;
    }
    setDraftTags(result.tags);
    setCustomTagInput('');
    setTagError('');
  };

  const handleRemoveDraftTag = (tagToRemove) => {
    const updated = removeTag(draftTags, tagToRemove);
    setDraftTags(updated);
    setTagError('');
  };

  const handleApplyDraftTags = async () => {
    if (savingTags) return;
    if (areTagsEqual(committedTags, draftTags)) {
      handleCloseTagEditor();
      return;
    }

    const previousTags = [...committedTags];
    setCommittedTags(draftTags);
    setSavingTags(true);
    setTagSaveError('');
    try {
      await onSaveContact?.(savePayload({ tags: draftTags }));
      handleCloseTagEditor();
    } catch (err) {
      setCommittedTags(previousTags);
      setTagSaveError('Lưu nhãn thất bại. Vui lòng thử lại.');
    } finally {
      setSavingTags(false);
    }
  };

  const handleCreateStatus = async () => {
    const name = newStatusName.trim();
    if (!name || creatingStatus) return;
    setCreatingStatus(true);
    setCreateStatusError('');
    try {
      const created = await onCreateLeadStatus?.(name, newStatusColor);
      if (created?.id == null) {
        setCreateStatusError('Không thể tạo trạng thái. Vui lòng thử lại.');
        return;
      }
      setStatusId(Number(created.id));
      setShowCreateStatus(false);
      setNewStatusName('');
      setNewStatusColor('#2684FF');
      setIsColorPickerOpen(false);
    } finally {
      setCreatingStatus(false);
    }
  };

  const handleDeleteStatus = () => {
    if (!currentStatus) return;
    const deletingStatus = currentStatus;
    setConfirmation({
      tone: 'danger',
      title: 'Xóa trạng thái?',
      description: `Các hội thoại đang dùng “${deletingStatus.name}” sẽ chuyển về “Chưa đặt”. Thao tác này không thể hoàn tác.`,
      confirmLabel: 'Xóa trạng thái',
      onConfirm: async () => {
        const success = await onDeleteLeadStatus?.(deletingStatus.id);
        if (!success) throw new Error('Không thể xóa trạng thái. Vui lòng thử lại.');
        setStatusId(null);
        setNotice({ tone: 'success', message: 'Đã xóa trạng thái.' });
      }
    });
  };

  const handleToggleLead = async () => {
    const updated = !leadCaptured;
    setLeadCaptured(updated);
    await onSaveContact?.(savePayload({ lead_captured: updated }));
  };

  // spec 035: a deliberate accept action for a dated phone candidate. Sends
  // phone_capture_id so the server resolves and adopts that exact capture's
  // normalized value/provenance (never a free-text phone edit) - the local
  // optimistic update mirrors what the server will do, since onSaveContact
  // commits the payload object as-is rather than the server's response.
  const handleAcceptPhoneCandidate = async (candidate) => {
    if (acceptingPhoneCandidateId) return;
    setAcceptingPhoneCandidateId(candidate.id);
    setPhoneCandidateError('');
    try {
      await onSaveContact?.(savePayload({
        phone: candidate.normalized_phone,
        phone_capture_id: candidate.id,
        phone_source: 'message_capture',
        phone_captured_at: Number(candidate.message_timestamp_ms) > 0
          ? new Date(Number(candidate.message_timestamp_ms)).toISOString()
          : candidate.detected_at
      }));
      setPhone(candidate.normalized_phone);
    } catch (err) {
      setPhoneCandidateError(err?.message || 'Không thể chọn số điện thoại này. Vui lòng thử lại.');
    } finally {
      setAcceptingPhoneCandidateId(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      await onSaveContact?.(savePayload());
      setSaveSuccess(true);
      successTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (!contactInfo) {
    return (
      <div className="w-[var(--lead-panel-width)] bg-[var(--color-bg-panel)] border-l border-[var(--color-border)] flex flex-col h-full shrink-0 select-none">
        <div className="h-[var(--header-height)] border-b border-[var(--color-border)] px-4 flex items-center justify-between shrink-0">
          <h3 className="font-bold text-[var(--color-text-primary)] text-base">Thông tin khách hàng</h3>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <EmptyState icon={UserRound} title="Chưa chọn hội thoại" description="Chọn một hội thoại để xem thông tin khách hàng." />
        </div>
        <ExportFooter onExportLeads={onExportLeads} />
      </div>
    );
  }

  const facebookName = contactInfo.name || contactInfo.contact_name || 'Khách hàng';
  const name = nickname.trim() || facebookName;
  const nameInitials = pickInitials(name);
  const avatarColor = pickAvatarColor(contactInfo.thread_id || name);
  const accountText = contactInfo.account_name || contactInfo.account_id || 'FB Account';

  const openReminderEditor = () => {
    setReminderDueAt(toDateTimeLocal(contactInfo.reminder_due_at));
    setReminderNote(contactInfo.reminder_note || '');
    setReminderError('');
    setIsReminderEditorOpen(true);
  };

  const closeReminderEditor = () => {
    setIsReminderEditorOpen(false);
    setReminderError('');
  };

  const handleSaveReminder = async () => {
    const dueAt = new Date(reminderDueAt);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
      setReminderError('Hãy chọn thời điểm ở tương lai.');
      return;
    }
    setSavingReminder(true);
    setReminderError('');
    try {
      await onSetReminder?.(contactInfo.thread_id, dueAt.toISOString(), reminderNote);
      closeReminderEditor();
    } catch (error) {
      setReminderError(error.message || 'Không thể lưu nhắc. Vui lòng thử lại.');
    } finally {
      setSavingReminder(false);
    }
  };

  const handleCompleteReminder = async () => {
    setSavingReminder(true);
    setReminderError('');
    try {
      await onCompleteReminder?.(contactInfo.thread_id);
      closeReminderEditor();
    } catch (error) {
      setReminderError(error.message || 'Không thể hoàn thành nhắc.');
    } finally {
      setSavingReminder(false);
    }
  };

  const handleCancelReminder = () => {
    setConfirmation({
      tone: 'danger',
      title: 'Hủy lời nhắc?',
      description: 'Lời nhắc này sẽ không còn xuất hiện trong danh sách chăm sóc.',
      confirmLabel: 'Hủy lời nhắc',
      onConfirm: async () => {
        await onCancelReminder?.(contactInfo.thread_id);
        closeReminderEditor();
        setNotice({ tone: 'success', message: 'Đã hủy lời nhắc.' });
      }
    });
  };

  const archiveThread = async (restore) => {
    try {
      await onArchiveThread?.(contactInfo.thread_id, restore);
      setNotice({ tone: 'success', message: restore ? 'Đã khôi phục hội thoại vào Inbox.' : 'Đã lưu trữ hội thoại.' });
    } catch (error) {
      setNotice({ tone: 'error', message: error.message || 'Không thể cập nhật lưu trữ.' });
    }
  };

  const handleArchiveAction = () => {
    const restore = Boolean(contactInfo.archived_at);
    if (restore) {
      archiveThread(true);
      return;
    }
    setConfirmation({
      tone: 'primary',
      title: 'Lưu trữ hội thoại?',
      description: 'Tin nhắn và thông tin khách vẫn được giữ nguyên. Hội thoại sẽ được ẩn khỏi Inbox cho đến khi khôi phục hoặc khách nhắn tin mới.',
      confirmLabel: 'Lưu trữ',
      onConfirm: () => archiveThread(false)
    });
  };

  const isVip = hasTag(committedTags, 'VIP');
  const quickActions = [
    { icon: Phone, label: 'Gọi', className: 'text-[var(--color-success)] bg-[var(--color-success-subtle)]' },
    { icon: Star, label: 'VIP', className: 'text-[var(--color-warning)] bg-[var(--color-warning-subtle)]' },
    { id: 'reminder', icon: Bell, label: 'Nhắc', className: 'text-[var(--color-accent)] bg-[var(--color-accent-subtle)]' },
    { id: 'archive', icon: Archive, label: contactInfo.archived_at ? 'Khôi phục' : 'Lưu', className: 'text-[var(--color-text-secondary)] bg-[var(--color-bg-surface)]' }
  ];

  return (
    <div className="w-[var(--lead-panel-width)] bg-[var(--color-bg-panel)] border-l border-[var(--color-border)] flex flex-col h-full shrink-0 select-none">
      {/* Header banner */}
      <div className="relative h-16 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 shrink-0">
        <div className="absolute inset-0 opacity-20 bg-gradient-to-t from-black to-transparent" />
        <span className="absolute top-3 left-4 text-[11px] font-semibold text-white tracking-wide uppercase opacity-90">
          Thông tin khách hàng
        </span>
        {onCloseDrawer && (
          <button
            onClick={onCloseDrawer}
            title="Đóng"
            aria-label="Đóng"
            className="absolute top-2 right-2 w-7 h-7 inline-flex items-center justify-center hover:bg-white/20 rounded-full transition-colors text-white"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* Avatar + name + chips, overlapping the banner */}
      <div className="relative px-4 pb-3 -mt-8 text-center shrink-0">
        <div className="inline-block p-1 bg-[var(--color-bg-panel)] rounded-full shadow-lg">
          {contactInfo.avatar_url ? (
            <img
              src={String(contactInfo.avatar_url).startsWith('http') ? contactInfo.avatar_url : `/api/avatars/${contactInfo.avatar_url}`}
              alt=""
              className="w-14 h-14 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-[var(--color-text-on-accent)] text-lg font-bold select-none"
              style={{ backgroundColor: avatarColor }}
            >
              {nameInitials}
            </div>
          )}
        </div>

        <h4 className="mt-2 font-bold text-[var(--color-text-primary)] text-base leading-tight truncate">{name}</h4>

        <div className="mt-1.5 flex items-center justify-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={handleToggleLead}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-success)] transition-colors"
            title="Đổi trạng thái thu thập liên hệ"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${leadCaptured ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
            {leadCaptured ? 'Đã bóc tách liên hệ' : 'Chưa có liên hệ'}
          </button>
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${!currentStatus ? 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)]' : ''}`}
            style={currentStatus ? getStatusBadgeStyle(currentStatus.color) : undefined}
          >
            {currentStatus ? currentStatus.name : 'Chưa đặt trạng thái'}
          </span>
        </div>

        <div className="mt-1.5 flex items-center justify-center gap-1 text-xs text-[var(--color-text-muted)]">
          <MessageCircle size={12} strokeWidth={1.8} className="text-[var(--color-accent)]" />
          Facebook Messenger
        </div>
      </div>

      {/* Quick actions */}
      <div className="px-4 pb-3 border-b border-[var(--color-border)] shrink-0">
        <div className="grid grid-cols-4 gap-2">
          {quickActions.map((action) => {
            const Icon = action.icon;
            const isVipAction = action.label === 'VIP';
            const vipLabel = isVip
              ? 'Bỏ đánh dấu VIP cho khách hàng'
              : 'Đánh dấu khách hàng là VIP';
            const actionClassName = isVipAction && isVip
              ? 'text-[var(--color-warning)] bg-[var(--color-warning-subtle)] ring-2 ring-[var(--color-warning)]/35 shadow-sm'
              : action.className;

            return (
              <button
                key={action.label}
                type="button"
                onClick={isVipAction ? () => handleToggleTag('VIP', true) : action.id === 'reminder' ? openReminderEditor : action.id === 'archive' ? handleArchiveAction : undefined}
                disabled={isVipAction ? savingTags : undefined}
                aria-pressed={isVipAction ? isVip : undefined}
                aria-busy={isVipAction ? savingTags : undefined}
                aria-label={isVipAction ? (savingTags ? 'Đang lưu nhãn VIP' : vipLabel) : action.label}
                title={isVipAction ? vipLabel : undefined}
                className={[
                  'py-2.5 flex flex-col items-center justify-center gap-1 rounded-xl transition-all',
                  actionClassName,
                  isVipAction
                    ? 'cursor-pointer hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg-panel)] disabled:opacity-60 disabled:cursor-wait'
                    : 'hover:opacity-80'
                ].join(' ')}
              >
                <span className="relative inline-flex">
                  <Icon
                    size={16}
                    strokeWidth={1.8}
                    fill={isVipAction && isVip ? 'currentColor' : 'none'}
                  />
                  {isVipAction && isVip && (
                    <Check
                      size={9}
                      strokeWidth={3}
                      className="absolute -right-2 -bottom-1 rounded-full bg-[var(--color-bg-panel)] p-px"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="text-xs font-semibold">{isVipAction && savingTags ? 'Đang lưu' : action.label}</span>
              </button>
            );
          })}
        </div>
        {isReminderEditorOpen && (
          <div className="mt-3 rounded-xl border border-[var(--color-accent)]/25 bg-[var(--color-accent-subtle)]/45 p-3" role="group" aria-label="Thiết lập lời nhắc">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-primary)]"><Bell size={14} className="text-[var(--color-accent)]" /> {contactInfo.reminder_due_at ? 'Chỉnh sửa lời nhắc' : 'Tạo lời nhắc'}</p>
              <button type="button" onClick={closeReminderEditor} disabled={savingReminder} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-black/5" aria-label="Đóng form nhắc"><X size={14} /></button>
            </div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)]">Thời điểm nhắc
              <input type="datetime-local" value={reminderDueAt} onChange={(event) => setReminderDueAt(event.target.value)} disabled={savingReminder} className="mt-1.5 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-panel)] px-2 text-xs text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/25" />
            </label>
            <label className="mt-2 block text-xs font-medium text-[var(--color-text-secondary)]">Ghi chú <span className="font-normal text-[var(--color-text-muted)]">(không bắt buộc)</span>
              <input type="text" value={reminderNote} onChange={(event) => setReminderNote(event.target.value)} maxLength={200} disabled={savingReminder} placeholder="Ví dụ: Gọi lại hỏi nhu cầu" className="mt-1.5 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-panel)] px-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/25" />
            </label>
            {reminderError && <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{reminderError}</p>}
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {contactInfo.reminder_due_at && <><button type="button" onClick={handleCancelReminder} disabled={savingReminder} className="h-8 rounded-lg border border-[var(--color-border)] px-2.5 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] disabled:opacity-60">Hủy nhắc</button><button type="button" onClick={handleCompleteReminder} disabled={savingReminder} className="h-8 rounded-lg border border-[var(--color-success)]/25 bg-[var(--color-success-subtle)] px-2.5 text-xs font-semibold text-[var(--color-success)] disabled:opacity-60">Hoàn thành</button></>}
              <button type="button" onClick={handleSaveReminder} disabled={savingReminder} className="h-8 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-bold text-[var(--color-text-on-accent)] hover:opacity-90 disabled:opacity-60">{savingReminder ? 'Đang lưu…' : 'Lưu nhắc'}</button>
            </div>
          </div>
        )}
        {vipSaveError && !isTagEditorOpen && (
          <div role="alert" className="mt-2 px-2.5 py-2 rounded-lg bg-[var(--color-danger-subtle)] text-[var(--color-danger)] text-xs flex items-center justify-between gap-2">
            <span>{vipSaveError}</span>
            <button
              type="button"
              onClick={() => setVipSaveError('')}
              className="p-1 rounded hover:bg-black/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
              aria-label="Đóng thông báo lỗi nhãn"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-3 gap-1 bg-[var(--color-bg-surface)] p-1 mx-4 mt-3 rounded-xl shrink-0">
        {[
          { id: 'INFO', label: 'Thông tin' },
          { id: 'NOTES', label: 'Ghi chú' },
          { id: 'HISTORY', label: 'Lịch sử' }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`h-8 text-xs font-bold rounded-lg transition-colors ${
              activeTab === tab.id
                ? 'bg-[var(--color-bg-panel)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-4">
          {activeTab === 'INFO' && (
            <>
              <SectionTitle icon={User}>Chi tiết liên hệ</SectionTitle>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Bổ sung chi tiết về người liên hệ này.</p>
              <div>
                <DetailRow icon={MessageCircle} label="Nguồn" value="Facebook Messenger" />
                <DetailRow icon={Link2} label="Tài khoản" value={accountText} />
                <DetailRow icon={UserRound} label="Biệt danh trong CRM">
                  <input
                    type="text"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value.slice(0, 80))}
                    maxLength={80}
                    placeholder={facebookName}
                    aria-label="Biệt danh trong CRM"
                    className="w-full bg-transparent text-[var(--color-text-primary)] text-sm font-semibold focus:outline-none placeholder:italic placeholder:font-normal placeholder:text-[var(--color-text-muted)]"
                  />
                  <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Chỉ hiển thị trong CRM, không đổi tên trên Messenger.</p>
                </DetailRow>
                <DetailRow icon={Phone} label="Số điện thoại">
                  <input
                    type="text"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="Chưa có"
                    className="w-full bg-transparent text-[var(--color-text-primary)] text-sm font-semibold focus:outline-none placeholder:italic placeholder:font-normal placeholder:text-[var(--color-text-muted)] font-mono"
                  />
                  {contactInfo.phone_source && (
                    <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {PHONE_SOURCE_LABELS[contactInfo.phone_source] || contactInfo.phone_source}
                      {contactInfo.phone_captured_at ? ` · ${formatCaptureDate(contactInfo.phone_captured_at)}` : ''}
                    </p>
                  )}
                </DetailRow>

                {Array.isArray(contactInfo.phone_candidates) && contactInfo.phone_candidates.length > 0 && (
                  <div className="ml-9 mt-1 mb-2 space-y-1.5">
                    <p className="text-[11px] text-[var(--color-text-muted)]">Số khác khách đã nhắn:</p>
                    {contactInfo.phone_candidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--color-bg-surface)] border border-[var(--color-border)]"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-mono font-semibold text-[var(--color-text-primary)] truncate">{candidate.normalized_phone}</p>
                          <p className="text-[11px] text-[var(--color-text-muted)] truncate">{formatCaptureDate(candidate.message_timestamp_ms || candidate.detected_at)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAcceptPhoneCandidate(candidate)}
                          disabled={acceptingPhoneCandidateId != null}
                          className="shrink-0 h-7 px-2.5 rounded-lg text-xs font-semibold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {acceptingPhoneCandidateId === candidate.id ? 'Đang chọn…' : 'Chọn'}
                        </button>
                      </div>
                    ))}
                    {phoneCandidateError && (
                      <p role="alert" className="text-[11px] text-[var(--color-danger)]">{phoneCandidateError}</p>
                    )}
                  </div>
                )}

                <DetailRow icon={Mail} label="Email">
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Chưa có"
                    className="w-full bg-transparent text-[var(--color-text-primary)] text-sm font-semibold focus:outline-none placeholder:italic placeholder:font-normal placeholder:text-[var(--color-text-muted)] font-mono"
                  />
                </DetailRow>
                <DetailRow icon={MapPin} label="Địa chỉ">
                  <input
                    type="text"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="Nhập địa chỉ khách hàng"
                    autoComplete="street-address"
                    className="w-full bg-transparent text-[var(--color-text-primary)] text-sm font-semibold focus:outline-none placeholder:italic placeholder:font-normal placeholder:text-[var(--color-text-muted)]"
                  />
                </DetailRow>
                {committedCustomFields.map((field, idx) => (
                  <DetailRow key={`${field.label}-${idx}`} icon={FileText} label={field.label}>
                    <div className="flex items-center gap-2">
                      <p className={`flex-1 min-w-0 truncate text-sm ${field.value ? 'font-semibold text-[var(--color-text-primary)]' : 'italic text-[var(--color-text-muted)]'}`}>
                        {field.value || 'Chưa có'}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleRemoveCustomField(idx)}
                        disabled={savingCustomFields}
                        title={`Xóa trường "${field.label}"`}
                        aria-label={`Xóa trường "${field.label}"`}
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                  </DetailRow>
                ))}
              </div>

              {!showAddDetail && (
                <button
                  type="button"
                  onClick={() => { setShowAddDetail(true); setCustomFieldError(''); }}
                  className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
                >
                  <Plus size={16} strokeWidth={1.8} />
                  Thêm chi tiết
                </button>
              )}

              {showAddDetail && (
                <div className="mt-2 space-y-2.5 p-3 rounded-xl bg-[var(--color-bg-surface)] border border-[var(--color-border)]">
                  <input
                    type="text"
                    value={newDetailLabel}
                    onChange={(event) => {
                      setNewDetailLabel(event.target.value);
                      if (customFieldError) setCustomFieldError('');
                    }}
                    placeholder="Tên trường (vd: Công ty, Ngày sinh...)"
                    aria-label="Tên trường"
                    aria-invalid={Boolean(customFieldError)}
                    className="w-full bg-transparent text-sm text-[var(--color-text-primary)] focus:outline-none placeholder:text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-1.5"
                  />
                  <input
                    type="text"
                    value={newDetailValue}
                    onChange={(event) => {
                      setNewDetailValue(event.target.value);
                      if (customFieldError) setCustomFieldError('');
                    }}
                    placeholder="Giá trị"
                    aria-label="Giá trị"
                    className="w-full bg-transparent text-sm text-[var(--color-text-primary)] focus:outline-none placeholder:text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-1.5"
                  />

                  {customFieldError && (
                    <p role="alert" className="text-[11px] text-[var(--color-danger)]">
                      {customFieldError}
                    </p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleAddCustomField}
                      disabled={!newDetailLabel.trim() || savingCustomFields}
                      className="flex-1 h-7 rounded-lg text-xs font-semibold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                    >
                      {savingCustomFields ? 'Đang thêm…' : 'Thêm'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAddDetail}
                      className="flex-1 h-7 rounded-lg text-xs font-semibold bg-[var(--color-bg-panel)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer transition-colors"
                    >
                      Hủy
                    </button>
                  </div>
                </div>
              )}

              <Divider />

              <SectionTitle
                icon={Activity}
                action={
                  !showCreateStatus && (
                    <button type="button" onClick={() => { setShowCreateStatus(true); setCreateStatusError(''); }} className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded">
                      + Tạo trạng thái mới
                    </button>
                  )
                }
              >
                Trạng thái
              </SectionTitle>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Theo dõi giai đoạn chăm sóc của khách hàng.</p>

              <div className="flex items-center gap-1.5">
                <select
                  value={statusId ?? ''}
                  onChange={(event) => setStatusId(event.target.value ? Number(event.target.value) : null)}
                  className="flex-1 min-w-0 bg-[var(--color-bg-panel)] text-[var(--color-text-primary)] text-sm font-semibold focus:outline-none cursor-pointer rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] transition-colors"
                >
                  <option value="" className="bg-[var(--color-bg-panel)] text-[var(--color-text-primary)]">Chưa đặt</option>
                  {leadStatuses.map((s) => (
                    <option key={s.id} value={s.id} className="bg-[var(--color-bg-panel)] text-[var(--color-text-primary)]">{s.name}</option>
                  ))}
                </select>
                {currentStatus && (
                  <button
                    type="button"
                    onClick={handleDeleteStatus}
                    title={`Xóa trạng thái "${currentStatus.name}"`}
                    aria-label={`Xóa trạng thái "${currentStatus.name}"`}
                    className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] transition-colors"
                  >
                    <Trash2 size={14} strokeWidth={1.8} />
                  </button>
                )}
              </div>

              {showCreateStatus && (
                <div className="mt-2 space-y-2.5 p-3 rounded-xl bg-[var(--color-bg-surface)] border border-[var(--color-border)]">
                  <input
                    type="text"
                    value={newStatusName}
                    onChange={(event) => {
                      setNewStatusName(event.target.value);
                      if (createStatusError) setCreateStatusError('');
                    }}
                    placeholder="Tên trạng thái mới"
                    aria-label="Tên trạng thái mới"
                    aria-invalid={Boolean(createStatusError)}
                    className="w-full bg-transparent text-sm text-[var(--color-text-primary)] focus:outline-none placeholder:text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-1.5"
                  />
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        ref={colorTriggerRef}
                        type="button"
                        onClick={() => setIsColorPickerOpen((prev) => !prev)}
                        aria-label={`Chọn màu cho trạng thái (Hiện tại: ${newStatusColor})`}
                        aria-expanded={isColorPickerOpen}
                        className="h-8 px-2.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-panel)] hover:bg-[var(--color-bg-hover)] text-xs font-semibold text-[var(--color-text-primary)] transition-colors cursor-pointer"
                      >
                        <span
                          className="w-4 h-4 rounded-full border border-black/10 dark:border-white/10 shadow-sm shrink-0"
                          style={{ backgroundColor: newStatusColor }}
                        />
                        <span className="font-mono text-xs font-bold">{newStatusColor}</span>
                      </button>
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        Đổi màu
                      </span>
                    </div>
                  </div>

                  {isColorPickerOpen && (
                    <LeadStatusColorPicker
                      value={newStatusColor}
                      onApply={(appliedColor) => {
                        setNewStatusColor(appliedColor);
                        setIsColorPickerOpen(false);
                      }}
                      onCancel={() => {
                        setIsColorPickerOpen(false);
                      }}
                      triggerRef={colorTriggerRef}
                    />
                  )}

                  {createStatusError && (
                    <p role="alert" className="text-[11px] text-[var(--color-danger)]">
                      {createStatusError}
                    </p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleCreateStatus}
                      disabled={!newStatusName.trim() || creatingStatus}
                      className="flex-1 h-7 rounded-lg text-xs font-semibold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                    >
                      {creatingStatus ? 'Đang tạo…' : 'Tạo'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCreateStatus(false);
                        setNewStatusName('');
                        setNewStatusColor('#2684FF');
                        setIsColorPickerOpen(false);
                        setCreatingStatus(false);
                        setCreateStatusError('');
                      }}
                      className="flex-1 h-7 rounded-lg text-xs font-semibold bg-[var(--color-bg-panel)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-pointer transition-colors"
                    >
                      Hủy
                    </button>
                  </div>
                </div>
              )}

              <Divider />

              <SectionTitle
                icon={Tag}
                action={
                  <button
                    type="button"
                    onClick={(e) => handleOpenTagEditor(e.currentTarget)}
                    aria-label="Quản lý nhãn khách hàng"
                    className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] rounded"
                  >
                    Quản lý nhãn
                  </button>
                }
              >
                Nhãn
              </SectionTitle>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">
                Sắp xếp hộp thư bằng cách gắn nhãn khách hàng (chọn nhiều).
              </p>

              {tagSaveError && !isTagEditorOpen && (
                <div role="alert" className="mb-2 p-2 rounded-lg bg-[var(--color-danger-subtle)] text-[var(--color-danger)] text-xs flex items-center justify-between">
                  <span>{tagSaveError}</span>
                  <button type="button" onClick={() => setTagSaveError('')} className="p-1 hover:opacity-80 cursor-pointer">
                    <X size={12} />
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 items-center">
                {/* 1. Starter tags as interactive toggle buttons */}
                {STARTER_TAGS.map((starterTag) => {
                  const isSelected = hasTag(committedTags, starterTag);
                  return (
                    <button
                      key={starterTag}
                      type="button"
                      onClick={() => handleToggleTag(starterTag)}
                      aria-pressed={isSelected}
                      disabled={savingTags}
                      aria-label={`${isSelected ? 'Bỏ chọn' : 'Chọn'} nhãn ${starterTag}`}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer border ${
                        isSelected
                          ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[var(--color-accent)]/30 shadow-xs ring-1 ring-[var(--color-accent)]/20'
                          : 'bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {isSelected ? (
                        <Check size={12} strokeWidth={2.5} className="shrink-0" />
                      ) : (
                        <Tag size={12} strokeWidth={1.75} className="text-[var(--color-text-muted)] shrink-0" />
                      )}
                      <span>{starterTag}</span>
                    </button>
                  );
                })}

                {/* 2. Custom/Legacy tags outside starter list */}
                {committedTags
                  .filter((t) => !STARTER_TAGS.some((st) => st.toLowerCase() === t.toLowerCase()))
                  .map((customTag) => (
                    <button
                      key={customTag}
                      type="button"
                      onClick={() => handleToggleTag(customTag)}
                      aria-pressed="true"
                      disabled={savingTags}
                      aria-label={`Bỏ chọn nhãn ${customTag}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success)]/30 shadow-xs ring-1 ring-[var(--color-success)]/20 hover:opacity-80 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Check size={12} strokeWidth={2.5} className="shrink-0" />
                      <span className="truncate max-w-[120px]">{customTag}</span>
                    </button>
                  ))}

                {/* 3. Add custom tag button */}
                <button
                  type="button"
                  onClick={(e) => handleOpenTagEditor(e.currentTarget)}
                  disabled={savingTags}
                  aria-label="Thêm nhãn mới"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] bg-[var(--color-bg-panel)] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Plus size={12} strokeWidth={2} />
                  <span>Thêm</span>
                </button>
              </div>

              {/* Inline Tags Editor */}
              {isTagEditorOpen && (
                <div
                  role="dialog"
                  aria-label="Chỉnh sửa nhãn khách hàng"
                  className="mt-2.5 p-3 rounded-xl bg-[var(--color-bg-surface)] border border-[var(--color-border)] shadow-md space-y-3 select-none"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--color-text-primary)] flex items-center gap-1.5">
                      <Tag size={13} className="text-[var(--color-accent)]" />
                      Chỉnh sửa nhãn ({draftTags.length}/{MAX_TAGS_PER_CONTACT})
                    </span>
                    <button
                      type="button"
                      onClick={handleCloseTagEditor}
                      aria-label="Đóng bảng chỉnh sửa nhãn"
                      className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer"
                    >
                      <X size={13} />
                    </button>
                  </div>

                  {/* Selected tags with remove controls */}
                  <div>
                    <p className="text-[11px] text-[var(--color-text-muted)] mb-1.5">Nhãn đang gắn:</p>
                    {draftTags.length === 0 ? (
                      <p className="text-xs italic text-[var(--color-text-muted)] py-1">Chưa có nhãn nào được chọn.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
                        {draftTags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-panel)] border border-[var(--color-border)] text-[var(--color-text-primary)] shadow-xs"
                          >
                            <span className="truncate max-w-[130px]">{tag}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveDraftTag(tag)}
                              aria-label={`Xóa nhãn ${tag}`}
                              title={`Xóa nhãn ${tag}`}
                              className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] transition-colors cursor-pointer"
                            >
                              <X size={10} strokeWidth={2.5} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Input to add new custom tag */}
                  <div className="space-y-1.5 pt-1 border-t border-[var(--color-border)]">
                    <label htmlFor="custom-tag-input" className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      Thêm nhãn tùy chỉnh
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        id="custom-tag-input"
                        ref={tagInputRef}
                        type="text"
                        value={customTagInput}
                        onChange={(e) => {
                          setCustomTagInput(e.target.value);
                          setTagError('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddDraftTag();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            handleCloseTagEditor();
                          }
                        }}
                        maxLength={MAX_TAG_LENGTH}
                        placeholder="Tên nhãn (tối đa 40 ký tự)"
                        className="flex-1 min-w-0 bg-[var(--color-bg-panel)] text-xs text-[var(--color-text-primary)] px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
                      />
                      <button
                        type="button"
                        onClick={handleAddDraftTag}
                        disabled={!customTagInput.trim() || draftTags.length >= MAX_TAGS_PER_CONTACT}
                        className="h-7 px-2.5 inline-flex items-center gap-1 text-xs font-semibold rounded-lg bg-[var(--color-bg-panel)] hover:bg-[var(--color-bg-hover)] text-[var(--color-accent)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      >
                        <Plus size={13} strokeWidth={2} />
                        Thêm
                      </button>
                    </div>
                  </div>

                  {/* Error message */}
                  {(tagError || tagSaveError) && (
                    <p role="alert" className="text-[11px] text-[var(--color-danger)] font-medium">
                      {tagError || tagSaveError}
                    </p>
                  )}

                  {/* Action buttons: Áp dụng & Hủy */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleApplyDraftTags}
                      disabled={savingTags}
                      className="flex-1 h-7 inline-flex items-center justify-center gap-1 text-xs font-semibold rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {savingTags ? 'Đang lưu...' : 'Áp dụng'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCloseTagEditor}
                      disabled={savingTags}
                      className="flex-1 h-7 inline-flex items-center justify-center text-xs font-semibold rounded-lg bg-[var(--color-bg-panel)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] transition-colors cursor-pointer disabled:opacity-50"
                    >
                      Hủy
                    </button>
                  </div>
                </div>
              )}

              <Divider />

              <SectionTitle
                icon={FileText}
                action={<button type="button" onClick={() => setActiveTab('NOTES')} className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">+ Thêm</button>}
              >
                Ghi chú
              </SectionTitle>
              <div className="mt-2 bg-[var(--color-warning-subtle)] border border-[var(--color-warning)]/20 rounded-lg p-3">
                <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  {notes || 'Khách quan tâm sản phẩm. Cần ghi chú nhu cầu, báo giá và lịch chăm sóc.'}
                </p>
                <p className="mt-1.5 text-xs text-[var(--color-warning)] font-medium">Gần đây</p>
              </div>
            </>
          )}

          {activeTab === 'NOTES' && (
            <div className="space-y-2.5">
              <SectionTitle icon={FileText}>Ghi chú chăm sóc</SectionTitle>
              <p className="text-xs text-[var(--color-text-muted)]">Nhu cầu, sản phẩm quan tâm, báo giá, lịch hẹn chăm sóc...</p>
              <textarea
                rows={8}
                placeholder="Nhập ghi chú..."
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="w-full bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] text-xs p-3.5 rounded-xl border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] resize-none placeholder:text-[var(--color-text-muted)] leading-relaxed min-h-[180px]"
              />
            </div>
          )}

          {activeTab === 'HISTORY' && (
            <div className="space-y-2.5">
              <SectionTitle icon={Clock}>Lịch sử tương tác</SectionTitle>
              <p className="text-xs text-[var(--color-text-muted)] mb-1">Theo dõi những lượt tương tác quan trọng của khách hàng.</p>
              <div>
                <HistoryLine label="Thread ID" value={contactInfo.thread_id} mono />
                <HistoryLine label="Nguồn" value="Facebook Messenger" />
                <HistoryLine label="Bóc tách liên hệ" value={leadCaptured ? 'Thành công' : 'Chưa có'} success={leadCaptured} />
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        title={confirmation?.title || ''}
        description={confirmation?.description || ''}
        confirmLabel={confirmation?.confirmLabel}
        tone={confirmation?.tone}
        onClose={() => setConfirmation(null)}
        onConfirm={async () => {
          try {
            await confirmation?.onConfirm?.();
            setConfirmation(null);
          } catch (error) {
            setConfirmation(null);
            setNotice({ tone: 'error', message: error.message || 'Thao tác không thành công. Vui lòng thử lại.' });
          }
        }}
      />
      <Toast notice={notice} onDismiss={() => setNotice(null)} />

      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-panel)] shrink-0 p-3.5 space-y-2.5">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={`w-full h-9.5 rounded-xl text-xs font-semibold transition-colors ${
            saveSuccess
              ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success)]/30'
              : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 text-[var(--color-text-on-accent)] shadow-sm'
          }`}
        >
          {saving ? 'Đang lưu...' : saveSuccess ? 'Đã cập nhật' : 'Lưu thông tin'}
        </button>
        <ExportFooter onExportLeads={onExportLeads} />
      </div>
    </div>
  );
}
