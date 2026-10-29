// Tarayıcı testi: ⚽ Tosun Top — 2 yatay telefon + 1 dikey telefon. Oda kur/katıl, takım seç, başlat,
// joystick ile koş (gerçek çoklu dokunuş: joystick + ŞUT aynı anda), şut, gol, maç sonu, bekleme odasına dönüş.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/haxball/', import.meta.url));
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.2 }); // 2 dk maç ≈ 24 sn (fizik gerçek zamanlı)
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(name, { width = 800, height = 360 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${srv.url}/#/multi/haxball`);
  await page.fill('input[placeholder="Takma adın"]', name);
  const cdp = await ctx.newCDPSession(page);
  return { page, errors, name, cdp };
}

const state = (p) => p.page.evaluate(async () => {
  const { net } = await import('/net.js');
  return { view: net.view, room: net.room, me: net.playerId, frame: net.frame };
});
async function until(p, pred, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(p);
    if (pred(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`${p.name}: koşul sağlanmadı`);
    await p.page.waitForTimeout(80);
  }
}
const myPos = (s) => {
  const i = s.view.discs.findIndex((d) => d.id === s.me);
  if (i < 0 || s.frame?.v !== s.view.ver) return null;
  return { x: s.frame.p[2 * i] / 10, y: s.frame.p[2 * i + 1] / 10, i, kick: (s.frame.f >> i) & 1 };
};
const shot = (p, name) => p.page.screenshot({ path: `${SHOTS}${name}.png` });
const touch = (p, type, points) => p.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id: id + 1, radiusX: 8, radiusY: 8, force: 1 })) });
async function noHorizontalScroll(p, label) {
  const m = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(m.sw <= m.w, `${p.name} ${label}: yatay kaydırma (${m.sw} > ${m.w})`);
}

test('2 yatay + 1 dikey telefon: takım seç, joystick + şut, gol, maç sonu', async () => {
  const host = await phone('Ali');
  const guest = await phone('Ayşe');
  const tall = await phone('Mert', { width: 360, height: 800 });
  await host.page.click('text=Yeni oda kur');
  const code = (await host.page.locator('#game-haxball .lobby-code').textContent()).trim();
  for (const p of [guest, tall]) {
    await p.page.fill('#game-haxball .code-input', code);
    await p.page.click('#game-haxball button:has-text("Katıl")');
  }
  await host.page.waitForFunction(() => document.querySelectorAll('#game-haxball .player-list li').length === 3);
  await host.page.click('#game-haxball .hx-pick.red');
  await guest.page.click('#game-haxball .hx-pick.blue');
  await tall.page.click('#game-haxball .hx-pick.red');
  await until(host, (s) => Object.keys(s.room.prep.teams).length === 3);
  await host.page.selectOption('#game-haxball select >> nth=0', '2');
  await until(host, (s) => s.room.settings.minutes === 2);
  await host.page.waitForSelector('#game-haxball .hx-team.blue li:has-text("Ayşe")');
  await shot(host, '00-lobby-host');
  await tall.page.screenshot({ path: `${SHOTS}00-lobby-portrait.png`, fullPage: true });
  for (const p of [host, guest, tall]) await noHorizontalScroll(p, 'lobi');
  // Dokunma hedefleri ≥ 44 px
  const small = await tall.page.$$eval('#game-haxball button, #game-haxball select', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent));
  assert.deepEqual(small, [], 'küçük dokunma hedefi');

  await host.page.click('#game-haxball button:has-text("Oyunu başlat")');
  for (const p of [host, guest, tall]) {
    await p.page.waitForSelector('#game-haxball .hx-stage.live');
    await until(p, (s) => s.frame && s.view && myPos(s));
  }
  await host.page.waitForTimeout(400);
  await shot(host, '01-kickoff-host');
  await shot(tall, '01-kickoff-portrait');
  for (const p of [host, guest, tall]) {
    await noHorizontalScroll(p, 'saha');
    const box = await p.page.locator('#game-haxball canvas').boundingBox();
    const vp = p.page.viewportSize();
    assert.ok(box.width > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `${p.name}: saha ekrana sığmalı`);
    const k = await p.page.locator('#game-haxball .hx-kick').boundingBox();
    assert.ok(k && k.width >= 44 && k.height >= 44, 'ŞUT tuşu büyük olmalı');
  }
  assert.ok(await tall.page.locator('.hx-rotate').isVisible(), 'dikeyde "yan çevir" ipucu');
  assert.ok(!(await host.page.locator('.hx-rotate').isVisible()), 'yatayda ipucu yok');
  // Tuval DPR'ye göre: piksel genişliği = CSS genişliği × 2
  const dpr = await host.page.$eval('#game-haxball canvas', (c) => c.width / c.getBoundingClientRect().width);
  assert.ok(Math.abs(dpr - 2) < 0.05, `tuval DPR ${dpr}`);

  // Joystick: sol yarıda parmak bas → sağa kaydır; aynı anda ikinci parmakla ŞUT (çoklu dokunuş)
  const s0 = await state(host);
  const p0 = myPos(s0);
  const kb = await host.page.locator('#game-haxball .hx-kick').boundingBox();
  const kick = [kb.x + kb.width / 2, kb.y + kb.height / 2];
  await touch(host, 'touchStart', [[160, 220]]);
  for (let dx = 10; dx <= 70; dx += 10) { await touch(host, 'touchMove', [[160 + dx, 220]]); await host.page.waitForTimeout(16); }
  await host.page.waitForTimeout(250);
  await touch(host, 'touchStart', [[230, 220], kick]);
  const held = await until(host, (s) => myPos(s)?.kick === 1, 3000);
  await host.page.waitForTimeout(250);
  await shot(host, '02-joystick-kick-held');
  await touch(host, 'touchEnd', [[230, 220]]); // ŞUT bırakıldı
  await host.page.waitForTimeout(200);
  await touch(host, 'touchEnd', []);
  const p1 = myPos(await until(host, (s) => { const m = myPos(s); return m && m.x > p0.x + 30; }, 3000));
  assert.ok(p1.x > p0.x + 30, `joystick ile sağa koşmalı (${p0.x} → ${p1.x})`);
  assert.equal(myPos(held).kick, 1);

  // Şut ve gol: test kancasıyla topu rakip kalenin önüne koy, ŞUT'a bas
  await host.page.evaluate(async () => {
    const { net } = await import('/net.js');
    net.action({ type: 'debugPlace', ball: { x: 300, y: 0 }, me: { x: 274, y: 0 } });
  });
  await until(host, (s) => s.view.phase === 'play' && Math.abs(s.frame.b[0] - 3000) < 50, 3000);
  await touch(host, 'touchStart', [kick]);
  await host.page.waitForTimeout(150);
  await touch(host, 'touchEnd', []);
  const goal = await until(guest, (s) => s.view.phase === 'goal', 4000);
  assert.deepEqual(goal.view.score, [1, 0]);
  assert.equal(goal.view.lastGoal.name, 'Ali');
  await guest.page.waitForSelector('#game-haxball .hx-banner.goal:has-text("GOL")');
  await shot(guest, '03-goal-guest');
  const fps = Number(await host.page.$eval('#game-haxball .hx', (e) => e.dataset.fps ?? 0));
  console.log(`# çizim hızı ${fps} fps`);
  assert.ok(fps >= 20, `çizim hızı ${fps} fps`);

  // Süre dolar → 1-0 Kırmızı kazanır
  for (const p of [host, guest, tall]) await until(p, (s) => s.view.phase === 'over', 45_000);
  await host.page.waitForSelector('#game-haxball .hx-end:not(.hidden)');
  await host.page.waitForSelector('text=Kırmızı kazandı');
  assert.match(await host.page.locator('#game-haxball .hx-goals').textContent(), /Ali/);
  assert.match(await host.page.locator('#game-haxball .hx-end').textContent(), /Takımın kazandı/);
  assert.match(await guest.page.locator('#game-haxball .hx-end').textContent(), /olmadı/);
  assert.ok(!(await host.page.locator('.hx-stage.live').count()), 'maç bitince sahne kapanmalı');
  await host.page.screenshot({ path: `${SHOTS}04-over-host.png`, fullPage: true });
  await tall.page.screenshot({ path: `${SHOTS}04-over-portrait.png`, fullPage: true });
  for (const p of [host, guest, tall]) await noHorizontalScroll(p, 'sonuç');

  await host.page.click('#game-haxball button:has-text("Bekleme odasına dön")');
  await guest.page.waitForSelector('#game-haxball .lobby-code');
  assert.equal(await guest.page.evaluate(() => document.body.classList.contains('hx-live')), false);
  for (const p of [host, guest, tall]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});

