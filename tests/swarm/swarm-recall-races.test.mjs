// Nüans / Ton Avı lobi: yarış ve protokol suistimali sürü testleri. Her botun her mesajını RecallReferee denetler:
// ezberde hedef var, hatırlamada hedef/başkasının cevabı yok, açıklamadaki puanlar public/recall-math.js ile aynı,
// toplamlar geçmişle tutarlı, history sıralı ve tekrarsız, "internal" hata yok.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, makeBots, Bot, sleep } from '../lib/bot.js';
import { scoreColor, scoreTone, hexToRgb, normalizeHex, round2 } from '../../public/recall-math.js';

const SCALE = 0.02; // ezber 100/60 ms, hatırlama 15 sn → 300 ms (+40 ms pay), açıklama 400 ms, host devri 300 ms, koltuk 2.4 sn
const GRACE = Math.round(2000 * SCALE);
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: SCALE, seed: 913 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const SCORE = {
  nuance: (t, g) => scoreColor(hexToRgb(t), hexToRgb(g)),
  tone: (t, g) => scoreTone(t, g),
};
const TOTAL = {
  nuance: (s) => (s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0),
  tone: (s) => round2(s.reduce((a, b) => a + b, 0)),
};
const hex2 = (n) => (n & 255).toString(16).padStart(2, '0');
const GUESS = {
  nuance: (i, round) => `#${hex2(17 + i * 19)}${hex2(round * 23 + 5)}${hex2(230 - i * 7)}`,
  tone: (i, round) => Math.round((100 + i * 37.3 + round * 3.1) * 10) / 10,
};
const contains = (text, v) => (typeof v === 'number'
  ? new RegExp(`[:,\\[]${String(v).replace('.', '[.]')}[,\\]}]`).test(text) // JSON sayı bağlamı (UUID içindeki "215" sayılmaz)
  : text.toLowerCase().includes(String(v).toLowerCase()));

class RecallReferee {
  constructor(gameId, label) {
    this.gameId = gameId;
    this.label = label;
    this.targets = new Map(); // gameKey:round -> hedef
    this.sent = new Map(); // gameKey:round -> Map(playerId -> gönderilen cevap)
    this.problems = [];
  }

  attach(bots) { for (const b of bots) b.taps.push((m, bot) => this.check(m, bot)); return this; }

  submit(bot, round, guess, view = bot.view) {
    const k = `${view.gameKey}:${round}`;
    if (!this.sent.has(k)) this.sent.set(k, new Map());
    this.sent.get(k).set(bot.playerId, guess);
    bot.action({ type: 'submit', round, guess });
  }

  bad(bot, msg) { if (this.problems.length < 50) this.problems.push(`${this.label} ${bot.name}: ${msg}`); }

