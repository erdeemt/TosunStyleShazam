// Vampir Köylü sürü testleri: rol dağılımı, gizlilik, gece/gündüz akışı, yargılama, kazanma koşulları.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.01 }); }); // gece 60 sn ≈ 0.6 sn
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function setup(n, settings = {}) {
  const room = await makeRoom(srv.wsUrl, 'vampir', n, 'Köylü');
  all.push(...room.bots);
  // Uzun gece/gündüz: testler süreye değil eylemlere göre ilerlesin.
  room.host.send({ t: 'settings', settings: { nightSeconds: 120, dayMinutes: 8, ...settings } });
  await room.host.waitRoom((r) => r.settings.nightSeconds === (settings.nightSeconds ?? 120));
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'night' && v.night === 1)));
  const by = (role) => room.bots.filter((b) => b.view.me.role === role);
  return { ...room, by, vamps: by('vampir') };
}

const living = (g) => g.bots.filter((b) => b.view.players.find((p) => p.id === b.playerId).alive);

// Geceyi oynat: vampirler victim'ı, doktor protect'i seçer; diğerleri izin verilen ilk kişiyi.
async function playNight(g, { victim, protect, peek } = {}) {
  const night = g.host.view.night;
  for (const b of living(g)) {
    const role = b.view.me.role;
    let target = b.view.me.nightTargets[0];
    if (role === 'vampir' && victim) target = victim.playerId;
    if (role === 'doktor') target = protect ? protect.playerId : b.view.me.nightTargets.find((id) => id !== victim?.playerId) ?? target; // kasıtsız kurtarma olmasın
    if (role === 'gozcu' && peek) target = peek.playerId;
    b.action({ type: 'nightPick', targetId: target });
  }
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase !== 'night' || v.night > night)));
  return g.host.view;
}

async function hang(g, target, { yes = true } = {}) {
  const voters = living(g).filter((b) => b !== target);
  const [nominator, supporter] = voters;
  await nominator.act({ type: 'nominate', targetId: target.playerId });
  supporter.action({ type: 'support' });
  await g.host.waitView((v) => v.phase === 'trial');
  target.action({ type: 'endDefense' });
  await g.host.waitView((v) => v.phase === 'trialVote');
  for (const v of voters) v.action({ type: 'trialVote', yes });
  return g.host.waitView((v) => v.phase !== 'trialVote');
}

// Oyun bitmeden: kimse kendi rolü dışında rol görmemeli (vampirler birbirini görür).
function assertSecrets(g) {
  const vampIds = new Set(g.vamps.map((b) => b.playerId));
  for (const b of g.bots) {
    for (const m of b.messages) {
      if (m.t !== 'view' || m.view.result) continue;
      const v = m.view;
      assert.ok(v.players.every((p) => !('role' in p)), 'oyuncu listesinde rol var');
      const isVamp = v.me.role === 'vampir';
      if (!isVamp) {
        assert.equal(v.me.allies, undefined, 'vampir olmayan müttefik listesi gördü');
        assert.equal(v.me.allyPicks, undefined);
      } else {
        assert.ok(v.me.allies.every((id) => vampIds.has(id)));
      }
      if (v.me.role !== 'gozcu') assert.equal(v.me.seerResults, undefined, 'gözcü olmayan sonuç gördü');
      if (v.me.role !== 'doktor') assert.equal(v.me.lastProtected, undefined, 'doktor olmayan koruma bilgisini gördü');
      assert.ok(!('log' in v) && !('winner' in v));
    }
  }
}

for (const [n, vamps] of [[5, 1], [7, 1], [8, 2], [10, 2], [11, 3], [12, 3]]) {
  test(`${n} kişi: ${vamps} vampir + doktor + gözcü + deli; vampirler birbirini bilir`, async () => {
    const g = await setup(n);
    assert.equal(g.vamps.length, vamps);
    assert.equal(g.by('doktor').length, 1);
    assert.equal(g.by('gozcu').length, 1);
    assert.equal(g.by('deli').length, 1);
    for (const v of g.vamps) assert.equal(v.view.me.allies.length, vamps - 1);
    assert.deepEqual(g.host.view.roleCounts.vampir, vamps);
    assertSecrets(g);
  });
}

