const serverRuntime = require('./server');

console.log('=== KHOI DONG HE THONG AUTOCHATBOT FB CRM BACKEND ===');
const startupPromise = serverRuntime.startServer();

module.exports = { ...serverRuntime, startupPromise };