  check(m, bot) {
    if (m.t === 'error' && m.code === 'internal') this.bad(bot, `internal hata ${m.message}`);
    if (m.t !== 'view' || !m.view) return;
    const v = m.view;
    if (v.game !== this.gameId) return this.bad(bot, `yanlış oyun ${v.game}`);
    const k = `${v.gameKey}:${v.round}`;
    // history: 1..n sıralı, tekrarsız
    v.history.forEach((h, i) => { if (h.round !== i + 1) this.bad(bot, `history sırası bozuk ${v.history.map((x) => x.round)}`); });
    if (v.phase === 'memorize') {
      if (v.target == null) this.bad(bot, 'ezberde hedef yok');
      if (v.history.length !== v.round - 1) this.bad(bot, `ezberde history ${v.history.length} != ${v.round - 1}`);
      const t = this.targets.get(k);
      if (t !== undefined && t !== v.target) this.bad(bot, `hedef değişti ${t} → ${v.target}`);
      this.targets.set(k, v.target);
    }
    if (v.phase === 'recall') {
      if (v.target !== null) this.bad(bot, `hatırlamada hedef görünür: ${v.target}`);
      if (v.lastRound !== null) this.bad(bot, 'hatırlamada lastRound dolu');
      if (v.history.length !== v.round - 1) this.bad(bot, `hatırlamada history ${v.history.length} != ${v.round - 1}`);
      const sent = this.sent.get(k);
      const text = JSON.stringify({ ...v, me: null });
      for (const [pid, g] of sent ?? []) {
        if (pid !== bot.playerId && contains(text, g)) this.bad(bot, `başkasının cevabı (${g}) hatırlamada görünür: ${text.slice(0, 600)}`);
      }
      const tgt = this.targets.get(k);
      if (tgt != null && contains(text, tgt)) this.bad(bot, `hedef (${tgt}) hatırlama görünümünde metin olarak var`);
      for (const p of v.players) {
        const keys = Object.keys(p).sort().join(',');
        if (keys !== 'id,name,submitted,total') this.bad(bot, `oyuncu alanları ${keys}`);
      }
      if (v.me.guess != null && sent?.has(bot.playerId) === false) this.bad(bot, 'me.guess göndermediği bir cevap');
    }
    if (v.phase === 'reveal' || v.phase === 'over') {
      if (v.phase === 'reveal' && v.history.length !== v.round) this.bad(bot, `açıklamada history ${v.history.length} != ${v.round}`);
      for (const h of v.history) {
        const t = this.targets.get(`${v.gameKey}:${h.round}`);
        if (t !== undefined && t !== h.target) this.bad(bot, `tur ${h.round} açıklanan hedef ${h.target} != ezber ${t}`);
        for (const [pid, a] of Object.entries(h.answers)) {
          if (a.guess === null) { if (a.score !== 0) this.bad(bot, `cevapsız ama puan ${a.score}`); continue; }
          const want = SCORE[this.gameId](h.target, a.guess);
          if (a.score !== want) this.bad(bot, `tur ${h.round} puan ${a.score} != ${want}`);
          const sent = this.sent.get(`${v.gameKey}:${h.round}`)?.get(pid);
          if (sent !== undefined && typeof sent === typeof a.guess && sent !== a.guess
            && !(this.gameId === 'nuance' && normalizeHex(sent) === a.guess)) this.bad(bot, `tur ${h.round} cevap ${a.guess} != gönderilen ${sent}`);
        }
      }
      if (v.lastRound && v.lastRound !== null && v.history.at(-1)?.round !== v.lastRound.round) this.bad(bot, 'lastRound history sonu değil');
    }
    // toplamlar geçmişten hesaplananla aynı
    for (const p of v.players) {
      const scores = v.history.filter((h) => h.answers[p.id]).map((h) => h.answers[p.id].score);
      const want = TOTAL[this.gameId](scores);
      if (p.total !== want) this.bad(bot, `${p.name} toplam ${p.total} != ${want}`);
    }
  }
}

