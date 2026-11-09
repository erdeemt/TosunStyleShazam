// Tarayıcı testi: 🔤 Harf Çarkı — telefon (360×800, dokunmatik):
//  1) Günlük: Başla → çark + ipucu; doğru (yeşil), yanlış (kırmızı), pas (sarı, sonra geri gelir); ağda cevap yok;
//     bitir → sonuç, emoji ızgarası, harf harf döküm, sıralama.
//  2) Lobi: 3 telefon, aynı çark; canlı mini çarklar; herkes bitirince sıralama + döküm.
// Ekran görüntüleri: test-results/harfcarki/ (HC_SHOTS=klasör verilirse oraya da hc-*.png).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';
import { fold } from '../../server/harfcarki-text.js';

const DAY = '2026-11-09'; // çıkış günü = #1
const SHOTS = fileURLToPath(new URL('../../test-results/harfcarki/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY, HARFCARKI_SALT: 'e2e' } });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function shot(page, name, fullPage = false) {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  if (process.env.HC_SHOTS) { mkdirSync(process.env.HC_SHOTS, { recursive: true }); copyFileSync(file, join(process.env.HC_SHOTS, `hc-${name}.png`)); }
}

async function phone(hash, name) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  const api = [];
  const views = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  page.on('response', async (res) => {
    if (res.url().includes('/api/harfcarki/')) api.push(await res.json().catch(() => null));
  });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(payload); if (m.t === 'view') views.push(m.view); } catch { /* yok say */ }
  }));
  await page.goto(`${srv.url}/${hash}`);
  if (name) await page.fill('input[placeholder="Takma adın"]', name);
  return { page, errors, api, views };
}

const leaks = (obj, answers) => {
  const text = ` ${fold(JSON.stringify(obj))} `;
  return answers.filter((a) => fold(a).replace(/ /g, '').length >= 4 && text.includes(` ${fold(a)} `));
};
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const curPos = (page) => page.locator('.hc-dot.hc-cur').getAttribute('data-i').then(Number);

async function answer(page, text) {
  const before = await curPos(page);
  await page.fill('.hc-input', text);
  await page.locator('.hc-send').tap();
  await page.waitForFunction((b) => {
    const c = document.querySelector('.hc-dot.hc-cur');
    return !c || Number(c.getAttribute('data-i')) !== b || document.querySelector('.hc-result, .hc-final');
  }, before);
}
async function pass(page) {
  const before = await curPos(page);
  await page.locator('.hc-pass-btn').tap();
  await page.waitForFunction((b) => {
    const c = document.querySelector('.hc-dot.hc-cur');
    return !c || Number(c.getAttribute('data-i')) !== b;
  }, before);
}

