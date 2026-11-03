// Tarayıcı testi: 📸 Ne Zaman Nerede? — telefon (360×800, dokunmatik):
//  1) Günlük: 5 fotoğraf (dokun → iğne, yıl düğmeleri, Kilitle → açıklama haritası + künye), final + sıralama.
//  2) Serbest Eski İstanbul: sokak seviyesine yakınlaştır, iğneyi sürükle, kilitle.
//  3) Lobi: 3 telefon, 3 tur; başkası kilitleyince iğne korunur, açıklamada herkesin iğnesi, final kürsüsü.
// Harita karoları varsayılan olarak boş PNG'ye yönlendirilir (internetsiz); WW_REAL_TILES=1 → gerçek OSM karoları.
// Ekran görüntüleri: test-results/whenwhere/ (WW_SHOTS=klasör verilirse oraya da ww-*.png).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';

const DAY = '2026-10-30'; // gerçek bugünle çakışmasın
const SHOTS = fileURLToPath(new URL('../../test-results/whenwhere/', import.meta.url));
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJYwPDl5vJ1QAAAABJRU5ErkJggg==', 'base64');
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY } });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function shot(page, name) {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  if (process.env.WW_SHOTS) { mkdirSync(process.env.WW_SHOTS, { recursive: true }); copyFileSync(file, join(process.env.WW_SHOTS, `ww-${name}.png`)); }
}

