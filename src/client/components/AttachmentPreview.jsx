import React from 'react';
import { FileText, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react';

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function AttachmentPreview({
  attachment,
  uploading = false,
  removing = false,
  onRemove
}) {
  if (!attachment && uploading === false) return null;

  if (uploading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-2.5 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-3 text-sm text-[var(--color-text-secondary)]"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-bg-hover)] text-[var(--color-accent)]">
          <Loader2 size={20} className="animate-spin motion-reduce:animate-none" />
        </span>
        <span>
          <span className="block font-semibold text-[var(--color-text-primary)]">Đang kiểm tra file...</span>
          <span className="text-xs text-[var(--color-text-muted)]">CRM đang xác minh định dạng và dung lượng.</span>
        </span>
      </div>
    );
  }

  const isImage = attachment.media_type === 'image';
  const isVideo = attachment.media_type === 'video';
  return (
    <div className="mb-2.5 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2.5 shadow-sm">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--color-bg-hover)] text-[var(--color-accent)]">
        {isVideo && attachment.preview_url
          ? React.createElement('video', { src: attachment.preview_url, muted: true, preload: 'metadata', className: 'h-full w-full object-cover' })
          : isImage && attachment.preview_url
          ? (
              <img
                src={attachment.preview_url}
                alt=""
                className="h-full w-full object-cover"
              />
            )
          : isImage
            ? <ImageIcon size={22} aria-hidden="true" />
            : <FileText size={22} aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
          {attachment.safe_name || attachment.original_name}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          {isImage ? 'Hình ảnh' : 'Tệp PDF'} · {formatBytes(attachment.byte_size)}
        </p>
        <p className="mt-1 text-[11px] font-medium text-[var(--color-success)]">
          Đã kiểm tra · sẵn sàng gửi
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label="Gỡ file đính kèm"
        title="Gỡ file đính kèm"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger-subtle)] hover:text-[var(--color-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-danger)]/40 disabled:opacity-50"
      >
        {removing
          ? <Loader2 size={17} className="animate-spin motion-reduce:animate-none" />
          : <Trash2 size={17} strokeWidth={1.8} />}
      </button>
    </div>
  );
}

export { formatBytes };