test('Günlük: doğru / yanlış / pas, çark renkleri, ağda cevap yok, sonuç + döküm + sıralama', async () => {
  const p = await phone('#/single/harfcarki');
  await p.page.waitForSelector('.hc-ready');
  assert.ok(await noHorizontalScroll(p.page));
  await p.page.locator('.rc-go').tap();
  await p.page.waitForSelector('.hc-wheel .hc-dot.hc-cur');
  const answers = (await secret(srv, { harfcarki: 1, gameId: DAY })).answers;
  assert.equal(await p.page.locator('.hc-dot').count(), 28);
  assert.deepEqual(await p.page.locator('.hc-dot text').allTextContents(), ['A','B','C','Ç','D','E','F','G','H','I','İ','J','K','L','M','N','O','Ö','P','R','S','Ş','T','U','Ü','V','Y','Z'], 'her dairede harfi');
  assert.match(await p.page.locator('.tab.active').textContent(), /Günlük #1$/);
  assert.match(await p.page.locator('.hc-rule').textContent(), /^A (ile başlar|harfini içerir)$/);
  // Doğru
  await answer(p.page, answers[0].toLocaleUpperCase('tr'));
  assert.match(await p.page.locator('.hc-dot[data-i="0"]').getAttribute('class'), /hc-ok/);
  // Yanlış
  await answer(p.page, 'kesinlikleyanlis');
  assert.match(await p.page.locator('.hc-dot[data-i="1"]').getAttribute('class'), /hc-bad/);
  assert.match(await p.page.locator('.hc-clue-card').getAttribute('class'), /hc-bad-flash/);
  // Pas
  await pass(p.page);
  assert.match(await p.page.locator('.hc-dot[data-i="2"]').getAttribute('class'), /hc-pass/);
  for (let i = 3; i < 9; i++) await answer(p.page, answers[i]);
  assert.match(await p.page.locator('.hc-stats').textContent(), /7 doğru · 1 yanlış · 20 pas/);
  // Girdi ekranda görünür, yatay kaydırma yok
  const box = await p.page.locator('.hc-input').boundingBox();
  assert.ok(box && box.y + box.height <= 800, `girdi görünür değil: ${JSON.stringify(box)}`);
  assert.ok(await noHorizontalScroll(p.page));
  await shot(p.page, 'wheel');
  // Bitmeden ağda cevap yok
  assert.deepEqual(leaks(p.api, answers), []);
  assert.ok(!JSON.stringify(p.api).includes('"answer"'));
  // Kalanları doğru bitir; pas (C) ilk turdan sonra geri gelir
  for (let i = 9; i < 28; i++) await answer(p.page, answers[i]);
  assert.equal(await curPos(p.page), 2, 'paslanan harf geri geldi');
  assert.match(await p.page.locator('.hc-cat').textContent(), /pas/);
  await answer(p.page, answers[2]);
  await p.page.waitForSelector('.hc-result');
  assert.match(await p.page.locator('.hc-summary').textContent(), /27 doğru · 1 yanlış · 0 pas/);
  assert.equal(await p.page.locator('.hc-recap li').count(), 28);
  assert.match(await p.page.locator('.hc-recap li').nth(1).textContent(), /sen: kesinlikleyanlis/);
  assert.match(await p.page.locator('.hc-grid').first().textContent(), /🟩🟥🟩/);
  await p.page.waitForSelector('.hc-board li.me');
  assert.ok(await noHorizontalScroll(p.page));
  await p.page.locator('.hc-recap').scrollIntoViewIfNeeded();
  await p.page.evaluate(() => window.scrollTo(0, 0));
  await shot(p.page, 'recap', true);
  // Yenileyince bitmiş sonuç döner (tek deneme)
  await p.page.reload();
  await p.page.waitForSelector('.hc-result');
  assert.deepEqual(p.errors, []);
  await p.page.context().close();
});

test('Lobi: 3 telefon aynı çark, canlı mini çarklar, herkes bitirince sıralama + döküm', async () => {
  const host = await phone('#/multi/harfcarki', 'Ayşe');
  await host.page.click('text=Yeni oda kur');
  const code = (await host.page.locator('.lobby-code').textContent()).trim();
  const guests = [];
  for (const name of ['Bora', 'Cem']) {
    const g = await phone('#/multi/harfcarki', name);
    await g.page.fill('input[placeholder="KOD"]', code);
    await g.page.click('button:has-text("Katıl")');
    guests.push(g);
  }
  await host.page.waitForFunction(() => document.querySelectorAll('.player-list li').length === 3);
  await host.page.click('[data-opt="difficulty-easy"]');
  await host.page.waitForSelector('[data-opt="difficulty-easy"].active');
  await host.page.click('#game-harfcarki button:has-text("Oyunu başlat")');
  const phones = [host, ...guests];
  await Promise.all(phones.map((x) => x.page.waitForSelector('.hc-dot.hc-cur', { timeout: 10_000 })));
  const answers = (await secret(srv, { room: code })).targets;
  const clues = await Promise.all(phones.map((x) => x.page.locator('.hc-clue').textContent()));
  assert.equal(new Set(clues).size, 1, 'herkese aynı ilk ipucu');
  // Ayşe 4 doğru, Bora 2 doğru 1 yanlış, Cem 2 pas
  for (let i = 0; i < 4; i++) await answer(host.page, answers[i]);
  await answer(guests[0].page, answers[0]);
  await answer(guests[0].page, answers[1]);
  await answer(guests[0].page, 'yanlisss');
  await pass(guests[1].page);
  await pass(guests[1].page);
  // Canlı: host'un ekranında 3 mini çark, Bora'nınkinde 1 kırmızı
  await host.page.waitForFunction(() => document.querySelectorAll('.hc-minis li').length === 3
    && document.querySelectorAll('.hc-minis .hc-m-bad').length === 1
    && document.querySelectorAll('.hc-minis .hc-m-pass').length === 2);
  assert.match(await host.page.locator('.hc-minis').textContent(), /Bora.*2✓ 1✗/s);
  await host.page.locator('.hc-minis').scrollIntoViewIfNeeded();
  await shot(host.page, 'lobby-live', true);
  // Oyun bitmeden ağda (WS) cevap yok
  for (const x of phones) assert.deepEqual(leaks(x.views, answers), []);
  // Hepsi bitirir (Bitir → onay)
  for (const x of phones) await x.page.locator('.hc-quit').tap();
  await Promise.all(phones.map((x) => x.page.waitForSelector('.hc-final', { timeout: 10_000 })));
  const names = await host.page.locator('.hc-rank .player-name').allTextContents();
  assert.deepEqual(names, ['Ayşe', 'Bora', 'Cem']);
  assert.equal(await host.page.locator('.hc-recap li').count(), 28);
  assert.match(await host.page.locator('.hc-recap li').first().textContent(), new RegExp(answers[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await guests[0].page.click('.hc-who button:has-text("Bora")');
  assert.match(await guests[0].page.locator('.hc-recap li').nth(2).textContent(), /sen: yanlisss/);
  assert.ok(await noHorizontalScroll(host.page));
  await host.page.evaluate(() => window.scrollTo(0, 0));
  await shot(host.page, 'lobby-result', true);
  for (const x of phones) assert.deepEqual(x.errors, []);
  for (const x of phones) await x.page.context().close();
});
