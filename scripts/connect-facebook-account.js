const processManager = require('../src/server/services/ProcessManager');

const accountId = process.argv[2];
if (!accountId) throw new Error('Missing Facebook account id');

processManager.startAccountProcess(String(accountId))
  .then((started) => {
    if (!started) throw new Error(`Could not start Facebook account ${accountId}`);
    console.log(`FACEBOOK_ACCOUNT_READY ${accountId}`);
    setInterval(() => {}, 30000);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
