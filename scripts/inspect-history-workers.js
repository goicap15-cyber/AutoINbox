async function inspect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const worker = targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  if (!worker) return { port, error: 'NO_CRM_WORKER' };
  const expression = `({
    user_id: typeof user_id === 'undefined' ? null : user_id,
    socket_state: typeof ws === 'undefined' || !ws ? null : ws.readyState,
    socket_url: typeof ws === 'undefined' || !ws ? null : ws.url,
    bulk_running: typeof bulkHistorySyncInFlight === 'undefined' ? null : bulkHistorySyncInFlight
    ,version: chrome.runtime.getManifest().version
    ,pool3: typeof handleBulkHistorySync === 'function' && handleBulkHistorySync.toString().includes('Math.min(3')
    ,pool_code: typeof handleBulkHistorySync === 'function' ? (handleBulkHistorySync.toString().match(/workerCount[^;]+/)||[])[0] : null
  })`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(worker.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      resolve({ port, state: message.result?.result?.value, exception: message.result?.exceptionDetails });
    };
    socket.onerror = reject;
  });
}

Promise.all([inspect(50870)])
  .then((results) => console.log(JSON.stringify(results, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