const noInternal = (bots) => assert.deepEqual(bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal')), []);

async function setup(gameId, n, { settings = {}, prefix = 'R', start = true } = {}) {
  const r = await makeRoom(srv.wsUrl, gameId, n, prefix);
  all.push(...r.bots);
  const ref = new RecallReferee(gameId, `${gameId}/${prefix}/${r.code}`).attach(r.bots);
  const s = { rounds: 3, recallSeconds: 15, ...settings };
  r.host.send({ t: 'settings', settings: s });
  await r.host.waitRoom((x) => x.settings.rounds === s.rounds && x.settings.recallSeconds === s.recallSeconds);
  if (start) await startGame(r.host, r.bots);
  return { ...r, ref };
}

async function startGame(host, bots) {
  const before = host.view?.gameKey;
  host.send({ t: 'start' });
  await Promise.all(bots.map((b) => b.waitView((v) => v.round === 1 && v.gameKey !== before && !v.over, { timeout: 4000 })));
  return host.view.gameKey;
}

const phase = (b, round, ph, timeout = 4000) => b.waitView((v) => v.round === round && (Array.isArray(ph) ? ph.includes(v.phase) : v.phase === ph), { timeout });
const passed = (ref) => assert.deepEqual(ref.problems, []);

for (const gameId of ['nuance', 'tone']) {
  test(`[${gameId}] 12 kişi, aynı tick'te hepsi cevap: tur tam bir kez kapanır, puanlar recall-math ile aynı, 13. kişi giremez`, async () => {
    const { bots, host, ref, code } = await setup(gameId, 12, { prefix: 'On2', settings: { rounds: 4, recallSeconds: 60 } });
    const extra = new Bot(srv.wsUrl, 'Fazla');
    all.push(await extra.connect());
    await assert.rejects(extra.join(code), /dolu/);
    for (let round = 1; round <= 4; round++) {
      await Promise.all(bots.map((b) => phase(b, round, 'recall')));
      bots.forEach((b, i) => ref.submit(b, round, GUESS[gameId](i, round)));
      const rv = await phase(host, round, ['reveal', 'over']);
      assert.equal(Object.keys(rv.lastRound.answers).length, 12);
      assert.ok(Object.values(rv.lastRound.answers).every((a) => a.guess !== null), 'tüm cevaplar sayılmalı');
      if (round < 4) host.action({ type: 'next', round });
    }
    const over = await host.waitView((v) => v.over);
    assert.equal(over.history.length, 4);
    await sleep(80);
    passed(ref);
    noInternal(bots);
  });

  test(`[${gameId}] süre sınırında gönderim: ya o turda sayılır ya sessizce düşer, asla sonraki tura sızmaz`, async () => {
    const offsets = [-40, -15, -5, 0, 10, GRACE - 5, GRACE + 5, GRACE + 30, 150];
    const { bots, host, ref } = await setup(gameId, offsets.length, { prefix: 'Sinir', settings: { rounds: 3 } });
    const tally = { counted: 0, dropped: 0 };
    for (let round = 1; round <= 3; round++) {
      const v = await phase(host, round, 'recall');
      const msg = host.messages.findLast((m) => m.t === 'view' && m.view.round === round && m.view.phase === 'recall');
      const skew = msg.serverNow - msg.receivedAt;
      const errIdx = bots.map((b) => b.errors.length);
      await Promise.all(bots.map(async (b, i) => {
        await sleep(Math.max(0, v.endsAt - skew + offsets[i] - Date.now()));
        ref.submit(b, round, GUESS[gameId](i, round), v);
      }));
      const rv = await phase(host, round, ['reveal', 'over']);
      await sleep(60); // en geç gönderim de işlensin
      for (const [i, b] of bots.entries()) {
        const a = rv.lastRound.answers[b.playerId];
        const after = await host.waitView((x) => x.round === round && x.history.length >= round);
        const final = after.history[round - 1].answers[b.playerId];
        assert.deepEqual(final, a, 'açıklama sonrası cevap değişmemeli');
        if (a.guess === null) tally.dropped++; else tally.counted++;
        assert.equal(b.errors.length, errIdx[i], `${b.name} sınırda hata aldı: ${JSON.stringify(b.errors.at(-1))}`);
      }
      if (round < 3) {
        host.action({ type: 'next', round });
        const nv = await Promise.all(bots.map((b) => phase(b, round + 1, 'recall')));
        nv.forEach((x) => assert.equal(x.me.submitted, false, 'eski tur cevabı yeni tura geçmemeli'));
      }
    }
    assert.ok(tally.counted > 0 && tally.dropped > 0, `iki taraf da görülmeli: ${JSON.stringify(tally)}`);
    passed(ref);
    noInternal(bots);
  });

  test(`[${gameId}] yanlış/gelecek tur ve bozuk tur değerleri sessizce yok sayılır; "next" bombardımanı tam bir tur atlatır`, async () => {
    const { bots, host, ref } = await setup(gameId, 3, { prefix: 'Tur', settings: { rounds: 3, recallSeconds: 60 } });
    const [a, b] = bots;
    const g = GUESS[gameId](0, 1);
    // ezberde gelecek tur: sessiz
    if (a.view.phase === 'memorize') {
      const e0 = a.errors.length;
      a.action({ type: 'submit', round: 2, guess: g });
      await sleep(30);
      assert.equal(a.errors.length, e0);
    }
    await phase(a, 1, 'recall');
    const e1 = a.errors.length;
    for (const round of [2, 0, -1, 1.5, null, 'abc', true, [1], { valueOf: 1 }, 1e300, '']) a.action({ type: 'submit', round, guess: g });
    a.action({ type: 'next', round: 1 });
    await sleep(80);
    assert.equal(a.errors.length, e1, `beklenmeyen hata: ${JSON.stringify(a.errors.slice(e1))}`);
    assert.equal(a.view.me.submitted, false);
    // round '1' (metin) kabul edilir
    await a.act({ type: 'submit', round: '1', guess: g });
    ref.sent.set(`${a.view.gameKey}:1`, new Map([[a.playerId, g]]));
    assert.equal(a.view.me.submitted, true);
    ref.submit(b, 1, GUESS[gameId](1, 1));
    ref.submit(bots[2], 1, GUESS[gameId](2, 1));
    await phase(host, 1, 'reveal');
    // açıklamada 2. tur için gönderim: sessiz, 2. turda sayılmaz
    b.action({ type: 'submit', round: 2, guess: GUESS[gameId](1, 2) });
    for (let i = 0; i < 12; i++) host.action({ type: 'next', round: 1 });
    for (let i = 0; i < 6; i++) host.action({ type: 'next', round: 2 });
    await phase(host, 2, ['memorize', 'recall']);
    await sleep(80);
    assert.equal(host.view.round, 2, 'next bombardımanı birden fazla tur atlattı');
    const r2 = await phase(b, 2, 'recall');
    assert.equal(r2.me.submitted, false, 'açıklamada gönderilen gelecek tur cevabı sayıldı');
    passed(ref);
    noInternal(bots);
  });

  test(`[${gameId}] bozuk cevaplar: NaN/Infinity/nesne/dizi/dev metin reddedilir, sınır değerler temizlenir`, async () => {
    const { bots, host, ref } = await setup(gameId, 6, { prefix: 'Bozuk', settings: { rounds: 3, recallSeconds: 60 } });
    await Promise.all(bots.map((b) => phase(b, 1, 'recall')));
    const huge = gameId === 'nuance' ? `#${'a'.repeat(7000)}` : '9'.repeat(7000);
    const invalid = gameId === 'nuance'
      ? [null, 'Infinity', '#GGGGGG', '#fff', 'red', huge, {}, [], ['#ffffff'], true, -1, '#12345', '#1234567', '##123456', ' ']
      : [null, 'Infinity', '-Infinity', 'abc', '440Hz', huge, {}, [], [440], true, '', ' ', '1e999'];
    const a = bots[0];
    for (const guess of invalid) {
      const err = await a.expectError({ type: 'submit', round: 1, guess });
      assert.match(err.message, /Geçersiz/, `${JSON.stringify(guess).slice(0, 40)} → ${err.message}`);
    }
    assert.equal(a.view.me.submitted, false);
    const valid = gameId === 'nuance'
      ? [[' #ABCDEF ', '#abcdef'], ['00ff00', '#00ff00'], [123456, '#123456'], ['#000000', '#000000'], ['#FFFFFF', '#ffffff']]
      : [[-50, 80], [0, 80], ['1e3', 1000], ['0x1F4', 500], [1e308, 1200]];
    for (const [i, [guess, want]] of valid.entries()) {
      const b = bots[i + 1];
      b.action({ type: 'submit', round: 1, guess });
      await b.waitView((v) => v.me.submitted, { timeout: 1000 });
      assert.equal(b.view.me.guess, want, `${JSON.stringify(guess)} → ${b.view.me.guess}`);
    }
    // a hâlâ gönderebilir (önceki reddedilenler hak yemedi)
    ref.submit(a, 1, GUESS[gameId](0, 1));
    const rv = await phase(host, 1, 'reveal');
    for (const [i, [, want]] of valid.entries()) assert.equal(rv.lastRound.answers[bots[i + 1].playerId].guess, want);
    passed(ref);
    noInternal(bots);
  });
}

test('[nuance] host hatırlama ortasında ayrılır → devir; host açıklamada kopar → 15 sn (ölçekli) sonra devir; geri gelen eski host oyuncu kalır', async () => {
  const { bots, host, ref } = await setup('nuance', 4, { prefix: 'Host', settings: { rounds: 4, recallSeconds: 60 } });
  const [h, b1, b2, b3] = bots;
  await phase(b1, 1, 'recall');
  for (const [i, b] of [b1, b2, b3].entries()) ref.submit(b, 1, GUESS.nuance(i + 1, 1));
  await b1.waitView((v) => v.players.filter((p) => p.submitted).length === 3);
  h.leave();
  const rv = await phase(b1, 1, 'reveal', 2000); // kalanların hepsi cevapladı → tur hemen biter
  assert.equal(rv.players.length, 3);
  assert.equal(b1.room.hostId, b1.playerId, 'en eski bağlı oyuncu host olmalı');
  b1.action({ type: 'next', round: 1 });
  await phase(b2, 2, ['memorize', 'recall']);
  // 2. tur açıklamasında yeni host kopar
  await phase(b1, 2, 'recall');
  for (const [i, b] of [b1, b2, b3].entries()) ref.submit(b, 2, GUESS.nuance(i + 1, 2));
  await phase(b2, 2, 'reveal');
  b1.drop();
  await b2.waitRoom((r) => r.hostId === b2.playerId, { timeout: 2000 });
  // eski host (b1) geri gelir: host değil, izleyici değil, cevap verebilir
  await b1.connect();
  const room = await b1.waitFreshRoom();
  assert.notEqual(room.hostId, b1.playerId);
  assert.equal(room.players.find((p) => p.id === b1.playerId).spectator, false);
  const v3 = await phase(b1, 3, 'recall', 4000);
  ref.submit(b1, 3, GUESS.nuance(1, 3), v3);
  await b1.waitView((v) => v.round === 3 && v.me.submitted);
  await phase(b1, 3, 'reveal', 4000); // diğerleri cevapsız: süre dolunca
  const nh = await b1.expectError({ type: 'next', round: 3 });
  assert.match(nh.message, /oda sahibi/);
  assert.equal(b1.view.lastRound.answers[b1.playerId].guess, normalizeHex(GUESS.nuance(1, 3)));
  passed(ref);
  noInternal(bots);
});

test('[tone] oyun ortası katılan izleyici: hedef/cevap görmez, eylemi reddedilir; oyuncular ayrılınca oyun biter, izleyici host olup yeni oyun başlatır', async () => {
  const { bots, host, ref, code } = await setup('tone', 3, { prefix: 'Izle', settings: { rounds: 5, recallSeconds: 60 } });
  const spec = new Bot(srv.wsUrl, 'İzleyici');
  all.push(await spec.connect());
  ref.attach([spec]);
  await spec.join(code);
  assert.equal(spec.room.players.find((p) => p.id === spec.playerId).spectator, true);
  const sv = await spec.waitView((v) => v.phase === 'recall');
  assert.ok(!sv.players.some((p) => p.id === spec.playerId), 'izleyici oyuncu listesinde');
  const err = await spec.expectError({ type: 'submit', round: sv.round, guess: 440 });
  assert.match(err.message, /İzleyici/);
  const err2 = await spec.expectError({ type: 'next', round: sv.round });
  assert.match(err2.message, /İzleyici/);
  ref.submit(bots[1], sv.round, GUESS.tone(1, sv.round), sv);
  await sleep(30);
  // tüm oyuncular hatırlama sırasında ayrılır
  for (const b of bots) b.leave();
  const over = await spec.waitView((v) => v.over, { timeout: 2000 });
  assert.equal(over.phase, 'over');
  assert.equal(over.players.length, 0);
  const room = await spec.waitRoom((r) => r.phase === 'over' && r.hostId === spec.playerId);
  assert.equal(room.players.length, 1);
  // bekleme odasına dönüp tek başına oynar
  spec.send({ t: 'backToLobby' });
  await spec.waitRoom((r) => r.phase === 'lobby');
  await startGame(spec, [spec]);
  assert.equal(spec.view.players.length, 1);
  spec.leave();
  await sleep(50);
  const late = new Bot(srv.wsUrl, 'Geç');
  all.push(await late.connect());
  await assert.rejects(late.join(code), /bulunamadı/);
  passed(ref);
});

test('[nuance] her fazda yeniden bağlanma: ezber/hatırlama/açıklama/bitiş görünümü tutarlı, hatırlamada hedef geri gelmez', async () => {
  const { bots, host, ref } = await setup('nuance', 4, { prefix: 'Bag', settings: { rounds: 3, recallSeconds: 60, difficulty: 'normal' } });
  const [, b1, b2, b3] = bots;
  // round 1 ezber (100 ms) — hemen yeniden bağlan
  if (b1.view.phase === 'memorize') {
    await b1.reconnect();
    const v = await b1.waitFreshView();
    assert.equal(v.round, 1);
    if (v.phase === 'memorize') assert.ok(v.target);
    else assert.equal(v.target, null);
  }
  await phase(b2, 1, 'recall');
  ref.submit(b2, 1, GUESS.nuance(2, 1));
  await b2.waitView((v) => v.me.submitted);
  await b2.reconnect();
  const v2 = await b2.waitFreshView();
  assert.equal(v2.phase, 'recall');
  assert.equal(v2.target, null);
  assert.equal(v2.me.submitted, true);
  assert.equal(v2.me.guess, normalizeHex(GUESS.nuance(2, 1)));
  for (const [i, b] of bots.entries()) if (b !== b2) ref.submit(b, 1, GUESS.nuance(i, 1));
  await phase(b3, 1, 'reveal');
  await b3.reconnect();
  const v3 = await b3.waitFreshView();
  assert.equal(v3.phase, 'reveal');
  assert.equal(v3.lastRound.round, 1);
  assert.equal(Object.keys(v3.lastRound.answers).length, 4);
  // host fırtına: 4'ü aynı anda yeniden bağlanır, oyun devam eder
  host.action({ type: 'next', round: 1 });
  await Promise.all(bots.map((b) => b.reconnect()));
  for (let round = 2; round <= 3; round++) {
    const vs = await Promise.all(bots.map((b) => phase(b, round, 'recall')));
    bots.forEach((b, i) => ref.submit(b, round, GUESS.nuance(i, round), vs[i]));
    await phase(host, round, ['reveal', 'over']);
    if (round < 3) host.action({ type: 'next', round });
  }
  await host.waitView((v) => v.over);
  await b1.reconnect();
  const vo = await b1.waitFreshView();
  assert.equal(vo.over, true);
  assert.equal(vo.history.length, 3);
  passed(ref);
  noInternal(bots);
});

test('[tone] oyun sırasında kick: bağlı oyuncu atılamaz; kopuk oyuncu atılınca tur hemen kapanır; atılan geri dönünce izleyici', async () => {
  const { bots, host, ref, code } = await setup('tone', 4, { prefix: 'Kick', settings: { rounds: 3, recallSeconds: 60 } });
  const [, b1, b2, b3] = bots;
  await phase(b1, 1, 'recall');
  host.send({ t: 'kick', playerId: b1.playerId });
  const ke = await host.waitFor((m) => m.t === 'error');
  assert.match(ke.message, /kopmuş/);
  for (const [i, b] of [host, b1, b2].entries()) ref.submit(b, 1, GUESS.tone(i, 1));
  await host.waitView((v) => v.players.filter((p) => p.submitted).length === 3);
  b3.drop();
  await host.waitRoom((r) => !r.players.find((p) => p.id === b3.playerId)?.connected);
  host.send({ t: 'kick', playerId: b3.playerId });
  const rv = await phase(host, 1, 'reveal', 1500);
  assert.equal(rv.players.length, 3);
  assert.ok(!(b3.playerId in rv.lastRound.answers));
  await b3.connect();
  assert.equal((await b3.waitFreshRoom(() => true, { timeout: 2000 }).catch(() => null)), null, 'atılan oyuncu odaya geri bağlanmamalı');
  await b3.join(code);
  assert.equal(b3.room.players.find((p) => p.id === b3.playerId).spectator, true);
  const err = await b3.expectError({ type: 'submit', round: 1, guess: 440 });
  assert.match(err.message, /İzleyici/);
  passed(ref);
  noInternal(bots);
});

test('[nuance] bitiş → bekleme odası → hemen yeniden başlat: eski zamanlayıcılar yeni oyunu kısaltmaz, gameKey değişir; oyun sırasında ayar/backToLobby/start reddedilir', async () => {
  const { bots, host, ref } = await setup('nuance', 3, { prefix: 'Yeni', settings: { rounds: 3, recallSeconds: 15 } });
  // oyun sırasında suistimal
  host.send({ t: 'settings', settings: { rounds: 10, recallSeconds: 60 } });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /bekleme odasında/);
  host.send({ t: 'backToLobby' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /bitmeden/);
  host.send({ t: 'start' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /zaten/);
  assert.equal(host.view.totalRounds, 3);
  const key1 = host.view.gameKey;
  for (let round = 1; round <= 3; round++) {
    const vs = await Promise.all(bots.map((b) => phase(b, round, 'recall')));
    bots.forEach((b, i) => ref.submit(b, round, GUESS.nuance(i, round), vs[i]));
    await phase(host, round, ['reveal', 'over']);
    if (round < 3) host.action({ type: 'next', round });
  }
  // son açıklama host "next" ile değil: açıklama zamanlayıcısı bekleniyor; tam bu sırada (bitti mi?) lobiye dön
  await host.waitView((v) => v.over, { timeout: 3000 });
  host.send({ t: 'backToLobby' });
  await host.waitRoom((r) => r.phase === 'lobby');
  host.send({ t: 'settings', settings: { rounds: 4, recallSeconds: 20 } });
  await host.waitRoom((r) => r.settings.rounds === 4);
  const t0 = Date.now();
  const key2 = await startGame(host, bots);
  assert.notEqual(key2, key1);
  assert.equal(host.view.totalRounds, 4);
  // 1. tur ezber ≥ ~100 ms, hatırlama ≥ ~400 ms sürmeli (eski 'reveal'/'recall' zamanlayıcıları ateşlemesin)
  const rec = await phase(host, 1, 'recall');
  const tRecall = Date.now();
  assert.ok(tRecall - t0 >= 70, `ezber çok kısa: ${tRecall - t0} ms`);
  await phase(host, 1, 'reveal', 3000);
  const dur = Date.now() - tRecall;
  assert.ok(dur >= 20 * 1000 * SCALE * 0.8, `hatırlama çok kısa: ${dur} ms`);
  assert.equal(rec.history.length, 0, 'yeni oyunda eski history');
  // Lobiye dönüş → başlat → hemen tekrar lobi deneme: oyun sürerken reddedilmeli
  passed(ref);
  noInternal(bots);
});

test('[nuance] host "next" ile bitirip anında backToLobby+start: aynı ms içinde çok kez; her seferinde temiz yeni oyun', async () => {
  const { bots, host, ref } = await setup('nuance', 2, { prefix: 'Hizli', settings: { rounds: 3 } });
  const keys = new Set([host.view.gameKey]);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let round = 1; round <= 3; round++) {
      const vs = await Promise.all(bots.map((b) => phase(b, round, 'recall')));
      bots.forEach((b, i) => ref.submit(b, round, GUESS.nuance(i + cycle * 2, round), vs[i]));
      await phase(host, round, 'reveal');
      host.action({ type: 'next', round });
    }
    await host.waitView((v) => v.over);
    host.send({ t: 'backToLobby' });
    host.send({ t: 'start' });
    await Promise.all(bots.map((b) => b.waitView((v) => !keys.has(v.gameKey) && v.round === 1)));
    keys.add(host.view.gameKey);
    assert.equal(host.view.history.length, 0);
  }
  assert.equal(keys.size, 4);
  passed(ref);
  noInternal(bots);
});

