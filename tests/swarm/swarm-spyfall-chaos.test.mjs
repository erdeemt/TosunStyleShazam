// Casus Kim? kaos senaryoları: yeniden bağlanma fırtınası, oylama ortasında host/oyuncu ayrılması, oylama sırasında kick,
// koltuk süresi dolması, aynı milisaniyede yarışan eylemler. Her senaryoda SpyfallReferee her mesajı denetler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom, makeBots } from '../lib/bot.js';
import { startProbedServer, SpyfallReferee, monkey, createRng, sleep, summarize, until } from './swarm-lib.mjs';

// TIME_SCALE=0.01 → tur 3 dk = 1.8 sn, suçlama oylaması 0.45 sn, final oylaması 0.6 sn, koltuk 1.2 sn
const SCALE = 0.01;
let srv;
const all = [];
const refs = [];

before(async () => { srv = await startProbedServer({ timeScale: SCALE, seed: 7 }); });
after(async () => {
  all.forEach((b) => b.close());
  await srv.stop();
});

async function setupGame(n, settings = {}) {
  const room = await makeRoom(srv.wsUrl, 'spyfall', n, 'K');
  all.push(...room.bots);
  const s = { rounds: 1, minutes: 15, spies: 1, ...settings };
  const ref = new SpyfallReferee({ label: `chaos n=${n} ${room.code}`, spiesSetting: s.spies }).attachAll(room.bots);
  refs.push(ref);
  room.host.send({ t: 'settings', settings: s });
  await room.host.waitRoom((r) => r.settings.rounds === s.rounds && r.settings.minutes === s.minutes && r.settings.spies === s.spies);
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'play')));
  const spies = room.bots.filter((b) => b.view.me.spy);
  const town = room.bots.filter((b) => !b.view.me.spy);
  return { ...room, spies, town, ref };
}

function assertClean(g) {
  const v = g.ref.finalChecks();
  assert.deepEqual(v, [], v.join('\n'));
  const errs = g.bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal'));
  assert.deepEqual(errs, []);
}

const byId = (g, id) => g.bots.find((b) => b.playerId === id);
const live = (g) => g.bots.filter((b) => b.isOpen && b.room);

// ---------------------------------------------------------------------------------------------------------------

test('yeniden bağlanma fırtınası: 8 ve 10 kişi, her 150–400 ms rastgele biri (host dahil) düşüp geri gelir', async () => {
  const storm = await startProbedServer({ timeScale: 0.02, seed: 9 }); // koltuk 2.4 sn, tur 3 dk = 3.6 sn
  const bots = [];
  try {
    const run = async (n, spies, seed) => {
      const room = await makeRoom(storm.wsUrl, 'spyfall', n, `F${n}-`);
      bots.push(...room.bots);
      const ref = new SpyfallReferee({ label: `storm n=${n} ${room.code}`, spiesSetting: spies }).attachAll(room.bots);
      room.host.send({ t: 'settings', settings: { rounds: 3, minutes: 3, spies } });
      await room.host.waitRoom((r) => r.settings.rounds === 3);
      const stop = { done: false };
      const rng = createRng(seed);
      const oracle = {};
      const loops = room.bots.map((b, i) => monkey(b, { rng: createRng(seed + i), oracle, stop, illegalRate: 0.02, guessRate: 0.003, accuseRate: 0.01 }));
      room.host.send({ t: 'start' });
      let drops = 0;
      let hostDrops = 0;
      const seatChecks = [];
      const chaos = (async () => {
        while (!stop.done) {
          await sleep(150 + rng.int(250));
          const b = rng.next() < 0.25 ? room.bots[0] : rng.pick(room.bots);
          if (!b.isOpen) continue;
          const before = { id: b.playerId, round: b.view?.round, phase: b.view?.phase, me: JSON.stringify(b.view?.me ?? null) };
          b.drop();
          drops++;
          if (b === room.bots[0]) hostDrops++;
          await sleep(20 + rng.int(230));
          await b.connect().catch(() => b.connect());
          assert.equal(b.playerId, before.id, 'yeniden bağlanınca aynı playerId');
          const v = await b.waitView(() => true, { timeout: 3000 }).catch(() => null);
          if (v && before.round === v.round && before.me !== 'null') seatChecks.push([before.me, JSON.stringify(v.me), b.name]);
        }
      })();
      try {
        // Host da düşüp geri geldiği için kapanışta reddeden waitRoom yerine yoklama
        await until(() => room.bots.some((b) => b.room?.phase === 'over'), { timeout: 45_000, what: `n=${n} oyun bitmedi` });
      } finally {
        stop.done = true;
        await Promise.all([...loops, chaos]);
      }
      for (const [a, b, name] of seatChecks) assert.equal(b, a, `${name}: yeniden bağlanınca özel görünüm (me) aynı kalmalı`);
      await until(() => room.host.isOpen && room.host.room?.players.every((p) => p.connected), { timeout: 3000, what: 'herkes bağlı' });
      const room2 = room.host.room;
      assert.equal(room2.players.length, n, 'kısa kopmalarda kimse koltuğunu kaybetmemeli');
      // Not: lobby.js artık host 15 sn (×TIME_SCALE = 300 ms) kopuk kalınca devrediyor; bu yüzden sadece geçerli host aranır.
      assert.ok(room2.players.some((p) => p.id === room2.hostId && p.connected), 'host bağlı bir oyuncu olmalı');
      const v = ref.finalChecks();
      assert.deepEqual(v, [], v.join('\n'));
      console.log(`${summarize(ref)} drops=${drops} hostDrops=${hostDrops} seatChecks=${seatChecks.length}`);
      assert.ok(drops >= 8, `yeterince kopma olmalı (${drops})`);
    };
    const res = await Promise.allSettled([run(8, 1, 500), run(10, 2, 900)]);
    for (const r of res) if (r.status === 'rejected') throw r.reason;
    assert.doesNotMatch(storm.log(), /hatası/);
  } finally {
    bots.forEach((b) => b.close());
    await storm.stop();
  }
});

