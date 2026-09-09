const Database = require('better-sqlite3');
const database = new Database('data/database.db');
const result = database.prepare(`
  UPDATE messages
  SET delivery_status = 'failed', delivery_error = 'Old send session did not return ACK'
  WHERE delivery_status = 'pending'
`).run();
console.log(JSON.stringify({ pending_reset: result.changes }));
database.close();
