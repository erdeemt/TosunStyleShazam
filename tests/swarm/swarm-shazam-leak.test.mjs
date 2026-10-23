// Tosun Shazam (online) gizlilik taraması (PLAN §4.4): tur açıklanana kadar şarkı adı/sanatçı/kapak/Spotify kimliği hiçbir
// istemciye gitmez (YouTube kimliği ve ses adresi kabul edilmiş sınırlama); başkalarının tahmin metinleri hiçbir zaman görünmez.
// Ek olarak yan kanallar: öneri havuzunun sırası, hata metinleri, görünüm boyutu (cevapla ilişkili bayt farkı), izleyici ve
// yeniden bağlanan oyuncunun görünümü, room mesajındaki prep özeti.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, Bot, sleep } from '../lib/bot.js';
import { ShazamReferee, makeTracks, sendPrep, secretHits, mediaKey, poolOf } from './swarm-shazam-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.01, seed: 41 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, tracks, settings) {
  const r = await makeRoom(srv.wsUrl, 'shazam', n, 'Gizli');
  all.push(...r.bots);
  const ref = new ShazamReferee({ label: `leak ${r.code}`, tracks }).attachAll(r.bots);
  await sendPrep(r.host, tracks);
  r.host.send({ t: 'settings', settings });
  await r.host.waitRoom((x) => x.settings.rounds === settings.rounds);
  return { ...r, ref };
}

// Botun aldığı mesajları turlara böl: [{ round, gameKey, revealed, msg }]
function tagMessages(bot) {
  let cur = null;
  return bot.messages.map((m) => {
    if (m.t === 'view' && m.view) cur = { round: m.view.round, gameKey: m.view.gameKey, revealed: m.view.phase !== 'play' };
    return { ...cur, msg: m };
  });
}

test('tam oyun: açıklama öncesi hiçbir mesaj türünde (view/room/error) gizli değer yok; havuz sırası cevaptan bağımsız', async () => {
  const tracks = makeTracks(20, 41);
  const { bots, host, code, ref } = await room(4, tracks, { rounds: 6, roundSeconds: 45 });
  host.send({ t: 'start' });
  await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'play')));
  // Oyun ortasında bir izleyici katılır, bir oyuncu düşüp geri gelir
  const spec = await new Bot(srv.wsUrl, 'İzleyici').connect();
  all.push(spec);
  ref.attach(spec);
  await spec.join(code);
  const [, b1, b2] = bots;
  for (let round = 1; round <= 6; round++) {
    await host.waitView((v) => v.round === round && v.phase === 'play', { timeout: 3000 });
    const ans = ref.answerFor(host.view);
    // Yanlış tahminler, geçersiz eylemler (hata metinleri taranır), bir doğru tahmin, bir yeniden bağlanma
    for (const b of bots) { const t = `yanlis ${b.name}-r${round}`; b.sentGuesses.add(t); b.action({ type: 'guess', text: t }); }
    spec.action({ type: 'guess', text: ans.title });
    b2.action({ type: 'guess', text: { toString: 1 } });
    b1.sentGuesses.add(ans.title);
    b1.action({ type: 'guess', text: ans.title });
    if (round === 2) { await b2.reconnect(); }
    for (const b of bots) b.action({ type: 'giveUp' });
    await host.waitView((v) => v.round === round && v.phase === 'reveal', { timeout: 3000 });
    host.action({ type: 'next' });
  }
  await host.waitRoom((r) => r.phase === 'over');
  await sleep(50);
  const violations = ref.finalChecks([...bots, spec]);
  assert.deepEqual(violations, [], violations.join('\n'));

  for (const b of [...bots, spec]) {
    for (const { msg, revealed } of tagMessages(b)) {
      if (msg.t === 'view' && msg.view && !revealed) {
        assert.deepEqual(secretHits(msg.view, tracks), [], `${b.name} açıklama öncesi gizli değer gördü`);
      }
      if (msg.t === 'shared') { // öneri havuzu (kasıtlı herkese açık): sadece pool alanı, prep sırasıyla tüm şarkılar
        assert.deepEqual(Object.keys(msg.data), ['pool']);
        assert.deepEqual(msg.data.pool, tracks.map((t) => `${t.title} — ${t.artist}`));
      } else if (msg.t !== 'view') {
        const text = JSON.stringify(msg);
        for (const t of tracks) for (const s of [t.title, t.artist, t.cover, t.spotifyId]) if (s) assert.ok(!text.includes(s), `${b.name} ${msg.t} mesajında "${s}"`);
      }
    }
  }
  // Pozitif kontrol: tarayıcı açıklanmış görünümde cevabı gerçekten buluyor
  const revealedView = host.messages.find((m) => m.t === 'view' && m.view?.phase === 'reveal').view;
  assert.ok(secretHits(revealedView, tracks).includes(revealedView.reveal.title), 'tarama açıklanan adı bulabilmeli');
  // Havuz: prep sırasıyla tüm şarkılar (seçilen 6 şarkıya göre daraltılmamış, sıralanmamış)
  const pool = poolOf(host);
  assert.deepEqual(pool, tracks.map((t) => `${t.title} — ${t.artist}`), 'havuz prep sırasıyla tüm şarkılar olmalı');
});