test('[tone] tek kişilik oda: koparak/geri gelerek oynar; uzun süre yoksa oyun kendi kendine biter; ayrılınca oda silinir', async () => {
  const { bots, host, ref, code } = await setup('tone', 1, { prefix: 'Solo', settings: { rounds: 3, recallSeconds: 15 } });
  host.drop();
  await sleep(40);
  await host.connect();
  const v1 = await host.waitFreshView();
  assert.equal(v1.round, 1);
  const r1 = await phase(host, 1, 'recall');
  ref.submit(host, 1, GUESS.tone(0, 1), r1);
  await phase(host, 1, 'reveal', 1000); // tek kişi cevapladı → hemen açıklama
  // kalan turlar o yokken akar (açıklama + hatırlama zamanlayıcıları); koltuk 2.4 sn olduğundan arada kısa uğrar
  let vo;
  for (let i = 0; i < 6; i++) {
    host.drop();
    await sleep(700);
    await host.connect();
    vo = await host.waitFreshView(() => true, { timeout: 1000 });
    assert.equal(vo.target === null, vo.phase === 'recall', `faz ${vo.phase} hedef ${vo.target}`);
    if (vo.over) break;
  }
  assert.equal(vo.over, true, `oyun bitmeliydi: ${vo.phase} tur ${vo.round}`);
  assert.equal(vo.history.length, 3);
  assert.equal(vo.history[1].answers[host.playerId].guess, null);
  assert.equal(vo.players[0].total, vo.history[0].answers[host.playerId].score);
  host.leave();
  await sleep(40);
  const late = new Bot(srv.wsUrl, 'Geç2');
  all.push(await late.connect());
  await assert.rejects(late.join(code), /bulunamadı/);
  passed(ref);
  noInternal(bots);
});

