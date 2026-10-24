// Nüans + Ton Avı tek oyunculu HTTP uçları: hedef sadece tur başlarken gelir, günlük tek hak,
// geç cevap 0, sıralama görünürlüğü, sınırsız mod sahipliği, yeniden başlatmada kalıcılık.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../lib/server.js';
import { sleep } from '../lib/bot.js';
import { scoreColor, scoreTone, hexToRgb } from '../../public/recall-math.js';

const DAY = '2026-11-07';
process.env.TEST_GAMES = '1';
process.env.RECALL_SALT = 'test-salt'; // tests/lib/server.js ile aynı
process.env.FAKE_TODAY = DAY;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-recall-api-'));
const { dailyTarget } = await import('../../server/recall.js');

const GAMES = {
  nuance: { wrong: '#123456', score: (t, g) => scoreColor(hexToRgb(t), hexToRgb(g)), hard: 'expert' },
  tone: { wrong: 333.3, score: (t, g) => scoreTone(t, g), hard: 'hard' },
};

let srv;
const env = { FAKE_TODAY: DAY };
before(async () => { srv = await startServer({ env, timeScale: 0.02 }); }); // hatırlama 0.6 sn, pay 0.25 sn
after(async () => { await srv.stop(); });

async function post(path, body) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json, text: JSON.stringify(json) };
}
const identity = async (name) => (await post('/api/identity', { name })).json;
const api = (game, ep, body) => post(`/api/recall/${game}/${ep}`, body);

