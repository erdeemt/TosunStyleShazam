// Tarayıcı testi: 🔗 Bağlantı Avı — telefon (360×800, dokunmatik):
//  1) Günlük: Başla → bağlantısız kişi ("Bağlantı yok" + sallanma, yanlış deneme) → ipucu → en kısa yolu Türkçe karaktersiz
//     arayarak kur (fotoğraf + neden etiketi) → bitiş: puan dökümü, senin zincirin, en kısa yol, sıralama. Ağda bitmeden
//     en kısa yolun ara kişileri yok.
//  2) Lobi: 3 telefon, 1 tur: biri en kısa yolla bitirir, diğeri 1 adımdayken "yarış" listesinde sadece sayı görür, sonra bitirir,
//     üçüncüsü pes eder → açıklamada herkesin zinciri yan yana + en kısa yol → final.
// Ekran görüntüleri: test-results/baglanti/ (BG_SHOTS=klasör verilirse oraya da bg-*.png). BG_DATA=real → gerçek veri + gerçek
// Wikimedia fotoğrafları (sadece ekran görüntüsü için; ağ gerekir).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';
import { fold } from '../../public/baglanti-math.js';

const DAY = '2026-11-10'; // gerçek bugünle çakışmasın
const SHOTS = fileURLToPath(new URL('../../test-results/baglanti/', import.meta.url));
const REAL = process.env.BG_DATA === 'real';
let srv;
let browser;
let index = []; // kişi dizini satırları

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY, ...(REAL ? { BG_DATA: 'real' } : {}) } });
  browser = await chromium.launch({ channel: 'chrome' });
  index = (await (await fetch(`${srv.url}/api/baglanti/people`)).json()).people;
});
after(async () => { await browser?.close(); await srv?.stop(); });

const nameOf = (q) => index.find((r) => r[0] === q)?.[1] ?? q;

async function shot(page, name, { full = false } = {}) {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  if (process.env.BG_SHOTS) { mkdirSync(process.env.BG_SHOTS, { recursive: true }); copyFileSync(file, join(process.env.BG_SHOTS, `bg-${name}.png`)); }
}

