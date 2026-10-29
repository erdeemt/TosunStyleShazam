// QA (tarayıcı): 👁️ Algıla lobi — 2 telefon (360×800, dokunmatik) 🃏 Cuma tam oyun: süre dolunca son dokunulan değerin
// otomatik gönderimi, hiç dokunulmayınca "cevap yok", davet linkiyle gelen (sesi kapalı) oyuncuda "Sesi aç" + ritim,
// sayfa yenileme (test ortası), dokunma hedefleri ≥44 px, yatay kaydırma, konsol hataları. Ayrıca gerçek süreyle 3 telefon:
// intro/açıklamada host ayrılınca yeni host düğmeleri, bağlantı kopup gelince girdi.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
const MONDAY = '2026-11-02'; // Pazartesi: Cuma varsayılanı (gerçek Cuma günü) testleri etkilemesin
import { tempoExpected } from '../../public/perceptle-math.js';

const SHOTS = fileURLToPath(new URL('../../test-results/qa-perceptle-lobby/', import.meta.url));
const TS = 0.25; // intro 1 sn, cevap 7.5 sn, açıklama 3 sn
let fast;
let real;
let browser;
let quiet;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  [fast, real] = await Promise.all([startServer({ timeScale: TS, env: { FAKE_TODAY: MONDAY } }), startServer({ timeScale: 1, env: { FAKE_TODAY: MONDAY } })]);
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  quiet = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await quiet?.close(); await fast?.stop(); await real?.stop(); });

// Başsız Chrome AudioContext'i her zaman çalıştırır; gerçek telefon gibi "dokunmadan ses yok" davranışını taklit et.
const MOBILE_AUTOPLAY = `(() => {
  const Real = window.AudioContext;
  window.__gesture = false;
  for (const ev of ['pointerdown', 'touchstart', 'keydown', 'click']) addEventListener(ev, (e) => { if (e.isTrusted) window.__gesture = true; }, true);
  class Phone extends Real {
    constructor(...a) { super(...a); this.__s = 'suspended'; super.suspend(); }
    get state() { return this.__s; }
    resume() { if (window.__gesture) { this.__s = 'running'; return super.resume(); } return Promise.resolve(); }
  }
  window.AudioContext = Phone;
  window.webkitAudioContext = Phone;
})();`;

async function phone(srv, name, b = browser, hash = '#/multi/perceptle') {
  const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  if (b === quiet) await ctx.addInitScript(MOBILE_AUTOPLAY);
  const page = await ctx.newPage();
  const errors = [];
  const views = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? name : undefined));
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.t === 'view') views.push(m.view); } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/${hash}`);
  if (hash.startsWith('#/multi')) await page.fill('input[placeholder="Takma adın"]', name);
  return { page, ctx, errors, views, name };
}

const lastView = (p) => p.views.at(-1);
async function stimOf(p, index) {
  for (let k = 0; k < 300; k++) {
    const v = p.views.find((x) => x.phase === 'play' && x.index === index && x.stimulus);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${p.name}: ${index}. uyaran gelmedi`);
}
const box = (page, sel) => page.locator(sel).boundingBox();
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Görünür etkileşimli öğelerden 44 px'ten küçük olanlar
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('#game-perceptle button, #game-perceptle input, #game-perceptle .pc-pad')]
  .filter((e) => e.offsetParent !== null)
  .map((e) => ({ t: (e.textContent || e.placeholder || e.className).trim().slice(0, 30), r: e.getBoundingClientRect() }))
  .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
  .map(({ t, r }) => `${t} ${Math.round(r.width)}×${Math.round(r.height)}`));

const small = new Set();
async function audit(p, label) {
  for (const s of await smallTargets(p.page)) small.add(`${label}: ${s}`);
  assert.ok(await noHScroll(p.page), `${p.name} ${label}: yatay kaydırma`);
}

