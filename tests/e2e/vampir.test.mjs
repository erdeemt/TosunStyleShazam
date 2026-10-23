// Tarayıcı testi: 5 telefon Vampir Köylü oynar — gece görevi, sabah duyurusu, aday/destek/savunma/oylama, oyun sonu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/vampir/', import.meta.url));
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
  page.on('dialog', (d) => d.accept());
  await page.goto(`${srv.url}/#/multi/vampir`);
  await page.fill('input[placeholder="Takma adın"]', name);
  return { page, errors, name };
}

// Uygulama içi durumu oku (net modülü; CSP'ye takılmayan import).
const state = (p) => p.page.evaluate(async () => {
  const { net } = await import('/net.js');
  return { view: net.view, room: net.room, me: net.playerId };
});
const until = async (p, pred, timeout = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await state(p);
    if (s.view && pred(s.view, s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`${p.name}: koşul sağlanmadı`);
    await p.page.waitForTimeout(100);
  }
};
const shot = (p, name) => p.page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

test('5 telefon: gece → sabah → yargılama → asma → oyun sonu', async () => {
  const phones = await Promise.all(['Ali', 'Ayşe', 'Mert', 'Zeynep', 'Can'].map(phone));
  const [host] = phones;
  await host.page.click('text=Yeni oda kur');
  const code = (await host.page.locator('.lobby-code').textContent()).trim();
  for (const p of phones.slice(1)) {
    await p.page.fill('.code-input', code);
    await p.page.click('button:has-text("Katıl")');
  }
  await host.page.waitForFunction(() => document.querySelectorAll('#game-vampir .player-list li').length === 5);
  // Hızlı test: tartışma ve gece en kısa, deli kapalı
  await host.page.locator('#game-vampir label', { hasText: 'Deli' }).locator('input').uncheck();
  await host.page.waitForTimeout(200);
  await shot(host, '00-lobby');
  await host.page.click('#game-vampir button:has-text("Oyunu başlat")');

  // Gece 1: herkes kartını açar; ekran yapısı herkes için aynı olmalı (aynı sayıda hedef düğmesi)
  const infos = [];
  for (const p of phones) {
    await p.page.waitForSelector('.role-card.hidden-card');
    const hiddenText = await p.page.locator('#game-vampir').textContent();
    assert.ok(!/Vampir değil|Kurbanını seç|kimi koruyorsun|içini göreceksin/.test(hiddenText), `${p.name}: kart kapalıyken rol ipucu görünüyor`);
    await p.page.click('.role-card');
    const s = await state(p);
    infos.push({ p, role: s.view.me.role, id: s.me, buttons: await p.page.locator('.target').count() });
    await shot(p, `01-night-${p.name}-${s.view.me.role}`);
  }
  assert.equal(new Set(infos.map((i) => i.buttons)).size, 1, 'gece ekranında herkes aynı sayıda düğme görmeli');
  const vamp = infos.find((i) => i.role === 'vampir');
  const doc = infos.find((i) => i.role === 'doktor');
  const victim = infos.find((i) => i.role === 'koylu' || i.role === 'gozcu');
  const victimName = victim.p.name;

  for (const i of infos) {
    const s = await state(i.p);
    let targetId = s.view.me.nightTargets[0];
    if (i === vamp) targetId = victim.id;
    if (i === doc) targetId = s.view.me.nightTargets.find((id) => id !== victim.id);
    const name = s.view.players.find((x) => x.id === targetId).name;
    await i.p.page.locator('.target', { hasText: name }).first().click();
  }

  // Sabah: kurban duyurulur, rol yazmaz
  for (const p of phones) await until(p, (v) => v.phase === 'day');
  const morning = await host.page.locator('.announce').textContent();
  assert.match(morning, new RegExp(`${victimName}.*öldü`));
  assert.ok(!/Vampir|Köylü|Doktor|Gözcü/.test(morning), 'duyuruda rol olmamalı');
  await shot(victim.p, '02-day-dead-victim');
  await shot(host, '02-day-host');

  // Gündüz: köylü tarafından biri vampiri aday gösterir, başkası destekler
  const alive = infos.filter((i) => i !== victim);
  const [nominator, supporter] = alive.filter((i) => i !== vamp);
  await nominator.p.page.locator('#game-vampir .player-list li', { hasText: vamp.p.name }).locator('button:has-text("Aday göster")').click();
  await supporter.p.page.waitForSelector('button:has-text("Destekliyorum")');
  await shot(supporter.p, '03-nomination');
  await supporter.p.page.click('button:has-text("Destekliyorum")');
  await vamp.p.page.waitForSelector('button:has-text("Savunmam bitti")');
  await shot(vamp.p, '04-defense-accused');
  await vamp.p.page.click('button:has-text("Savunmam bitti")');

  for (const i of alive.filter((x) => x !== vamp)) {
    await i.p.page.waitForSelector('button:has-text("Evet, asılsın")');
    await i.p.page.click('button:has-text("Evet, asılsın")');
  }
  // 5 kişide 1 vampir: vampir asılınca köy kazanır
  const end = await until(host, (v) => v.phase === 'over');
  assert.equal(end.view.result.winner, 'town');
  await host.page.waitForSelector('text=Köy kazandı');
  await shot(host, '05-over-host');
  await shot(vamp.p, '05-over-vampire');

  for (const p of phones) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});
