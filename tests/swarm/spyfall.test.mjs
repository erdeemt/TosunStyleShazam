// Casus Kim? sürü testleri: tam oyunlar, gizli bilgi sızıntısı, yeniden bağlanma, geçersiz eylemler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

let srv;
const all = [];

before(async () => { srv = await startServer({ timeScale: 0.002 }); }); // 8 dk ≈ 1 sn
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function setupGame(n, settings = {}) {
  const room = await makeRoom(srv.wsUrl, 'spyfall', n, 'Oyuncu');
  all.push(...room.bots);
  room.host.send({ t: 'settings', settings: { rounds: 1, minutes: 8, spies: 1, ...settings } });
  await room.host.waitRoom((r) => r.settings.rounds === (settings.rounds ?? 1));
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'play')));
  const spies = room.bots.filter((b) => b.view.me.spy);
  const town = room.bots.filter((b) => !b.view.me.spy);
  return { ...room, spies, town };
}

// Tur açıklanmadan önce: casus hiçbir mesajda mekân/rol görmemeli, köylüler casus kimliğini görmemeli.
function assertNoLeaks(bots) {
  for (const b of bots) {
    const spy = b.messages.find((m) => m.t === 'view')?.view.me?.spy;
    for (const m of b.messages) {
      if (m.t !== 'view' || m.view.result) continue;
      const text = JSON.stringify(m.view);
      assert.ok(!text.includes('spyIds'), `${b.name} açıklanmadan casus listesini gördü`);
      assert.ok(!text.includes('"roles"'), `${b.name} açıklanmadan rol listesini gördü`);
      if (spy) {
        assert.equal(m.view.me.location, undefined, 'casus mekânı gördü');
        assert.equal(m.view.me.role, undefined, 'casus rol gördü');
      }
    }
    for (const other of bots) if (other !== b) assert.ok(!b.transcript().includes(other.token), 'token sızdı');
  }
}

for (const n of [3, 6, 10, 12]) {
  test(`${n} kişi: casus doğru mekânı tahmin eder → casus 4 puan`, async () => {
    const g = await setupGame(n);
    assert.equal(g.spies.length, 1);
    const locId = g.town[0].view.me.location.id;
    assert.ok(g.town.every((b) => b.view.me.location.id === locId), 'herkes aynı mekânı görmeli');
    // Roller: köylü sayısı ≤ rol sayısıysa hepsi farklı olmalı
    const roles = g.town.map((b) => b.view.me.role);
    if (roles.length <= 8) assert.equal(new Set(roles).size, roles.length);
    await g.spies[0].act({ type: 'guess', locationId: locId });
    const v = await g.host.waitView((x) => x.phase === 'reveal');
    assert.equal(v.result.winner, 'spy');
    assert.equal(v.result.reason, 'guess');
    assert.equal(v.result.points[g.spies[0].playerId], 4);
    assertNoLeaks(g.bots);
  });
}

test('suçlama: herkes Evet → casus yakalanır, suçlayana bonus', async () => {
  const g = await setupGame(6);
  const accuser = g.town[0];
  await accuser.act({ type: 'accuse', targetId: g.spies[0].playerId });
  await g.host.waitView((v) => v.phase === 'accuse');
  // suçlanan oy veremez
  const err = await g.spies[0].expectError({ type: 'vote', yes: false });
  assert.equal(err.t, 'error');
  for (const b of g.town.slice(1)) b.action({ type: 'vote', yes: true });
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.winner, 'town');
  assert.equal(v.result.points[accuser.playerId], 2);
  assert.equal(v.result.points[g.town[1].playerId], 1);
  assert.equal(v.result.points[g.spies[0].playerId], 0);
});

