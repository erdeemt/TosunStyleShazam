// Tarayıcı testi: hafıza oyunlarının yeni arayüzü — Nüans yay kadranları parmakla çevrilir, Ton Avı sahnesinde
// dalga çizilir ve kartın içindeki "Kilitle" düğmesi gönderir (360×800, dokunmatik).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

let srv;
let browser;

before(async () => {
  srv = await startServer({ timeScale: 0.4, env: { FAKE_TODAY: '2026-11-10' } });
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

// Kadranın merkezine göre açıyla (0 = tepe, saat yönü) bir noktaya fareyle bas-sürükle.
async function turn(page, dial, fromDeg, toDeg) {
  const box = await dial.boundingBox();
  const at = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [box.x + box.width / 2 + Math.sin(a) * box.width * 0.42, box.y + box.height / 2 - Math.cos(a) * box.height * 0.42];
  };
  await page.mouse.move(...at(fromDeg));
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(...at(fromDeg + ((toDeg - fromDeg) * i) / 6));
  await page.mouse.up();
}

test('Nüans: yay kadranları çevrilir, hex ve değer etiketleri güncellenir, Kilitle gönderir', async () => {
  const { page, errors } = await phone('#/single/nuance');
  await page.waitForSelector('.rc-go');
  await page.click('.rc-go');
  await page.waitForSelector('.nu-knob', { timeout: 8000 });
  const dials = page.locator('.nu-dial');
  assert.equal(await dials.count(), 3);
  assert.equal(await page.locator('.rc-submit').count(), 1, 'tek gönder düğmesi (kartın içinde)');

  // Ton: sol alttan (225°) tepeye (360°) çevir → 135/270 × 360 = 180°
  await turn(page, dials.nth(0), 230, 360);
  const hue = Number(await page.$eval('.nu-h', (n) => n.value));
  assert.ok(Math.abs(hue - 180) < 6, `ton ≈180 olmalı (${hue})`);
  assert.equal(await page.locator('.nu-knob >> nth=0 >> .nu-val').textContent(), String(Math.round(hue)));

  // Parlaklık: en sağa (alttaki boşluğa taşsa da) → 100
  await turn(page, dials.nth(2), 300, 150);
  assert.equal(Math.round(Number(await page.$eval('.nu-b', (n) => n.value))), 100);
  // Doygunluk: en sola → 0; renk gri olur
  await turn(page, dials.nth(1), 300, 215);
  assert.equal(Math.round(Number(await page.$eval('.nu-s', (n) => n.value))), 0);
  assert.equal((await page.inputValue('.nu-hex')).toUpperCase(), '#FFFFFF');

  await page.click('.rc-submit');
  await page.waitForSelector('.nu-round.big');
  assert.match(await page.locator('.nu-round.big').textContent(), /#FFFFFF/);
  assert.deepEqual(errors, []);
});

test('Ton Avı: sahnede dalga çizilir, basılıyken parlar, Kilitle gönderir', async () => {
  const { page, errors } = await phone('#/single/tone');
  await page.waitForSelector('.rc-go');
  await page.click('.rc-go');
  await page.waitForSelector('.tn-memo canvas.tn-wave');
  await page.waitForSelector('.tn-pad canvas.tn-wave', { timeout: 6000 });
  await page.waitForTimeout(200);
  // Kanvas boş değil: ortada parlak piksel var
  const lit = await page.$eval('.tn-pad canvas.tn-wave', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 40) n++;
    return n;
  });
  assert.ok(lit > 200, `dalga çizilmeli (${lit})`);
  const box = await page.locator('.tn-pad').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2, { steps: 5 });
  assert.equal(await page.locator('.tn-pad.active').count(), 1);
  await page.mouse.up();
  assert.equal(await page.locator('.tn-pad.active').count(), 0);
  assert.equal(await page.locator('.rc-submit').count(), 1);
  await page.click('.rc-submit');
  await page.waitForSelector('.tn-round.big');
  assert.deepEqual(errors, []);
});
