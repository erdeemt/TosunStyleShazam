// 👁️ Algıla lobi güvenlik denetimi: her mesaj taranır (uyaran play'den önce / izleyiciye, gerçek değer ve
// başkalarının cevabı açıklamadan önce), zamanlı uyaran gösterimden sonra tekrar gönderilmez, üretim modunda
// test kancaları (TIME_SCALE, _test oyunu) kapalı, ritim cevabının CPU maliyeti, sunucu iç alanları sızmaz.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
const MONDAY = '2026-11-02'; // Pazartesi: Cuma varsayılanı (gerçek Cuma günü) testleri etkilemesin
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { secret } from '../lib/media.js';
import { TESTS, TEMPO, evaluate, makeStimulus, trackLanding } from '../../public/perceptle-math.js';
import { cryptoRng } from '../../server/rng.js';

const TS = 0.15;
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: TS, env: { FAKE_TODAY: MONDAY } }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const untilServer = async (t) => { const w = t - Date.now(); if (w > 0) await sleep(w); };
const views = (b, gk) => b.messages.filter((m) => m.t === 'view' && m.view?.gameKey === gk);

test('mesaj taraması: uyaran, gerçek değer ve başkalarının cevabı zamanından önce kimseye gitmez', async () => {
  for (const rules of ['normal', 'friday']) {
    const r = await makeRoom(srv.wsUrl, 'perceptle', 4, `L${rules[0]}`);
    all.push(...r.bots);
    if (rules === 'friday') {
      r.host.send({ t: 'settings', settings: { rules } });
      await Promise.all(r.bots.map((b) => b.waitRoom((x) => x.settings.rules === rules)));
    }
    r.host.send({ t: 'start' });
    const gk = (await r.host.waitView((v) => v.phase === 'intro')).gameKey;
    const spec = new Bot(srv.wsUrl, `Spec${rules[0]}`);
    all.push(spec);
    await spec.connect();
    await spec.join(r.code);
    const plays = [];
    const raws = [];
    const myAnswers = r.bots.map(() => []);
    for (let i = 0; i < TESTS.length; i++) {
      await r.host.waitView((v) => v.gameKey === gk && v.index === i && (v.phase === 'intro' || v.phase === 'play'));
      r.host.action({ type: 'go', index: i });
      const pm = await r.host.waitFor((m) => m.t === 'view' && m.view?.gameKey === gk && m.view.phase === 'play' && m.view.index === i, { fromStart: true });
      const pv = pm.view;
      plays.push(pv);
      raws.push((await secret(srv, { room: r.code })).stimuli[i]); // ham uyaran (istemciye gitmez)
      // Uyaran SYNC_MS (700 ms × ölçek) erken gelir — gösterimden önce elde: tasarım gereği, burada sadece ölçülür.
      assert.ok(pv.startAt - pm.receivedAt <= 700 * TS + 50);
      await untilServer(pv.recallAt + 60);
      // Zamanlı uyaran gösterimden sonra yeniden bağlanana gitmez
      const re = r.bots[3];
      await re.reconnect();
      const fresh = await re.waitFreshView((v) => v.gameKey === gk);
      if (['count', 'track', 'tempo'].includes(TESTS[i])) assert.equal(fresh.stimulus, null, `${TESTS[i]} gösterimden sonra tekrar geldi`);
      else assert.ok(fresh.stimulus);
      for (const [k, b] of r.bots.entries()) {
        const t = TESTS[i];
        const ans = t === 'tempo' ? [100 + k, 200 + k] : t === 'count' ? 700 + k : t === 'track' ? 811.7 + k : t === 'angle' ? 271.3 + k : 0.6173 + k / 1000;
        myAnswers[k].push(ans);
        b.action({ type: 'answer', index: i, answer: ans });
        await sleep(20);
      }
      const rv = await r.host.waitView((v) => v.gameKey === gk && v.index === i && (v.phase === 'reveal' || v.phase === 'over'));
      if (rv.phase === 'reveal') r.host.action({ type: 'next', index: i });
    }
    const over = await r.host.waitView((v) => v.gameKey === gk && v.over, { timeout: 5000 });
    await sleep(50);

    const everyone = [...r.bots, spec];
    for (const b of everyone) {
      const raw = JSON.stringify(b.messages);
      for (const bad of ['"stimuli"', '"answers"', '"closeAt"', '"dots"', '"vx"', '"vy"', '"g":', '"token":"' + (b === r.host ? r.bots[1].token : r.host.token)]) {
        assert.ok(!raw.includes(bad), `${b.name}: ${bad} sızdı`);
      }
      for (const m of views(b, gk)) {
        const v = m.view;
        const isSpec = b === spec;
        if (isSpec || v.phase !== 'play') assert.equal(v.stimulus, null, `${b.name} ${v.phase}: uyaran`);
        if (v.phase === 'intro' || v.phase === 'play') {
          assert.ok(v.history.every((h) => h.index < v.index), 'süren testin sonucu sızdı');
          assert.equal(v.last, null);
          for (const p of v.players) assert.deepEqual(Object.keys(p).sort(), ['answered', 'grade', 'id', 'name', 'scores', 'total']);
          assert.ok(v.players.every((p) => p.scores.length === v.index), 'süren testin puanı sızdı');
        }
        if (v.phase === 'play' && v.stimulus && ['count', 'track', 'tempo'].includes(v.test)) {
          assert.ok(m.receivedAt <= plays[v.index].recallAt + 40, `${b.name}: zamanlı uyaran gösterimden sonra tekrar gönderildi`);
        }
        // me.answer sadece kendi cevabı
        if (v.phase === 'play' && v.me.answer != null) {
          const k = r.bots.indexOf(b);
          const mine = myAnswers[k][v.index];
          assert.ok(Array.isArray(mine) ? v.me.answer === mine.length : Math.abs(v.me.answer - mine) < 1e-6, `${b.name}: me.answer başkasının`);
        }
      }
      // Başkalarının (belirgin) cevabı, o testin açıklamasından önceki hiçbir mesajda yok
      for (let i = 0; i < TESTS.length; i++) {
        if (!['track', 'angle'].includes(TESTS[i])) continue;
        const firstReveal = b.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === gk && m.view.index === i && (m.view.phase === 'reveal' || m.view.phase === 'over'));
        // Uyaran (yörünge örnekleri 1 ondalıklı x içerir) cevap değil: rastlantısal eşleşme olmasın diye taramadan çıkar
        const before = JSON.stringify(b.messages.slice(0, firstReveal).map((m) => (m.t === 'view' ? { ...m.view, me: null, stimulus: null, history: m.view.history.map((h) => ({ ...h, stimulus: null })), last: m.view.last && { ...m.view.last, stimulus: null } } : m)));
        for (const [k, other] of r.bots.entries()) if (other !== b) assert.ok(!before.includes(String(myAnswers[k][i])), `${b.name}: ${other.name} cevabı erken`);
        const truth = over.history[i].truth;
        assert.ok(!before.includes(`"truth":${truth}`), 'gerçek değer erken');
      }
      // İzleyici: açıklamadan önce zamanlı uyaranı (nokta/yörünge) hiçbir biçimde almaz
      if (b === spec) {
        for (const [i, pv] of plays.entries()) {
          if (!pv.stimulus || !['count', 'track'].includes(TESTS[i])) continue;
          const firstReveal = b.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === gk && m.view.index === i && m.view.phase !== 'play' && m.view.phase !== 'intro');
          const before = JSON.stringify(b.messages.slice(0, firstReveal));
          const probe = TESTS[i] === 'count' ? JSON.stringify(raws[i].dots[0]) : `"vx":${raws[i].vx}`;
          assert.ok(!before.includes(probe), `izleyiciye ${TESTS[i]} uyaranı sızdı`);
        }
      }
    }
    // Ritim cevabı görünümde sadece dokunuş sayısı (ham zamanlar saklanmaz/yayınlanmaz)
    const tempoIdx = TESTS.indexOf('tempo');
    for (const b of everyone) assert.ok(!JSON.stringify(b.messages).includes('[100,200]'));
    assert.equal(over.history[tempoIdx].results[r.host.playerId].answer, 2);
  }
});