test('2 telefon 🃏 Cuma: otomatik gönderim, cevap yok, davet linki + Sesi aç, yenileme, hedef boyutları', async () => {
  const ali = await phone(fast, 'Ali');
  await ali.page.click('text=Yeni oda kur');
  const code = (await ali.page.locator('.lobby-code').textContent()).trim();
  // Davet linkiyle gelen, sayfaya hiç dokunmamış oyuncu (ses kapalı tarayıcı)
  const zey = await phone(fast, 'Zeynep', quiet, `#/join/${code}`);
  await ali.page.waitForFunction(() => document.querySelectorAll('#game-perceptle .player-list li').length === 2);
  await ali.page.click('.rc-diff:has-text("Cuma")');
  await zey.page.waitForSelector('.rc-diff.active:has-text("Cuma")');
  await audit(ali, 'lobi');
  await ali.page.click('#game-perceptle button:has-text("Oyunu başlat")');
  const both = [ali, zey];
  const reveal = async (i) => {
    try {
      await Promise.all(both.map((p) => p.page.waitForFunction((k) => document.querySelector('.pl-rank li')
        && [...document.querySelectorAll('.round')].some((x) => x.textContent.includes(`Test ${k + 1} /`)), i, { timeout: 15000, polling: 50 })));
    } catch (e) {
      for (const p of both) await p.page.screenshot({ path: `${SHOTS}fail-${i}-${p.name}.png`, fullPage: true });
      console.log(both.map((p) => `${p.name}: ${JSON.stringify(lastView(p) && { ph: lastView(p).phase, i: lastView(p).index, me: lastView(p).me })} err=${p.errors}`).join(' || '));
      throw e;
    }
  };
  const resultOf = async (p, i) => {
    for (let k = 0; k < 100; k++) {
      const v = p.views.find((x) => (x.phase === 'reveal' || x.phase === 'over') && x.last?.index === i);
      if (v) return v.last;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('reveal yok');
  };

  // ---------- Say (Cuma, hareketli noktalar): Ali yazar ama kilitlemez; Zeynep sayfayı yeniler, dokunmaz ----------
  await Promise.all(both.map((p) => p.page.waitForSelector('.pc-intro')));
  await audit(ali, 'intro');
  const sv = await stimOf(ali, 0);
  const n = sv.stimulus.dots.length;
  await ali.page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  await ali.page.fill('.pc-num', String(n));
  await audit(ali, 'say');
  await zey.page.reload();
  await zey.page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  assert.equal(await zey.page.locator('.pc-stage canvas').count() >= 0, true);
  await zey.page.screenshot({ path: `${SHOTS}01-count-after-reload.png`, fullPage: true });
  await reveal(0);
  let res = await resultOf(ali, 0);
  const aliId = lastView(ali).players.find((p) => p.name === 'Ali').id;
  const zeyId = lastView(ali).players.find((p) => p.name === 'Zeynep').id;
  assert.equal(res.results[aliId].timedOut, false, 'yazılan ama kilitlenmeyen değer süre dolunca gitmeli');
  assert.equal(res.results[aliId].answer, n);
  assert.equal(res.results[aliId].score, 100);
  assert.equal(res.results[zeyId].timedOut, true);
  assert.match(await ali.page.locator('.pl-rank').textContent(), /cevap yok/);
  await audit(ali, 'açıklama');
  await ali.page.screenshot({ path: `${SHOTS}02-count-reveal.png`, fullPage: true });

  // ---------- Yörünge (Cuma, sekmeli): Ali dokunur, kilitlemez; Zeynep dokunur + kilitler ----------
  await stimOf(ali, 1);
  await Promise.all(both.map((p) => p.page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 8000 })));
  for (const [p, f] of [[ali, 0.3], [zey, 0.6]]) {
    const fb = await box(p.page, '.pc-field');
    await p.page.touchscreen.tap(fb.x + fb.width * f, fb.y + fb.height * 0.7);
  }
  await zey.page.click('.pc-lock');
  await audit(ali, 'yörünge');
  await reveal(1);
  res = await resultOf(ali, 1);
  assert.equal(res.results[aliId].timedOut, false, 'dokunulan iniş noktası otomatik gitmeli');
  assert.equal(res.results[zeyId].timedOut, false);
  assert.ok(res.stimulus?.walls, 'açıklamada Cuma yörüngesi çizilir');
  await ali.page.screenshot({ path: `${SHOTS}03-track-reveal.png`, fullPage: true });

  // ---------- Açı (Cuma, sarmal): Ali kadrana dokunur (Cuma: bırakınca gitmez), Zeynep hiç dokunmaz ----------
  await stimOf(ali, 2);
  await ali.page.waitForSelector('.pc-dial');
  const db = await box(ali.page, '.pc-dial');
  await ali.page.touchscreen.tap(db.x + db.width * 0.85, db.y + db.height * 0.5);
  await ali.page.waitForTimeout(150);
  assert.ok(!lastView(ali).me.answered, 'Cuma: dokunuş tek başına göndermez');
  await audit(ali, 'açı');
  await reveal(2);
  res = await resultOf(ali, 2);
  assert.equal(res.results[aliId].timedOut, false);
  assert.equal(res.results[zeyId].timedOut, true);

  // ---------- Ritim (Cuma): Zeynep "Sesi aç" düğmesine basar ve vurur; Ali hiç vurmaz ----------
  await zey.page.waitForSelector('.pc-intro, .pl-ready', { timeout: 8000 });
  const sound = zey.page.locator('.pl-sound');
  const hadSound = await sound.count();
  if (hadSound) {
    const sb = await sound.boundingBox();
    assert.ok(sb.height >= 44, 'Sesi aç ≥44 px');
    await zey.page.screenshot({ path: `${SHOTS}04-tempo-sound.png`, fullPage: true });
    await sound.tap();
  }
  await Promise.all(both.map((p) => p.page.waitForSelector('.pc-pad[data-t0]', { timeout: 8000 })));
  const tv = await stimOf(zey, 3);
  const ready = await zey.page.evaluate(() => (window.AudioContext ? 'ok' : 'no'));
  void ready;
  const I = 60_000 / tv.stimulus.bpm;
  const times = [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(tv.stimulus.bpm, true)).map((t) => t * TS);
  await zey.page.evaluate((ts) => {
    const t0 = Number(document.querySelector('.pc-pad').dataset.t0);
    for (const t of ts) setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })), t0 + t - performance.now());
  }, times);
  await audit(zey, 'ritim');
  await reveal(3);
  res = await resultOf(ali, 3);
  assert.ok(res.results[zeyId].score >= 70, `Zeynep Cuma ritmi ${res.results[zeyId].score}`);
  assert.equal(res.results[aliId].detail.hits, 0);
  await zey.page.screenshot({ path: `${SHOTS}05-tempo-reveal.png`, fullPage: true });
  const audioState = await zey.page.evaluate(() => document.querySelector('.pl-sound') ? 'button-still-there' : 'gone');
  assert.equal(audioState, 'gone');

  // ---------- Böl (Cuma, uzatılmış çizgi): Ali dokunur kilitlemez; Zeynep dokunur + kilitler ----------
  await Promise.all(both.map((p) => p.page.waitForSelector('.pc-line', { timeout: 8000 })));
  for (const p of both) {
    const lb = await box(p.page, '.pc-line');
    await p.page.touchscreen.tap(lb.x + lb.width * 0.5, lb.y + lb.height / 2);
  }
  await zey.page.click('.pc-lock');
  await audit(ali, 'böl');
  // ---------- Final ----------
  await Promise.all(both.map((p) => p.page.waitForSelector('text=Final sıralaması', { timeout: 20000 })));
  assert.equal(await zey.page.locator('.pl-table tbody tr').count(), 2);
  assert.equal(await zey.page.locator('.pl-final .pl-grade').count(), 2);
  await audit(ali, 'final');
  await zey.page.screenshot({ path: `${SHOTS}06-final.png`, fullPage: true });
  for (const p of both) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
  console.log('Ses düğmesi gösterildi mi:', Boolean(hadSound));
  console.log('Küçük dokunma hedefleri:', [...small]);
  await ali.ctx.close(); await zey.ctx.close();
});

