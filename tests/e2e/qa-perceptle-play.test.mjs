// QA: 👁️ Algıla'yı gerçek oyuncu gibi oyna — telefon (360×800 dokunmatik, DPR 3) ve masaüstü (fare).
// Günlük Pazartesi, günlük Cuma, sınırsız Normal, sınırsız Cuma. Her test puanı formülle bağımsız doğrulanır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { SHOTS, PHONE, DESKTOP, openPage, playTest, nextBtn, press, noHScroll, smallTargets, canvasDpr, gradeOf } from './qa-perceptle-lib.mjs';

let browser;
const servers = [];
before(async () => { browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }); });
after(async () => { await browser?.close(); for (const s of servers) await s.stop(); });
const server = async (day) => { const s = await startServer({ timeScale: 1, env: day ? { FAKE_TODAY: day } : {} }); servers.push(s); return s; };

async function fullRun(p, { friday, plans, tag, daily }) {
  const { page } = p;
  const notes = [];
  const results = [];
  const small = new Set();
  for (let i = 0; i < 5; i++) {
    if (i > 0) await nextBtn(p, 'Sonraki test');
    if (i === 0 && daily) await nextBtn(p, 'Başla');
    // test ekranında küçük hedefler, DPR, yatay kaydırma
    await page.waitForSelector('.pc-intro');
    const r = await playTest(p, i, plans, friday, notes);
    for (const s of await smallTargets(page)) small.add(`[${i}] ${s}`);
    for (const c of await canvasDpr(page)) if (!c.ok) notes.push(`canvas not DPR-crisp test ${i}: ${JSON.stringify(c)}`);
    assert.ok(await noHScroll(page), `yatay kaydırma, test ${i}`);
    await page.screenshot({ path: `${SHOTS}${tag}-${i}-result.png`, fullPage: true });
    results.push(r);
  }
  await nextBtn(p, 'Sonucu gör');
  await page.waitForSelector('.pc-final');
  for (const s of await smallTargets(page)) small.add(`[final] ${s}`);
  assert.ok(await noHScroll(page), 'final yatay kaydırma');
  const total = Number((await page.locator('.pc-total').textContent()).match(/^\d+/)[0]);
  const grade = (await page.locator('.pc-grade').textContent()).trim();
  await press(p, 'button:has-text("Paylaş")');
  await page.waitForTimeout(200);
  const shared = await page.evaluate(() => window.__shared.at(-1));
  await page.screenshot({ path: `${SHOTS}${tag}-final.png`, fullPage: true });
  return { results, notes, small: [...small], total, grade, shared, finalText: await page.locator('.pc-final').textContent() };
}

function check(run, friday, label) {
  const log = [];
  for (const r of run.results) {
    log.push(`${label} t${r.i}: shown=${r.shown} server=${r.played.score} formula=${r.exp} | ${r.detail}`);
    assert.equal(r.shown, r.played.score);
    assert.equal(r.played.score, r.exp, `${label} test ${r.i} formül farkı: ${r.played.score} vs ${r.exp}`);
  }
  const mean = Math.round(run.results.reduce((a, r) => a + r.played.score, 0) / 5);
  assert.equal(run.total, mean);
  assert.equal(run.grade, gradeOf(mean));
  const squares = run.results.map((r) => (r.played.score >= 85 ? '🟩' : r.played.score >= 55 ? '🟨' : '🟥')).join('');
  assert.ok(run.shared.includes(squares), `paylaşım kareleri: ${run.shared}`);
  assert.ok(run.shared.includes(`${mean} (${gradeOf(mean)})`));
  if (friday) assert.ok(run.shared.includes('🃏'));
  console.log(log.join('\n'));
  console.log(`${label} total=${run.total} ${run.grade} share=${JSON.stringify(run.shared)}`);
  console.log(`${label} notes: ${run.notes.join(' | ')}`);
  console.log(`${label} small targets: ${run.small.join(' ; ') || 'yok'}`);
}

