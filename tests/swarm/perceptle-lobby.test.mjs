// 👁️ Algıla lobi sürü testleri: tam oyun (1, 3, 8 kişi), puanlar evaluate ile aynı, gizli bilgi taraması,
// erken/geç/çift/eski/bozuk cevaplar, her fazda yeniden bağlanma, oyun ortası ayrılma, izleyici, Cuma ayarı,
// test seçimi, paralel odalar, süre sınırında cevap. Kurallar: PLAN.md §4.7 "Çok oyunculu".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { secret, hasKey } from '../lib/media.js';
import { TESTS, evaluate, finalScore, gradeOf, tempoExpected, trackLanding, splitValue } from '../../public/perceptle-math.js';

const TS = 0.05; // intro 0.2 sn, cevap 1.5 sn, açıklama 0.6 sn
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-perceptle-lobby-'));
process.env.PERCEPTLE_SALT = 'test-salt';
const { cleanAnswer } = await import('../../server/perceptle.js');

let srv;
const all = [];
const MONDAY = '2026-11-02';
const FRIDAY = '2026-10-30';
before(async () => { srv = await startServer({ timeScale: TS, env: { FAKE_TODAY: MONDAY } }); }); // Cuma varsayılanı karışmasın
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, settings = {}, prefix = 'Göz') {
  const r = await makeRoom(srv.wsUrl, 'perceptle', n, prefix);
  all.push(...r.bots);
  if (Object.keys(settings).length) {
    r.host.send({ t: 'settings', settings });
    // settings değerleri zaten temiz (sabit sırada) verilir
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

// i. testin ilk play görünümü (uyaranı taşıyan) — mesaj geçmişinde ara.
const playView = (b, gameKey, i) => b.waitFor((m) => m.t === 'view' && m.view?.gameKey === gameKey && m.view.phase === 'play' && m.view.index === i, { fromStart: true, timeout: 8000 }).then((m) => m.view);

// Bot k'nın i. testteki cevabı (ham) — hepsi farklı, bot 0 kusursuz.
function rawAnswer(test, stim, k, friday) {
  switch (test) {
    case 'count': return stim.dots.length + k * 2;
    case 'track': return Math.min(1000, Math.round((trackLanding(stim) + k * 13 + 0.3) * 10) / 10);
    case 'angle': return stim.target + k * 3;
    case 'tempo': {
      const I = 60_000 / stim.bpm;
      return [0, 1, 2, 3].map((j) => j * I).concat(tempoExpected(stim.bpm, friday)).map((t) => Math.round((t + k * 17) * TS * 10) / 10);
    }
    default: return Math.round((splitValue(stim) + k * 0.021) * 10000) / 10000;
  }
}

// Sunucunun hesaplayacağı puan (aynı temizlik + ölçek dönüşümü)
function expectedScore(test, stim, raw, friday) {
  const clean = cleanAnswer(test, raw, friday);
  return evaluate(test, stim, test === 'tempo' ? clean.map((x) => x / TS) : clean, friday).score;
}

async function untilServer(t) {
  const wait = t - Date.now();
  if (wait > 0) await sleep(wait);
}

// Tüm testleri oyna. skip: Set('k:i') cevap vermeyecek bot/test. Dönen: { stimuli, expected[k][i], answers }
async function playAll(r, gameKey, { friday = false, skip = new Set(), go = true } = {}) {
  const tests = r.host.view.tests;
  const expected = r.bots.map(() => []);
  const stimuli = [];
  const answers = {};
  for (let i = 0; i < tests.length; i++) {
    await r.host.waitView((v) => v.gameKey === gameKey && v.index === i && (v.phase === 'intro' || v.phase === 'play'));
    if (go && r.host.view.phase === 'intro') r.host.action({ type: 'go', index: i });
    const pvs = await Promise.all(r.bots.map((b) => playView(b, gameKey, i)));
    assert.ok(pvs[0].stimulus, 'play başında uyaran gelmeli');
    // İstemciye ham uyaran gitmez: Say → oyuncu başına ayrı PNG adresi, Yörünge → örnekler; diğerleri herkese aynı.
    if (tests[i] === 'count') {
      assert.ok(pvs.every((pv) => /^\/api\/media\/[0-9a-f]{32}$/.test(pv.stimulus.image) && !hasKey(pv.stimulus, ['dots'])));
      assert.equal(new Set(pvs.map((pv) => pv.stimulus.image)).size, pvs.length, 'herkese ayrı medya adresi');
    } else for (const pv of pvs) assert.deepEqual(pv.stimulus, pvs[0].stimulus, 'herkese aynı uyaran');
    if (tests[i] === 'track') assert.ok(!hasKey(pvs[0].stimulus, ['g', 'vx', 'vy', 'x0', 'y0', 'landing']), 'atış parametresi sızdı');
    const stim = (await secret(srv, { room: r.code })).stimuli[i];
    assert.ok(pvs.every((pv) => pv.startAt === pvs[0].startAt), 'herkese aynı başlangıç anı');
    stimuli.push(stim);
    await untilServer(pvs[0].recallAt + 5);
    for (const [k, b] of r.bots.entries()) {
      if (skip.has(`${k}:${i}`)) { expected[k].push(0); continue; }
      const raw = rawAnswer(tests[i], stim, k, friday);
      answers[`${k}:${i}`] = raw;
      expected[k].push(expectedScore(tests[i], stim, raw, friday));
      b.action({ type: 'answer', index: i, answer: raw });
    }
    const rv = await r.host.waitView((v) => v.gameKey === gameKey && v.index === i && (v.phase === 'reveal' || v.phase === 'over'), { timeout: 8000 });
    for (const [k, b] of r.bots.entries()) {
      const res = rv.last.results[b.playerId];
      if (!res) continue; // ayrılan
      assert.equal(res.score, expected[k][i], `test ${tests[i]} ${b.name} puanı`);
    }
    if (rv.phase === 'reveal') r.host.action({ type: 'next', index: i });
  }
  const over = await r.host.waitView((v) => v.gameKey === gameKey && v.over, { timeout: 8000 });
  return { stimuli, expected, answers, over, tests };
}

// Metinde sayı var mı (başka sayının parçası değil)
const containsNum = (text, v) => new RegExp(`(^|[^0-9.])${String(v).replace('.', '[.]')}($|[^0-9])`).test(text);

// Gizli bilgi: uyaran play'den önce yok; play'de başkalarının cevabı ve süren testin sonucu yok; token yok.
function assertNoLeaks(r, gameKey, { stimuli, answers, tests }) {
  for (const [bk, b] of r.bots.entries()) {
    const views = b.messages.filter((m) => m.t === 'view' && m.view?.gameKey === gameKey).map((m) => m.view);
    for (const [i, stim] of stimuli.entries()) {
      const firstPlay = b.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === gameKey && m.view.phase === 'play' && m.view.index === i);
      assert.ok(firstPlay >= 0);
      const before = JSON.stringify(b.messages.slice(0, firstPlay));
      if (tests[i] === 'count' || tests[i] === 'track') assert.ok(!before.includes(JSON.stringify(stim)), `${b.name}: ${tests[i]} uyaranı play'den önce sızdı`);
      if (tests[i] === 'count') assert.ok(!before.includes(JSON.stringify(stim.dots[0])), 'nokta erken sızdı');
      // Gizli uyaran: nokta koordinatları ve atış parametreleri hiçbir mesajda (açıklamada da) yok.
      const all = b.transcript();
      if (tests[i] === 'count') assert.ok(!all.includes(JSON.stringify(stim.dots[0])) && !all.includes('"dots"'), 'nokta koordinatı sızdı');
      if (tests[i] === 'track') assert.ok(!/"(vx|vy|g|x0|y0)":/.test(all), 'yörünge parametresi sızdı');
    }
    for (const v of views) {
      if (v.phase !== 'play') assert.equal(v.stimulus, null, `${v.phase} fazında uyaran olmamalı`);
      if (v.phase === 'intro' || v.phase === 'play') {
        assert.ok(v.history.every((h) => h.index < v.index), 'süren testin sonucu görünümde');
        assert.equal(v.last, null);
      }
      if (v.phase === 'play') {
        for (const p of v.players) assert.deepEqual(Object.keys(p).sort(), ['answered', 'grade', 'id', 'name', 'scores', 'total']);
        // Uyaran (yörünge örnekleri) cevap değil: rastlantısal sayı eşleşmesi olmasın
        const text = JSON.stringify({ ...v, me: null, stimulus: null, history: v.history.map((h) => ({ ...h, stimulus: null })) });
        if (tests[v.index] === 'track') {
          for (const [ok] of r.bots.entries()) {
            const a = answers[`${ok}:${v.index}`];
            if (a != null && ok !== bk) assert.ok(!containsNum(text, a), `${b.name} başkasının cevabını erken gördü (${a})`);
          }
        }
      }
    }
    for (const other of r.bots) if (other !== b) assert.ok(!b.transcript().includes(other.token), 'token sızdı');
  }
}

for (const n of [1, 3, 8]) {
  test(`${n} kişi: 5 testlik tam oyun, puanlar evaluate ile aynı, ortalama + not, sızıntı yok`, async () => {
    const r = await room(n, {}, `P${n}-`);
    const gameKey = await start(r);
    assert.deepEqual(r.host.view.tests, TESTS);
    assert.equal(r.host.view.friday, false);
    const res = await playAll(r, gameKey);
    for (const [k, b] of r.bots.entries()) {
      const p = res.over.players.find((x) => x.id === b.playerId);
      assert.deepEqual(p.scores, res.expected[k]);
      assert.equal(p.total, finalScore(res.expected[k]), `${b.name} ortalaması`);
      assert.equal(p.grade, gradeOf(p.total));
    }
    assert.equal(res.over.history.length, 5);
    assert.equal(res.over.phase, 'over');
    // bot 0 kusursuz: en yüksek ortalama ona
    const best = Math.max(...res.over.players.map((p) => p.total));
    assert.equal(res.over.players.find((p) => p.id === r.host.playerId).total, best);
    await r.host.waitRoom((x) => x.phase === 'over');
    assertNoLeaks(r, gameKey, res);
  });
}

test('host atlamazsa intro süre dolunca kendiliğinden başlar; açıklama da kendiliğinden geçer; cevap vermeyen 0', async () => {
  const r = await room(2, { tests: 'count,split' });
  const gameKey = await start(r);
  assert.deepEqual(r.host.view.tests, ['count', 'split']);
  const res = await playAll(r, gameKey, { go: false, skip: new Set(['1:0']) });
  assert.deepEqual(res.over.history.map((h) => h.test), ['count', 'split']);
  const lazy = res.over.history[0].results[r.bots[1].playerId];
  assert.equal(lazy.score, 0);
  assert.equal(lazy.timedOut, true);
  // açıklamada "Sonraki" basılmasa da devam eder
  const r2 = await room(1, { tests: 'split' });
  const gk2 = await start(r2);
  const pv = await playView(r2.host, gk2, 0);
  r2.host.action({ type: 'answer', index: 0, answer: 0.5 });
  await r2.host.waitView((v) => v.gameKey === gk2 && v.phase === 'reveal');
  await r2.host.waitView((v) => v.gameKey === gk2 && v.over, { timeout: 4000 });
  assert.ok(pv.stimulus);
});

test('erken, çift, eski, bozuk, bilinmeyen ve yetkisiz eylemler', async () => {
  const r = await room(2, { tests: 'tempo,split' });
  const [a, b] = r.bots;
  const gameKey = await start(r);
  // intro'da cevap: yanlış faz, sessizce yok sayılır; host olmayan "go" diyemez
  const errs = a.errors.length;
  a.action({ type: 'answer', index: 0, answer: [] });
  await sleep(40);
  assert.equal(a.errors.length, errs);
  const notHost = await b.expectError({ type: 'go', index: 0 });
  assert.match(notHost.message, /oda sahibi/);
  a.action({ type: 'go', index: 0 });
  const pv = await playView(a, gameKey, 0);
  assert.ok(pv.stimulus.bpm >= 80);
  // ritim gösterimi bitmeden cevap reddedilir
  const early = await a.expectError({ type: 'answer', index: 0, answer: [1, 2, 3] });
  assert.match(early.message, /gösterim/);
  assert.equal(a.view.me.answered, false, 'erken cevap testi tüketmemeli');
  await untilServer(pv.recallAt + 5);
  // eski/gelecek test: sessizce yok sayılır
  a.action({ type: 'answer', index: 5, answer: [] });
  a.action({ type: 'answer', index: -1, answer: [] });
  a.action({ type: 'answer', index: '0x', answer: [] });
  a.action({ type: 'answer', answer: [] });
  await sleep(40);
  assert.equal(a.errors.length, errs + 1);
  assert.equal(a.view.me.answered, false);
  // bozuk değerler
  for (const bad of ['abc', { toString: 1 }, Array(41).fill(100), [1, 'x'], [{}], null]) {
    const e = await a.expectError({ type: 'answer', index: 0, answer: bad });
    assert.match(e.message, /Geçersiz/, JSON.stringify(bad));
  }
  // uç değerler sınıra çekilir (sayısal dizi, 40 dokunuşa kadar)
  await a.act({ type: 'answer', index: 0, answer: Array(40).fill(1e9) });
  assert.equal(a.view.me.answered, true);
  assert.equal(a.view.me.answer, 40);
  const dup = await a.expectError({ type: 'answer', index: 0, answer: [] });
  assert.match(dup.message, /zaten/);
  const unk = await b.expectError({ type: 'hack', index: 0 });
  assert.match(unk.message, /Bilinmeyen/);
  // b cevaplamaz; süre dolunca test kapanır, geç gelen cevap yok sayılır
  const rv = await a.waitView((v) => v.phase === 'reveal', { timeout: 6000 });
  assert.equal(rv.last.results[b.playerId].timedOut, true);
  const be = b.errors.length;
  b.action({ type: 'answer', index: 0, answer: [] });
  await sleep(40);
  assert.equal(b.errors.length, be);
  assert.equal(b.view.last.results[b.playerId].score, 0);
  const nn = await b.expectError({ type: 'next', index: 0 });
  assert.match(nn.message, /oda sahibi/);
  // eski "Sonraki" ikinci kez test atlatmaz
  a.action({ type: 'next', index: 0 });
  await a.waitView((v) => v.index === 1);
  a.action({ type: 'next', index: 0 });
  await sleep(40);
  assert.equal(a.view.index, 1);
  assert.equal(a.view.phase, 'intro');
  // böl: bozuk sayı reddedilir, aralık dışı sınıra çekilir
  a.action({ type: 'go', index: 1 });
  const sv = await playView(a, gameKey, 1);
  assert.ok(sv.stimulus.kind);
  const bad = await a.expectError({ type: 'answer', index: 1, answer: 'yarım' });
  assert.match(bad.message, /Geçersiz/);
  await a.act({ type: 'answer', index: 1, answer: 7 });
  assert.equal(a.view.me.answer, 1);
});

test('süre sınırı: tam endsAt anında gelen cevap kabul edilir', async () => {
  const r = await room(2, { tests: 'split' });
  const gameKey = await start(r);
  r.host.action({ type: 'go', index: 0 });
  const pv = await playView(r.host, gameKey, 0);
  r.host.action({ type: 'answer', index: 0, answer: 0.3 });
  await untilServer(pv.endsAt);
  r.bots[1].action({ type: 'answer', index: 0, answer: 0.7 });
  const rv = await r.host.waitView((v) => v.phase === 'reveal', { timeout: 4000 });
  const res = rv.last.results[r.bots[1].playerId];
  assert.equal(res.timedOut, false, 'sınırda gelen cevap sayılmalı');
  assert.equal(res.answer, 0.7);
  assert.equal(res.score, evaluate('split', pv.stimulus, 0.7, false).score);
});

test('yeniden bağlanma: intro, play (cevapsız/cevaplı), reveal ve over fazlarında durum korunur', async () => {
  const r = await room(2, { tests: 'count,angle' });
  const [a, b] = r.bots;
  const gameKey = await start(r);
  // intro
  await b.reconnect();
  let v = await b.waitFreshView();
  assert.equal(v.phase, 'intro');
  assert.equal(v.stimulus, null);
  a.action({ type: 'go', index: 0 });
  const pv = await playView(a, gameKey, 0);
  // play: gösterim bittikten sonra bağlanan zamanlı uyaranı (noktaları) tekrar almaz
  await untilServer(pv.recallAt + 5);
  await b.reconnect();
  v = await b.waitFreshView();
  assert.equal(v.phase, 'play');
  assert.equal(v.stimulus, null, 'gösterimden sonra noktalar tekrar gelmemeli');
  assert.equal(v.me.answered, false);
  // cevap verdikten sonra
  await b.act({ type: 'answer', index: 0, answer: 50 });
  await b.reconnect();
  v = await b.waitFreshView();
  assert.equal(v.me.answered, true);
  assert.equal(v.me.answer, 50);
  assert.equal(a.view.players.find((p) => p.id === b.playerId).answered, true, 'diğerleri kimin cevapladığını görür');
  assert.ok(!JSON.stringify({ ...a.view, me: null }).includes(':50,'), 'ama cevabı göremez');
  // açı: süresiz uyaran yeniden bağlanınca tekrar gelir
  a.action({ type: 'answer', index: 0, answer: 60 });
  await a.waitView((x) => x.phase === 'reveal');
  // reveal
  await b.reconnect();
  v = await b.waitFreshView();
  assert.equal(v.phase, 'reveal');
  assert.equal(v.last.results[b.playerId].answer, 50);
  a.action({ type: 'next', index: 0 });
  await a.waitView((x) => x.index === 1 && x.phase === 'intro');
  a.action({ type: 'go', index: 1 });
  const av = await playView(a, gameKey, 1);
  await b.reconnect();
  v = await b.waitFreshView();
  assert.equal(v.phase, 'play');
  assert.deepEqual(v.stimulus, av.stimulus, 'açı hedefi tekrar gelmeli');
  await untilServer(av.recallAt + 5);
  a.action({ type: 'answer', index: 1, answer: 90 });
  b.action({ type: 'answer', index: 1, answer: 180 });
  await a.waitView((x) => x.phase === 'reveal');
  a.action({ type: 'next', index: 1 });
  await a.waitView((x) => x.over);
  // over
  await b.reconnect();
  v = await b.waitFreshView();
  assert.equal(v.over, true);
  assert.equal(v.players.length, 2);
  assert.equal(v.history.length, 2);
});

test('oyun ortası ayrılan: kalanlar cevapladıysa test hemen biter, sıralamadan düşer; herkes ayrılırsa oyun biter', async () => {
  const r = await room(3, { tests: 'angle,split' });
  const [a, b, c] = r.bots;
  const gameKey = await start(r);
  a.action({ type: 'go', index: 0 });
  const pv = await playView(a, gameKey, 0);
  await untilServer(pv.recallAt + 5);
  a.action({ type: 'answer', index: 0, answer: 40 });
  b.action({ type: 'answer', index: 0, answer: 60 });
  await a.waitView((v) => v.players.filter((p) => p.answered).length === 2);
  c.leave();
  const rv = await a.waitView((v) => v.phase === 'reveal', { timeout: 1500 });
  assert.equal(rv.players.length, 2);
  assert.deepEqual(Object.keys(rv.last.results).sort(), [a.playerId, b.playerId].sort());
  // sonraki testte ayrılan beklenmez: iki cevapla biter
  a.action({ type: 'next', index: 0 });
  await a.waitView((v) => v.index === 1);
  a.action({ type: 'go', index: 1 });
  await playView(a, gameKey, 1);
  a.action({ type: 'answer', index: 1, answer: 0.5 });
  b.action({ type: 'answer', index: 1, answer: 0.5 });
  const ov = await a.waitView((v) => v.over, { timeout: 2000 });
  assert.equal(ov.players.length, 2);
  assert.ok(ov.players.every((p) => p.scores.length === 2));
  // tek oyuncu + izleyici: oyuncu ayrılınca oyun biter, izleyici sonu görür
  const r2 = await room(1, { tests: 'split' });
  const gk2 = await start(r2);
  const spec = new Bot(srv.wsUrl, 'İzleyici');
  all.push(spec);
  await spec.connect();
  await spec.join(r2.code);
  const sv = await spec.waitView((v) => v.gameKey === gk2);
  assert.equal(sv.me.playing, false);
  r2.host.leave();
  const end = await spec.waitView((v) => v.over, { timeout: 2000 });
  assert.equal(end.players.length, 0);
});

test('izleyici: intro ve açıklamayı görür, uyaranı almaz, cevap veremez', async () => {
  const r = await room(2, { tests: 'count,split' });
  const gameKey = await start(r);
  const spec = new Bot(srv.wsUrl, 'Seyirci');
  all.push(spec);
  await spec.connect();
  const joined = await spec.join(r.code);
  assert.equal(joined.players.find((p) => p.id === spec.playerId).spectator, true);
  r.host.action({ type: 'go', index: 0 });
  const sv = await playView(spec, gameKey, 0);
  assert.equal(sv.stimulus, null, 'izleyiciye uyaran gitmez');
  assert.equal(sv.me.playing, false);
  assert.ok(sv.players.every((p) => p.id !== spec.playerId), 'izleyici oyuncu listesinde değil');
  const e = await spec.expectError({ type: 'answer', index: 0, answer: 10 });
  assert.match(e.message, /İzleyici/);
  const pv = await playView(r.host, gameKey, 0);
  await untilServer(pv.recallAt + 5);
  for (const b of r.bots) b.action({ type: 'answer', index: 0, answer: 60 });
  const rv = await spec.waitView((v) => v.phase === 'reveal');
  assert.equal(rv.last.truth, (await secret(srv, { room: r.code })).stimuli[0].dots.length);
  assert.equal(Object.keys(rv.last.results).length, 2);
});

test('🃏 Cuma ayarı: kurallar ve toleranslar Cuma; ayar doğrulama ve test seçimi', async () => {
  const { bots, host } = await makeRoom(srv.wsUrl, 'perceptle', 2, 'Ayar');
  all.push(...bots);
  host.send({ t: 'settings', settings: { rules: 'yok', tests: 'hack,zzz' } });
  let s = (await host.waitRoom((x) => x.settings.rules === 'normal' && x.settings.tests === TESTS.join(','))).settings;
  host.send({ t: 'settings', settings: { tests: 'split, count,count,tempo' } });
  s = (await host.waitRoom((x) => x.settings.tests !== TESTS.join(','))).settings;
  assert.equal(s.tests, 'count,tempo,split', 'sabit sıra, tekrarsız');
  host.send({ t: 'settings', settings: { tests: '' } });
  s = (await host.waitRoom((x) => x.settings.tests === TESTS.join(','))).settings;
  const notHost = bots[1].waitFor((m) => m.t === 'error');
  bots[1].send({ t: 'settings', settings: { rules: 'friday' } });
  assert.match((await notHost).message, /oda sahibi/);

  const r = await room(2, { rules: 'friday', tests: 'count,track,angle,tempo,split' }, 'Cuma');
  const gameKey = await start(r);
  assert.equal(r.host.view.friday, true);
  const res = await playAll(r, gameKey, { friday: true });
  assert.equal(res.stimuli[0].dots[0].length, 5, 'Cuma noktaları hareketli');
  assert.equal(res.stimuli[1].walls, true, 'Cuma topu duvardan seker');
  const p0 = res.over.players.find((p) => p.id === r.host.playerId);
  assert.ok(p0.total >= 95, `kusursuz Cuma oyunu ${p0.total}`);
});

test('paralel odalar: 4 oda aynı anda, uyaranlar odalar arasında farklı, puanlar karışmaz', async () => {
  const rooms = await Promise.all([0, 1, 2, 3].map((i) => room(2, { tests: 'count,split' }, `R${i}-`)));
  const results = await Promise.all(rooms.map(async (r) => {
    const gk = await start(r);
    return { r, ...(await playAll(r, gk)) };
  }));
  const counts = results.map((x) => JSON.stringify(x.stimuli[0]));
  assert.equal(new Set(counts).size, 4, 'her odanın uyaranı farklı (kripto RNG)');
  for (const { r, over, expected } of results) {
    for (const [k, b] of r.bots.entries()) assert.deepEqual(over.players.find((p) => p.id === b.playerId).scores, expected[k]);
  }
  // Aynı odada yeni oyun yeni uyaran
  const { r } = results[0];
  await r.host.waitRoom((x) => x.phase === 'over');
  r.host.send({ t: 'backToLobby' });
  await r.host.waitRoom((x) => x.phase === 'lobby');
  const gk = await start(r);
  const again = await playAll(r, gk);
  assert.notDeepEqual(again.stimuli[0], results[0].stimuli[0]);
});

test('varsayılan kurallar: İstanbul Cuma günü kurulan oda 🃏 Cuma, diğer günler Normal; host değiştirebilir', async () => {
  const fri = await startServer({ timeScale: TS, env: { FAKE_TODAY: FRIDAY } });
  try {
    const { bots, host } = await makeRoom(fri.wsUrl, 'perceptle', 2, 'Cum');
    all.push(...bots);
    assert.equal(host.room.settings.rules, 'friday');
    assert.equal(bots[1].room.settings.rules, 'friday');
    host.send({ t: 'settings', settings: { rules: 'normal' } });
    await bots[1].waitRoom((x) => x.settings.rules === 'normal');
    host.send({ t: 'settings', settings: { rules: 'friday' } });
    await host.waitRoom((x) => x.settings.rules === 'friday');
    host.send({ t: 'start' });
    const v = await host.waitView((x) => x.phase === 'intro');
    assert.equal(v.friday, true);
  } finally {
    await fri.stop();
  }
  const { bots, host } = await makeRoom(srv.wsUrl, 'perceptle', 1, 'Pzt');
  all.push(...bots);
  assert.equal(host.room.settings.rules, 'normal', 'Pazartesi varsayılan Normal');
  host.send({ t: 'settings', settings: { rules: 'friday' } });
  await host.waitRoom((x) => x.settings.rules === 'friday');
});
