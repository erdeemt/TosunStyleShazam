// Tosun Shazam (online) yarış/kaos senaryoları: aynı milisaniyede herkes doğru cevap (bonus tam bir kişiye), tahmin × süre
// dolması, "sonraki" ×10, son tahmin sırasında ayrılma, tur ortasında (host dahil) yeniden bağlanma fırtınası, oyun ortasında
// izleyici, bekleme odasına dönüş → prep duruyor → yeniden başlat. Her senaryoda ShazamReferee her mesajı denetler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, Bot, sleep } from '../lib/bot.js';
import { ShazamReferee, makeTracks, sendPrep, rightVariants, poolOf, playToEnd } from './swarm-shazam-lib.mjs';

const SCALE = 0.01; // tur 45 sn ≈ 450 ms; koltuk 120 sn ≈ 1.2 sn; host devri 15 sn ≈ 150 ms
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: SCALE, seed: 71 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function setup(n, { tracks = makeTracks(12, 70 + n), settings = {}, prefix = 'Yarış', noLeaves = false } = {}) {
  const r = await makeRoom(srv.wsUrl, 'shazam', n, prefix);
  all.push(...r.bots);
  const ref = new ShazamReferee({ label: `${prefix} ${r.code}`, tracks, noLeaves }).attachAll(r.bots);
  await sendPrep(r.host, tracks);
  const s = { rounds: 5, roundSeconds: 180, ...settings };
  r.host.send({ t: 'settings', settings: s });
  await r.host.waitRoom((x) => x.settings.rounds === s.rounds && x.settings.roundSeconds === s.roundSeconds);
  return { ...r, ref, tracks };
}

async function start(host, bots) {
  host.send({ t: 'start' });
  await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'play')));
}