for (const [game, G] of Object.entries(GAMES)) {
  const targets = [0, 1, 2, 3, 4].map((i) => dailyTarget(game, DAY, i));
  // Sayılar zaman damgalarının içinde rastlantıyla geçmesin: sadece tek başına duran sayı eşleşir.
  const has = (text, t) => (typeof t === 'number'
    ? new RegExp(`(^|[^0-9.])${String(t).replace('.', '\\.')}($|[^0-9])`).test(text)
    : text.includes(JSON.stringify(t)));

  test(`${game} günlük: hedef sadece tur başında, tekrar başlatılamaz, tek hak`, async () => {
    const me = await identity(`Usta-${game}`);
    const start = await api(game, 'start', { ...me, mode: 'daily' });
    assert.equal(start.status, 200, start.text);
    assert.equal(start.json.gameId, DAY);
    assert.equal(start.json.rounds, 5);
    assert.ok(targets.every((t) => !has(start.text, t)), 'başlangıçta hedef sızdı');

    const skipAhead = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 1 });
    assert.match(skipAhead.json.error, /önceki/);

    let expectedSum = 0;
    const scores = [];
    for (let i = 0; i < 5; i++) {
      const r = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: i });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.target, targets[i]);
      assert.ok(targets.slice(i + 1).every((t) => !has(r.text, t)), 'sonraki turun hedefi sızdı');
      const again = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: i });
      assert.match(again.json.error, /zaten başladı/);
      assert.ok(!has(again.text, targets[i]));
      // tur sürerken sayfa yenilenirse hedef yeniden gelmez
      const mid = await api(game, 'start', { ...me, mode: 'daily' });
      assert.equal(mid.json.pending.round, i);
      assert.ok(!has(mid.text, targets[i]), 'yenilemede hedef tekrar geldi');

      const guess = i === 0 ? targets[0] : G.wrong;
      const s = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: i, guess });
      assert.equal(s.status, 200, s.text);
      const want = G.score(targets[i], guess);
      assert.equal(s.json.played[i].score, want);
      assert.deepEqual(s.json.played[i].target, targets[i]);
      scores.push(want);
      expectedSum += want;
      const dup = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: i, guess });
      assert.match(dup.json.error, /zaten/);
      if (i === 4) {
        assert.equal(s.json.done, true);
        assert.equal(s.json.total, game === 'nuance' ? Math.round(expectedSum / 5) : Math.round(expectedSum * 100) / 100);
      }
    }
    assert.equal(scores[0], game === 'nuance' ? 1000 : 10);

    const replay = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
    assert.match(replay.json.error, /bitirdin/);
    const resume = await api(game, 'start', { ...me, mode: 'daily' });
    assert.equal(resume.json.done, true);
    assert.equal(resume.json.played.length, 5);
  });

  test(`${game} günlük: sıralama sadece bitirenleri, ayrıntıları sadece bitirene gösterir`, async () => {
    const finisher = (await identity(`Usta-${game}`)); // farklı kimlik
    for (let i = 0; i < 5; i++) {
      await api(game, 'round', { ...finisher, mode: 'daily', gameId: DAY, round: i });
      await api(game, 'submit', { ...finisher, mode: 'daily', gameId: DAY, round: i, guess: G.wrong });
    }
    const lb = (await api(game, 'leaderboard', finisher)).json;
    assert.ok(lb.entries.length >= 2);
    assert.ok(lb.entries.every((e) => Array.isArray(e.rounds)));
    for (let i = 1; i < lb.entries.length; i++) assert.ok(lb.entries[i - 1].total >= lb.entries[i].total, 'sıralama puana göre');

    const halfway = await identity(`Yarım-${game}`);
    await api(game, 'round', { ...halfway, mode: 'daily', gameId: DAY, round: 0 });
    const lb2 = await api(game, 'leaderboard', halfway);
    assert.ok(lb2.json.entries.every((e) => e.rounds === null), 'bitirmeyen başkalarının cevaplarını görmemeli');
    assert.ok(lb2.json.entries.every((e) => e.name !== `Yarım-${game}`), 'bitirmeyen sıralamada olmamalı');
    assert.ok(targets.slice(1).every((t) => !has(lb2.text, t)), 'sıralamada hedef sızdı');
    assert.ok(lb2.json.playing >= 1);
  });

  test(`${game}: süresi geçmiş cevap sayılmaz (0 puan)`, async () => {
    const me = await identity(`Geç-${game}`);
    await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
    await sleep(1300); // ezber + hatırlama + pay (ölçekli) geçti
    const late = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess: targets[0] });
    assert.equal(late.status, 200, late.text);
    assert.equal(late.json.played[0].score, 0);
    assert.equal(late.json.played[0].timedOut, true);
    // cevaplamadan bırakılan tur da sonradan 0 sayılır
    await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 1 });
    await sleep(1300);
    const resume = await api(game, 'start', { ...me, mode: 'daily' });
    assert.equal(resume.json.played.length, 2);
    assert.equal(resume.json.played[1].score, 0);
    assert.equal(resume.json.pending, null);
  });

  test(`${game}: bozuk girdiler`, async () => {
    const me = await identity(`Bozuk-${game}`);
    await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
    for (const guess of [null, {}, [], 'abc', { toString: 1 }]) {
      const r = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess });
      assert.equal(r.status, 400, `${JSON.stringify(guess)} kabul edildi`);
    }
    for (const round of [-1, 5, 1.5, 'x', null, {}]) {
      const r = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round });
      assert.equal(r.status, 400);
    }
    const old = await api(game, 'round', { ...me, mode: 'daily', gameId: '2026-11-06', round: 1 });
    assert.match(old.json.error, /değişti/);
    const noAuth = await api(game, 'start', { playerId: me.playerId, token: 'yanlis' });
    assert.match(noAuth.json.error, /Kimlik/);
    if (game === 'tone') {
      const clamped = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess: 1e9 });
      assert.equal(clamped.json.played[0].guess, 1200, 'günlük Kolay: 1200 Hz sınırı');
    }
  });

  test(`${game} sınırsız: rastgele hedef, zorluk seçilir, başkasının oyunu oynanamaz`, async () => {
    const a = await identity('A');
    const b = await identity('B');
    const g = (await api(game, 'start', { ...a, mode: 'free', difficulty: G.hard })).json;
    assert.ok(g.gameId && g.gameId !== DAY);
    assert.equal(g.difficulty, G.hard);
    assert.ok(g.memorizeMs < (game === 'nuance' ? 100 : 61), 'zor/uzman ezber süresi kısa (ölçekli)');
    const steal = await api(game, 'round', { ...b, mode: 'free', gameId: g.gameId, round: 0 });
    assert.match(steal.json.error, /bulunamadı/);
    const r0 = (await api(game, 'round', { ...a, mode: 'free', gameId: g.gameId, round: 0 })).json;
    assert.ok(r0.target != null);
    const s = (await api(game, 'submit', { ...a, mode: 'free', gameId: g.gameId, round: 0, guess: r0.target })).json;
    assert.equal(s.played[0].score, game === 'nuance' ? 1000 : 10);
    const bogus = (await api(game, 'start', { ...a, mode: 'free', difficulty: '__proto__' })).json;
    assert.equal(bogus.difficulty, game === 'nuance' ? 'normal' : 'easy');
  });
}

test('bilinmeyen hafıza oyunu / uç 404', async () => {
  const me = await identity('X');
  assert.equal((await post('/api/recall/hack/start', me)).status, 404);
  assert.equal((await post('/api/recall/nuance/delete', me)).status, 404);
});

test('sunucu yeniden başlayınca günlük ilerleme ve başlamış tur korunur', async () => {
  const me = await identity('Kalıcı');
  await api('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
  await api('nuance', 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess: '#000000' });
  await api('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 1 });
  await sleep(700); // gecikmeli yazma
  await srv.stop();
  srv = await startServer({ env, timeScale: 0.02, dataDir: srv.dataDir });
  const resume = await api('nuance', 'start', { ...me, mode: 'daily' });
  assert.equal(resume.status, 200, resume.text);
  assert.equal(resume.json.played.length >= 1, true);
  const again = await api('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 1 });
  assert.match(again.json.error, /zaten başladı/, 'yeniden başlatma turu sıfırlamamalı');
});
