const fs = require('fs');
const MessageQueueRepository = require('../repositories/MessageQueueRepository');
const OutboundAttachmentRepository = require('../repositories/OutboundAttachmentRepository');
const OutboundAttemptRepository = require('../repositories/OutboundAttemptRepository');
const { checksumSha256 } = require('./attachmentValidation');

class QueueWorker {
  constructor() {
    this.isRunning = false;
    this.getExtensionConnection = null;
    this.isCampaignEnabled = () => false;
    this.onQueueFail = null;
    this.database = null;
  }

  configure(config) {
    if (config.getConnection) this.getExtensionConnection = config.getConnection;
    if (config.onQueueFail) this.onQueueFail = config.onQueueFail;
    if (config.campaignEnabled) this.isCampaignEnabled = config.campaignEnabled;
    if (config.database) this.database = config.database;
  }

  getDatabaseArgument() {
    return this.database || undefined;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop();
    console.log('[QueueWorker] Started.');
  }

  stop() {
    this.isRunning = false;
    console.log('[QueueWorker] Stopped.');
  }

  fail(message, reason) {
    const database = this.getDatabaseArgument();
    MessageQueueRepository.updateStatus(message.id, 'failed', reason, database);
    if (message.outbound_attempt_id) {
      OutboundAttemptRepository.transition(
        message.outbound_attempt_id,
        ['queued', 'dispatching', 'awaiting_confirmation'],
        'failed',
        { error_code: reason, error_message: reason },
        database
      );
      if (message.attachment_id) {
        OutboundAttachmentRepository.transition(
          message.attachment_id,
          ['queued', 'sending'],
          'failed',
          { validation_error: reason },
          database
        );
      }
    }
    if (this.onQueueFail) this.onQueueFail(message, reason);
  }

  buildAttachment(message) {
    if (!message.attachment_id) return null;
    if (!message.attachment_path || !message.attachment_mime_type || !fs.existsSync(message.attachment_path)) {
      throw new Error('ATTACHMENT_UNAVAILABLE');
    }
    const bytes = fs.readFileSync(message.attachment_path);
    if (
      Number(message.contract_version) === 2 &&
      (
        bytes.length !== Number(message.attachment_byte_size) ||
        checksumSha256(bytes) !== message.attachment_checksum
      )
    ) {
      throw new Error('ATTACHMENT_INTEGRITY_MISMATCH');
    }
    return {
      id: message.attachment_id,
      media_type: message.attachment_media_type || 'image',
      mime_type: message.attachment_mime_type,
      name: message.attachment_name,
      byte_size: bytes.length,
      checksum_sha256: message.attachment_checksum || checksumSha256(bytes),
      // The backend and extension always run on the same machine (desktop
      // Electron app), and Facebook's current Business Suite/Messenger
      // composers open a native OS file chooser rather than exposing a
      // scriptable <input type="file">. A base64 byte payload has nothing to
      // attach to; a real local path lets the extension supply the file via
      // CDP's Page.handleFileChooser instead (see background.js).
      local_path: message.attachment_path
    };
  }

  // Spec 040: several independently-selected files, or one folder ZIP,
  // dispatched together as one manifest. Reads member rows straight from
  // campaign_attachments (they already carry their own checksum/byte_size -
  // no need to duplicate that data onto message_queue). Any single member
  // failing its integrity check fails the WHOLE manifest, matching
  // CampaignAttachmentService.saveFolderAsZip's "reject the whole thing, not
  // silently a partial send" rule.
  buildAttachmentManifest(message, database) {
    if (!message.manifest_id) return null;
    const db = database || require('../database/db');
    const rows = db.prepare(
      'SELECT * FROM campaign_attachments WHERE manifest_id = ? ORDER BY created_at ASC, id ASC'
    ).all(message.manifest_id);
    if (!rows.length) throw new Error('ATTACHMENT_MANIFEST_EMPTY');
    return rows.map((row) => {
      if (!row.storage_path || !row.mime_type || !fs.existsSync(row.storage_path)) {
        throw new Error('ATTACHMENT_UNAVAILABLE');
      }
      const bytes = fs.readFileSync(row.storage_path);
      if (
        Number(message.contract_version) === 2 &&
        (bytes.length !== Number(row.byte_size) || checksumSha256(bytes) !== row.checksum)
      ) {
        throw new Error('ATTACHMENT_INTEGRITY_MISMATCH');
      }
      return {
        id: row.id,
        media_type: row.media_type || 'file',
        mime_type: row.mime_type,
        name: row.original_name,
        byte_size: bytes.length,
        checksum_sha256: row.checksum || checksumSha256(bytes),
        local_path: row.storage_path
      };
    });
  }

