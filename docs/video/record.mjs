// Records the live SIEGE app with a scripted cursor, paced to the narration clips.
// Usage: node record.mjs <durations.json> <outdir>
// durations.json: {"s1_load": 13.2, ...}. Writes <outdir>/frames/*.jpg, <outdir>/frames.json, <outdir>/scenes.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');

const URL = 'https://near-siege.onrender.com/';
const PAD = 0.5; // seconds of breathing room after each line
const dur = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.id = '__cursor';
    d.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
      'background:rgba(20,20,20,.62);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);z-index:2147483647;' +
      'pointer-events:none;transition:transform .12s ease;transform:translate(960px,540px)';
    document.body.appendChild(d);
    addEventListener('mousemove', (e) => { d.style.transition = 'none'; d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => { d.style.background = 'rgba(0,200,120,.8)'; }, true);
    addEventListener('mouseup', () => { setTimeout(() => (d.style.background = 'rgba(20,20,20,.62)'), 180); }, true);
  });
});

// Wake the host (cold start can take a minute).
for (let i = 0; i < 12; i++) {
  try { const r = await fetch(URL + 'healthz'); if (r.ok) break; } catch {}
  await sleep(10000);
}
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 180000 });
await page.evaluate(() => document.fonts.ready);
await sleep(1500);

// ---- cursor + scroll helpers ----
let mx = 960, my = 540;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms = 700) {
  const x0 = mx, y0 = my, steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t);
    await sleep(ms / steps);
  }
  mx = x; my = y;
}
async function scrollTo(y, ms = 1200) {
  await page.evaluate((y, ms) => new Promise((res) => {
    const y0 = scrollY, y1 = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)), t0 = performance.now();
    const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const t = Math.min(1, (now - t0) / ms); scrollTo(0, y0 + (y1 - y0) * e(t)); t < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), y, ms);
  // keep the dot under the (fixed) mouse position after scrolling
  await page.mouse.move(mx, my);
}
// Rect of an element (selector), or of the first element under root whose own text includes `text`.
async function rect(sel, text) {
  return page.evaluate((sel, text) => {
    let el = document.querySelector(sel);
    if (el && text) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; el = null;
      while ((n = w.nextNode())) if (n.textContent.includes(text) && n.parentElement.offsetParent) { el = n.parentElement; break; }
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, docY: r.top + scrollY };
  }, sel, text);
}
async function point(sel, text, ms = 700, dx = 0) {
  const r = await rect(sel, text);
  if (!r) throw new Error(`not found: ${sel} ${text || ''}`);
  await moveTo(dx ? r.x + dx : r.cx, r.cy, ms);
  return r;
}
async function click(sel, text) {
  await point(sel, text, 600);
  await sleep(200);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const state = () => page.evaluate(() => document.getElementById('siege').dataset.state);
async function waitDone(maxMs = 90000) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < maxMs) { if ((await state()) !== 'running') return; await sleep(250); }
  throw new Error('siege did not finish');
}

