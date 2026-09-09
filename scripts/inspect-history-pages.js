async function inspect(target) {
  const expression = `({url:location.href,ready:document.readyState,rows:document.querySelectorAll('[role="row"]').length,articles:document.querySelectorAll('[role="article"]').length,mains:document.querySelectorAll('[role="main"]').length,text:(document.body?.innerText||'').length})`;
  return new Promise((resolve) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close(); resolve(message.result?.result?.value);
    };
    socket.onerror = () => resolve({ url: target.url, error: true });
  });
}

(async () => {
  const targets = await (await fetch('http://127.0.0.1:50870/json')).json();
  console.log(JSON.stringify(await Promise.all(targets.filter((target) => target.type === 'page' && target.url.includes('/messages/')).map(inspect)), null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
