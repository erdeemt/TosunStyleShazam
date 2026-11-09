// 🔗 Bağlantı Avı lobi sürü testleri: yarış (biri en kısa yolla, biri yanlış deneme + fazladan adımla, biri pes), canlı
// ilerlemede sadece adım sayısı, tur kapanmadan en kısa yol / başkasının zinciri sızmaz, sonuç sütunları + puanlar = scoreRun,
// süre dolunca bitirmeyen 0, yeniden bağlanma (zincir korunur), oyun ortası gelen izleyici, host geçişi, ayar temizliği.
// Kurallar: PLAN.md §4.12 "Çok oyunculu".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { secret } from '../lib/media.js';
import { scoreRun } from '../../public/baglanti-math.js';

const TS = 0.05; // 3 dk → 9 sn; açıklama 30 sn → 1.5 sn
const GRAPH = JSON.parse(readFileSync(new URL('../../content/baglanti/test-graph.json', import.meta.url), 'utf8'));
const Q = GRAPH.people.map((p) => p.q);
const adjacent = (a, b) => GRAPH.edges.some(([x, y]) => (Q[x] === a && Q[y] === b) || (Q[x] === b && Q[y] === a));
const neighbors = (a) => Q.filter((b) => adjacent(a, b));
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: TS, env: { FAKE_TODAY: '2026-11-10' } }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, settings = {}, prefix = 'Zincir') {
  const r = await makeRoom(srv.wsUrl, 'baglanti', n, prefix);
  all.push(...r.bots);
  if (Object.keys(settings).length) {
    r.host.send({ t: 'settings', settings });
    await Promise.all(r.bots.map((b) => b.waitRoom((x) => Object.entries(settings).every(([k, v]) => x.settings[k] === v))));
  }
  return r;
}

async function start(r) {
  r.host.send({ t: 'start' });
  const v = await r.host.waitView((x) => x.phase === 'play' && x.index === 0, { timeout: 8000 });
  await Promise.all(r.bots.map((b) => b.waitView((x) => x.gameKey === v.gameKey)));
  return v;
}

const paths = async (code) => (await secret(srv, { room: code })).targets;
const untilServer = async (t) => { const w = t - Date.now(); if (w > 0) await sleep(w + 20); };

// Bir kişi: uca bağlı ama en kısa yolda olmayan, hedefe bağlı olmayan, zincirde olmayan (fazladan adım için)
function detour(path, end, used) {
  return neighbors(end).find((q) => !path.includes(q) && !used.includes(q) && !adjacent(q, path.at(-1)) && neighbors(q).some((x) => x === path[1] || path.indexOf(x) > 0));
}

