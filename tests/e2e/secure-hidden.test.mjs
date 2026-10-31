// Tarayıcı testi: gizli uyaranlar ağ sekmesinde okunamaz ama oyun oynanır (360×800 dokunmatik).
// Nüans (tek + lobi): hedef sunucu PNG'si, hex hiçbir JSON/ws mesajında yok; Ton Avı Zor (tek + lobi): WAV çalar, Hz yok;
// Algıla Say/Yörünge: nokta PNG'si ve yörünge örnekleriyle oynanır, puan doğru. Ekranlar: test-results/secure-hidden/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';
import { trackLanding } from '../../public/perceptle-math.js';

const DAY = '2026-11-16'; // Pazartesi
const SHOTS = fileURLToPath(new URL('../../test-results/secure-hidden/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.5, env: { FAKE_TODAY: DAY } });
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

// Telefon: tüm /api JSON yanıtları ve ws mesajları kaydedilir (ağ sekmesinde görünen her şey).
async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    window.__wavs = [];
    window.__osc = 0;
    const ostart = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...a) { window.__osc++; return ostart.apply(this, a); };
    const bstart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      const d = this.buffer.getChannelData(0);
      let c = 0;
      for (let i = 1; i < d.length; i++) if (d[i - 1] < 0 && d[i] >= 0) c++;
      window.__wavs.push(c / this.buffer.duration);
      return bstart.apply(this, a);
    };
  });
  const page = await ctx.newPage();
  const p = { page, errors: [], net: [], media: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (u.pathname.startsWith('/api/media/')) { p.media.push({ path: u.pathname, status: res.status(), type: res.headers()['content-type'], at: Date.now() }); return; }
    const text = await res.text().catch(() => '');
    p.net.push({ path: u.pathname, text, at: Date.now() });
  });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    p.net.push({ path: 'ws', text: String(payload), at: Date.now() });
    try { const m = JSON.parse(payload); if (m.t === 'room' && m.room) p.code = m.room.code; } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/${hash}`);
  return p;
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const hasNum = (text, v) => new RegExp(`(^|[^0-9.])${String(v).replace('.', '[.]')}($|[^0-9])`).test(text);

// Ezber diskindeki görselin ortalama rengi
async function shownHex(page) {
  await page.waitForFunction(() => document.querySelector('.nu-target-img')?.complete && document.querySelector('.nu-target-img').naturalWidth > 0);
  return page.$eval('.nu-target-img', (img) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
    return `#${s.map((v) => Math.round(v / (d.length / 4)).toString(16).padStart(2, '0')).join('')}`;
  });
}
const near = (a, b, tol = 2) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= tol);
// Sayfa açılınca günlük /start da gelir: sınırsız oyunun kimliği (yanıt gövdesi olaydan biraz sonra gelir)
async function freeGameId(p, path) {
  for (let k = 0; k < 200; k++) {
    const hit = p.net.filter((x) => x.path === path).map((x) => JSON.parse(x.text)).find((j) => j.mode === 'free');
    if (hit) return hit.gameId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${path}: sınırsız oyun yok`);
}
const until = (p, at) => p.net.filter((x) => x.at < at).map((x) => x.text).join('\n').toLowerCase();

test('Nüans tek oyunculu: hedef görsel olarak gelir, hex ağda yok, sonuçta kesin hex', async () => {
  const p = await phone('#/single/nuance');
  const { page } = p;
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-diff:has-text("Uzman")');
  await page.click('.rc-go');
  await page.waitForSelector('.nu-target.nu-img');
  const gameId = await freeGameId(p, '/api/recall/nuance/start');
  const target = (await secret(srv, { recall: 'nuance', gameId })).targets[0];
  const shown = await shownHex(page);
  assert.ok(near(shown, target), `görsel ${shown} ≠ hedef ${target}`);
  assert.match(await page.$eval('.nu-target-img', (i) => i.src), /^blob:/);
  await page.screenshot({ path: `${SHOTS}nuance-single-memorize.png` });
  await page.waitForSelector('.nu-input', { timeout: 6000 });
  const recallAt = Date.now();
  await page.fill('.nu-hex', target);
  await page.click('.rc-submit');
  await page.waitForSelector('.nu-round.big, .rc-final, .nu-score', { timeout: 6000 });
  assert.ok(!until(p, recallAt).includes(target.slice(1)), 'hex sonuçtan önce ağda görüldü');
  assert.ok(p.media.length === 1 && p.media[0].status === 200 && p.media[0].type === 'image/png');
  assert.match(await page.locator('#game-nuance').textContent(), new RegExp(target, 'i'), 'sonuçta kesin hex');
  await page.screenshot({ path: `${SHOTS}nuance-single-result.png`, fullPage: true });
  assert.ok(await noHScroll(page));
  assert.deepEqual(p.errors, []);
});

test('Nüans lobi (tek kişi): ezberde görsel, ws mesajlarında hex yok; açıklamada hex', async () => {
  const p = await phone('#/multi/nuance');
  const { page } = p;
  await page.fill('input[placeholder="Takma adın"]', 'Renk');
  await page.click('text=Yeni oda kur');
  await page.waitForSelector('.lobby-code');
  await page.selectOption('#game-nuance select >> nth=0', '3');
  await page.click('#game-nuance button:has-text("Oyunu başlat")');
  await page.waitForSelector('.nu-target.nu-img');
  const target = (await secret(srv, { room: p.code })).targets[0];
  assert.ok(near(await shownHex(page), target));
  await page.screenshot({ path: `${SHOTS}nuance-lobby-memorize.png` });
  await page.waitForSelector('.nu-input', { timeout: 8000 });
  await page.fill('.nu-hex', target);
  const sentAt = Date.now();
  await page.click('.rc-submit');
  await page.waitForSelector('text=Hedef buydu', { timeout: 6000 });
  assert.ok(!until(p, sentAt).includes(target.slice(1)), 'hex açıklamadan önce ws/ağda');
  await page.screenshot({ path: `${SHOTS}nuance-lobby-reveal.png`, fullPage: true });
  assert.deepEqual(p.errors, []);
});

test('Ton Avı Zor tek oyunculu: WAV çalar (osilatör değil), Hz ağda yok; lobi Zor da aynı', async () => {
  const p = await phone('#/single/tone');
  const { page } = p;
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-diff:has-text("Zor")');
  await page.click('.rc-go');
  await page.waitForSelector('.tn-orb');
  const gameId = await freeGameId(p, '/api/recall/tone/start');
  const target = (await secret(srv, { recall: 'tone', gameId })).targets[0];
  await page.waitForFunction(() => window.__wavs.length > 0, null, { timeout: 4000 });
  const heard = await page.evaluate(() => window.__wavs[0]);
  assert.ok(Math.abs(heard / target - 1) < 0.03, `çalan ${heard} ≠ hedef ${target}`);
  assert.equal(await page.evaluate(() => window.__osc), 0, 'Zor modda hedef osilatörle (Hz bilinerek) çalınmamalı');
  await page.screenshot({ path: `${SHOTS}tone-hard-single-memorize.png` });
  await page.waitForSelector('.tn-pad', { timeout: 6000 });
  assert.equal(await page.locator('.tn-hz').count(), 0);
  const recallAt = Date.now();
  await page.click('.rc-submit');
  await page.waitForSelector('.tn-round.big', { timeout: 6000 });
  const before = until(p, recallAt);
  assert.ok(!hasNum(before, target), 'Hz sonuçtan önce ağda');
  await page.screenshot({ path: `${SHOTS}tone-hard-single-result.png`, fullPage: true });

  // Lobi Zor (tek kişi)
  const q = await phone('#/multi/tone');
  await q.page.fill('input[placeholder="Takma adın"]', 'Kulak');
  await q.page.click('text=Yeni oda kur');
  await q.page.waitForSelector('.lobby-code');
  await q.page.selectOption('#game-tone select >> nth=0', '3');
  await q.page.selectOption('#game-tone select >> nth=1', 'hard');
  await q.page.click('#game-tone button:has-text("Oyunu başlat")');
  await q.page.waitForSelector('.tn-orb');
  const lt = (await secret(srv, { room: q.code })).targets[0];
  await q.page.waitForFunction(() => window.__wavs.length > 0, null, { timeout: 4000 });
  assert.ok(Math.abs((await q.page.evaluate(() => window.__wavs[0])) / lt - 1) < 0.03);
  await q.page.screenshot({ path: `${SHOTS}tone-hard-lobby-memorize.png` });
  await q.page.waitForSelector('.tn-pad', { timeout: 6000 });
  const t2 = Date.now();
  await q.page.click('.rc-submit');
  await q.page.waitForSelector('text=Hedef buydu', { timeout: 6000 });
  assert.ok(!hasNum(until(q, t2), lt), 'Hz açıklamadan önce ws\'te');
  assert.deepEqual([...p.errors, ...q.errors], []);
});

test('Algıla tek oyunculu: Say (nokta PNG) ve Yörünge (örnekler) oynanır, kusursuz cevap 100', async () => {
  const p = await phone('#/single/perceptle');
  const { page } = p;
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-go:has-text("Başla")');
  await page.waitForSelector('.pc-intro');
  await page.click('.rc-go:has-text("Hazırım")');
  await page.waitForSelector('.pc-stage canvas');
  await page.waitForTimeout(400);
  // Noktalar çizildi mi (canvas boş değil)
  const lit = await page.evaluate(() => { const c = document.querySelector('.pc-stage canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 200) n++; return n; });
  assert.ok(lit > 500, `noktalar çizilmedi (${lit})`);
  await page.screenshot({ path: `${SHOTS}perceptle-count-dots.png`, fullPage: true });
  const raw = (await secret(srv, { gameId: await freeGameId(p, '/api/perceptle/start') })).stimuli;
  const testRes = p.net.find((x) => x.path === '/api/perceptle/test').text;
  assert.ok(!testRes.includes('"dots"') && !testRes.includes(JSON.stringify(raw[0].dots[0])), 'nokta koordinatı ağda');
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 5000 });
  await page.fill('.pc-num', String(raw[0].dots.length));
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.match(await page.locator('.pc-big-score').textContent(), /^100/);
  await page.screenshot({ path: `${SHOTS}perceptle-count-result.png`, fullPage: true });

  // Yörünge
  await page.click('.rc-go:has-text("Sonraki test")');
  await page.click('.rc-go:has-text("Hazırım")');
  await page.waitForSelector('.pc-field');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}perceptle-track-flight.png`, fullPage: true });
  const tr = p.net.filter((x) => x.path === '/api/perceptle/test').at(-1).text;
  assert.ok(!/"(g|vx|vy|x0|y0|landing)":/.test(tr), `yörünge parametresi ağda: ${tr.slice(0, 200)}`);
  await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 6000 });
  const land = trackLanding(raw[1]);
  const fb = await page.locator('.pc-field canvas').boundingBox();
  await page.touchscreen.tap(fb.x + (land / 1000) * fb.width, fb.y + fb.height * 0.8);
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  const sc = Number((await page.locator('.pc-big-score').textContent()).match(/^\d+/)[0]);
  assert.ok(sc >= 95, `yörünge puanı ${sc}`); // dokunuş piksel çözünürlüğünde
  assert.equal(await page.locator('.pc-reveal canvas').count(), 1, 'sonuçta yay + iniş çizimi');
  await page.screenshot({ path: `${SHOTS}perceptle-track-result.png`, fullPage: true });
  assert.ok(await noHScroll(page));
  assert.deepEqual(p.errors, []);
});