test('roller kapatılabilir, vampir sayısı elle seçilebilir ama yarıdan az kalır', async () => {
  const g = await setup(6, { doktor: false, gozcu: false, deli: false, vampires: 3 });
  assert.equal(g.vamps.length, 2, '6 kişide en fazla 2 vampir');
  assert.equal(g.by('koylu').length, 4);
});

test('gece: vampir kurbanı ölür, rol açıklanmaz; doktor kurtarırsa kimse ölmez', async () => {
  const g = await setup(8);
  const victim = g.by('koylu')[0];
  let v = await playNight(g, { victim });
  assert.equal(v.phase, 'day');
  assert.equal(v.announcement.deadId, victim.playerId);
  assert.equal(JSON.stringify(v.announcement).includes('koylu'), false);
  assert.equal(v.players.find((p) => p.id === victim.playerId).alive, false);

  // 2. gece: doktor kurbanı korur
  g.host.send({ t: 'action', action: { type: 'endDay' } });
  await Promise.all(g.bots.map((b) => b.waitView((x) => x.phase === 'night' && x.night === 2)));
  // Doktor dün gece koruduğu kişiyi tekrar koruyamaz; ona uymayan bir köylü seç.
  const doc = g.by('doktor')[0];
  const victim2 = g.by('koylu').find((b) => b !== victim && b.playerId !== doc.view.me.lastProtected);
  v = await playNight(g, { victim: victim2, protect: victim2 });
  assert.equal(v.announcement.deadId, null);
  assert.ok(v.players.find((p) => p.id === victim2.playerId).alive);
  assertSecrets(g);
});

test('doktor aynı kişiyi üst üste koruyamaz; vampir vampiri seçemez; gözcü tek bakış + doğru sonuç', async () => {
  const g = await setup(8);
  const doc = g.by('doktor')[0];
  const seer = g.by('gozcu')[0];
  const target = g.by('koylu')[0];
  if (g.vamps.length > 1) {
    const err = await g.vamps[0].expectError({ type: 'nightPick', targetId: g.vamps[1].playerId });
    assert.match(err.message, /seçemezsin/);
  }
  await seer.act({ type: 'nightPick', targetId: g.vamps[0].playerId });
  assert.deepEqual(seer.view.me.seerResults.map((r) => r.isVampire), [true]);
  assert.match((await seer.expectError({ type: 'nightPick', targetId: target.playerId })).message, /bakışını kullandın/);
  await playNight(g, { victim: g.by('deli')[0], protect: target });
  g.host.send({ t: 'action', action: { type: 'endDay' } });
  await doc.waitView((x) => x.phase === 'night' && x.night === 2);
  assert.ok(!doc.view.me.nightTargets.includes(target.playerId));
  assert.match((await doc.expectError({ type: 'nightPick', targetId: target.playerId })).message, /üst üste/);
});

test('yargılama: aday + destek + savunma + çoğunluk Evet → asılır, gece başlar; rol açıklanmaz', async () => {
  const g = await setup(8);
  await playNight(g, {});
  const target = g.by('koylu')[0];
  const v = await hang(g, target);
  assert.equal(v.phase, 'night');
  assert.equal(v.lastTrial.hanged, true);
  assert.equal(v.players.find((p) => p.id === target.playerId).death.cause, 'hanged');
  // ölü eylem yapamaz
  assert.match((await target.expectError({ type: 'nightPick', targetId: g.vamps[0].playerId })).message, /Ölüler/);
  assertSecrets(g);
});

test('yargılama: çoğunluk yoksa asılmaz, tartışma kaldığı yerden sürer; günde tek aday hakkı', async () => {
  const g = await setup(6);
  await playNight(g, {});
  const target = g.by('koylu')[0] ?? g.by('deli')[0];
  const before = g.host.view.endsAt;
  const v = await hang(g, target, { yes: false });
  assert.equal(v.phase, 'day');
  assert.equal(v.lastTrial.hanged, false);
  assert.ok(v.endsAt >= before - 100, 'tartışma saati yargılama sırasında durmalı');
  const nominator = living(g).filter((b) => b !== target)[0];
  assert.match((await nominator.expectError({ type: 'nominate', targetId: target.playerId })).message, /hakkını kullandın/);
  // kendini destekleyemez, aday kendine oy veremez
  const other = living(g).filter((b) => b !== target && b !== nominator)[0];
  await other.act({ type: 'nominate', targetId: target.playerId });
  assert.match((await other.expectError({ type: 'support' })).message, /destekleyemezsin/);
  assert.match((await target.expectError({ type: 'support' })).message, /destekleyemezsin/);
});