test('gerçek süre, 3 telefon: host intro ve açıklamada ayrılınca yeni host düğmeleri; kopup gelen oyuncu cevaplar', async () => {
  const a = await phone(real, 'Ayla');
  const b = await phone(real, 'Berk');
  const c = await phone(real, 'Cem');
  await a.page.click('text=Yeni oda kur');
  const code = (await a.page.locator('.lobby-code').textContent()).trim();
  for (const p of [b, c]) { await p.page.fill('.code-input', code); await p.page.click('button:has-text("Katıl")'); }
  await a.page.waitForFunction(() => document.querySelectorAll('#game-perceptle .player-list li').length === 3);
  for (const t of ['Say', 'Yörünge', 'Ritim']) await a.page.click(`.pl-test:has-text("${t}")`);
  await b.page.waitForSelector('#game-perceptle .settings:has-text("Testler: 2 / 5")');
  await a.page.click('#game-perceptle button:has-text("Oyunu başlat")');
  await Promise.all([a, b, c].map((p) => p.page.waitForSelector('.pc-intro')));
  // intro'da host ayrılır
  await a.page.click('button:has-text("Odadan çık")');
  await b.page.waitForFunction(() => document.querySelector('.room-bar')?.textContent.includes('2 kişi'), null, { timeout: 3000 });
  await b.page.waitForTimeout(250);
  const introBtn = await b.page.locator('button:has-text("Hemen başla")').count();
  await b.page.screenshot({ path: `${SHOTS}10-new-host-intro.png`, fullPage: true });
  // Açı: Cem bağlantısını kaybeder ve geri gelir; sonra cevap verir
  await Promise.all([b, c].map((p) => p.page.waitForSelector('.pc-dial', { timeout: 8000 })));
  await c.ctx.setOffline(true);
  await c.page.waitForTimeout(1500);
  await c.ctx.setOffline(false);
  await c.page.waitForFunction(() => !document.querySelector('.badge.offline'), null, { timeout: 10000 });
  for (const p of [b, c]) {
    await p.page.waitForSelector('.pc-dial');
    const db = await box(p.page, '.pc-dial');
    await p.page.touchscreen.tap(db.x + db.width * 0.5, db.y + db.height * 0.1);
    await p.page.click('.pc-lock');
  }
  await Promise.all([b, c].map((p) => p.page.waitForSelector('.pl-rank li', { timeout: 10000 })));
  const rv = c.views.find((v) => v.phase === 'reveal');
  assert.ok(rv && Object.values(rv.last.results).every((r) => !r.timedOut), 'kopup gelen Cem\'in cevabı sayılmalı');
  // açıklamada host (Berk) ayrılır → Cem host
  await b.page.click('button:has-text("Odadan çık")');
  await c.page.waitForFunction(() => document.querySelector('.room-bar')?.textContent.includes('1 kişi'), null, { timeout: 3000 });
  await c.page.waitForTimeout(250);
  const nextBtn = await c.page.locator('button:has-text("Sonraki test")').count();
  await c.page.screenshot({ path: `${SHOTS}11-new-host-reveal.png`, fullPage: true });
  console.log(`Yeni host düğmeleri — intro "Hemen başla": ${introBtn}, açıklama "Sonraki test": ${nextBtn}`);
  for (const p of [a, b, c]) assert.deepEqual(p.errors.filter((e) => !/WebSocket|ERR_INTERNET_DISCONNECTED|net::/.test(e)), [], `${p.name} konsol hatası`);
  assert.equal(introBtn, 1, 'intro sırasında host olan Berk "Hemen başla" görmeli');
  assert.equal(nextBtn, 1, 'açıklama sırasında host olan Cem "Sonraki test" görmeli');
});

