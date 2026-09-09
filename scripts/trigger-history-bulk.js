const Database = require('better-sqlite3');

async function trigger() {
  const database = new Database('data/database.db', { readonly: true });
  const accountId = '100004449999465';
  const threads = database.prepare(`
    SELECT id AS thread_id, thread_url, contact_name
    FROM threads
    WHERE account_id = ?
    ORDER BY last_activity DESC
  `).all(accountId);
  database.close();

  const targets = await (await fetch('http://127.0.0.1:50870/json')).json();
  const worker = targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  if (!worker) throw new Error('CRM history worker is not running');
  const payload = {
    job_id: `manual_${Date.now()}`,
    account_id: accountId,
    threads
  };
  const expression = `handleBulkHistorySync(${JSON.stringify(payload)}); ({ started: true, total: ${threads.length} })`;

  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(worker.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      resolve(message.result);
    };
    socket.onerror = reject;
  });
  console.log(JSON.stringify(result));
}

trigger().catch((error) => { console.error(error); process.exitCode = 1; });
