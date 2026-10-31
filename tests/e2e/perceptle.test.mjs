// Tarayıcı testi: 👁️ Algıla — tam günlük oyun (5 test, dokunmatik 360×800) ve sınırsız Cuma kuralları oyunu.
// Ekran görüntüleri: test-results/perceptle/.
import { secret } from '../lib/media.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { tempoExpected, trackLanding, splitValue } from '../../public/perceptle-math.js';

const DAY = '2026-11-02'; // Pazartesi
const SHOTS = fileURLToPath(new URL('../../test-results/perceptle/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY } });
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  const stimuli = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', async (res) => {
    // İstemciye ham uyaran gitmiyor (nokta PNG'si / yörünge örnekleri): kusursuz cevap için testlere özel uçtan ham hâli
    if (res.url().endsWith('/api/perceptle/test') && res.ok()) {
      const j = await res.json().catch(() => null);
      if (j) { j.public = j.stimulus; j.stimulus = (await secret(srv, { gameId: j.gameId })).stimuli[j.index]; }
      stimuli.push(j);
    }
  });
  // Yanıt gövdesi olaydan biraz sonra gelir: i. test uyaranını bekle
  stimuli.at = async (i) => {
    for (let k = 0; k < 100 && !stimuli[i]; k++) await new Promise((r) => setTimeout(r, 20));
    return stimuli[i];
  };
  await page.goto(`${srv.url}/${hash}`);
  return { page, errors, stimuli };
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const box = async (page, sel) => (await page.locator(sel).boundingBox());
const lastScore = async (page) => Number((await page.locator('.pc-big-score').textContent()).match(/^\d+/)[0]);

async function next(page, label = 'Hazırım') {
  await page.click(`.rc-go:has-text("${label}")`);
}

// Ritim: vuruş zamanlarında (sayfanın kendi saatine göre) Boşluk tuşu olayları gönder.
async function tapTempo(page, stim, friday, offsetMs = 0) {
  await page.waitForSelector('.pc-pad[data-t0]');
  const times = (() => {
    const I = 60_000 / stim.bpm;
    return [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(stim.bpm, friday)).map((t) => t + offsetMs);
  })();
  await page.evaluate((ts) => {
    const pad = document.querySelector('.pc-pad');
    const t0 = Number(pad.dataset.t0);
    for (const t of ts) {
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })), t0 + t - performance.now());
    }
  }, times);
}