test('[tone] tek kişilik oda: tek oyuncu koltuk süresinden (120 sn ölçekli) uzun kopuk kalırsa oda temizlenir', async () => {
  const { host, code } = await setup('tone', 1, { prefix: 'Solo2', settings: { rounds: 10, recallSeconds: 60 } });
  host.drop();
  await sleep(120_000 * SCALE + 300);
  await host.connect();
  const room = await host.waitFreshRoom(() => true, { timeout: 1000 }).catch(() => 'yok');
  assert.ok(room === null || room === 'yok', `oda hâlâ duruyor: ${JSON.stringify(room)?.slice(0, 80)}`);
  const late = new Bot(srv.wsUrl, 'Geç3');
  all.push(await late.connect());
  await assert.rejects(late.join(code), /bulunamadı/);
});

test('paralel 8 oda (4 Nüans + 4 Ton Avı, 5\'er kişi): odalar arası sızıntı yok, hepsi biter', async () => {
  const games = ['nuance', 'tone', 'nuance', 'tone', 'nuance', 'tone', 'nuance', 'tone'];
  const rooms = await Promise.all(games.map((g, i) => setup(g, 5, { prefix: `P${i}`, settings: { rounds: 3 } })));
  await Promise.all(rooms.map(async ({ bots, host, ref }, ri) => {
    for (let round = 1; round <= 3; round++) {
      const vs = await Promise.all(bots.map((b) => phase(b, round, 'recall', 6000)));
      bots.forEach((b, i) => { if ((i + round + ri) % 5) ref.submit(b, round, GUESS[games[ri]](i, round), vs[i]); }); // her turda biri cevapsız
      await phase(host, round, ['reveal', 'over'], 6000);
      if (round < 3) host.action({ type: 'next', round });
    }
    await host.waitView((v) => v.over, { timeout: 6000 });
  }));
  const keys = new Set(rooms.map((r) => r.host.view.gameKey));
  assert.equal(keys.size, rooms.length, 'gameKey çakıştı');
  for (const { bots, ref } of rooms) {
    const ids = new Set(bots.map((b) => b.playerId));
    for (const b of bots) {
      for (const m of b.messages) {
        if (m.t === 'view' && m.view) for (const p of m.view.players) assert.ok(ids.has(p.id), 'başka odanın oyuncusu görünür');
        if (m.t === 'room' && m.room) for (const p of m.room.players) assert.ok(ids.has(p.id), 'başka odanın oyuncusu odada');
      }
      for (const other of rooms.flatMap((r) => r.bots)) if (!ids.has(other.playerId)) assert.ok(!b.transcript().includes(other.playerId));
    }
    passed(ref);
    noInternal(bots);
  }
});

