const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTestDatabase } = require('../helpers/testDatabase');

// Helper to run tests in an isolated temporary SQLite database
function withTestDb(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-quick-templates-test-'));
  const dbFile = path.join(dir, 'test.db');
  const db = getTestDatabase(dbFile);
  try {
    return run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Emulate GET /api/quick-templates handler
function handleGetQuickTemplates(db) {
  return db.prepare('SELECT id, title, content, sort_order, created_at FROM quick_templates ORDER BY sort_order ASC, id ASC').all();
}

// Emulate POST /api/quick-templates handler
function handlePostQuickTemplate(body, db) {
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : null;

  if (!content) {
    return { status: 400, error: 'Nội dung mẫu câu không được để trống.' };
  }
  if (content.length > 2000) {
    return { status: 400, error: 'Nội dung mẫu câu không được vượt quá 2000 ký tự.' };
  }

  const allTemplates = db.prepare('SELECT id, content FROM quick_templates').all();
  const normalizedNew = content.toLowerCase();
  const isDuplicate = allTemplates.some(t => String(t.content || '').trim().toLowerCase() === normalizedNew);
  if (isDuplicate) {
    return { status: 400, error: 'Mẫu câu này đã tồn tại trong danh sách.' };
  }

  const maxOrderRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM quick_templates').get();
  const nextOrder = (maxOrderRow?.max_order || 0) + 1;
  const stmt = db.prepare('INSERT INTO quick_templates (title, content, sort_order) VALUES (?, ?, ?)');
  const info = stmt.run(title, content, nextOrder);
  const created = db.prepare('SELECT id, title, content, sort_order, created_at FROM quick_templates WHERE id = ?').get(info.lastInsertRowid);
  return { status: 200, template: created };
}

// Emulate DELETE /api/quick-templates/:id handler
function handleDeleteQuickTemplate(idParam, db) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, error: 'id mẫu câu không hợp lệ' };
  }
  const result = db.prepare('DELETE FROM quick_templates WHERE id = ?').run(id);
  if (result.changes === 0) {
    return { status: 404, error: 'Không tìm thấy mẫu câu để xóa.' };
  }
  return { status: 200, success: true, deleted: true };
}

test('quick_templates schema exists in isolated database', () => withTestDb((db) => {
  const columns = db.prepare("PRAGMA table_info(quick_templates)").all().map(c => c.name);
  assert.ok(columns.includes('id'));
  assert.ok(columns.includes('title'));
  assert.ok(columns.includes('content'));
  assert.ok(columns.includes('sort_order'));
  assert.ok(columns.includes('created_at'));
  assert.ok(columns.includes('updated_at'));
}));

test('GET returns empty array when no templates exist', () => withTestDb((db) => {
  const result = handleGetQuickTemplates(db);
  assert.deepEqual(result, []);
}));

test('POST creates template and GET returns in sorted order', () => withTestDb((db) => {
  const post1 = handlePostQuickTemplate({ content: 'Mẫu thứ nhất' }, db);
  assert.equal(post1.status, 200);
  assert.equal(post1.template.content, 'Mẫu thứ nhất');
  assert.equal(post1.template.sort_order, 1);

  const post2 = handlePostQuickTemplate({ content: 'Mẫu thứ hai', title: 'Tiêu đề 2' }, db);
  assert.equal(post2.status, 200);
  assert.equal(post2.template.sort_order, 2);
  assert.equal(post2.template.title, 'Tiêu đề 2');

  const list = handleGetQuickTemplates(db);
  assert.equal(list.length, 2);
  assert.equal(list[0].content, 'Mẫu thứ nhất');
  assert.equal(list[1].content, 'Mẫu thứ hai');
}));

test('POST rejects empty or whitespace-only content', () => withTestDb((db) => {
  const resEmpty = handlePostQuickTemplate({ content: '' }, db);
  assert.equal(resEmpty.status, 400);

  const resSpaces = handlePostQuickTemplate({ content: '   ' }, db);
  assert.equal(resSpaces.status, 400);
}));

test('POST rejects content exceeding 2000 characters', () => withTestDb((db) => {
  const longContent = 'A'.repeat(2001);
  const res = handlePostQuickTemplate({ content: longContent }, db);
  assert.equal(res.status, 400);
  assert.match(res.error, /2000/);
}));

test('POST rejects duplicate content case-insensitively (ASCII & Vietnamese Unicode)', () => withTestDb((db) => {
  // ASCII duplicate
  const firstAscii = handlePostQuickTemplate({ content: 'Hello World' }, db);
  assert.equal(firstAscii.status, 200);
  const dupAscii = handlePostQuickTemplate({ content: 'hello world' }, db);
  assert.equal(dupAscii.status, 400);
  assert.match(dupAscii.error, /đã tồn tại/);

  // Vietnamese Unicode duplicate 1: ĐÃ GỬI vs đã gửi
  const firstVi1 = handlePostQuickTemplate({ content: 'ĐÃ GỬI' }, db);
  assert.equal(firstVi1.status, 200);
  const dupVi1 = handlePostQuickTemplate({ content: 'đã gửi' }, db);
  assert.equal(dupVi1.status, 400);
  assert.match(dupVi1.error, /đã tồn tại/);

  // Vietnamese Unicode duplicate 2: MẪU BÁO GIÁ vs mẫu báo giá
  const firstVi2 = handlePostQuickTemplate({ content: 'MẪU BÁO GIÁ' }, db);
  assert.equal(firstVi2.status, 200);
  const dupVi2 = handlePostQuickTemplate({ content: 'mẫu báo giá' }, db);
  assert.equal(dupVi2.status, 400);
  assert.match(dupVi2.error, /đã tồn tại/);
}));

test('DELETE returns 404 when ID does not exist', () => withTestDb((db) => {
  const res = handleDeleteQuickTemplate(99999, db);
  assert.equal(res.status, 404);
  assert.match(res.error, /Không tìm thấy/);
}));

test('DELETE rejects invalid ID', () => withTestDb((db) => {
  const resInvalid = handleDeleteQuickTemplate('abc', db);
  assert.equal(resInvalid.status, 400);

  const resNegative = handleDeleteQuickTemplate(-1, db);
  assert.equal(resNegative.status, 400);
}));

test('DELETE successfully removes template and allows clearing to empty array', () => withTestDb((db) => {
  const created = handlePostQuickTemplate({ content: 'Cần xóa' }, db);
  assert.equal(created.status, 200);

  const del = handleDeleteQuickTemplate(created.template.id, db);
  assert.equal(del.status, 200);
  assert.equal(del.deleted, true);

  // When all are deleted, GET returns empty list []
  const after = handleGetQuickTemplates(db);
  assert.deepEqual(after, []);
}));
