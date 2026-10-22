// QA: 4 telefon (1 masaüstü host + 3 mobil) Casus Kim?'i baştan sona oynar:
// başarılı suçlama, başarısız suçlama (Hayır), casusun yanlış/doğru tahmini, süre dolunca zorunlu oylama,
// final skor tablosu, bekleme odasına dönüş, tekrar oynama. Ekran görüntüleri: test-results/qa/game-*.png
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, phone, state, waitNet, shot, createRoom, joinCode, startGame, setSetting, roles, realErrors, overflow, smallButtons,
} from './qa-lib.mjs';

let env;
before(async () => { env = await setup({ timeScale: 0.1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

async function revealCard(p) {
  await p.page.click('.role-card');
  await p.page.waitForSelector('.role-card:not(.hidden-card)');
}

async function accuse(p, target) {
  await p.page.locator('.player-list li', { hasText: target.name }).locator('button:has-text("Suçla")').click();
}

async function vote(p, yes) {
  await p.page.click(yes ? 'button:has-text("Evet, casus")' : 'button:has-text("Hayır")');
}

async function guess(spy, locName) {
  await spy.page.click('button:has-text("Mekânı tahmin et")');
  await spy.page.locator('.loc', { hasText: locName }).first().click();
}

async function next(host) {
  await host.page.locator('button:has-text("Sonraki tur"), button:has-text("Sonuçları göster")').click();
}

async function allPhase(players, pred, timeout) {
  for (const p of players) await waitNet(p.page, pred, timeout);
}

const scores = async (p) => Object.fromEntries((await state(p.page)).view.players.map((x) => [x.name, x.score]));

test('tam oyun: 3 tur + tekrar oyna', async () => {
  const host = await phone(env, 'Deniz', { desktop: true });
  const ali = await phone(env, 'Ali');
  const ayse = await phone(env, 'Ayşe');
  const mert = await phone(env, 'Mert');
  const all = [host, ali, ayse, mert];

  await shot(ali, 'game-00-entry-mobile');
  const code = await createRoom(host);
  for (const p of [ali, ayse, mert]) await joinCode(p, code);
  await host.page.waitForFunction(() => document.querySelectorAll('#game-spyfall .player-list li').length === 4);
  await setSetting(host, 'Tur süresi', 3);
  await waitNet(ali.page, 'room.settings.minutes === 3');
  await shot(host, 'game-01-waiting-host-desktop');
  await shot(ali, 'game-01-waiting-guest-mobile');
  soft((await overflow(ali.page)).scrollW <= 360, `bekleme odası 360px taşma: ${JSON.stringify(await overflow(ali.page))}`);
  console.log('küçük butonlar (bekleme, host masaüstü):', JSON.stringify(await smallButtons(host.page)));

  // ---------- Tur 1: başarılı suçlama ----------
  await startGame(host, all);
  let { spy, town } = await roles(all);
  assert.equal(spy.length, 1);
  for (const p of all) await shot(p, `game-10-r1-hidden-${p.name}`);
  for (const p of all) { await revealCard(p); await shot(p, `game-11-r1-card-${p.name}`); }
  soft((await overflow(ali.page)).scrollW <= 360, 'oyun ekranı 360px taşma');
  console.log('küçük butonlar (oyun, mobil):', JSON.stringify(await smallButtons(ali.page)));

  // Gizli bilgi: casusun aldığı ham WS çerçevelerinde mekân yok; diğerlerinin çerçevelerinde casus kimliği yok
  const townView = (await state(town[0].page)).view;
  const loc = townView.me.location;
  const spyFrames = spy[0].frames.join('\n');
  soft(!spyFrames.includes(`"${loc.id}"`) || !/"locationId"|"location":\{/.test(spyFrames), 'casus çerçevesinde mekân izi');
  soft(!spyFrames.includes('"role"'), 'casus çerçevesinde role alanı');
  const spyId = (await state(spy[0].page)).playerId;
  for (const t of town) soft(!t.frames.join('\n').includes('spyIds'), `${t.name} çerçevesinde spyIds (reveal öncesi)`);
  void spyId;

  const accuser = town[0];
  await accuse(accuser, spy[0]);
  await allPhase(all, "view.phase === 'accuse'");
  for (const p of all) await shot(p, `game-12-r1-accuse-${p.name}`);
  for (const p of town.slice(1)) await vote(p, true);
  await allPhase(all, "view.phase === 'reveal'");
  for (const p of all) await shot(p, `game-13-r1-reveal-${p.name}`);
  let v = (await state(host.page)).view;
  soft(v.result.winner === 'town' && v.result.reason === 'caught', `tur1 sonuç ${v.result.winner}/${v.result.reason}`);
  let s = await scores(host);
  soft(s[accuser.name] === 2 && town.every((t) => t === accuser || s[t.name] === 1) && s[spy[0].name] === 0, `tur1 puanlar ${JSON.stringify(s)}`);
  await next(host);

  // ---------- Tur 2: Hayır ile başarısız suçlama → saat devam; sonra casus yanlış tahmin ----------
  await allPhase(all, "view.round === 2 && view.phase === 'play'");
  ({ spy, town } = await roles(all));
  for (const p of all) await revealCard(p);
  const endsBefore = (await state(host.page)).view.endsAt;
  await accuse(town[0], town[1]);
  await allPhase(all, "view.phase === 'accuse'");
  await vote(town[2] ?? spy[0], false);
  await allPhase(all, "view.phase === 'play'");
  const after = (await state(host.page)).view;
  soft(after.canAccuse !== undefined, 'canAccuse alanı');
  soft(Math.abs(after.endsAt - endsBefore) < 3000, `suçlama sonrası saat makul devam etmeli (fark ${after.endsAt - endsBefore} ms)`);
  await shot(town[0], 'game-20-r2-after-failed-accuse-accuser');
  soft(!(await town[0].page.locator('button:has-text("Suçla")').count()), 'suçlayan tekrar suçlayabiliyor');
  soft(await town[0].page.locator('text=Bu turdaki suçlama hakkını kullandın').count() > 0, 'hak kullanıldı ipucu yok');
  await shot(spy[0], 'game-21-r2-spy-before-guess');
  await spy[0].page.click('button:has-text("Mekânı tahmin et")');
  await shot(spy[0], 'game-22-r2-spy-guess-open');
  const real = (await state(town[0].page)).view.me.location;
  const wrong = (await state(spy[0].page)).view.locations.find((l) => l.id !== real.id);
  await spy[0].page.locator('.loc', { hasText: wrong.name }).first().click();
  await allPhase(all, "view.phase === 'reveal'");
  for (const p of [spy[0], town[0]]) await shot(p, `game-23-r2-badguess-${p === spy[0] ? 'spy' : 'town'}`);
  v = (await state(host.page)).view;
  soft(v.result.reason === 'bad_guess' && v.result.winner === 'town', `tur2 sonuç ${v.result.reason}`);
  const s2 = await scores(host);
  soft(town.every((t) => s2[t.name] === s[t.name] + 1) && s2[spy[0].name] === s[spy[0].name], `tur2 puanlar ${JSON.stringify(s)} -> ${JSON.stringify(s2)}`);
  s = s2;
  await next(host);

  // ---------- Tur 3: casus doğru tahmin ----------
  await allPhase(all, "view.round === 3 && view.phase === 'play'");
  ({ spy, town } = await roles(all));
  const real3 = (await state(town[0].page)).view.me.location;
  await guess(spy[0], real3.name);
  await allPhase(all, "view.phase === 'reveal'");
  await shot(spy[0], 'game-30-r3-goodguess-spy');
  await shot(host, 'game-30-r3-goodguess-host');
  const s3 = await scores(host);
  soft(s3[spy[0].name] === s[spy[0].name] + 4 && town.every((t) => s3[t.name] === s[t.name]), `tur3 puanlar ${JSON.stringify(s3)}`);
  soft(await host.page.locator('button:has-text("Sonuçları göster")').count() === 1, 'son turda "Sonuçları göster" yok');
  await next(host);

  // ---------- Final skor ----------
  await allPhase(all, "room.phase === 'over'");
  for (const p of all) await shot(p, `game-40-over-${p.name}`);
  soft(await ali.page.locator('text=Oda sahibinin yeni oyunu').count() === 1, 'misafirde bekleme mesajı yok');
  await host.page.click('button:has-text("Bekleme odasına dön")');
  await allPhase(all, "room.phase === 'lobby' && !view");
  await shot(ali, 'game-41-back-in-lobby');

  // ---------- Oyun 2: 1 tur, süre dolar → zorunlu oylama (çoğunluk casusta) ----------
  await setSetting(host, 'Tur sayısı', 1);
  await waitNet(ali.page, 'room.settings.rounds === 1');
  await startGame(host, all);
  ({ spy, town } = await roles(all));
  for (const p of all) await revealCard(p);
  await allPhase(all, "view.phase === 'final'", 40000);
  await shot(town[0], "game-50-final-vote-town"); await shot(spy[0], "game-50-final-vote-spy");
  for (const t of town) await t.page.locator('.player-list li', { hasText: spy[0].name }).locator('button').click();
  await spy[0].page.locator('.player-list li', { hasText: town[0].name }).locator('button').click();
  await allPhase(all, "view.phase === 'reveal'");
  await shot(host, 'game-51-final-caught-reveal-host');
  v = (await state(host.page)).view;
  soft(v.result?.reason === 'final_caught', `oyun2 sonuç ${v.result?.reason}`);
  await next(host);
  await allPhase(all, "room.phase === 'over'");
  await host.page.click('button:has-text("Bekleme odasına dön")');
  await allPhase(all, "room.phase === 'lobby'");

  // ---------- Oyun 3: tekrar oyna (yine 1 tur) — kart gizli başlamalı ----------
  await startGame(host, all);
  for (const p of all) {
    const hidden = await p.page.locator('.role-card.hidden-card').count();
    soft(hidden === 1, `oyun3 başında ${p.name} rol kartı gizli değil (önceki oyundan açık kaldı)`);
  }
  await shot(ali, 'game-60-replay-start-ali');
  // Eşitlik: süre dolar, herkes farklı kişiye oy verir
  await allPhase(all, "view.phase === 'final'", 40000);
  const order = all;
  for (let i = 0; i < order.length; i++) {
    const target = order[(i + 1) % order.length];
    await order[i].page.locator('.player-list li', { hasText: target.name }).locator('button').click();
  }
  await allPhase(all, "view.phase === 'reveal'");
  v = (await state(host.page)).view;
  soft(v.result?.reason === 'tie' && v.result.winner === 'spy', `oyun3 eşitlik sonucu ${v.result?.reason}`);
  await shot(ali, 'game-61-tie-over-ali');

  for (const p of all) soft(realErrors(p).length === 0, `${p.name} konsol: ${realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  assert.deepEqual(issues, []);
});