// ---- screencast ----
const cdp = await page.createCDPSession();
const frames = [];
let fi = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const name = `f${String(fi++).padStart(6, '0')}.jpg`;
  fs.writeFileSync(path.join(out, 'frames', name), Buffer.from(f.data, 'base64'));
  frames.push({ name, t: f.metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await sleep(400);
// Keep frames flowing in still moments: a 1px invisible ticker forces repaints.
await page.evaluate(() => {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:2147483646;pointer-events:none';
  document.body.appendChild(t);
  let k = 0; setInterval(() => { t.style.background = (k ^= 1) ? '#fff' : '#fefefe'; }, 33);
});
await page.mouse.move(mx, my);
await sleep(300);
const T0 = Date.now() / 1000;
const scenes = [];
async function scene(id, fn) {
  const start = Date.now() / 1000;
  scenes.push({ id, start: start - T0 });
  console.log('scene', id, (start - T0).toFixed(2));
  await fn();
  const left = start + dur[id] + PAD - Date.now() / 1000;
  if (left > 0) await sleep(left * 1000);
}

try {
await sleep(600); // lead-in
await scene('s1_load', async () => {
  await point('.hero h1, h1', null, 900);
  await sleep(2500);
  await point('#outcome', '128.53', 1100);
  await sleep(1800);
  await point('#g-outlayer', '128.53', 900);
  await sleep(1500);
  await point('#g-mandate', '1.02', 900);
});

await scene('s2_rules', async () => {
  await point('#clauses', 'Pay any vendor invoice', 900);
  await sleep(600);
  await point('#clauses', 'It allows any payee', 800);
  await sleep(1800);
  const tr = await rect('#trace', 'acme-supplie');
  await scrollTo(tr.docY - 560, 1600);
  await point('#trace', 'acme-supplie', 900, 60);
  await sleep(600);
  await moveTo(mx + 70, my, 900);
});

await scene('s3_siege', async () => {
  await scrollTo(0, 1500);
  await click('#siege-btn');
  await sleep(1200);
  await point('#feed', 'Latest attempts', 900);
  await sleep(2500);
  await moveTo(mx + 280, my + 120, 1400);
  await sleep(2000);
  await point('#g-outlayer', 'NEAR', 900);
  await waitDone();
});

await scene('s4_verdict', async () => {
  await point('#siege-verdict', '128.53', 900);
  await sleep(2600);
  const f = await rect('#next-fix-text');
  await scrollTo(f.docY - 420, 1500);
  await point('#next-fix-text', null, 800);
  await sleep(1500);
  await point('#next-fix-btn', null, 800);
});

await scene('s4_fix', async () => {
  await click('#next-fix-btn');
  await sleep(500);
  await scrollTo(0, 1400);
  await sleep(1500);
  await point('#g-mandate', 'NEAR', 900);
  await waitDone();
});

await scene('s4_after', async () => {
  await point('#clauses', 'acme-', 900);
  await sleep(1800);
  await point('#g-mandate', '0.00', 900);
  await sleep(2500);
  await point('#g-outlayer', '91.08', 900);
});

await scene('s5_try', async () => {
  const t = await rect('#try');
  await scrollTo(t.docY - 200, 1600);
  await click('#try summary');
  await sleep(400);
  await click('#t-to');
  await page.click('#t-to', { clickCount: 3 });
  await page.keyboard.type('pool.testnet', { delay: 50 });
  await sleep(300);
  await click('label[for=k-call]');
  await sleep(500);
  await point('#t-args', null, 600);
  await sleep(500);
  const b = await rect('#try-btn');
  await scrollTo(b.docY - 640, 800);
  await click('#try-btn');
  await page.waitForFunction(() => !document.getElementById('verdicts').hidden && /refuse/.test(document.getElementById('verdicts').innerText));
  await sleep(700);
  await point('#verdicts', 'Would send it', 800);
  await sleep(1200);
  await point('#verdicts', 'Would refuse it', 800);
  await sleep(1000);
  await point('#verdicts', 'drainer.testnet', 800, 40);
});

await scene('s6_proof', async () => {
  await point('#chain', 'SIEGE vault, enforced', 900);
  await sleep(1400);
  await point('#chain', '8bC9Sjk', 900);
  await sleep(2200);
  await point('#chain', 'BAD_SIGNATURE', 900);
  await sleep(800);
  await point('#chain', '4uKP4WR', 800);
});

await scene('s7_end', async () => {
  await scrollTo(0, 1800);
  await point('#siege-verdict', null, 900);
});
await sleep(1500);
} catch (e) { console.error('FAILED', e); process.exitCode = 1; await page.screenshot({ path: path.join(out, 'error.png') }); }
const TEND = Date.now() / 1000;
await cdp.send('Page.stopScreencast');
await sleep(500);
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames));
fs.writeFileSync(path.join(out, 'scenes.json'), JSON.stringify({ t0: T0, end: TEND - T0, scenes }, null, 1));
console.log('frames', frames.length, 'length', (TEND - T0).toFixed(2));
await browser.close();
