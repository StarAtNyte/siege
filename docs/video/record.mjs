// Records the live SIEGE app with a scripted cursor, a zooming camera and a spotlight, paced to the narration.
// Usage: node record.mjs <narration.json> <durations.json> <outdir>
// durations.json: {id: seconds} for every line in narration.json. Writes <outdir>/frames/*.jpg, frames.json, scenes.json.
//
// Camera (as in the DARWIN recorder): the page is never scrolled. A CSS transform on <body> (origin 0 0) zooms and
// pans to the focus with eased moves; the cursor dot and the spotlight live on <html>, outside the transform.
// The siege itself runs on the server in about 5 s; the page then plays it back one round at a time. The recorder
// only changes that playback speed (window.__pace) and can hold it on a line (window.__hold); the results are the
// server's.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');

const URL = 'https://near-siege.onrender.com/';
const PAD = 0.25; // breath after each line
const SLOPPY = 'Pay any invoice up to 50 NEAR per transaction.';
const lines = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dur = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = process.argv[4];
const gap = Object.fromEntries(lines.map((l) => [l.id, l.gap_after || 0]));
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  // Playback pacing of the siege feed (the page waits 1100 ms per played round, 45 ms otherwise).
  window.__pace = 1; window.__hold = false; window.__holdOn = null;
  const ST = window.setTimeout.bind(window);
  window.setTimeout = (f, ms, ...a) => {
    if (typeof f !== 'function' || (ms !== 1100 && ms !== 45)) return ST(f, ms, ...a);
    const go = () => (window.__hold ? ST(go, 50) : f(...a));
    return ST(go, ms * window.__pace);
  };
  addEventListener('DOMContentLoaded', () => {
    const root = document.documentElement, body = document.body;
    const css = document.createElement('style');
    css.textContent = 'html{overflow:hidden!important}.tip{display:none!important}';
    document.head.appendChild(css);
    const d = document.createElement('div');
    d.id = '__cursor';
    d.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
      'background:rgba(20,20,20,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);z-index:2147483647;' +
      'pointer-events:none;transform:translate(960px,540px)';
    const spot = document.createElement('div');
    spot.id = '__spot';
    spot.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;border-radius:14px;pointer-events:none;z-index:2147483600;' +
      'opacity:0;box-shadow:0 0 0 2px rgba(255,255,255,.5),0 0 0 3000px rgba(0,0,0,.5),0 0 40px 12px rgba(0,0,0,.25) inset;' +
      'transition-property:left,top,width,height,opacity;transition-timing-function:cubic-bezier(.65,0,.35,1)';
    root.appendChild(spot); root.appendChild(d);
    root.style.background = getComputedStyle(body).backgroundColor;
    body.style.transformOrigin = '0 0';
    body.style.willChange = 'transform';
    body.style.transitionProperty = 'transform';
    body.style.transitionTimingFunction = 'cubic-bezier(.65,0,.35,1)';
    addEventListener('mousemove', (e) => { if (e.isTrusted) d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => { d.style.background = 'rgba(0,200,120,.85)'; }, true);
    addEventListener('mouseup', () => { setTimeout(() => (d.style.background = 'rgba(20,20,20,.55)'), 180); }, true);
    // Hold the feed the moment a chosen payee shows up in it.
    new MutationObserver(() => {
      const f = document.getElementById('feed-lines');
      if (window.__holdOn && f && f.innerText.includes(window.__holdOn)) { window.__hold = true; window.__holdOn = null; }
    }).observe(body, { childList: true, subtree: true });

    const cam = { s: 1, tx: 0, ty: 0 };
    const W = innerWidth, H = innerHeight, CAP = 130; // keep the focus clear of the caption band
    const find = (sel, text) => {
      let el = document.querySelector(sel);
      if (el && text) {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n; el = null;
        while ((n = w.nextNode())) if (n.textContent.includes(text) && n.parentElement.offsetParent) { el = n.parentElement; break; }
      }
      return el;
    };
    const pageRect = (targets) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [sel, text] of targets) {
        const el = find(sel, text);
        if (!el) throw new Error(`not found: ${sel} ${text || ''}`);
        const r = el.getBoundingClientRect();
        x0 = Math.min(x0, (r.left - cam.tx) / cam.s); y0 = Math.min(y0, (r.top - cam.ty) / cam.s);
        x1 = Math.max(x1, (r.right - cam.tx) / cam.s); y1 = Math.max(y1, (r.bottom - cam.ty) / cam.s);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    window.__cam = {
      focus(targets, { maxScale = 1.4, minScale = 1, pad = 24, spot: dim = true, ms } = {}) {
        const r = pageRect(targets);
        const docH = Math.max(H, body.offsetHeight);
        const s = Math.max(minScale, Math.min(maxScale, (W - 160) / (r.w + 2 * pad), (H - CAP - 80) / (r.h + 2 * pad)));
        let tx = W / 2 - s * (r.x + r.w / 2), ty = (H - CAP) / 2 - s * (r.y + r.h / 2);
        tx = Math.min(0, Math.max(W - s * W, tx));
        ty = Math.min(0, Math.max(H - s * docH, ty));
        const dist = Math.hypot(tx - cam.tx, ty - cam.ty) + 400 * Math.abs(s - cam.s);
        const t = ms ?? Math.round(Math.min(1400, Math.max(650, 500 + dist * 0.35)));
        body.style.transitionDuration = spot.style.transitionDuration = t + 'ms';
        body.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
        Object.assign(cam, { s, tx, ty });
        const vx = s * (r.x - pad) + tx, vy = s * (r.y - pad) + ty;
        Object.assign(spot.style, { left: vx + 'px', top: vy + 'px', width: s * (r.w + 2 * pad) + 'px', height: s * (r.h + 2 * pad) + 'px', opacity: dim ? '1' : '0' });
        return t;
      },
      wide(ms = 900) {
        body.style.transitionDuration = spot.style.transitionDuration = ms + 'ms';
        body.style.transform = 'translate(0px,0px) scale(1)';
        Object.assign(cam, { s: 1, tx: 0, ty: 0 });
        spot.style.opacity = '0';
        return ms;
      },
    };
  });
});

