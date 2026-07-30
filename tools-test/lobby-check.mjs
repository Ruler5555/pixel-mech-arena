// 实测联机大厅输入框+加入按钮布局
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
await page.evaluate(() => document.getElementById('btnGuest').click());
await new Promise(r => setTimeout(r, 400));
await page.evaluate(() => document.getElementById('btnOpenOnline').click());
await new Promise(r => setTimeout(r, 600));

const m = await page.evaluate(() => {
  const join = document.querySelector('.lobby-join');
  const input = document.querySelector('.lobby-input');
  const btn = document.getElementById('btnJoin');
  const vp = { w: window.innerWidth, h: window.innerHeight };
  const inRect = input.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const joinRect = join.getBoundingClientRect();
  const cs = el => ({
    display: getComputedStyle(el).display,
    width: getComputedStyle(el).width,
    padding: getComputedStyle(el).padding,
    marginLeft: getComputedStyle(el).marginLeft,
    marginRight: getComputedStyle(el).marginRight
  });
  // 按钮可见宽度 = 在视口内的部分
  const btnVisibleLeft = Math.max(btnRect.left, 0);
  const btnVisibleRight = Math.min(btnRect.right, vp.w);
  const btnVisibleW = Math.max(0, btnVisibleRight - btnVisibleLeft);
  return {
    vp,
    joinRect: { top: Math.round(joinRect.top), left: Math.round(joinRect.left), right: Math.round(joinRect.right), w: Math.round(joinRect.width) },
    inputRect: { left: Math.round(inRect.left), right: Math.round(inRect.right), w: Math.round(inRect.width) },
    btnRect: { left: Math.round(btnRect.left), right: Math.round(btnRect.right), w: Math.round(btnRect.width) },
    btnVisibleW: Math.round(btnVisibleW),
    btnOverflow: btnRect.right > vp.w,
    joinStyles: cs(join),
    inputStyles: cs(input),
    btnStyles: cs(btn),
    bodyOverflow: getComputedStyle(document.body).overflow,
    appOverflow: getComputedStyle(document.getElementById('app')).overflow
  };
});
console.log(JSON.stringify(m, null, 2));
await page.screenshot({ path: 'C:/Users/15611/pixel-mech-arena/tools-test/lobby.png' });
await browser.close();
console.log('DONE');