test('yan kanal: görünüm baytları medya/skor dışında turdan tura sabit (cevapla ilişkili ek veri yok)', async () => {
  const tracks = makeTracks(12, 42);
  const { bots, host, ref } = await room(3, tracks, { rounds: 8, roundSeconds: 45 });
  host.send({ t: 'start' });
  const firsts = [];
  for (let round = 1; round <= 8; round++) {
    const v = await host.waitView((x) => x.round === round && x.phase === 'play', { timeout: 3000 });
    const msg = host.messages.findLast((m) => m.t === 'view' && m.view === v);
    // Ağdaki bayt = görünüm JSON'u (gizli dolgu/ek alan yok)
    const { receivedAt, bytes, ...wire } = msg;
    assert.equal(bytes, Buffer.byteLength(JSON.stringify(wire)), 'mesaj boyutu görünüm JSON\'una eşit olmalı');
    const norm = JSON.stringify({ ...v, media: null, endsAt: 0, round: 0, players: v.players.map((p) => ({ ...p, score: 0 })) });
    firsts.push(norm);
    for (const b of bots) b.action({ type: 'giveUp' });
    await host.waitView((x) => x.round === round && x.phase === 'reveal', { timeout: 3000 });
    host.action({ type: 'next' });
  }
  assert.equal(new Set(firsts).size, 1, 'medya/skor dışındaki görünüm turdan tura değişmemeli');
  assert.deepEqual(ref.violations, []);
});

test('başkalarının tahmin metni hiçbir zaman (açıklamadan ve oyun bittikten sonra da) görünmez', async () => {
  const tracks = makeTracks(8, 43); // en az 3 şarkı hep çalınmadan kalır
  const { bots, host, ref } = await room(3, tracks, { rounds: 3, roundSeconds: 45 });
  host.send({ t: 'start' });
  const markers = new Map();
  for (let round = 1; round <= 3; round++) {
    await host.waitView((v) => v.round === round && v.phase === 'play', { timeout: 3000 });
    for (const b of bots) {
      const t = `yanlis ‮<img src=x onerror=alert(1)> ${b.name}-${round}-ÇĞİ`;
      b.sentGuesses.add(t);
      b.sentGuesses.add(t.replace(new RegExp(String.fromCharCode(0x202e), 'g'), '')); // sunucu yön karakterini atar
      markers.set(t, b);
      b.action({ type: 'guess', text: t });
    }
    await sleep(30);
    for (const b of bots) b.action({ type: 'giveUp' });
    await host.waitView((v) => v.round === round && v.phase === 'reveal', { timeout: 3000 });
    host.action({ type: 'next' });
  }
  await host.waitRoom((r) => r.phase === 'over');
  await sleep(50);
  for (const b of bots) {
    const text = b.transcript();
    for (const [t, owner] of markers) {
      // Sunucu kontrol/yön karakterlerini (U+202E) atar: temizlenmiş hâli aranır
      const needle = JSON.stringify(t.replace(new RegExp(String.fromCharCode(0x202e), 'g'), '')).slice(1, -1);
      if (owner === b) assert.ok(text.includes(needle), 'kendi tahmini kendi görünümünde olmalı');
      else assert.ok(!text.includes(needle), `${b.name}, ${owner.name}'in tahminini gördü`);
    }
  }
  assert.deepEqual(ref.violations, []);
});

test('izleyici ve yeniden bağlanan host: açıklama öncesi gizli değer yok, izleyici eylemleri reddedilir', async () => {
  const tracks = makeTracks(6, 44);
  const { bots, host, code, ref } = await room(2, tracks, { rounds: 3, roundSeconds: 90 });
  host.send({ t: 'start' });
  await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'play')));
  const spec = await new Bot(srv.wsUrl, 'Seyirci').connect();
  all.push(spec);
  ref.attach(spec);
  const r = await spec.join(code);
  assert.equal(r.players.find((p) => p.id === spec.playerId).spectator, true);
  const sv = await spec.waitView(() => true);
  assert.equal(sv.me, null);
  assert.deepEqual(secretHits(sv, tracks), []);
  assert.match((await spec.expectError({ type: 'guess', text: ref.answerFor(sv).title })).message, /İzleyici/);
  await host.reconnect();
  const hv = await host.waitView((v) => v.phase === 'play');
  assert.deepEqual(secretHits(hv, tracks), []);
  // Medya anahtarı herkese aynı
  assert.equal(mediaKey(hv.media), mediaKey(spec.view.media));
  assert.deepEqual(ref.violations, []);
});