test('host suçlama oylamasının ortasında ayrılır (host seçmen): yeni host, oylama kalanlarla çözülür', async () => {
  const g = await setupGame(6);
  const host = g.host;
  const accuser = g.town.find((b) => b !== host);
  const target = g.spies[0] !== host ? g.spies[0] : g.town.find((b) => b !== host && b !== accuser);
  await accuser.act({ type: 'accuse', targetId: target.playerId });
  await host.waitView((v) => v.phase === 'accuse');
  const voters = g.bots.filter((b) => ![host, accuser, target].includes(b));
  voters[0].action({ type: 'vote', yes: true });
  await accuser.waitView((v) => v.accusation?.votedCount === 2);
  host.send({ t: 'leave' });
  const room = await accuser.waitRoom((r) => r.players.length === 5);
  assert.equal(room.hostId, g.bots[1].playerId, 'en eski bağlı oyuncu host olmalı');
  const v1 = await accuser.waitView((v) => v.players.length === 5);
  if (host.view.me.spy) {
    assert.equal(v1.result?.reason, 'spy_left');
  } else {
    assert.equal(v1.phase, 'accuse', 'host ayrılınca oylama sürmeli');
    assert.equal(v1.accusation.voterCount, 4);
    for (const b of voters.slice(1)) b.action({ type: 'vote', yes: true });
    const v = await accuser.waitView((x) => x.phase === 'reveal');
    assert.equal(v.result.winner, target.view.me.spy ? 'town' : 'spy');
    assert.ok(!(host.playerId in v.result.points), 'ayrılan host puan almamalı');
  }
  const newHost = byId(g, room.hostId);
  newHost.action({ type: 'next' });
  await newHost.waitRoom((r) => r.phase === 'over');
  assertClean(g);
});

test('host suçlayan olarak ayrılır: oylama devam eder, ayrılan suçlayana bonus yazılmaz', async () => {
  const g = await setupGame(6);
  const host = g.host;
  const target = host.view.me.spy ? g.town[0] : g.spies[0];
  await host.act({ type: 'accuse', targetId: target.playerId });
  await g.bots[1].waitView((v) => v.phase === 'accuse');
  host.send({ t: 'leave' });
  const v1 = await g.bots[1].waitView((v) => v.players.length === 5);
  if (host.view.me.spy) {
    assert.equal(v1.result?.reason, 'spy_left');
  } else {
    assert.equal(v1.phase, 'accuse');
    // Suçlayanın "Evet" oyu silinir; kalan seçmenler: hedef hariç herkes
    for (const b of g.bots.filter((b) => b !== host && b !== target)) b.action({ type: 'vote', yes: true });
    const v = await g.bots[1].waitView((x) => x.phase === 'reveal');
    assert.equal(v.result.winner, 'town');
    assert.equal(v.result.reason, 'caught');
    const total = Object.values(v.result.points).reduce((s, x) => s + x, 0);
    assert.equal(total, 4, '4 kalan köylü × 1, bonus yok');
  }
  assertClean(g);
});

