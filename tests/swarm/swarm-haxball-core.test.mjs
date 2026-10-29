// ⚽ Tosun Top / gerçek zamanlı lobi çekirdeği — süreç içi sürü testi.
// Lobi bu süreçte çalışır: setInterval/clearInterval sayılır (döngü sızıntısı, çift döngü), adım istisnası
// sahte bir oyunla (haxball + 'boom' eylemi) tetiklenir, console.error sayılır. Kaynak kod değiştirilmez.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, sleep } from '../lib/bot.js';

Object.assign(process.env, {
  TEST_MODE: '1', TIME_SCALE: '0.1', TEST_GAMES: '1', SEED: '7', DATA_DIR: mkdtempSync(join(tmpdir(), 'tss-core-')),
  LIMIT_HTTP_PER_MIN: '100000', LIMIT_IDENTITIES_PER_HOUR: '100000', LIMIT_SOCKETS_PER_IP: '100000', LIMIT_ROOMS_PER_IP: '100000', LIMIT_LIVE_PER_IP: '100000',
});

// ---- interval muhasebesi (döngü aralığı ⌊1000/60⌋ = 16 ms) ----
const LOOP_MS = 16;
const live = new Set();
let created = 0;
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
globalThis.setInterval = function (fn, ms, ...rest) {
  const h = realSet(fn, ms, ...rest);
  if (ms === LOOP_MS) { live.add(h); created++; }
  return h;
};
globalThis.clearInterval = function (h) { live.delete(h); return realClear(h); };

const errLog = [];
const realErr = console.error;
console.error = (...a) => { errLog.push(a.map(String).join(' ')); };

let lobby; let GAMES; let haxball; let server; let wss; let wsUrl;
const all = [];

before(async () => {
  lobby = await import('../../server/lobby.js');
  ({ GAMES } = await import('../../server/games/index.js'));
  haxball = GAMES.haxball;
  // Sahte oyun: haxball ile aynı, ama 'boom' eylemi sonraki adımda istisna, 'end' eylemi maçı bitirir.
  GAMES.hxboom = {
    ...haxball,
    id: 'hxboom',
    realtime: {
      ...haxball.realtime,
      step(state, ctx) {
        if (state.boom) throw new Error('boom-step');
        return haxball.realtime.step(state, ctx);
      },
    },
    action(state, playerId, action, ctx) {
      if (action.type === 'boom') { state.boom = true; return; }
      if (action.type === 'end') { state.phase = 'over'; state.result = { winner: 'draw', reason: 'test' }; return; }
      return haxball.action(state, playerId, action, ctx);
    },
  };
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  wss = lobby.attachLobby(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
});

after(async () => {
  all.forEach((b) => b.close());
  wss.close();
  await new Promise((r) => server.close(r));
  console.error = realErr;
});

async function room(game, n, prefix) {
  const bots = [];
  for (let i = 0; i < n; i++) bots.push(await new Bot(wsUrl, `${prefix}${i + 1}`).connect());
  all.push(...bots);
  const code = await bots[0].create(game);
  for (const b of bots.slice(1)) await b.join(code);
  await Promise.all(bots.map((b) => b.waitRoom((r) => r.players.length === n)));
  bots.forEach((b, i) => b.send({ t: 'lobbyAction', data: { type: 'team', team: i % 2 ? 'blue' : 'red' } }));
  await bots[0].waitRoom((r) => bots.every((b, i) => r.prep?.teams?.[b.playerId] === (i % 2 ? 'blue' : 'red')));
  return { bots, host: bots[0], code };
}

async function start(g) {
  g.host.send({ t: 'start' });
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'kickoff' || v.phase === 'play', { timeout: 5000 })));
  await Promise.all(g.bots.map((b) => b.waitFrame(() => true, { timeout: 3000 })));
}

const loops = () => lobby.stats().loops;