test('suçlama: bir Hayır → oyun devam, suçlama hakkı biter, saat kaldığı yerden', async () => {
  const g = await setupGame(5);
  const accuser = g.town[0];
  const endsBefore = accuser.view.endsAt;
  await accuser.act({ type: 'accuse', targetId: g.town[1].playerId });
  await g.host.waitView((v) => v.phase === 'accuse' && v.paused);
  await g.town[2].act({ type: 'vote', yes: false });
  const v = await accuser.waitView((x) => x.phase === 'play');
  assert.equal(v.canAccuse, false);
  assert.ok(v.endsAt >= endsBefore - 50, 'saat durmuş olmalı (bitiş geri gitmemeli)');
  const err = await accuser.expectError({ type: 'accuse', targetId: g.spies[0].playerId });
  assert.match(err.message, /hakkını kullandın/);
});

test('masum suçlanır, herkes Evet → casus kazanır', async () => {
  const g = await setupGame(4);
  const [a, b, c] = g.town;
  await a.act({ type: 'accuse', targetId: b.playerId });
  c.action({ type: 'vote', yes: true });
  g.spies[0].action({ type: 'vote', yes: true });
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.winner, 'spy');
  assert.equal(v.result.reason, 'wrong_accuse');
});

test('süre dolar → zorunlu oylama; eşitlikte casus kazanır; kimse kendine oy veremez', async () => {
  const g = await setupGame(4);
  await g.host.waitView((v) => v.phase === 'final', { timeout: 5000 });
  const [a, b, c] = g.town;
  const spy = g.spies[0];
  const selfVote = await a.expectError({ type: 'finalVote', targetId: a.playerId });
  assert.equal(selfVote.t, 'error');
  a.action({ type: 'finalVote', targetId: spy.playerId });
  b.action({ type: 'finalVote', targetId: spy.playerId });
  c.action({ type: 'finalVote', targetId: a.playerId });
  spy.action({ type: 'finalVote', targetId: a.playerId });
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.reason, 'tie');
  assert.equal(v.result.winner, 'spy');
});

test('süre dolar → oylamada casus seçilir → köylüler kazanır', async () => {
  const g = await setupGame(5);
  await g.host.waitView((v) => v.phase === 'final', { timeout: 5000 });
  for (const b of g.bots) {
    const target = b === g.spies[0] ? g.town[0] : g.spies[0];
    b.action({ type: 'finalVote', targetId: target.playerId });
  }
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.winner, 'town');
  assert.equal(v.result.reason, 'final_caught');
});

test('köylü tahmin edemez, oy tekrar edilemez, yanlış fazda eylem yok, host olmayan next diyemez', async () => {
  const g = await setupGame(4);
  assert.match((await g.town[0].expectError({ type: 'guess', locationId: 'hastane' })).message, /Sadece casus/);
  assert.match((await g.town[0].expectError({ type: 'vote', yes: true })).message, /oylama yok/);
  assert.match((await g.town[0].expectError({ type: 'next' })).message, /bitmedi/);
  assert.match((await g.town[0].expectError({ type: 'hack' })).message, /Bilinmeyen/);
  assert.match((await g.spies[0].expectError({ type: 'guess', locationId: '__proto__' })).message, /mekân yok/);
  await g.spies[0].expectError({ type: 'guess', locationId: 'yanlis-mekan-yok' });
  const wrongLoc = g.town[0].view.locations.find((l) => l.id !== g.town[0].view.me.location.id).id;
  await g.spies[0].act({ type: 'guess', locationId: wrongLoc });
  const v = await g.host.waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.winner, 'town');
  const nonHost = g.bots.find((b) => b !== g.host);
  assert.match((await nonHost.expectError({ type: 'next' })).message, /oda sahibi/);
});

