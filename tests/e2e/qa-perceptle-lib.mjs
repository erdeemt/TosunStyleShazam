// QA yardımcıları: 👁️ Algıla'yı gerçek bir oyuncu gibi oynatmak (dokunmatik CDP sürükleme, fare, klavye),
// gönderilen cevaplardan puanı formülle bağımsız olarak yeniden hesaplamak. qa-perceptle-*.test.mjs kullanır.
import { secret } from '../lib/media.js';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHOTS = fileURLToPath(new URL('../../test-results/qa-perceptle/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

export const PHONE = { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };
export const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Bağımsız puan hesabı (PLAN.md §4.7) ----------
export const TOL = {
  normal: { count: 0.20, track: 60, angle: 8, tempo: 60, split: 0.05 },
  friday: { count: 0.32, track: 90, angle: 14, tempo: 85, split: 0.10 },
};
export const score = (err, tol) => Math.round(100 * Math.exp(-0.5 * (err / tol) ** 2));
const fold = (v, lo, hi) => { const s = hi - lo; let u = (v - lo) % (2 * s); if (u < 0) u += 2 * s; return lo + (u > s ? 2 * s - u : u); };
export function landing(p) {
  const T = (p.vy + Math.sqrt(p.vy ** 2 + 2 * p.g * p.y0)) / p.g;
  const raw = p.x0 + p.vx * T;
  return p.walls ? fold(raw, 12, 988) : raw;
}
export const splitVal = (s) => (s.kind === 'pct' ? s.pct / 100 : s.num / s.den);
export function tempoErr(bpm, taps, friday) {
  const I = 60000 / bpm;
  const exp = Array.from({ length: 8 }, (_, j) => I * (4 + j + (friday ? 0.5 : 0)));
  const warm = taps.filter((t) => t >= -I / 2 && t < 3.5 * I).map((t) => t - Math.min(3, Math.max(0, Math.round(t / I))) * I).sort((a, b) => a - b);
  let lat = 0;
  if (warm.length) { const m = warm.length >> 1; lat = warm.length % 2 ? warm[m] : (warm[m - 1] + warm[m]) / 2; }
  lat = Math.max(-150, Math.min(150, lat));
  const best = exp.map(() => Infinity);
  let extra = 0;
  for (const t of taps) {
    if (t < 3.5 * I) continue;
    const j = Math.max(0, Math.min(7, Math.round((t - exp[0]) / I)));
    const d = Math.abs(t - exp[j] - lat);
    if (best[j] === Infinity) best[j] = d; else { extra++; best[j] = Math.min(best[j], d); }
  }
  const terms = [...best.map((b) => Math.min(b, 250)), ...Array(extra).fill(250)];
  return Math.round(Math.sqrt(terms.reduce((a, b) => a + b * b, 0) / terms.length) * 10) / 10; // sunucu RMS'i 0,1 ms'e yuvarlar
}
export function expectedScore(test, stim, answer, friday, taps) {
  const tol = TOL[friday ? 'friday' : 'normal'][test];
  if (test === 'count') return score(Math.abs(answer - stim.dots.length) / stim.dots.length, tol);
  if (test === 'track') return score(Math.abs(answer - landing(stim)), tol);
  if (test === 'angle') {
    if (friday) return score(Math.abs(answer - stim.target), tol);
    const d = Math.abs(((((answer - stim.target) % 360) + 540) % 360) - 180);
    return score(d, tol);
  }
  if (test === 'tempo') return score(tempoErr(stim.bpm, taps, friday), tol);
  return score(Math.abs(answer - splitVal(stim)), tol);
}
export const gradeOf = (s) => (s >= 95 ? 'S' : s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F');

// ---------- Sayfa ----------
export async function openPage(browser, url, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const p = { ctx, page, errors: [], stimuli: [], submits: [], touch: Boolean(opts.hasTouch) };
  page.on('pageerror', (e) => p.errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') p.errors.push(`console: ${m.text()}`); });
  page.on('response', async (res) => {
    const u = res.url();
    if (u.endsWith('/api/perceptle/test') && res.ok()) {
      const j = await res.json().catch(() => null);
      // Ham uyaran istemciye gitmiyor: testlere özel uçtan (TEST_GAMES=1)
      if (j) { j.public = j.stimulus; j.stimulus = (await secret({ url: new URL(u).origin }, { gameId: j.gameId })).stimuli[j.index]; p.stimuli[j.index] = j; }
    }
    if (u.endsWith('/api/perceptle/submit')) {
      const body = JSON.parse(res.request().postData() || '{}');
      p.submits.push({ body, status: res.status(), json: await res.json().catch(() => null) });
    }
  });
  await page.addInitScript(() => {
    window.__shared = [];
    window.__ev = [];
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'touchstart', 'touchend', 'gotpointercapture', 'lostpointercapture']) {
      document.addEventListener(t, (e) => window.__ev.push(`${Math.round(performance.now())} ${t} ${e.target.className || e.target.tagName} ${e.pointerId ?? ''}`), true);
    }
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared.push(d.text); } });
  });
  if (opts.hasTouch) p.cdp = await ctx.newCDPSession(page);
  await page.goto(url);
  return p;
}

