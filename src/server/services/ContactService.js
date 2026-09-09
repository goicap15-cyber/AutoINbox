/**
 * Shared persistence boundary for contact details and tags.
 * The Express route and integration tests call this same code to avoid SQL drift.
 */

class PhoneCaptureNotFoundError extends Error {
  constructor(message = 'Không tìm thấy số điện thoại ứng viên này.') {
    super(message);
    this.code = 'PHONE_CAPTURE_NOT_FOUND';
  }
}

function sourceCapturedAt(capture) {
  const timestampMs = Number(capture?.message_timestamp_ms);
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    return new Date(timestampMs).toISOString();
  }
  return capture?.detected_at || null;
}

function update(threadId, payload = {}, database) {
  const { name, email, address, notes, tags, lead_captured, avatar_url, status_id, custom_fields, phone_capture_id } = payload;
  const hasNickname = Object.prototype.hasOwnProperty.call(payload, 'nickname');
  const nickname = hasNickname ? String(payload.nickname || '').trim() : undefined;
  if (nickname !== undefined && nickname.length > 80) {
    const error = new Error('Biệt danh không được vượt quá 80 ký tự.');
    error.code = 'NICKNAME_TOO_LONG';
    throw error;
  }
  let { phone } = payload;
  const serializedTags = JSON.stringify(Array.isArray(tags) ? tags : []);
  const serializedCustomFields = JSON.stringify(Array.isArray(custom_fields) ? custom_fields : []);

  const existing = database.prepare(
    'SELECT phone, phone_source, phone_capture_id, phone_captured_at FROM contacts WHERE thread_id = ?'
  ).get(threadId);

  // Provenance (spec 035): preserved by default, only changed by an
  // explicit candidate acceptance (`phone_capture_id`) or a manual edit that
  // actually changes the phone value. A payload that omits `phone`, or
  // resends the same value, must never reset/clear provenance.
  let phoneSource = existing ? existing.phone_source : null;
  let phoneCaptureId = existing ? existing.phone_capture_id : null;
  let phoneCapturedAt = existing ? existing.phone_captured_at : null;

  if (phone_capture_id != null) {
    const capture = database.prepare(
      'SELECT * FROM contact_phone_captures WHERE id = ? AND thread_id = ?'
    ).get(phone_capture_id, threadId);
    if (!capture) throw new PhoneCaptureNotFoundError();
    phone = capture.normalized_phone;
    phoneSource = 'message_capture';
    phoneCaptureId = capture.id;
    phoneCapturedAt = sourceCapturedAt(capture);
  } else if (phone && (!existing || phone !== existing.phone)) {
    phoneSource = 'manual';
    phoneCaptureId = null;
    phoneCapturedAt = null;
  }

  database.prepare(`
    INSERT INTO contacts
      (thread_id, name, nickname, phone, email, address, notes, tags, lead_captured, avatar_url, status_id,
       custom_fields, phone_source, phone_capture_id, phone_captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      nickname = CASE WHEN ? THEN excluded.nickname ELSE contacts.nickname END,
      phone = COALESCE(excluded.phone, contacts.phone),
      email = COALESCE(excluded.email, contacts.email),
      address = COALESCE(excluded.address, contacts.address),
      notes = excluded.notes, tags = excluded.tags,
      lead_captured = excluded.lead_captured,
      avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
      status_id = excluded.status_id,
      custom_fields = excluded.custom_fields,
      phone_source = excluded.phone_source,
      phone_capture_id = excluded.phone_capture_id,
      phone_captured_at = excluded.phone_captured_at
  `).run(
    threadId,
    name || null,
    nickname || null,
    phone || null,
    email || null,
    address == null ? null : String(address).trim(),
    notes || null,
    serializedTags,
    lead_captured ? 1 : 0,
    avatar_url || null,
    status_id || null,
    serializedCustomFields,
    phoneSource,
    phoneCaptureId,
    phoneCapturedAt,
    hasNickname ? 1 : 0
  );

  if (phone_capture_id != null) {
    // Only one capture can be the selected one for this thread at a time -
    // demote whatever was previously selected, then mark the new choice.
    database.prepare(`
      UPDATE contact_phone_captures SET selection_state = 'candidate'
      WHERE thread_id = ? AND selection_state = 'selected' AND id != ?
    `).run(threadId, phoneCaptureId);
    database.prepare(
      "UPDATE contact_phone_captures SET selection_state = 'selected' WHERE id = ?"
    ).run(phoneCaptureId);
  }

  return database.prepare('SELECT * FROM contacts WHERE thread_id = ?').get(threadId);
}

module.exports = { update, PhoneCaptureNotFoundError };
