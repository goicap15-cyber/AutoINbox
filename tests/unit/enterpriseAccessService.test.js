const test = require('node:test');
const assert = require('node:assert/strict');
const { getTestDatabase } = require('../helpers/testDatabase');
const { EnterpriseAccessService } = require('../../src/server/services/EnterpriseAccessService');

test('company admin assigns accounts and employee only sees assigned accounts', () => {
  const db = getTestDatabase();
  try {
    db.prepare("INSERT INTO users(username,password_hash,role,company_id,company_role) VALUES ('owner','x','STAFF',1,'ADMIN')").run();
    db.prepare("INSERT INTO users(username,password_hash,role,company_id,company_role) VALUES ('worker','x','STAFF',1,'EMPLOYEE')").run();
    const owner = db.prepare("SELECT * FROM users WHERE username='owner'").get();
    const worker = db.prepare("SELECT * FROM users WHERE username='worker'").get();
    db.prepare("INSERT INTO accounts(id,name,profile_dir,owner_user_id,company_id) VALUES ('fb-a','A','a',?,1)").run(owner.id);
    db.prepare("INSERT INTO accounts(id,name,profile_dir,owner_user_id,company_id) VALUES ('fb-b','B','b',?,1)").run(owner.id);
    const service = new EnterpriseAccessService(db);
    service.setAssignments(owner, worker.id, ['fb-b']);
    assert.deepEqual(service.listAccounts(worker).map(row => row.id), ['fb-b']);
    assert.equal(service.canAccessAccount(worker, 'fb-a'), false);
    assert.equal(service.canAccessAccount(worker, 'fb-b'), true);
    assert.deepEqual(service.listAccounts(owner).map(row => row.id).sort(), ['fb-a', 'fb-b']);
  } finally { db.close(); }
});

test('assignment rejects an account from another company', () => {
  const db = getTestDatabase();
  try {
    db.prepare("INSERT INTO users(username,password_hash,role,company_id,company_role) VALUES ('owner','x','STAFF',1,'ADMIN')").run();
    db.prepare("INSERT INTO users(username,password_hash,role,company_id,company_role) VALUES ('worker','x','STAFF',1,'EMPLOYEE')").run();
    const owner = db.prepare("SELECT * FROM users WHERE username='owner'").get();
    const worker = db.prepare("SELECT * FROM users WHERE username='worker'").get();
    db.prepare("INSERT INTO accounts(id,name,profile_dir,company_id) VALUES ('foreign','Foreign','f',2)").run();
    const service = new EnterpriseAccessService(db);
    assert.throws(() => service.setAssignments(owner, worker.id, ['foreign']), /không thuộc công ty/i);
  } finally { db.close(); }
});