export async function stim(p, i) {
  for (let k = 0; k < 200 && !p.stimuli[i]; k++) await sleep(20);
  return p.stimuli[i];
}

// Dokunmatik (CDP) ya da fare ile noktalar boyunca sürükle.
export async function drag(p, pts, { stepMs = 12 } = {}) {
  if (p.touch) {
    const tp = ([x, y]) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
    await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) });
    for (const pt of pts.slice(1)) { await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(pt) }); await sleep(stepMs); }
    await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await p.page.mouse.move(...pts[0]);
    await p.page.mouse.down();
    for (const pt of pts.slice(1)) { await p.page.mouse.move(...pt); await sleep(stepMs); }
    await p.page.mouse.up();
  }
}
export async function press(p, sel) {
  const b = await p.page.locator(sel).first().boundingBox();
  if (p.touch) await p.page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  else await p.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
// CDP dokunmatik sürüklemeden hemen sonraki ilk dokunuş Chrome emülasyonunda bazen click üretmiyor
// (nötr sayfada da oluyor: harness kusuru). Sonuç gelmezse bir kez daha dokun ve not düş.
export async function pressAfterDrag(p, notes, sel = '.pc-lock') {
  const n = p.submits.length;
  await press(p, sel);
  await p.page.waitForTimeout(700);
  if (p.submits.length === n && (await p.page.locator('.pc-big-score').count()) === 0) {
    notes.push('first tap after drag swallowed (emulation), re-tapped');
    await press(p, sel);
  }
}
export const box = (p, sel) => p.page.locator(sel).first().boundingBox();
export const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
export const bigScore = async (page) => Number((await page.locator('.pc-big-score').textContent()).match(/^\d+/)[0]);

// Görünür etkileşimli öğelerden 44 px'ten küçük olanlar
export function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('#game-perceptle :is(button, input, summary, a, .pc-stage[tabindex])')]
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
    .map(({ e, r }) => `${e.tagName.toLowerCase()}.${e.className} "${(e.textContent || e.placeholder || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`));
}
// Canvas DPR'ye göre mi?
export function canvasDpr(page) {
  return page.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => {
    const r = c.getBoundingClientRect();
    return { css: Math.round(r.width), px: c.width, dpr: devicePixelRatio, ok: Math.abs(c.width - Math.round(r.width * devicePixelRatio)) <= 1 };
  }));
}
// Kesirli konumda pembe piksel var mı (açı sarmalı için)
export function pinkAt(page, sel, fx, fy) {
  return page.evaluate(([s, fx, fy]) => {
    const c = document.querySelector(`${s} canvas`);
    const ctx = c.getContext('2d');
    let hit = false;
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const d = ctx.getImageData(Math.round(fx * c.width) + dx, Math.round(fy * c.height) + dy, 1, 1).data;
      if (d[0] > 180 && d[1] < 140 && d[2] > 90) hit = true;
    }
    return hit;
  }, [sel, fx, fy]);
}

// Ritim: sayfanın kendi saatine göre (pad.dataset.t0) Boşluk tuşu olayları
export async function tapSpace(page, timesMs) {
  await page.waitForSelector('.pc-pad[data-t0]');
  await page.evaluate((ts) => {
    const t0 = Number(document.querySelector('.pc-pad').dataset.t0);
    for (const t of ts) setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })), t0 + t - performance.now());
  }, timesMs);
}
export function beatTimes(bpm, friday, offset = 0) {
  const I = 60000 / bpm;
  return [0, 1, 2, 3].map((k) => k * I).concat(Array.from({ length: 8 }, (_, j) => I * (4 + j + (friday ? 0.5 : 0)))).map((t) => t + offset);
}

export async function nextBtn(p, label) { await press(p, `.rc-go:has-text("${label}")`); }

