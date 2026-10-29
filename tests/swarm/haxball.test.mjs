// ⚽ Tosun Top sürü testleri: gerçek zamanlı döngü, kareler, girdi doğrulama, kopma/yeniden bağlanma, izleyici, host ayrılması.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';
import { Bot } from '../lib/bot.js';
import { setupMatch, startBrain, myDisc, frameChecker, sleep } from './haxball-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.1 }); }); // 2 dk maç ≈ 12 sn (fizik gerçek zamanlı)
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });
const track = (g) => { all.push(...g.bots); return g; };

async function playToEnd(g, { timeout = 60_000 } = {}) {
  const stops = g.bots.map((b) => startBrain(b));
  try {
    await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'over', { timeout })));
  } finally { stops.forEach((s) => s()); }
  return g.host.view;
}

test('lobi: takım seçimi, karıştırma; tek takımla başlamaz', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { teams: ['red', 'red', 'red'], start: false }));
  const err = g.host.waitFor((m) => m.t === 'error');
  g.host.send({ t: 'start' });
  assert.match((await err).message, /İki takımda/);
  assert.equal(g.host.room.phase, 'lobby');
  // Host olmayan karıştıramaz
  const e2 = g.bots[1].waitFor((m) => m.t === 'error');
  g.bots[1].send({ t: 'lobbyAction', data: { type: 'shuffle' } });
  assert.match((await e2).message, /oda sahibi/);
  g.host.send({ t: 'lobbyAction', data: { type: 'shuffle' } });
  const r = await g.host.waitRoom((x) => new Set(Object.values(x.prep.teams)).size === 2);
  const counts = Object.values(r.prep.teams).reduce((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {});
  assert.ok(counts.red >= 1 && counts.blue >= 1);
  // Bozuk lobbyAction verisi
  for (const data of [null, [], 'x', { type: 'team', team: { a: 1 } }, { type: '__proto__' }, { type: 'team', team: 'yesil' }]) {
    const e = g.bots[2].waitFor((m) => m.t === 'error');
    g.bots[2].send({ t: 'lobbyAction', data });
    await e;
  }
  // Oyun ortası lobbyAction reddedilir
  g.host.send({ t: 'start' });
  await g.host.waitView((v) => v.phase === 'kickoff');
  const e3 = g.bots[1].waitFor((m) => m.t === 'error');
  g.bots[1].send({ t: 'lobbyAction', data: { type: 'team', team: 'red' } });
  assert.match((await e3).message, /bekleme odasında/);
  g.bots.forEach((b) => b.leave());
});

test('2v2 tam maç: goller, skor tutarlı, kareler küçük ve sıralı, maç sonu', async () => {
  const g = track(await setupMatch(srv.wsUrl, 4, { settings: { minutes: 2, goals: 3 } }));
  const errors = [];
  g.bots.forEach((b) => frameChecker(b, errors));
  assert.equal(g.host.view.pitch, 'small');
  assert.equal(g.host.view.discs.length, 4);
  const t0 = Date.now();
  const c0 = g.bots[0].frameCount;
  const end = await playToEnd(g);
  const secs = (Date.now() - t0) / 1000;
  assert.deepEqual(errors, []);
  assert.equal(end.phase, 'over');
  assert.equal(end.goals.length, end.score[0] + end.score[1], 'gol listesi skorla tutarlı');
  assert.ok(end.goals.length >= 1, 'yapay zekâ en az bir gol atmalı');
  for (const b of g.bots) assert.deepEqual(b.view.score, end.score, 'herkes aynı skoru görmeli');
  const winner = end.score[0] > end.score[1] ? 'red' : end.score[1] > end.score[0] ? 'blue' : 'draw';
  assert.equal(end.result.winner, winner);
  const rate = (g.bots[0].frameCount - c0) / secs;
  assert.ok(rate > 20 && rate < 40, `kare hızı ${rate.toFixed(1)}/sn`);
  for (const b of g.bots) assert.ok(b.frameMaxBytes < 1024, `kare ${b.frameMaxBytes} bayt`);
  // Bittikten sonra kare gelmez
  const n = g.bots[0].frameCount;
  await sleep(300);
  assert.equal(g.bots[0].frameCount, n, 'maç bitince döngü durmalı');
  // Host lobiye döner, takımlar korunur, yeni maç başlar
  g.host.send({ t: 'backToLobby' });
  const r = await g.host.waitRoom((x) => x.phase === 'lobby');
  assert.equal(Object.keys(r.prep.teams).length, 4);
  g.bots.forEach((b) => b.leave());
});

