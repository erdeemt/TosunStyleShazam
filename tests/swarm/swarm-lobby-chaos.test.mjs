// Lobi kenar durumları: aynı kimlikle iki soket, aynı sokette kimlik değişimi, bitmiş/silinmiş odaya katılma,
// oda temizliği (test-only sonda ile oda sayısı gözlenir), sunucu oda sınırı ve yan etkiler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeBots, makeRoom } from '../lib/bot.js';
import { startProbedServer, Bot, sleep, until } from './swarm-lib.mjs';

let srv;
const all = [];
const track = (list) => { all.push(...list); return list; };

before(async () => { srv = await startProbedServer({ timeScale: 0.01, seed: 3, probeMs: 100 }); }); // koltuk 1.2 sn
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

test('aynı kimlikle iki soket: eski "replaced" + 4000 ile kapanır, koltuk bağlı kalır, görünüm yenisine gider', async () => {
  const { bots, host } = await makeRoom(srv.wsUrl, '_test', 3, 'Çift');
  track(bots);
  host.send({ t: 'start' });
  const b = bots[1];
  const secret = (await b.waitView((v) => v.mySecret)).mySecret;
  const twin = track([new Bot(srv.wsUrl, b.name)])[0];
  twin.playerId = b.playerId;
  twin.token = b.token;
  const oldWs = b.ws;
  const replaced = new Promise((r) => oldWs.once('close', (code) => r(code)));
  await twin.connect();
  assert.equal(twin.playerId, b.playerId);
  assert.equal(await replaced, 4000);
  assert.ok(b.errors.some((e) => e.code === 'replaced'));
  const v = await twin.waitView((x) => x.mySecret);
  assert.equal(v.mySecret, secret);
  await sleep(100);
  assert.equal(host.room.players.find((p) => p.id === b.playerId).connected, true, 'eski soketin kapanması koltuğu kopuk göstermemeli');
  // İki soket aynı anda yeniden bağlanırsa (iki sekme yarışı) sonunda tek bağlı soket kalmalı
  const t2 = track([new Bot(srv.wsUrl, b.name)])[0];
  const t3 = track([new Bot(srv.wsUrl, b.name)])[0];
  for (const t of [t2, t3]) { t.playerId = b.playerId; t.token = b.token; }
  await Promise.allSettled([t2.connect(), t3.connect()]);
  await sleep(200);
  const open = [twin, t2, t3].filter((t) => t.isOpen);
  assert.equal(open.length, 1, `tek açık soket kalmalı, açık: ${open.length}`);
  assert.equal(host.room.players.find((p) => p.id === b.playerId).connected, true);
});

test('aynı sokette ikinci hello ile kimlik değişimi: eski kimliğin koltuğu kopuk sayılır (hayalet oyuncu yok)', async () => {
  const { bots, host, code } = await makeRoom(srv.wsUrl, '_test', 3, 'Hayalet');
  track(bots);
  const b = bots[2];
  b.sendRaw({ t: 'hello', name: 'Yeni Kimlik' }); // playerId yok → yeni kimlik, aynı soket
  const w = await b.waitFor((m) => m.t === 'welcome');
  assert.notEqual(w.playerId, b.playerId);
  const room = await host.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === false, { timeout: 2000 });
  assert.equal(room.code, code);
  // koltuk süresi sonunda eski kimlik odadan düşer
  await host.waitRoom((r) => r.players.length === 2, { timeout: 4000 });
});

test('bitmiş odaya katılan izleyici olur; silinmiş odaya katılma "bulunamadı"', async () => {
  const { bots, host, code } = await makeRoom(srv.wsUrl, '_test', 2, 'Bitti');
  track(bots);
  host.send({ t: 'start' });
  for (let i = 0; i < 2; i++) {
    const turn = await host.waitView((v) => v.turnPlayerId != null);
    await bots.find((b) => b.playerId === turn.turnPlayerId).act({ type: 'press' });
  }
  await host.waitRoom((r) => r.phase === 'over');
  const [late] = track(await makeBots(srv.wsUrl, 1, 'Geç'));
  const r = await late.join(code);
  assert.equal(r.phase, 'over');
  assert.equal(r.players.find((p) => p.id === late.playerId).spectator, true);
  for (const b of [...bots, late]) b.send({ t: 'leave' });
  await sleep(100);
  await assert.rejects(late.join(code), /bulunamadı/);
});

