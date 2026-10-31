// 👁️ Algıla tek oyunculu HTTP uçları: uyaran sadece test başında, testler sırayla, günlük tek hak, erken cevap reddi,
// zaman aşımı 0, sıralama görünürlüğü, Cuma tespiti (FAKE_TODAY), sınırsız mod sahipliği ve sınırı, bozuk girdiler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../lib/server.js';
import { sleep } from '../lib/bot.js';
import { secret, hasKey } from '../lib/media.js';
import { TESTS, gradeOf, finalScore, tempoExpected, trackLanding, splitValue } from '../../public/perceptle-math.js';

const DAY = '2026-11-02'; // Pazartesi
const FRIDAY = '2026-11-06';
const TS = 0.02;
process.env.TEST_GAMES = '1';
process.env.PERCEPTLE_SALT = 'test-salt'; // tests/lib/server.js ile aynı
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-perceptle-api-'));
const { dailyStimulus } = await import('../../server/perceptle.js');

let srv;
let fri;
before(async () => {
  [srv, fri] = await Promise.all([
    startServer({ env: { FAKE_TODAY: DAY }, timeScale: TS }), // cevap süresi 90 sn × 0.02 = 1.8 sn
    startServer({ env: { FAKE_TODAY: FRIDAY }, timeScale: TS }),
  ]);
});
after(async () => { await Promise.all([srv.stop(), fri.stop()]); });

async function post(server, path, body) {
  const res = await fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json, text: JSON.stringify(json) };
}
const identity = async (name, server = srv) => (await post(server, '/api/identity', { name })).json;
const api = (ep, body, server = srv) => post(server, `/api/perceptle/${ep}`, body);

// Kusursuz cevap (ritim: ölçekli zamanda vuruşlar)
function perfect(test, stim, friday) {
  switch (test) {
    case 'count': return stim.dots.length;
    case 'track': return trackLanding(stim);
    case 'angle': return stim.target;
    case 'tempo': {
      const I = 60_000 / stim.bpm;
      return [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(stim.bpm, friday)).map((t) => t * TS);
    }
    default: return splitValue(stim);
  }
}

// Bir testi oynat: başlat, gösterim bitene kadar bekle, cevap gönder.
async function play(me, index, answerFn, { server = srv, mode = 'daily', gameId = DAY } = {}) {
  const r = await api('test', { ...me, mode, gameId, index }, server);
  assert.equal(r.status, 200, r.text);
  await sleep(r.json.showMs + 30);
  // Uyaranın ham hâli artık istemciye gitmiyor (nokta PNG'si / yörünge örnekleri); kusursuz cevap için testlere özel uçtan.
  const stim = (await secret(server, { gameId })).stimuli[index];
  const answer = answerFn(stim, r.json);
  const s = await api('submit', { ...me, mode, gameId, index, answer }, server);
  assert.equal(s.status, 200, s.text);
  return { r: r.json, s: s.json };
}

const stimKeys = /"(dots|bpm|target|x0|vx|vy|num|den|pct|image|samples)"/;

// İstemciye giden uyaran: Say → PNG adresi (nokta listesi yok), Yörünge → örnekler (g/hız/iniş yok), diğerleri aynı.
function assertPublicStim(test, pub, raw) {
  if (test === 'count') {
    assert.match(pub.image, /^\/api\/media\/[0-9a-f]{32}$/);
    assert.ok(!hasKey(pub, ['dots']), 'nokta koordinatları sızdı');
  } else if (test === 'track') {
    assert.ok(Array.isArray(pub.samples) && pub.samples.length >= 30);
    assert.ok(!hasKey(pub, ['g', 'vx', 'vy', 'x0', 'y0', 'landing']), 'atış parametresi sızdı');
    assert.equal(pub.visible, raw.visible);
  } else assert.deepEqual(pub, raw);
}