// Bir testi oyna. plan: { count: delta, track: deltaUnits, angle: deltaDeg, tempo: 'exact'|'random'|offset, split: delta }
export async function playTest(p, i, plan, friday, notes) {
  const { page } = p;
  await page.waitForSelector('.pc-intro');
  await nextBtn(p, 'Hazırım');
  const s = await stim(p, i);
  const st = s.stimulus;
  let taps = null;
  if (i === 0) {
    await page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
    if (p.touch) await page.touchscreen.tap(...Object.values(await box(p, '.pc-num')).slice(0, 2).map((v, k) => v + 10));
    await page.keyboard.type(String(st.dots.length + plan.count));
    await press(p, '.pc-lock');
  } else if (i === 1) {
    await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 8000 });
    const fb = await box(p, '.pc-field');
    const target = landing(st) + plan.track;
    const tx = fb.x + (Math.min(1000, Math.max(0, target)) / 1000) * fb.width;
    // dokun yanlış yere, sonra kaydırarak düzelt
    const sx = fb.x + fb.width * 0.1;
    const pts = [];
    for (let k = 0; k <= 10; k++) pts.push([sx + ((tx - sx) * k) / 10, fb.y + fb.height * 0.6]);
    await drag(p, pts);
    notes.push(`track lock enabled after drag: ${!(await page.locator('.pc-lock').isDisabled())}`);
    await pressAfterDrag(p, notes);
  } else if (i === 2) {
    await page.waitForSelector('.pc-dial');
    const db = await box(p, '.pc-dial');
    const cx = db.x + db.width / 2;
    const cy = db.y + db.height / 2;
    const R = db.width * 0.38;
    const at = (deg) => [cx + Math.cos((deg * Math.PI) / 180) * R, cy - Math.sin((deg * Math.PI) / 180) * R];
    const goal = st.target + plan.angle;
    if (!friday) {
      const a0 = goal + 120;
      const pts = [];
      for (let d = a0; d >= goal; d -= 6) pts.push(at(d));
      pts.push(at(goal));
      await drag(p, pts); // bırakınca gönderilir
    } else {
      // 0'dan 180'e döndür, sarmalın 1 turu aşıp aşmadığına bak → taban 180 ya da 540
      const pts = [];
      for (let d = 0; d <= 180; d += 10) pts.push(at(d));
      await drag(p, pts);
      await page.waitForTimeout(50);
      const over = await pinkAt(page, '.pc-dial', 0.5 + 0.17, 0.5);
      let base = over ? 540 : 180;
      if (!over && (await pinkAt(page, '.pc-dial', 0.5 + 0.24, 0.5))) base = 900;
      notes.push(`friday angle base guess ${base}`);
      const pts2 = [];
      const step = goal >= base ? 10 : -10;
      for (let v = base; step > 0 ? v <= goal : v >= goal; v += step) pts2.push(at(v));
      pts2.push(at(goal));
      await drag(p, pts2, { stepMs: 6 });
      notes.push(`friday angle: not submitted on release: ${(await page.locator('.pc-big-score').count()) === 0}`);
      await pressAfterDrag(p, notes);
    }
  } else if (i === 3) {
    let times;
    if (plan.tempo === 'random') {
      const I = 60000 / st.bpm;
      times = Array.from({ length: 8 }, () => 3.6 * I + Math.random() * 8.5 * I).sort((a, b) => a - b);
    } else times = beatTimes(st.bpm, friday, typeof plan.tempo === 'number' ? plan.tempo : 0);
    taps = times;
    await tapSpace(page, times);
  } else {
    await page.waitForSelector('.pc-line');
    const sb = await box(p, '.pc-line');
    const v = splitVal(st) + plan.split;
    const X = (val) => (friday ? sb.x + sb.width * (0.25 + 0.5 * val) : sb.x + sb.width * (0.08 + 0.84 * val));
    const y = sb.y + sb.height * 0.55;
    const pts = [];
    const start = X(friday ? 0.5 : 0.5);
    for (let k = 0; k <= 12; k++) pts.push([start + ((X(v) - start) * k) / 12, y]);
    await drag(p, pts);
    await pressAfterDrag(p, notes);
  }
  try {
    await page.waitForSelector('.pc-big-score', { timeout: 20000 });
  } catch (err) {
    await page.screenshot({ path: `${SHOTS}FAIL-test${i}.png` });
    console.log('EVENTS', (await page.evaluate(() => window.__ev.slice(-14))).join('\n'));
    const dis = await page.locator('.pc-lock').isDisabled().catch(() => 'n/a');
    await page.locator('.pc-lock').click({ timeout: 2000 }).catch(() => {});
    const retry = await page.waitForSelector('.pc-big-score', { timeout: 3000 }).then(() => 'retry-click worked', () => 'retry-click failed');
    console.log(`DIAG test ${i}: lockDisabled=${dis} ${retry}`);
    const info = await page.evaluate(() => ({ y: scrollY, toast: document.getElementById('toast')?.textContent, lock: document.querySelector('.pc-lock')?.getBoundingClientRect().toJSON() }));
    throw new Error(`test ${i} sonuç gelmedi: ${JSON.stringify(info)} submits=${JSON.stringify(p.submits.map((s) => [s.status, s.json?.error]))}`);
  }
  const sub = p.submits.at(-1);
  const played = sub.json.played.find((x) => x.index === i);
  const exp = expectedScore(['count', 'track', 'angle', 'tempo', 'split'][i], st, i === 3 ? null : played.answer, friday, i === 3 ? sub.body.answer : null);
  const shown = await bigScore(page);
  return { i, played, exp, shown, detail: await page.locator('.pc-detail').textContent(), sent: sub.body.answer, taps };
}
