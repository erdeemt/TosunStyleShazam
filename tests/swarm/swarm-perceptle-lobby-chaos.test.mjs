// 👁️ Algıla lobi kaos sürüsü: 12 kişilik oda + süre sınırında eşzamanlı cevap, her fazda host ayrılması,
// oyun ortası kopan oyuncunun atılması, go/next yağmuru, backToLobby→start döngüleri (bayat zamanlayıcı/uyaran),
// oyun sırasında ayar/geri dönüş, test türüne göre bozuk cevaplar, izleyici/ayrılmış oyuncu cevabı, paralel odalar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { TESTS, finalScore, gradeOf, trackLanding, splitValue } from '../../public/perceptle-math.js';

const TS = 0.15; // intro 600 ms, cevap 4.5 sn, grace 300 ms, açıklama 1.8 sn
const GRACE = 2000 * TS;
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: TS }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, settings = {}, prefix = 'K') {
  const r = await makeRoom(srv.wsUrl, 'perceptle', n, prefix);
  all.push(...r.bots);
  if (Object.keys(settings).length) {
    r.host.send({ t: 'settings', settings });
    await Promise.all(r.bots.map((b) => b.waitRoom((x) => Object.entries(settings).every(([k, v]) => x.settings[k] === v))));
  }
  return r;
}

async function start(r) {
  r.host.send({ t: 'start' });
  const v = await r.host.waitView((x) => x.phase === 'intro' && x.index === 0);
  await Promise.all(r.bots.map((b) => b.waitView((x) => x.gameKey === v.gameKey)));
  return v.gameKey;
}

const playView = (b, gameKey, i) => b.waitFor((m) => m.t === 'view' && m.view?.gameKey === gameKey && m.view.phase === 'play' && m.view.index === i, { fromStart: true, timeout: 8000 }).then((m) => m.view);
const untilServer = async (t) => { const w = t - Date.now(); if (w > 0) await sleep(w); };

function goodAnswer(test, stim) {
  switch (test) {
    case 'count': return stim.dots.length;
    case 'track': return Math.round(trackLanding(stim) * 10) / 10;
    case 'angle': return stim.target;
    case 'tempo': return [];
    default: return Math.round(splitValue(stim) * 10000) / 10000;
  }
}

function checkOver(over) {
  for (const p of over.players) {
    assert.equal(p.scores.length, over.history.length, `${p.name}: her test için puan`);
    assert.ok(p.scores.every((s) => Number.isInteger(s) && s >= 0 && s <= 100));
    assert.equal(p.total, finalScore(p.scores));
    assert.equal(p.grade, gradeOf(p.total));
  }
}

test('12 kişi Cuma: yarısı endsAt sınırında, yarısı grace sonrasında aynı anda cevaplar; sonuç tutarlı', async () => {
  const r = await room(12, { rules: 'friday' }, 'D');
  const gameKey = await start(r);
  const lateErrors = [];
  for (let i = 0; i < TESTS.length; i++) {
    await r.host.waitView((v) => v.gameKey === gameKey && v.index === i && v.phase === 'intro');
    r.host.action({ type: 'go', index: i });
    const pv = await playView(r.host, gameKey, i);
    const test = TESTS[i];
    const ans = goodAnswer(test, pv.stimulus);
    // Hepsi aynı anda: 0–5 sınırın hemen içi, 6–11 grace bittikten sonra
    await untilServer(pv.endsAt - 3);
    r.bots.slice(0, 6).forEach((b) => b.action({ type: 'answer', index: i, answer: ans }));
    const errs = r.bots.map((b) => b.errors.length);
    await untilServer(pv.endsAt + GRACE + 40);
    r.bots.slice(6).forEach((b) => b.action({ type: 'answer', index: i, answer: ans }));
    const rv = await r.host.waitView((v) => v.gameKey === gameKey && v.index === i && (v.phase === 'reveal' || v.phase === 'over'), { timeout: 5000 });
    await sleep(30);
    for (const [k, b] of r.bots.entries()) {
      const res = rv.last.results[b.playerId];
      assert.ok(res, `${b.name} sonuçta olmalı`);
      if (k < 6) assert.equal(res.timedOut, false, `${test}: sınırdaki ${b.name} sayılmalı`);
      else {
        assert.equal(res.timedOut, true, `${test}: geç kalan ${b.name} sayılmamalı`);
        lateErrors.push(...b.errors.slice(errs[k]).map((e) => e.message));
      }
    }
    if (rv.phase === 'reveal') r.host.action({ type: 'next', index: i });
  }
  const over = await r.host.waitView((v) => v.gameKey === gameKey && v.over, { timeout: 5000 });
  assert.equal(over.players.length, 12);
  checkOver(over);
  // geç kalanlar ya sessizce yok sayılır ya da "Süre doldu" alır; başka hata yok
  assert.ok(lateErrors.every((m) => /Süre doldu/.test(m)), lateErrors.join(' | '));
});