test('suçlanan host ayrılır: suçlama iptal, oyun devam, suçlayanın hakkı gider', async () => {
  const g = await setupGame(5);
  const host = g.host;
  const accuser = g.bots.find((b) => b !== host);
  await accuser.act({ type: 'accuse', targetId: host.playerId });
  await accuser.waitView((v) => v.phase === 'accuse');
  host.send({ t: 'leave' });
  const v = await accuser.waitView((x) => x.players.length === 4);
  if (host.view.me.spy) assert.equal(v.result?.reason, 'spy_left');
  else {
    assert.equal(v.phase, 'play');
    assert.equal(v.accusation, null);
    assert.equal(v.canAccuse, false);
    assert.ok(v.endsAt > Date.now(), 'saat devam etmeli');
  }
  assertClean(g);
});

test('final oylamasında oy alan oyuncu ayrılır: ona verilen oylar silinir, sahipleri yeniden oy verir', async () => {
  const g = await setupGame(6, { minutes: 3 }); // final ≈ 1.8 sn sonra
  await g.host.waitView((v) => v.phase === 'final', { timeout: 6000 });
  const spy = g.spies[0];
  const [x, a, c, ...rest] = g.town.filter((b) => b !== g.host).concat(g.town.filter((b) => b === g.host));
  a.action({ type: 'finalVote', targetId: x.playerId });
  c.action({ type: 'finalVote', targetId: x.playerId });
  await spy.waitView((v) => v.finalVote?.votedCount === 2);
  x.send({ t: 'leave' });
  const v = await spy.waitView((vv) => vv.players.length === 5);
  assert.equal(v.phase, 'final');
  assert.equal(v.finalVote.votedCount, 0, 'ayrılana verilen oylar silinmeli');
  assert.equal(v.finalVote.voterCount, 5);
  const back = await a.waitView((vv) => vv.players.length === 5);
  assert.equal(back.finalVote.myVote, null, 'oyu silinen tekrar oy verebilmeli');
  for (const b of [a, c, ...rest]) b.action({ type: 'finalVote', targetId: spy.playerId });
  spy.action({ type: 'finalVote', targetId: a.playerId });
  const r = await spy.waitView((vv) => vv.phase === 'reveal');
  assert.equal(r.result.reason, 'final_caught');
  assert.ok(!Object.values(r.result.finalVotes).includes(x.playerId));
  assertClean(g);
});

test('final oylamasında son oy vermeyen ayrılır: oylama hemen çözülür', async () => {
  const g = await setupGame(5, { minutes: 3 });
  await g.host.waitView((v) => v.phase === 'final', { timeout: 6000 });
  const spy = g.spies[0];
  const quitter = g.town.find((b) => b !== g.host);
  const voters = g.bots.filter((b) => b !== quitter);
  for (const b of voters) b.action({ type: 'finalVote', targetId: b === spy ? g.host.playerId : spy.playerId });
  await spy.waitView((v) => v.finalVote?.votedCount === 4);
  quitter.send({ t: 'leave' });
  const r = await spy.waitView((vv) => vv.phase === 'reveal', { timeout: 300 }); // final süresinden (600 ms) önce
  assert.equal(r.result.reason, 'final_caught');
  assertClean(g);
});