test('günlük: uyaran sadece test başında, sırayla, tekrar başlatılamaz, kusursuz cevap 100, tek hak', async () => {
  const me = await identity('Keskin');
  const start = await api('start', { ...me, mode: 'daily' });
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.gameId, DAY);
  assert.equal(start.json.puzzleNo, 8); // 2026-10-26 = #1
  assert.equal(start.json.friday, false);
  assert.deepEqual(start.json.tests, TESTS);
  assert.ok(!stimKeys.test(start.text), 'başlangıçta uyaran sızdı');

  const skip = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 1 });
  assert.match(skip.json.error, /önceki/);

  for (let i = 0; i < 5; i++) {
    const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index: i });
    assert.equal(r.status, 200, r.text);
    assertPublicStim(TESTS[i], r.json.stimulus, dailyStimulus(DAY, i));
    assert.equal(r.json.test, TESTS[i]);
    const again = await api('test', { ...me, mode: 'daily', gameId: DAY, index: i });
    assert.match(again.json.error, /zaten başladı/);
    assert.ok(!stimKeys.test(again.text));
    const next = await api('test', { ...me, mode: 'daily', gameId: DAY, index: i + 1 });
    assert.equal(next.status, 400, 'cevapsız testten sonra yenisi başladı');
    // sayfa yenilenirse zamanlı uyaran tekrar gelmez (açı/böl hedefi gelir)
    const mid = await api('start', { ...me, mode: 'daily' });
    assert.equal(mid.json.pending.index, i);
    if (['angle', 'split'].includes(TESTS[i])) assert.deepEqual(mid.json.pending.stimulus, dailyStimulus(DAY, i));
    else assert.equal(mid.json.pending.stimulus, null, 'yenilemede zamanlı uyaran tekrar geldi');
    await sleep(r.json.showMs + 30);
    const answer = perfect(TESTS[i], dailyStimulus(DAY, i), false);
    const s = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: i, answer });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.played[i].score, 100, `${TESTS[i]} kusursuz cevap 100 almalı (${s.text})`);
    assert.equal(s.json.played[i].timedOut, false);
    const dup = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: i, answer });
    assert.match(dup.json.error, /zaten/);
    if (i === 4) {
      assert.equal(s.json.done, true);
      assert.equal(s.json.total, 100);
      assert.equal(s.json.grade, 'S');
    }
  }
  const replay = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 });
  assert.match(replay.json.error, /bitirdin/);
  const resume = await api('start', { ...me, mode: 'daily' });
  assert.equal(resume.json.done, true);
  assert.equal(resume.json.played.length, 5);
  assert.equal(resume.json.played[0].truth, dailyStimulus(DAY, 0).dots.length);
});

test('erken cevap reddedilir ve testi tüketmez; ritim de son vuruştan önce kabul edilmez (gerçek süreler)', async () => {
  const slow = await startServer({ env: { FAKE_TODAY: DAY }, timeScale: 1 }); // say 2 sn, ritim ~7 sn
  try {
    const o = { server: slow };
    const me = await identity('Aceleci', slow);
    const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 }, slow);
    assert.equal(r.json.showMs, 2000);
    const early = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: dailyStimulus(DAY, 0).dots.length }, slow);
    assert.equal(early.status, 400, 'gösterim bitmeden cevap kabul edildi');
    assert.match(early.json.error, /gösterim/);
    const st = (await api('start', { ...me, mode: 'daily' }, slow)).json;
    assert.equal(st.played.length, 0, 'erken cevap test olarak sayıldı');
    assert.equal(st.pending.index, 0);
    assert.ok(st.pending.recallAt > st.serverNow, 'pending.recallAt gösterim bitişini vermeli');
    await sleep(r.json.showMs + 30);
    assert.equal((await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: 50 }, slow)).status, 200);
    await play(me, 1, () => 500, o);
    await play(me, 2, () => 90, o);
    const t = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 3 }, slow);
    assert.equal(t.json.showMs, Math.round(1500 + tempoExpected(dailyStimulus(DAY, 3).bpm, false).at(-1)));
    assert.equal(t.json.leadMs, 1500);
    const tooSoon = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 3, answer: [] }, slow);
    assert.equal(tooSoon.status, 400, 'ritim son vuruştan önce gönderildi');
  } finally {
    await slow.stop();
  }
});

test('zaman aşımı: geç cevap 0 sayılır; bırakılan test sonradan 0 olur', async () => {
  const me = await identity('Geç');
  const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 });
  await sleep(r.json.endsAt - r.json.startedAt + 400); // 1.8 sn cevap + pay
  const late = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: dailyStimulus(DAY, 0).dots.length });
  assert.equal(late.status, 200, late.text);
  assert.equal(late.json.played[0].score, 0);
  assert.equal(late.json.played[0].timedOut, true);
  const r1 = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 1 });
  await sleep(r1.json.endsAt - r1.json.startedAt + 400);
  const resume = await api('start', { ...me, mode: 'daily' });
  assert.equal(resume.json.played.length, 2);
  assert.equal(resume.json.played[1].score, 0);
  assert.equal(resume.json.pending, null);
});