test('4v4 + yapay ağ gecikmesi (75 ms tek yön): oynanabilir ve tutarlı', async () => {
  const g = track(await setupMatch(srv.wsUrl, 8, { settings: { minutes: 2, goals: 3 } }));
  assert.equal(g.host.view.pitch, 'medium');
  g.bots.forEach((b, i) => { b.latency = 40 + (i % 3) * 35; }); // 40/75/110 ms → RTT 80–220
  const errors = [];
  g.bots.forEach((b) => frameChecker(b, errors));
  // Girdi tepkisi: sağa koşunca diskin kayması RTT + birkaç adım içinde görünür
  await g.host.waitView((v) => v.phase === 'kickoff');
  const mover = g.bots[2]; // kırmızı, gecikme 110 ms
  const start = myDisc(mover);
  const sent = Date.now();
  mover.input(0, 1, false);
  const iv = setInterval(() => mover.input(0, 1, false), 100);
  await mover.waitFrame(() => { const d = myDisc(mover); return d && Math.abs(d.y - start.y) >= 1; }, { timeout: 3000 });
  clearInterval(iv);
  // Beklenen: RTT + 1 birim yol (~5 adım ≈ 80 ms) + kare aralığı (33 ms) + ara değer yok (bot ham kareyi okur)
  const lag = Date.now() - sent;
  assert.ok(lag < 2 * mover.latency + 200, `girdi gecikmesi ${lag} ms (RTT ${2 * mover.latency})`);

  const end = await playToEnd(g, { timeout: 90_000 });
  assert.deepEqual(errors, []);
  for (const b of g.bots) {
    assert.deepEqual(b.view.score, end.score);
    assert.deepEqual(b.view.goals.map((x) => x.team), end.goals.map((x) => x.team));
    assert.ok(b.frameMaxBytes < 1024, `8 kişilik kare ${b.frameMaxBytes} bayt`);
  }
  g.bots.forEach((b) => { b.latency = 0; b.leave(); });
});

test('kopma: 5 sn içinde dönen oyuncu sahada kalır; dönmeyenin diski kalkar, izleyici olur', async () => {
  const g = track(await setupMatch(srv.wsUrl, 4));
  const [, , c] = g.bots; // c: kırmızı
  const ver0 = g.host.view.ver;
  c.drop();
  await sleep(1500);
  await c.connect();
  const v1 = await c.waitFreshView();
  assert.equal(v1.discs.length, 4, 'kısa kopmada disk kalmalı');
  assert.equal(v1.myTeam, 'red');
  c.input(1, 0, false);
  await sleep(200);
  c.drop();
  const v2 = await g.host.waitView((v) => v.discs.length === 3, { timeout: 8000 });
  assert.ok(v2.ver > ver0);
  assert.ok(!v2.discs.some((d) => d.id === c.playerId));
  const f = await g.host.waitFrame((x) => x.v === v2.ver);
  assert.equal(f.p.length, 6, 'kare 3 disk içermeli');
  await c.connect();
  const v3 = await c.waitFreshView();
  assert.equal(v3.removed, true);
  assert.equal(v3.myTeam, null);
  // Girdisi yok sayılır, disk geri gelmez
  for (let i = 0; i < 10; i++) c.input(1, 1, true);
  await sleep(200);
  assert.equal(g.host.view.discs.length, 3);
  assert.equal(c.room.players.find((p) => p.id === c.playerId).spectator, false, 'odada kalır (bir sonraki maçta oynar)');
  g.bots.forEach((b) => b.leave());
});

test('oyun ortası katılan izleyici kare alır, sahaya giremez', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2));
  const late = track({ bots: [await new Bot(srv.wsUrl, 'Geç').connect()] }).bots[0];
  await late.join(g.code);
  const room = await late.waitRoom((r) => r.players.some((p) => p.id === late.playerId));
  assert.equal(room.players.find((p) => p.id === late.playerId).spectator, true);
  const v = await late.waitView(() => true);
  assert.equal(v.myTeam, null);
  await late.waitFrame();
  for (let i = 0; i < 20; i++) late.input(1, 0, true);
  late.action({ type: 'debugPlace', ball: { x: 300, y: 0 } });
  const err = await late.waitFor((m) => m.t === 'error');
  assert.match(err.message, /İzleyici/);
  await sleep(200);
  assert.equal(g.host.view.discs.length, 2);
  assert.equal(late.frame.p.length, 4);
  [...g.bots, late].forEach((b) => b.leave());
});