test('çok turlu oyun: mekân tekrar etmez, skorlar toplanır, oyun biter', async () => {
  const g = await setupGame(6, { rounds: 3 });
  const seen = new Set();
  for (let round = 1; round <= 3; round++) {
    await Promise.all(g.bots.map((b) => b.waitView((v) => v.round === round && v.phase === 'play')));
    const spy = g.bots.find((b) => b.view.me.spy);
    const townBot = g.bots.find((b) => !b.view.me.spy);
    const loc = townBot.view.me.location.id;
    assert.ok(!seen.has(loc), 'mekân tekrar etti');
    seen.add(loc);
    await spy.act({ type: 'guess', locationId: loc });
    await g.host.waitView((v) => v.phase === 'reveal' && v.round === round);
    g.host.action({ type: 'next' });
  }
  const room = await g.host.waitRoom((r) => r.phase === 'over');
  assert.equal(room.phase, 'over');
  const total = g.host.view.players.reduce((s, p) => s + p.score, 0);
  assert.equal(total, 12, '3 tur × casus 4 puan');
});

test('2 casus (10 kişi): casuslar birbirini bilmez', async () => {
  const g = await setupGame(10, { spies: 2 });
  assert.equal(g.spies.length, 2);
  for (const s of g.spies) {
    assert.equal(s.view.me.spyCount, 2);
    const other = g.spies.find((x) => x !== s);
    assert.ok(!JSON.stringify(s.view.me).includes(other.playerId));
  }
  assertNoLeaks(g.bots);
});

test('yeniden bağlanma: aynı rol ve mekân geri gelir', async () => {
  const g = await setupGame(5);
  const b = g.town[1];
  const before = JSON.stringify(b.view.me);
  b.drop();
  await g.host.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === false);
  await sleep(50);
  await b.connect();
  const v = await b.waitView((x) => x.me != null);
  assert.equal(JSON.stringify(v.me), before);
});

test('casus kalıcı ayrılırsa tur iptal; 3 kişinin altına düşerse oyun biter', async () => {
  const g = await setupGame(4);
  g.spies[0].send({ t: 'leave' });
  const v = await g.town[0].waitView((x) => x.phase === 'reveal');
  assert.equal(v.result.reason, 'spy_left');
  const g2 = await setupGame(3);
  g2.town[0].send({ t: 'leave' });
  const room = await g2.spies[0].waitRoom((r) => r.phase === 'over');
  assert.equal(room.phase, 'over');
});

test('eş zamanlı: aynı anda 6 suçlama ve 6 oy tutarlı', async () => {
  const g = await setupGame(6);
  for (const b of g.bots) {
    const target = g.bots.find((x) => x !== b);
    b.action({ type: 'accuse', targetId: target.playerId });
  }
  await sleep(200);
  const v = g.host.view;
  assert.equal(v.phase === 'accuse' || v.phase === 'play' || v.phase === 'reveal', true);
  const errors = g.bots.reduce((n, b) => n + b.errors.filter((e) => /suçlama yapılamaz/.test(e.message)).length, 0);
  assert.ok(errors >= 1, 'sadece bir suçlama aynı anda kabul edilmeli');
});

test('soru-cevap sırası: X → Y; ikisi onaylayınca cevap veren yeni soran olur ve sorana geri soramaz', async () => {
  const g = await setupGame(5);
  const byId = (id) => g.bots.find((b) => b.playerId === id);
  let qa = g.host.view.qa;
  assert.equal(qa.askerId, g.host.view.firstAskerId);
  assert.notEqual(qa.targetId, qa.askerId);
  const outsider = g.bots.find((b) => b.playerId !== qa.askerId && b.playerId !== qa.targetId);
  assert.match((await outsider.expectError({ type: 'qaDone' })).message, /senin değil/);
  // sadece soran onaylar → ikili değişmez
  await byId(qa.askerId).act({ type: 'qaDone' });
  let v = await g.host.waitView((x) => x.qa.done.length === 1);
  assert.equal(v.qa.number, 1);
  // cevaplayan da onaylar → yeni ikili
  const prev = qa;
  byId(qa.targetId).action({ type: 'qaDone' });
  v = await g.host.waitView((x) => x.qa.number === 2);
  assert.equal(v.qa.askerId, prev.targetId, 'cevap veren yeni soran olmalı');
  assert.notEqual(v.qa.targetId, prev.askerId, 'kendisine sorana geri soramaz');
  assert.notEqual(v.qa.targetId, v.qa.askerId);
  assert.deepEqual(v.qa.done, []);
});

