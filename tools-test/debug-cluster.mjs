// 实测 v99 线上: 对局时 topCluster 实际显示的内容
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
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));

// 进入副本对局
await page.evaluate(() => document.getElementById('btnGuest').click());
await new Promise(r => setTimeout(r, 500));
await page.evaluate(() => document.getElementById('btnOffline').click());
await new Promise(r => setTimeout(r, 800));

// 点击 startBtn 启动对局
await page.evaluate(() => {
  const b = document.getElementById('startBtn');
  if (b && !b.classList.contains('hidden')) b.click();
});
await new Promise(r => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  const ids = ['persistEdge', 'topCluster', 'rttTag', 'gameModeTag', 'exitMobileBtn', 'hud'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = 'MISSING'; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[id] = {
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      pos: cs.position,
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.textContent || '').trim().slice(0, 60),
      innerHTML: el.innerHTML.slice(0, 200)
    };
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
console.log('DONE');