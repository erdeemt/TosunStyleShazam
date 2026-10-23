// Vampir Köylü kaos senaryoları: gece/yargılama/oylama sırasında yeniden bağlanma fırtınası, yargılama ortasında host ayrılması
// (host devri), savunmada sanığın ayrılması, oylamada seçmenin ayrılması, son vampirin ayrılması, kick (oyun içinde sadece
// kopuk oyuncu), oyun ortasında izleyici / geri dönen eski oyuncu, aynı milisaniyede yarışan eylemler.
// Her senaryoda VampirReferee her mesajı denetler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom, Bot, sleep } from '../lib/bot.js';
import { startProbedServer, createRng, until } from './swarm-lib.mjs';
import { VampirReferee, vampMonkey, setupVampir, livingBots, playNight, startTrialOn, summarizeV, FAST, observerOf } from './swarm-vampir-lib.mjs';

// TIME_SCALE=0.05 → gece 120 sn = 6 sn, gündüz 8 dk = 24 sn, savunma 60 sn = 3 sn, oylama 30 sn = 1.5 sn, koltuk 6 sn, host devri 0.75 sn
const SCALE = 0.05;
let srv;
const all = [];
before(async () => { srv = await startProbedServer({ timeScale: SCALE, seed: 41 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function game(n, settings = {}, prefix = 'C') {
  const g = await setupVampir(srv.wsUrl, makeRoom, n, settings, prefix);
  all.push(...g.bots);
  return g;
}
const assertClean = (g) => {
  const v = g.ref.finalChecks();
  assert.deepEqual(v, [], v.join('\n'));
  assert.deepEqual(g.bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal')), []);
};
// Kimse ölmeden gündüze geç (vampirler X'i seçer, doktor X'i korur).
async function quietNight(g) {
  const x = g.bots.find((b) => b.view.me.role === 'koylu' && livingBots(g).includes(b));
  return playNight(g, { victim: x, protect: x });
}
const others = (g, ...ex) => livingBots(g).filter((b) => !ex.includes(b));
// Host olmayan yaşayanlar (host'u ayrılan/atılan olarak kullanmamak için)
const byRole = (g, ...roles) => livingBots(g).filter((b) => b !== g.host && roles.includes(b.view.me.role));

// ---------------------------------------------------------------------------------------------------------------

test('yeniden bağlanma fırtınası: 8 ve 10 kişi monkey oyun, gece/yargılama/oylamada 1–3 kişi (host dahil) aynı anda düşüp geri gelir', async () => {
  const storm = await startProbedServer({ timeScale: 0.02, seed: 43 }); // koltuk 2.4 sn, host devri 0.3 sn
  const bots = [];
  try {
    const run = async (n, seed) => {
      const room = await makeRoom(storm.wsUrl, 'vampir', n, `F${n}-`);
      bots.push(...room.bots);
      const s = { ...FAST, vampires: 0 };
      const ref = new VampirReferee({ label: `storm n=${n} ${room.code}`, clockTolerance: 120 }).attachAll(room.bots);
      room.host.send({ t: 'settings', settings: s });
      await room.host.waitRoom((r) => r.settings.nightSeconds === FAST.nightSeconds);
      const stop = { done: false };
      const rng = createRng(seed);
      const loops = room.bots.map((b, i) => vampMonkey(b, { rng: createRng(seed + i), stop }));
      room.host.send({ t: 'start' });
      const stats = { drops: 0, hostDrops: 0, byPhase: {}, seat: [] };
      const chaos = (async () => {
        while (!stop.done) {
          await sleep(120 + rng.int(250));
          const phase = room.bots.find((b) => b.isOpen)?.view?.phase;
          if (!phase || phase === 'over') continue;
          const k = ['night', 'trial', 'trialVote'].includes(phase) ? 1 + rng.int(3) : rng.next() < 0.4 ? 1 : 0;
          const victims = [...new Set(Array.from({ length: k }, () => (rng.next() < 0.25 ? room.bots[0] : rng.pick(room.bots))))].filter((b) => b.isOpen && b.view?.me);
          await Promise.all(victims.map(async (b) => {
            const before = { id: b.playerId, role: b.view.me.role, allies: JSON.stringify(b.view.me.allies ?? null), gameKey: b.view.gameKey };
            b.drop();
            stats.drops++;
            stats.byPhase[phase] = (stats.byPhase[phase] ?? 0) + 1;
            if (b === room.bots[0]) stats.hostDrops++;
            await sleep(20 + rng.int(230));
            await b.connect().catch(() => b.connect());
            const v = await b.waitView(() => true, { timeout: 3000 }).catch(() => null);
            if (v?.me && v.gameKey === before.gameKey) stats.seat.push([before, { id: b.playerId, role: v.me.role, allies: JSON.stringify(v.me.allies ?? null) }, b.name]);
          }));
        }
      })();
      try {
        await until(() => room.bots.some((b) => b.room?.phase === 'over'), { timeout: 60_000, what: `n=${n} oyun bitmedi` });
      } finally {
        stop.done = true;
        await Promise.all([...loops, chaos]);
      }
      for (const [a, b, name] of stats.seat) assert.deepEqual(b, { id: a.id, role: a.role, allies: a.allies }, `${name}: yeniden bağlanınca aynı koltuk/rol/müttefikler`);
      await until(() => room.bots.every((b) => b.isOpen) && room.host.room?.players.every((p) => p.connected), { timeout: 3000, what: 'herkes bağlı' });
      const r = room.host.room;
      assert.equal(r.players.length, n, 'kısa kopmalarda kimse koltuğunu kaybetmemeli');
      assert.ok(r.players.some((p) => p.id === r.hostId && p.connected), 'host bağlı biri olmalı');
      await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'over', { timeout: 3000 })));
      const v = ref.finalChecks();
      console.log(`${summarizeV(ref)} drops=${stats.drops} hostDrops=${stats.hostDrops} byPhase=${JSON.stringify(stats.byPhase)} seatChecks=${stats.seat.length}`);
      assert.deepEqual(v, [], v.join('\n'));
      assert.ok(stats.drops >= 5, `yeterince kopma olmalı (${stats.drops})`);
    };
    const res = await Promise.allSettled([run(8, 500), run(10, 900)]);
    for (const r of res) if (r.status === 'rejected') throw r.reason;
    assert.doesNotMatch(storm.log(), /hatası/);
  } finally {
    bots.forEach((b) => b.close());
    await storm.stop();
  }
});

test('host savunma sırasında ayrılır (seçmen): oda sahipliği en eski bağlı oyuncuya geçer, yargılama sürer, yeni host geceyi geçirebilir', async () => {
  const g = await game(7, { deli: false });
  await quietNight(g);
  const target = byRole(g, 'koylu').find((b) => b !== g.host);
  const nominator = others(g, g.host, target)[0];
  const supporter = others(g, g.host, target, nominator)[0];
  await startTrialOn(g, target, { nominator, supporter });
  g.host.leave();
  const room = await nominator.waitRoom((r) => !r.players.some((p) => p.id === g.host.playerId));
  assert.equal(room.hostId, g.bots[1].playerId, 'en eski bağlı oyuncu host olmalı');
  const v = await nominator.waitView((x) => x.players.find((p) => p.id === g.host.playerId)?.death?.cause === 'left');
  if (v.phase === 'over') return assertClean(g); // host tek vampirse oyun biter
  assert.equal(v.phase, 'trial');
  assert.equal(v.trial.voterCount, livingBots(g).filter((b) => b !== target && b !== g.host).length);
  target.action({ type: 'endDefense' });
  await nominator.waitView((x) => x.phase === 'trialVote');
  for (const b of others(g, target, g.host)) b.action({ type: 'trialVote', yes: false });
  const day = await nominator.waitView((x) => x.phase === 'day');
  assert.equal(day.lastTrial.hanged, false);
  const newHost = g.bots[1];
  newHost.action({ type: 'endDay' });
  await nominator.waitView((x) => x.phase === 'night' && x.night === 2);
  assertClean(g);
});

test('sanık (host) savunmada ayrılır: yargılama düşer, gün saati kaldığı yerden sürer, host devredilir', async () => {
  const g = await game(8, { vampires: 2 });
  await quietNight(g);
  const hostRole = g.host.view.me.role;
  const watcher = others(g, g.host)[0];
  await startTrialOn(g, g.host, { nominator: others(g, g.host)[1], supporter: others(g, g.host)[2] });
  await sleep(200);
  g.host.leave();
  const v = await watcher.waitView((x) => x.phase !== 'trial');
  assert.equal(v.phase, 'day', `sanık ayrılınca gündüze dönmeli (host rolü ${hostRole})`);
  assert.equal(v.lastTrial, null, 'yargılama sonucu yazılmamalı');
  assert.equal(v.players.find((p) => p.id === g.host.playerId).death.cause, 'left');
  assert.notEqual(watcher.room.hostId, g.host.playerId);
  assert.ok(g.ref.stats.clockChecks > 0, 'gün saati devam kontrolü yapılmalı');
  assertClean(g);
});

test('sanık oylama sırasında ayrılır → gündüz sürer; seçmenler oylamada ayrılır: oyları silinir, son oy vermeyen ayrılınca oylama hemen çözülür', async () => {
  // 1) sanık oylamada ayrılır
  const g = await game(9, { vampires: 1 });
  await quietNight(g);
  const t1 = byRole(g, 'koylu')[0];
  await startTrialOn(g, t1);
  t1.action({ type: 'endDefense' });
  await observerOf(g).waitView((x) => x.phase === 'trialVote');
  others(g, t1)[0].action({ type: 'trialVote', yes: true });
  await observerOf(g).waitView((x) => x.trial?.votedCount === 1);
  t1.leave();
  const v1 = await observerOf(g).waitView((x) => x.phase !== 'trialVote');
  assert.equal(v1.phase, 'day');
  assert.equal(v1.lastTrial, null);

  // 2) yeni yargılama: 8 yaşayan, sanık hariç 7 seçmen. 3 Evet + 3 Hayır, oy vermeyen 1 kişi ayrılır → 3/6 → asılmaz.
  //    Sonra 3. yargılama yok (bugünkü haklar); ayrı bir kontrol: Evet veren ayrılırsa oyu silinir.
  const alive = livingBots(g);
  const nonVamp = alive.filter((b) => b.view.me.role !== 'vampir');
  const t2 = nonVamp.find((b) => b.view.me.role === 'koylu') ?? nonVamp[0];
  const voters = others(g, t2);
  const canNom = voters.filter((b) => b.view.me.canNominate);
  await startTrialOn(g, t2, { nominator: canNom[0], supporter: canNom[1] });
  t2.action({ type: 'endDefense' });
  await observerOf(g).waitView((x) => x.phase === 'trialVote');
  const leaver = voters.filter((b) => b.view.me.role !== 'vampir' && b !== g.host).at(-1);
  const rest = voters.filter((b) => b !== leaver);
  rest.forEach((b, i) => b.action({ type: 'trialVote', yes: i % 2 === 0 }));
  await observerOf(g).waitView((x) => x.trial?.votedCount === rest.length);
  const yes = rest.filter((_, i) => i % 2 === 0).length;
  leaver.leave();
  const v2 = await observerOf(g).waitView((x) => x.phase !== 'trialVote');
  assert.deepEqual(v2.lastTrial, { targetId: t2.playerId, hanged: yes * 2 > rest.length, yes, voters: rest.length }, 'oylama kalanlarla hemen çözülmeli');
  assertClean(g);
});

test('Evet veren seçmen oylamada ayrılır: oyu sayılmaz (çoğunluk düşer)', async () => {
  const g = await game(7, { vampires: 1, deli: false });
  await quietNight(g);
  const t = byRole(g, 'koylu')[0];
  await startTrialOn(g, t);
  t.action({ type: 'endDefense' });
  await observerOf(g).waitView((x) => x.phase === 'trialVote');
  const voters = others(g, t); // 6 seçmen
  const nonVampVoters = voters.filter((b) => b.view.me.role !== 'vampir' && b !== g.host);
  const yesVoters = [...nonVampVoters.slice(0, 4)]; // 4 Evet
  for (const b of yesVoters) b.action({ type: 'trialVote', yes: true });
  await observerOf(g).waitView((x) => x.trial?.votedCount === 4);
  yesVoters[0].leave(); // 3 Evet / 5 seçmen kalır → hâlâ çoğunluk; bir Evet daha giderse 2/4 → asılmaz
  await observerOf(g).waitView((x) => x.trial?.voterCount === 5 && x.trial.votedCount === 3);
  yesVoters[1].leave();
  await observerOf(g).waitView((x) => x.trial?.voterCount === 4 || x.phase === 'over');
  if (observerOf(g).view.phase === 'over') return assertClean(g);
  for (const b of others(g, t).filter((b) => b.view.trial.myVote == null)) b.action({ type: 'trialVote', yes: false });
  const v = await observerOf(g).waitView((x) => x.phase !== 'trialVote');
  assert.equal(v.lastTrial.yes, 2);
  assert.equal(v.lastTrial.voters, 4);
  assert.equal(v.lastTrial.hanged, false);
  assertClean(g);
});

test('son vampir ayrılır: ilk vampir gece ayrılınca oyun sürer (gece sayacı düşer), ikincisi oylamada ayrılınca köy hemen kazanır', async () => {
  const g = await game(8, { vampires: 2 });
  const [v1, v2] = g.vamps;
  const watcher = others(g, v1, v2)[0];
  const before = watcher.view.nightProgress.total;
  v1.leave();
  const a = await watcher.waitView((x) => x.nightProgress?.total === before - 1);
  assert.equal(a.phase, 'night');
  await quietNight(g);
  const t = byRole(g, 'koylu')[0];
  await startTrialOn(g, t, { nominator: others(g, t, v2)[0], supporter: others(g, t, v2)[1] });
  t.action({ type: 'endDefense' });
  await watcher.waitView((x) => x.phase === 'trialVote');
  v2.leave();
  const over = await watcher.waitView((x) => x.phase === 'over');
  assert.equal(over.result.winner, 'town');
  assert.equal(over.players.find((p) => p.id === v2.playerId).death.cause, 'left');
  assertClean(g);
});

test('kick: oyun sırasında bağlı oyuncu atılamaz; kopuk vampir gece atılır → ayrılmış sayılır; kopuk sanık oylamada atılır → gündüz sürer; atılan görünüm almaz', async () => {
  const g = await game(10, { vampires: 3 });
  const [v1] = g.vamps;
  const watcher = byRole(g, 'koylu')[0];
  const errP = g.host.waitFor((m) => m.t === 'error');
  g.host.send({ t: 'kick', playerId: watcher.playerId });
  assert.match((await errP).message, /bağlantısı kopmuş/);
  if (v1 !== g.host) {
    v1.drop();
    await watcher.waitRoom((r) => r.players.find((p) => p.id === v1.playerId)?.connected === false);
    g.host.send({ t: 'kick', playerId: v1.playerId });
    const v = await watcher.waitView((x) => x.players.find((p) => p.id === v1.playerId)?.death?.cause === 'left');
    assert.equal(v.phase, 'night');
    const n0 = v1.messages.length;
    await quietNight(g);
    assert.equal(v1.messages.length, n0, 'atılan oyuncu görünüm almamalı');
  } else {
    await quietNight(g);
  }
  // kopuk sanık oylamada atılır
  const t = byRole(g, 'koylu').find((b) => b !== g.host && b !== watcher);
  await startTrialOn(g, t, { nominator: watcher, supporter: others(g, t, watcher, g.host)[0] });
  t.action({ type: 'endDefense' });
  await watcher.waitView((x) => x.phase === 'trialVote');
  t.drop();
  await watcher.waitRoom((r) => r.players.find((p) => p.id === t.playerId)?.connected === false);
  g.host.send({ t: 'kick', playerId: t.playerId });
  const d = await watcher.waitView((x) => x.phase !== 'trialVote');
  assert.equal(d.phase, 'day');
  assert.equal(d.players.find((p) => p.id === t.playerId).death.cause, 'left');
  // ölü (zaten kopuk) oyuncuyu atmak durumu değiştirmez
  assertClean(g);
});

test('geri dönen eski oyuncu izleyici olur: kendi (ölü) rolünü görür, başka sır görmez, eylem yapamaz; yeni izleyici me=null', async () => {
  const g = await game(8, { vampires: 2 });
  const leaver = byRole(g, 'koylu')[0];
  leaver.leave();
  await g.host.waitView((x) => x.players.find((p) => p.id === leaver.playerId)?.death?.cause === 'left');
  await leaver.join(g.code);
  const v = await leaver.waitView(() => true);
  assert.equal(v.me.role, 'koylu');
  assert.equal(v.me.alive, false);
  assert.equal(v.me.nightTargets, undefined);
  const e = await leaver.expectError({ type: 'nightPick', targetId: g.vamps[0].playerId });
  assert.match(e.message, /İzleyiciler/);
  const fresh = await new Bot(srv.wsUrl, 'Yeni').connect();
  all.push(fresh);
  g.ref.attach(fresh);
  await fresh.join(g.code);
  assert.equal((await fresh.waitView(() => true)).me, null);
  assert.match((await fresh.expectError({ type: 'support' })).message, /İzleyiciler/);
  await quietNight(g);
  assertClean(g);
});

// ---------- Yarışlar ----------

test('yarış: tüm gece seçimleri aynı ms\'de (vampirler farklı hedefler + tekrar seçim) → tek çözüm, tek duyuru', async () => {
  const g = await game(12, { vampires: 3 });
  const targets = byRole(g, 'koylu').map((b) => b.playerId);
  for (const b of livingBots(g)) {
    const me = b.view.me;
    if (me.role === 'vampir') {
      b.action({ type: 'nightPick', targetId: targets[0] });
      b.action({ type: 'nightPick', targetId: targets[g.vamps.indexOf(b) + 1] }); // fikir değiştirir: üç farklı hedef → eşitlik
    } else b.action({ type: 'nightPick', targetId: me.nightTargets.find((id) => id !== b.playerId && !targets.slice(0, 4).includes(id)) ?? me.nightTargets[0] });
  }
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'day')));
  const transitions = g.host.messages.filter((m) => m.t === 'view' && m.view.phase === 'day').length;
  assert.ok(transitions >= 1);
  const ann = new Set(g.bots.map((b) => JSON.stringify(b.view.announcement)));
  assert.equal(ann.size, 1);
  const dead = g.host.view.announcement.deadId;
  assert.ok(targets.slice(1, 4).includes(dead), 'eşitlikte kurban eşitler arasından seçilmeli');
  assertClean(g);
});