test('host her fazda ayrılınca yeni host go/next yapabilir, oyun biter', async () => {
  const r = await room(4, { tests: 'count,angle,split' }, 'H');
  const [a, b, c, d] = r.bots;
  const gameKey = await start(r);
  // intro'da host ayrılır
  a.leave();
  await b.waitRoom((x) => x.hostId === b.playerId);
  await b.act({ type: 'go', index: 0 });
  const pv = await playView(b, gameKey, 0);
  await untilServer(pv.recallAt + 5);
  // play'de (cevap vermiş) host ayrılır
  b.action({ type: 'answer', index: 0, answer: 10 });
  c.action({ type: 'answer', index: 0, answer: 20 });
  await c.waitView((v) => v.players.filter((p) => p.answered).length === 2);
  b.leave();
  await c.waitRoom((x) => x.hostId === c.playerId);
  d.action({ type: 'answer', index: 0, answer: 30 });
  const rv = await c.waitView((v) => v.phase === 'reveal' && v.index === 0, { timeout: 3000 });
  assert.deepEqual(Object.keys(rv.last.results).sort(), [c.playerId, d.playerId].sort());
  // reveal'da host ayrılır; d tek başına next yapar
  c.leave();
  await d.waitRoom((x) => x.hostId === d.playerId);
  await d.act({ type: 'next', index: 0 });
  await d.waitView((v) => v.index === 1 && v.phase === 'intro');
  d.action({ type: 'go', index: 1 });
  await playView(d, gameKey, 1);
  d.action({ type: 'answer', index: 1, answer: 0.5 });
  await d.waitView((v) => v.index === 1 && v.phase === 'reveal', { timeout: 3000 });
  d.action({ type: 'next', index: 1 });
  await d.waitView((v) => v.index === 2 && v.phase === 'intro');
  d.action({ type: 'go', index: 2 });
  const cv = await playView(d, gameKey, 2);
  await untilServer(cv.recallAt + 5);
  d.action({ type: 'answer', index: 2, answer: 60 });
  await d.waitView((v) => v.phase === 'reveal' && v.index === 2);
  d.action({ type: 'next', index: 2 });
  const over = await d.waitView((v) => v.over, { timeout: 3000 });
  assert.equal(over.players.length, 1);
  checkOver(over);
});

test('kopan oyuncu testi bekletir; host atınca test hemen biter; bağlı oyuncu atılamaz', async () => {
  const r = await room(3, { tests: 'angle,split' }, 'Kp');
  const [a, b, c] = r.bots;
  const gameKey = await start(r);
  a.action({ type: 'go', index: 0 });
  const pv = await playView(a, gameKey, 0);
  await untilServer(pv.recallAt + 5);
  c.drop();
  await a.waitRoom((x) => x.players.find((p) => p.id === c.playerId)?.connected === false);
  a.action({ type: 'answer', index: 0, answer: 0.1 });
  b.action({ type: 'answer', index: 0, answer: 0.2 });
  await a.waitView((v) => v.players.filter((p) => p.answered).length === 2);
  await sleep(60);
  assert.equal(a.view.phase, 'play', 'kopuk oyuncu cevaplamadı, test sürer');
  const kickConnected = a.waitFor((m) => m.t === 'error');
  a.send({ t: 'kick', playerId: b.playerId });
  assert.match((await kickConnected).message, /bağlantısı kopmuş/);
  a.send({ t: 'kick', playerId: c.playerId });
  const rv = await a.waitView((v) => v.phase === 'reveal', { timeout: 800 });
  assert.equal(Object.keys(rv.last.results).length, 2);
  assert.equal(rv.players.length, 2);
  // atılan yeniden bağlanıp katılırsa izleyici olur, cevap veremez
  await c.connect();
  await c.join(r.code);
  a.action({ type: 'next', index: 0 });
  await a.waitView((v) => v.index === 1 && v.phase === 'intro');
  a.action({ type: 'go', index: 1 });
  const av = await playView(c, gameKey, 1);
  assert.equal(av.stimulus, null, 'atılan oyuncu (izleyici) uyaranı almaz');
  assert.equal(av.me.playing, false);
  const se = await c.expectError({ type: 'answer', index: 1, answer: 90 });
  assert.match(se.message, /İzleyici/);
  await untilServer(av.recallAt + 5);
  a.action({ type: 'answer', index: 1, answer: 1 });
  b.action({ type: 'answer', index: 1, answer: 2 });
  const over = await a.waitView((v) => v.phase === 'reveal' && v.index === 1, { timeout: 2000 });
  assert.ok(!over.last.results[c.playerId]);
});

