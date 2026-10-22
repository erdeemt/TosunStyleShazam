// Tarayıcı testi: Wordle TR günlük modu — klavye, renkler, kazanma, sıralama, yenileme sonrası devam.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-06';
process.env.TEST_GAMES = '1';
process.env.FAKE_TODAY = DAY;
const { dailyAnswer } = await import('../../server/wordle.js');
const ANSWER = dailyAnswer(DAY);
const VALID = JSON.parse(readFileSync(new URL('../../content/wordle/valid.json', import.meta.url)));
const WRONG = VALID.find((w) => ![...w].some((c) => ANSWER.includes(c))) ?? VALID.find((w) => w !== ANSWER);

const SHOTS = fileURLToPath(new URL('../../test-results/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ env: { FAKE_TODAY: DAY } });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test('günlük Wordle: yanlış + doğru tahmin, renkler, sıralama, yenileme', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Geçersiz kelimede sunucu 400 döner; tarayıcının bunu konsola yazması beklenen davranış.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${srv.url}/#/single/wordle`);
  await page.waitForSelector('.w-grid');
  await page.fill('input[placeholder="Takma adın"]', 'Tester');
  await page.click('button:has-text("Kaydet")');
  await page.waitForSelector('input[placeholder="Takma adın"]', { state: 'detached' });

  // Sözlükte olmayan kelime: hak gitmez
  await page.keyboard.type('qwxyz'.replace(/[qwx]/g, 'z'));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast.show');
  await page.keyboard.press('Backspace');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');

  // Yanlış kelime (ekran klavyesinden)
  for (const ch of WRONG) await page.click(`.w-key[aria-label="${ch}"]`);
  await page.click('.w-key[aria-label="Gönder"]');
  await page.waitForFunction(() => document.querySelectorAll('.w-row')[0].querySelector('.absent, .present, .correct'));
  const firstRow = await page.$$eval('.w-row:first-child .w-tile', (t) => t.map((x) => x.className));
  assert.ok(firstRow.every((c) => /absent|present|correct/.test(c)));

  // Doğru kelime (fiziksel klavye)
  await page.keyboard.type(ANSWER);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.w-result');
  const second = await page.$$eval('.w-row:nth-child(2) .w-tile', (t) => t.map((x) => x.className));
  assert.ok(second.every((c) => c.includes('correct')));
  await page.waitForSelector('.w-board li');
  assert.match(await page.locator('.w-board').textContent(), /Tester.*2\/6/);
  await page.waitForTimeout(1700);
  await page.screenshot({ path: `${SHOTS}wordle-won.png`, fullPage: true });

  // Yenileyince bitmiş oyun ve sıralama geri gelir
  await page.reload();
  await page.waitForSelector('.w-result');
  assert.equal(await page.locator('.w-key').count(), 0, 'bitmiş oyunda klavye olmamalı');

  // Sınırsız mod sekmesi çalışır
  await page.click('.tab:has-text("Sınırsız")');
  await page.waitForSelector('.w-key');
  await page.screenshot({ path: `${SHOTS}wordle-free.png` });

  assert.deepEqual(errors, []);
});