test('çekirdek: start → bitir → backToLobby ×10 — tek interval, sızıntı yok, lobide kare yok, rematch kareleri sıfırdan', async () => {
  const g = await room('hxboom', 2, 'Cyc');
  const c0 = created;
  for (let i = 0; i < 10; i++) {
    // Başlat spam'i: sadece biri başarılı olmalı
    for (let j = 0; j < (i === 0 ? 5 : 1); j++) g.host.send({ t: 'start' });
    await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'kickoff', { timeout: 5000 })));
    const first = await g.bots[1].waitFrame((f) => f.s >= 1);
    assert.ok(first.k <= 6, `rematch ${i}: ilk kare eski maçtan değil (k=${first.k}, s=${first.s})`);
    assert.equal(first.v, 1);
    assert.equal(live.size, 1, `rematch ${i}: tek döngü intervali olmalı (${live.size})`);
    assert.equal(loops(), 1);
    await sleep(450); // genel hız sınırı (30 / 5 sn) aşılmasın
    const v = g.host.view;
    g.host.action({ type: 'end' });
    await g.host.waitView((x) => x.phase === 'over' && x !== v);
    assert.equal(live.size, 0, `rematch ${i}: maç bitince interval kalmamalı`);
    assert.equal(loops(), 0);
    g.host.send({ t: 'backToLobby' });
    await g.host.waitRoom((r) => r.phase === 'lobby');
    const fc = g.bots.map((b) => b.frameCount);
    await sleep(150);
    assert.deepEqual(g.bots.map((b) => b.frameCount), fc, 'lobide/over sonrası kare gelmemeli');
    g.bots.forEach((b) => { b.frame = null; });
  }
  assert.equal(created - c0, 10, `10 maç için tam 10 interval kurulmalı (kurulan: ${created - c0})`);
  g.bots.forEach((b) => b.leave());
});

test('çekirdek: oda maç ortasında silinir / herkes kopar / host ayrılır — interval sayısı doğru', async () => {
  const a = await room('haxball', 2, 'Del');
  await start(a);
  const b = await room('haxball', 3, 'Hst');
  await start(b);
  assert.equal(live.size, 2);
  // a: herkes ayrılır → oda silinir
  a.bots.forEach((x) => x.leave());
  await sleep(80);
  assert.equal(live.size, 1, 'silinen odanın intervali durmalı');
  // b: host ayrılır (2 kişi kalır, aynı takımda değilse sürer) — döngü tek kalmalı
  b.host.leave();
  await b.bots[1].waitRoom((r) => r.players.length === 2);
  await sleep(80);
  assert.equal(live.size, 1);
  assert.equal(loops(), 1);
  // b: kalanlar kopar (drop) → diskler donuk bekler; yer tutma süresi (120 sn × 0.1 = 12 sn) dolunca
  // oyuncular odadan çıkar → oda silinir → döngü durur
  b.bots.slice(1).forEach((x) => x.drop());
  await sleep(5500);
  assert.equal(live.size, 1, 'kısa kopmada maç sürmeli (diskler 20 sn donuk bekler)');
  await sleep(7200);
  assert.equal(live.size, 0, 'yer tutma süresi dolunca döngü durmalı');
  assert.equal(loops(), 0);
});

test('çekirdek: step istisnası — döngü durur, bir kez loglanır; oda kilitli kalmamalı', async () => {
  const g = await room('hxboom', 3, 'Boom');
  // 3. bot kırmızıda (sıra: red, blue, red)
  await start(g);
  const before = errLog.filter((l) => l.includes('boom-step')).length;
  g.host.action({ type: 'boom' });
  await sleep(200);
  assert.equal(live.size, 0, 'istisnadan sonra interval durmalı');
  assert.equal(errLog.filter((l) => l.includes('boom-step')).length - before, 1, 'istisna bir kez loglanmalı');
  // Başka bir değişiklik (oyuncu ayrılır → afterChange) döngüyü tekrar başlatıp aynı hatayı yeniden basmamalı
  g.bots[2].leave();
  await g.host.waitRoom((r) => r.players.length === 2);
  await sleep(200);
  const logged = errLog.filter((l) => l.includes('boom-step')).length - before;
  const liveAfter = live.size;
  // Host odayı kurtarabilmeli (lobiye dönüş) — yoksa oda sonsuza dek 'playing' kalır
  const p = g.host.waitFor((m) => (m.t === 'room' && m.room?.phase === 'lobby') || m.t === 'error');
  g.host.send({ t: 'backToLobby' });
  const res = await p;
  assert.deepEqual(
    { logged, liveAfter, recover: res.t === 'room' ? 'lobby' : `error: ${res.message}` },
    { logged: 1, liveAfter: 0, recover: 'lobby' },
  );
});

test('çekirdek: çok oda aynı anda başlar/biter — interval sayısı = oynayan oda sayısı', async () => {
  const games = [];
  for (let i = 0; i < 5; i++) games.push(await room('hxboom', 2, `M${i}`));
  await Promise.all(games.map(start));
  assert.equal(live.size, 5);
  assert.equal(loops(), 5);
  games[0].host.action({ type: 'end' });
  games[1].bots.forEach((b) => b.leave());
  games[2].bots[1].leave(); // hükmen
  await games[0].host.waitView((v) => v.phase === 'over');
  await games[2].host.waitView((v) => v.phase === 'over');
  await sleep(80);
  assert.equal(live.size, 2);
  assert.equal(loops(), 2);
  games.forEach((g) => g.bots.forEach((b) => b.leave()));
  await sleep(80);
  assert.equal(live.size, 0);
  assert.equal(loops(), 0);
});