test('günlük: 5 test dokunmatikle, sonuçlar, not, sıralama, yenileyince bitmiş oyun', async () => {
  const { page, errors, stimuli } = await phone('#/single/perceptle');
  await page.fill('input[placeholder="Takma adın"]', 'Kartal');
  await page.click('button:has-text("Kaydet")');
  await page.waitForSelector('.pc-start');
  assert.equal(await page.locator('.pc-friday').count(), 0, 'Pazartesi Cuma kuralı yok');
  assert.match(await page.locator('.howto').textContent(), /Say.*Yörünge.*Açı.*Ritim.*Böl/s);
  await page.screenshot({ path: `${SHOTS}01-start.png`, fullPage: true });
  await next(page, 'Başla');
  await page.waitForSelector('.pc-intro');
  await page.screenshot({ path: `${SHOTS}02-intro-count.png`, fullPage: true });

  // 1. Say
  await next(page);
  await page.waitForSelector('.pc-stage canvas');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}03-count-dots.png`, fullPage: true });
  assert.equal(await page.locator('.pc-num').isDisabled(), true, 'gösterim sırasında cevap yazılamaz');
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 4000 });
  const n = (await stimuli.at(0)).stimulus.dots.length;
  await page.fill('.pc-num', String(n - 3));
  await page.screenshot({ path: `${SHOTS}04-count-answer.png`, fullPage: true });
  assert.ok(await noHorizontalScroll(page));
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.match(await page.locator('.pc-detail').textContent(), new RegExp(`Gerçek ${n} · Sen ${n - 3} · %\\d+ hata`));
  assert.equal(await lastScore(page), Math.round(100 * Math.exp(-0.5 * ((3 / n) / 0.2) ** 2)));
  await page.screenshot({ path: `${SHOTS}05-count-result.png`, fullPage: true });

  // 2. Yörünge: kaybolunca iniş noktasına dokun, kaydır, kilitle
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-field');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}06-track-flight.png`, fullPage: true });
  assert.equal(await page.locator('.pc-lock').isDisabled(), true, 'dokunmadan kilitlenemez');
  await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 4000 });
  const land = trackLanding((await stimuli.at(1)).stimulus);
  const fb = await box(page, '.pc-field');
  await page.touchscreen.tap(fb.x + 20, fb.y + fb.height / 2); // önce yanlış yere
  await page.touchscreen.tap(fb.x + (land / 1000) * fb.width, fb.y + fb.height * 0.8); // sonra düzelt
  await page.screenshot({ path: `${SHOTS}07-track-guess.png`, fullPage: true });
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.ok(await lastScore(page) >= 95, `yörünge puanı ${await lastScore(page)}`);
  assert.match(await page.locator('.pc-detail').textContent(), /İniş \d+ · Sen \d+ · \d+ birim fark/);
  await page.screenshot({ path: `${SHOTS}08-track-result.png`, fullPage: true });

  // 3. Açı: hedef açıya dokun, sonra Kilitle (tek dokunuş göndermez; sürükleyip bırakmak gönderir); değer ekranda yazmaz
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-dial');
  const target = (await stimuli.at(2)).stimulus.target;
  assert.equal((await page.locator('.pc-target').textContent()).trim(), `${target}°`);
  await page.screenshot({ path: `${SHOTS}09-angle.png`, fullPage: true });
  const db = await box(page, '.pc-dial');
  const cx = db.x + db.width / 2;
  const cy = db.y + db.height / 2;
  const R = db.width * 0.4;
  const rad = (target * Math.PI) / 180;
  await page.touchscreen.tap(cx + Math.cos(rad) * R, cy - Math.sin(rad) * R);
  await page.click(".pc-lock"); // tek dokunuş göndermez (kaza dokunuşu), Kilitle gönderir
  await page.waitForSelector('.pc-big-score');
  assert.ok(await lastScore(page) >= 90, `açı puanı ${await lastScore(page)}`);
  assert.match(await page.locator('.pc-detail').textContent(), new RegExp(`Hedef ${target}° · Sen [\\d,]+° · [\\d,]+° fark`));
  await page.screenshot({ path: `${SHOTS}10-angle-result.png`, fullPage: true });

  // 4. Ritim: 4 ısınma + 8 sessiz vuruş, hepsi +30 ms gecikmeli (kalibrasyon düzeltir)
  await next(page, 'Sonraki test');
  await page.waitForSelector('.pc-intro');
  await next(page);
  await page.waitForSelector('.pc-pad');
  const tempoStim = (await stimuli.at(3)).stimulus;
  await tapTempo(page, tempoStim, false, 30);
  await page.waitForTimeout(1500 + (60_000 / tempoStim.bpm) * 2);
  await page.waitForSelector('.pc-big-score', { timeout: 15000 });
  assert.ok(await lastScore(page) >= 80, `ritim puanı ${await lastScore(page)}`);
  assert.match(await page.locator('.pc-detail').textContent(), new RegExp(`${tempoStim.bpm} BPM · 8/8 vuruş`));
  await page.screenshot({ path: `${SHOTS}12-tempo-result.png`, fullPage: true });

  // 5. Böl: işaretçiyi sürükle, kilitle
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-line');
  const sb = await box(page, '.pc-line');
  const v = splitValue((await stimuli.at(4)).stimulus);
  const x = sb.x + sb.width * (0.08 + 0.84 * v);
  await page.touchscreen.tap(x, sb.y + sb.height / 2);
  await page.screenshot({ path: `${SHOTS}13-split.png`, fullPage: true });
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.ok(await lastScore(page) >= 90, `böl puanı ${await lastScore(page)}`);
  await page.screenshot({ path: `${SHOTS}14-split-result.png`, fullPage: true });

  await page.click('.rc-go:has-text("Sonucu gör")');
  await page.waitForSelector('.pc-final');
  await page.waitForSelector('.rc-board li');
  assert.match(await page.locator('.pc-grade').textContent(), /^[SABCDF]$/);
  assert.equal(await page.locator('.pc-final .pc-row').count(), 5);
  assert.match(await page.locator('.rc-board').textContent(), /Kartal/);
  assert.equal(await page.locator('.pc-board .pc-chip').count(), 5, 'bitirince kendi test puanları görünür');
  assert.ok(await noHorizontalScroll(page));
  await page.screenshot({ path: `${SHOTS}15-final.png`, fullPage: true });

  await page.reload();
  await page.waitForSelector('.pc-final');
  assert.equal(await page.locator('.rc-go').count(), 0, 'günlük tekrar oynanamaz');
  assert.deepEqual(errors, []);
});

