// Tarayıcı testi: 👁️ Algıla lobi — 3 telefon (360×800) tam oyun: Say, Yörünge (sürükleme), Açı, Ritim (Boşluk tuşu,
// vuruş anında), Böl; uyaran herkese aynı anda, başkası cevaplayınca girdi sıfırlanmaz, açıklama ve final ekranı.
// Ekran görüntüleri: test-results/perceptle-lobby/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
const MONDAY = '2026-11-02'; // Pazartesi: Cuma varsayılanı (gerçek Cuma günü) testleri etkilemesin
import { tempoExpected, trackLanding, splitValue } from '../../public/perceptle-math.js';

const SHOTS = fileURLToPath(new URL('../../test-results/perceptle-lobby/', import.meta.url));
let srv;
let browser;
let quietBrowser; // sesi kendiliğinden açmayan tarayıcı (davet linkinden gelen, hiç dokunmamış oyuncu gibi)

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: MONDAY } });
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  quietBrowser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await quietBrowser?.close(); await srv?.stop(); });

async function phone(name, b = browser) {
  const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  const views = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.t === 'view') views.push(m.view); } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/#/multi/perceptle`);
  await page.fill('input[placeholder="Takma adın"]', name);
  return { page, errors, views, name };
}

// i. testin uyaranı (WebSocket görünümünden)
async function stimOf(p, index) {
  for (let k = 0; k < 200; k++) {
    const v = p.views.find((x) => x.phase === 'play' && x.index === index && x.stimulus);
    if (v) return v.stimulus;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${p.name}: ${index}. uyaran gelmedi`);
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const box = (page, sel) => page.locator(sel).boundingBox();
const myScore = async (page) => Number((await page.locator('.pc-big-score').textContent()).match(/^\d+/)[0]);
const answeredCount = (page, n) => page.waitForFunction((k) => document.querySelectorAll('.rc-check').length
  && [...document.querySelectorAll('.rc-check')].filter((x) => x.textContent.includes('cevapladı')).length >= k, n);

async function hostGo(host, phones) {
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-intro')));
  await host.page.click('button:has-text("Hemen başla")');
}

async function waitReveal(phones, timeout = 15000) {
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pl-rank li', { timeout })));
}

// Ritim: sayfanın kendi saatinde vuruş anlarına Boşluk tuşu olayları
async function tapTempo(page, stim, offsetMs) {
  const I = 60_000 / stim.bpm;
  const times = [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(stim.bpm, false)).map((t) => t + offsetMs);
  await page.evaluate((ts) => {
    const t0 = Number(document.querySelector('.pc-pad').dataset.t0);
    for (const t of ts) setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })), t0 + t - performance.now());
  }, times);
}

test('3 telefon lobi: 5 test, aynı anda uyaran, gizli cevaplar, girdi korunur, açıklama ve final', async () => {
  const ali = await phone('Ali');
  const ayse = await phone('Ayşe');
  const mert = await phone('Mert', quietBrowser);
  const phones = [ali, ayse, mert];
  await ali.page.click('text=Yeni oda kur');
  const code = (await ali.page.locator('.lobby-code').textContent()).trim();
  for (const p of [ayse, mert]) {
    await p.page.fill('.code-input', code);
    await p.page.click('button:has-text("Katıl")');
  }
  await ali.page.waitForFunction(() => document.querySelectorAll('#game-perceptle .player-list li').length === 3);
  assert.equal(await ali.page.locator('.pl-test.active').count(), 5, 'varsayılan: hepsi');
  assert.match(await ali.page.locator('#game-perceptle .settings').textContent(), /Hepsi \(5 test\)/);
  assert.equal(await ayse.page.locator('.pl-test[disabled]').count(), 5, 'ayarları sadece host değiştirir');
  // Cuma'yı açıp kapat, bir testi çıkarıp geri ekle (ayar senkronu)
  await ali.page.click('.rc-diff:has-text("Cuma")');
  await ayse.page.waitForSelector('.rc-diff.active:has-text("Cuma")');
  await ali.page.click('.rc-diff:has-text("Normal")');
  await ali.page.click('.pl-test:has-text("Ritim")');
  await ayse.page.waitForSelector('#game-perceptle .settings:has-text("Testler: 4 / 5")');
  await ali.page.click('.pl-test:has-text("Ritim")');
  await ayse.page.waitForSelector('#game-perceptle .settings:has-text("Hepsi (5 test)")');
  await ayse.page.waitForSelector('.rc-diff.active:has-text("Normal")');
  await ali.page.screenshot({ path: `${SHOTS}01-lobby.png`, fullPage: true });
  await ali.page.click('#game-perceptle button:has-text("Oyunu başlat")');

  // ---------- 1. Say ----------
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-intro .pl-count')));
  assert.equal(await ayse.page.locator('button:has-text("Hemen başla")').count(), 0, 'sadece host atlar');
  await ayse.page.screenshot({ path: `${SHOTS}02-intro.png`, fullPage: true });
  await ali.page.click('button:has-text("Hemen başla")');
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-stage canvas')));
  await ayse.page.waitForTimeout(300);
  await ayse.page.screenshot({ path: `${SHOTS}03-count-dots.png`, fullPage: true });
  const n = (await stimOf(ali, 0)).dots.length;
  assert.equal((await stimOf(mert, 0)).dots.length, n, 'herkese aynı noktalar');
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-num:not([disabled])', { timeout: 5000 })));
  await ali.page.fill('.pc-num', String(n));
  await ali.page.click('.pc-lock');
  await ali.page.waitForSelector('text=Cevabın gönderildi');
  await mert.page.fill('.pc-num', String(n + 5)); // yazdı ama henüz kilitlemedi
  await answeredCount(ayse.page, 1);
  assert.ok(!(await ayse.page.locator('#game-perceptle').textContent()).includes(String(n)), 'Ali\'nin cevabı açıklanmadan görünmemeli');
  await ayse.page.fill('.pc-num', String(n - 3));
  await ayse.page.screenshot({ path: `${SHOTS}04-count-answer.png`, fullPage: true });
  await ayse.page.click('.pc-lock');
  await answeredCount(mert.page, 2);
  assert.equal(await mert.page.inputValue('.pc-num'), String(n + 5), 'başkaları cevaplayınca yazı silinmemeli');
  await mert.page.screenshot({ path: `${SHOTS}05-count-status.png`, fullPage: true });
  await mert.page.click('.pc-lock');
  await waitReveal(phones);
  assert.match(await ali.page.locator('.pl-rank li').first().textContent(), /Ali.*100/s);
  assert.equal(await ali.page.locator('.pl-rank li').count(), 3);
  assert.match(await ayse.page.locator('.pc-detail').textContent(), new RegExp(`Gerçek ${n} · Sen ${n - 3}`));
  await ayse.page.screenshot({ path: `${SHOTS}06-count-reveal.png`, fullPage: true });
  assert.equal(await mert.page.locator('button:has-text("Sonraki test")').count(), 0, 'sadece host geçirir');
  await ali.page.click('button:has-text("Sonraki test")');

  // ---------- 2. Yörünge (sürükleme) ----------
  await hostGo(ali, phones);
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 6000 })));
  const land = trackLanding(await stimOf(ali, 1));
  const fb = await box(ayse.page, '.pc-field');
  // Ayşe sürükler: soldan iniş noktasının biraz sağına
  await ayse.page.mouse.move(fb.x + 10, fb.y + fb.height / 2);
  await ayse.page.mouse.down();
  for (let k = 1; k <= 10; k++) await ayse.page.mouse.move(fb.x + 10 + (((land + 40) / 1000) * fb.width - 10) * (k / 10), fb.y + fb.height / 2);
  await ayse.page.mouse.up();
  const before = await ayse.page.locator('.pc-field').screenshot();
  const ab = await box(ali.page, '.pc-field');
  await ali.page.touchscreen.tap(ab.x + (land / 1000) * ab.width, ab.y + ab.height * 0.7);
  await ali.page.click('.pc-lock');
  const mb = await box(mert.page, '.pc-field');
  await mert.page.touchscreen.tap(mb.x + mb.width * 0.2, mb.y + mb.height / 2);
  await mert.page.click('.pc-lock');
  await answeredCount(ayse.page, 2);
  await ayse.page.waitForTimeout(100);
  const afterShot = await ayse.page.locator('.pc-field').screenshot();
  assert.ok(before.equals(afterShot), 'başkaları cevaplayınca sürüklenen işaret kaybolmamalı');
  await ayse.page.screenshot({ path: `${SHOTS}07-track-drag.png`, fullPage: true });
  await ayse.page.click('.pc-lock');
  await waitReveal(phones);
  assert.ok(await myScore(ali.page) >= 95, `Ali yörünge ${await myScore(ali.page)}`);
  assert.match(await ayse.page.locator('.pc-detail').textContent(), /İniş \d+ · Sen \d+/);
  await ayse.page.screenshot({ path: `${SHOTS}08-track-reveal.png`, fullPage: true });
  await ali.page.click('button:has-text("Sonraki test")');

  // ---------- 3. Açı ----------
  await hostGo(ali, phones);
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-dial')));
  const target = (await stimOf(ali, 2)).target;
  for (const [p, delta] of [[ali, 0], [ayse, 20], [mert, -35]]) {
    const db = await box(p.page, '.pc-dial');
    const rad = ((target + delta) * Math.PI) / 180;
    await p.page.touchscreen.tap(db.x + db.width / 2 + Math.cos(rad) * db.width * 0.4, db.y + db.height / 2 - Math.sin(rad) * db.width * 0.4);
    await p.page.click('.pc-lock');
  }
  await waitReveal(phones);
  assert.ok(await myScore(ali.page) >= 90);
  await mert.page.screenshot({ path: `${SHOTS}09-angle-reveal.png`, fullPage: true });
  await ali.page.click('button:has-text("Sonraki test")');

  // ---------- 4. Ritim (Boşluk tuşu, vuruş anında) ----------
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-intro')));
  const sound = mert.page.locator('.pl-sound');
  if (await sound.count()) { // ses kapalıysa düğme görünür; dokununca kalkar
    await mert.page.screenshot({ path: `${SHOTS}10-tempo-sound.png`, fullPage: true });
    await sound.click();
    await mert.page.waitForSelector('.pl-sound', { state: 'detached', timeout: 2000 });
  }
  await ali.page.click('button:has-text("Hemen başla")');
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-pad[data-t0]', { timeout: 5000 })));
  const t0s = await Promise.all(phones.map((p) => p.page.evaluate(() => performance.timeOrigin + Number(document.querySelector('.pc-pad').dataset.t0))));
  assert.ok(Math.max(...t0s) - Math.min(...t0s) < 80, `ritim herkese aynı anda başlamalı (fark ${Math.round(Math.max(...t0s) - Math.min(...t0s))} ms)`);
  const tempo = await stimOf(ali, 3);
  await tapTempo(ali.page, tempo, 30); // 30 ms gecikme: ısınma kalibrasyonu düzeltir
  await tapTempo(ayse.page, tempo, 0);
  // Mert vurmaz
  await ali.page.waitForTimeout(800);
  await ali.page.screenshot({ path: `${SHOTS}11-tempo.png`, fullPage: true });
  await waitReveal(phones, 20000);
  assert.ok(await myScore(ali.page) >= 80, `Ali ritim ${await myScore(ali.page)}`);
  assert.ok(await myScore(ayse.page) >= 80, `Ayşe ritim ${await myScore(ayse.page)}`);
  assert.ok(await myScore(mert.page) <= 5, 'vurmayan neredeyse 0');
  assert.match(await ali.page.locator('.pc-detail').textContent(), new RegExp(`${tempo.bpm} BPM · 8/8 vuruş`));
  await ali.page.screenshot({ path: `${SHOTS}12-tempo-reveal.png`, fullPage: true });
  await ali.page.click('button:has-text("Sonraki test")');

  // ---------- 5. Böl ----------
  await hostGo(ali, phones);
  await Promise.all(phones.map((p) => p.page.waitForSelector('.pc-line')));
  const v = splitValue(await stimOf(ali, 4));
  for (const [p, delta] of [[ali, 0], [ayse, 0.1], [mert, -0.2]]) {
    const sb = await box(p.page, '.pc-line');
    await p.page.touchscreen.tap(sb.x + sb.width * (0.08 + 0.84 * Math.min(1, Math.max(0, v + delta))), sb.y + sb.height / 2);
    await p.page.click('.pc-lock');
  }
  await waitReveal(phones);
  await ali.page.screenshot({ path: `${SHOTS}13-split-reveal.png`, fullPage: true });
  await ali.page.click('button:has-text("Sonuçları göster")');

  // ---------- Final ----------
  await Promise.all(phones.map((p) => p.page.waitForSelector('text=Final sıralaması')));
  assert.match(await mert.page.locator('.pl-final li').first().textContent(), /Ali/);
  assert.equal(await mert.page.locator('.pl-table tbody tr').count(), 3);
  assert.equal(await mert.page.locator('.pl-table thead th').count(), 7);
  assert.match(await ali.page.locator('.pl-final .pl-grade').first().textContent(), /^[SABCDF]$/);
  assert.match(await ali.page.locator('.rc-winner').textContent(), /Ali kazandı/);
  assert.equal(await ali.page.locator('button:has-text("Bekleme odasına dön")').count(), 1);
  await mert.page.screenshot({ path: `${SHOTS}14-final.png`, fullPage: true });
  for (const p of phones) {
    assert.ok(await noHorizontalScroll(p.page), `${p.name}: yatay kaydırma`);
    assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
  }
});

test('2 telefon: tek test (Böl), beraberlik, geç katılan izleyici, tek oyunculu mod bozulmadı', async () => {
  const a = await phone('Can');
  const b = await phone('Ece');
  await a.page.click('text=Yeni oda kur');
  const code = (await a.page.locator('.lobby-code').textContent()).trim();
  await b.page.fill('.code-input', code);
  await b.page.click('button:has-text("Katıl")');
  await a.page.waitForFunction(() => document.querySelectorAll('#game-perceptle .player-list li').length === 2);
  for (const t of ['Say', 'Yörünge', 'Açı', 'Ritim']) await a.page.click(`.pl-test:has-text("${t}")`);
  await b.page.waitForSelector('#game-perceptle .settings:has-text("Testler: 1 / 5")');
  // son test kapatılamaz
  await a.page.click('.pl-test:has-text("Böl")');
  await a.page.waitForTimeout(200);
  assert.equal(await a.page.locator('.pl-test.active').count(), 1);
  await a.page.click('#game-perceptle button:has-text("Oyunu başlat")');
  await hostGo(a, [a, b]);
  // oyun ortası izleyici
  const c = await phone('Gül');
  await c.page.fill('.code-input', code);
  await c.page.click('button:has-text("Katıl")');
  await c.page.waitForSelector('text=İzliyorsun');
  await c.page.screenshot({ path: `${SHOTS}20-spectator.png`, fullPage: true });
  const v = splitValue(await stimOf(a, 0));
  for (const p of [a, b]) {
    await p.page.waitForSelector('.pc-line');
    const sb = await box(p.page, '.pc-line');
    await p.page.touchscreen.tap(sb.x + sb.width * (0.08 + 0.84 * v), sb.y + sb.height / 2);
    await p.page.click('.pc-lock');
  }
  await waitReveal([a, b, c]);
  await a.page.click('button:has-text("Sonuçları göster")');
  await Promise.all([a, b, c].map((p) => p.page.waitForSelector('text=Final sıralaması')));
  const scores = await a.page.locator('.pl-final .rc-sum').allTextContents();
  if (scores[0] === scores[1]) {
    assert.match(await c.page.locator('.rc-winner').textContent(), /Berabere/);
    assert.deepEqual(await a.page.locator('.pl-final .w-rank').allTextContents(), ['🥇', '🥇']);
  }
  await c.page.screenshot({ path: `${SHOTS}21-final-spectator.png`, fullPage: true });

  // tek oyunculu kategori aynı sayfada hâlâ çalışır
  await a.page.goto(`${srv.url}/#/single/perceptle`);
  await a.page.waitForSelector('#game-perceptle .pc-start, #game-perceptle .rc-diffs', { timeout: 5000 });
  assert.equal(await a.page.locator('#game-perceptle .lobby-code, #game-perceptle .code-input').count(), 0, 'lobi ekranı kalmamalı');
  for (const p of [a, b, c]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});

test('kaybolan cevap: bir kez kendiliğinden yeniden gönderilir; o da kaybolursa Kilitle tekrar açılır ve cevap sayılır', async () => {
  const p = await phone('Deniz');
  await p.page.click('text=Yeni oda kur');
  await p.page.waitForSelector('.lobby-code');
  for (const t of ['Say', 'Yörünge', 'Ritim']) await p.page.click(`.pl-test:has-text("${t}")`);
  await p.page.waitForSelector('#game-perceptle .settings:has-text("Testler: 2 / 5")');
  // Sonraki n "answer" mesajını ağa hiç çıkarmadan düşür (bağlantı kopmuş gibi)
  const dropAnswers = (n) => p.page.evaluate((k) => {
    window.__drop = k;
    if (window.__patched) return;
    window.__patched = true;
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (window.__drop > 0 && String(data).includes('"type":"answer"')) { window.__drop--; return; }
      return orig.call(this, data);
    };
  }, n);
  await p.page.click('#game-perceptle button:has-text("Oyunu başlat")');

  // 1) Açı: ilk gönderim kaybolur, otomatik yeniden gönderim tutar
  await hostGo(p, [p]);
  await p.page.waitForSelector('.pc-dial');
  const target = (await stimOf(p, 0)).target;
  await dropAnswers(1);
  const db = await box(p.page, '.pc-dial');
  const rad = (target * Math.PI) / 180;
  await p.page.touchscreen.tap(db.x + db.width / 2 + Math.cos(rad) * db.width * 0.4, db.y + db.height / 2 - Math.sin(rad) * db.width * 0.4);
  await p.page.click('.pc-lock');
  await waitReveal([p], 8000);
  assert.ok(await myScore(p.page) >= 90, `yeniden gönderilen açı sayılmalı (${await myScore(p.page)})`);
  await p.page.click('button:has-text("Sonraki test")');

  // 2) Böl: iki gönderim de kaybolur → Kilitle açılır, tekrar basınca sayılır
  await hostGo(p, [p]);
  await p.page.waitForSelector('.pc-line');
  const v = splitValue(await stimOf(p, 1));
  await dropAnswers(2);
  const sb = await box(p.page, '.pc-line');
  await p.page.touchscreen.tap(sb.x + sb.width * (0.08 + 0.84 * v), sb.y + sb.height / 2);
  await p.page.click('.pc-lock');
  assert.equal(await p.page.locator('.pc-lock').isDisabled(), true);
  await p.page.waitForSelector('.pc-lock:not([disabled])', { timeout: 6000 });
  await p.page.screenshot({ path: `${SHOTS}30-lock-reopened.png`, fullPage: true });
  await p.page.click('.pc-lock');
  await waitReveal([p], 8000);
  assert.ok(await myScore(p.page) >= 90, `tekrar gönderilen böl sayılmalı (${await myScore(p.page)})`);
  assert.deepEqual(p.errors, []);
});