for (let i = 0; i < 12; i++) {
  try { const r = await fetch(URL + 'healthz'); if (r.ok) break; } catch {}
  await sleep(10000);
}
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 180000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => document.querySelector('#siege-verdict')?.innerText.includes('128.53'), { timeout: 60000 });
await sleep(1500);

// ---- camera, cursor ----
let mx = 960, my = 540;
const focus = async (targets, opts = {}) => { const t = await page.evaluate((a, o) => window.__cam.focus(a, o), targets, opts); await sleep(t + 80); await page.mouse.move(mx, my); };
const wide = async (ms) => { const t = await page.evaluate((m) => window.__cam.wide(m), ms); await sleep(t + 80); await page.mouse.move(mx, my); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms = 700) {
  const x0 = mx, y0 = my, t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms), k = ease(t);
    await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
    if (t >= 1) break;
    await sleep(15);
  }
  mx = x; my = y;
}
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
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
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
async function waitDone(maxMs = 120000) {
  const t0 = Date.now();
  await sleep(800);
  while (Date.now() - t0 < maxMs) { if ((await state()) === 'done') return; await sleep(200); }
  throw new Error('siege did not finish');
}
const setPace = (p) => page.evaluate((p) => { window.__pace = p; }, p);

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
await page.evaluate(() => {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:2147483646;pointer-events:none';
  document.documentElement.appendChild(t);
  let k = 0; setInterval(() => { t.style.background = (k ^= 1) ? '#fff' : '#fefefe'; }, 33);
});
// Open on the question, zoomed in.
await page.evaluate(() => window.__cam.focus([['.hero'], ['.stakes__why']], { maxScale: 1.45, spot: false, ms: 1 }));
{ const a = await rect('.stakes__why'); mx = a.x + 40; my = a.y + a.h + 60; }
await page.mouse.move(mx, my);
await sleep(500);
const T0 = Date.now() / 1000;
const scenes = [];
const info = {};
async function scene(id, fn) {
  const start = Date.now() / 1000;
  scenes.push({ id, start: start - T0 });
  console.log('scene', id, (start - T0).toFixed(2));
  await fn(start);
  const left = start + dur[id] + PAD + gap[id] - Date.now() / 1000;
  if (left > 0) await sleep(left * 1000);
}
// Sleep until `sec` seconds after the scene start (to land an action on a word).
const at = async (start, sec) => { const left = start + sec - Date.now() / 1000; if (left > 0) await sleep(left * 1000); };

