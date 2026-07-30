// 实测线上 v97: 延迟/模式/退出簇是否可见、在哪
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
// 手机竖屏 + 触控 (匹配 pointer:coarse 媒体查询)
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));

// 快速登录 -> 副本
await page.evaluate(() => document.getElementById('btnGuest').click());
await new Promise(r => setTimeout(r, 600));
await page.evaluate(() => document.getElementById('btnOffline').click());
await new Promise(r => setTimeout(r, 800));

// 若有 READY 弹层, 点开始
await page.evaluate(() => {
  const b = document.getElementById('startBtn');
  if (b && !b.classList.contains('hidden')) b.click();
});
await new Promise(r => setTimeout(r, 1000));

const info = await page.evaluate(() => {
  const ids = ['persistEdge', 'topCluster', 'rttTag', 'gameModeTag', 'exitMobileBtn', 'hud', 'gameWrap'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = 'MISSING_FROM_DOM'; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[id] = {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      pos: cs.position, zIndex: cs.zIndex,
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      hiddenClass: el.classList.contains('hidden'),
      text: (el.textContent || '').trim().slice(0, 40)
    };
  }
  // 谁在 topCluster 的中心点上(遮挡检测)
  const tc = document.getElementById('topCluster');
  if (tc) {
    const r = tc.getBoundingClientRect();
    const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out._elementAtClusterCenter = topEl ? (topEl.id || topEl.className || topEl.tagName) : 'null';
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));

await page.screenshot({ path: 'C:/Users/15611/pixel-mech-arena/tools-test/ingame.png' });
await browser.close();
console.log('DONE');
