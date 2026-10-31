// Hafıza oyunları (Nüans, Ton Avı) için ortak sürü senaryoları: tam oyun, gizli bilgi, zaman aşımı,
// geçersiz/eski/çift eylem, yeniden bağlanma, puan toplamı. nuance.test.mjs ve tone.test.mjs çağırır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';
import { secret } from '../lib/media.js';
import { scoreColor, scoreTone, hexToRgb, round2 } from '../../public/recall-math.js';

const SCORE = {
  nuance: (t, g) => scoreColor(hexToRgb(t), hexToRgb(g)),
  tone: (t, g) => scoreTone(t, g),
};
const TOTAL = {
  nuance: (s) => Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  tone: (s) => round2(s.reduce((a, b) => a + b, 0)),
};

// Metinde değer var mı? Sayılar başka bir sayının parçası olarak (ör. 309.8 ⊂ 1309.8) eşleşmesin.
const contains = (text, v) => (typeof v === 'number'
  ? new RegExp(`(^|[^0-9.])${String(v).replace('.', '\\.')}($|[^0-9])`).test(text)
  : text.includes(JSON.stringify(v)));

// gameId: 'nuance' | 'tone'. guessFor(botIndex, round, target) → bu botun gönderdiği (benzersiz) cevap
export function recallSuite(gameId, { guessFor, outOfRange, clampedTo, invalid }) {
  let srv;
  const all = [];
  before(async () => { srv = await startServer({ timeScale: 0.05 }); }); // ezber 0.25/0.15 sn, hatırlama 1.5 sn
  after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

  async function setup(n, settings = {}) {
    const room = await makeRoom(srv.wsUrl, gameId, n, 'Oyuncu');
    all.push(...room.bots);
    room.host.send({ t: 'settings', settings: { rounds: 3, ...settings } });
    await room.host.waitRoom((r) => r.settings.rounds === (settings.rounds ?? 3));
    room.host.send({ t: 'start' });
    await Promise.all(room.bots.map((b) => b.waitView((v) => v.round === 1)));
    return room;
  }

  // Gizli bilgi kuralları: hatırlama sırasında hedef yok, kimse başkasının bu turdaki cevabını görmez.
  function assertNoLeaks(bots, guesses) {
    for (const [bi, b] of bots.entries()) {
      for (const m of b.messages) {
        if (m.t !== 'view' || !m.view) continue;
        const v = m.view;
        if (v.phase === 'recall') {
          assert.equal(v.target, null, `${b.name} hatırlama sırasında hedefi gördü`);
          assert.equal(v.lastRound, null);
          assert.ok(v.history.every((h) => h.round < v.round), 'süren turun sonucu görünümde');
          const text = JSON.stringify(v);
          for (const [oi] of bots.entries()) {
            if (oi === bi) continue;
            const g = guesses[`${oi}:${v.round}`];
            if (g != null) assert.ok(!contains(text, g), `${b.name}, ${bots[oi].name} adlı oyuncunun cevabını erken gördü (${g})`);
          }
        }
        if (v.phase === 'memorize') {
          // Gizli hedef (Nüans, Ton Avı Zor): ezberde hex/Hz yok, sadece opak medya adresi.
          const hidden = gameId === 'nuance' || v.difficulty === 'hard';
          if (hidden) {
            assert.equal(v.target, null, 'ezberde gizli hedef JSON içinde olmamalı');
            assert.match(v.media, /^\/api\/media\/[0-9a-f]{32}$/);
          } else assert.ok(v.target != null, 'ezberde hedef görünmeli');
        }
      }
      for (const other of bots) if (other !== b) assert.ok(!b.transcript().includes(other.token), 'token sızdı');
    }
  }

  // Bir turu oynat: herkes (skip hariç) ezberde hedefi görür, hatırlamada cevap gönderir; tur sonucu döner.
  async function playRound(room, round, guesses, { skip = new Set() } = {}) {
    // Ezber görünümü çoktan gelmiş olabilir: tüm mesaj geçmişinde ara.
    const memo = await room.host.waitFor((m) => m.t === 'view' && m.view?.round === round && m.view.phase === 'memorize', { fromStart: true, timeout: 8000 });
    // Gizli hedefte görünümde target yok: testlere özel uçtan al (kusursuz/benzersiz cevap için).
    const target = memo.view.target ?? (await secret(srv, { room: room.code })).targets[round - 1];
    await Promise.all(room.bots.map(async (b, i) => {
      await b.waitView((v) => v.round === round && v.phase !== 'memorize', { timeout: 8000 });
      if (skip.has(i) || b.view.phase !== 'recall') return;
      const guess = guessFor(i, round, target);
      guesses[`${i}:${round}`] = guess;
      b.action({ type: 'submit', round, guess });
    }));
    const reveal = await room.host.waitView((v) => v.round === round && (v.phase === 'reveal' || v.phase === 'over'), { timeout: 8000 });
    return { target, reveal };
  }

  for (const n of [1, 2, 5, 8]) { // 1: tek kişilik oda da başlatılabilir
    const rounds = n === 8 ? 5 : 3;
    test(`${n} kişi, ${rounds} tur: tam oyun, puanlar sunucuyla tutarlı, sızıntı yok`, async () => {
      const room = await setup(n, { rounds });
      const guesses = {};
      const expected = room.bots.map(() => []);
      for (let round = 1; round <= rounds; round++) {
        const { target, reveal } = await playRound(room, round, guesses);
        assert.equal(reveal.lastRound.target, target, 'açıklanan hedef ezberdeki hedefle aynı olmalı');
        for (const [i, b] of room.bots.entries()) {
          const a = reveal.lastRound.answers[b.playerId];
          const want = SCORE[gameId](target, guesses[`${i}:${round}`]);
          assert.equal(a.score, want, `tur ${round} ${b.name} puanı`);
          expected[i].push(want);
        }
        if (round < rounds) room.host.action({ type: 'next', round });
      }
      const over = await room.host.waitView((v) => v.over, { timeout: 8000 });
      assert.equal(over.phase, 'over');
      assert.equal(over.history.length, rounds);
      for (const [i, b] of room.bots.entries()) {
        const p = over.players.find((x) => x.id === b.playerId);
        assert.equal(p.total, TOTAL[gameId](expected[i]), `${b.name} toplamı`);
      }
      await room.host.waitRoom((r) => r.phase === 'over');
      assertNoLeaks(room.bots, guesses);
    });
  }

  test('cevap vermeyen 0 alır; tur süre dolunca biter; açıklama süre dolunca kendiliğinden geçer', async () => {
    const room = await setup(3, { rounds: 3 });
    const guesses = {};
    const { reveal } = await playRound(room, 1, guesses, { skip: new Set([2]) });
    const lazy = reveal.lastRound.answers[room.bots[2].playerId];
    assert.equal(lazy.score, 0);
    assert.equal(lazy.guess, null);
    // host "Sonraki" demese de açıklama (20 sn ölçekli) bitince 2. tur başlar
    await room.host.waitView((v) => v.round === 2 && v.phase === 'memorize', { timeout: 8000 });
  });

  test('geçersiz, eski, çift ve aralık dışı eylemler', async () => {
    const room = await setup(2, { rounds: 3 });
    const [a, b] = room.bots;
    // ezber sırasında cevap reddedilir
    if (a.view.phase === 'memorize') {
      const early = await a.expectError({ type: 'submit', round: 1, guess: guessFor(0, 1) });
      assert.match(early.message, /ezberle/);
    }
    await a.waitView((v) => v.phase === 'recall');
    // eski/gelecek tur: sessizce yok sayılır
    const errsBefore = a.errors.length;
    a.action({ type: 'submit', round: 0, guess: guessFor(0, 1) });
    a.action({ type: 'submit', round: 7, guess: guessFor(0, 1) });
    a.action({ type: 'submit', round: '1x', guess: guessFor(0, 1) });
    a.action({ type: 'submit', guess: guessFor(0, 1) });
    await sleep(60);
    assert.equal(a.errors.length, errsBefore, 'eski tur eylemi hata üretmemeli');
    assert.equal(a.view.me.submitted, false, 'eski tur eylemi kabul edilmemeli');
    // bozuk değer reddedilir
    const bad = await a.expectError({ type: 'submit', round: 1, guess: invalid });
    assert.match(bad.message, /Geçersiz/);
    const badObj = await a.expectError({ type: 'submit', round: 1, guess: { toString: 1 } });
    assert.match(badObj.message, /Geçersiz/);
    // aralık dışı değer sınıra çekilir (ton) / reddedilir (renk)
    if (clampedTo !== undefined) {
      await a.act({ type: 'submit', round: 1, guess: outOfRange });
      assert.equal(a.view.me.guess, clampedTo);
    } else {
      await a.act({ type: 'submit', round: 1, guess: guessFor(0, 1) });
    }
    assert.equal(a.view.me.submitted, true);
    // çift gönderim reddedilir
    const dup = await a.expectError({ type: 'submit', round: 1, guess: guessFor(0, 1) });
    assert.match(dup.message, /zaten/);
    // bilinmeyen eylem
    const unk = await b.expectError({ type: 'hack', round: 1 });
    assert.match(unk.message, /Bilinmeyen/);
    // host olmayan "Sonraki" diyemez
    b.action({ type: 'submit', round: 1, guess: guessFor(1, 1) });
    await b.waitView((v) => v.phase === 'reveal');
    const notHost = await b.expectError({ type: 'next', round: 1 });
    assert.match(notHost.message, /oda sahibi/);
    // eski turun "Sonraki"si ikinci kez tur atlatmaz
    room.host.action({ type: 'next', round: 1 });
    await room.host.waitView((v) => v.round === 2);
    room.host.action({ type: 'next', round: 1 });
    await sleep(60);
    assert.equal(room.host.view.round, 2);
  });

  test('yeniden bağlanma: tur, faz ve gönderilmiş cevap korunur', async () => {
    const room = await setup(3, { rounds: 3, recallSeconds: 60 }); // hatırlama 3 sn (ölçekli)
    const [, b] = room.bots;
    await b.waitView((v) => v.phase === 'recall');
    await b.act({ type: 'submit', round: 1, guess: guessFor(1, 1) });
    const before = b.view;
    await b.reconnect();
    const v = await b.waitView((x) => x.round === 1, { fromStart: false });
    assert.equal(v.round, before.round);
    assert.ok(v.phase === 'recall' || v.phase === 'reveal');
    if (v.phase === 'recall') {
      assert.equal(v.me.submitted, true);
      assert.deepEqual(v.me.guess, before.me.guess);
      assert.equal(v.target, null, 'yeniden bağlanınca hedef geri gelmemeli');
    }
    const c = room.bots[2];
    const p = (await c.waitView((x) => x.phase === 'recall')).players.find((x) => x.id === b.playerId);
    assert.equal(p.submitted, true, 'diğerleri kimin gönderdiğini görür');
    assert.ok(!contains(JSON.stringify(c.view), guessFor(1, 1)), 'ama cevabı göremez');
  });

  test('oyuncu ayrılınca kalanlar cevap verdiyse tur hemen biter', async () => {
    const room = await setup(3, { rounds: 3, recallSeconds: 60 });
    const [a, b, c] = room.bots;
    await a.waitView((v) => v.phase === 'recall');
    a.action({ type: 'submit', round: 1, guess: guessFor(0, 1) });
    b.action({ type: 'submit', round: 1, guess: guessFor(1, 1) });
    await a.waitView((v) => v.players.filter((p) => p.submitted).length === 2);
    c.leave();
    const v = await a.waitView((x) => x.phase === 'reveal', { timeout: 2000 });
    assert.equal(v.players.length, 2);
    assert.equal(Object.keys(v.lastRound.answers).length, 2);
  });

  test('ayar doğrulama: tur 3–10, süre 15–60, bilinmeyen zorluk varsayılan', async () => {
    const { bots, host } = await makeRoom(srv.wsUrl, gameId, 2, 'Ayar');
    all.push(...bots);
    host.send({ t: 'settings', settings: { rounds: 99, recallSeconds: 1, difficulty: 'yok-boyle' } });
    const r = await host.waitRoom((x) => x.settings.rounds === 10);
    assert.equal(r.settings.recallSeconds, 15);
    assert.ok(['normal', 'easy'].includes(r.settings.difficulty));
    host.send({ t: 'settings', settings: { rounds: 1, recallSeconds: 600 } });
    const r2 = await host.waitRoom((x) => x.settings.rounds === 3);
    assert.equal(r2.settings.recallSeconds, 60);
  });
}
