import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/15611/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'https://ruler5555.github.io/pixel-mech-arena/?t=' + Date.now();

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage();

const errors = [];
page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('CONSOLE_ERR: ' + msg.text());
});

await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 1500));

// 检查所有屏初始状态
const init = await page.evaluate(() => {
  const ids = ['authScreen', 'lobby', 'modeSelect', 'onlineHub', 'roomLobby', 'gameWrap'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el ? el.classList.contains('hidden') : 'MISSING';
  }
  out.btnGuestExists = !!document.getElementById('btnGuest');
  out.btnOfflineExists = !!document.getElementById('btnOffline');
  out.btnModeAIExists = !!document.getElementById('btnModeAI');
  return out;
});
console.log('[INIT]', JSON.stringify(init, null, 2));

// 尝试点 btnGuest
await page.evaluate(() => document.getElementById('btnGuest').click());
await new Promise(r => setTimeout(r, 800));

const afterGuest = await page.evaluate(() => {
  const ids = ['authScreen', 'lobby', 'modeSelect', 'onlineHub'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el.classList.contains('hidden') ? 'hidden' : 'visible';
  }
  return out;
});
console.log('[AFTER BTNGUEST]', JSON.stringify(afterGuest, null, 2));

if (errors.length) console.log('[ERRORS]', errors);
await browser.close();
console.log('DONE');