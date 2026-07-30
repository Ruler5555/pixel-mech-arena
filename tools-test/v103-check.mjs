// 实测 v103: 玩法选择屏 + 连不上?按钮不再漂移
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
await new Promise(r => setTimeout(r, 800));

// 登录 → 点副本 → 应到 modeSelect
await page.evaluate(() => document.getElementById('btnGuest').click());
await new Promise(r => setTimeout(r, 400));
await page.evaluate(() => document.getElementById('btnOffline').click());
await new Promise(r => setTimeout(r, 500));

const modeScreen = await page.evaluate(() => {
  const ms = document.getElementById('modeSelect');
  const btnAI = document.getElementById('btnModeAI');
  const btnBack = document.getElementById('btnModeBack');
  return {
    modeSelectVisible: ms && !ms.classList.contains('hidden'),
    btnAIVisible: btnAI && btnAI.offsetParent !== null,
    btnAIText: btnAI ? btnAI.textContent.trim().slice(0, 30) : null,
    btnBackVisible: btnBack && btnBack.offsetParent !== null
  };
});
console.log('[副本 → modeSelect]', JSON.stringify(modeScreen, null, 2));

// 返回 → 应回 lobby
await page.evaluate(() => document.getElementById('btnModeBack').click());
await new Promise(r => setTimeout(r, 300));
const back2Lobby = await page.evaluate(() => {
  const lobby = document.getElementById('lobby');
  const ms = document.getElementById('modeSelect');
  return { lobbyVisible: !lobby.classList.contains('hidden'), msHidden: ms.classList.contains('hidden') };
});
console.log('[modeSelect → 返回]', JSON.stringify(back2Lobby));

// 点联机大厅 → 等 1.5 秒观察连不上?按钮位置是否变化
await page.evaluate(() => document.getElementById('btnOpenOnline').click());
const positions = [];
for (let i = 0; i < 6; i++) {
  const pos = await page.evaluate(() => {
    const btn = document.querySelector('#onlineHub .help-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  });
  positions.push(pos);
  await new Promise(r => setTimeout(r, 250));
}
console.log('[联机大厅 1.5s 内连不上?按钮位置变化]');
positions.forEach((p, i) => console.log(`  t+${i*250}ms:`, JSON.stringify(p)));

const stable = positions.every(p => p && p.top === positions[0].top && p.bottom === positions[0].bottom);
console.log('[位置稳定?]', stable ? '✓' : '✗');

await page.screenshot({ path: 'C:/Users/15611/pixel-mech-arena/tools-test/v103-modeselect.png' });
await browser.close();
console.log('DONE');