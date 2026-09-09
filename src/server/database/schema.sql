-- 1. Bảng Người dùng hệ thống (Admin / Staff)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('ADMIN', 'STAFF')) NOT NULL DEFAULT 'STAFF',
    company_id INTEGER,
    company_role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(company_role IN ('ADMIN', 'EMPLOYEE')),
    google_id TEXT,
    email TEXT,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS account_user_assignments (
    account_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    assigned_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(account_id, user_id),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(assigned_by) REFERENCES users(id) ON DELETE CASCADE
);

-- 2. Bảng Tài khoản Facebook cá nhân
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT NOT NULL,
    profile_dir TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    broadcast_daily_count INTEGER DEFAULT 0,
    last_broadcast_date DATE DEFAULT (DATE('now')),
    status TEXT CHECK(status IN ('ACTIVE', 'DISCONNECTED', 'CHECKPOINT')) DEFAULT 'ACTIVE',
    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    company_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Persistent tombstones prevent a detached/stale Chrome extension from
-- recreating an account after the backend restarts. A deliberate new-account
-- login removes the matching tombstone.
CREATE TABLE IF NOT EXISTS removed_accounts (
    account_id TEXT PRIMARY KEY,
    removed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2b. Bảng Nguồn inbox hợp nhất: personal Messenger account hoặc Facebook Page
CREATE TABLE IF NOT EXISTS inbox_sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK(source_type IN ('personal_messenger', 'page_messenger')),
    owner_account_id TEXT,
    external_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    access_token_encrypted TEXT,
    webhook_verify_token TEXT,
    status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISCONNECTED', 'TOKEN_EXPIRED')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, external_id)
);

-- 3. Bảng Hội thoại (Threads)
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    external_thread_id TEXT,
    account_id TEXT NOT NULL,
    source_id TEXT,
    thread_url TEXT,
    contact_name TEXT,
    last_message TEXT,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_unread BOOLEAN DEFAULT 1,
    inbox_folder TEXT CHECK(inbox_folder IN ('INBOX', 'MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE')) DEFAULT 'INBOX',
    status TEXT CHECK(status IN ('UNPROCESSED', 'ASSIGNED', 'COMPLETED')) DEFAULT 'UNPROCESSED',
    assigned_user_id INTEGER,
    ai_paused_until DATETIME,
    sync_status TEXT DEFAULT 'LOCAL',
    sync_cursor TEXT,
    sync_error TEXT,
    archived_at DATETIME,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(assigned_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL UNIQUE,
    due_at DATETIME NOT NULL,
    note TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')) DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_reminders_due ON conversation_reminders(status, due_at);

-- 4. Bảng Tin nhắn (Messages)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    fb_message_id TEXT UNIQUE,
    client_message_id TEXT,
    sender_id TEXT NOT NULL,
    content TEXT,
    media_type TEXT CHECK(media_type IN ('text', 'image', 'video', 'voice', 'file', 'call')) DEFAULT 'text',
    media_url TEXT,
    local_media_path TEXT,
    attachment_id TEXT REFERENCES outbound_attachments(id),
    latest_attempt_id TEXT REFERENCES outbound_attempts(id),
    media_name TEXT,
    media_mime_type TEXT,
    media_size INTEGER CHECK(media_size IS NULL OR media_size >= 0),
    is_outgoing BOOLEAN NOT NULL DEFAULT 0,
    sender_role TEXT NOT NULL DEFAULT 'customer' CHECK(sender_role IN ('customer', 'operator')),
    sequence_order INTEGER,
    direction_status TEXT NOT NULL DEFAULT 'confirmed' CHECK(direction_status IN ('confirmed', 'pending')),
    is_unsent BOOLEAN NOT NULL DEFAULT 0,
    delivery_status TEXT CHECK(delivery_status IN ('pending', 'sent', 'failed')) DEFAULT 'sent',
    delivery_error TEXT,
    timestamp_ms INTEGER DEFAULT 0,
    timestamp_source TEXT DEFAULT 'unknown',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- 5. Bảng Tìm kiếm Toàn văn FTS5 (Full-Text Search)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    thread_id UNINDEXED,
    sender_id UNINDEXED,
    tokenize='unicode61'
);

