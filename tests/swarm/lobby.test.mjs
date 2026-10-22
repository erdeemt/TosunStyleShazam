// Lobi altyapısı testleri (_test oyunu ile). Çalıştır: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { Bot, makeBots, makeRoom, sleep } from '../lib/bot.js';

let srv;
const bots = [];
const track = (list) => { bots.push(...list); return list; };

before(async () => { srv = await startServer({ timeScale: 0.02 }); });
after(async () => { bots.forEach((b) => b.close()); await srv.stop(); });

test('oda kur, katıl, isim çakışması, oda kodu formatı', async () => {
  const [a, b, c] = track(await makeBots(srv.wsUrl, 3, 'Ayşe'));
  // üçüne de aynı ad
  for (const bot of [a, b, c]) bot.send({ t: 'rename', name: 'Ali' });
  await Promise.all([a, b, c].map((bot) => bot.waitFor((m) => m.t === 'welcome')));
  const code = await a.create('_test');
  assert.match(code, /^[ABCDEFGHJKLMNPRSTUVYZ]{4}$/);
  await b.join(code);
  await c.join(code.toLowerCase());
  const room = await a.waitRoom((r) => r.players.length === 3);
  assert.deepEqual(room.players.map((p) => p.name), ['Ali', 'Ali 2', 'Ali 3']);
  assert.equal(room.hostId, a.playerId);
  assert.ok(room.players[0].isHost);
});

test('olmayan oda, bilinmeyen oyun, hello olmadan mesaj, bozuk JSON', async () => {
  const [a] = track(await makeBots(srv.wsUrl, 1));
  await assert.rejects(a.join('ZZZZ'), /bulunamadı/);
  await assert.rejects(a.create('yok-boyle-oyun'), /oyun yok/);
  a.sendRaw('{bozuk');
  assert.equal((await a.waitFor((m) => m.t === 'error')).code, 'bad_json');
  a.sendRaw({ t: '__proto__' });
  assert.equal((await a.waitFor((m) => m.t === 'error')).code, 'unknown');

  const raw = new Bot(srv.wsUrl, 'x');
  track([raw]);
  // hello göndermeden create
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const reply = new Promise((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ t: 'create', game: '_test' }));
  assert.equal((await reply).code, 'no_hello');
  ws.terminate();
});

test('sadece host başlatır/ayar değiştirir; ayarlar temizlenir; min oyuncu', async () => {
  const [a, b] = track(await makeBots(srv.wsUrl, 2));
  const code = await a.create('_test');
  a.send({ t: 'start' });
  assert.match((await a.waitFor((m) => m.t === 'error')).message, /en az 2/);
  await b.join(code);
  b.send({ t: 'start' });
  assert.match((await b.waitFor((m) => m.t === 'error')).message, /oda sahibi/);
  a.send({ t: 'settings', settings: { seconds: 99999, evil: '<script>', __proto__: { polluted: 1 } } });
  const room = await a.waitRoom((r) => r.settings.seconds === 600);
  assert.deepEqual(Object.keys(room.settings), ['seconds']);
  assert.equal({}.polluted, undefined);
});

test('tam oyun + gizli bilgi sızıntısı yok (12 oyuncu)', async () => {
  const { bots: list, host } = await makeRoom(srv.wsUrl, '_test', 12);
  track(list);
  host.send({ t: 'start' });
  const views = await Promise.all(list.map((b) => b.waitView((v) => v.turnPlayerId != null)));
  const secrets = views.map((v) => v.mySecret);
  assert.equal(new Set(secrets).size, 12);
  for (let i = 0; i < list.length; i++) {
    const turnId = list[0].view.turnPlayerId;
    const turnBot = list.find((b) => b.playerId === turnId);
    // sırası olmayan biri basarsa hata
    const other = list.find((b) => b !== turnBot);
    const err = await other.act({ type: 'press' });
    assert.equal(err.t, 'error');
    await turnBot.act({ type: 'press' });
  }
  const room = await host.waitRoom((r) => r.phase === 'over');
  assert.equal(room.phase, 'over');
  // Her bot sadece kendi sırrını ve kendi token'ını görmüş olmalı.
  for (const [i, b] of list.entries()) {
    const text = b.transcript();
    for (const [j, other] of list.entries()) {
      if (i === j) continue;
      assert.ok(!text.includes(secrets[j]), `${b.name}, ${other.name} sırrını gördü`);
      assert.ok(!text.includes(other.token), `${b.name}, ${other.name} token'ını gördü`);
    }
  }
});

test('zamanlayıcı süre dolunca oyunu bitirir (TIME_SCALE)', async () => {
  const { bots: list, host } = await makeRoom(srv.wsUrl, '_test', 2);
  track(list);
  host.send({ t: 'settings', settings: { seconds: 5 } }); // 5 sn * 0.02 = 100 ms
  await host.waitRoom((r) => r.settings.seconds === 5);
  host.send({ t: 'start' });
  const v = await host.waitView((x) => x.over, { timeout: 3000 });
  assert.equal(v.reason, 'timeout');
});