test('sıralama: sadece bitirenler; test puanları sadece bitirene görünür; ad güncel', async () => {
  const a = await identity('Birinci');
  for (let i = 0; i < 5; i++) await play(a, i, (stim) => perfect(TESTS[i], stim, false));
  const b = await identity('Orta');
  const scores = [];
  for (let i = 0; i < 5; i++) {
    const wrong = [80, 100, 200, [], 0.9][i];
    const { s } = await play(b, i, () => wrong);
    scores.push(s.played[i].score);
  }
  const lb = (await api('leaderboard', b)).json;
  assert.equal(lb.viewerDone, true);
  assert.ok(lb.entries.length >= 2);
  assert.ok(lb.entries.every((e) => Array.isArray(e.scores) && e.scores.length === 5));
  const mine = lb.entries.find((e) => e.me);
  assert.equal(mine.name, 'Orta');
  assert.deepEqual(mine.scores, scores);
  assert.equal(mine.total, finalScore(scores));
  assert.equal(mine.grade, gradeOf(mine.total));
  for (let i = 1; i < lb.entries.length; i++) assert.ok(lb.entries[i - 1].total >= lb.entries[i].total);
  assert.equal(lb.entries[0].total, 100);

  const half = await identity('Yarım');
  await play(half, 0, () => 60);
  const lb2 = await api('leaderboard', half);
  assert.equal(lb2.json.viewerDone, false);
  assert.ok(lb2.json.entries.every((e) => e.scores === null), 'bitirmeyen başkalarının puanlarını gördü');
  assert.ok(lb2.json.entries.every((e) => e.name !== 'Yarım'));
  assert.ok(lb2.json.playing >= 1);
  // ad değişince sıralamada güncel ad
  await post(srv, '/api/identity', { ...b, name: 'Orta2' });
  const lb3 = (await api('leaderboard', b)).json;
  assert.ok(lb3.entries.some((e) => e.me && e.name === 'Orta2'));
});

test('Cuma (FAKE_TODAY): kurallar otomatik, hareketli noktalar, sekmeli top, geniş tolerans', async () => {
  const me = await identity('Cumacı', fri);
  const st = (await api('start', { ...me, mode: 'daily' }, fri)).json;
  assert.equal(st.friday, true);
  assert.equal(st.gameId, FRIDAY);
  const o = { server: fri, gameId: FRIDAY };
  const { r: c } = await play(me, 0, (stim) => Math.round(stim.dots.length * 1.32), o);
  assert.equal(c.friday, true);
  assert.ok(c.stimulus.frames > 1 && c.stimulus.fps > 0, 'Cuma noktaları hareketli (kare şeridi)');
  assert.ok(!hasKey(c.stimulus, ['dots']));
  const { r: t, s } = await play(me, 1, (stim) => trackLanding(stim) + 90, o);
  assert.equal(t.stimulus.walls, true);
  assert.equal(s.played[1].score, 61, 'Cuma toleransı 90');
  const { s: s2 } = await play(me, 2, (stim) => stim.target + 14, o);
  assert.equal(s2.played[2].score, 61, 'Cuma açı toleransı 14');
  const { s: s3 } = await play(me, 3, (stim) => perfect('tempo', stim, true), o);
  assert.equal(s3.played[3].score, 100, 'Cuma ritmi vuruş aralarında');
  const { r: sp, s: s4 } = await play(me, 4, (stim) => splitValue(stim), o);
  const v = splitValue(sp.stimulus); // böl hedefi ekranda yazılı: olduğu gibi gelir
  assert.ok(v < 0 || v > 1, 'Cuma kesri çizginin dışında');
  assert.equal(s4.played[4].score, 100);
  assert.equal(s4.done, true);
  const sc = s4.played[0].score; // ≈ %32 hata = 1 × Cuma toleransı (yuvarlama payı)
  assert.ok(sc >= 55 && sc <= 67, `Cuma say puanı ${sc}`);
});