-- Trigger tự động thêm tin nhắn vào FTS5
CREATE TRIGGER IF NOT EXISTS messages_ai_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, thread_id, sender_id)
    VALUES (new.id, new.content, new.thread_id, new.sender_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_ai_update AFTER UPDATE ON messages BEGIN
    UPDATE messages_fts SET content = new.content, thread_id = new.thread_id, sender_id = new.sender_id
    WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_ai_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END;

-- 5.5 Bảng Trạng thái tùy chỉnh (tạo 1 lần, dùng lại cho nhiều thread)
CREATE TABLE IF NOT EXISTS lead_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5.6 Quy tắc toàn cục: tự động đánh dấu khi khách gửi số (spec 037)
CREATE TABLE IF NOT EXISTS phone_capture_automation_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    is_enabled INTEGER NOT NULL DEFAULT 0 CHECK(is_enabled IN (0, 1)),
    status_id INTEGER REFERENCES lead_statuses(id) ON DELETE SET NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 6. Bảng Liên hệ / Lead khách hàng (Contacts)
CREATE TABLE IF NOT EXISTS contacts (
    thread_id TEXT PRIMARY KEY,
    name TEXT,
    nickname TEXT,
    avatar_url TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    lead_captured BOOLEAN DEFAULT 0,
    tags TEXT DEFAULT '[]',
    notes TEXT,
    campaign_opt_out BOOLEAN NOT NULL DEFAULT 0,
    status_id INTEGER REFERENCES lead_statuses(id),
    custom_fields TEXT DEFAULT '[]',
    phone_source TEXT,
    phone_capture_id INTEGER REFERENCES contact_phone_captures(id),
    phone_captured_at DATETIME,
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- 6b. Bảng bằng chứng số điện thoại bắt được từ tin nhắn (spec 035)
CREATE TABLE IF NOT EXISTS contact_phone_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    raw_phone TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_timestamp_ms INTEGER DEFAULT 0,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    rule_version INTEGER NOT NULL DEFAULT 1,
    selection_state TEXT NOT NULL DEFAULT 'candidate' CHECK(selection_state IN ('selected', 'candidate', 'ignored')),
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    UNIQUE(message_id, normalized_phone)
);
CREATE INDEX IF NOT EXISTS idx_contact_phone_captures_thread ON contact_phone_captures(thread_id, message_timestamp_ms);

-- 7. Bảng Cấu hình Auto Reply & AI
CREATE TABLE IF NOT EXISTS auto_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    created_by_staff_id INTEGER,
    trigger_keyword TEXT NOT NULL,
    response_template TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT UNIQUE NOT NULL,
    provider TEXT CHECK(provider IN ('LOCAL_OLLAMA', 'CLOUD_OPENAI', 'CLOUD_GEMINI')) NOT NULL,
    api_key TEXT,
    model_name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- INDICES TỐI ƯU
CREATE INDEX IF NOT EXISTS idx_threads_account ON threads(account_id);
CREATE INDEX IF NOT EXISTS idx_threads_assigned ON threads(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- 8. Bảng Message Queue (Hàng đợi tin nhắn)
CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source_id TEXT,
    source_type TEXT CHECK(source_type IN ('personal_messenger', 'page_messenger')),
    page_id TEXT,
    content TEXT NOT NULL DEFAULT '',
    attachment_id TEXT,
    attachment_path TEXT,
    attachment_mime_type TEXT,
    attachment_name TEXT,
    outbound_attempt_id TEXT REFERENCES outbound_attempts(id),
    attachment_media_type TEXT CHECK(attachment_media_type IN ('image', 'file')),
    attachment_byte_size INTEGER CHECK(attachment_byte_size IS NULL OR attachment_byte_size > 0),
    attachment_checksum TEXT,
    -- Spec 040: when set, this dispatch carries every campaign_attachments
    -- row sharing this manifest (several independently-selected files, or
    -- one folder ZIP's single member) instead of the one attachment_id
    -- above. QueueWorker reads the member rows straight from
    -- campaign_attachments by manifest_id rather than duplicating their
    -- checksum/byte_size onto this row.
    manifest_id TEXT,
    contract_version INTEGER NOT NULL DEFAULT 1,
    campaign_id TEXT,
    campaign_recipient_id TEXT,
    campaign_attempt_id TEXT,
    idempotency_key TEXT UNIQUE,
    status TEXT CHECK(status IN ('pending', 'processing', 'sent', 'failed')) DEFAULT 'pending',
    error_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
);


-- Campaign persistence

-- Thread-bound staged attachments for one-to-one rich messages.
CREATE TABLE IF NOT EXISTS outbound_attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    created_by INTEGER,
    original_name TEXT NOT NULL,
    safe_name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image', 'file')),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    byte_size INTEGER NOT NULL CHECK(byte_size > 0),
    storage_path TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64),
    status TEXT NOT NULL CHECK(status IN ('staged', 'queued', 'sending', 'sent', 'failed', 'expired', 'deleted')) DEFAULT 'staged',
    validation_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    consumed_by_message_id INTEGER UNIQUE,
    FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(consumed_by_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- Immutable-per-dispatch audit records. Retries append rows instead of reusing one.
CREATE TABLE IF NOT EXISTS outbound_attempts (
    id TEXT PRIMARY KEY,
    message_id INTEGER NOT NULL,
    queue_id TEXT UNIQUE,
    attachment_id TEXT,
    source_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('personal_messenger', 'page_messenger')),
    account_id TEXT NOT NULL,
    page_id TEXT,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('queued', 'dispatching', 'awaiting_confirmation', 'sent', 'failed', 'uncertain', 'superseded')) DEFAULT 'queued',
    dispatch_method TEXT,
    error_code TEXT,
    error_message TEXT,
    dispatched_at DATETIME,
    confirmed_at DATETIME,
    confirmation_message_id TEXT,
    confirmation_source TEXT CHECK(confirmation_source IS NULL OR confirmation_source IN ('webhook', 'personal_dom', 'page_dom', 'reconciliation')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY(queue_id) REFERENCES message_queue(id) ON DELETE SET NULL,
    FOREIGN KEY(attachment_id) REFERENCES outbound_attachments(id) ON DELETE SET NULL,
    UNIQUE(message_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_outbound_attachments_thread_status
ON outbound_attachments(thread_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_attachments_expiry
ON outbound_attachments(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_outbound_attachments_checksum
ON outbound_attachments(checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_message
ON outbound_attempts(message_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_status
ON outbound_attempts(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_attempts_active_message
ON outbound_attempts(message_id)
WHERE status IN ('queued', 'dispatching', 'awaiting_confirmation');
CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_scope TEXT,
    account_scope TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'ready', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed')) DEFAULT 'draft',
    start_position INTEGER NOT NULL DEFAULT 1,
    direction TEXT NOT NULL CHECK(direction IN ('asc', 'desc')) DEFAULT 'asc',
    pacing_ms INTEGER NOT NULL DEFAULT 5000,
    max_retries INTEGER NOT NULL DEFAULT 0,
    send_cap INTEGER NOT NULL DEFAULT 50,
    quiet_hours_start TEXT NOT NULL DEFAULT '00:00',
    quiet_hours_end TEXT NOT NULL DEFAULT '00:00',
    feature_version TEXT NOT NULL DEFAULT '026-v1',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME,
    phone_capture_policy TEXT NOT NULL DEFAULT 'continue' CHECK(phone_capture_policy IN ('continue', 'stop_remaining', 'thank_then_stop')),
    phone_capture_thank_you_text TEXT,
    phone_capture_status_id INTEGER, -- deliberately no FK: may outlive the status row (FR-012)
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    source_id TEXT,
    account_id TEXT NOT NULL,
    source_type_snapshot TEXT,
    source_external_id_snapshot TEXT,
    source_display_name_snapshot TEXT,
    selection_order INTEGER NOT NULL,
    execution_order INTEGER,
    eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('eligible', 'ineligible', 'opted_out', 'unsupported', 'invalid_route')),
    eligibility_reason TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled')) DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error TEXT,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    UNIQUE(campaign_id, thread_id),
    UNIQUE(campaign_id, selection_order),
    UNIQUE(campaign_id, execution_order)
);

CREATE TABLE IF NOT EXISTS campaign_messages (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    sequence_order INTEGER NOT NULL,
    text_content TEXT,
    validation_status TEXT NOT NULL CHECK(validation_status IN ('pending', 'valid', 'invalid')) DEFAULT 'pending',
    validation_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    UNIQUE(campaign_id, sequence_order)
);

-- Spec 040: groups one or more campaign_attachments rows staged together as
-- a single attachment manifest (multiple selected files, or one generated
-- ZIP for a selected folder). Kept as a separate additive table rather than
-- reshaping campaign_attachments, so spec 039's existing single-image rows
-- (no manifest_id) remain byte-for-byte unchanged.
CREATE TABLE IF NOT EXISTS campaign_attachment_manifests (
    id TEXT PRIMARY KEY,
    campaign_message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('files', 'folder_zip')),
    item_count INTEGER NOT NULL CHECK(item_count > 0),
    total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
    archive_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_message_id) REFERENCES campaign_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaign_attachments (
    id TEXT PRIMARY KEY,
    campaign_message_id TEXT NOT NULL,
    manifest_id TEXT,
    media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'file')),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
    storage_path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    validation_status TEXT NOT NULL CHECK(validation_status IN ('pending', 'valid', 'invalid', 'unavailable')) DEFAULT 'pending',
    validation_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_message_id) REFERENCES campaign_messages(id) ON DELETE CASCADE,
    FOREIGN KEY(manifest_id) REFERENCES campaign_attachment_manifests(id) ON DELETE CASCADE,
    UNIQUE(campaign_message_id, checksum)
);

CREATE INDEX IF NOT EXISTS idx_campaign_attachments_manifest ON campaign_attachments(manifest_id);

CREATE TABLE IF NOT EXISTS campaign_attempts (
    id TEXT PRIMARY KEY,
    campaign_recipient_id TEXT NOT NULL,
    campaign_message_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    queue_id TEXT,
    client_message_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('created', 'dispatched', 'confirmed', 'failed', 'unknown')) DEFAULT 'created',
    attachment_status TEXT CHECK(attachment_status IN ('not_requested', 'pending', 'sent', 'failed')) DEFAULT 'not_requested',
    attachment_error TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    FOREIGN KEY(campaign_recipient_id) REFERENCES campaign_recipients(id) ON DELETE CASCADE,
    FOREIGN KEY(campaign_message_id) REFERENCES campaign_messages(id) ON DELETE CASCADE,
    UNIQUE(campaign_recipient_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS campaign_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    campaign_recipient_id TEXT,
    event_type TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_type TEXT NOT NULL DEFAULT 'system' CHECK(actor_type IN ('operator', 'system')),
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(campaign_recipient_id) REFERENCES campaign_recipients(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_phone_capture_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    campaign_recipient_id TEXT NOT NULL,
    phone_capture_id INTEGER NOT NULL,
    policy TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'stop_applied', 'thank_queued', 'thank_confirmed', 'thank_failed', 'status_applied', 'status_unavailable')),
    thank_you_client_message_id TEXT,
    applied_status_id INTEGER,
    error_detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(campaign_recipient_id) REFERENCES campaign_recipients(id) ON DELETE CASCADE,
    FOREIGN KEY(phone_capture_id) REFERENCES contact_phone_captures(id),
    UNIQUE(campaign_recipient_id, phone_capture_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_phone_capture_actions_recipient ON campaign_phone_capture_actions(campaign_recipient_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_next ON campaign_recipients(campaign_id, status, execution_order);
CREATE INDEX IF NOT EXISTS idx_campaign_attempts_queue ON campaign_attempts(queue_id);
CREATE INDEX IF NOT EXISTS idx_campaign_audit_campaign ON campaign_audit_events(campaign_id, id);
CREATE INDEX IF NOT EXISTS idx_campaign_attachments_message ON campaign_attachments(campaign_message_id);
CREATE INDEX IF NOT EXISTS idx_campaign_attachments_checksum ON campaign_attachments(checksum);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_idempotency ON message_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;
