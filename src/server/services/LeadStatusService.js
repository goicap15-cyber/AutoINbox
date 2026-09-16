class LeadStatusValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeadStatusValidationError';
  }
}

function normalizeInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const color = typeof input?.color === 'string' ? input.color.trim() : '';

  if (!name) {
    throw new LeadStatusValidationError('Thi?u name h?p l?');
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    throw new LeadStatusValidationError(
      'Mã màu không hợp lệ. Chỉ chấp nhận định dạng #RRGGBB (6 ký tự hex, không có alpha).'
    );
  }

  return { name, color: color.toUpperCase() };
}

function create(input, database) {
  const normalized = normalizeInput(input);
  const existing = database
    .prepare('SELECT id, name, color FROM lead_statuses WHERE name = ?')
    .get(normalized.name);
  if (existing) return existing;

  const info = database
    .prepare('INSERT INTO lead_statuses (name, color) VALUES (?, ?)')
    .run(normalized.name, normalized.color);

  return {
    id: Number(info.lastInsertRowid),
    name: normalized.name,
    color: normalized.color
  };
}

module.exports = {
  LeadStatusValidationError,
  normalizeInput,
  create
};