test('masaüstü: klavye ile koşu ve şut, odadan çıkınca sahne kapanır', async () => {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mk = async (ctx, name) => {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${srv.url}/#/multi/haxball`);
    await page.fill('input[placeholder="Takma adın"]', name);
    return { page, errors, name };
  };
  const a = await mk(ctxA, 'Can');
  const b = await mk(ctxB, 'Zeynep');
  await a.page.click('text=Yeni oda kur');
  const code = (await a.page.locator('#game-haxball .lobby-code').textContent()).trim();
  await b.page.fill('#game-haxball .code-input', code);
  await b.page.click('#game-haxball button:has-text("Katıl")');
  await a.page.waitForFunction(() => document.querySelectorAll('#game-haxball .player-list li').length === 2);
  await a.page.click('#game-haxball button:has-text("Oyunu başlat")'); // takım seçmeyenler dengelenir
  await a.page.waitForSelector('#game-haxball .hx-stage.live');
  const s0 = await until(a, (s) => s.frame && myPos(s));
  assert.ok(['red', 'blue'].includes(s0.view.myTeam));
  assert.notEqual((await until(b, (s) => s.view)).view.myTeam, s0.view.myTeam, 'iki takıma dengelenmeli');
  assert.ok(await a.page.locator('.hx-keys').isVisible(), 'klavye ipucu');
  assert.ok(!(await a.page.locator('.hx-kick').isVisible()), 'masaüstünde ŞUT tuşu gizli');
  await a.page.keyboard.down('KeyS');
  await a.page.keyboard.down('Space');
  const held = await until(a, (s) => myPos(s)?.kick === 1, 3000);
  await a.page.waitForTimeout(500);
  await a.page.keyboard.up('Space');
  await a.page.keyboard.up('KeyS');
  const s1 = await until(a, (s) => myPos(s).y > myPos(s0).y + 20, 3000);
  assert.ok(myPos(s1).y > myPos(s0).y + 20 && myPos(held).kick === 1);
  await a.page.screenshot({ path: `${SHOTS}05-desktop.png` });
  // Odadan çık: sahne kapanır, sayfa yine kaydırılabilir
  await a.page.click('.hx-hud button[aria-label="Maçtan çık"]');
  await a.page.waitForSelector('#game-haxball >> text=Yeni oda kur');
  assert.equal(await a.page.evaluate(() => document.body.classList.contains('hx-live')), false);
  // Kalan oyuncu tek kalınca hükmen kazanır
  await until(b, (s) => s.view?.phase === 'over' && s.view.result.reason === 'forfeit', 8000);
  await b.page.waitForSelector('text=Bir takım sahada kalmadı');
  for (const p of [a, b]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});