test('yarış: birden çok destek + savunmayı bitir aynı ms\'de → tek yargılama; nominate yarışı → biri kabul, diğerinin hakkı yanmaz', async () => {
  const g = await game(9, { vampires: 2 });
  await quietNight(g);
  const alive = livingBots(g);
  const [a, b] = alive;
  const target = alive.at(-1);
  a.action({ type: 'nominate', targetId: target.playerId });
  b.action({ type: 'nominate', targetId: target.playerId });
  await g.host.waitView((v) => v.nomination);
  await sleep(100);
  const nom = g.host.view.nomination;
  const loser = nom.byId === a.playerId ? b : a;
  assert.ok(loser.errors.some((e) => /bekleyen bir aday/.test(e.message)));
  assert.equal(loser.view.me.canNominate, true, 'reddedilenin aday hakkı yanmamalı');
  const supporters = alive.filter((x) => x !== a && x !== b && x !== target);
  for (const s of supporters) s.action({ type: 'support' });
  target.action({ type: 'endDefense' });
  await g.host.waitView((v) => v.phase === 'trial' || v.phase === 'trialVote');
  await sleep(150);
  const trials = g.host.messages.filter((m) => m.t === 'view' && m.view.phase === 'trial').length;
  assert.ok(trials >= 1);
  const supportErrors = supporters.flatMap((s) => s.errors).filter((e) => /destek/.test(e.message)).length;
  assert.equal(supportErrors, supporters.length - 1, 'sadece ilk destek yargılama başlatmalı');
  assert.ok(['trial', 'trialVote'].includes(g.host.view.phase));
  assertClean(g);
});

