const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { ensureMessageDirectionStatus } = require('./messageDirectionMigration');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

const DATA_DIR = APP_DATA_ROOT;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MEDIA_DIR = path.join(DATA_DIR, 'media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'database.db');
// Capture this before opening SQLite because opening a missing database creates
// the file immediately. Migration backups should only run for existing data.
const dbExistedBeforeOpen = fs.existsSync(DB_PATH);
let dbOpts = {};
if (process.resourcesPath) {
  const unpackedBinding = path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (fs.existsSync(unpackedBinding)) {
    dbOpts.nativeBinding = unpackedBinding;
  }
}
const db = new Database(DB_PATH, dbOpts);

// Bật WAL Mode & Synchronous Normal cho hiệu năng tối đa
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Backup legacy data before schema/migration code can alter the file.
let preMigrationBackupPath = null;
if (dbExistedBeforeOpen) {
  const migrationTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get();
  const currentVersion = migrationTable ? (db.prepare('SELECT MAX(version) AS version FROM migrations').get().version || 0) : 0;
  if (currentVersion < 14) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    preMigrationBackupPath = DB_PATH + '.backup-' + Date.now();
    fs.copyFileSync(DB_PATH, preMigrationBackupPath);
    console.log('[DB] Backup created at ' + preMigrationBackupPath);
  }
}

// Nạp Schema SQL
const schemaPath = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
const existingQueueColumns = db.prepare('PRAGMA table_info(message_queue)').all()
  .map((column) => column.name);
const idempotencyIndexSql = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_idempotency ON message_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;';
// Legacy databases receive idempotency_key in migration v14. Delay only this
// index statement until the migration has added the column. Migration v14/v15
// creates the same unique index before startup completes.
let initializationSql = existingQueueColumns.length > 0 &&
  !existingQueueColumns.includes('idempotency_key')
  ? schemaSql.replace(idempotencyIndexSql, '')
  : schemaSql;
// Same problem, same fix, for spec 040: a pre-existing campaign_attachments
// table (any DB from before this column existed) has no manifest_id column
// yet - CREATE TABLE IF NOT EXISTS is then a no-op, so the index statement
// right after it would fail against the old shape. Migration v24 adds the
// column and creates this same index once it's safe to.
const existingAttachmentColumns = db.prepare('PRAGMA table_info(campaign_attachments)').all()
  .map((column) => column.name);
const manifestIndexSql = 'CREATE INDEX IF NOT EXISTS idx_campaign_attachments_manifest ON campaign_attachments(manifest_id);';
if (existingAttachmentColumns.length > 0 && !existingAttachmentColumns.includes('manifest_id')) {
  initializationSql = initializationSql.replace(manifestIndexSql, '');
}
db.exec(initializationSql);

// CREATE TABLE IF NOT EXISTS does not evolve an existing SQLite table. Keep
// this additive compatibility guard independent from migration version state:
// some long-lived databases can already contain higher/custom migration rows,
// which would otherwise make MAX(version) skip the nickname migration.
const contactColumns = db.prepare('PRAGMA table_info(contacts)').all().map((column) => column.name);
if (!contactColumns.includes('nickname')) {
  db.exec('ALTER TABLE contacts ADD COLUMN nickname TEXT;');
  console.log('[DB] Added missing contacts.nickname column.');
}

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('company_id')) {
  try { db.exec('ALTER TABLE users ADD COLUMN company_id INTEGER;'); } catch (_) {}
  try { db.exec('UPDATE users SET company_id = id WHERE company_id IS NULL;'); } catch (_) {}
  console.log('[DB] Added missing users.company_id column.');
}
if (!userColumns.includes('company_role')) {
  try { db.exec("ALTER TABLE users ADD COLUMN company_role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(company_role IN ('ADMIN','EMPLOYEE'));"); } catch (_) {}
  console.log('[DB] Added missing users.company_role column.');
}

const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name);
if (!accountColumns.includes('company_id')) {
  try { db.exec('ALTER TABLE accounts ADD COLUMN company_id INTEGER;'); } catch (_) {}
  try { db.exec('UPDATE accounts SET company_id = owner_user_id WHERE company_id IS NULL;'); } catch (_) {}
  console.log('[DB] Added missing accounts.company_id column.');
}

const threadColumns = db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name);
if (!threadColumns.includes('history_completed')) {
  try { db.exec('ALTER TABLE threads ADD COLUMN history_completed INTEGER NOT NULL DEFAULT 0;'); } catch (_) {}
  console.log('[DB] Added missing threads.history_completed column.');
}

