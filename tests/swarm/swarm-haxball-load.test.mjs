// ⚽ Tosun Top yük sürüsü: hiç okumayan istemci (diğerleri 30 kare/sn almaya devam eder, sunucu belleği şişmez),
// 6 oda × 8 bot işlemci + ping gecikmesi + kare hızı, yük altında döngü sayısı.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { setupMatch, startBrain, stats, sleep } from './haxball-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 1 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });
const track = (g) => { all.push(...g.bots); return g; };

const rate = (bots, c0, ms) => bots.map((b, i) => ((b.frameCount - c0[i]) * 1000) / ms);

test('hiç okumayan istemci (10 sn): diğer 7 oyuncu ≥ 27 kare/sn, sunucu belleği sınırlı, tıkalı sokete kare atlanır', async () => {
  const g = track(await setupMatch(srv.wsUrl, 8, { prefix: 'Slow', settings: { minutes: 5, goals: 0 } }));
  const [slow, ...rest] = g.bots;
  const stops = rest.map((b) => startBrain(b));
  await sleep(300);
  const s0 = await stats(srv.url);
  slow.ws._socket.pause();
  const c0 = rest.map((b) => b.frameCount);
  const t0 = Date.now();
  const mins = [];
  for (let i = 0; i < 10; i++) {
    const ci = rest.map((b) => b.frameCount);
    await sleep(1000);
    mins.push(Math.min(...rate(rest, ci, 1000)));
  }
  const wall = Date.now() - t0;
  const s1 = await stats(srv.url);
  const r = rate(rest, c0, wall);
  console.log(`# yavaş istemci: diğerleri en düşük ${Math.min(...r).toFixed(1)} kare/sn (saniyelik en düşük ${Math.min(...mins).toFixed(0)}), rss ${(s0.rss / 1e6).toFixed(0)} → ${(s1.rss / 1e6).toFixed(0)} MB`);
  assert.ok(Math.min(...r) >= 27, `diğerlerinin kare hızı ${Math.min(...r).toFixed(1)}`);
  assert.ok(s1.rss - s0.rss < 60e6, 'tıkalı soket için sunucu belleği şişmemeli');
  slow.ws._socket.resume();
  // Okumaya dönünce (heartbeat 15 sn'de bir; 10 sn tıkalı kalan henüz atılmamış olabilir) kare almaya devam eder ya da temizce kapanır
  await sleep(1500);
  const n = slow.frameCount;
  await sleep(500);
  assert.ok(!slow.isOpen || slow.frameCount > n, 'açık kaldıysa kare almalı');
  stops.forEach((s) => s());
  g.bots.forEach((b) => b.leave());
});

test('6 oda × 8 bot (girdi 20 Hz): işlemci payı, kare hızı ≥ 27/sn, ping RTT, döngü = 6', async () => {
  const games = [];
  for (let i = 0; i < 6; i++) games.push(track(await setupMatch(srv.wsUrl, 8, { prefix: `L${i}`, settings: { minutes: 5, goals: 0 } })));
  assert.equal((await stats(srv.url)).loops, 6);
  const bots = games.flatMap((g) => g.bots);
  const stops = bots.map((b) => startBrain(b));
  const rtts = [];
  for (const b of bots) b.taps.push((m) => { if (m.t === 'pong') rtts.push(Date.now() - m.c); });
  const pinger = setInterval(() => bots.forEach((b) => b.sendRaw({ t: 'ping', c: Date.now() })), 500);
  await sleep(800);
  const s0 = await stats(srv.url);
  const c0 = bots.map((b) => b.frameCount);
  const t0 = Date.now();
  await sleep(6000);
  const s1 = await stats(srv.url);
  const wall = Date.now() - t0;
  clearInterval(pinger);
  stops.forEach((s) => s());
  const cpuMs = (s1.cpu.user - s0.cpu.user + s1.cpu.system - s0.cpu.system) / 1000;
  const r = rate(bots, c0, wall);
  rtts.sort((a, b) => a - b);
  const p50 = rtts[Math.floor(rtts.length / 2)];
  const p99 = rtts[Math.floor(rtts.length * 0.99)];
  console.log(`# 6×8: sunucu işlemci %${((cpuMs / wall) * 100).toFixed(1)}, kare hızı en düşük ${Math.min(...r).toFixed(1)}/sn, ping RTT p50 ${p50} ms p99 ${p99} ms (${rtts.length} örnek), rss ${(s1.rss / 1e6).toFixed(0)} MB`);
  assert.ok(cpuMs / wall < 0.5, 'sunucu işlemci payı');
  assert.ok(Math.min(...r) >= 27, `kare hızı ${Math.min(...r).toFixed(1)}`);
  assert.ok(p99 < 100, `ping p99 ${p99} ms`);
  assert.ok(bots.every((b) => b.isOpen));
  bots.forEach((b) => b.leave());
  await sleep(150);
  const s2 = await stats(srv.url);
  assert.equal(s2.loops, 0);
  assert.equal(s2.rooms, 0);
});
