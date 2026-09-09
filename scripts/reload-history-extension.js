const puppeteer = require('puppeteer-core');
const path = require('path');

async function install(port) {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const extension = await browser.installExtension(path.resolve('src/extension'));
  const result = { port, id: extension.id };
  await browser.disconnect();
  return result;
}

Promise.all([install(50870), install(62824)])
  .then((results) => console.log(JSON.stringify(results)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