test('suçlama oylamasında kick: oy vermemiş seçmen atılır → kalan Evet oylarıyla çözülür; atılan artık görünüm almaz', async () => {
  const g = await setupGame(6);
  const host = g.host;
  const spy = g.spies[0];
  if (spy === host) return; // tohum 7 ile host casus değil; değilse senaryo anlamsız
  const accuser = g.town.find((b) => b !== host);
  await accuser.act({ type: 'accuse', targetId: spy.playerId });
  await host.waitView((v) => v.phase === 'accuse');
  const victim = g.town.find((b) => b !== host && b !== accuser);
  const others = g.town.filter((b) => ![host, accuser, victim].includes(b));
  host.action({ type: 'vote', yes: true });
  for (const b of others) b.action({ type: 'vote', yes: true });
  await accuser.waitView((v) => v.accusation?.votedCount === 2 + others.length);
  host.send({ t: 'kick', playerId: victim.playerId });
  await victim.waitFor((m) => m.t === 'kicked');
  const kickedAt = victim.messages.findIndex((m) => m.t === 'kicked');
  const v = await accuser.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.reason, 'caught');
  assert.equal(v.result.points[accuser.playerId], 2);
  await sleep(100);
  assert.equal(victim.messages.slice(kickedAt).filter((m) => m.t === 'view').length, 0, 'atılan oyuncu görünüm almaya devam etti');
  assert.equal(victim.room, null);
  assertClean(g);
});

test('suçlama oylamasında suçlananı kick: suçlama iptal; casusu kick: tur iptal (spy_left)', async () => {
  const g = await setupGame(6);
  const host = g.host;
  const accuser = g.town.find((b) => b !== host);
  const innocent = g.town.find((b) => b !== host && b !== accuser);
  await accuser.act({ type: 'accuse', targetId: innocent.playerId });
  await host.waitView((v) => v.phase === 'accuse');
  host.send({ t: 'kick', playerId: innocent.playerId });
  const v = await accuser.waitView((x) => x.players.length === 5);
  assert.equal(v.phase, 'play');
  const spy = g.spies[0];
  const accuser2 = g.town.find((b) => ![host, accuser, innocent].includes(b));
  await accuser2.act({ type: 'accuse', targetId: host === spy ? accuser.playerId : spy.playerId });
  await host.waitView((x) => x.phase === 'accuse');
  if (host !== spy) {
    host.send({ t: 'kick', playerId: spy.playerId });
    const r = await accuser.waitView((x) => x.phase === 'reveal');
    assert.equal(r.result.reason, 'spy_left');
    assert.ok(Object.values(r.result.points).every((p) => p === 0));
  }
  assertClean(g);
});

test('final oylamasında kick: son oy vermeyen atılırsa oylama hemen çözülür', async () => {
  const g = await setupGame(5, { minutes: 3 });
  await g.host.waitView((v) => v.phase === 'final', { timeout: 6000 });
  const spy = g.spies[0];
  const victim = g.town.find((b) => b !== g.host);
  for (const b of g.bots.filter((b) => b !== victim)) b.action({ type: 'finalVote', targetId: b === spy ? g.host.playerId : spy.playerId });
  await spy.waitView((v) => v.finalVote?.votedCount === 4);
  g.host.send({ t: 'kick', playerId: victim.playerId });
  const r = await spy.waitView((vv) => vv.phase === 'reveal', { timeout: 300 });
  assert.equal(r.result.reason, spy === g.host ? 'final_wrong' : 'final_caught');
  assertClean(g);
});

test('koltuk süresi oyun ortasında dolar: suçlama sırasında kopan seçmen "Hayır" sayılır, sonra oyundan düşer', async () => {
  const g = await setupGame(6);
  const host = g.host;
  const accuser = g.town.find((b) => b !== host);
  const target = g.town.find((b) => b !== host && b !== accuser);
  const ghost = g.bots.find((b) => ![host, accuser, target].includes(b) && !b.view.me.spy);
  await accuser.act({ type: 'accuse', targetId: target.playerId });
  await host.waitView((v) => v.phase === 'accuse');
  ghost.drop();
  for (const b of g.bots.filter((b) => ![accuser, target, ghost].includes(b))) b.action({ type: 'vote', yes: true });
  const v = await accuser.waitView((x) => x.phase === 'play', { timeout: 2000 }); // 0.45 sn sonra zaman aşımı → Hayır
  assert.equal(v.players.length, 6);
  const gone = await accuser.waitView((x) => x.players.length === 5, { timeout: 4000 }); // koltuk 1.2 sn
  assert.ok(!gone.players.some((p) => p.id === ghost.playerId));
  const room = await accuser.waitRoom((r) => r.players.length === 5);
  assert.ok(!room.players.some((p) => p.id === ghost.playerId));
  assertClean({ ...g, bots: g.bots.filter((b) => b !== ghost) });
});