test('3 kişi yarış: en kısa yol / yanlış+fazladan / pes; canlı ilerleme sadece sayı; tur kapanmadan sızıntı yok; puanlar', async () => {
  const r = await room(3, { difficulty: 'orta', rounds: 1, minutes: 8 });
  const v0 = await start(r);
  const [path] = await paths(r.code);
  assert.equal(path.length, 5);
  assert.equal(v0.start, path[0]);
  assert.equal(v0.target, path.at(-1));
  assert.equal(v0.opt, 3);
  await untilServer(v0.startAt);
  const [a, b, c] = r.bots;
  // A: ilk adım → B'nin görünümünde A "1 adım", A'nın seçtiği kişi yok
  const va = await a.act({ type: 'add', index: 0, qid: path[1] });
  assert.equal(va.t, 'view', JSON.stringify(va));
  const seenB = await b.waitView((x) => x.players.find((p) => p.id === a.playerId)?.steps === 1);
  assert.ok(!JSON.stringify(seenB).includes(`"${path[1]}"`), 'A\'nın seçtiği kişi B\'ye gitmemeli');
  assert.equal(seenB.me.run.chain.length, 0);
  // B: yanlış deneme (bağlı değil) → hata değil, geri bildirim; sonra bir dolambaç + doğru yol
  const bad = Q.find((q) => !path.includes(q) && !adjacent(path[0], q));
  const vb = await b.act({ type: 'add', index: 0, qid: bad });
  assert.equal(vb.t, 'view');
  const mineB = await b.waitView((x) => x.me.run?.wrong === 1);
  assert.equal(mineB.me.run.fb.ok, false);
  assert.equal(mineB.me.run.chain.length, 0);
  // Geçersiz girdi → hata mesajı
  const err = await b.expectError({ type: 'add', index: 0, qid: '<x>' });
  assert.match(err.message, /listede yok/);
  // A bitirir
  for (const q of path.slice(2, -1)) await a.act({ type: 'add', index: 0, qid: q });
  const aDone = await a.waitView((x) => x.me.run?.done);
  assert.equal(aDone.me.run.optimal, null, 'tur sürerken bitirene bile en kısa yol yok');
  const bSees = await b.waitView((x) => x.players.find((p) => p.id === a.playerId)?.place === 1);
  for (const q of path.slice(1, -1)) assert.ok(!JSON.stringify(bSees).includes(`"${q}"`), 'B\'nin görünümünde A\'nın zinciri yok');
  // B: path[1] sonra path[2]... bitir (1 yanlış)
  for (const q of path.slice(1, -1)) await b.act({ type: 'add', index: 0, qid: q });
  await b.waitView((x) => x.me.run?.done);
  // C pes eder → herkes bitti → tur kapanır
  c.action({ type: 'giveup', index: 0 });
  const rev = await r.host.waitView((x) => x.phase === 'reveal');
  // Sızıntı: açıklamadan önceki tüm mesajlarda en kısa yolun ara kişileri sadece kendi eklediğinde
  for (const bot of r.bots) {
    const until = bot.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === v0.gameKey && m.view.phase === 'reveal');
    for (const m of bot.messages.slice(0, until)) {
      const s = JSON.stringify(m);
      assert.ok(!/"optimal":\[|"path"|"targets"/.test(s), `${bot.name}: yasak alan`);
      if (bot === c) for (const q of path.slice(1, -1)) assert.ok(!s.includes(`"${q}"`), `${bot.name}: ${q} sızdı`);
    }
  }
  const h = rev.last;
  assert.deepEqual(h.optimal.map((x) => x.q), path.slice(1));
  assert.ok(h.optimal.every((x) => x.e && x.t));
  const ra = h.results[a.playerId];
  const rb = h.results[b.playerId];
  const rc = h.results[c.playerId];
  assert.equal(ra.place, 1);
  assert.equal(rb.place, 2);
  assert.equal(rc.place, null);
  assert.equal(rc.gaveUp, true);
  assert.equal(rc.score, 0);
  assert.equal(ra.score, scoreRun({ steps: 3, optimal: 3, seconds: ra.ms / 1000 }).score);
  assert.equal(rb.score, scoreRun({ steps: 3, optimal: 3, wrong: 1, seconds: rb.ms / 1000 }).score);
  assert.ok(ra.score > rb.score);
  assert.deepEqual(ra.chain.map((x) => x.q), path.slice(1, -1));
  assert.ok(ra.final?.t);
  // Host olmayan "next" reddedilir, host geçer → final
  const e2 = await b.expectError({ type: 'next', index: 0 });
  assert.match(e2.message, /oda sahibi/);
  r.host.action({ type: 'next', index: 0 });
  const over = await r.host.waitView((x) => x.phase === 'over');
  assert.equal(over.history.length, 1);
  assert.equal(over.players.find((p) => p.id === a.playerId).total, ra.score);
});

test('süre dolunca bitirmeyen 0; fazladan adımla bitiren −150; ipucu ücreti', async () => {
  const r = await room(2, { difficulty: 'zor', rounds: 1, minutes: 3 });
  const v0 = await start(r);
  const [path] = await paths(r.code);
  await untilServer(v0.startAt);
  const [a] = r.bots;
  await a.act({ type: 'hint', index: 0, kind: 'letter' });
  const extra = detour(path, path[0], []);
  const used = [];
  if (extra) { await a.act({ type: 'add', index: 0, qid: extra }); used.push(extra); }
  // Dolambaçtan yola dön: uca bağlı ilk yol kişisi
  const end = used.at(-1) ?? path[0];
  const k = Math.max(...path.slice(1, -1).map((q, i) => (adjacent(end, q) ? i + 1 : 0)));
  for (const q of path.slice(k > 0 ? k : 1, -1)) await a.act({ type: 'add', index: 0, qid: q });
  const done = await a.waitView((x) => x.me.run?.done || x.phase === 'reveal', { timeout: 15000 });
  const rev = await r.host.waitView((x) => x.phase === 'reveal', { timeout: 15000 });
  const ra = rev.last.results[a.playerId];
  const rb = rev.last.results[r.bots[1].playerId];
  assert.equal(rb.done, false);
  assert.equal(rb.score, 0, 'süre doldu → 0');
  assert.ok(done);
  assert.equal(ra.done, true);
  assert.equal(ra.hints, 1);
  assert.equal(ra.score, scoreRun({ steps: ra.chain.length, optimal: 4, hints: ['letter'], seconds: ra.ms / 1000 }).score);
});