test('girdi seli ve bozuk girdiler: sunucu ayakta, konumlar sonlu, genel hız sınırı tüketilmez', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2));
  const [a, b] = g.bots;
  const bad = [
    { t: 'input', x: 'NaN', y: null, k: {} },
    { t: 'input', x: 1e308, y: -1e308, k: 1 },
    { t: 'input', x: { valueOf: 5 }, y: [1, 2], k: 'yes' },
    { t: 'input', x: -Infinity },
    { t: 'input' },
    { t: 'input', x: 0.5, y: 0.5, k: true, extra: 'x'.repeat(100) },
    { t: 'ping', c: 'saat' },
    { t: 'ping', c: { a: 1 } },
  ];
  for (let i = 0; i < 400; i++) a.sendRaw(bad[i % bad.length]);
  a.sendRaw('{"t":"input","x":1e999}'); // JSON'da Infinity
  a.sendRaw('{"t":"input","x":"__proto__","__proto__":{"k":1}}');
  a.sendRaw(JSON.stringify({ t: 'input', x: 1, pad: 'y'.repeat(400) })); // > 256 bayt: normal yoldan, bilinmeyen mesaj
  await sleep(300);
  assert.ok(a.isOpen, '400 girdi (pencere sınırı altında) bağlantıyı kapatmamalı');
  // Genel sayaç tüketilmedi: normal mesaj hız hatası almaz
  const before = a.errors.filter((e) => e.code === 'rate').length;
  a.send({ t: 'rename', name: 'X' }); // oyun sırasında reddedilir ama hız hatası değil
  const e = await a.waitFor((m) => m.t === 'error' && m.code !== 'unknown');
  assert.equal(e.code, 'game');
  assert.equal(a.errors.filter((x) => x.code === 'rate').length, before);
  const f = await b.waitFrame((x) => x.s > 0);
  assert.ok([...f.p, ...f.b].every(Number.isInteger));
  // Ping yanıtı (yeni pencerede; az önceki selde ping de düşmüş olur)
  await sleep(1100);
  const pong = a.waitFor((m) => m.t === 'pong');
  a.sendRaw({ t: 'ping', c: 12345.5 });
  assert.equal((await pong).c, 12345.5);
  // Sel: pencere başına 600'ü aşan bağlantı kapanır, oda yaşamaya devam eder
  await sleep(1100);
  for (let i = 0; i < 700; i++) a.sendRaw({ t: 'input', x: 1, y: 0, k: 0 });
  await a.waitFor(() => false, { timeout: 1500 }).catch(() => {});
  assert.equal(a.closed?.code, 1008);
  const fb = b.frameCount;
  await sleep(300);
  assert.ok(b.frameCount > fb, 'diğer oyuncu kare almaya devam etmeli');
  g.bots.forEach((x) => x.close());
});

test('host maç ortasında ayrılır: host devri, disk kalkar; takım boşalınca hükmen biter', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { teams: ['red', 'blue', 'red'] }));
  const [host, blue, red2] = g.bots;
  host.leave();
  const r = await blue.waitRoom((x) => x.hostId !== host.playerId && !x.players.some((p) => p.id === host.playerId));
  assert.ok([blue.playerId, red2.playerId].includes(r.hostId));
  const v = await blue.waitView((x) => x.discs.length === 2);
  assert.notEqual(v.phase, 'over');
  red2.leave();
  const over = await blue.waitView((x) => x.phase === 'over');
  assert.equal(over.result.reason, 'forfeit');
  assert.equal(over.result.winner, 'blue');
  blue.leave();
});

test('yavaş okuyan istemci: kareler atlanır, bağlantı kesilmez', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2));
  const [a, b] = g.bots;
  const stop = startBrain(b);
  a.ws._socket.pause(); // okumayı durdur (TCP tamponu dolar)
  await sleep(3000);
  a.ws._socket.resume();
  const n = a.frameCount;
  await sleep(500);
  stop();
  assert.ok(a.isOpen, 'yavaş istemci atılmamalı');
  assert.ok(a.frameCount > n, 'okumaya dönünce kareler devam etmeli');
  g.bots.forEach((x) => x.leave());
});

test('başka sitenin soketi ve kimliksiz girdi: yok sayılır', async () => {
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  for (let i = 0; i < 50; i++) ws.send(JSON.stringify({ t: 'input', x: 1, y: 0, k: 1 }));
  ws.send(JSON.stringify({ t: 'ping', c: 1 }));
  await sleep(200);
  assert.equal(got.length, 0, 'hello öncesi girdi/ping yanıtsız düşer');
  ws.terminate();
});