// ---------------------------------------------------------------------------------------------------------------
// Aynı milisaniye yarışları

test('yarış: iki oyuncu aynı anda suçlar → biri kabul, reddedilenin hakkı yanmaz', async () => {
  const g = await setupGame(6);
  const [a, b] = g.town;
  const t1 = g.bots.find((x) => x !== a && x !== b);
  a.action({ type: 'accuse', targetId: t1.playerId });
  b.action({ type: 'accuse', targetId: t1.playerId });
  const v = await g.host.waitView((x) => x.phase === 'accuse');
  const winner = v.accusation.byId === a.playerId ? a : b;
  const loser = winner === a ? b : a;
  await loser.waitFor((m) => m.t === 'error', { fromStart: true });
  // Birisi Hayır → oyun devam
  const no = g.bots.find((x) => x !== winner && x !== t1);
  no.action({ type: 'vote', yes: false });
  const after = await loser.waitView((x) => x.phase === 'play');
  assert.equal(after.canAccuse, true, 'reddedilen suçlamanın hakkı yanmamalı');
  assertClean(g);
});

test('yarış: tüm seçmenler aynı ms\'de oy verir, suçlanan aynı ms\'de ayrılır → tek sonuç, tutarlı', async () => {
  const g = await setupGame(7);
  const accuser = g.town[0];
  const target = g.town[1];
  await accuser.act({ type: 'accuse', targetId: target.playerId });
  await g.host.waitView((v) => v.phase === 'accuse');
  for (const b of g.bots.filter((x) => x !== accuser && x !== target)) b.action({ type: 'vote', yes: true });
  target.send({ t: 'leave' });
  await sleep(300);
  const v = accuser.view;
  // Ayrılma oylardan önce işlendiyse oyun devam (play), sonra işlendiyse masum açıklandı (reveal / wrong_accuse)
  assert.ok(v.phase === 'play' || (v.phase === 'reveal' && v.result.reason === 'wrong_accuse'), `beklenmeyen durum ${v.phase}/${v.result?.reason}`);
  assertClean({ ...g, bots: g.bots.filter((b) => b !== target) });
});

test('yarış: 8 final oyu aynı anda + süre dolması → tek açıklama, puan bir kez', async () => {
  const g = await setupGame(8, { minutes: 3 });
  await g.host.waitView((v) => v.phase === 'final', { timeout: 6000 });
  const spy = g.spies[0];
  for (const b of g.bots) b.action({ type: 'finalVote', targetId: b === spy ? g.town[0].playerId : spy.playerId });
  for (const b of g.bots) b.action({ type: 'finalVote', targetId: g.town[1].playerId }); // tekrar oy
  const r = await g.host.waitView((v) => v.phase === 'reveal');
  await sleep(700); // final zamanlayıcısının tetiklenme anını da geç
  const reveals = g.host.messages.filter((m) => m.t === 'view' && m.view.phase === 'reveal');
  assert.ok(reveals.every((m) => JSON.stringify(m.view.result) === JSON.stringify(r.result)), 'sonuç değişmemeli');
  assert.equal(g.host.view.players.reduce((s, p) => s + p.score, 0), 7);
  assertClean(g);
});

test('yarış: host 10 kez aynı anda "next" → tur tam 1 artar', async () => {
  const g = await setupGame(4, { rounds: 3 });
  const loc = g.town[0].view.me.location.id;
  await g.spies[0].act({ type: 'guess', locationId: loc });
  await g.host.waitView((v) => v.phase === 'reveal');
  for (let i = 0; i < 10; i++) g.host.action({ type: 'next' });
  await g.host.waitView((v) => v.round === 2);
  await sleep(200);
  assert.equal(g.host.view.round, 2);
  assert.equal(g.host.view.phase, 'play');
  assertClean(g);
});

