// Tarayıcı testi: 3 ayrı "telefon" (Chrome bağlamı) Casus Kim? odası kurar, katılır, oyunu başlatır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1 });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${srv.url}/#/multi/spyfall`);
  await page.fill('input[placeholder="Takma adın"]', name);
  return { page, errors, name };
}

test('3 telefon: oda kur, kodla katıl, başlat, rol kartı', async () => {
  const [ali, ayse, mert] = await Promise.all([phone('Ali'), phone('Ayşe'), phone('Mert')]);
  await ali.page.click('text=Yeni oda kur');
  const code = (await ali.page.locator('.lobby-code').textContent()).trim();
  assert.match(code, /^[A-Z]{4}$/);

  for (const p of [ayse, mert]) {
    await p.page.fill('.code-input', code.toLowerCase());
    await p.page.click('button:has-text("Katıl")');
  }
  await ali.page.waitForFunction(() => document.querySelectorAll('#game-spyfall .player-list li').length === 3);
  await ali.page.screenshot({ path: SHOTS + 'spyfall-lobby.png' });

  // Sadece host başlatabilir
  assert.equal(await ayse.page.locator('#game-spyfall button:has-text("Oyunu başlat")').count(), 0);
  await ali.page.click('#game-spyfall button:has-text("Oyunu başlat")');

  let spyCount = 0;
  for (const p of [ali, ayse, mert]) {
    await p.page.waitForSelector('.role-card.hidden-card');
    await p.page.click('.role-card');
    const text = await p.page.locator('.role-card').textContent();
    if (text.includes('CASUSSUN')) spyCount++;
    else assert.match(text, /Rolün:/);
    await p.page.screenshot({ path: `${SHOTS}spyfall-${p.name}.png` });
  }
  assert.equal(spyCount, 1);

  // Sayfa yenilenince aynı odaya ve role dönülür
  await mert.page.reload();
  await mert.page.waitForSelector('.role-card');
  assert.ok(await mert.page.locator('text=Oda ' + code).count());

  for (const p of [ali, ayse, mert]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});
