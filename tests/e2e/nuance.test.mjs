// Tarayıcı testi: 🎨 Nüans — tek oyunculu günlük oyun (hex + kaydırıcı + süre dolunca otomatik gönderim, sıralama)
// ve 3 telefonla lobi oyunu (360×800). Ekran görüntüleri: test-results/nuance/.
import { secret } from '../lib/media.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { hsbToRgb, rgbToHex as rgbHex } from '../../public/recall-math.js';

const DAY = '2026-11-08';
const SHOTS = fileURLToPath(new URL('../../test-results/nuance/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.4, env: { FAKE_TODAY: DAY } }); // ezber 2 sn, hatırlama 12 sn
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${srv.url}/${hash}`);
  return { page, errors };
}

const rgbToHex = (css) => `#${css.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
// Hedef hex artık JSON'da/DOM'da yok: ezber diskindeki sunucu PNG'si (blob:). Görselin ortalama rengi (göz damlası değil,
// tüm piksellerin ortalaması) ve kesin hedef (testlere özel uç) ayrı ayrı alınır.
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
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('tek oyunculu günlük: 5 tur, hex ve kaydırıcı, otomatik gönderim, sıralama', async () => {
  const { page, errors } = await phone('#/single/nuance');
  await page.fill('input[placeholder="Takma adın"]', 'Renkçi');
  await page.click('button:has-text("Kaydet")');
  await page.waitForSelector('.rc-go');
  await page.screenshot({ path: `${SHOTS}single-ready.png`, fullPage: true });
  await page.click('.rc-go');

  for (let round = 0; round < 5; round++) {
    if (round > 0) await page.click('.rc-go');
    await page.waitForSelector('.nu-target');
    const target = (await secret(srv, { recall: 'nuance', gameId: DAY })).targets[round];
    if (round === 0) assert.ok(near(await shownHex(page), target), 'gösterilen görsel hedef renkte olmalı');
    if (round === 0) await page.screenshot({ path: `${SHOTS}single-memorize.png` });
    await page.waitForSelector('.nu-input', { timeout: 6000 });
    assert.equal(await page.locator('.nu-target').count(), 0, 'hatırlama ekranında hedef görünmemeli');
    if (round === 0) {
      // hex kutusu kaydırıcıları günceller (iki yönlü)
      await page.fill('.nu-hex', target.toUpperCase());
      const preview = rgbToHex(await page.$eval('.nu-preview', (n) => getComputedStyle(n).backgroundColor));
      assert.equal(preview, target);
      const h = Number(await page.$eval('.nu-h', (n) => n.value));
      assert.ok(h >= 0 && h <= 360);
      await page.screenshot({ path: `${SHOTS}single-recall.png`, fullPage: true });
      assert.ok(await noHorizontalScroll(page), 'yatay kaydırma olmamalı');
      await page.click('.rc-submit');
      await page.waitForSelector('.nu-round.big');
      assert.match(await page.locator('.nu-round.big .nu-score').textContent(), /^1000/);
      await page.screenshot({ path: `${SHOTS}single-result.png`, fullPage: true });
    } else if (round === 1) {
      // kaydırıcılar: değer değişince hex kutusu ve önizleme güncellenir
      const before = await page.inputValue('.nu-hex');
      await page.locator('.nu-h').fill('200');
      await page.locator('.nu-s').fill('80');
      await page.locator('.nu-b').fill('70');
      const after = await page.inputValue('.nu-hex');
      assert.notEqual(after, before);
      assert.equal(after, rgbHex(hsbToRgb(200, 80, 70)).toUpperCase());
      await page.click('.rc-submit');
      await page.waitForSelector('.nu-round.big');
    } else if (round === 2) {
      // hiçbir şeye dokunmadan bekle: süre dolunca rastgele başlangıç rengi gönderilir
      await page.waitForSelector('.nu-round.big', { timeout: 20000 });
      assert.match(await page.locator('#toast').textContent(), /Süre doldu/);
    } else {
      await page.fill('.nu-hex', '#808080');
      await page.click('.rc-submit');
      await page.waitForSelector(round === 4 ? '.rc-final' : '.nu-round.big');
    }
  }
  await page.waitForSelector('.rc-board li');
  assert.match(await page.locator('.rc-board').textContent(), /Renkçi/);
  assert.match(await page.locator('.rc-total').textContent(), /\/1000 · (Acemi|Orta|İyi|Uzman|Elit)/);
  assert.equal(await page.locator('.rc-final .nu-round').count(), 5);
  await page.screenshot({ path: `${SHOTS}single-final.png`, fullPage: true });

  // yenileyince bitmiş oyun geri gelir, tekrar oynanamaz
  await page.reload();
  await page.waitForSelector('.rc-final');
  assert.equal(await page.locator('.rc-go').count(), 0);

  // Sınırsız: Uzman seçilir, ezber 2 sn yerine 0.8 sn
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-diff:has-text("Uzman")');
  await page.screenshot({ path: `${SHOTS}free-setup.png`, fullPage: true });
  await page.click('.rc-go');
  await page.waitForSelector('.nu-target');
  await page.waitForSelector('.nu-input', { timeout: 3000 });
  assert.deepEqual(errors, []);
});

test('3 telefon lobi: aynı hedef, gizli cevaplar, açıklama yan yana, final sıralaması', async () => {
  const phones = await Promise.all(['Ali', 'Ayşe', 'Mert'].map(async (name) => {
    const p = await phone('#/multi/nuance');
    await p.page.fill('input[placeholder="Takma adın"]', name);
    return { ...p, name };
  }));
  const [ali, ayse, mert] = phones;
  await ali.page.click('text=Yeni oda kur');
  const code = (await ali.page.locator('.lobby-code').textContent()).trim();
  for (const p of [ayse, mert]) {
    await p.page.fill('.code-input', code);
    await p.page.click('button:has-text("Katıl")');
  }
  await ali.page.waitForFunction(() => document.querySelectorAll('#game-nuance .player-list li').length === 3);
  await ali.page.selectOption('#game-nuance select >> nth=0', '3');
  await ali.page.selectOption('#game-nuance select >> nth=2', '15');
  await ali.page.waitForTimeout(300);
  await ali.page.screenshot({ path: `${SHOTS}lobby-waiting.png`, fullPage: true });
  await ali.page.click('#game-nuance button:has-text("Oyunu başlat")');

  for (let round = 1; round <= 3; round++) {
    const shown = await Promise.all(phones.map(async (p) => {
      await p.page.waitForSelector('.nu-target');
      return shownHex(p.page);
    }));
    const real = (await secret(srv, { room: code })).targets[round - 1];
    assert.ok(shown.every((h) => near(h, real)), `herkes aynı hedefi görmeli ${shown} ~ ${real}`);
    const targets = [real];
    if (round === 1) await ayse.page.screenshot({ path: `${SHOTS}lobby-memorize.png` });
    await Promise.all(phones.map((p) => p.page.waitForSelector('.nu-input', { timeout: 6000 })));
    // Ali hex ile tam isabet, Ayşe kaydırıcıyla, Mert dokunmaz (süre dolunca otomatik)
    await ali.page.fill('.nu-hex', targets[0]);
    await ali.page.click('.rc-submit');
    await ayse.page.locator('.nu-h').fill('90');
    await ayse.page.waitForSelector('.rc-check:has-text("gönderdi")'); // Ali'nin gönderdiği görünür
    const ayseHex = await ayse.page.inputValue('.nu-hex');
    assert.ok(!(await ayse.page.content()).includes(targets[0].toUpperCase()), 'Ali\'nin cevabı açıklanmadan görünmemeli');
    if (round === 1) await ayse.page.screenshot({ path: `${SHOTS}lobby-recall.png`, fullPage: true });
    assert.equal(await ayse.page.inputValue('.nu-hex'), ayseHex, 'başkası gönderince kaydırıcılar sıfırlanmamalı');
    await ayse.page.click('.rc-submit');
    if (round === 1) {
      await ali.page.waitForSelector('text=Cevabın gönderildi');
      await ali.page.screenshot({ path: `${SHOTS}lobby-submitted.png`, fullPage: true });
    }
    await Promise.all(phones.map((p) => p.page.waitForSelector('.rc-rank li .nu-chip', { timeout: 15000 })));
    const reveal = await ali.page.locator('.rc-rank').textContent();
    assert.match(reveal, /Ali.*1000/s);
    assert.equal(await ali.page.locator('.rc-rank li').count(), 3);
    if (round === 1) await mert.page.screenshot({ path: `${SHOTS}lobby-reveal.png`, fullPage: true });
    assert.equal(await mert.page.locator('button:has-text("Sonraki tur")').count(), 0, 'sadece host geçirir');
    await ali.page.click(round === 3 ? 'button:has-text("Sonuçları göster")' : 'button:has-text("Sonraki tur")');
  }
  await Promise.all(phones.map((p) => p.page.waitForSelector('text=Final sıralaması')));
  assert.match(await mert.page.locator('.rc-rank li').first().textContent(), /Ali/);
  await mert.page.screenshot({ path: `${SHOTS}lobby-final.png`, fullPage: true });
  for (const p of phones) {
    assert.ok(await noHorizontalScroll(p.page), `${p.name}: yatay kaydırma`);
    assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
  }
});