test('oda temizliği: herkes leave → oda hemen silinir; herkes kopar → koltuk süresi sonunda silinir (sonda ile)', async () => {
  const base = (await srv.waitProbe(() => true)).rooms;
  const groups = [];
  for (let i = 0; i < 5; i++) groups.push(await makeRoom(srv.wsUrl, 'spyfall', 4, `T${i}-`));
  groups.forEach((g) => track(g.bots));
  await srv.waitProbe((p) => p.rooms === base + 5);
  groups[0].host.send({ t: 'start' }); // biri oyun ortasında
  await groups[0].host.waitRoom((r) => r.phase === 'playing');
  for (const g of groups.slice(0, 2)) for (const b of g.bots) b.send({ t: 'leave' });
  await srv.waitProbe((p) => p.rooms === base + 3, 2000);
  for (const g of groups.slice(2)) for (const b of g.bots) b.drop();
  await sleep(300);
  assert.equal(srv.lastProbe().rooms, base + 3, 'koltuk süresi dolmadan oda silinmemeli');
  await srv.waitProbe((p) => p.rooms === base, 5000);
});

test('sunucu oda sınırı (200): 201. oda reddedilir; sınırdayken odadaki host "create" denerse odasını kaybetmemeli', async () => {
  const base = (await srv.waitProbe(() => true)).rooms;
  // Önce 2 kişilik bir oda: host sınırdayken create denesin
  const g = await makeRoom(srv.wsUrl, '_test', 2, 'Sınır');
  track(g.bots);
  const need = 200 - base - 1;
  const creators = [];
  for (let i = 0; i < need; i += 25) {
    const batch = track(await makeBots(srv.wsUrl, Math.min(25, need - i), `C${i}-`));
    await Promise.all(batch.map((b) => b.create('_test')));
    creators.push(...batch);
  }
  await srv.waitProbe((p) => p.rooms === 200);
  const [extra] = track(await makeBots(srv.wsUrl, 1, 'Fazla'));
  await assert.rejects(extra.create('_test'), /Sunucu dolu/);
  const err = g.host.waitFor((m) => m.t === 'error' || (m.t === 'room' && m.room === null));
  g.host.send({ t: 'create', game: '_test' });
  const m = await err;
  try {
    assert.equal(m.t, 'error');
    await sleep(100);
    const seen = await g.bots[1].waitRoom(() => true);
    assert.ok(seen.players.some((p) => p.id === g.host.playerId), 'reddedilen create, host\'u mevcut odasından çıkarmamalı');
  } finally {
    creators.forEach((b) => b.send({ t: 'leave' }));
    await srv.waitProbe((p) => p.rooms <= base + 1, 5000).catch(() => {});
  }
});

test('oyun sırasında rename reddedilir ve kimlik adı da değişmemeli', async () => {
  const { bots, host, code } = await makeRoom(srv.wsUrl, '_test', 2, 'Ad');
  track(bots);
  host.send({ t: 'start' });
  await host.waitRoom((r) => r.phase === 'playing');
  const p = bots[1].waitFor((m) => m.t === 'error');
  bots[1].send({ t: 'rename', name: 'Gizlice' });
  assert.match((await p).message, /bekleme odasında/);
  // Ad göndermeden yeniden bağlan: welcome'daki ad, sunucunun kimlikte tuttuğu addır
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const welcome = new Promise((r) => ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome') r(m); }));
  ws.send(JSON.stringify({ t: 'hello', playerId: bots[1].playerId, token: bots[1].token }));
  const w = await welcome;
  ws.terminate();
  assert.ok(code);
  assert.notEqual(w.name, 'Gizlice', 'reddedilen ad kimliğe yazılmış (sonraki odalarda bu ad kullanılır)');
});

test('hello olmadan / hello sonrası her mesaj tipine boş gövde: sadece kontrollü hata', async () => {
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  for (const t of ['create', 'join', 'leave', 'settings', 'start', 'action', 'kick', 'rename', 'backToLobby']) ws.send(JSON.stringify({ t }));
  await until(() => got.length >= 9, { timeout: 2000, what: '9 yanıt' });
  assert.ok(got.every((m) => m.t === 'error' && m.code === 'no_hello'));
  ws.send(JSON.stringify({ t: 'hello', name: 'Boş' }));
  await until(() => got.some((m) => m.t === 'welcome'));
  got.length = 0;
  for (const t of ['create', 'join', 'settings', 'start', 'action', 'kick', 'backToLobby', 'leave', 'rename']) ws.send(JSON.stringify({ t }));
  await sleep(300);
  assert.deepEqual(got.filter((m) => m.code === 'internal'), []);
  ws.terminate();
});