test('deli asılırsa tek başına kazanır', async () => {
  const g = await setup(6);
  await playNight(g, {});
  const deli = g.by('deli')[0];
  const v = await hang(g, deli);
  assert.equal(v.phase, 'over');
  assert.equal(v.result.winner, 'jester');
  assert.deepEqual(v.result.winnerIds, [deli.playerId]);
  assert.equal(v.result.roles[deli.playerId], 'deli');
});

test('tüm vampirler asılırsa köy kazanır', async () => {
  const g = await setup(5, { deli: false });
  await playNight(g, { victim: g.by('koylu')[0] });
  const v = await hang(g, g.vamps[0]);
  assert.equal(v.result.winner, 'town');
  assert.ok(!v.result.winnerIds.includes(g.vamps[0].playerId));
});

test('vampir sayısı köylülere eşitlenince vampirler kazanır', async () => {
  const g = await setup(5, { deli: false, doktor: false }); // 1 vampir, 4 köylü tarafı
  // 1. gece biri ölür (3 kaldı), gündüz bir masum asılır (2 kaldı), 2. gece biri ölür → 1 vampir vs 1
  await playNight(g, { victim: g.by('koylu')[0] });
  const innocents = () => living(g).filter((b) => b.view.me.role !== 'vampir');
  await hang(g, innocents()[0]);
  await Promise.all(g.bots.map((b) => b.waitView((x) => x.phase === 'night' && x.night === 2)));
  const v = await playNight(g, { victim: innocents()[0] });
  assert.equal(v.phase, 'over');
  assert.equal(v.result.winner, 'vampires');
});

test('süre dolarsa: gece kendiliğinden biter, gündüz kimse asılmadan geceye geçer', async () => {
  const room = await makeRoom(srv.wsUrl, 'vampir', 5, 'Süre');
  all.push(...room.bots);
  room.host.send({ t: 'settings', settings: { nightSeconds: 30, dayMinutes: 2 } }); // 0.3 sn / 1.2 sn
  await room.host.waitRoom((r) => r.settings.nightSeconds === 30);
  room.host.send({ t: 'start' });
  const day = await room.host.waitView((v) => v.phase === 'day', { timeout: 3000 });
  assert.equal(day.announcement.deadId, null, 'kimse seçmediyse kimse ölmez');
  const night2 = await room.host.waitView((v) => v.phase === 'night' && v.night === 2, { timeout: 4000 });
  assert.equal(night2.lastTrial, null);
});

test('yeniden bağlanma rolü korur; ayrılan oyuncu ölü sayılır ve kazanma kontrol edilir', async () => {
  const g = await setup(6, { deli: false });
  const b = g.by('koylu')[0];
  const role = b.view.me.role;
  const observer = g.bots.find((x) => x !== b && x !== g.vamps[0]);
  b.drop();
  await observer.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === false);
  await sleep(30);
  await b.connect();
  assert.equal((await b.waitView((v) => v.me)).me.role, role);
  // tek vampir ayrılırsa köy kazanır
  g.vamps[0].send({ t: 'leave' });
  const v = await observer.waitView((x) => x.phase === 'over');
  assert.equal(v.result.winner, 'town');
  assert.equal(v.players.find((p) => p.id === g.vamps[0].playerId).death.cause, 'left');
});

test('host olmayan geceye geçiremez; host ölü olsa da geçirebilir', async () => {
  const g = await setup(6);
  await playNight(g, { victim: g.host.view.me.role === 'vampir' ? g.by('koylu')[0] : g.host });
  const nonHost = living(g).find((b) => b !== g.host);
  assert.match((await nonHost.expectError({ type: 'endDay' })).message, /oda sahibi/);
  g.host.action({ type: 'endDay' });
  await g.host.waitView((v) => v.phase === 'night' && v.night === 2);
});