test('çapraz oda: başka odanın oyuncusu/oda kodu ile eylem enjeksiyonu etkisiz', async () => {
  const A = await makeRoom(srv.wsUrl, 'perceptle', 2, 'XA');
  const B = await makeRoom(srv.wsUrl, 'perceptle', 2, 'XB');
  all.push(...A.bots, ...B.bots);
  for (const r of [A, B]) {
    r.host.send({ t: 'settings', settings: { tests: 'split' } });
    await r.host.waitRoom((x) => x.settings.tests === 'split');
    r.host.send({ t: 'start' });
    await Promise.all(r.bots.map((b) => b.waitView((v) => v.phase === 'intro')));
  }
  // A oyuncusu B'nin hostunun kimliğiyle eylem yollamaya çalışır (playerId alanı yok sayılmalı)
  const eA = A.bots[1].waitFor((m) => m.t === 'error');
  A.bots[1].send({ t: 'action', playerId: B.host.playerId, code: B.code, action: { type: 'go', index: 0, playerId: B.host.playerId } });
  assert.match((await eA).message, /oda sahibi/);
  await sleep(50);
  assert.equal(B.host.view.phase, 'intro');
  assert.equal(A.host.view.phase, 'intro');
  // Odasız kimlik eylem gönderemez
  const lone = new Bot(srv.wsUrl, 'Yalnız');
  all.push(lone);
  await lone.connect();
  const el = lone.waitFor((m) => m.t === 'error');
  lone.send({ t: 'action', code: A.code, action: { type: 'answer', index: 0, answer: 0.5 } });
  assert.match((await el).message, /odada değilsin/);
  // Bir başkasının token'ı olmadan onun kimliğine bürünülemez
  const imp = new Bot(srv.wsUrl, 'Taklit');
  all.push(imp);
  imp.playerId = A.host.playerId;
  imp.token = 'f'.repeat(32);
  await imp.connect();
  assert.notEqual(imp.playerId, A.host.playerId);
});