test('yarış: oylama süresi dolarken oylar gelir → tek sonuç; Evet sayısı kabul edilen Evet oylarına eşit', async () => {
  const g = await game(10, { vampires: 2 });
  await quietNight(g);
  const t = livingBots(g).at(-1);
  await startTrialOn(g, t);
  t.action({ type: 'endDefense' });
  const tv = await g.host.waitFor((m) => m.t === 'view' && m.view.phase === 'trialVote');
  const voters = others(g, t);
  const marks = new Map(voters.map((b) => [b, b.errors.length]));
  // süre: 30 sn × 0.05 = 1.5 sn; son ~5 ms'de herkes aynı anda Evet
  await sleep(Math.max(0, tv.view.endsAt - tv.serverNow - 5));
  for (const b of voters) b.action({ type: 'trialVote', yes: true });
  const v = await g.host.waitView((x) => x.phase !== 'trialVote');
  await sleep(150);
  const rejected = voters.filter((b) => b.errors.slice(marks.get(b)).some((e) => /oylama yok|zaten/.test(e.message))).length;
  console.log(`oylama/süre yarışı: kabul=${voters.length - rejected}, reddedilen=${rejected}, sonuç=${JSON.stringify(v.lastTrial)}`);
  assert.equal(v.lastTrial.yes, voters.length - rejected, 'Evet sayısı = kabul edilen oylar');
  const resolutions = new Set(g.host.messages.filter((m) => m.t === 'view' && m.view.lastTrial).map((m) => JSON.stringify(m.view.lastTrial)));
  assert.equal(resolutions.size, 1, 'tek sonuç');
  assertClean(g);
});