try {
await sleep(300);
await scene('s0_hook', async () => {
  await point('.stakes__why', 'poisoned email', 1400);
  await sleep(600);
  await point('.stakes__why', 'pay a thief', 1200);
});

await scene('s1_what', async () => {
  await wide(1200);
  await point('#doc-h', null, 900);
  await sleep(1200);
  await point('#siege-verdict', null, 900);
});

await scene('s2_lay', async (st) => {
  await focus([['#doc-h'], ['#clauses']], { maxScale: 1.3, spot: false });
  await point('#clauses', 'Pay any vendor invoice', 800);
  await page.evaluate(() => { window.__holdOn = 'acme-supp1ies'; });
  await at(st, dur.s2_lay * 0.3);
  await wide(900);
  await click('#siege-btn');
  await sleep(300);
  await focus([['#stage'], ['#feed']], { maxScale: 1.5, spot: false });
});

// Held on the first lookalike line until this scene ends.
await page.waitForFunction(() => window.__hold, { timeout: 30000 });
await scene('s2_feed', async (st) => {
  await focus([['#feed']], { maxScale: 1.6, pad: 30 });
  await point('#feed-lines', 'testnet', 700);
  await sleep(1200);
  const words = dur.s2_feed;
  // The account name is split into spans (the swapped character is marked), so find its row.
  const li = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#feed-lines li')].find((l) => l.innerText.includes('acme-supp1ies'));
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left }; };
    const a = li.querySelectorAll('.feed__v');
    return { name: r(li.querySelector('.feed__to') || li), paid: r(a[0]), blocked: r(a[1]) };
  });
  await at(st, words * 0.3);
  await moveTo(li.name.x, li.name.y, 800);
  await at(st, words * 0.72);
  await moveTo(li.paid.x, li.paid.y, 700);
  await at(st, words * 0.88);
  await moveTo(li.blocked.x, li.blocked.y, 600);
});
await setPace(0.25);
await page.evaluate(() => { window.__hold = false; });
await focus([['#g-outlayer'], ['#g-mandate']], { maxScale: 1.3, spot: false });
await waitDone();
await setPace(1);
await sleep(600);

await scene('s3_verdict', async (st) => {
  await focus([['#g-outlayer'], ['#g-mandate']], { maxScale: 1.4 });
  await at(st, dur.s3_verdict * 0.18);
  await point('#g-outlayer', '128.53', 900);
  await at(st, dur.s3_verdict * 0.72);
  await point('#g-mandate', '1.02', 800);
});

await scene('s4_fix', async (st) => {
  await focus([['#next-h'], ['#next-weak'], ['#next-fix']], { maxScale: 1.5 });
  await point('#next-weak', null, 800);
  await at(st, dur.s4_fix * 0.5);
  await point('#next-fix-text', null, 800);
  await at(st, dur.s4_fix * 0.8);
  await setPace(0.25);
  await click('#next-fix-btn');
  await sleep(400);
  await focus([['#g-outlayer'], ['#g-mandate']], { maxScale: 1.3, spot: false });
});
await waitDone();
await setPace(1);
await sleep(1000); // let the payoff land before the voice

await scene('s4_after', async (st) => {
  await focus([['#g-mandate']], { maxScale: 1.6 });
  await point('#g-mandate', '0.00', 900);
  await at(st, dur.s4_after * 0.45);
  await focus([['#next-delta'], ['#next-weak']], { maxScale: 1.6 });
  await point('#next-delta', null, 800);
  await at(st, dur.s4_after * 0.75);
  await point('#next-weak', '91.08', 800);
});
await sleep(300);