  async processNext() {
    const database = this.getDatabaseArgument();
    const message = MessageQueueRepository.popPending(database);
    if (!message) return null;

    if (message.campaign_id && !this.isCampaignEnabled()) {
      this.fail(message, 'CAMPAIGN_FEATURE_DISABLED');
      return { message, outcome: 'failed' };
    }

    const isRich = Number(message.contract_version) === 2 && Boolean(message.outbound_attempt_id);
    const routeInvalid = (message.campaign_id || isRich) && (
      !message.account_id ||
      !message.source_id ||
      !['personal_messenger', 'page_messenger'].includes(message.source_type) ||
      (message.source_type === 'page_messenger' && !message.page_id)
    );
    if (routeInvalid) {
      this.fail(message, message.campaign_id ? 'CAMPAIGN_ROUTE_INVALID' : 'RICH_MESSAGE_ROUTE_INVALID');
      return { message, outcome: 'failed' };
    }

    let attachment = null;
    let attachmentManifest = null;
    try {
      if (message.manifest_id) {
        attachmentManifest = this.buildAttachmentManifest(message, database);
      } else {
        attachment = this.buildAttachment(message);
      }
    } catch (error) {
      this.fail(message, error.message || 'ATTACHMENT_UNAVAILABLE');
      return { message, outcome: 'failed' };
    }

    if (isRich) {
      const transitioned = OutboundAttemptRepository.transition(
        message.outbound_attempt_id,
        ['queued'],
        'dispatching',
        { dispatch_method: 'rich-message-v1', dispatched_at: new Date().toISOString() },
        database
      );
      if (!transitioned) {
        this.fail(message, 'OUTBOUND_ATTEMPT_STATE_CONFLICT');
        return { message, outcome: 'failed' };
      }
      if (message.attachment_id) {
        OutboundAttachmentRepository.transition(
          message.attachment_id,
          ['queued'],
          'sending',
          {},
          database
        );
      }
    }

    const ws = this.getExtensionConnection ? this.getExtensionConnection(message.account_id) : null;
    if (!ws || ws.readyState !== 1) {
      console.warn('[QueueWorker] Extension not connected for account ' + message.account_id + '.');
      this.fail(message, 'EXTENSION_NOT_CONNECTED');
      return { message, outcome: 'failed' };
    }

    const envelope = {
      type: 'SEND_QUEUED_MESSAGE',
      data: {
        contract_version: (isRich || message.campaign_id) ? 2 : 1,
        queue_id: message.id,
        outbound_attempt_id: message.outbound_attempt_id || null,
        thread_id: message.thread_id,
        thread_url: message.thread_url || null,
        expected_contact_name: message.expected_contact_name || null,
        account_id: message.account_id,
        content: message.content,
        source_type: message.source_type,
        page_id: message.page_id,
        source_id: message.source_id || null,
        attachment,
        attachment_manifest: attachmentManifest,
        campaign_id: message.campaign_id || null,
        campaign_recipient_id: message.campaign_recipient_id || null,
        campaign_attempt_id: message.campaign_attempt_id || null,
        idempotency_key: message.idempotency_key || null
      }
    };

    console.log('[QueueWorker] Dispatching message ' + message.id + ' for account ' + message.account_id);
    try {
      ws.send(JSON.stringify(envelope));
    } catch (error) {
      this.fail(message, 'EXTENSION_DISPATCH_FAILED');
      return { message, outcome: 'failed' };
    }
    return { message, envelope, outcome: 'dispatched' };
  }

  async loop() {
    while (this.isRunning) {
      try {
        const result = await this.processNext();
        if (result) {
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3000) + 2000));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error('[QueueWorker] Error in loop:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
}

module.exports = new QueueWorker();