test('yarış: geceye geç + destek aynı ms\'de → bekleyen aday varken gün bitmez, tek yargılama; 10× geceye geç → gece tam 1 artar', async () => {
  const g = await game(8, { vampires: 2 });
  await quietNight(g);
  const [a, , c] = others(g, g.host);
  const target = others(g, g.host, a, c)[0];
  await a.act({ type: 'nominate', targetId: target.playerId });
  g.host.action({ type: 'endDay' });
  c.action({ type: 'support' });
  await g.host.waitView((v) => v.phase !== 'day');
  await sleep(100);
  assert.equal(g.host.view.phase, 'trial', 'destek kazanmalı (bekleyen adayla gün bitirilemez)');
  assert.equal(g.host.view.night, 1);
  // savunma + oylama → asılmaz, gündüz sürer; sonra host 10 kez aynı anda geceye geçer
  target.action({ type: 'endDefense' });
  await g.host.waitView((v) => v.phase === 'trialVote');
  for (const b of others(g, target)) b.action({ type: 'trialVote', yes: false });
  await g.host.waitView((v) => v.phase === 'day');
  for (let i = 0; i < 10; i++) g.host.action({ type: 'endDay' });
  await g.host.waitView((v) => v.phase === 'night');
  await sleep(150);
  assert.equal(g.host.view.night, 2, 'gece tam 1 artmalı');
  assert.equal(g.host.errors.filter((e) => /gündüz tartışması yok/.test(e.message)).length >= 9, true);
  assertClean(g);
});

