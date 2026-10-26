// QA: 👁️ Algıla kenar durumları — gönderim ağda düşerse (page.route abort) her testte ne olur, test ortasında yenileme,
// iOS benzeri dokunma ayarları. Ağ kesintisinde cevap korunur (regresyon); diğerleri console.log ile mevcut davranışı belgeler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { SHOTS, PHONE, openPage, stim, drag, press, box, landing, splitVal, beatTimes, tapSpace, nextBtn } from './qa-perceptle-lib.mjs';

let browser;
const servers = [];
before(async () => { browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }); });
after(async () => { await browser?.close(); for (const s of servers) await s.stop(); });
const server = async (day) => { const s = await startServer({ timeScale: 1, env: { FAKE_TODAY: day } }); servers.push(s); return s; };
const toastText = (page) => page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : ''; });
const hasResult = async (page) => (await page.locator('.pc-big-score').count()) > 0;

async function newDaily(day, name) {
  const srv = await server(day);
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, PHONE);
  await p.page.fill('input[placeholder="Takma adın"]', name);
  await press(p, 'button:has-text("Kaydet")');
  await p.page.waitForSelector('.pc-start');
  await nextBtn(p, 'Başla');
  return p;
}

// Bir testin ilk gönderimini ağda düşür; sayfa yenilemeden toparlanılabiliyor mu?
async function abortOnce(p, i, act, recover) {
  const { page } = p;
  await page.waitForSelector('.pc-intro');
  await nextBtn(p, 'Hazırım');
  const s = (await stim(p, i)).stimulus;
  await page.route('**/api/perceptle/submit', (r) => r.abort('internetdisconnected'));
  await act(s);
  await page.waitForTimeout(i === 3 ? 0 : 600);
  if (i === 3) await page.waitForSelector('.pc-tempo-label:has-text("Tamam")', { timeout: 15000 });
  await page.waitForTimeout(400);
  const t = await toastText(page);
  const lockDisabled = (await page.locator('.pc-lock').count()) ? await page.locator('.pc-lock').isDisabled() : 'yok';
  const tabsDisabled = await page.locator('.tab').first().isDisabled();
  await page.unroute('**/api/perceptle/submit');
  await recover(s);
  await page.waitForTimeout(1200);
  const recovered = await hasResult(page);
  let afterReload = null;
  if (!recovered) {
    await page.screenshot({ path: `${SHOTS}abort-stuck-${i}.png`, fullPage: true });
    await page.reload();
    // yenilenince ne olur?
    await page.waitForTimeout(i === 3 ? 600 : 300);
    await page.waitForSelector('.pc-intro, .pc-card, .pc-big-score', { timeout: 15000 });
    afterReload = (await page.locator('.pc-big-score').count()) ? `sonuç ${await page.locator('.pc-big-score').textContent()} (${await page.locator('.pc-detail').textContent()})` : (await page.locator('.pc-card').count() ? 'test ekranı yeniden açıldı' : 'giriş');
    if (!(await hasResult(page)) && (await page.locator('.pc-card').count())) await recover(s, true);
    await page.waitForSelector('.pc-big-score', { timeout: 15000 });
    afterReload += ` → son puan ${await page.locator('.pc-big-score').textContent()}`;
  }
  const line = `ABORT test ${i}: toast="${t}" lockDisabled=${lockDisabled} tabsDisabled=${tabsDisabled} recoveredWithoutReload=${recovered}${afterReload ? ` | reload: ${afterReload}` : ''}`;
  console.log(line);
  return { recovered, line };
}

test('ağ kesintisi: gönderim düşerse cevap kaybolmaz (otomatik yeniden deneme + Tekrar gönder)', async () => {
  const p = await newDaily('2026-11-02', 'Ağ QA');
  const { page } = p;
  const SUBMIT = '**/api/perceptle/submit';
  // 1. Say: bağlantı tamamen yok → 3 deneme sonra "Tekrar gönder" ekranı; bağlantı gelince gönderilir
  await nextBtn(p, 'Hazırım');
  const s0 = (await stim(p, 0)).stimulus;
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  await page.route(SUBMIT, (r) => r.abort());
  await page.fill('.pc-num', String(s0.dots.length));
  await press(p, '.pc-lock');
  await page.waitForSelector('text=Bağlantı koptu', { timeout: 8000 });
  assert.equal(await hasResult(page), false);
  await page.unroute(SUBMIT);
  await press(p, 'button:has-text("Tekrar gönder")');
  await page.waitForSelector('.pc-big-score');
  assert.equal(Number(await page.locator('.pc-big-score').textContent().then((t) => t.match(/\d+/)[0])), 100, 'doğru sayı tam puan');
  await nextBtn(p, 'Sonraki test');

  // 2. Yörünge ve 3. Açı normal
  await nextBtn(p, 'Hazırım');
  const s1 = (await stim(p, 1)).stimulus;
  await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 8000 });
  const fb = await box(p, '.pc-field');
  await page.touchscreen.tap(fb.x + (landing(s1) / 1000) * fb.width, fb.y + fb.height / 2);
  await press(p, '.pc-lock');
  await page.waitForSelector('.pc-big-score');
  await nextBtn(p, 'Sonraki test');
  await nextBtn(p, 'Hazırım');
  const s2 = (await stim(p, 2)).stimulus;
  await page.waitForSelector('.pc-dial');
  const db = await box(p, '.pc-dial');
  const a = (s2.target * Math.PI) / 180;
  await page.touchscreen.tap(db.x + db.width / 2 + Math.cos(a) * db.width * 0.38, db.y + db.height / 2 - Math.sin(a) * db.width * 0.38);
  await press(p, '.pc-lock');
  await page.waitForSelector('.pc-big-score');
  await nextBtn(p, 'Sonraki test');

  // 4. Ritim: ilk gönderim düşer → kendiliğinden yeniden denenir, dokunuşlar kaybolmaz
  let aborted = 0;
  await page.route(SUBMIT, (r) => (aborted++ === 0 ? r.abort() : r.continue()));
  await nextBtn(p, 'Hazırım');
  const s3 = (await stim(p, 3)).stimulus;
  await tapSpace(page, beatTimes(s3.bpm, false));
  await page.waitForSelector('.pc-big-score', { timeout: 20000 });
  assert.ok(aborted >= 2, 'yeniden denenmeli');
  const tempo = Number((await page.locator('.pc-big-score').textContent()).match(/\d+/)[0]);
  assert.ok(tempo >= 80, `ritim dokunuşları korunmalı (${tempo})`);
  await page.unroute(SUBMIT);
  assert.deepEqual(p.errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e)), []);
});