test('go/next yağmuru test atlatmaz; her test bir kez oynanır', async () => {
  const r = await room(2, { tests: 'angle,split' }, 'Sp');
  const [a, b] = r.bots;
  const gameKey = await start(r);
  for (let i = 0; i < 2; i++) {
    await a.waitView((v) => v.index === i && v.phase === 'intro');
    for (let k = 0; k < 5; k++) { a.action({ type: 'go', index: i }); a.action({ type: 'next', index: i }); }
    const pv = await playView(a, gameKey, i);
    await untilServer(pv.recallAt + 5);
    a.action({ type: 'answer', index: i, answer: i ? 0.5 : 45 });
    b.action({ type: 'answer', index: i, answer: i ? 0.4 : 50 });
    await a.waitView((v) => v.index === i && v.phase === 'reveal');
    for (let k = 0; k < 5; k++) { a.action({ type: 'next', index: i }); a.action({ type: 'go', index: i + 1 }); }
  }
  const over = await a.waitView((v) => v.over, { timeout: 3000 });
  await sleep(30);
  const phases = [];
  for (const m of a.messages) if (m.t === 'view' && m.view?.gameKey === gameKey) { const k = `${m.view.index}:${m.view.phase}`; if (phases.at(-1) !== k) phases.push(k); }
  assert.deepEqual(phases, ['0:intro', '0:play', '0:reveal', '1:intro', '1:play', '1:reveal', '1:over']);
  assert.equal(over.history.length, 2);
  checkOver(over);
  assert.ok(a.errors.every((e) => e.code === 'rate' || /oda sahibi|oynanmıyor/.test(e.message)), JSON.stringify(a.errors));
});