test('yarış: gece son seçim + bir oyuncunun ayrılması aynı ms\'de; savunma süresi dolarken savunmayı bitir', async () => {
  const g = await game(9, { vampires: 2 });
  const victim = byRole(g, 'koylu')[0];
  const leaver = byRole(g, 'koylu')[1];
  for (const b of livingBots(g)) {
    if (b === leaver) continue;
    const me = b.view.me;
    const t = me.role === 'vampir' ? victim.playerId : me.nightTargets.find((id) => id !== b.playerId && id !== victim.playerId);
    b.action({ type: 'nightPick', targetId: t });
  }
  leaver.leave();
  const day = await g.host.waitView((v) => v.phase !== 'night');
  assert.equal(day.phase, 'day');
  assert.equal(day.announcement.deadId, victim.playerId);
  // savunma süresi (60 sn × 0.05 = 3 sn) dolarken sanık bitirir
  const t = others(g)[0];
  await startTrialOn(g, t);
  const tr = g.host.messages.findLast((m) => m.t === 'view' && m.view.phase === 'trial');
  await sleep(Math.max(0, tr.view.endsAt - tr.serverNow - 3));
  t.action({ type: 'endDefense' });
  t.action({ type: 'endDefense' });
  await g.host.waitView((v) => v.phase === 'trialVote');
  await sleep(100);
  assert.equal(g.host.view.phase, 'trialVote');
  assertClean(g);
});

