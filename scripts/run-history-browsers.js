const puppeteer = require('puppeteer-core');
const path = require('path');

const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = path.resolve('src/extension');
const profiles = [
  { port: 50870, path: path.resolve('data/profiles/pending_20260828080620_x5rli') },
  { port: 62824, path: path.resolve('data/profiles/pending_20260830065912_ztarm') }
];

async function launch(profile) {
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable,
    headless: false,
    userDataDir: profile.path,
    defaultViewport: null,
    enableExtensions: true,
    debuggingPort: profile.port,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-popup-blocking',
      '--disable-notifications'
    ]
  });
  await browser.installExtension(extensionPath);
  const pages = await browser.pages();
  const messenger = pages.find((page) => page.url().includes('facebook.com/messages')) || pages[0] || await browser.newPage();
  for (const page of pages) {
    if (page !== messenger) await page.close().catch(() => {});
  }
  if (!messenger.url().includes('facebook.com/messages')) {
    await messenger.goto('https://www.facebook.com/messages', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return browser;
}

Promise.all(profiles.map(launch))
  .then((browsers) => {
    console.log('HISTORY_BROWSERS_READY');
    for (const browser of browsers) {
      browser.on('disconnected', () => console.error('HISTORY_BROWSER_DISCONNECTED'));
    }
    // Puppeteer's transport can be unref'ed by Node. Keep the owner process
    // alive explicitly; otherwise Chrome is closed as soon as this script exits.
    setInterval(() => {
      for (const browser of browsers) {
        void browser.version().catch(() => {});
      }
    }, 15000);
  })
  .catch((error) => { console.error(error); process.exit(1); });