test('yenileme: Say gösterimi sırasında, Açı ortasında, sınırsız oyun ortasında', async () => {
  const p = await newDaily('2026-11-03', 'Yenile QA');
  const { page } = p;
  await nextBtn(p, 'Hazırım');
  const s0 = (await stim(p, 0)).stimulus;
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(200);
  const during = await page.locator('#game-perceptle').textContent();
  console.log('RELOAD count during show →', /Yükleniyor/.test(during) ? 'Yükleniyor…' : during.slice(0, 80));
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  const dotsAgain = await page.evaluate(() => { const c = document.querySelector('.pc-stage canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 200) n++; return n; });
  console.log('RELOAD count: nokta pikselleri yenilemeden sonra', dotsAgain, '(0 = tekrar gösterilmedi)');
  assert.equal(dotsAgain, 0);
  await page.fill('.pc-num', String(s0.dots.length));
  await page.press('.pc-num', 'Enter');
  await page.waitForSelector('.pc-big-score');
  console.log('RELOAD count result', await page.locator('.pc-detail').textContent());
  // Yörünge geç
  await nextBtn(p, 'Sonraki test');
  await nextBtn(p, 'Hazırım');
  await page.waitForTimeout(150);
  await page.reload(); // uçuş sırasında
  await page.waitForSelector('.pc-field', { timeout: 8000 });
  await page.waitForSelector('.pc-tip:not(.hidden)', { timeout: 8000 });
  const fb = await box(p, '.pc-field');
  await page.touchscreen.tap(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await press(p, '.pc-lock');
  await page.waitForSelector('.pc-big-score');
  console.log('RELOAD track (yay görünmez, kör tahmin):', await page.locator('.pc-detail').textContent(), 'reveal:', await page.locator('.pc-reveal').count());
  // Açı ortasında yenile: hedef tekrar gelir
  await nextBtn(p, 'Sonraki test');
  await nextBtn(p, 'Hazırım');
  const target = (await stim(p, 2)).stimulus.target;
  await page.reload();
  await page.waitForSelector('.pc-dial');
  assert.equal((await page.locator('.pc-target').textContent()).trim(), `${target}°`);
  console.log('RELOAD angle: hedef tekrar geldi', target);
  // ritim ortasında yenile → 0
  const db = await box(p, '.pc-dial');
  await page.touchscreen.tap(db.x + db.width / 2, db.y + 10);
  await page.click(".pc-lock"); // tek dokunuş yönü ayarlar, Kilitle gönderir
  await page.waitForSelector('.pc-big-score');
  await nextBtn(p, 'Sonraki test');
  await nextBtn(p, 'Hazırım');
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector('.pc-big-score', { timeout: 20000 });
  console.log('RELOAD tempo →', await page.locator('.pc-big-score').textContent(), await page.locator('.pc-detail').textContent());

  // sınırsız: yenileyince oyun kaybolur mu?
  await page.click('.rc-go');
  await page.waitForSelector('.pc-intro');
  await page.click('.tab:has-text("Sınırsız")');
  await page.click('.rc-go:has-text("Başla")');
  await page.waitForSelector('.pc-intro');
  await nextBtn(p, 'Hazırım');
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  await page.reload();
  await page.waitForTimeout(800);
  console.log('RELOAD free mid-game →', (await page.locator('#game-perceptle h2').first().textContent()));
  console.log('ERRORS', p.errors);
});

test('iOS benzeri: dokunma ayarları, giriş yazı boyutu, viewport', async () => {
  const srv = await server('2026-11-04');
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, { ...PHONE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const { page } = p;
  await page.waitForSelector('.pc-start');
  const info = await page.evaluate(() => {
    const ta = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).touchAction : 'yok'; };
    const fs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).fontSize : 'yok'; };
    return { viewport: document.querySelector('meta[name=viewport]').content, goTA: ta('.rc-go'), tabTA: ta('.tab'), bodyTA: getComputedStyle(document.body).touchAction, nameFont: fs('input[placeholder="Takma adın"]') };
  });
  await nextBtn(p, 'Başla');
  await nextBtn(p, 'Hazırım');
  await page.waitForSelector('.pc-num:not([disabled])', { timeout: 6000 });
  Object.assign(info, await page.evaluate(() => ({ numFont: getComputedStyle(document.querySelector('.pc-num')).fontSize, lockTA: getComputedStyle(document.querySelector('.pc-lock')).touchAction, numType: document.querySelector('.pc-num').inputMode })));
  console.log('IOS', JSON.stringify(info));
});