// ---------- Kural kenarları (bulgular) ----------

test('aday destek süresi dolunca düşer ve bu herkese yayınlanır (kimse eylem yapmasa da)', async () => {
  const g = await game(6, { vampires: 1 });
  await quietNight(g);
  const [a, b] = livingBots(g);
  await a.act({ type: 'nominate', targetId: b.playerId });
  const nom = a.view.nomination;
  assert.ok(nom);
  await b.waitView((x) => x.nomination);
  // 30 sn × 0.05 = 1.5 sn sonra adayın düştüğü görünüm gelmeli
  const v = await b.waitView((x) => x.phase === 'day' && x.nomination === null, { timeout: 3000 });
  assert.equal(v.nomination, null);
  assert.ok(Date.now() >= nom.expiresAt - 50);
  assertClean(g);
});

test('gece: vampirlerin seçtiği kişi ayrılırsa öldürme hakkı sessizce yanmamalı (gece hemen çözülüp "kimse ölmedi" olmamalı)', async () => {
  const g = await game(8, { vampires: 2 });
  const target = byRole(g, 'koylu')[0];
  const watcher = byRole(g, 'koylu')[1];
  for (const b of livingBots(g)) {
    if (b === target) continue;
    const me = b.view.me;
    const t = me.role === 'vampir' ? target.playerId : me.nightTargets.find((id) => id !== b.playerId && id !== target.playerId);
    b.action({ type: 'nightPick', targetId: t });
  }
  await watcher.waitView((v) => v.nightProgress?.done === 7);
  target.leave(); // son seçmeyen + vampirlerin hedefi
  const v = await watcher.waitView((x) => x.phase !== 'night' || x.nightProgress.total === 7);
  // Beklenen: vampirler yeniden seçebilsin (gece sürsün) ya da kayıp ayrılan kişi sayılmasın; gerçekleşen: gece biter, kimse ölmez
  assert.equal(v.phase, 'night', `gece hemen çözüldü: duyuru=${JSON.stringify(v.announcement)}`);
});