async function phone(hash, name) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  if (process.env.WW_REAL_TILES !== '1') await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));
  const errors = [];
  const api = []; // /api/whenwhere yanıtları (sızıntı taraması)
  const views = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('response', async (res) => {
    if (res.url().includes('/api/whenwhere/') && res.ok()) api.push({ url: res.url(), json: await res.json().catch(() => null) });
  });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.t === 'view') views.push(m.view); if (m.t === 'room' && m.room) views.code = m.room.code; } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/${hash}`);
  if (name) await page.fill('input[placeholder="Takma adın"]', name);
  return { page, errors, api, views, name };
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Haritada orana göre dokun (0..1)
async function tapMap(page, fx, fy) {
  const map = page.locator('[data-testid=ww-guess-map]');
  await map.scrollIntoViewIfNeeded();
  const b = await map.boundingBox();
  await page.touchscreen.tap(b.x + b.width * fx, b.y + b.height * fy);
  await page.waitForSelector('[data-testid=ww-guess-map] .ww-pin-me');
}

test('Günlük: 5 fotoğraf, iğne + yıl, açıklama haritası ve künye, final + sıralama; cevap ağda kilitten önce yok', async () => {
  const p = await phone('#/single/whenwhere');
  await p.page.click('.rc-go:has-text("Başla")');
  const truths = (await secret(srv, { whenwhere: 1, gameId: DAY })).truths;
  for (let i = 0; i < 5; i++) {
    await p.page.waitForSelector('.ww-photo:not(.loading) .ww-img');
    await p.page.waitForSelector('[data-testid=ww-guess-map].leaflet-container .leaflet-control-zoom-in');
    assert.ok(await p.page.locator('.ww-lock').isDisabled(), 'iğnesiz kilit kapalı');
    // Sayfada ve ağda bu turun cevabı yok
    const text = await p.page.locator('#game-whenwhere').textContent();
    assert.ok(!text.includes(truths[i].title), 'başlık kilitten önce ekranda');
    const net = JSON.stringify(p.api.map((x) => x.json));
    for (const t of truths.slice(i)) for (const needle of [t.title, t.file, t.id, String(t.lat)]) assert.ok(!net.includes(needle), `ağda sızıntı: ${needle}`);
    const src = await p.page.locator('.ww-img').getAttribute('src');
    assert.match(src, /^blob:/, 'görsel blob: (adres opak)');
    await tapMap(p.page, 0.3 + i * 0.1, 0.45);
    await p.page.click('.ww-step[aria-label="+10 yıl"]');
    await p.page.click('.ww-step[aria-label="−1 yıl"]');
    assert.equal(await p.page.locator('.ww-year-out').textContent(), '1939');
    if (i === 0) {
      assert.ok(await noHorizontalScroll(p.page));
      await p.page.locator('.ww-photo').scrollIntoViewIfNeeded();
      await shot(p.page, 'guess');
    }
    await p.page.click('.ww-lock');
    await p.page.waitForSelector('.ww-big-score');
    await p.page.waitForSelector('[data-testid=ww-reveal-map] .ww-pin-truth');
    await p.page.waitForSelector('[data-testid=ww-reveal-map] .leaflet-overlay-pane path', { state: 'attached' }); // yatay çizginin yüksekliği 0 olabilir
    const credit = await p.page.locator('.ww-credit').textContent();
    assert.ok(credit.includes(truths[i].title) && credit.includes('Test Yazar') && credit.includes('CC BY-SA 4.0'));
    assert.match(await p.page.locator('.ww-miss').textContent(), /(km|m) \/ .*şaştın/);
    assert.ok((await p.page.locator('.leaflet-control-attribution').first().textContent()).includes('OpenStreetMap'));
    if (i === 0) { await p.page.locator('.ww-result').scrollIntoViewIfNeeded(); await shot(p.page, 'reveal'); }
    await p.page.click('.ww-next');
  }
  await p.page.waitForSelector('.ww-final');
  const total = Number((await p.page.locator('.ww-total').textContent()).match(/^\d+/)[0]);
  const sum = (await p.page.locator('.ww-row-score').allTextContents()).reduce((s, x) => s + Number(x), 0);
  assert.equal(total, sum);
  assert.ok((await p.page.locator('.ww-title').textContent()).length > 2);
  await p.page.waitForSelector('.ww-board li.me');
  await shot(p.page, 'end');
  // Yenileyince yine final (tek deneme)
  await p.page.reload();
  await p.page.waitForSelector('.ww-final');
  assert.deepEqual(p.errors, []);
});

test('Serbest Eski İstanbul: set seçimi, sokak seviyesi yakınlaştırma, iğne sürükleme, kilit', async () => {
  const p = await phone('#/single/whenwhere');
  await p.page.click('.tab:has-text("Serbest")');
  await p.page.click('.ww-set[data-set="istanbul"]');
  await p.page.click('.rc-go:has-text("Başla")');
  await p.page.waitForSelector('.ww-photo:not(.loading)');
  await p.page.waitForSelector('[data-testid=ww-guess-map].leaflet-container .leaflet-control-zoom-in');
  // Başlangıç İstanbul (zoom 11); + ile 16'ya kadar in
  for (let k = 0; k < 5; k++) { await p.page.click('[data-testid=ww-guess-map] .leaflet-control-zoom-in'); await p.page.waitForTimeout(280); }
  const zoomOk = await p.page.evaluate(() => document.querySelectorAll('[data-testid=ww-guess-map] img.leaflet-tile[src*="/16/"]').length > 0);
  assert.ok(zoomOk, 'sokak seviyesi (zoom 16) karoları istendi');
  await tapMap(p.page, 0.5, 0.5);
  // İğneyi sürükle (dokunmatik sürükleme yerine fare: Leaflet sürükleme olayları)
  const pin = await p.page.locator('[data-testid=ww-guess-map] .ww-pin-me .ww-pin-dot').boundingBox();
  await p.page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await p.page.mouse.down();
  await p.page.mouse.move(pin.x + 60, pin.y + 30, { steps: 6 });
  await p.page.mouse.up();
  await p.page.click('.ww-lock');
  await p.page.waitForSelector('.ww-big-score');
  const t = (await secret(srv, { whenwhere: 1, gameId: p.api.find((x) => x.json?.mode === 'free')?.json.gameId })).truths[0];
  assert.ok(t.lat > 40.8 && t.lat < 41.4, 'İstanbul fotoğrafı');
  assert.deepEqual(p.errors, []);
});

test('Lobi: 3 telefon, 3 tur; iğne başkası kilitleyince korunur; açıklamada herkesin iğnesi; final kürsüsü', async () => {
  const ali = await phone('#/multi/whenwhere', 'Ali');
  const ayse = await phone('#/multi/whenwhere', 'Ayşe');
  const mert = await phone('#/multi/whenwhere', 'Mert');
  const phones = [ali, ayse, mert];
  await ali.page.click('text=Yeni oda kur');
  const code = (await ali.page.locator('.lobby-code').textContent()).trim();
  for (const p of [ayse, mert]) {
    await p.page.fill('.code-input', code);
    await p.page.click('button:has-text("Katıl")');
  }
  await ali.page.waitForFunction(() => document.querySelectorAll('#game-whenwhere .player-list li').length === 3);
  await ali.page.click('.pl-test[data-opt="rounds-3"]');
  await ali.page.click('.pl-test[data-opt="time-90"]');
  await ayse.page.waitForSelector('.pl-test.active[data-opt="rounds-3"]');
  assert.ok(await ayse.page.locator('.ww-set[data-set="turkiye"]').isDisabled(), 'ayarları sadece host değiştirir');
  await ali.page.click('#game-whenwhere button:has-text("Oyunu başlat")');
  for (let i = 0; i < 3; i++) {
    await Promise.all(phones.map((p) => p.page.waitForSelector('.ww-photo:not(.loading)')));
    await Promise.all(phones.map((p) => p.page.waitForSelector('[data-testid=ww-guess-map].leaflet-container .leaflet-control-zoom-in')));
    await ali.page.waitForTimeout(1600); // SYNC (tur başlangıcı)
    // Mert iğnesini koyar (kilitlemez); Ali ve Ayşe kilitler → Mert'in iğnesi ve yılı yerinde kalmalı
    await tapMap(mert.page, 0.6, 0.4);
    await mert.page.click('.ww-step[aria-label="+10 yıl"]');
    await tapMap(ali.page, 0.4, 0.5);
    await ali.page.click('.ww-lock');
    await ali.page.waitForSelector('text=Kilitlendi');
    await tapMap(ayse.page, 0.5, 0.6);
    await ayse.page.click('.ww-lock');
    await mert.page.waitForFunction(() => [...document.querySelectorAll('.rc-check')].filter((x) => x.textContent.includes('kilitledi')).length >= 2);
    assert.equal(await mert.page.locator('[data-testid=ww-guess-map] .ww-pin-me').count(), 1, 'iğne korunur');
    assert.equal(await mert.page.locator('.ww-year-out').textContent(), '1940', 'yıl korunur');
    const roomTruth = (await secret(srv, { room: code })).targets[i];
    for (const p of phones) {
      const seen = JSON.stringify(p.views.filter((v) => v.phase === 'play' && v.index === i));
      assert.ok(!seen.includes(`"lat":${roomTruth.lat}`), 'tur kapanmadan gerçek yer görünümde yok');
    }
    if (i === 0) { await mert.page.locator('.ww-photo').scrollIntoViewIfNeeded(); await shot(mert.page, 'lobby-guess'); }
    await mert.page.click('.ww-lock');
    await Promise.all(phones.map((p) => p.page.waitForSelector('.ww-rank li')));
    await Promise.all(phones.map((p) => p.page.waitForSelector('[data-testid=ww-reveal-map] .ww-pin-truth')));
    assert.equal(await ayse.page.locator('[data-testid=ww-reveal-map] .ww-pin-label').count(), 4, '3 iğne + gerçek yer');
    assert.equal(await ayse.page.locator('.ww-rank li').count(), 3);
    if (i === 0) {
      await ayse.page.waitForTimeout(400);
      await ayse.page.locator('.ww-result').scrollIntoViewIfNeeded();
      await shot(ayse.page, 'lobby-reveal');
    }
    assert.equal(await ayse.page.locator('.ww-next').count(), 0, 'sadece host geçirir');
    await ali.page.click('.ww-next');
  }
  await Promise.all(phones.map((p) => p.page.waitForSelector('.ww-podium')));
  assert.equal(await ali.page.locator('.ww-final-rank li').count(), 3);
  assert.equal(await ali.page.locator('.ww-table tbody tr').count(), 3);
  await shot(ali.page, 'lobby-end');
  for (const p of phones) assert.ok(await noHorizontalScroll(p.page));
  for (const p of phones) assert.deepEqual(p.errors, [], p.name);
});