test('telefon: günlük Pazartesi, bilinçli hatalarla — puan formülü, paylaşım, sıralama', async () => {
  const srv = await server('2026-11-02');
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, PHONE);
  await p.page.fill('input[placeholder="Takma adın"]', 'QA Kedi');
  await press(p, 'button:has-text("Kaydet")');
  await p.page.waitForSelector('.pc-start');
  const run = await fullRun(p, { friday: false, daily: true, tag: 'phone-daily', plans: { count: 7, track: 45, angle: 6, tempo: 25, split: 0.03 } });
  check(run, false, 'phone-daily');
  await p.page.waitForSelector('.rc-board li');
  assert.match(await p.page.locator('.rc-board').textContent(), /QA Kedi/);
  assert.match(run.shared, /^Tosun Algıla #8 · /);
  assert.ok(run.results[3].played.score >= 85, 'kalibre ritim (+25 ms) yüksek olmalı');
  await p.page.reload();
  await p.page.waitForSelector('.pc-final');
  assert.equal(await p.page.locator('.rc-go').count(), 0);
  assert.deepEqual(p.errors, []);
});

test('telefon: günlük CUMA (2026-10-30) — çizgi dışı Böl, sarımlı Açı dokunmatikle', async () => {
  const srv = await server('2026-10-30');
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, PHONE);
  await p.page.fill('input[placeholder="Takma adın"]', 'Cuma QA');
  await press(p, 'button:has-text("Kaydet")');
  await p.page.waitForSelector('.pc-start .pc-friday');
  const run = await fullRun(p, { friday: true, daily: true, tag: 'phone-friday', plans: { count: -5, track: -30, angle: 4, tempo: 0, split: 0.02 } });
  check(run, true, 'phone-friday');
  assert.ok(run.results[2].played.answer > 360 || run.results[2].played.truth < 360, 'sarım');
  assert.ok(run.results[2].played.score >= 85, `cuma açı puanı ${run.results[2].played.score}`);
  assert.ok(run.results[4].played.score >= 85, `cuma böl puanı ${run.results[4].played.score}`);
  assert.ok(run.results[3].played.score >= 85, `cuma ritim puanı ${run.results[3].played.score}`);
  assert.deepEqual(p.errors, []);
});

test('masaüstü fare: sınırsız Normal (rastgele ritim → düşük)', async () => {
  const srv = await server();
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, DESKTOP);
  await p.page.click('.tab:has-text("Sınırsız")');
  await p.page.click('.rc-diff:has-text("Normal")');
  await p.page.click('.rc-go:has-text("Başla")');
  const run = await fullRun(p, { friday: false, tag: 'desk-free', plans: { count: 0, track: 0, angle: 0, tempo: 'random', split: 0 } });
  check(run, false, 'desk-free');
  assert.ok(run.results[3].played.score < 40, `rastgele ritim ${run.results[3].played.score}`);
  assert.ok(run.results[0].played.score === 100);
  assert.equal(await p.page.locator('.rc-board').count(), 0);
  assert.match(run.shared, /sınırsız/);
  assert.deepEqual(p.errors, []);
});

test('telefon: sınırsız Cuma, açı hedefi 360° üstü olana kadar (dokunmatik sarım)', async () => {
  const srv = await server();
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, PHONE);
  await p.page.click('.tab:has-text("Sınırsız")');
  await press(p, '.rc-diff:has-text("Cuma")');
  for (let g = 0; g < 4; g++) {
    p.stimuli.length = 0;
    await press(p, '.rc-go:has-text("Başla")');
    const run = await fullRun(p, { friday: true, tag: `phone-free-friday${g}`, plans: { count: 3, track: 20, angle: 5, tempo: 15, split: 0.04 } });
    check(run, true, `phone-free-friday${g}`);
    const a = run.results[2].played;
    if (a.truth > 400) { assert.ok(a.score >= 80, `dokunmatik sarım puanı ${a.score} (hedef ${a.truth}, sen ${a.answer})`); break; }
    await press(p, 'button:has-text("Yeni oyun")');
    await p.page.waitForSelector('.rc-diffs');
  }
  assert.deepEqual(p.errors, []);
});

test('masaüstü fare: sınırsız Cuma', async () => {
  const srv = await server();
  const p = await openPage(browser, `${srv.url}/#/single/perceptle`, DESKTOP);
  await p.page.click('.tab:has-text("Sınırsız")');
  await p.page.click('.rc-diff:has-text("Cuma")');
  await p.page.click('.rc-go:has-text("Başla")');
  const run = await fullRun(p, { friday: true, tag: 'desk-friday', plans: { count: 10, track: 70, angle: -10, tempo: 40, split: -0.06 } });
  check(run, true, 'desk-friday');
  assert.deepEqual(p.errors, []);
});