test('host oyun sürerken "bekleme odasına dön" ile oyunu iptal edememeli (PLAN §3.3: sadece oyun bitince)', async () => {
  const g = await game(6, { vampires: 1 });
  const errP = g.host.waitFor((m) => m.t === 'error' || (m.t === 'room' && m.room?.phase === 'lobby'));
  g.host.send({ t: 'backToLobby' });
  const m = await errP;
  assert.equal(m.t, 'error', `oyun ortasında lobiye dönüldü (oda fazı: ${m.room?.phase})`);
});

test('gündüz: aynı anda tek aday — bekleyen aday varken yeni aday reddedilir (PLAN §4.3 güncel kural)', async () => {
  const g = await game(6, { vampires: 1 });
  await quietNight(g);
  const [a, b, c, d] = livingBots(g);
  await a.act({ type: 'nominate', targetId: b.playerId });
  await c.waitView((x) => x.nomination);
  const p = c.waitFor((m) => m.t === 'error' || (m.t === 'view' && m.view.nomination?.targetId === d.playerId));
  c.action({ type: 'nominate', targetId: d.playerId });
  const r = await p;
  assert.equal(r.t, 'error', 'bekleyen aday varken yeni aday kabul edildi');
  assert.match(r.message, /bekleyen bir aday/);
});