test('[nuance] oyun ortası gelen izleyici, oyuncuların bağlantısı kısa süre kopunca host olup onları atarak oyunu bitirememeli', async () => {
  const { bots, ref, code } = await setup('nuance', 3, { prefix: 'Gasp', settings: { rounds: 5, recallSeconds: 60 } });
  const spec = new Bot(srv.wsUrl, 'Gaspçı');
  all.push(await spec.connect());
  await spec.join(code);
  await phase(bots[0], 1, 'recall');
  for (const b of bots) b.drop(); // ör. aynı Wi-Fi'daki 3 oyuncu birden koptu
  const room = await spec.waitRoom((r) => r.hostId === spec.playerId, { timeout: 1500 }).catch(() => null);
  if (room) {
    for (const b of bots) spec.send({ t: 'kick', playerId: b.playerId });
    await sleep(100);
  }
  await Promise.all(bots.map((b) => b.connect()));
  const views = await Promise.all(bots.map((b) => b.waitFreshView(() => true, { timeout: 1500 }).catch(() => null)));
  assert.ok(views.every((v) => v && !v.over),
    `izleyici host oldu (${Boolean(room)}) ve oyunu bitirdi: oyuncuların görünümü ${JSON.stringify(views.map((v) => v && v.phase))}`);
  passed(ref);
});

test('sunucu günlüğünde oyun/tick/view hatası yok', async () => {
  await sleep(50);
  assert.doesNotMatch(srv.log(), /hatası|TypeError|ReferenceError|Lobi hatası/);
});
