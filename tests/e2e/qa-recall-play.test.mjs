// QA oyuncu testi: 🎨 Nüans ve 🔊 Ton Avı uçtan uca (390×844 telefon).
// - Nüans günlük: puan = CIEDE2000 formülü, hex↔kaydırıcı eşleşmesi, her tur rastgele başlangıç, tur ortasında yenileme,
//   bitince tekrar oynanamaz, sıralama.
// - Ton Avı tek kişilik lobi: tek başına oda kur/başlat, puan = sent formülü, dokunmadan süre dolunca başlangıç değeri gider.
// - Regresyon: sonradan girilen ad sıralamaya yansır; lobide yeniden çizimde süre çubuğu baştan dolmaz.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { hexToRgb, scoreColor, scoreTone } from '../../public/recall-math.js';

const DAY = '2026-11-20';
let srv;
let browser;

before(async () => {
  srv = await startServer({ timeScale: 0.4, env: { FAKE_TODAY: DAY } });
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${srv.url}/${hash}`);
  return { ctx, page, errors };
}

const cssHex = (css) => `#${css.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const hzOf = (t) => Number(t.replace(/[^\d.]/g, ''));

test('Nüans günlük: formül, hex↔kaydırıcı, rastgele başlangıç, yenileme, tekrar oynanamaz', async () => {
  const { page, errors } = await phone('#/single/nuance');
  await page.fill('input[placeholder="Takma adın"]', 'QA Renk');
  await page.click('button:has-text("Kaydet")');
  await page.click('.rc-go');
  const starts = new Set();
  const scores = [];
  for (let round = 0; round < 5; round++) {
    if (round > 0) await page.click('.rc-go');
    await page.waitForSelector('.nu-target');
    const target = cssHex(await page.$eval('.nu-target', (n) => getComputedStyle(n).backgroundColor));
    await page.waitForSelector('.nu-input', { timeout: 6000 });
    starts.add(await page.inputValue('.nu-hex'));
    if (round === 2) {
      await page.reload();
      await page.waitForSelector('.nu-input', { timeout: 8000 });
      assert.equal(await page.locator('.nu-target').count(), 0, 'yenilemede hedef tekrar gösterilmez');
    }
    let guess;
    if (round === 1) {
      await page.locator('.nu-h').fill('120');
      await page.locator('.nu-s').fill('50');
      await page.locator('.nu-b').fill('50');
      guess = (await page.inputValue('.nu-hex')).toLowerCase();
      assert.equal(guess, '#408040');
    } else {
      guess = ['#000000', null, '#ff8800', '#336699', target][round] ?? target;
      await page.fill('.nu-hex', guess);
      // hex → kaydırıcı → hex: kaydırıcıya dokunmak rengi bozmamalı
      await page.locator('.nu-s').dispatchEvent('input');
      assert.equal((await page.inputValue('.nu-hex')).toLowerCase(), guess.toLowerCase());
    }
    assert.ok(await noHScroll(page));
    await page.click('.rc-submit');
    await page.waitForSelector(round === 4 ? '.rc-final' : '.nu-round.big');
    const exp = scoreColor(hexToRgb(target), hexToRgb(guess));
    const shown = round === 4
      ? Number(await page.locator('.rc-final .nu-score').nth(4).textContent())
      : Number((await page.locator('.nu-round.big .nu-score').textContent()).match(/\d+/)[0]);
    assert.equal(shown, exp, `tur ${round + 1}: gösterilen ${shown}, formül ${exp}`);
    scores.push(exp);
  }
  assert.ok(starts.size >= 4, 'her tur farklı rastgele başlangıç');
  const avg = Math.round(scores.reduce((a, b) => a + b) / 5);
  assert.match(await page.locator('.rc-total').textContent(), new RegExp(`^${avg}/1000 · `));
  await page.waitForSelector('.rc-board li');
  assert.match(await page.locator('.rc-board').textContent(), /QA Renk/);
  await page.reload();
  await page.waitForSelector('.rc-final');
  assert.equal(await page.locator('.rc-go').count(), 0, 'bitmiş günlük tekrar başlatılamaz');
  const replay = await page.evaluate(async (day) => {
    const id = JSON.parse(localStorage.getItem('tss:identity'));
    const r = await fetch('/api/recall/nuance/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...id, mode: 'daily', gameId: day, round: 0 }) });
    return r.status;
  }, DAY);
  assert.equal(replay, 400);
  assert.deepEqual(errors, []);
});

test('Ton Avı tek kişilik lobi: tek başına başlar, puan formülü, dokunmadan süre dolunca başlangıç perdesi gider', async () => {
  const { page, errors } = await phone('#/multi/tone');
  await page.fill('input[placeholder="Takma adın"]', 'Yalnız');
  await page.click('text=Yeni oda kur');
  await page.waitForSelector('.lobby-code');
  await page.selectOption('#game-tone select >> nth=0', '3');
  await page.selectOption('#game-tone select >> nth=2', '15');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#game-tone button:has-text("Oyunu başlat")').isDisabled(), false);
  await page.click('#game-tone button:has-text("Oyunu başlat")');
  let total = 0;
  for (let round = 1; round <= 3; round++) {
    await page.waitForSelector('.tn-pad', { timeout: 10000 });
    const start = hzOf(await page.locator('.tn-hz').textContent());
    if (round === 2) {
      await page.waitForSelector('.rc-rank li', { timeout: 12000 }); // süre doldu → otomatik gönderim
    } else {
      await page.focus('.tn-pad');
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
      await page.click('.rc-submit');
      await page.waitForSelector('.rc-rank li', { timeout: 3000 }); // tek kişi gönderince tur hemen biter
    }
    const vals = await page.$$eval('.tn-round.big .tn-vals b', (n) => n.map((x) => x.textContent));
    const [target, guess] = vals.map(hzOf);
    if (round === 2) assert.equal(guess, start, 'otomatik gönderimde başlangıç perdesi gitmeli');
    const shown = Number((await page.locator('.tn-round.big .nu-score').textContent()).match(/[\d.]+/)[0]);
    assert.equal(shown, scoreTone(target, guess));
    total += shown;
    await page.click(round === 3 ? 'button:has-text("Sonuçları göster")' : 'button:has-text("Sonraki tur")');
  }
  await page.waitForSelector('text=Final sıralaması');
  assert.match(await page.locator('.rc-rank').textContent(), new RegExp((Math.round(total * 100) / 100).toFixed(2)));
  assert.ok(await noHScroll(page));
  assert.deepEqual(errors, []);
});

test('oyunu bitirdikten sonra girilen ad sıralamaya yansır', async () => {
  const { page } = await phone('#/single/tone');
  await page.waitForSelector('.rc-go');
  for (let round = 0; round < 5; round++) {
    await page.click('.rc-go');
    await page.waitForSelector('.tn-pad', { timeout: 6000 });
    await page.click('.rc-submit');
    await page.waitForSelector(round === 4 ? '.rc-board li' : '.tn-round.big');
  }
  await page.fill('input[placeholder="Takma adın"]', 'Sonradan');
  await page.click('button:has-text("Kaydet")');
  await page.reload();
  await page.waitForSelector('.rc-board li');
  assert.match(await page.locator('.rc-board').textContent(), /Sonradan/);
});

test('lobide ekran yeniden çizilince süre çubuğu baştan dolmaz', async () => {
  const phones = await Promise.all(['Ana', 'Baba'].map(async (n) => { const p = await phone('#/multi/nuance'); await p.page.fill('input[placeholder="Takma adın"]', n); return p; }));
  const [a, b] = phones;
  await a.page.click('text=Yeni oda kur');
  const code = (await a.page.locator('.lobby-code').textContent()).trim();
  await b.page.fill('.code-input', code);
  await b.page.click('button:has-text("Katıl")');
  await a.page.waitForFunction(() => document.querySelectorAll('#game-nuance .player-list li').length === 2);
  await a.page.click('#game-nuance button:has-text("Oyunu başlat")');
  await a.page.waitForSelector('.nu-input', { timeout: 8000 });
  await a.page.waitForTimeout(6000); // 12 sn'nin yarısı
  await b.page.close(); // bağlantı durumu değişir → A'nın ekranı yeniden çizilir
  await a.page.waitForTimeout(800);
  const pct = await a.page.evaluate(() => {
    const f = document.querySelector('.rc-bar-fill').getBoundingClientRect().width;
    return (f / document.querySelector('.rc-bar').getBoundingClientRect().width) * 100;
  });
  assert.ok(pct < 60, `çubuk %${Math.round(pct)} (kalan süre ~%45 olmalı)`);
});
