// Tarayıcı testi: tek telefon + 🤖 botlarla 🧛 Vampir (PLAN.md §3.8). Host bekleme odasında 4 bot ekler, birini
// çıkarıp yenisini ekler, oyunu başlatır; gece kendi seçimini yapar, botlar da seçince sabah olur. 3D sahne botları
// diğer oyuncular gibi çizer (sahne tarifi). Ekran görüntüleri test-results/vampir-bots/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, phone, nightClick, state, waitNet, realErrors } from './qa-vampir-lib.mjs';

const SHOTS = fileURLToPath(new URL('../../test-results/vampir-bots/', import.meta.url));
let env;
before(async () => { mkdirSync(SHOTS, { recursive: true }); env = await setup({ timeScale: 0.25 }); });
after(async () => { await env?.close(); });

test('tek telefon 4 bot ekler, Vampir başlar, bir gece geçer', async () => {
  const p = await phone(env, 'Erdem');
  const page = p.page;
  await page.click('text=Yeni oda kur');
  await page.waitForSelector('.lobby-code');
  const addBot = page.locator('#game-vampir button.add-bot');
  assert.equal(await addBot.textContent(), '🤖 Bot ekle');
  for (let i = 1; i <= 4; i++) {
    await addBot.click();
    await waitNet(page, `room && room.players.length === ${i + 1}`);
  }
  // Bir botu çıkar, yenisini ekle
  const firstBot = (await state(page)).room.players.find((x) => x.bot);
  await page.click(`#game-vampir [data-remove-bot="${firstBot.id}"]`);
  await waitNet(page, `room && room.players.length === 4 && !room.players.some((x) => x.id === ${JSON.stringify(firstBot.id)})`);
  await addBot.click();
  await waitNet(page, 'room && room.players.length === 5');
  const names = await page.locator('#game-vampir .player-list .player-name').allTextContents();
  assert.equal(names.filter((n) => n.startsWith('🤖 Bot ')).length, 4, names.join(', '));
  assert.equal(await page.locator('#game-vampir .player-list .tag', { hasText: '📴' }).count(), 0);
  await page.screenshot({ path: `${SHOTS}waiting.png`, fullPage: true });

  await page.click('#game-vampir button:has-text("Oyunu başlat")');
  await waitNet(page, "room && room.phase === 'playing' && view && view.phase === 'night'");
  const s = await state(page);
  assert.equal(s.view.players.length, 5);
  for (const x of s.view.players) assert.ok(!('role' in x));
  const botIds = s.room.players.filter((x) => x.bot).map((x) => x.id);

  // 3D sahne (veya yedek yol) botları da karakter olarak çizer
  await page.waitForSelector('#game-vampir .v3d[data-ready="webgl"], #game-vampir .v3d[data-ready="fallback"]', { timeout: 20000 });
  const desc = JSON.parse(await page.locator('#game-vampir .v3d').getAttribute('data-state'));
  assert.deepEqual(desc.chars.map((c) => c.id).sort(), s.view.players.map((x) => x.id).sort());
  for (const id of botIds) assert.ok(desc.chars.some((c) => c.id === id));

  // Kendi gece seçimi: izin verilen ilk hedef
  const target = s.view.me.nightTargets.find((id) => id !== s.playerId) ?? s.view.me.nightTargets[0];
  const targetName = s.view.players.find((x) => x.id === target).name;
  await nightClick(p, targetName);
  // Botlar 2–8 sn (×0.25) içinde seçer; herkes seçince gece biter
  await waitNet(page, "view && view.phase !== 'night'", 20000);
  const after = await state(page);
  assert.ok(['day', 'over'].includes(after.view.phase), after.view.phase);
  assert.equal(after.view.night, 1);
  await page.screenshot({ path: `${SHOTS}day.png`, fullPage: true });
  assert.deepEqual(realErrors(p), []);
});