test('yeniden bağlanma zinciri korur; oyun ortası gelen izleyici olur ve oynayamaz', async () => {
  const r = await room(2, { difficulty: 'kolay', rounds: 3, minutes: 8 });
  const v0 = await start(r);
  const [path] = await paths(r.code);
  await untilServer(v0.startAt);
  const [a, b] = r.bots;
  await a.act({ type: 'add', index: 0, qid: path[1] });
  await b.reconnect();
  const fresh = await b.waitFreshView((x) => x.gameKey === v0.gameKey);
  assert.equal(fresh.me.playing, true);
  assert.ok(fresh.me.run);
  await a.reconnect();
  const fa = await a.waitFreshView((x) => x.gameKey === v0.gameKey);
  assert.deepEqual(fa.me.run.chain.map((c) => c.q), [path[1]], 'zincir korunur');
  const late = new Bot(srv.wsUrl, 'Geç');
  all.push(late);
  await late.connect();
  await late.join(r.code);
  const lv = await late.waitView((x) => x.gameKey === v0.gameKey);
  assert.equal(lv.me.playing, false);
  assert.equal(lv.me.run, null);
  assert.equal(lv.start, path[0]);
  const e = await late.expectError({ type: 'add', index: 0, qid: path[1] });
  assert.match(e.message, /İzleyici/);
  // Eski tura ait eylem sessizce yok sayılır
  a.action({ type: 'add', index: 5, qid: path[2] });
  await sleep(100);
  assert.ok(!a.errors.some((x) => /tur/.test(x.message)));
});

test('host ayrılırsa yeni host turu geçirir; ayrılan beklenmez', async () => {
  const r = await room(3, { difficulty: 'kolay', rounds: 3, minutes: 8 });
  const v0 = await start(r);
  const [path] = await paths(r.code);
  await untilServer(v0.startAt);
  const [h, x, y] = r.bots;
  h.leave();
  for (const q of path.slice(1, -1)) await x.act({ type: 'add', index: 0, qid: q });
  y.action({ type: 'giveup', index: 0 });
  const rev = await x.waitView((v) => v.phase === 'reveal', { timeout: 8000 });
  assert.ok(!rev.last.results[h.playerId], 'ayrılanın sonucu yok');
  const room2 = await x.waitRoom((rm) => rm.hostId !== h.playerId);
  const newHost = r.bots.find((b) => b.playerId === room2.hostId);
  newHost.action({ type: 'next', index: 0 });
  const v1 = await x.waitView((v) => v.phase === 'play' && v.index === 1);
  assert.notEqual(v1.start, v0.start, 'yeni yapboz');
});

test('ayarlar temizlenir; geçersiz eylemler', async () => {
  const r = await room(1);
  r.host.send({ t: 'settings', settings: { difficulty: '<b>', rounds: 99, minutes: '5', extra: 1 } });
  const rm = await r.host.waitRoom((x) => x.settings.rounds === 3);
  assert.deepEqual(rm.settings, { difficulty: 'orta', rounds: 3, minutes: 5 });
  r.host.send({ t: 'settings', settings: { difficulty: 'zor', rounds: 5, minutes: 3 } });
  await r.host.waitRoom((x) => x.settings.difficulty === 'zor' && x.settings.rounds === 5);
  const v0 = await start(r);
  assert.equal(v0.rounds, 5);
  await untilServer(v0.startAt);
  for (const action of [{ type: 'fly', index: 0 }, { type: 'remove', index: 0, pos: 3 }, { type: 'hint', index: 0, kind: 'x' }]) {
    const e = await r.host.expectError(action);
    assert.ok(e.message);
  }
  assert.equal(JSON.stringify(r.host.view).includes('"path"'), false);
});