const guess = (b, ref, text) => { b.sentGuesses.add(text); b.action({ type: 'guess', text }); };
const right = (b, ref, view = b.view) => {
  const t = ref.answerFor(view).title;
  b.rightGuesses.add(`${view.gameKey}:${view.round}:${t}`);
  guess(b, ref, t);
};
const noInternal = (bots) => assert.deepEqual(bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal')), []);

test('aynı milisaniyede 12 kişi doğru cevap: adım 0\'da bonus tam bir kişiye; adım 1\'de de ayrıca tam bir kişiye', async () => {
  const { bots, host, ref } = await setup(12, { noLeaves: true, settings: { rounds: 3 } });
  await start(host, bots);
  for (let round = 1; round <= 3; round++) {
    await Promise.all(bots.map((b) => b.waitView((v) => v.round === round && v.phase === 'play')));
    // Yarısı önce bir adım geçer (adım 1'de bilecekler), sonra herkes aynı tick'te doğruyu yollar
    const half = bots.slice(6);
    for (const b of half) b.action({ type: 'skip' });
    await Promise.all(half.map((b) => b.waitView((v) => v.me?.stage === 1)));
    for (const b of bots) right(b, ref);
    const rv = await host.waitView((v) => v.round === round && v.phase === 'reveal', { timeout: 3000 });
    const pts = rv.players.map((p) => p.roundPoints).sort((a, b) => a - b);
    assert.deepEqual(pts, [4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6], `tur ${round} puanları`);
    host.action({ type: 'next' });
  }
  await host.waitRoom((r) => r.phase === 'over');
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(bots);
});

test('tahmin × süre dolması: süre bitimine denk gelen doğru tahminler ya tur içinde sayılır ya "Bu tur bitti" alır, asla ikisi', async () => {
  const { bots, host, ref } = await setup(4, { settings: { rounds: 8, roundSeconds: 45 } });
  await start(host, bots);
  const outcomes = { inRound: 0, late: 0 };
  for (let round = 1; round <= 8; round++) {
    const v = await host.waitView((x) => x.round === round && x.phase === 'play', { timeout: 3000 });
    const msg = host.messages.findLast((m) => m.t === 'view' && m.view.round === round);
    const offset = msg.serverNow - msg.receivedAt; // sunucu saati - yerel saat (aynı makine ≈ 0)
    const fireAt = v.endsAt - offset + [-40, -25, -15, -8, -4, -1, 2, 6][round - 1]; // süre bitiminin hemen öncesi/sonrası
    await sleep(Math.max(0, fireAt - Date.now()));
    const idx = new Map(bots.map((x) => [x, x.messages.length]));
    for (const b of bots.slice(1)) right(b, ref, v);
    const rv = await host.waitView((x) => x.round === round && x.phase === 'reveal', { timeout: 3000 });
    for (const b of bots.slice(1)) {
      const p = rv.players.find((x) => x.id === b.playerId);
      if (p.won) { outcomes.inRound++; continue; }
      outcomes.late++;
      assert.equal(p.roundPoints, 0);
      // Geç kalan tahmin "tur bitti" hatası almalı (sonraki tura sızmamalı)
      const err = await b.waitFor((m) => m.t === 'error', { from: idx.get(b), timeout: 1500 }).catch(() => null);
      assert.ok(err && /tur bitti/.test(err.message), `${b.name} geç kaldı ama "tur bitti" almadı: ${JSON.stringify(err)}`);
    }
    // Hiçbir bot aynı tahmin için hem puan hem hata almadı
    for (const b of bots.slice(1)) {
      const won = rv.players.find((x) => x.id === b.playerId).won;
      const errs = b.messages.slice(idx.get(b)).filter((m) => m.t === 'error' && /tur bitti/.test(m.message)).length;
      assert.ok(!(won && errs), `${b.name} hem bildi hem "tur bitti" aldı`);
    }
    host.action({ type: 'next' });
  }
  await host.waitRoom((r) => r.phase === 'over', { timeout: 5000 });
  console.log(`süre sınırında tahmin: tur içinde=${outcomes.inRound}, geç=${outcomes.late}`);
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(bots);
});

test('"sonraki" ×10 aynı anda: tam bir tur ilerler; son turda oyun biter, fazlası hata; host olmayanlar reddedilir', async () => {
  const { bots, host, ref } = await setup(3, { settings: { rounds: 3 } });
  await start(host, bots);
  let lastRound = 0;
  for (;;) {
    const v = await host.waitView((x) => (x.phase === 'play' && x.round > lastRound) || x.phase === 'over', { timeout: 3000 });
    if (v.phase === 'over') break;
    lastRound = v.round;
    for (const b of bots) b.action({ type: 'giveUp' });
    await host.waitView((x) => x.round === v.round && x.phase === 'reveal');
    // Host hız sınırı 30 msj / 5 sn (kurulum 6 + pes 3): 1. turda ×10, 2. turda ×1, son turda ×9; host olmayan her turda ×10
    const burst = { 1: 10, 2: 1, 3: 9 }[v.round];
    for (let i = 0; i < 10; i++) { if (i < burst) host.action({ type: 'next' }); bots[1].action({ type: 'next' }); }
    await sleep(80);
    const after = host.view;
    assert.ok(after.phase === 'over' || after.round === v.round + 1, `tek tur ilerlemeli: ${v.round} → ${after.round} (${after.phase})`);
    assert.ok(bots[1].errors.some((e) => /oda sahibi|henüz bitmedi|oynanmıyor/.test(e.message)));
  }
  assert.equal(host.room.phase, 'over');
  assert.equal(host.view.round, host.view.totalRounds);
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(bots);
});

test('son tahmin sırasında ayrılma: kalanların son eylemi ile ayrılma aynı tick\'te → tur tam bir kez açılır (iki sıra)', async () => {
  for (const order of ['leaveFirst', 'guessFirst']) {
    const { bots, host, ref } = await setup(3, { settings: { rounds: 4 }, prefix: `Ayrıl-${order}` });
    await start(host, bots);
    const [a, b, c] = bots;
    right(a, ref);
    await a.waitView((v) => v.me.done);
    if (order === 'leaveFirst') { c.send({ t: 'leave' }); right(b, ref); } else { right(b, ref); c.send({ t: 'leave' }); }
    const rv = await host.waitView((v) => v.phase === 'reveal', { timeout: 2000 });
    await sleep(50);
    const reveals = host.messages.filter((m) => m.t === 'view' && m.view.round === 1 && m.view.phase === 'reveal');
    const distinct = new Set(reveals.map((m) => JSON.stringify(m.view.players.map((p) => [p.id, p.roundPoints]))));
    assert.ok(distinct.size <= 2, 'açılış puanları bir kez belirlenmeli');
    assert.equal(rv.players.some((p) => p.id === c.playerId), false, 'ayrılan oyuncu listeden çıkar');
    assert.equal(rv.players.find((p) => p.id === b.playerId).won, true);
    // Kalan ikisiyle oyun sürer
    host.action({ type: 'next' });
    await host.waitView((v) => v.round === 2 && v.phase === 'play');
    for (const x of [a, b]) x.action({ type: 'giveUp' });
    await host.waitView((v) => v.round === 2 && v.phase === 'reveal');
    assert.deepEqual(ref.violations, [], ref.violations.join('\n'));
    noInternal([a, b]);
  }
});

test('tek oyuncu dışında herkes ayrılırsa oyun sürer; son oyuncu da ayrılınca oda temizlenir', async () => {
  const { bots, host, ref } = await setup(4, { settings: { rounds: 4 } });
  await start(host, bots);
  for (const b of bots.slice(1)) b.send({ t: 'leave' });
  const v = await host.waitView((x) => x.players.length === 1);
  assert.equal(v.phase, 'play', 'host tek başına oynamaya devam eder (bilerek: minPlayers sadece başlarken)');
  right(host, ref);
  await host.waitView((x) => x.phase === 'reveal');
  assert.deepEqual(ref.violations, []);
});

test('yeniden bağlanma fırtınası tur ortasında (host dahil): ilerleme ve host korunur; uzun kopmada host devri', async () => {
  const { bots, host, ref, code } = await setup(8, { settings: { rounds: 3, roundSeconds: 90 } });
  await start(host, bots);
  // Herkes biraz ilerler
  for (const [i, b] of bots.entries()) { if (i % 3 === 0) b.action({ type: 'skip' }); else if (i % 3 === 1) guess(b, ref, `yanlis fırtına-${i}`); }
  await sleep(60);
  const before = new Map(bots.map((b) => [b.playerId, JSON.stringify(b.view.me)]));
  // 4 dalga: herkes aynı anda düşer, 10–40 ms sonra geri gelir (host devri 150 ms'den kısa)
  const stormStart = Date.now();
  for (let wave = 0; wave < 4; wave++) {
    bots.forEach((b) => b.drop());
    await sleep(10 + wave * 10);
    await Promise.all(bots.map((b) => b.connect()));
  }
  const fresh = await Promise.all(bots.map((b) => b.waitFreshView((v) => v.phase === 'play' && v.me)));
  bots.forEach((b, i) => assert.equal(JSON.stringify(fresh[i].me), before.get(b.playerId), `${b.name} ilerlemesi korunmalı`));
  const stormMs = Date.now() - stormStart;
  const freshRoom = await host.waitFreshRoom();
  // Host devri 15 sn × 0.01 = 150 ms; makine yüklüyken fırtına bundan uzun sürerse devir meşrudur
  if (stormMs < 120) assert.equal(freshRoom.hostId, host.playerId, 'host kısa kopmalarda host kalır');
  else console.log(`fırtına ${stormMs} ms sürdü (makine yüklü); host kalır kontrolü atlandı`);
  if (freshRoom.hostId !== host.playerId) return; // devir olduysa kalan senaryo bu turda anlamsız
  // Host devir süresinden (150 ms) uzun kopuk: oda sahipliği bağlı birine geçer; eski host koltuk süresi içinde oyuncu olarak döner
  host.drop();
  const r = await bots[1].waitRoom((x) => x.hostId !== host.playerId, { timeout: 2000 });
  const newHost = bots.find((b) => b.playerId === r.hostId);
  assert.ok(newHost && newHost !== host);
  await host.connect();
  const hv = await host.waitFreshView((v) => v.me);
  assert.equal(JSON.stringify(hv.me), before.get(host.playerId), 'eski hostun ilerlemesi korunur');
  assert.notEqual((await host.waitFreshRoom()).hostId, host.playerId, 'devredilen host geri dönünce host olmaz');
  for (const b of bots) b.action({ type: 'giveUp' });
  const rv = await newHost.waitView((v) => v.phase === 'reveal', { timeout: 3000 });
  assert.equal(rv.round, 1);
  assert.match((await host.expectError({ type: 'next' })).message, /oda sahibi/);
  newHost.action({ type: 'next' });
  await newHost.waitView((v) => v.round === 2 && v.phase === 'play');
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(bots);
  void code;
});

test('oyun ortasında izleyiciler: görünümde me yok, eylemleri reddedilir, gizli bilgi yok; lobiye dönünce oyuncu olurlar', async () => {
  const { bots, host, ref, code } = await setup(3, { settings: { rounds: 4 } });
  await start(host, bots);
  const specs = [];
  for (let i = 0; i < 4; i++) {
    const s = await new Bot(srv.wsUrl, `İzleyen${i}`).connect();
    all.push(s);
    ref.attach(s);
    await s.join(code);
    specs.push(s);
  }
  for (const s of specs) {
    const v = await s.waitView(() => true);
    assert.equal(v.me, null);
    const ans = ref.answerFor(v).title;
    assert.match((await s.expectError({ type: 'guess', text: ans })).message, /İzleyici/);
  }
  assert.ok(specs.every((s) => s.view.players.length === 3), 'izleyiciler oyuncu listesinde değil');
  await playToEnd(host, bots);
  host.send({ t: 'backToLobby' });
  const lobby = await host.waitRoom((r) => r.phase === 'lobby');
  assert.ok(lobby.players.every((p) => !p.spectator), 'lobide herkes oyuncu');
  assert.ok(lobby.prep.trackCount > 0, 'prep korunur');
  host.send({ t: 'start' });
  const all7 = [...bots, ...specs];
  await Promise.all(all7.map((b) => b.waitView((v) => v.phase === 'play' && v.me)));
  assert.equal(host.view.players.length, 7);
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(all7);
});

test('bekleme odasına dön → prep duruyor → tekrar başlat ×2: yeni gameKey, tur 1, skorlar sıfır, havuz aynı', async () => {
  const { bots, host, ref } = await setup(3, { tracks: makeTracks(10, 79), settings: { rounds: 3 } });
  const games = [];
  for (let g = 0; g < 2; g++) { // 2 oyun (host hız sınırı: 30 msj / 5 sn)
    await start(host, bots);
    const v = host.view;
    assert.equal(v.round, 1);
    assert.ok(v.players.every((p) => p.score === 0), 'yeni oyunda skorlar sıfır');
    const order = [];
    await playToEnd(host, bots, { onRound: async (rv) => { order.push(rv.media.key); right(bots[1], ref, rv); await sleep(5); } });
    games.push({ key: v.gameKey, pool: JSON.stringify(poolOf(host, v)), order });
    // Oyun bitti: prep değiştirilemez, sadece bekleme odasında
    host.send({ t: 'backToLobby' });
    const r = await host.waitRoom((x) => x.phase === 'lobby');
    assert.equal(r.prep.trackCount, 10, 'prep korunur');
  }
  assert.equal(new Set(games.map((g) => g.key)).size, 2, 'her oyunun gameKey\'i farklı');
  assert.equal(new Set(games.map((g) => g.pool)).size, 1, 'havuz aynı (prep sırası)');
  // Lobide prep sıfırlanınca başlatılamaz
  host.send({ t: 'prep', data: { op: 'reset' } });
  await host.waitRoom((x) => x.prep.trackCount === 0);
  host.send({ t: 'start' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /en az \d+ şarkı/);
  assert.deepEqual(ref.finalChecks(), []);
  noInternal(bots);
});

test('bitirmiş oyuncu eylem yağmuru (guess/skip/giveUp ×20) → durumu ve puanı değişmez', async () => {
  const { bots, host, ref } = await setup(3, { settings: { rounds: 3 } });
  await start(host, bots);
  const [a] = bots;
  right(a, ref);
  const v0 = await a.waitView((v) => v.me.done);
  const snap = JSON.stringify(v0.me);
  const score = v0.players.find((p) => p.id === a.playerId).score;
  for (let i = 0; i < 20; i++) {
    const t = rightVariants(ref.answerFor(v0))[i % 5];
    a.sentGuesses.add(t);
    a.action(i % 3 === 0 ? { type: 'guess', text: t } : { type: i % 3 === 1 ? 'skip' : 'giveUp' });
  }
  await sleep(100);
  assert.equal(JSON.stringify(a.view.me), snap);
  assert.equal(a.view.players.find((p) => p.id === a.playerId).score, score);
  assert.ok(a.errors.filter((e) => /bitirdin/.test(e.message)).length >= 15);
  assert.deepEqual(ref.violations, []);
});

test('kopuk (ama ayrılmamış) oyuncu turu bekletir; tur süre dolunca açılır, kopuğun puanı 0', async () => {
  const { bots, host, ref } = await setup(3, { settings: { rounds: 3, roundSeconds: 45 } });
  await start(host, bots);
  const [a, b, c] = bots;
  c.drop();
  right(a, ref);
  b.action({ type: 'giveUp' });
  const t0 = Date.now();
  const rv = await host.waitView((v) => v.phase === 'reveal', { timeout: 3000 });
  const remaining = host.messages.find((m) => m.t === 'view' && m.view.round === 1).view.endsAt - t0;
  assert.ok(Date.now() - t0 >= remaining - 50, 'tur süre dolmadan açılmamalı');
  assert.equal(rv.players.find((p) => p.id === c.playerId).roundPoints, 0);
  assert.deepEqual(ref.violations, []);
});

test('bayat eylem: önceki tur için gönderilen tahmin/geç, host "sonraki"den hemen sonra gelirse yeni turda adım yakmamalı', async () => {
  const { bots, host, ref } = await setup(2, { settings: { rounds: 3 } });
  await start(host, bots);
  const [, b] = bots;
  for (const x of bots) x.action({ type: 'giveUp' });
  const rv = await host.waitView((v) => v.phase === 'reveal');
  // Host "sonraki"ye basar; aynı anda b'nin (eski ekranda) bastığı "geç" yola çıkmıştır
  host.action({ type: 'next', round: rv.round });
  // Gerçek istemci gibi: eylem hangi tur ve adım için gönderildiğini taşır (sendOnce)
  b.action({ type: 'skip', round: rv.round, stage: 0 });
  const nv = await b.waitView((v) => v.round === rv.round + 1);
  await sleep(50);
  assert.equal(b.view.me.stage, 0, `yeni turda adım ${b.view.me.stage} (bayat "geç" sayıldı)`);
  void nv; void ref;
});