test('soru-cevap: sıradaki oyuncu ayrılırsa ikili yeniden kurulur; suçlama sırasında onay yok', async () => {
  const g = await setupGame(5);
  const byId = (id) => g.bots.find((b) => b.playerId === id);
  const qa = g.host.view.qa;
  const leaver = byId(qa.targetId);
  const observer = g.bots.find((b) => b !== leaver && b.playerId !== qa.askerId) ?? byId(qa.askerId);
  leaver.send({ t: 'leave' });
  const v = await observer.waitView((x) => x.qa && x.qa.targetId !== leaver.playerId && x.qa.askerId !== leaver.playerId && x.players.length === 4);
  assert.ok(v.players.some((p) => p.id === v.qa.targetId));
  // suçlama sırasında soru onayı yapılamaz
  const a = byId(v.qa.askerId);
  const other = g.bots.find((b) => b !== leaver && b !== a);
  await other.act({ type: 'accuse', targetId: a.playerId });
  await a.waitView((x) => x.phase === 'accuse');
  assert.match((await a.expectError({ type: 'qaDone' })).message, /soru sırası yok/);
});

test('soru turları: ilk N soruda herkese tam bir kez sorulur, sonra yeni tur başlar', async () => {
  for (const n of [4, 8]) {
    const g = await setupGame(n);
    const byId = (id) => g.bots.find((b) => b.playerId === id);
    const targets = [];
    for (let q = 1; q <= n + 1; q++) {
      const v = await g.host.waitView((x) => x.qa.number === q);
      assert.equal(v.qa.tour, q <= n ? 1 : 2, `${q}. soru turu`);
      assert.equal(v.qa.askedCount, q <= n ? q : 1);
      assert.equal(v.qa.playerCount, n);
      targets.push(v.qa.targetId);
      if (q === n + 1) break;
      await byId(v.qa.askerId).act({ type: 'qaDone' });
      byId(v.qa.targetId).action({ type: 'qaDone' });
    }
    assert.equal(new Set(targets.slice(0, n)).size, n, `${n} kişide ilk ${n} soruda herkese sorulmalı`);
    assert.deepEqual(new Set(targets.slice(0, n)), new Set(g.bots.map((b) => b.playerId)));
  }
});

test('mekân geçmişi: tekrar oynayınca (aynı oyuncular) önceki oyunların mekânları gelmez', async () => {
  const g = await setupGame(3, { rounds: 10 });
  const seen = [];
  // 3 oyun × 10 tur: 30 turun hepsi farklı mekân olmalı (oyunlar arası da). Mesaj sınırına takılmamak için turlar arası kısa bekleme.
  for (let game = 0; game < 3; game++) {
    if (game > 0) {
      g.host.send({ t: 'backToLobby' });
      await g.host.waitRoom((r) => r.phase === 'lobby');
      g.host.send({ t: 'start' });
    }
    for (let round = 1; round <= 10; round++) {
      await Promise.all(g.bots.map((b) => b.waitView((v) => v.round === round && v.phase === 'play' && (game === 0 || v.gameKey !== g.prevKey))));
      const spy = g.bots.find((b) => b.view.me.spy);
      const loc = g.bots.find((b) => !b.view.me.spy).view.me.location.id;
      seen.push(loc);
      await spy.act({ type: 'guess', locationId: loc });
      await g.host.waitView((v) => v.phase === 'reveal' && v.round === round);
      g.host.action({ type: 'next' });
      await sleep(250);
    }
    await g.host.waitRoom((r) => r.phase === 'over');
    g.prevKey = g.host.view.gameKey;
  }
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30, 'önceki oyunların mekânları tekrar gelmemeli');
});
