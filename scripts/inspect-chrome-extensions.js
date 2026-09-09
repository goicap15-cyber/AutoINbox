async function inspect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((item) => item.url === 'chrome://extensions/');
  if (!target) throw new Error(`No extensions page on ${port}`);
  const expression = `(() => {
    const items = [...document.querySelector('extensions-manager').shadowRoot
      .querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item')];
    return items.map(item => {
      const root = item.shadowRoot;
      return {
        id: item.id,
        name: root.querySelector('#name')?.textContent?.trim(),
        errors: root.querySelector('#errors-button')?.textContent?.trim() || null,
        enabled: root.querySelector('#enableToggle')?.checked
      };
    });
  })()`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      resolve({ port, result: message.result?.result?.value, error: message.result?.exceptionDetails });
    };
    socket.onerror = reject;
  });
}

Promise.all([inspect(50870), inspect(62824)])
  .then((results) => console.log(JSON.stringify(results, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
