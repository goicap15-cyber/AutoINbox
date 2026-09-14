import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Image, Paperclip, Smile, FileText, Loader2, AlertCircle, WifiOff, ThumbsUp, Plus, Trash2, RefreshCw } from 'lucide-react';
import EmojiPickerPopover from './EmojiPickerPopover.jsx';
import AttachmentPreview from './AttachmentPreview.jsx';

export default function MessageComposer({
  onSendMessage,
  onStageAttachment,
  onDiscardAttachment,
  capabilities = null,
  senderIdentity = null,
  disabled = false,
  disabledReason = 'Không thể gửi - tài khoản Facebook chưa kết nối'
}) {
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState(null);
  const [isAddingTemplate, setIsAddingTemplate] = useState(false);
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [removingAttachment, setRemovingAttachment] = useState(false);
  const [draggingAttachment, setDraggingAttachment] = useState(false);
  const textareaRef = useRef(null);
  const emojiButtonRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const dragDepthRef = useRef(0);
  const restoreFocusAfterSendRef = useRef(false);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplateLoadError(null);
      const res = await fetch('/api/quick-templates');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setTemplates(data);
          setTemplateLoadError(null);
        } else {
          setTemplateLoadError('Dữ liệu mẫu câu không đúng định dạng');
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        setTemplateLoadError(errData.error || `Lỗi máy chủ (${res.status})`);
      }
    } catch (err) {
      setTemplateLoadError(err.message || 'Không thể kết nối máy chủ');
    } finally {
      setTemplatesLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleCreateTemplate = async (e) => {
    e?.preventDefault();
    const content = newTemplateContent.trim();
    if (!content || savingTemplate) return;

    setSavingTemplate(true);
    try {
      const res = await fetch('/api/quick-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (res.ok && data.template) {
        setTemplates((prev) => [...prev, data.template]);
        setNewTemplateContent('');
        setIsAddingTemplate(false);
      } else {
        setError(data.error || 'Không thể tạo mẫu câu mới');
      }
    } catch (err) {
      setError(err.message || 'Lỗi khi lưu mẫu câu');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (e, id) => {
    e?.stopPropagation();
    if (deletingTemplateId) return;

    setDeletingTemplateId(id);
    try {
      const res = await fetch(`/api/quick-templates/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Không thể xóa mẫu câu');
      }
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err.message || 'Lỗi khi xóa mẫu câu');
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const resizeInput = useCallback((target) => {
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = Math.min(Math.max(target.scrollHeight, 36), 132) + 'px';
  }, []);

  const rememberSelection = () => {
    const target = textareaRef.current;
    if (!target) return;
    selectionRef.current = {
      start: target.selectionStart ?? inputText.length,
      end: target.selectionEnd ?? inputText.length
    };
  };

  const closeEmojiPicker = useCallback(({ restoreFocus = false } = {}) => {
    setShowEmojiPicker(false);
    if (restoreFocus) requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    if (disabled) closeEmojiPicker();
  }, [disabled, closeEmojiPicker]);

  useEffect(() => {
    if (sending || disabled || !restoreFocusAfterSendRef.current) return;
    restoreFocusAfterSendRef.current = false;
    // The textarea is disabled while sending. Wait until React has committed
    // the enabled state before restoring keyboard focus for the next message.
    const frame = requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [sending, disabled]);

  const submitContent = async (rawContent) => {
    const content = String(rawContent || '').trim();
    if ((!content && !attachment) || sending || disabled || uploadingAttachment) return;

    const clientMessageId = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const submittedAttachment = attachment;
    restoreFocusAfterSendRef.current = true;
    setSending(true);
    setError(null);
    try {
      await onSendMessage({
        contract_version: submittedAttachment ? 2 : 1,
        content,
        client_message_id: clientMessageId,
        attachment_id: submittedAttachment?.id || null,
        attachment: submittedAttachment
      });
      setInputText('');
      setAttachment(null);
      selectionRef.current = { start: 0, end: 0 };
      requestAnimationFrame(() => resizeInput(textareaRef.current));
    } catch (err) {
      setError(err.message || 'Không gửi được tin nhắn');
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (event) => {
    event?.preventDefault();
    await submitContent(inputText);
  };

  const handleQuickLike = async () => {
    await submitContent('👍');
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && showEmojiPicker) {
      event.preventDefault();
      closeEmojiPicker({ restoreFocus: true });
      return;
    }
    if (event.key === 'Enter' && event.shiftKey === false) {
      event.preventDefault();
      handleSend(event);
    }
  };

  const insertEmoji = (emoji) => {
    const target = textareaRef.current;
    const fallback = inputText.length;
    const start = Math.min(selectionRef.current.start ?? fallback, inputText.length);
    const end = Math.min(selectionRef.current.end ?? fallback, inputText.length);
    const nextText = inputText.slice(0, start) + emoji + inputText.slice(end);
    const nextCursor = start + emoji.length;
    setInputText(nextText);
    selectionRef.current = { start: nextCursor, end: nextCursor };
    requestAnimationFrame(() => {
      if (!target) return;
      target.focus();
      target.setSelectionRange(nextCursor, nextCursor);
      resizeInput(target);
    });
  };

  const chooseTemplate = (template) => {
    const text = typeof template === 'string' ? template : (template?.content || '');
    setInputText(text);
    setShowTemplates(false);
    setIsAddingTemplate(false);
    selectionRef.current = { start: text.length, end: text.length };
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(text.length, text.length);
      resizeInput(textareaRef.current);
    });
  };

  const selectAttachment = async (file, kind) => {
    if (!file || attachment || uploadingAttachment || disabled) return;
    const capability = capabilities?.[kind];
    if (capability?.enabled === false) {
      setError(capabilities?.disabled_reason || (kind === 'image'
        ? 'Nguồn gửi này chưa hỗ trợ gửi ảnh.'
        : 'Nguồn gửi này chưa hỗ trợ gửi PDF.'));
      return;
    }
    if (capability?.max_bytes && file.size > capability.max_bytes) {
      setError('File vượt giới hạn ' + Math.round(capability.max_bytes / 1024 / 1024) + ' MB.');
      return;
    }

    setUploadingAttachment(true);
    setError(null);
    try {
      const staged = await onStageAttachment(file);
      setAttachment(staged);
    } catch (uploadError) {
      setError(uploadError.message || 'Không tải được file đính kèm.');
    } finally {
      setUploadingAttachment(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = async () => {
    if (!attachment || removingAttachment) return;
    setRemovingAttachment(true);
    setError(null);
    try {
      await onDiscardAttachment(attachment.id);
      setAttachment(null);
    } catch (removeError) {
      setError(removeError.message || 'Không gỡ được file đính kèm.');
    } finally {
      setRemovingAttachment(false);
    }
  };

  const attachmentKind = (file) => {
    const type = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
    // Chromium on Windows can expose MP4/MOV as application/pdf. Infer the
    // transport kind from the extension so the v2 media contract is retained.
    if (type.startsWith('video/') || /\.(mp4|mov|avi|webm|mkv)$/i.test(name)) return 'video';
    return 'file';
  };

  const composerRef = useRef(null);

  const isFileDragEvent = (event) => {
    if (!event.dataTransfer?.types) return false;
    const types = Array.from(event.dataTransfer.types);
    return types.some((t) => t.toLowerCase() === 'files' || t.toLowerCase().startsWith('image/'));
  };

  const handleDragEnter = useCallback((event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingAttachment(true);
  }, []);

  const handleDragOver = useCallback((event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachment || disabled ? 'none' : 'copy';
  }, [attachment, disabled]);

  const handleDragLeave = useCallback((event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingAttachment(false);
  }, []);

  const handleDrop = useCallback((event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingAttachment(false);
    let files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0 && event.dataTransfer?.items) {
      files = Array.from(event.dataTransfer.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(Boolean);
    }
    if (files.length === 0) return;
    if (files.length > 1) {
      setError('Mỗi tin nhắn chỉ đính kèm được 1 file.');
      return;
    }
    selectAttachment(files[0], attachmentKind(files[0]));
  }, [attachment, disabled, capabilities]);

  useEffect(() => {
    const target = composerRef.current?.closest('.chat-thread') || composerRef.current;
    if (!target) return;

    target.addEventListener('dragenter', handleDragEnter);
    target.addEventListener('dragover', handleDragOver);
    target.addEventListener('dragleave', handleDragLeave);
    target.addEventListener('drop', handleDrop);

    return () => {
      target.removeEventListener('dragenter', handleDragEnter);
      target.removeEventListener('dragover', handleDragOver);
      target.removeEventListener('dragleave', handleDragLeave);
      target.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragOver, handleDragLeave, handleDrop]);

  const hasText = inputText.trim().length > 0;
  const hasSendableContent = hasText || Boolean(attachment);
  // Video shares the generic picker with files. Keep that picker enabled when
  // video is supported even if arbitrary file transport is disabled.
  const genericAttachmentEnabled = !capabilities
    || capabilities?.video?.enabled === true
    || capabilities?.file?.enabled !== false;
  const iconButtonClass = 'w-8 h-8 inline-flex items-center justify-center hover:bg-[var(--color-bg-hover)] rounded-full transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div
      ref={composerRef}
      className="chat-composer relative px-4 pt-2.5 pb-2.5 bg-[var(--color-bg-panel)] border-t border-[var(--color-border)] select-none shrink-0 w-full sticky bottom-0"
    >
      {draggingAttachment && (
        <div className="fixed inset-0 lg:absolute lg:inset-0 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-bg-panel)]/95 text-sm font-semibold text-[var(--color-accent)] pointer-events-none">
          {attachment ? 'Gỡ file hiện tại trước khi thêm file mới' : 'Thả ảnh hoặc file vào đây'}
        </div>
      )}
      {senderIdentity?.name && (
        <div
          className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent-subtle)] px-3 py-1.5"
          title={`Tin nhắn này sẽ được gửi bằng ${senderIdentity.name}${senderIdentity.id ? ` · ID ${senderIdentity.id}` : ''}`}
        >
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-accent)] text-[10px] font-extrabold text-[var(--color-text-on-accent)]">
            {String(senderIdentity.name).charAt(0).toUpperCase()}
            {senderIdentity.avatar_url && <img src={senderIdentity.avatar_url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
          </span>
          <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-muted)]">Gửi bằng:</span>
          <strong className="min-w-0 truncate text-xs text-[var(--color-accent)]">{senderIdentity.name}</strong>
          {senderIdentity.id && <span className="ml-auto shrink-0 rounded bg-[var(--color-bg-panel)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--color-text-secondary)]">#{String(senderIdentity.id).slice(-4)}</span>}
        </div>
      )}
      {disabled && (
        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-danger-subtle)] border border-[var(--color-danger)]/20 rounded-lg text-xs font-medium text-[var(--color-danger)] mb-2.5">
          <WifiOff size={14} className="shrink-0" strokeWidth={1.75} />
          <span>{disabledReason}</span>
        </div>
      )}

      {showTemplates && (
        <div className="p-2.5 bg-[var(--color-bg-panel)] rounded-xl border border-[var(--color-border)] text-xs mb-2.5 shadow-lg max-h-80 flex flex-col">
          <div className="flex justify-between items-center text-xs text-[var(--color-text-muted)] font-medium pb-2 mb-1.5 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--color-text-primary)]">Mẫu nhanh</span>
              <button
                type="button"
                onClick={() => setIsAddingTemplate((prev) => !prev)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/20 px-2 py-0.5 rounded-full transition-colors"
                title="Tạo mẫu câu trả lời mới"
              >
                <Plus size={12} strokeWidth={2} />
                <span>{isAddingTemplate ? 'Đóng form' : 'Thêm mẫu'}</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowTemplates(false);
                setIsAddingTemplate(false);
              }}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 rounded px-1"
            >
              Đóng
            </button>
          </div>

          {isAddingTemplate && (
            <form onSubmit={handleCreateTemplate} className="mb-2 p-2 bg-[var(--color-bg-surface)] rounded-lg border border-[var(--color-border)] space-y-2">
              <textarea
                value={newTemplateContent}
                onChange={(e) => setNewTemplateContent(e.target.value)}
                placeholder="Nhập nội dung mẫu câu trả lời (VD: Báo giá, STK, địa chỉ...)"
                rows={2}
                className="w-full text-xs p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-panel)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingTemplate(false);
                    setNewTemplateContent('');
                  }}
                  className="px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] rounded-md transition-colors"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={!newTemplateContent.trim() || savingTemplate}
                  className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                >
                  {savingTemplate && <Loader2 size={11} className="animate-spin" />}
                  <span>Lưu mẫu</span>
                </button>
              </div>
            </form>
          )}

          <div className="overflow-y-auto space-y-1 pr-0.5 max-h-56">
            {!templatesLoaded ? (
              <div className="flex items-center justify-center py-4 text-[var(--color-text-muted)] gap-1.5">
                <Loader2 size={13} className="animate-spin" />
                <span>Đang tải mẫu câu...</span>
              </div>
            ) : templateLoadError ? (
              <div className="text-center py-4 px-2 space-y-2 select-none">
                <p className="text-xs text-[var(--color-danger)] leading-relaxed">{templateLoadError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setTemplatesLoaded(false);
                    loadTemplates();
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/20 rounded-md transition-colors"
                >
                  <RefreshCw size={12} strokeWidth={1.75} />
                  <span>Thử lại</span>
                </button>
              </div>
            ) : templates.length === 0 ? (
              <div className="text-center py-4 text-[var(--color-text-muted)]">
                Chưa có mẫu câu nào. Bấm <b>"+ Thêm mẫu"</b> để tạo câu mới.
              </div>
            ) : (
              templates.map((tpl) => {
                const templateText = typeof tpl === 'string' ? tpl : tpl.content;
                const templateId = typeof tpl === 'string' ? tpl : tpl.id;
                const isDeleting = deletingTemplateId === templateId;

                return (
                  <div
                    key={templateId}
                    className="group flex items-center justify-between gap-2 p-2 hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded-lg transition-colors text-xs cursor-pointer"
                    onClick={() => chooseTemplate(templateText)}
                  >
                    <span className="flex-1 text-left line-clamp-2 leading-relaxed">{templateText}</span>
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={(e) => handleDeleteTemplate(e, templateId)}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] p-1 rounded hover:bg-[var(--color-danger)]/10 transition-all shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-danger)]/40"
                      title="Xóa mẫu câu này"
                    >
                      {isDeleting ? (
                        <Loader2 size={13} className="animate-spin text-[var(--color-danger)]" />
                      ) : (
                        <Trash2 size={13} strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between px-3 py-2 bg-[var(--color-danger-subtle)] border border-[var(--color-danger)]/20 rounded-lg text-xs text-[var(--color-danger)] mb-2.5">
          <span className="flex items-center gap-1.5"><AlertCircle size={14} strokeWidth={1.75} /> {error}</span>
          <button type="button" onClick={() => setError(null)} className="text-xs underline focus-visible:ring-2 focus-visible:ring-[var(--color-danger)] rounded">Đóng</button>
        </div>
      )}

      <AttachmentPreview
        attachment={attachment}
        uploading={uploadingAttachment}
        removing={removingAttachment}
        onRemove={removeAttachment}
      />

      <form onSubmit={handleSend} className="flex items-end gap-2 bg-[var(--color-bg-surface)] rounded-2xl px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-[var(--color-accent)]/10 transition-all">
        <div className="relative flex-shrink-0">
          <button
            ref={emojiButtonRef}
            type="button"
            aria-label="Chọn biểu tượng cảm xúc"
            aria-haspopup="dialog"
            aria-expanded={showEmojiPicker}
            disabled={disabled || sending}
            onClick={() => {
              rememberSelection();
              setShowTemplates(false);
              setShowEmojiPicker((value) => !value);
            }}
            className={iconButtonClass + ' text-[var(--color-warning)]'}
          >
            <Smile size={20} strokeWidth={1.75} />
          </button>
          <EmojiPickerPopover
            open={showEmojiPicker}
            onClose={closeEmojiPicker}
            onSelect={insertEmoji}
            triggerRef={emojiButtonRef}
          />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.csv,.json,.xml,.html,.md,.zip,.rar,.7z,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.mp3,.wav,.mp4,.mov,.avi"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            selectAttachment(file, attachmentKind(file));
          }}
        />
        <button
          type="button"
          aria-label="Đính kèm tệp hoặc video"
          title={!genericAttachmentEnabled
            ? (capabilities.disabled_reason || 'Nguồn gửi này chưa hỗ trợ tệp hoặc video')
            : 'Đính kèm tệp hoặc video'}
          disabled={disabled || sending || uploadingAttachment || Boolean(attachment) || !genericAttachmentEnabled}
          onClick={() => fileInputRef.current?.click()}
          className={iconButtonClass + ' text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}
        >
          <Paperclip size={19} strokeWidth={1.75} />
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          className="hidden"
          onChange={(event) => selectAttachment(event.target.files?.[0], 'image')}
        />
        <button
          type="button"
          aria-label="Đính kèm ảnh"
          title={capabilities?.image?.enabled === false
            ? (capabilities.disabled_reason || 'Nguồn gửi này chưa hỗ trợ ảnh')
            : 'Đính kèm ảnh'}
          disabled={disabled || sending || uploadingAttachment || Boolean(attachment) || capabilities?.image?.enabled === false}
          onClick={() => imageInputRef.current?.click()}
          className={iconButtonClass + ' text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}
        >
          <Image size={19} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Mở mẫu trả lời nhanh"
          aria-expanded={showTemplates}
          title="Mẫu nhanh"
          disabled={disabled || sending}
          onClick={() => {
            closeEmojiPicker();
            setShowTemplates((value) => !value);
          }}
          className={iconButtonClass + ' text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}
        >
          <FileText size={18} strokeWidth={1.75} />
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          value={inputText}
          onChange={(event) => {
            setInputText(event.target.value);
            rememberSelection();
          }}
          onInput={(event) => resizeInput(event.target)}
          onSelect={rememberSelection}
          onClick={rememberSelection}
          onKeyUp={rememberSelection}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          aria-label="Nội dung tin nhắn"
          placeholder={disabled ? disabledReason : 'Nhập tin nhắn...'}
          className="flex-1 bg-transparent text-sm focus:outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] resize-none disabled:opacity-50 leading-5 py-2 max-h-32 min-h-9"
          style={{ height: 36 }}
        />

        <button
          type={hasSendableContent ? 'submit' : 'button'}
          onClick={hasSendableContent ? undefined : handleQuickLike}
          disabled={disabled || sending}
          className={
            'w-10 h-10 rounded-full transition-all flex-shrink-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50 ' +
            (hasSendableContent
              ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-on-accent)] shadow-sm'
              : 'text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]')
          }
          title={hasSendableContent ? 'Gửi tin nhắn' : 'Gửi biểu tượng thích'}
          aria-label={hasSendableContent ? 'Gửi tin nhắn' : 'Gửi biểu tượng thích'}
        >
          {sending
            ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
            : hasSendableContent
              ? <Send size={17} strokeWidth={1.8} />
              : <ThumbsUp size={19} strokeWidth={1.8} />}
        </button>
      </form>
    </div>
  );
}