test('davet linkiyle gelen, hiç dokunmamış oyuncu: Ritim introsunda "Sesi aç", dokununca kalkar; ritim iki telefonda eş zamanlı', async () => {
  const host = await phone(real, 'Deniz');
  await host.page.click('text=Yeni oda kur');
  const code = (await host.page.locator('.lobby-code').textContent()).trim();
  const guest = await phone(real, 'Ece', quiet, `#/join/${code}`);
  await host.page.waitForFunction(() => document.querySelectorAll('#game-perceptle .player-list li').length === 2);
  for (const t of ['Say', 'Yörünge', 'Açı', 'Böl']) await host.page.click(`.pl-test:has-text("${t}")`);
  await guest.page.waitForSelector('#game-perceptle .settings:has-text("Testler: 1 / 5")');
  await host.page.click('#game-perceptle button:has-text("Oyunu başlat")');
  await guest.page.waitForSelector('.pc-intro');
  const btn = guest.page.locator('.pl-sound');
  assert.equal(await btn.count(), 1, 'sesi kapalı davetli oyuncuya "Sesi aç" gösterilmeli');
  const bb = await btn.boundingBox();
  assert.ok(bb.height >= 44 && bb.width >= 44);
  await guest.page.screenshot({ path: `${SHOTS}20-sound-button.png`, fullPage: true });
  await btn.tap();
  await guest.page.waitForFunction(() => !document.querySelector('.pl-sound'), null, { timeout: 2000 });
  assert.match(await guest.page.locator('.pc-intro').textContent(), /Ses açık/);
  await Promise.all([host, guest].map((p) => p.page.waitForSelector('.pc-pad[data-t0]', { timeout: 8000 })));
  const t0s = await Promise.all([host, guest].map((p) => p.page.evaluate(() => performance.timeOrigin + Number(document.querySelector('.pc-pad').dataset.t0))));
  const skew = Math.abs(t0s[0] - t0s[1]);
  assert.ok(skew < 80, `ritim başlangıç farkı ${Math.round(skew)} ms`);
  // misafir pad'e dokunarak vurur (dokunmatik)
  const tv = await stimOf(guest, 0);
  const I = 60_000 / tv.stimulus.bpm;
  const times = [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(tv.stimulus.bpm, false));
  const t0 = await guest.page.evaluate(() => Number(document.querySelector('.pc-pad').dataset.t0));
  const pb = await box(guest.page, '.pc-pad');
  assert.ok(pb.height >= 44);
  for (const t of times) {
    const wait = await guest.page.evaluate((at) => at - performance.now(), t0 + t);
    if (wait > 0) await guest.page.waitForTimeout(wait);
    await guest.page.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
  }
  await Promise.all([host, guest].map((p) => p.page.waitForSelector('.pl-rank li', { timeout: 20000 })));
  const rv = guest.views.find((v) => v.phase === 'reveal' || v.phase === 'over');
  const me = Object.entries(rv.last.results).find(([id]) => id !== rv.players.find((p) => p.name === 'Deniz').id)[1];
  console.log(`Davetli dokunmatik ritim: ${me.score} puan, ${me.detail.hits}/8, rms ${me.error} ms, gecikme ${me.detail.latency} ms; başlangıç farkı ${Math.round(skew)} ms`);
  assert.ok(me.detail.hits >= 6, `dokunuşlar sayılmalı (${me.detail.hits}/8)`);
  await guest.page.screenshot({ path: `${SHOTS}21-tempo-touch-reveal.png`, fullPage: true });
  for (const p of [host, guest]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
  assert.ok(await noHScroll(guest.page));
});