test('oyun sırasında ayar / backToLobby reddedilir; backToLobby→start döngüsünde bayat zamanlayıcı ve uyaran yok', async () => {
  const r = await room(2, { tests: 'split' }, 'Cy');
  const [a, b] = r.bots;
  let gk = await start(r);
  const se = a.waitFor((m) => m.t === 'error');
  a.send({ t: 'settings', settings: { rules: 'friday' } });
  assert.match((await se).message, /bekleme odasında/);
  const be = a.waitFor((m) => m.t === 'error');
  a.send({ t: 'backToLobby' });
  assert.match((await be).message, /bitmeden/);
  for (let cycle = 0; cycle < 4; cycle++) {
    // Oyunu reveal'da bitir: açıklama zamanlayıcısı beklerken host next ile bitirir (bekleyen zamanlayıcı kalmasın)
    a.action({ type: 'go', index: 0 });
    const pv = await playView(a, gk, 0);
    a.action({ type: 'answer', index: 0, answer: 0.5 });
    b.action({ type: 'answer', index: 0, answer: 0.5 });
    await a.waitView((v) => v.gameKey === gk && v.phase === 'reveal');
    if (cycle % 2) a.action({ type: 'next', index: 0 });
    await a.waitRoom((x) => x.phase === 'over', { timeout: 3000 });
    a.send({ t: 'backToLobby' });
    await a.waitRoom((x) => x.phase === 'lobby');
    await sleep(250); // hız sınırı
    if (cycle === 1) {
      a.send({ t: 'settings', settings: { rules: 'friday', tests: 'count' } });
      await a.waitRoom((x) => x.settings.rules === 'friday');
    }
    const from = a.messages.length;
    a.send({ t: 'start' });
    const iv = await a.waitView((v) => v.gameKey !== gk && v.phase === 'intro');
    const old = gk;
    gk = iv.gameKey;
    // Host go demezse intro tam süresince (200 ms) sürmeli: bayat 'intro'/'play' zamanlayıcısı erken tetiklememeli
    const t0 = Date.now();
    const auto = await a.waitView((v) => v.gameKey === gk && v.phase === 'play', { timeout: 2000 });
    const dt = Date.now() - t0;
    assert.ok(dt >= 400, `intro erken bitti (${dt} ms)`);
    assert.ok(auto.stimulus && JSON.stringify(auto.stimulus) !== JSON.stringify(pv.stimulus));
    assert.ok(a.messages.slice(from).every((m) => m.t !== 'view' || m.view?.gameKey !== old), 'eski oyunun görünümü gelmemeli');
    if (cycle >= 1) {
      // count testi (Cuma): cevapla ve bitir, sonraki döngü için tekrar split'e dön
      await untilServer(auto.recallAt + 5);
      a.action({ type: 'answer', index: 0, answer: 50 });
      b.action({ type: 'answer', index: 0, answer: 50 });
      await a.waitView((v) => v.gameKey === gk && v.phase === 'reveal');
      a.action({ type: 'next', index: 0 });
      await a.waitRoom((x) => x.phase === 'over');
      a.send({ t: 'backToLobby' });
      await a.waitRoom((x) => x.phase === 'lobby');
      a.send({ t: 'settings', settings: { rules: 'normal', tests: 'split' } });
      await a.waitRoom((x) => x.settings.tests === 'split');
      a.send({ t: 'start' });
      const nv = await a.waitView((v) => v.gameKey !== gk && v.phase === 'intro');
      gk = nv.gameKey;
      await b.waitView((v) => v.gameKey === gk);
    } else {
      // intro'dan play'e geçmiş bu oyunu oynayıp kapat
      a.action({ type: 'answer', index: 0, answer: 0.5 });
      b.action({ type: 'answer', index: 0, answer: 0.5 });
      await a.waitRoom((x) => x.phase === 'over', { timeout: 3000 });
      a.send({ t: 'backToLobby' });
      await a.waitRoom((x) => x.phase === 'lobby');
      a.send({ t: 'start' });
      const nv = await a.waitView((v) => v.gameKey !== gk && v.phase === 'intro');
      gk = nv.gameKey;
      await b.waitView((v) => v.gameKey === gk);
    }
  }
  assert.ok(a.errors.every((e) => /bekleme odasında|bitmeden/.test(e.message)), JSON.stringify(a.errors.map((e) => e.message)));
});

// Test türüne göre bozuk cevaplar: hepsi "Geçersiz cevap." ile reddedilir, testi tüketmez, sunucu ayakta kalır.
const BAD = {
  common: [null, 'abc', '', '   ', 'Infinity', '-Infinity', '1e400', 'NaN', true, false, {}, { valueOf: 5 }, [], [5], [[1]]],
  tempo: [null, 5, '5', {}, { length: 3 }, Array(41).fill(1), [1, null], [1, 'x'], [1, 'Infinity'], [1, '1e999'], [[1]], [{}], [true]],
};

