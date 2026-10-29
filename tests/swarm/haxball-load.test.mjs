// ⚽ Tosun Top yük ve sızıntı testleri: paralel odalar birbirine karışmaz, döngü maç bitince/oda silinince durur,
// 4 oda × 8 oyuncu sunucuda gerçek zamandan çok daha az işlemci harcar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { setupMatch, startBrain, frameChecker, stats, sleep } from './haxball-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.1 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });
const track = (g) => { all.push(...g.bots); return g; };

test('döngü: maç bitince ve oda silinince durur (açık interval kalmaz)', async () => {
  assert.equal((await stats(srv.url)).loops, 0);
  // 1) Oda silinir (herkes çıkar) — maç sürerken
  const g1 = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Sil' }));
  assert.equal((await stats(srv.url)).loops, 1);
  g1.bots.forEach((b) => b.leave());
  await sleep(100);
  let s = await stats(srv.url);
  assert.equal(s.loops, 0, 'oda silinince döngü durmalı');
  const n = g1.bots[0].frameCount;
  await sleep(200);
  assert.equal(g1.bots[0].frameCount, n);
  // 2) Maç biter (hükmen: bir takım ayrılır), oda yaşamaya devam eder
  const g2 = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Bit' }));
  assert.equal((await stats(srv.url)).loops, 1);
  g2.bots[1].leave();
  await g2.host.waitView((v) => v.phase === 'over');
  s = await stats(srv.url);
  assert.equal(s.loops, 0, 'maç bitince döngü durmalı');
  assert.ok(s.rooms >= 1);
  // 3) Herkesin bağlantısı koparsa: 5 sn sonra diskler kalkar → maç biter → döngü durur
  const g3 = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Kop' }));
  assert.equal((await stats(srv.url)).loops, 1);
  g3.bots.forEach((b) => b.drop());
  await sleep(5600);
  assert.equal((await stats(srv.url)).loops, 0, 'herkes kopunca döngü durmalı');
  // 4) Lobiye dön → yeni maç → yine tek döngü
  g2.host.send({ t: 'backToLobby' });
  await g2.host.waitRoom((r) => r.phase === 'lobby');
  assert.equal((await stats(srv.url)).loops, 0);
  g2.host.leave();
});

test('paralel odalar: 3 oda aynı anda oynar, kareler karışmaz', async () => {
  const games = [];
  for (let i = 0; i < 3; i++) games.push(track(await setupMatch(srv.wsUrl, 2 + i * 2, { prefix: `P${i}`, settings: { minutes: 2, goals: 3 } })));
  assert.equal((await stats(srv.url)).loops, 3);
  const errors = [];
  for (const g of games) {
    for (const b of g.bots) {
      frameChecker(b, errors);
      b.taps.push((m) => {
        if (m.t === 'frame' && b.view && m.v === b.view.ver && m.p.length !== b.view.discs.length * 2) errors.push(`${b.name}: başka odanın karesi?`);
      });
    }
  }
  const stops = games.flatMap((g) => g.bots.map((b) => startBrain(b)));
  await sleep(4000);
  stops.forEach((s) => s());
  assert.deepEqual(errors, []);
  for (const g of games) {
    const codes = new Set(g.bots.map((b) => b.room.code));
    assert.equal(codes.size, 1);
    for (const b of g.bots) assert.equal(b.frame.p.length, g.bots.length * 2);
  }
  games.forEach((g) => g.bots.forEach((b) => b.leave()));
  await sleep(100);
  assert.equal((await stats(srv.url)).loops, 0);
});

test('işlemci: 4 oda × 8 oyuncu (girdi 20 Hz) sunucuda gerçek zamanın çok altında', async () => {
  const games = [];
  for (let i = 0; i < 4; i++) games.push(track(await setupMatch(srv.wsUrl, 8, { prefix: `C${i}`, settings: { minutes: 5, goals: 0 } })));
  const stops = games.flatMap((g) => g.bots.map((b) => startBrain(b)));
  await sleep(500);
  const s0 = await stats(srv.url);
  const counts0 = games.flatMap((g) => g.bots.map((b) => b.frameCount));
  const t0 = Date.now();
  await sleep(5000);
  const s1 = await stats(srv.url);
  const wall = Date.now() - t0;
  stops.forEach((s) => s());
  const cpuMs = (s1.cpu.user - s0.cpu.user + s1.cpu.system - s0.cpu.system) / 1000;
  const frac = cpuMs / wall;
  const rates = games.flatMap((g) => g.bots.map((b) => b.frameCount)).map((c, i) => ((c - counts0[i]) * 1000) / wall);
  const minRate = Math.min(...rates);
  console.log(`# 4×8 oyuncu: sunucu işlemci ${cpuMs.toFixed(0)} ms / ${wall} ms duvar (%${(frac * 100).toFixed(1)}), en düşük kare hızı ${minRate.toFixed(1)}/sn, rss ${(s1.rss / 1e6).toFixed(0)} MB`);
  assert.ok(frac < 0.5, `sunucu işlemci payı %${(frac * 100).toFixed(1)}`);
  assert.ok(minRate > 22, `en düşük kare hızı ${minRate.toFixed(1)}/sn`);
  for (const g of games) for (const b of g.bots) assert.ok(b.frameMaxBytes < 1024);
  games.forEach((g) => g.bots.forEach((b) => b.leave()));
  await sleep(100);
  assert.equal((await stats(srv.url)).loops, 0);
});