// Initialize migrations table
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const migrations = [
  {
    version: 1,
    name: 'add_client_message_id',
    up: (db) => {
      try { db.exec("ALTER TABLE messages ADD COLUMN client_message_id TEXT;"); } catch (e) { }
    }
  },
  {
    version: 2,
    name: 'add_thread_url',
    up: (db) => {
      try { db.exec("ALTER TABLE threads ADD COLUMN thread_url TEXT;"); } catch (e) { }
    }
  },
  {
    version: 3,
    name: 'add_timestamp_ms',
    up: (db) => {
      try { db.exec("ALTER TABLE messages ADD COLUMN timestamp_ms INTEGER DEFAULT 0;"); } catch (e) { }
      try { db.exec("ALTER TABLE messages ADD COLUMN timestamp_source TEXT DEFAULT 'unknown';"); } catch (e) { }
    }
  },
  {
    version: 4,
    name: 'add_sync_fields_threads',
    up: (db) => {
      try { db.exec("ALTER TABLE threads ADD COLUMN sync_status TEXT DEFAULT 'LOCAL';"); } catch (e) { }
      try { db.exec("ALTER TABLE threads ADD COLUMN sync_cursor TEXT;"); } catch (e) { }
      try { db.exec("ALTER TABLE threads ADD COLUMN sync_error TEXT;"); } catch (e) { }
    }
  },
  {
    version: 5,
    name: 'update_fts_triggers',
    up: (db) => {
      db.exec("DROP TRIGGER IF EXISTS messages_ai;");
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, thread_id, sender_id)
            VALUES (new.id, new.content, new.thread_id, new.sender_id);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai_update AFTER UPDATE ON messages BEGIN
            UPDATE messages_fts SET content = new.content, thread_id = new.thread_id, sender_id = new.sender_id
            WHERE rowid = old.id;
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai_delete AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
        END;
      `);
    }
  },
  {
    version: 6,
    name: 'cleanup_accessibility_label_content',
    up: (db) => {
      const rows = db.prepare("SELECT id, content FROM messages WHERE content LIKE 'Tin nhắn do % gửi lúc %' OR content LIKE 'Message sent by % at %'").all();
      const update = db.prepare('UPDATE messages SET content = ? WHERE id = ?');
      const remove = db.prepare('DELETE FROM messages WHERE id = ?');
      for (const row of rows) {
        const match = String(row.content || '').match(/^(?:Nhập,\s*)?(?:Tin nhắn do [^\n]+? gửi lúc|Message sent by [^\n]+? at) [^:\n]*:\s*([\s\S]*)$/i);
        const clean = match ? match[1].trim() : String(row.content || '').trim();
        if (clean) update.run(clean, row.id);
        else remove.run(row.id);
      }
      console.log('[DB] Cleaned ' + rows.length + ' accessibility-label message rows.');
    }
  },
  {
    version: 7,
    name: 'cleanup_delivery_status_content',
    // This migration intentionally removes known Facebook UI metadata rows.
    allowsMessageRowReduction: true,
    up: (db) => {
      const rows = db.prepare("SELECT id, content FROM messages WHERE content LIKE 'Đã gửi % trước' OR content LIKE 'Đã nhận % trước' OR content LIKE 'Đã xem % trước' OR content LIKE 'Sent % ago'").all();
      const remove = db.prepare('DELETE FROM messages WHERE id = ?');
      for (const row of rows) {
        if (/^(?:Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen)\s+\d+\s+(?:giây|phút|giờ|ngày|tuần|tháng|năm)\s+(?:trước|ago)$/i.test(String(row.content || '').trim())) remove.run(row.id);
      }
      console.log('[DB] Removed ' + rows.length + ' delivery-status message rows.');
    }
  },
  {
    version: 8,
    name: 'add_outbound_delivery_state',
    up: (db) => {
      try { db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent';"); } catch (e) { }
      try { db.exec("ALTER TABLE messages ADD COLUMN delivery_error TEXT;"); } catch (e) { }
      db.exec("UPDATE messages SET delivery_status = CASE WHEN fb_message_id LIKE 'pending_%' THEN 'pending' ELSE 'sent' END WHERE delivery_status IS NULL;");
    }
  },
  {
    version: 9,
    name: 'add_external_thread_id',
    up: (db) => {
      try { db.exec("ALTER TABLE threads ADD COLUMN external_thread_id TEXT;"); } catch (e) { }
      db.exec("UPDATE threads SET external_thread_id = id WHERE external_thread_id IS NULL OR external_thread_id = '';");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_account_external ON threads(account_id, external_thread_id);");
    }
  },
  {
    version: 10,
    name: 'add_inbox_sources_and_source_id',
    up: (db) => {
      // Create inbox_sources table
      db.exec(`
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
        )
      `);
      // Add source_id to threads
      try { db.exec("ALTER TABLE threads ADD COLUMN source_id TEXT;"); } catch (e) { }
      // Auto-create personal_messenger sources for existing accounts
      const accounts = db.prepare('SELECT id, name FROM accounts').all();
      const insertSource = db.prepare(`
        INSERT OR IGNORE INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
        VALUES (?, 'personal_messenger', NULL, ?, ?, 'ACTIVE')
      `);
      for (const acc of accounts) {
        const sourceId = 'src_personal_' + acc.id;
        insertSource.run(sourceId, acc.id, acc.name || acc.id);
      }
      // Backfill source_id on existing threads
      db.exec(`
        UPDATE threads SET source_id = (
          SELECT inbox_sources.id FROM inbox_sources
          WHERE inbox_sources.external_id = threads.account_id
            AND inbox_sources.source_type = 'personal_messenger'
        )
        WHERE source_id IS NULL
      `);
      // Index for source-based queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_threads_source_id ON threads(source_id);");
      db.exec("DROP INDEX IF EXISTS idx_threads_account_external;");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_source_external ON threads(source_id, external_thread_id) WHERE source_id IS NOT NULL AND external_thread_id IS NOT NULL;");
      db.exec("CREATE INDEX IF NOT EXISTS idx_threads_account_external_lookup ON threads(account_id, external_thread_id);");
      console.log('[DB] Migration v10: Created inbox_sources table, backfilled ' + accounts.length + ' personal sources.');
    }
  },
  {
    version: 11,
    name: 'ensure_source_aware_thread_identity',
    up: (db) => {
      db.exec(`
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
        )
      `);
      try { db.exec("ALTER TABLE threads ADD COLUMN source_id TEXT;"); } catch (e) { }
      const accounts = db.prepare('SELECT id, name FROM accounts').all();
      const insertSource = db.prepare(`
        INSERT OR IGNORE INTO inbox_sources (id, source_type, owner_account_id, external_id, display_name, status)
        VALUES (?, 'personal_messenger', NULL, ?, ?, 'ACTIVE')
      `);
      for (const acc of accounts) {
        insertSource.run('src_personal_' + acc.id, acc.id, acc.name || acc.id);
      }
      db.exec(`
        UPDATE threads SET source_id = (
          SELECT inbox_sources.id FROM inbox_sources
          WHERE inbox_sources.external_id = threads.account_id
            AND inbox_sources.source_type = 'personal_messenger'
        )
        WHERE source_id IS NULL
      `);
      db.exec("DROP INDEX IF EXISTS idx_threads_account_external;");
      db.exec("CREATE INDEX IF NOT EXISTS idx_threads_source_id ON threads(source_id);");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_source_external ON threads(source_id, external_thread_id) WHERE source_id IS NOT NULL AND external_thread_id IS NOT NULL;");
      db.exec("CREATE INDEX IF NOT EXISTS idx_threads_account_external_lookup ON threads(account_id, external_thread_id);");
      console.log('[DB] Migration v11: Ensured source-aware thread identity indexes.');
    }
  },
  {
    version: 20260922001,
    name: 'add_threads_pinned',
    up: (db) => {
      try { db.exec('ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'); } catch (e) { }
    }
  },
  {
    version: 20260921001,
    name: 'add_threads_unread_manual',
    up: (db) => {
      try { db.exec('ALTER TABLE threads ADD COLUMN unread_manual INTEGER NOT NULL DEFAULT 0;'); } catch (e) { }
      try { db.exec('ALTER TABLE threads ADD COLUMN history_completed INTEGER NOT NULL DEFAULT 0;'); } catch (e) { }
    }
  },
  {
    version: 20260919001,
    name: 'add_lead_tags_with_colors',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS lead_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT '#6366F1',
        text_color TEXT NOT NULL DEFAULT '#FFFFFF',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      try { db.exec("ALTER TABLE lead_tags ADD COLUMN text_color TEXT NOT NULL DEFAULT '#FFFFFF';"); } catch (e) { }
      const seed = [
        ['Tiềm năng', '#22C55E', '#FFFFFF'],
        ['Quan tâm', '#F59E0B', '#FFFFFF'],
        ['Cần tư vấn', '#3B82F6', '#FFFFFF']
      ];
      const ins = db.prepare('INSERT OR IGNORE INTO lead_tags (name, color, text_color) VALUES (?, ?, ?)');
      for (const [n, c, tc] of seed) ins.run(n, c, tc);
    }
  },
  {
    version: 12,
    name: 'add_lead_statuses',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lead_statuses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      try { db.exec("ALTER TABLE contacts ADD COLUMN status_id INTEGER REFERENCES lead_statuses(id);"); } catch (e) { }
      const seedStatuses = db.prepare('SELECT COUNT(*) AS count FROM lead_statuses').get().count;
      if (seedStatuses === 0) {
        const insert = db.prepare('INSERT INTO lead_statuses (name, color) VALUES (?, ?)');
        insert.run('Mới', '#2684ff');
        insert.run('Đang xử lý', '#ff6b2c');
        insert.run('Đã chốt', '#0fbd74');
      }
      console.log('[DB] Migration v12: Created lead_statuses table, added contacts.status_id, seeded starter statuses.');
    }
  },
  {
    version: 13,
    name: 'add_message_direction_status',
    up: (db) => {
      ensureMessageDirectionStatus(db);
      console.log('[DB] Migration v13: Added message direction status.');
    }
  },
  {
    version: 14,
    name: "add_bulk_campaigns",
    up: (db) => {
      for (const [name, type] of [["campaign_id", "TEXT"], ["campaign_recipient_id", "TEXT"], ["campaign_attempt_id", "TEXT"], ["idempotency_key", "TEXT"]]) {
        try { db.exec("ALTER TABLE message_queue ADD COLUMN " + name + " " + type + ";"); } catch (e) { }
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_idempotency ON message_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;");
      db.exec(fs.readFileSync(path.join(__dirname, "campaignSchema.sql"), "utf8"));
      console.log("[DB] Migration v14: Added bulk campaign persistence.");
    }
  },
  {
    version: 15,
    name: 'complete_bulk_campaigns',
    up: (db) => {
      const addColumn = (table, name, type) => {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type};`); } catch (error) { }
      };
      addColumn('contacts', 'campaign_opt_out', 'BOOLEAN NOT NULL DEFAULT 0');
      addColumn('campaigns', 'send_cap', 'INTEGER NOT NULL DEFAULT 50');
      addColumn('campaigns', 'quiet_hours_start', "TEXT NOT NULL DEFAULT '00:00'");
      addColumn('campaigns', 'quiet_hours_end', "TEXT NOT NULL DEFAULT '00:00'");
      addColumn('campaigns', 'feature_version', "TEXT NOT NULL DEFAULT '026-v1'");
      addColumn('campaign_attempts', 'attachment_status', "TEXT DEFAULT 'not_requested'");
      addColumn('campaign_attempts', 'attachment_error', 'TEXT');
      addColumn('campaign_audit_events', 'actor_user_id', 'INTEGER');
      addColumn('campaign_audit_events', 'actor_type', "TEXT NOT NULL DEFAULT 'system'");
      addColumn('message_queue', 'source_id', 'TEXT');
      addColumn('message_queue', 'source_type', 'TEXT');
      addColumn('message_queue', 'page_id', 'TEXT');
      addColumn('message_queue', 'attachment_id', 'TEXT');
      addColumn('message_queue', 'attachment_path', 'TEXT');
      addColumn('message_queue', 'attachment_mime_type', 'TEXT');
      addColumn('message_queue', 'attachment_name', 'TEXT');
      db.exec(fs.readFileSync(path.join(__dirname, 'campaignSchema.sql'), 'utf8'));
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_idempotency ON message_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;');
      console.log('[DB] Migration v15: Completed campaign limits, attachments, audit, and queue routing fields.');
    }
  },
  {
    version: 16,
    name: 'add_crm_rich_messaging',
    up: (db) => {
      const addColumn = (table, name, type) => {
        try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + type + ';'); } catch (error) { }
      };
      addColumn('messages', 'attachment_id', 'TEXT REFERENCES outbound_attachments(id)');
      addColumn('messages', 'latest_attempt_id', 'TEXT REFERENCES outbound_attempts(id)');
      addColumn('messages', 'media_name', 'TEXT');
      addColumn('messages', 'media_mime_type', 'TEXT');
      addColumn('messages', 'media_size', 'INTEGER');
      addColumn('message_queue', 'outbound_attempt_id', 'TEXT REFERENCES outbound_attempts(id)');
      addColumn('message_queue', 'attachment_media_type', 'TEXT');
      addColumn('message_queue', 'attachment_byte_size', 'INTEGER');
      addColumn('message_queue', 'attachment_checksum', 'TEXT');
      addColumn('message_queue', 'contract_version', 'INTEGER NOT NULL DEFAULT 1');

      // Re-executing the idempotent schema creates the two new tables after the
      // legacy columns exist. Rich-message queue rows intentionally keep the
      // campaign-owned message_queue.idempotency_key NULL.
      db.exec(schemaSql);
      db.exec('CREATE INDEX IF NOT EXISTS idx_message_queue_outbound_attempt ON message_queue(outbound_attempt_id) WHERE outbound_attempt_id IS NOT NULL;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_latest_attempt ON messages(latest_attempt_id) WHERE latest_attempt_id IS NOT NULL;');
      console.log('[DB] Migration v16: Added CRM rich messaging persistence.');
    }
  },
  {
    version: 17,
    name: 'add_contact_custom_fields',
    up: (db) => {
      try { db.exec("ALTER TABLE contacts ADD COLUMN custom_fields TEXT DEFAULT '[]';"); } catch (e) { }
      console.log('[DB] Migration v17: Added contacts.custom_fields.');
    }
  },
  {
    version: 18,
    name: 'add_contact_address',
    up: (db) => {
      try { db.exec('ALTER TABLE contacts ADD COLUMN address TEXT;'); } catch (e) { }
      console.log('[DB] Migration v18: Added contacts.address.');
    }
  },
  {
    version: 19,
    name: 'add_followup_archive',
    up: (db) => {
      try { db.exec('ALTER TABLE threads ADD COLUMN archived_at DATETIME;'); } catch (e) { }
      db.exec("CREATE TABLE IF NOT EXISTS conversation_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL UNIQUE, due_at DATETIME NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_conversation_reminders_due ON conversation_reminders(status, due_at);");
      console.log('[DB] Migration v19: Added CRM follow-up reminders and archive state.');
    }
  },
  {
    version: 20,
    name: 'add_phone_capture_automation',
    up: (db) => {
      db.exec(`
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
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_contact_phone_captures_thread ON contact_phone_captures(thread_id, message_timestamp_ms);');

      try { db.exec('ALTER TABLE contacts ADD COLUMN phone_source TEXT;'); } catch (e) { }
      try { db.exec('ALTER TABLE contacts ADD COLUMN phone_capture_id INTEGER REFERENCES contact_phone_captures(id);'); } catch (e) { }
      try { db.exec('ALTER TABLE contacts ADD COLUMN phone_captured_at DATETIME;'); } catch (e) { }

      db.exec(`
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
      `);

      try { db.exec("ALTER TABLE campaigns ADD COLUMN phone_capture_policy TEXT NOT NULL DEFAULT 'continue';"); } catch (e) { }
      try { db.exec('ALTER TABLE campaigns ADD COLUMN phone_capture_thank_you_text TEXT;'); } catch (e) { }
      // Deliberately no FK here (unlike contacts.phone_capture_id above) - a
      // campaign must be able to keep pointing at a since-deleted status
      // (FR-012) so a later capture can report phone_capture_status_unavailable,
      // instead of either losing that fact or having the status deletion
      // itself blocked by a dangling reference.
      try { db.exec('ALTER TABLE campaigns ADD COLUMN phone_capture_status_id INTEGER;'); } catch (e) { }

      // Legacy non-empty phone values predate provenance tracking - mark them
      // explicitly protected so PhoneCaptureService never treats a contact
      // that already has a phone as if it were empty (FR-006).
      db.exec("UPDATE contacts SET phone_source = 'legacy' WHERE phone IS NOT NULL AND phone != '' AND phone_source IS NULL;");

      console.log('[DB] Migration v20: Added phone capture automation schema.');
    }
  },
  {
    version: 22,
    name: 'add_global_phone_capture_automation',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS phone_capture_automation_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          is_enabled INTEGER NOT NULL DEFAULT 0 CHECK(is_enabled IN (0, 1)),
          status_id INTEGER REFERENCES lead_statuses(id) ON DELETE SET NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.prepare('INSERT OR IGNORE INTO phone_capture_automation_settings (id, is_enabled, status_id) VALUES (1, 0, NULL)').run();
      console.log('[DB] Migration v22: Added global phone capture automation setting.');
    }
  },
  {
    version: 21,
    name: 'fix_campaign_phone_capture_status_fk',
    up: (db) => {
      // v20 accidentally added phone_capture_status_id with a hard FK to
      // lead_statuses, which would block deleting any status a campaign
      // still references - the opposite of FR-012's intent. SQLite can't
      // drop a column constraint in place, so rebuild the table without it
      // (a fresh install skips straight to the fixed v20 definition above
      // and never needs this).
      const columns = db.prepare('PRAGMA table_info(campaigns)').all();
      if (!columns.some((c) => c.name === 'phone_capture_status_id')) {
        console.log('[DB] Migration v21: campaigns.phone_capture_status_id absent, nothing to fix.');
        return;
      }
      const fkList = db.prepare('PRAGMA foreign_key_list(campaigns)').all();
      const hasStatusFk = fkList.some((fk) => fk.from === 'phone_capture_status_id');
      if (!hasStatusFk) {
        console.log('[DB] Migration v21: campaigns.phone_capture_status_id already has no FK.');
        return;
      }

      // Verified empirically: DROP TABLE on a table other rows reference via
      // ON DELETE CASCADE actually fires those cascades in SQLite, even
      // though it's a schema change, not a DML delete. Every table in that
      // cascade closure (direct + transitive, via campaign_recipients and
      // campaign_messages) must be backed up before the drop and restored
      // after, or this "fix" would silently wipe every campaign's history.
      const cascadeChildren = [
        'campaign_recipients', 'campaign_messages', 'campaign_audit_events',
        'campaign_attempts', 'campaign_phone_capture_actions', 'campaign_attachments'
      ];
      for (const t of cascadeChildren) {
        db.exec('CREATE TEMP TABLE backup_' + t + ' AS SELECT * FROM ' + t);
      }

      db.exec(`
        CREATE TABLE campaigns_v21 (
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
          phone_capture_status_id INTEGER,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
      `);
      db.exec(`
        INSERT INTO campaigns_v21
          (id, name, source_scope, account_scope, status, start_position, direction, pacing_ms,
           max_retries, send_cap, quiet_hours_start, quiet_hours_end, feature_version, created_by,
           created_at, updated_at, started_at, finished_at,
           phone_capture_policy, phone_capture_thank_you_text, phone_capture_status_id)
        SELECT
          id, name, source_scope, account_scope, status, start_position, direction, pacing_ms,
          max_retries, send_cap, quiet_hours_start, quiet_hours_end, feature_version, created_by,
          created_at, updated_at, started_at, finished_at,
          phone_capture_policy, phone_capture_thank_you_text, phone_capture_status_id
        FROM campaigns;
      `);
      db.exec('DROP TABLE campaigns;');
      db.exec('ALTER TABLE campaigns_v21 RENAME TO campaigns;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);');

      // Restore parent-before-child so each row's own FK targets already exist.
      const restoreOrder = [
        'campaign_recipients', 'campaign_messages',
        'campaign_attempts', 'campaign_phone_capture_actions', 'campaign_attachments',
        'campaign_audit_events'
      ];
      for (const t of restoreOrder) {
        const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name).join(',');
        db.exec('DELETE FROM ' + t); // cascade may already have emptied it - ensure clean
        db.exec('INSERT INTO ' + t + ' (' + cols + ') SELECT ' + cols + ' FROM backup_' + t);
        db.exec('DROP TABLE backup_' + t);
      }

      const check = db.prepare('PRAGMA foreign_key_check').all();
      if (check.length > 0) {
        throw new Error('Migration v21 left dangling foreign keys: ' + JSON.stringify(check));
      }
      console.log('[DB] Migration v21: Rebuilt campaigns table without the phone_capture_status_id FK; all campaign history preserved.');
    }
  },
  {
    version: 23,
    name: 'add_campaign_recipient_route_snapshot',
    up: (db) => {
      try { db.exec("ALTER TABLE campaign_recipients ADD COLUMN source_type_snapshot TEXT;"); } catch (e) { }
      try { db.exec("ALTER TABLE campaign_recipients ADD COLUMN source_external_id_snapshot TEXT;"); } catch (e) { }
      try { db.exec("ALTER TABLE campaign_recipients ADD COLUMN source_display_name_snapshot TEXT;"); } catch (e) { }
      console.log('[DB] Migration v23: Added route snapshot columns to campaign_recipients table.');
    }
  },
  {
    version: 24,
    name: 'add_campaign_attachment_manifests',
    up: (db) => {
      db.exec(`
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
      `);
      try { db.exec("ALTER TABLE campaign_attachments ADD COLUMN manifest_id TEXT REFERENCES campaign_attachment_manifests(id) ON DELETE CASCADE;"); } catch (e) { }
      db.exec("CREATE INDEX IF NOT EXISTS idx_campaign_attachments_manifest ON campaign_attachments(manifest_id);");
      console.log('[DB] Migration v24: Added campaign_attachment_manifests table and campaign_attachments.manifest_id (spec 040).');
    }
  },
  {
    version: 25,
    name: 'add_message_queue_manifest_id',
    up: (db) => {
      try { db.exec("ALTER TABLE message_queue ADD COLUMN manifest_id TEXT;"); } catch (e) { }
      console.log('[DB] Migration v25: Added message_queue.manifest_id for manifest-aware dispatch (spec 040).');
    }
  },
  {
    version: 26,
    name: 'add_message_sequence_and_sender_role',
    up: (db) => {
      try { db.exec("ALTER TABLE messages ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'customer' CHECK(sender_role IN ('customer', 'operator'));"); } catch (e) { }
      try { db.exec('ALTER TABLE messages ADD COLUMN sequence_order INTEGER;'); } catch (e) { }
      db.exec(`
        UPDATE messages
        SET sequence_order = COALESCE(sequence_order, id),
            sender_role = CASE WHEN is_outgoing = 1 THEN 'operator' ELSE 'customer' END;
        CREATE TRIGGER IF NOT EXISTS messages_sequence_after_insert AFTER INSERT ON messages BEGIN
          UPDATE messages
          SET sequence_order = COALESCE(new.sequence_order, new.id),
              sender_role = CASE WHEN new.is_outgoing = 1 THEN 'operator' ELSE 'customer' END
          WHERE id = new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS messages_role_after_direction_update AFTER UPDATE OF is_outgoing ON messages BEGIN
          UPDATE messages
          SET sender_role = CASE WHEN new.is_outgoing = 1 THEN 'operator' ELSE 'customer' END
          WHERE id = new.id;
        END;
        CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence ON messages(thread_id, sequence_order, id);
      `);
      console.log('[DB] Migration v26: Added durable message sequence and sender role.');
    }
  },
  {
    version: 27,
    name: 'add_local_user_auth_sessions',
    up: (db) => {
      db.exec(`
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
      `);
      console.log('[DB] Migration v27: Added local CRM user sessions.');
    }
  },
  {
    version: 28,
    name: 'fix_crm_outgoing_call_direction',
    up: (db) => {
      db.exec(`
        UPDATE messages
        SET is_outgoing = 1,
            sender_role = 'operator',
            direction_status = 'confirmed'
        WHERE fb_message_id LIKE 'call_ended_%';
      `);
      console.log('[DB] Migration v28: Corrected CRM-originated call logs to outgoing.');
    }
  },
  {
    version: 29,
    name: 'isolate_facebook_accounts_by_crm_user',
    up: (db) => {
      try { db.exec('ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;'); } catch (error) { }
      db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_owner_user ON accounts(owner_user_id);');
      console.log('[DB] Migration v29: Added per-user ownership for Facebook accounts.');
    }
  },
  {
    version: 30,
    name: 'enterprise_company_membership_and_account_assignments',
    up: (db) => {
      try { db.exec('ALTER TABLE users ADD COLUMN company_id INTEGER;'); } catch (error) { }
      try { db.exec("ALTER TABLE users ADD COLUMN company_role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(company_role IN ('ADMIN','EMPLOYEE'));"); } catch (error) { }
      try { db.exec('ALTER TABLE accounts ADD COLUMN company_id INTEGER;'); } catch (error) { }
      db.exec(`
        UPDATE users SET company_id=id WHERE company_id IS NULL;
        UPDATE accounts SET company_id=owner_user_id WHERE company_id IS NULL;
        CREATE TABLE IF NOT EXISTS account_user_assignments (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(account_id,user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id,company_role);
        CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id);
        CREATE INDEX IF NOT EXISTS idx_account_assignments_user ON account_user_assignments(user_id,account_id);
      `);
      console.log('[DB] Migration v30: Added enterprise membership and Facebook assignments.');
    }
  },
  {
    version: 53,
    name: 'add_local_contact_nickname',
    up: (db) => {
      try { db.exec('ALTER TABLE contacts ADD COLUMN nickname TEXT;'); } catch (error) { }
      console.log('[DB] Migration v53: Verified CRM-only contact nicknames.');
    }
  },
  {
    version: 54,
    name: 'add_google_identity_to_users',
    up: (db) => {
      try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT;'); } catch (error) { }
      try { db.exec('ALTER TABLE users ADD COLUMN email TEXT;'); } catch (error) { }
      try { db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT;'); } catch (error) { }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;');
      console.log('[DB] Migration v54: Added Google identity fields.');
    }
  },
  {
    version: 55,
    name: 'allow_call_media_type_in_messages',
    up: (db) => {
      db.exec(`
        CREATE TABLE messages_v55 (
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

        INSERT INTO messages_v55 (
            id, thread_id, fb_message_id, client_message_id, sender_id, content, media_type, media_url,
            local_media_path, attachment_id, latest_attempt_id, media_name, media_mime_type, media_size,
            is_outgoing, sender_role, sequence_order, direction_status, is_unsent, delivery_status,
            delivery_error, timestamp_ms, timestamp_source, created_at
        )
        SELECT
            id, thread_id, fb_message_id, client_message_id, sender_id, content, media_type, media_url,
            local_media_path, attachment_id, latest_attempt_id, media_name, media_mime_type, media_size,
            is_outgoing, COALESCE(NULLIF(sender_role, ''), CASE WHEN is_outgoing = 1 THEN 'operator' ELSE 'customer' END),
            sequence_order, direction_status, is_unsent, delivery_status,
            delivery_error, timestamp_ms, timestamp_source, created_at
        FROM messages;

        DROP TABLE messages;
        ALTER TABLE messages_v55 RENAME TO messages;

        CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence ON messages(thread_id, sequence_order, id);
        CREATE INDEX IF NOT EXISTS idx_messages_latest_attempt ON messages(latest_attempt_id) WHERE latest_attempt_id IS NOT NULL;

        DROP TRIGGER IF EXISTS messages_ai_insert;
        DROP TRIGGER IF EXISTS messages_ai_update;
        DROP TRIGGER IF EXISTS messages_ai_delete;
        DROP TRIGGER IF EXISTS messages_sequence_after_insert;
        DROP TRIGGER IF EXISTS messages_role_after_direction_update;

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

        CREATE TRIGGER IF NOT EXISTS messages_sequence_after_insert AFTER INSERT ON messages BEGIN
          UPDATE messages
          SET sequence_order = COALESCE(new.sequence_order, new.id),
              sender_role = CASE WHEN new.is_outgoing = 1 THEN 'operator' ELSE 'customer' END
          WHERE id = new.id;
        END;

        CREATE TRIGGER IF NOT EXISTS messages_role_after_direction_update AFTER UPDATE OF is_outgoing ON messages BEGIN
          UPDATE messages
          SET sender_role = CASE WHEN new.is_outgoing = 1 THEN 'operator' ELSE 'customer' END
          WHERE id = new.id;
        END;
      `);
      console.log('[DB] Migration v55: Rebuilt messages table to allow media_type="call".');
    }
  },
  {
    version: 56,
    name: 'add_inbox_folder_to_threads',
    up: (db) => {
      try {
        db.exec("ALTER TABLE threads ADD COLUMN inbox_folder TEXT CHECK(inbox_folder IN ('INBOX', 'MESSAGE_REQUEST_SPAM', 'MESSAGE_REQUEST_POSSIBLE')) DEFAULT 'INBOX';");
        console.log('[DB] Migration v56: Added threads.inbox_folder column.');
      } catch (e) {
        console.log('[DB] Migration v56: threads.inbox_folder already exists, skipped.');
      }
    }
  },
  {
    version: 57,
    name: 'add_campaign_response_events',
    up: (db) => {
      db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_campaign_response_recipient
          ON campaign_response_events(campaign_recipient_id, id);
      `);
    }
  },
  {
    version: 58,
    name: 'store_outbound_video_metadata_natively',
    up: (db) => {
      db.exec(`
        CREATE TABLE outbound_attachments_v58 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          created_by INTEGER,
          original_name TEXT NOT NULL,
          safe_name TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'file')),
          mime_type TEXT NOT NULL,
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
        INSERT INTO outbound_attachments_v58 (
          id, thread_id, created_by, original_name, safe_name, media_type, mime_type,
          byte_size, storage_path, checksum_sha256, status, validation_error,
          created_at, expires_at, consumed_by_message_id
        )
        SELECT
          id, thread_id, created_by, original_name, safe_name,
          CASE
            WHEN lower(safe_name) LIKE '%.mp4' OR lower(storage_path) LIKE '%.mp4' THEN 'video'
            WHEN lower(safe_name) LIKE '%.mov' OR lower(storage_path) LIKE '%.mov' THEN 'video'
            WHEN lower(safe_name) LIKE '%.avi' OR lower(storage_path) LIKE '%.avi' THEN 'video'
            ELSE media_type
          END,
          CASE
            WHEN lower(safe_name) LIKE '%.mp4' OR lower(storage_path) LIKE '%.mp4' THEN 'video/mp4'
            WHEN lower(safe_name) LIKE '%.mov' OR lower(storage_path) LIKE '%.mov' THEN 'video/quicktime'
            WHEN lower(safe_name) LIKE '%.avi' OR lower(storage_path) LIKE '%.avi' THEN 'video/x-msvideo'
            ELSE mime_type
          END,
          byte_size, storage_path, checksum_sha256, status, validation_error,
          created_at, expires_at, consumed_by_message_id
        FROM outbound_attachments;
        DROP TABLE outbound_attachments;
        ALTER TABLE outbound_attachments_v58 RENAME TO outbound_attachments;
        CREATE INDEX IF NOT EXISTS idx_outbound_attachments_thread_status
          ON outbound_attachments(thread_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_outbound_attachments_expiry
          ON outbound_attachments(status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_outbound_attachments_checksum
          ON outbound_attachments(checksum_sha256);
      `);
      console.log('[DB] Migration v58: Outbound video metadata is now stored as video MIME natively.');
    }
  },
  {
    version: 59,
    name: 'allow_video_media_type_in_message_queue',
    up: (db) => {
      const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_queue'").get()?.sql || '';
      if (/attachment_media_type\s+TEXT\s+CHECK\s*\(attachment_media_type\s+IN\s*\([^)]*'video'/i.test(tableSql)) {
        console.log('[DB] Migration v59: message_queue already accepts video.');
        return;
      }
      db.exec(`
        CREATE TABLE message_queue_v59 (
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
          attachment_media_type TEXT CHECK(attachment_media_type IN ('image', 'video', 'file')),
          attachment_byte_size INTEGER CHECK(attachment_byte_size IS NULL OR attachment_byte_size > 0),
          attachment_checksum TEXT,
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
        INSERT INTO message_queue_v59 (
          id, thread_id, account_id, source_id, source_type, page_id, content,
          attachment_id, attachment_path, attachment_mime_type, attachment_name,
          outbound_attempt_id, attachment_media_type, attachment_byte_size,
          attachment_checksum, manifest_id, contract_version, campaign_id,
          campaign_recipient_id, campaign_attempt_id, idempotency_key, status,
          error_reason, created_at, processed_at
        )
        SELECT
          id, thread_id, account_id, source_id, source_type, page_id, content,
          attachment_id, attachment_path, attachment_mime_type, attachment_name,
          outbound_attempt_id, attachment_media_type, attachment_byte_size,
          attachment_checksum, manifest_id, contract_version, campaign_id,
          campaign_recipient_id, campaign_attempt_id, idempotency_key, status,
          error_reason, created_at, processed_at
        FROM message_queue;
        DROP TABLE message_queue;
        ALTER TABLE message_queue_v59 RENAME TO message_queue;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_idempotency
          ON message_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_message_queue_outbound_attempt
          ON message_queue(outbound_attempt_id) WHERE outbound_attempt_id IS NOT NULL;
      `);
      console.log('[DB] Migration v59: message_queue now accepts image/video/file attachments.');
    }
  },
  {
    version: 60,
    name: 'persist_facebook_account_avatar',
    up: (db) => {
      try { db.exec('ALTER TABLE accounts ADD COLUMN avatar_url TEXT;'); } catch (error) { }
      console.log('[DB] Migration v60: Facebook account avatars are now persisted.');
    }
  },
  {
    version: 61,
    name: 'create_quick_templates_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quick_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          content TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_quick_templates_sort ON quick_templates(sort_order, id);
      `);
      const count = db.prepare('SELECT COUNT(*) as count FROM quick_templates').get().count;
      if (count === 0) {
        const insert = db.prepare('INSERT INTO quick_templates (content, sort_order) VALUES (?, ?)');
        const defaults = [
          'Dạ chào bạn! Shop có thể hỗ trợ gì cho bạn ạ?',
          'Sản phẩm hiện đang có sẵn hàng, shop ship ngay trong ngày nha anh/chị!',
          'Bạn cho shop xin SĐT và địa chỉ để tạo đơn ngay nhé ạ!',
          'Shop xin cảm ơn và chúc bạn một ngày tốt lành!'
        ];
        defaults.forEach((content, idx) => insert.run(content, idx + 1));
      }
      console.log('[DB] Migration v61: Created quick_templates table and seeded defaults.');
    }
  },
  {
    version: 62,
    name: 'merge_namespaced_page_threads_into_bare',
    // Gộp trùng chủ đích: xoá row namespaced sau khi merge về bare -> giảm
    // số row threads/messages là hành vi đúng, không phải lỗi phá huỷ dữ liệu.
    allowsRowCountReduction: true,
    up: (db) => {
      // Bare-first policy (2026-09-19): page threads are canonically keyed by
      // the bare Facebook id. Namespaced rows (`page:<pageId>:<psid>`) minted
      // by the earlier policy duplicated every customer whose bare row already
      // existed, broke tab navigation routing (page_id resolved NULL for the
      // bare row) and tripped the UNIQUE(source_id, external_thread_id) index.
      // Merge each namespaced row into its bare twin, then drop it.
      const nsRows = db.prepare("SELECT id, external_thread_id, account_id, source_id FROM threads WHERE id LIKE 'page:%:%'").all();
      let merged = 0;
      let skipped = 0;
      for (const ns of nsRows) {
        const parts = String(ns.id).split(':');
        if (parts.length !== 3) continue;
        const pageId = parts[1];
        const bareId = parts[2];
        if (!/^\d+$/.test(bareId)) continue;

        const bare = db.prepare('SELECT id, source_id FROM threads WHERE id = ? AND account_id = ?').get(bareId, ns.account_id);
        const nsSource = ns.source_id || `src_page_${pageId}`;
        if (!bare) {
          // No bare twin -> rename this row to the bare id when free.
          const taken = db.prepare('SELECT id FROM threads WHERE id = ?').get(bareId);
          if (taken) { skipped += 1; continue; }
          db.prepare('UPDATE threads SET id = ?, external_thread_id = ? WHERE id = ?').run(bareId, bareId, ns.id);
          merged += 1;
          continue;
        }
        // Only merge when the bare row is unbound or owned by the SAME page
        // source. A bare row owned by a different page/personal source is a
        // genuine separate conversation - leave the pair alone.
        if (bare.source_id && bare.source_id !== nsSource) { skipped += 1; continue; }

        // 1. Move messages by re-pointing thread_id IN PLACE. (An
        // INSERT...SELECT copy would collide with the original rows on the
        // UNIQUE fb_message_id index while they still exist and OR IGNORE
        // would silently drop every row - reproduced on the real DB.)
        db.prepare('UPDATE OR IGNORE messages SET thread_id = ? WHERE thread_id = ?').run(bareId, ns.id);
        db.prepare('DELETE FROM messages WHERE thread_id = ?').run(ns.id);

        // 2. Re-point every other table carrying a thread_id column.
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
        for (const table of tables) {
          if (table === 'threads' || table === 'messages' || table === 'contacts' || table.startsWith('messages_fts')) continue;
          const cols = db.prepare(`PRAGMA table_info(${table})`).all();
          if (!cols.some((c) => c.name === 'thread_id')) continue;
          try {
            db.prepare(`UPDATE OR IGNORE ${table} SET thread_id = ? WHERE thread_id = ?`).run(bareId, ns.id);
            db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(ns.id);
          } catch (_) {}
        }

        // 3. Merge the contact row (thread_id is the PK there) and drop the twin.
        const nsContact = db.prepare('SELECT name, avatar_url FROM contacts WHERE thread_id = ?').get(ns.id);
        if (nsContact) {
          db.prepare(`
            INSERT INTO contacts (thread_id, name, avatar_url)
            VALUES (?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
              name = COALESCE(contacts.name, excluded.name),
              avatar_url = COALESCE(contacts.avatar_url, excluded.avatar_url)
          `).run(bareId, nsContact.name, nsContact.avatar_url);
          db.prepare('DELETE FROM contacts WHERE thread_id = ?').run(ns.id);
        }

        // 4. Drop the namespaced thread row (references are gone now).
        db.prepare('DELETE FROM threads WHERE id = ?').run(ns.id);

        // 5. Bind the page source onto the bare row (safe - the twin is gone).
        if (!bare.source_id) {
          try { db.prepare('UPDATE threads SET source_id = ? WHERE id = ?').run(nsSource, bareId); } catch (_) {}
        }
        merged += 1;
      }
      console.log(`[DB] Migration v62: Merged ${merged} namespaced page thread(s) into bare ids (skipped ${skipped} genuine cross-page collisions).`);
    }
  },
  {
    version: 63,
    name: 'add_profile_url_to_contacts',
    up: (db) => {
      try {
        db.exec('ALTER TABLE contacts ADD COLUMN profile_url TEXT;');
        console.log('[DB] Migration v63: Added contacts.profile_url column.');
      } catch (e) {
        console.log('[DB] Migration v63: contacts.profile_url already exists, skipped.');
      }
    }
  },
  {
    version: 64,
    name: 'add_threads_history_completed',
    up: (db) => {
      try {
        db.exec('ALTER TABLE threads ADD COLUMN history_completed INTEGER NOT NULL DEFAULT 0;');
        console.log('[DB] Migration v64: Added threads.history_completed column.');
      } catch (e) {
        console.log('[DB] Migration v64: threads.history_completed already exists, skipped.');
      }
    }
  }
];

function runMigrations() {
  const legacy57 = db.prepare("SELECT version, name FROM migrations WHERE version = 57 AND name = 'create_quick_templates_table'").get();
  if (legacy57) {
    db.prepare("UPDATE migrations SET version = 61 WHERE version = 57 AND name = 'create_quick_templates_table'").run();
  }
  const appliedVersions = new Set(db.prepare('SELECT version FROM migrations').all().map(r => r.version));
  const pending = migrations.filter(m => !appliedVersions.has(m.version));
  if (pending.length > 0) {
    const beforeCounts = {
      threads: db.prepare('SELECT COUNT(*) AS count FROM threads').get().count,
      messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
    };
    console.log(`[DB] Found ${pending.length} pending migrations.`);

    const insertMigration = db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)');
    const migrate = db.transaction((pendingMigrations) => {
      for (const m of pendingMigrations) {
        console.log(`[DB] Running migration v${m.version}: ${m.name}`);
        m.up(db);
        insertMigration.run(m.version, m.name);
      }
    });

    try {
      db.pragma('foreign_keys = OFF');
      migrate(pending);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    try {
      console.log('[DB] Migrations applied successfully.');

      // Integrity check
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        throw new Error('SQLite integrity check failed: ' + integrity);
      }
      const afterCounts = {
        threads: db.prepare('SELECT COUNT(*) AS count FROM threads').get().count,
        messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
      };
      const expectedMessageReduction = pending.some(m => m.allowsMessageRowReduction);
      const expectedRowCountReduction = pending.some(m => m.allowsRowCountReduction);
      if ((afterCounts.threads < beforeCounts.threads && !expectedRowCountReduction)
        || (afterCounts.messages < beforeCounts.messages && !expectedMessageReduction && !expectedRowCountReduction)) {
        throw new Error('Migration reduced persisted thread/message row counts');
      }
    } catch (err) {
      console.error('[DB] Migration failed; startup aborted to protect persisted data:', err);
      throw err;
    }
  }
}

runMigrations();

// Tạo index hỗ trợ query messages sau khi đảm bảo các cột đã tồn tại
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_thread_timestamp 
  ON messages(thread_id, timestamp_ms, created_at, id);
`);

// Thêm Admin mặc định nếu CSDL chưa có user
const adminCheck = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'").get();
if (adminCheck.count === 0) {
  const defaultPassword = 'admin123';
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'ADMIN')").run('admin', passwordHash);
  console.log('[DB] Khởi tạo tài khoản Admin mặc định thành công (username: admin / pass: admin123)');
}

try {
  db.prepare("DELETE FROM messages WHERE content LIKE '%Chưa có tin nhắn%' OR content LIKE '%ChÃ%' OR (content LIKE '%tin nh%' AND content LIKE '%n%')").run();
  db.prepare("UPDATE threads SET last_message = 'Chưa có tin nhắn' WHERE last_message LIKE '%ChÃ%'").run();
} catch (e) {}

console.log('[DB] CSDL SQLite đã sẵn sàng (WAL Mode, FTS5 enabled):', DB_PATH);

module.exports = db;
