// Tarayıcı testi: 🎲 Doğum Piyangosu — telefon görünümünde doğ, ad koy, bir seçim yap, 4× + ⏭ ile sona ilerle,
// Hayat Karnesi ve geçmiş kaydı. Ekran görüntüleri: test-results/lifesim/ (LIFESIM_SHOTS ile ek klasöre de kopyalanır).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/lifesim/', import.meta.url));
const EXTRA = process.env.LIFESIM_SHOTS; // isteğe bağlı ek kopya klasörü
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  if (EXTRA) mkdirSync(EXTRA, { recursive: true });
  srv = await startServer({ timeScale: 1 });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function shot(page, name) {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  if (EXTRA) copyFileSync(file, join(EXTRA, `${name}.png`));
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('telefon: doğ → ad → seçim → 4× ve ⏭ ile sona → Hayat Karnesi → geçmiş', { timeout: 180_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Sabit tohum: hep aynı hayat (Hindistan, seçimli, uzun ömürlü)
  await page.addInitScript(() => {
    try { localStorage.setItem('tss:lifesim-seed', JSON.stringify('e2e-2')); } catch { /* yok */ }
    Object.defineProperty(navigator, 'canShare', { value: undefined }); // paylaşım menüsü yerine indirme yolu
  });
  await page.goto(`${srv.url}/#/single/lifesim`);

  // Ana menüde kayıtlı
  assert.equal(await page.locator('.nav-item[data-route="single/lifesim"]').count(), 1);

  await page.waitForSelector('.ls-born:not([disabled])');
  await page.click('.ls-born');
  const card = page.locator('[data-testid="birth-card"]');
  await card.waitFor();
  assert.match(await card.innerText(), /doğdun!/);
  assert.match(await card.innerText(), /Beklenen ömür/);
  await page.click('.ls-birth-card .ls-stat > summary');
  assert.match(await page.locator('.ls-birth-card .ls-stat p').innerText(), /Dünya Bankası|UN WPP/);
  // Rastgele ad düğmesi adı değiştirir; sonra kendi adımızı yazarız
  const before = await page.inputValue('.ls-name-input');
  await page.click('button:has-text("🎲 Rastgele")');
  assert.ok((await page.inputValue('.ls-name-input')).length > 0 && before.length > 0);
  await shot(page, 'life-birth');
  await page.fill('.ls-name-input', 'Deneme');
  await page.click('.ls-start');

  await page.waitForSelector('.ls-head');
  assert.equal((await page.locator('.ls-pname').innerText()).trim(), 'Deneme');
  assert.equal(await page.locator('.ls-bar').count(), 4);
  assert.match(await page.locator('.ls-bar-w .ls-bar-val').innerText(), /🌍%/);
  assert.ok(await noHorizontalScroll(page), 'yatay kaydırma olmamalı');
  for (const sel of ['.ls-ctl']) {
    for (const b of await page.locator(sel).all()) {
      const box = await b.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${sel} dokunma hedefi ${box.width}×${box.height}`);
    }
  }
  // Saat kendiliğinden ilerliyor (1× = 2,5 sn/yıl)
  await page.waitForFunction(() => Number(document.querySelector('.ls-age')?.textContent) >= 1 || document.querySelector('[data-testid="choice"]'), null, { timeout: 8000 });
  await page.click('.ls-speed[data-speed="4"]');
  assert.equal(await page.getAttribute('.ls-speed[data-speed="4"]', 'aria-pressed'), 'true');

  let choices = 0;
  let shotChoice = false;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (await page.locator('[data-testid="report"]').count()) break;
    const choice = page.locator('[data-testid="choice"]');
    if (await choice.count()) {
      const age = Number(await page.locator('.ls-age').innerText());
      if (!shotChoice && age >= 14) { await shot(page, 'life-choice'); shotChoice = true; }
      const opts = choice.locator('.ls-option');
      const n = await opts.count();
      assert.ok(n >= 2, 'seçimde en az 2 seçenek');
      for (const b of await opts.all()) assert.ok((await b.boundingBox()).height >= 44);
      await opts.first().click();
      choices++;
      continue;
    }
    const skip = page.locator('.ls-skip');
    if (await skip.count()) await skip.click().catch(() => {});
    await page.waitForTimeout(60);
  }
  assert.ok(choices >= 1, `en az bir seçim yapılmalı (${choices})`);
  assert.ok(shotChoice, 'seçim ekran görüntüsü');

  // 📊 bir günlük satırında gerçek veriyi açar
  const report = page.locator('[data-testid="report"]');
  await report.waitFor({ timeout: 10_000 });
  const text = await report.innerText();
  assert.match(text, /Hayat Karnesi/);
  assert.match(text, /Deneme/);
  assert.match(text, /dünyanın en zengin %\d+/);
  assert.match(text, /Türkiye'de doğsaydın|Türkiye/);
  assert.ok(await page.locator('.ls-timeline li').count() >= 2, 'önemli anlar');
  assert.ok(await noHorizontalScroll(page));
  await shot(page, 'life-report');
  await page.screenshot({ path: join(SHOTS, 'life-report-full.png'), fullPage: true });

  // Paylaşım kartı PNG olarak iner
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.click('button:has-text("📤 Kartı paylaş")')]);
  assert.match(dl.suggestedFilename(), /^dogum-piyangosu-[a-z]{3}\.png$/);
  await dl.saveAs(join(SHOTS, 'life-share-card.png'));

  await page.click('button:has-text("📜 Geçmiş")');
  const hist = page.locator('[data-testid="history"]');
  await hist.waitFor();
  assert.match(await hist.innerText(), /Deneme/);
  assert.match(await hist.innerText(), /1\s*hayat/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('kaynaklar ekranı: lisanslar ve varsayımlar listeleniyor; oyun ekranında 📊 açılıyor', { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('tss:lifesim-seed', JSON.stringify('e2e-0')); } catch { /* yok */ } });
  await page.goto(`${srv.url}/#/single/lifesim`);
  await page.waitForSelector('.ls-born:not([disabled])');
  await page.click('button:has-text("📚 Kaynaklar")');
  const src = page.locator('[data-testid="sources"]');
  await src.waitFor();
  const t = await src.innerText();
  assert.match(t, /CC BY 4\.0/);
  assert.match(t, /UN DESA/);
  assert.match(t, /varsayım/);
  await page.click('button:has-text("← Geri")');
  await page.click('.ls-born');
  await page.click('.ls-start');
  await page.waitForSelector('.ls-entry');
  await page.click('.ls-entry .ls-stat > summary');
  assert.match(await page.locator('.ls-entry .ls-stat p').first().innerText(), /%/);
  await ctx.close();
});