test('yarış: casus tahmin eder, aynı ms\'de köylü suçlar ve başka biri oy verir', async () => {
  const g = await setupGame(5);
  const spy = g.spies[0];
  spy.action({ type: 'guess', locationId: g.town[0].view.me.location.id });
  g.town[0].action({ type: 'accuse', targetId: spy.playerId });
  g.town[1].action({ type: 'vote', yes: true });
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.reason, 'guess');
  await sleep(100);
  assert.equal(g.host.view.phase, 'reveal');
  assertClean(g);
});

test('yarış: 15 bot aynı anda 1 kişilik odaya katılır → tam 12, kalanlar "Oda dolu"', async () => {
  const [host] = await makeBots(srv.wsUrl, 1, 'Dolu');
  const crowd = await makeBots(srv.wsUrl, 15, 'Kalabalık');
  all.push(host, ...crowd);
  const code = await host.create('spyfall');
  const results = await Promise.allSettled(crowd.map((b) => b.join(code)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 11);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => /dolu/.test(r.reason.message)));
  const room = await host.waitRoom((r) => r.players.length === 12);
  assert.equal(room.players.length, 12);
});

test('yarış: aynı hedefe kick + leave aynı anda, start + 2 ayrılma aynı anda (3 kişi)', async () => {
  const r1 = await makeRoom(srv.wsUrl, 'spyfall', 4, 'Yr');
  all.push(...r1.bots);
  r1.host.send({ t: 'kick', playerId: r1.bots[3].playerId });
  r1.bots[3].send({ t: 'leave' });
  await r1.host.waitRoom((r) => r.players.length === 3);
  await sleep(100);
  r1.host.send({ t: 'start' });
  r1.bots[1].send({ t: 'leave' });
  r1.bots[2].send({ t: 'leave' });
  await sleep(300);
  const room = r1.host.room;
  assert.equal(room.players.length, 1);
  assert.ok(['lobby', 'over'].includes(room.phase), `tek kişiyle oyun sürmemeli: ${room.phase}`);
  const errs = r1.bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal'));
  assert.deepEqual(errs, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Bulgu: izleyici host olunca tur ilerletilemez (BUG adayı, bkz. rapor).
test('host ayrılınca oda sahipliği izleyiciye değil oyuncuya geçer; sonraki tura geçilebilir (B2)', async () => {
  // A (host), D, B, C, E katılır. D kopar → A oyunu A,B,C,E ile başlatır (D izleyici). D döner. A ayrılır → host D (izleyici).
  const bots = await makeBots(srv.wsUrl, 5, 'Iz');
  all.push(...bots);
  const [A, D, B, C, E] = bots;
  const code = await A.create('spyfall');
  for (const b of [D, B, C, E]) await b.join(code);
  A.send({ t: 'settings', settings: { rounds: 3, minutes: 15 } });
  await A.waitRoom((r) => r.settings.rounds === 3 && r.players.length === 5);
  D.drop();
  await A.waitRoom((r) => r.players.find((p) => p.id === D.playerId)?.connected === false);
  A.send({ t: 'start' });
  await A.waitRoom((r) => r.phase === 'playing');
  await D.connect();
  await A.waitRoom((r) => r.players.find((p) => p.id === D.playerId)?.connected === true);
  const players = [A, B, C, E];
  await Promise.all(players.map((b) => b.waitView((v) => v.phase === 'play')));
  if (A.view.me.spy) return; // casus ayrılırsa tur iptal olur; senaryo başka yoldan aynı sonuca varır
  A.send({ t: 'leave' });
  const room = await B.waitRoom((r) => r.players.length === 4);
  // Düzeltme sonrası: host izleyici D'ye değil, en eski oyuncuya (B) geçer.
  assert.notEqual(room.hostId, D.playerId, 'host izleyiciye geçmemeli');
  assert.equal(room.hostId, B.playerId);
  const spy = [B, C, E].find((b) => b.view.me.spy);
  const town = [B, C, E].find((b) => !b.view.me.spy);
  await spy.act({ type: 'guess', locationId: town.view.me.location.id });
  await B.waitView((v) => v.phase === 'reveal');
  D.action({ type: 'next' });
  B.action({ type: 'next' });
  await sleep(300);
  const errs = [D, B].map((b) => b.errors.at(-1)?.message);
  assert.equal(B.view.round, 2, `kimse sonraki tura geçemiyor: D="${errs[0]}", B="${errs[1]}"`);
});
