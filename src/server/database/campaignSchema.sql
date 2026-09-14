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

CREATE TABLE IF NOT EXISTS campaign_attachments (
    id TEXT PRIMARY KEY,
    campaign_message_id TEXT NOT NULL,
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
    UNIQUE(campaign_message_id, checksum)
);

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

CREATE TABLE IF NOT EXISTS campaign_response_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    campaign_recipient_id TEXT NOT NULL,
    message_id INTEGER NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(campaign_recipient_id) REFERENCES campaign_recipients(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_response_recipient ON campaign_response_events(campaign_recipient_id, id);

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