await scene('s5_edit', async (st) => {
  await focus([['#doc-h'], ['#edit-btn'], ['#clauses', 'Pay up to 10']], { maxScale: 1.3, spot: false });
  await click('#edit-btn');
  await sleep(300);
  // If the click missed, press the same button from the page.
  info.editFallback = await page.evaluate(() => { const t = document.getElementById('mandate'); if (!t.hidden) return false; document.getElementById('edit-btn').click(); return true; });
  await sleep(200);
  await focus([['.doc__head'], ['#mandate']], { maxScale: 1.6, spot: false });
  await at(st, dur.s5_edit * 0.45);
  await point('#mandate', null, 600);
  await page.evaluate(() => { const t = document.getElementById('mandate'); t.focus({ preventScroll: true }); t.select(); });
  await page.keyboard.type(SLOPPY, { delay: 25 });
  if ((await page.$eval('#mandate', (t) => t.value)) !== SLOPPY) throw new Error('typing did not reach the rules');
  await sleep(700);
  await page.waitForFunction(() => !document.getElementById('siege-btn').hasAttribute('aria-disabled') && !/Reading/.test(document.getElementById('doc-status').textContent), { timeout: 20000 });
});
await wide(900);
await click('#siege-btn');
await sleep(300);
await setPace(0.25);
await focus([['#g-outlayer'], ['#g-mandate']], { maxScale: 1.3, spot: false });
await waitDone();
await setPace(1);
await sleep(500);

await scene('s5_result', async (st) => {
  await focus([['#g-mandate']], { maxScale: 1.6 });
  await point('#g-mandate', '319.75', 800);
  await at(st, dur.s5_result * 0.4);
  await focus([['#general']], { maxScale: 1.4, spot: false });
  await click('#general summary');
  await sleep(300);
  await focus([['#general']], { maxScale: 1.5 });
  await point('#general .note__story', null, 800);
  info.general = await page.evaluate(() => document.getElementById('general').innerText);
});

await scene('s6_try', async (st) => {
  await focus([['#try']], { maxScale: 1.3, spot: false });
  await click('#try summary');
  await sleep(500);
  await focus([['#t-to'], ['#t-read']], { maxScale: 1.5, spot: false });
  await point('#t-read', null, 700);
  await sleep(400);
  await point('#t-to', null, 700);
  await at(st, dur.s6_try * 0.5);
  await click('#try-btn');
  await page.waitForFunction(() => !document.getElementById('verdicts').hidden, { timeout: 20000 });
  await focus([['#verdicts']], { maxScale: 1.5 });
  await point('#verdicts', 'Would send it', 700);
  await at(st, dur.s6_try * 0.82);
  await point('#verdicts', 'Would refuse it', 700);
  info.verdicts = await page.evaluate(() => document.getElementById('verdicts').innerText);
});

await scene('s7_chain', async (st) => {
  await focus([['#chain-h'], ['.chain__lead']], { maxScale: 1.5 });
  await point('.chain__lead', 'two-key vault', 900);
  await at(st, dur.s7_chain * 0.4);
  await focus([['#chain', 'A guard-signed 0.01 NEAR invoice']], { maxScale: 1.7 });
  await point('#chain', '8bC9Sjk', 800);
  await at(st, dur.s7_chain * 0.62);
  await focus([['.chain__row--refused']], { maxScale: 1.6 });
  await point('.chain__row--refused', 'without the guard', 800);
  await at(st, dur.s7_chain * 0.86);
  await point('.chain__row--refused', 'BAD_SIGNATURE', 700);
});

await scene('s8_close', async () => {
  await wide(1400);
  await focus([['.bar'], ['.hero']], { maxScale: 1.25, spot: false, ms: 1200 });
  await point('.wordmark', null, 900);
  await sleep(1500);
  await point('#siege-btn', null, 900);
});
await sleep(1000);
} catch (e) { console.error('FAILED', e); process.exitCode = 1; await page.screenshot({ path: path.join(out, 'error.png') }); }
const TEND = Date.now() / 1000;
await cdp.send('Page.stopScreencast');
await sleep(500);
info.text = await page.evaluate(() => ({ g: document.getElementById('g-mandate').innerText, o: document.getElementById('g-outlayer').innerText }));
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames));
fs.writeFileSync(path.join(out, 'scenes.json'), JSON.stringify({ t0: T0, end: TEND - T0, scenes, info }, null, 1));
console.log('frames', frames.length, 'length', (TEND - T0).toFixed(2));
await browser.close();