test('yeniden bağlanma: aynı koltuk, aynı gizli bilgi; yanlış token yeni kimlik', async () => {
  const { bots: list, host } = await makeRoom(srv.wsUrl, '_test', 3);
  track(list);
  host.send({ t: 'start' });
  const [, b] = list;
  const before = await b.waitView((v) => v.mySecret);
  await host.waitRoom(() => true);
  b.drop();
  await host.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === false);
  await b.connect();
  const afterView = await b.waitView((v) => v.mySecret);
  assert.equal(afterView.mySecret, before.mySecret);
  await host.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === true);

  // Başkasının playerId'si + yanlış token → yeni kimlik, odaya giremez
  const thief = track([new Bot(srv.wsUrl, 'Hırsız')])[0];
  thief.playerId = b.playerId;
  thief.token = 'yanlis';
  await thief.connect();
  assert.notEqual(thief.playerId, b.playerId);
  assert.equal(thief.room, null);
});

test('koltuk süresi dolunca oyuncu çıkar, host devredilir', async () => {
  const { bots: list, host, code } = await makeRoom(srv.wsUrl, '_test', 3);
  track(list);
  host.drop(); // 120 sn * 0.02 = 2.4 sn sonra çıkar
  const room = await list[1].waitRoom((r) => r.players.length === 2, { timeout: 6000 });
  assert.equal(room.hostId, list[1].playerId);
  assert.equal(room.code, code);
});

test('kick, oda dolu, oyun sırasında katılan izleyici olur', async () => {
  const { bots: list, host, code } = await makeRoom(srv.wsUrl, '_test', 12);
  track(list);
  const [extra] = track(await makeBots(srv.wsUrl, 1, 'Fazla'));
  await assert.rejects(extra.join(code), /dolu/);
  host.send({ t: 'kick', playerId: list[11].playerId });
  await list[11].waitFor((m) => m.t === 'kicked');
  await host.waitRoom((r) => r.players.length === 11);
  host.send({ t: 'start' });
  await host.waitRoom((r) => r.phase === 'playing');
  const room = await extra.join(code);
  assert.ok(room.players.find((p) => p.id === extra.playerId).spectator);
  const errP = extra.waitFor((m) => m.t === 'error');
  extra.action({ type: 'press' });
  const err = await errP;
  assert.match(err.message, /İzleyici/);
});

test('XSS / kontrol karakterli ad temizlenir ve kısaltılır', async () => {
  const [a] = track(await makeBots(srv.wsUrl, 1));
  a.send({ t: 'rename', name: '‮\u0000<img src=x onerror=alert(1)>çok uzun bir isim' });
  const w = await a.waitFor((m) => m.t === 'welcome');
  assert.ok(!/[\u0000-\u001f‮]/.test(w.name));
  assert.ok([...w.name].length <= 16);
  // HTML olduğu gibi saklanır (istemci textContent ile basar) — sadece uzunluk/karakter sınırı
  assert.ok(w.name.startsWith('<img'));
});

test('büyük mesaj bağlantıyı kapatır, mesaj seli kesilir', async () => {
  const [a, b] = track(await makeBots(srv.wsUrl, 2));
  a.sendRaw({ t: 'rename', name: 'x'.repeat(9000) });
  await sleep(300);
  assert.equal(a.closed?.code, 1009);

  for (let i = 0; i < 200; i++) b.sendRaw({ t: 'rename', name: `n${i}` });
  await sleep(500);
  assert.ok(b.errors.some((e) => e.code === 'rate'));
  assert.equal(b.closed?.code, 1008);
});

test('başka siteden (Origin) WebSocket reddedilir', async () => {
  const evil = new Bot(srv.wsUrl, 'Kötü');
  await assert.rejects(evil.connect({ origin: 'https://evil.example' }), /403/);
});

test('eş zamanlı start ve press yarışı tutarlı kalır', async () => {
  const { bots: list, host } = await makeRoom(srv.wsUrl, '_test', 6);
  track(list);
  for (let i = 0; i < 5; i++) host.send({ t: 'start' });
  await host.waitRoom((r) => r.phase === 'playing');
  await sleep(100);
  assert.ok(host.errors.filter((e) => /zaten başladı/.test(e.message)).length >= 1);
  const turnId = host.view.turnPlayerId;
  const turnBot = list.find((b) => b.playerId === turnId);
  for (let i = 0; i < 5; i++) turnBot.action({ type: 'press' });
  await sleep(200);
  const pressed = host.view.players.filter((p) => p.pressed).length;
  assert.equal(pressed, 1, 'aynı oyuncu bir kerede birden fazla sıra ilerletmemeli');
});