test('sınırsız: kurallar seçilir, kayıt yok, başkasının oyunu oynanamaz, kişi başı 3 oyun', async () => {
  const a = await identity('SınırsızA');
  const b = await identity('SınırsızB');
  const g = (await api('start', { ...a, mode: 'free', rules: 'friday' })).json;
  assert.ok(g.gameId && g.gameId !== DAY);
  assert.equal(g.friday, true);
  assert.equal(g.puzzleNo, undefined);
  const steal = await api('test', { ...b, mode: 'free', gameId: g.gameId, index: 0 });
  assert.match(steal.json.error, /bulunamadı/);
  const o = { mode: 'free', gameId: g.gameId };
  for (let i = 0; i < 5; i++) await play(a, i, (stim) => perfect(TESTS[i], stim, true), o);
  const done = (await api('start', { ...a, mode: 'free', rules: 'normal' })).json;
  assert.equal(done.friday, false);
  const lb = (await api('leaderboard', a)).json;
  assert.ok(lb.entries.every((e) => e.name !== 'SınırsızA'), 'sınırsız oyun sıralamaya girdi');
  // kişi başı en fazla 3 sınırsız oyun: en eskisi silinir
  const ids = [g.gameId, done.gameId];
  for (let k = 0; k < 2; k++) ids.push((await api('start', { ...a, mode: 'free' })).json.gameId);
  const gone = await api('test', { ...a, mode: 'free', gameId: ids[0], index: 0 });
  assert.match(gone.json.error, /bulunamadı/);
  const kept = await api('test', { ...a, mode: 'free', gameId: ids[3], index: 0 });
  assert.equal(kept.status, 200);
  const bogus = (await api('start', { ...a, mode: 'free', rules: '__proto__' })).json;
  assert.equal(bogus.friday, false);
});

test('bozuk girdiler reddedilir veya sınıra çekilir', async () => {
  const me = await identity('Bozuk');
  const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 });
  await sleep(r.json.showMs + 30);
  for (const answer of [null, {}, [], 'abc', { toString: 1 }, true]) {
    const s = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer });
    assert.equal(s.status, 400, `${JSON.stringify(answer)} kabul edildi`);
  }
  for (const index of [-1, 5, 1.5, 'x', null, {}]) {
    assert.equal((await api('test', { ...me, mode: 'daily', gameId: DAY, index })).status, 400);
  }
  const old = await api('test', { ...me, mode: 'daily', gameId: '2026-11-01', index: 1 });
  assert.match(old.json.error, /değişti/);
  assert.match((await api('start', { playerId: me.playerId, token: 'yanlis' })).json.error, /Kimlik/);
  const clamped = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: 1e9 });
  assert.equal(clamped.json.played[0].answer, 999);
  // Ritim: dizi değilse, 40'tan uzunsa, sayı olmayan öğe varsa reddedilir
  const f = (await api('start', { ...me, mode: 'free' })).json;
  const o = { mode: 'free', gameId: f.gameId };
  for (let i = 0; i < 3; i++) await play(me, i, () => 1, o);
  const t = await api('test', { ...me, ...o, index: 3 });
  await sleep(t.json.showMs + 30);
  for (const answer of [12, 'x', Array(41).fill(1), [1, 'a'], [1, null], [{}]]) {
    const s = await api('submit', { ...me, ...o, index: 3, answer });
    assert.equal(s.status, 400, `ritim ${JSON.stringify(answer).slice(0, 40)} kabul edildi`);
  }
  const ok = await api('submit', { ...me, ...o, index: 3, answer: [1e12, -1e12, '5'] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.played[3].answer, 3, 'kayıtta dokunuş sayısı');
  // Açı normalde 0–360'a katlanır, böl 0–1'e çekilir
  const a = await play(me, 4, () => 7, o);
  assert.equal(a.s.played[4].answer, 1);
  const n = (await api('start', { ...me, mode: 'free' })).json;
  const o2 = { mode: 'free', gameId: n.gameId };
  for (let i = 0; i < 2; i++) await play(me, i, () => 1, o2);
  const an = await play(me, 2, () => -30, o2);
  assert.equal(an.s.played[2].answer, 330);
});

test('bilinmeyen uç 404', async () => {
  const me = await identity('X');
  assert.equal((await post(srv, '/api/perceptle/delete', me)).status, 404);
  assert.equal((await post(srv, '/api/perceptle/', me)).status, 404);
});

test('sunucu yeniden başlayınca günlük ilerleme korunur, başlamış test sıfırlanmaz', async () => {
  const me = await identity('Kalıcı');
  await play(me, 0, () => 60);
  await api('test', { ...me, mode: 'daily', gameId: DAY, index: 1 });
  await sleep(700); // gecikmeli yazma
  await srv.stop();
  srv = await startServer({ env: { FAKE_TODAY: DAY }, timeScale: TS, dataDir: srv.dataDir });
  const resume = await api('start', { ...me, mode: 'daily' });
  assert.equal(resume.status, 200, resume.text);
  assert.equal(resume.json.played.length, 1);
  const again = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 1 });
  assert.match(again.json.error, /zaten başladı/);
});