test('bozuk cevaplar (her test türü): reddedilir, test tüketilmez, sonra geçerli cevap kabul', async () => {
  // Ayrı, yavaş sunucu: 15 bozuk cevap hız sınırına takılmadan cevap süresine sığsın (cevap 12 sn).
  const slow = await startServer({ timeScale: 0.4 });
  const { bots: [a] } = await makeRoom(slow.wsUrl, 'perceptle', 1, 'Bz');
  all.push(a);
  a.send({ t: 'settings', settings: { rules: 'friday' } });
  await a.waitRoom((x) => x.settings.rules === 'friday');
  const r = { host: a, bots: [a] };
  const gameKey = await start(r);
  const accepted = {};
  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    await a.waitView((v) => v.index === i && v.phase === 'intro');
    a.action({ type: 'go', index: i });
    const pv = await playView(a, gameKey, i);
    await untilServer(pv.recallAt + 5);
    const list = test === 'tempo' ? BAD.tempo : BAD.common;
    for (const bad of list) {
      const e = await a.expectError({ type: 'answer', index: i, answer: bad });
      assert.match(e.message, /Geçersiz/, `${test} ${JSON.stringify(bad)}`);
      await sleep(170); // hız sınırına (30 mesaj / 5 sn) takılmamak için
    }
    assert.equal(a.view.me.answered, false);
    // uç ama geçerli değerler sınıra çekilir
    const edge = { count: 1e308, track: -1e9, angle: 1e9, tempo: Array(40).fill(-1e12), split: '-7' }[test];
    await a.act({ type: 'answer', index: i, answer: edge });
    accepted[test] = a.view.phase === 'play' ? a.view.me.answer : a.view.last.results[a.playerId].answer;
    if (a.view.phase !== 'reveal') await a.waitView((v) => v.index === i && v.phase === 'reveal');
    a.action({ type: 'next', index: i });
  }
  assert.deepEqual(accepted, { count: 999, track: 0, angle: 3600, tempo: 40, split: -0.5 });
  const over = await a.waitView((v) => v.over, { timeout: 3000 });
  checkOver(over);
  a.close();
  await slow.stop();
});

test('wrong-index / hex-string index / eksik tip cevapları sessizce yok sayılır', async () => {
  const r = await room(1, { tests: 'split' }, 'Wi');
  const a = r.host;
  const gameKey = await start(r);
  a.action({ type: 'go', index: 0 });
  await playView(a, gameKey, 0);
  const n = a.errors.length;
  for (const index of [1, -1, 0.5, '1', null, [0], { valueOf: 0 }, 'x']) a.action({ type: 'answer', index, answer: 0.5 });
  await sleep(80);
  assert.equal(a.errors.length, n);
  assert.equal(a.view.me.answered, false);
  // string "0" ve " 0 " geçerli sayılır (num()), bu zararsız
  await a.act({ type: 'answer', index: ' 0 ', answer: '0.5' });
  const rv = await a.waitView((v) => v.phase === 'reveal');
  assert.equal(rv.last.results[a.playerId].answer, 0.5);
});

test('paralel 6 oda × 3 oyuncu: eylemler odalar arasında karışmaz, mesajda oda kodu yok sayılır', async () => {
  const rooms = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => room(3, { tests: 'angle,split' }, `P${i}-`)));
  const keys = await Promise.all(rooms.map(start));
  // oda 0 hostu, mesaja başka odanın kodunu koyup go der → sadece kendi odası etkilenir
  rooms[0].host.send({ t: 'action', code: rooms[1].code, room: rooms[1].code, action: { type: 'go', index: 0 } });
  await playView(rooms[0].host, keys[0], 0);
  await sleep(50);
  assert.equal(rooms[1].host.view.phase, 'intro', 'başka odaya etki etmemeli');
  await Promise.all(rooms.map(async (r, ri) => {
    for (let i = 0; i < 2; i++) {
      await r.host.waitView((v) => v.index === i && (v.phase === 'intro' || v.phase === 'play'));
      r.host.action({ type: 'go', index: i });
      const pv = await playView(r.host, keys[ri], i);
      await untilServer(pv.recallAt + 5);
      r.bots.forEach((b, k) => b.action({ type: 'answer', index: i, answer: i ? 10 * k + ri : 0.1 * k }));
      await r.host.waitView((v) => v.index === i && (v.phase === 'reveal' || v.phase === 'over'));
      r.host.action({ type: 'next', index: i });
    }
    const over = await r.host.waitView((v) => v.over, { timeout: 4000 });
    assert.equal(over.players.length, 3);
    for (const b of r.bots) assert.ok(over.history.every((h) => h.results[b.playerId] && !h.results[b.playerId].timedOut));
    assert.deepEqual(Object.keys(over.history[0].results).sort(), r.bots.map((b) => b.playerId).sort());
  }));
});
