const db = require('../src/server/database/db');
console.log('=== ATTEMPTS ===');
console.table(db.prepare('SELECT id, status, error_code, error_message, created_at FROM outbound_attempts ORDER BY id DESC LIMIT 5').all());