async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  const api = []; // /api/baglanti yanıtları (sızıntı taraması)
  const views = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  page.on('response', async (res) => {
    if (/\/api\/baglanti\/(start|begin|add|remove|hint|giveup)/.test(res.url()) && res.ok()) api.push(await res.json().catch(() => null));
  });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.t === 'view') views.push(m.view); } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/${hash}`);
  return { page, errors, api, views };
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Arama sayfasını aç, adı Türkçe karaktersiz yaz, sonucu seç. Dönen: 'ok' | 'bad'
async function pick(page, q, { typed } = {}) {
  if (!(await page.locator('[data-testid=bg-sheet]').count())) await page.click('[data-testid=bg-add]');
  const input = page.locator('[data-testid=bg-search]');
  await input.fill('');
  await input.type(typed ?? fold(nameOf(q)), { delay: 5 });
  await page.click(`.bg-res[data-q="${q}"]`);
  const res = await Promise.race([
    page.waitForSelector('[data-testid=bg-sheet]', { state: 'detached' }).then(() => 'ok'),
    page.waitForSelector('.bg-sheet-msg.bad', { state: 'visible' }).then(() => 'bad'),
  ]);
  return res;
}

test('Günlük: yanlış deneme + sallanma, ipucu, Türkçe karaktersiz arama, fotoğraflı zincir, bitiş + en kısa yol + sıralama', async () => {
  const p = await phone('#/single/baglanti');
  await p.page.click('[data-testid=bg-start]');
  await p.page.waitForSelector('.bg-person.bg-start');
  const { path } = await secret(srv, { baglanti: 1, gameId: DAY });
  assert.equal(await p.page.locator('.bg-person.bg-start').getAttribute('data-q'), path[0]);
  assert.equal(await p.page.locator('.bg-person.bg-target').getAttribute('data-q'), path.at(-1));
  // Bağlantısız biri: yolda olmayan (gerçek veride bağlı çıkarsa ✕ ile silinir)
  const wrongs = index.map((r) => r[0]).filter((q) => !path.includes(q)).reverse();
  let invalidShot = false;
  for (const q of wrongs.slice(0, 6)) {
    const r = await pick(p.page, q);
    if (r === 'bad') {
      const msg = await p.page.textContent('.bg-sheet-msg.bad');
      assert.match(msg, /Bağlantı yok/);
      assert.match(msg, /yanlış deneme: 1/);
      assert.ok(await p.page.locator('.bg-sheet.bg-shake').count(), 'sallanma');
      await shot(p.page, 'invalid');
      invalidShot = true;
      break;
    }
    await p.page.click('.bg-person[data-q] .bg-x');
  }
  assert.ok(invalidShot, 'bağlantısız kişi bulunamadı');
  await p.page.click('.bg-sheet-head button');
  // İpucu: baş harf
  await p.page.click('[data-testid=bg-hint-letter]');
  await p.page.waitForSelector('.bg-hint-list li.now');
  assert.match(await p.page.textContent('.bg-hint-list li.now'), /ile başlıyor/);
  // En kısa yol: büyük harfle / Türkçe karaktersiz yazarak
  for (const [i, q] of path.slice(1, -2).entries()) {
    const typed = i === 0 ? fold(nameOf(q)).toUpperCase() : fold(nameOf(q));
    assert.equal(await pick(p.page, q, { typed }), 'ok');
    await p.page.waitForSelector(`.bg-chain .bg-person[data-q="${q}"]`);
  }
  assert.equal(await p.page.locator('.bg-chain .bg-person.bg-step').count(), path.length - 3);
  const chips = await p.page.locator('.bg-link-ok .bg-link-chip').allTextContents();
  assert.equal(chips.length, path.length - 3);
  for (const c of chips) assert.ok(c.trim().length > 3, `etiket: ${c}`);
  assert.ok(await noHorizontalScroll(p.page), 'yatay kaydırma yok (oyun)');
  await p.page.waitForTimeout(REAL ? 2500 : 300); // fotoğraflar yüklensin
  await p.page.evaluate(() => window.scrollTo(0, 120));
  await shot(p.page, 'chain');
  // Bitmeden önceki hiçbir yanıtta en kısa yolun eklenmemiş ara kişileri ve "optimal" yok
  for (const [k, j] of p.api.entries()) {
    const s = JSON.stringify(j);
    assert.ok(!/"optimal":\[/.test(s), `yanıt ${k}: en kısa yol`);
    assert.ok(!s.includes(`"${path.at(-2)}"`), `yanıt ${k}: son ara kişi sızdı`);
  }
  // Son adım → bitiş
  assert.equal(await pick(p.page, path.at(-2)), 'ok');
  await p.page.waitForSelector('.bg-result');
  await p.page.waitForSelector('.bg-optimal .bg-chain');
  const total = Number(await p.page.textContent('.bg-total').then((t) => t.match(/\d+/)[0]));
  assert.ok(total >= 800 && total <= 1000 - 25 - 100, `puan ${total}`);
  assert.equal(await p.page.locator('.bg-optimal .bg-person').count(), path.length);
  assert.equal(await p.page.locator('.bg-break li').count() >= 3, true, 'döküm: zincir + yanlış + ipucu');
  await p.page.waitForSelector('.bg-lb li.me');
  assert.ok(await noHorizontalScroll(p.page), 'yatay kaydırma yok (bitiş)');
  await p.page.waitForTimeout(REAL ? 2500 : 200);
  await shot(p.page, 'final');
  await p.page.locator('.bg-optimal').scrollIntoViewIfNeeded();
  await shot(p.page, 'final-optimal');
  // Yenileyince yine bitiş ekranı (tek deneme)
  await p.page.reload();
  await p.page.waitForSelector('.bg-result');
  assert.deepEqual(p.errors, []);
  await p.page.context().close();
});

test('Lobi: 3 telefon yarış — canlı ilerleme sadece sayı, açıklamada herkesin zinciri yan yana + en kısa yol, final', async () => {
  const host = await phone('#/multi/baglanti');
  await host.page.fill('#game-baglanti input[placeholder="Takma adın"]', 'Ayşe');
  await host.page.click('#game-baglanti button:has-text("Yeni oda kur")');
  await host.page.waitForSelector('.lobby-code');
  const code = (await host.page.textContent('.lobby-code')).trim();
  const others = [];
  for (const name of ['Burak', 'Cem']) {
    const o = await phone('#/multi/baglanti');
    await o.page.fill('#game-baglanti input[placeholder="Takma adın"]', name);
    await o.page.fill('#game-baglanti .code-input', code);
    await o.page.click('#game-baglanti button:has-text("Katıl")');
    await o.page.waitForSelector('.lobby-code');
    others.push(o);
  }
  await host.page.click('[data-diff=kolay]');
  await host.page.click('[data-opt=rounds-1]');
  await host.page.click('[data-opt=minutes-3]');
  await others[0].page.waitForSelector('[data-opt=rounds-1].active');
  await host.page.click('#game-baglanti button:has-text("Oyunu başlat")');
  const phones = [host, ...others];
  for (const ph of phones) await ph.page.waitForSelector('.bg-person.bg-start');
  const code2 = code;
  const [path] = (await secret(srv, { room: code2 })).targets;
  await host.page.waitForSelector('[data-testid=bg-add]:not([disabled])');
  // Burak 1 adım
  await others[0].page.waitForSelector('[data-testid=bg-add]:not([disabled])');
  assert.equal(await pick(others[0].page, path[1]), 'ok');
  // Ayşe bitirir
  for (const q of path.slice(1, -1)) assert.equal(await pick(host.page, q), 'ok');
  await host.page.waitForSelector('.bg-done');
  // Burak'ın yarış listesinde Ayşe "✅ 1." ve kendisi "1 adım"; Ayşe'nin seçtikleri görünmez
  await others[0].page.waitForSelector('.bg-race li:has-text("Ayşe") .rc-check:has-text("bitirdi")');
  await others[2 - 1].page.evaluate(() => window.scrollTo(0, 0));
  assert.match(await others[1].page.textContent('.bg-race'), /Burak\s*1 adım/);
  await others[1].page.locator('.bg-race').scrollIntoViewIfNeeded();
  await shot(others[1].page, 'lobby-race');
  const viewsBeforeReveal = others[1].views.filter((v) => v.phase === 'play');
  for (const v of viewsBeforeReveal) {
    const s = JSON.stringify(v);
    for (const q of path.slice(1, -1)) assert.ok(!s.includes(`"${q}"`), `Cem'e ara kişi sızdı: ${q}`);
    assert.ok(!/"optimal":\[/.test(s));
  }
  // Burak bitirir, Cem pes eder
  for (const q of path.slice(2, -1)) assert.equal(await pick(others[0].page, q), 'ok');
  await others[1].page.click('#game-baglanti button:has-text("Pes et")');
  for (const ph of phones) await ph.page.waitForSelector('[data-testid=bg-reveal]');
  const cols = host.page.locator('.bg-col');
  assert.equal(await cols.count(), 4, 'en kısa yol + 3 oyuncu');
  assert.match(await host.page.textContent('.bg-col-opt'), /En kısa yol/);
  assert.match(await host.page.textContent('.bg-cols'), /🥇/);
  assert.ok(await noHorizontalScroll(host.page), 'sayfa yatay kaymaz (sütunlar kendi içinde kayar)');
  await host.page.waitForTimeout(REAL ? 2500 : 200);
  await host.page.locator('.bg-cols').scrollIntoViewIfNeeded();
  await shot(host.page, 'lobby-reveal');
  await host.page.click('.bg-next');
  for (const ph of phones) await ph.page.waitForSelector('.bg-final-rank');
  assert.match(await host.page.textContent('.bg-final-rank li:first-child'), /Ayşe/);
  await shot(host.page, 'lobby-final');
  for (const ph of phones) assert.deepEqual(ph.errors, []);
  for (const ph of phones) await ph.page.context().close();
});