test('üretim modu: TEST_MODE yoksa TIME_SCALE ve _test oyunu yok sayılır, görünüm timeScale=1', async () => {
  const prod = await startServer({ timeScale: 0.01, env: { TEST_MODE: '0', TEST_GAMES: '0' } });
  try {
    const { bots, host } = await makeRoom(prod.wsUrl, 'perceptle', 1, 'Prod');
    all.push(...bots);
    host.send({ t: 'start' });
    const m = await host.waitFor((x) => x.t === 'view' && x.view?.phase === 'intro');
    assert.equal(m.view.timeScale, 1);
    assert.ok(m.view.endsAt - m.serverNow > 3500, `intro 4 sn olmalı (${m.view.endsAt - m.serverNow})`);
    const t = new Bot(prod.wsUrl, 'T');
    all.push(t);
    await t.connect();
    await assert.rejects(t.create('_test'), /Böyle bir oyun yok/);
  } finally {
    await prod.stop();
  }
});

test('CPU: en kötü ritim cevabı (40 dokunuş) ve uyaran üretimi ucuz', async () => {
  const { cleanAnswer } = await import('../../server/perceptle.js');
  const stim = { bpm: 80 };
  const nasty = Array.from({ length: TEMPO.maxTaps }, (_, i) => (i % 2 ? 120_000 : -5000 + i * 3.3));
  let t0 = performance.now();
  for (let i = 0; i < 20_000; i++) evaluate('tempo', stim, cleanAnswer('tempo', nasty, true), true);
  const perAnswer = (performance.now() - t0) / 20_000;
  assert.ok(perAnswer < 0.2, `ritim cevabı başına ${perAnswer.toFixed(4)} ms`);
  // Oyun başlatma maliyeti (5 uyaran; nokta yerleştirme döngüsü 50k denemeye kadar)
  const rng = cryptoRng();
  t0 = performance.now();
  for (let i = 0; i < 50; i++) for (const t of TESTS) makeStimulus(t, rng, i % 2 === 1);
  const perStart = (performance.now() - t0) / 50;
  assert.ok(perStart < 30, `oyun başlatma ${perStart.toFixed(2)} ms`);
  console.log(`ritim cevabı ${perAnswer.toFixed(4)} ms, oyun kurulumu ${perStart.toFixed(2)} ms`);
  void trackLanding;
});
