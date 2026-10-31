// Tarayıcı testi: 🔊 Ton Avı — tek oyunculu günlük oyun (ped sürükleme, klavye, otomatik gönderim, sonuçta tekrar
// dinleme, sıralama) ve 2 telefonla Zor modda lobi oyunu (360×800). Ekran görüntüleri: test-results/tone/.
// Ses gerçekten çalıyor mu: OscillatorNode.start sayılır ve frekansı kaydedilir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-09';
const SHOTS = fileURLToPath(new URL('../../test-results/tone/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.4, env: { FAKE_TODAY: DAY } }); // ton 1.2 sn, hatırlama 12 sn
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    window.__tones = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.__tones.push(this.frequency.value);
      return start.apply(this, args);
    };
    // Zor mod: hedef sunucunun WAV'ı (AudioBufferSourceNode); sıfır geçişlerinden frekansı kaydet
    window.__wavs = [];
    const bstart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const d = this.buffer.getChannelData(0);
      let c = 0;
      for (let i = 1; i < d.length; i++) if (d[i - 1] < 0 && d[i] >= 0) c++;
      window.__wavs.push(c / this.buffer.duration);
      return bstart.apply(this, args);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${srv.url}/${hash}`);
  return { page, errors };
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Pedde basılı tutup dikey kaydır (fromFrac/toFrac: 0 = alt, 1 = üst)
async function drag(page, fromFrac, toFrac) {
  const box = await page.locator('.tn-pad').boundingBox();
  const y = (f) => box.y + box.height * (1 - f);
  await page.mouse.move(box.x + box.width / 2, y(fromFrac));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2, y(fromFrac + ((toFrac - fromFrac) * i) / 8));
  await page.mouse.up();
}

const hzOf = (text) => Number(text.replace(/[^\d.]/g, ''));

test('tek oyunculu günlük: ton çalar, ped ile perde bulunur, sonuçta tekrar dinlenir', async () => {
  const { page, errors } = await phone('#/single/tone');
  await page.fill('input[placeholder="Takma adın"]', 'Kulak');
  await page.click('button:has-text("Kaydet")');
  await page.waitForSelector('.rc-go');
  await page.click('.rc-go');

  for (let round = 0; round < 5; round++) {
    if (round > 0) await page.click('.rc-go');
    await page.waitForSelector('.tn-orb');
    assert.equal(await page.locator('button:has-text("Sesi aç")').count(), 0, 'otomatik çalma izinliyken düğme gerekmemeli');
    if (round === 0) await page.screenshot({ path: `${SHOTS}single-memorize.png` });
    const playedBefore = await page.evaluate(() => window.__tones.length);
    await page.waitForSelector('.tn-pad', { timeout: 6000 });
    assert.ok(playedBefore >= round + 1, 'ezberde ton çalmalı');
    const startHz = hzOf(await page.locator('.tn-hz').textContent());
    assert.ok(startHz >= 80 && startHz <= 1200);
    if (round === 0) {
      await drag(page, 0.5, 0.9);
      const high = hzOf(await page.locator('.tn-hz').textContent());
      await drag(page, 0.5, 0.1);
      const low = hzOf(await page.locator('.tn-hz').textContent());
      assert.ok(high > low * 4, `yukarı tiz, aşağı pes olmalı (${high} / ${low})`);
      const liveTones = await page.evaluate(() => window.__tones.length);
      assert.ok(liveTones >= playedBefore + 2, 'basılıyken ton çalmalı');
      await drag(page, 0.5, 0.55);
      await page.screenshot({ path: `${SHOTS}single-recall.png`, fullPage: true });
      assert.ok(await noHorizontalScroll(page));
      await page.click('.rc-submit');
      await page.waitForSelector('.tn-round.big');
      const detail = await page.locator('.tn-round.big').textContent();
      assert.match(detail, /sent/);
      // ezberde çalan frekans = sonuçta gösterilen hedef
      const target = hzOf(await page.locator('.tn-round.big .tn-vals b').first().textContent());
      const memoHz = await page.evaluate((i) => window.__tones[i], playedBefore - 1);
      assert.ok(Math.abs(memoHz - target) < 0.6, `çalan ${memoHz} ≠ hedef ${target}`);
      const n = await page.evaluate(() => window.__tones.length);
      await page.click('.tn-round.big .tn-play >> nth=0');
      assert.equal(await page.evaluate(() => window.__tones.length), n + 1, 'sonuç ekranında hedef tekrar çalınabilir');
      await page.screenshot({ path: `${SHOTS}single-result.png`, fullPage: true });
    } else if (round === 1) {
      await page.focus('.tn-pad');
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
      assert.ok(hzOf(await page.locator('.tn-hz').textContent()) > startHz, 'ok tuşu perdeyi yükseltmeli');
      await page.click('.rc-submit');
      await page.waitForSelector('.tn-round.big');
    } else if (round === 2) {
      await page.waitForSelector('.tn-round.big', { timeout: 20000 }); // dokunmadan bekle → otomatik gönderim
      assert.match(await page.locator('#toast').textContent(), /Süre doldu/);
    } else {
      await drag(page, 0.3, 0.4 + round * 0.1);
      await page.click('.rc-submit');
      await page.waitForSelector(round === 4 ? '.rc-final' : '.tn-round.big');
    }
  }
  await page.waitForSelector('.rc-board li');
  assert.match(await page.locator('.rc-total').textContent(), /^\d+\.\d\d\/50$/);
  assert.match(await page.locator('.rc-board').textContent(), /Kulak/);
  assert.equal(await page.locator('.rc-final .tn-round').count(), 5);
  await page.screenshot({ path: `${SHOTS}single-final.png`, fullPage: true });
  assert.deepEqual(errors, []);
});

test('2 telefon lobi, Zor mod: Hz gizli, aynı ton, açıklamada iki cevap', async () => {
  const phones = await Promise.all(['Deniz', 'Ece'].map(async (name) => {
    const p = await phone('#/multi/tone');
    await p.page.fill('input[placeholder="Takma adın"]', name);
    return { ...p, name };
  }));
  const [deniz, ece] = phones;
  await deniz.page.click('text=Yeni oda kur');
  const code = (await deniz.page.locator('.lobby-code').textContent()).trim();
  await ece.page.fill('.code-input', code);
  await ece.page.click('button:has-text("Katıl")');
  await deniz.page.waitForFunction(() => document.querySelectorAll('#game-tone .player-list li').length === 2);
  await deniz.page.selectOption('#game-tone select >> nth=0', '3');
  await deniz.page.selectOption('#game-tone select >> nth=1', 'hard');
  await deniz.page.selectOption('#game-tone select >> nth=2', '15');
  await ece.page.waitForFunction(() => [...document.querySelectorAll('#game-tone select')][1]?.value === 'hard');
  await ece.page.screenshot({ path: `${SHOTS}lobby-waiting.png`, fullPage: true });
  await deniz.page.click('#game-tone button:has-text("Oyunu başlat")');

  for (let round = 1; round <= 3; round++) {
    await Promise.all(phones.map((p) => p.page.waitForSelector('.tn-orb')));
    if (round === 1) await ece.page.screenshot({ path: `${SHOTS}lobby-memorize.png` });
    await Promise.all(phones.map((p) => p.page.waitForSelector('.tn-pad', { timeout: 6000 })));
    // Zor: Hz JSON'da yok, ton sunucunun WAV'ı olarak çalar (osilatör değil)
    const heard = await Promise.all(phones.map((p) => p.page.evaluate(() => window.__wavs.at(-1))));
    assert.equal(await deniz.page.evaluate(() => window.__wavs.length), round, 'her turda bir WAV çalmalı');
    assert.ok(heard.every((h) => h >= 55 && h <= 1450), `WAV frekansı ${heard}`);
    assert.ok(Math.abs(heard[0] / heard[1] - 1) < 0.02, `iki telefonda aynı ton çalmalı ${heard}`);
    assert.equal(await deniz.page.locator('.tn-hz').count(), 0, 'Zor modda Hz gizli');
    await drag(deniz.page, 0.2, 0.6);
    await deniz.page.click('.rc-submit');
    await ece.page.waitForSelector('.rc-check:has-text("gönderdi")');
    // Ece sürüklerken başkasının gönderimi ekranı sıfırlamamalı; Ece sonra gönderir
    await drag(ece.page, 0.7, 0.3);
    if (round === 1) {
      await ece.page.screenshot({ path: `${SHOTS}lobby-recall.png`, fullPage: true });
      await deniz.page.screenshot({ path: `${SHOTS}lobby-submitted.png`, fullPage: true });
    }
    await ece.page.click('.rc-submit');
    await Promise.all(phones.map((p) => p.page.waitForSelector('.rc-rank li .tn-chip')));
    assert.equal(await ece.page.locator('.rc-rank li').count(), 2);
    assert.match(await ece.page.locator('.rc-rank').textContent(), /Hz/);
    if (round === 1) await ece.page.screenshot({ path: `${SHOTS}lobby-reveal.png`, fullPage: true });
    await deniz.page.click(round === 3 ? 'button:has-text("Sonuçları göster")' : 'button:has-text("Sonraki tur")');
  }
  await Promise.all(phones.map((p) => p.page.waitForSelector('text=Final sıralaması')));
  assert.match(await ece.page.locator('.rc-rank li').first().textContent(), /\d+\.\d\d/);
  await ece.page.screenshot({ path: `${SHOTS}lobby-final.png`, fullPage: true });
  for (const p of phones) {
    assert.ok(await noHorizontalScroll(p.page), `${p.name}: yatay kaydırma`);
    assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
  }
});
