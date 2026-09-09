async function evaluate(target) {
  const expression = `(() => {
    const main = document.querySelector('[role="main"]');
    const candidates = [...document.querySelectorAll('div')].filter(el => el.scrollHeight > el.clientHeight + 100);
    const scroller = candidates.sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
    return {url:location.href,articles:document.querySelectorAll('[role="article"]').length,top:scroller?.scrollTop ?? null,height:scroller?.scrollHeight ?? null,client:scroller?.clientHeight ?? null,mainText:(main?.innerText||'').length};
  })()`;
  return new Promise((resolve) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
    socket.onmessage = (event) => { const m=JSON.parse(event.data); if(m.id!==1)return; socket.close(); resolve(m.result?.result?.value); };
    socket.onerror = () => resolve({url:target.url,error:true});
  });
}
async function sample() {
  const targets = await (await fetch('http://127.0.0.1:50870/json')).json();
  return Promise.all(targets.filter(t => t.type==='page' && t.url.includes('/messages/')).slice(0, 3).map(evaluate));
}
(async()=>{const first=await sample();await new Promise(r=>setTimeout(r,5000));const second=await sample();console.log(JSON.stringify({first,second},null,2));})().catch(e=>{console.error(e);process.exitCode=1});