test('sınırsız Cuma kuralları: hareketli noktalar, duvarlı saha, sarımlı açı, ara vuruş, çizgi dışı kesir', async () => {
  const { page, errors, stimuli } = await phone('#/single/perceptle');
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-diff:has-text("Cuma")');
  await page.screenshot({ path: `${SHOTS}20-free-setup.png`, fullPage: true });
  await page.click('.rc-go:has-text("Başla")');
  await page.waitForSelector('.pc-intro');
  assert.match(await page.locator('.pc-friday').first().textContent(), /Cuma kuralları/);
  assert.match(await page.locator('.pc-intro').textContent(), /hareket/);

  // Say (noktalar kayıyor: iki kare farklı olmalı)
  await next(page);
  await page.waitForSelector('.pc-stage canvas');
  await page.waitForTimeout(200);
  const a = await page.locator('.pc-stage').screenshot();
  await page.waitForTimeout(250);
  const b = await page.locator('.pc-stage').screenshot();
  assert.ok(!a.equals(b), 'Cuma noktaları hareket etmeli');
  await page.screenshot({ path: `${SHOTS}21-friday-count.png`, fullPage: true });
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 4000 });
  await page.fill('.pc-num', String((await stimuli.at(0)).stimulus.dots.length));
  await page.press('.pc-num', 'Enter');
  await page.waitForSelector('.pc-big-score');
  assert.equal(await lastScore(page), 100);

  // Yörünge (duvardan seker)
  await next(page, 'Sonraki test');
  await next(page);
  assert.equal((await stimuli.at(1)).stimulus.walls, true);
  await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 5000 });
  const fb = await box(page, '.pc-field');
  const land = trackLanding((await stimuli.at(1)).stimulus);
  await page.touchscreen.tap(fb.x + (land / 1000) * fb.width, fb.y + fb.height / 2);
  await page.screenshot({ path: `${SHOTS}22-friday-track.png`, fullPage: true });
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.ok(await lastScore(page) >= 95);
  await page.screenshot({ path: `${SHOTS}23-friday-track-result.png`, fullPage: true });

  // Açı: fareyle iki tam tur sarım; bırakmak kilitlemez, Kilitle gerekir
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-dial');
  const db = await box(page, '.pc-dial');
  const cx = db.x + db.width / 2;
  const cy = db.y + db.height / 2;
  const R = db.width * 0.4;
  const at = (deg) => [cx + Math.cos((deg * Math.PI) / 180) * R, cy - Math.sin((deg * Math.PI) / 180) * R];
  await page.mouse.move(...at(90));
  await page.mouse.down();
  for (let d = 90; d <= 90 + 720 + 45; d += 15) await page.mouse.move(...at(d));
  await page.mouse.up();
  assert.equal(await page.locator('.pc-big-score').count(), 0, 'Cuma: bırakınca gönderilmemeli');
  await page.screenshot({ path: `${SHOTS}24-friday-angle.png`, fullPage: true });
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  const sen = Number((await page.locator('.pc-detail').textContent()).match(/Sen ([\d.]+)°/)[1].replace('.', ''));
  const wound = 90 + 720 + 45;
  assert.ok([0, 360].some((k) => Math.abs(sen - (wound + k)) <= 3), `sarım sayılmadı: ${sen}`);
  await page.screenshot({ path: `${SHOTS}25-friday-angle-result.png`, fullPage: true });

  // Ritim: vuruş aralarına
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-pad');
  const stim = (await stimuli.at(3)).stimulus;
  await tapTempo(page, stim, true);
  await page.waitForSelector('.pc-tempo-label.go', { timeout: 8000 });
  assert.match(await page.locator('.pc-tempo-label').textContent(), /ARASINA/);
  await page.waitForSelector('.pc-big-score', { timeout: 15000 });
  assert.ok(await lastScore(page) >= 80, `Cuma ritim puanı ${await lastScore(page)}`);

  // Böl: değer çizginin dışında; çizgi ortadaki %50
  await next(page, 'Sonraki test');
  await next(page);
  await page.waitForSelector('.pc-line');
  const v = splitValue((await stimuli.at(4)).stimulus);
  assert.ok(v < 0 || v > 1);
  const sb = await box(page, '.pc-line');
  await page.touchscreen.tap(sb.x + sb.width * (0.25 + 0.5 * v), sb.y + sb.height / 2);
  await page.screenshot({ path: `${SHOTS}27-friday-split.png`, fullPage: true });
  await page.click('.pc-lock');
  await page.waitForSelector('.pc-big-score');
  assert.ok(await lastScore(page) >= 90);
  await page.click('.rc-go:has-text("Sonucu gör")');
  await page.waitForSelector('.pc-final');
  assert.match(await page.locator('.pc-final').textContent(), /Cuma/);
  assert.equal(await page.locator('.rc-board').count(), 0, 'sınırsızda sıralama yok');
  await page.screenshot({ path: `${SHOTS}28-friday-final.png`, fullPage: true });
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(errors, []);
});
