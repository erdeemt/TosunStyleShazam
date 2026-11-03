// 📸 Ne Zaman Nerede? lobi sürü testleri: tam oyun, puan = scoreRound, tur kapanmadan cevap/başkasının tahmini sızmaz,
// süre dolunca tahminsiz 0, görsel jetonu sahibine + odaya bağlı, yeniden bağlanma, izleyici, ayar temizliği, host geçişi.
// Kurallar: PLAN.md §4.11 "Çok oyunculu".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { fetchMedia, secret } from '../lib/media.js';
import { KM_SCALE, cleanGuess, scoreRound } from '../../public/whenwhere-math.js';

const TS = 0.05; // 30 sn tur → 1.5 sn; açıklama 20 sn → 1 sn
const POOL = JSON.parse(readFileSync(new URL('../../content/whenwhere/test-photos.json', import.meta.url), 'utf8')).photos;
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: TS, env: { FAKE_TODAY: '2026-10-30' } }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, settings = {}, prefix = 'Foto') {
  const r = await makeRoom(srv.wsUrl, 'whenwhere', n, prefix);
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

const targets = async (code) => (await secret(srv, { room: code })).targets;
const untilServer = async (t) => { const w = t - Date.now(); if (w > 0) await sleep(w); };
const near = (t, k) => ({ lat: Math.max(-89, Math.min(89, t.lat + (k + 1) * 0.7)), lon: t.lon + (k + 1) * 0.9, year: Math.min(2020, t.year + (k + 1) * 3) }); // hiçbiri tam isabet değil (sızıntı taraması)
const photoOf = (t) => POOL.find((p) => p.lat === t.lat && p.lon === t.lon && p.year === t.year);

test('3 kişi, 3 tur: puanlar scoreRound ile aynı, toplamlar, final unvanı; tur kapanmadan cevap sızmaz', async () => {
  const r = await room(3, { rounds: 3, time: 30 });
  const v0 = await start(r);
  const truth = await targets(r.code);
  assert.equal(truth.length, 3);
  const leakCheckUntil = []; // tur i'nin açıklamasına kadar alınan mesaj sayısı (her bot)
  for (let i = 0; i < 3; i++) {
    const play = await r.host.waitView((x) => x.gameKey === v0.gameKey && x.phase === 'play' && x.index === i, { timeout: 8000 });
    assert.equal(play.last, null);
    assert.equal(play.history.length, i);
    assert.match(play.image, /^\/api\/media\/[0-9a-f]{32}$/);
    await untilServer(play.startAt + 20);
    for (const [k, b] of r.bots.entries()) {
      const v = await b.act({ type: 'guess', index: i, guess: near(truth[i], k) });
      assert.equal(v.t, 'view', JSON.stringify(v));
      // Kilitledikten sonra bile başkasının tahmini görünmez (sadece kilitledi bayrağı)
      if (k === 0 && v.view.phase === 'play') {
        assert.equal(v.view.me.locked, true);
        assert.deepEqual(v.view.me.guess, cleanGuess(near(truth[i], 0)));
        assert.ok(!JSON.stringify(v.view.players).includes('"guess"'));
      }
    }
    const rev = await r.host.waitView((x) => x.phase === 'reveal' && x.index === i);
    await Promise.all(r.bots.map((b) => b.waitView((x) => x.phase === 'reveal' && x.index === i)));
    leakCheckUntil.push(r.bots.map((b) => b.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === v0.gameKey && m.view.phase === 'reveal' && m.view.index === i)));
    assert.deepEqual(rev.last.truth, truth[i]);
    for (const [k, b] of r.bots.entries()) {
      const res = rev.last.results[b.playerId];
      assert.equal(res.score, scoreRound(cleanGuess(near(truth[i], k)), truth[i], KM_SCALE.world).score);
      assert.equal(res.timedOut, false);
    }
    assert.ok(rev.last.title && rev.last.author && rev.last.license);
    r.host.action({ type: 'next', index: i });
  }
  const over = await r.host.waitView((x) => x.phase === 'over');
  for (const p of over.players) {
    assert.equal(p.total, p.scores.reduce((s, x) => s + x, 0));
    assert.ok(p.badge?.name);
  }
  // Sızıntı: tur i'nin başlığı, dosya adı ve koordinatı o turun açıklamasından önceki hiçbir mesajda yok
  for (let i = 0; i < 3; i++) {
    const p = photoOf(truth[i]);
    for (const [k, b] of r.bots.entries()) {
      assert.ok(leakCheckUntil[i][k] > 0);
      const before = JSON.stringify(b.messages.slice(0, leakCheckUntil[i][k]));
      for (const needle of [p.title_tr, p.caption_tr, p.src.file, p.id, `"lat":${p.lat}`, `"lon":${p.lon}`]) {
        assert.ok(!before.includes(needle), `tur ${i} için "${needle}" açıklamadan önce sızdı (bot ${k})`);
      }
      assert.ok(!before.includes(p.src.thumb.slice(8, 40)));
    }
  }
});

test('süre dolunca: tahmin etmeyen 0 (timedOut), eden puan alır; geç tahmin reddedilir', async () => {
  const r = await room(2, { rounds: 3, time: 30 });
  const v0 = await start(r);
  const truth = await targets(r.code);
  await untilServer(v0.startAt + 20);
  await r.bots[0].act({ type: 'guess', index: 0, guess: { ...truth[0] } });
  const rev = await r.host.waitView((x) => x.phase === 'reveal' && x.index === 0, { timeout: 8000 });
  assert.equal(rev.last.results[r.bots[0].playerId].score, 1000);
  assert.deepEqual(rev.last.results[r.bots[1].playerId], { guess: null, km: null, dy: null, place: 0, yearPts: 0, score: 0, timedOut: true });
  // Kapanmış tura geç tahmin sessizce yok sayılır (puan değişmez)
  r.bots[1].action({ type: 'guess', index: 0, guess: { ...truth[0] } });
  await sleep(100);
  const still = r.bots[1].view;
  assert.equal(still.history[0].results[r.bots[1].playerId].score, 0);
});

test('erken, çift, bozuk tahmin ve host olmayanın "Sonraki"si reddedilir', async () => {
  const r = await room(2, { rounds: 3, time: 60 });
  const v0 = await start(r);
  if (Date.now() < v0.startAt - 200) {
    const early = await r.bots[1].expectError({ type: 'guess', index: 0, guess: { lat: 0, lon: 0, year: 1900 } });
    assert.match(early.message, /başlamadı/);
  }
  await untilServer(v0.startAt + 20);
  for (const guess of [null, { lat: '1', lon: 0, year: 1900 }, { lat: 0, lon: 0, year: 1500 }, { lat: 100, lon: 0, year: 1900 }, [1, 2, 3]]) {
    const e = await r.bots[1].expectError({ type: 'guess', index: 0, guess });
    assert.match(e.message, /Geçersiz/);
  }
  const bogus = await r.bots[1].expectError({ type: 'hack', index: 0 });
  assert.match(bogus.message, /Bilinmeyen/);
  await r.bots[1].act({ type: 'guess', index: 0, guess: { lat: 1, lon: 1, year: 1900 } });
  const twice = await r.bots[1].expectError({ type: 'guess', index: 0, guess: { lat: 2, lon: 2, year: 1901 } });
  assert.match(twice.message, /zaten/);
  await r.bots[0].act({ type: 'guess', index: 0, guess: { lat: 1, lon: 1, year: 1900 } });
  await r.bots[1].waitView((x) => x.phase === 'reveal');
  const notHost = await r.bots[1].expectError({ type: 'next', index: 0 });
  assert.match(notHost.message, /oda sahibi/);
});

test('görsel jetonu: sahibine ve odaya bağlı; başka oyuncu 403; görselde üst veri yok', async () => {
  const r = await room(2, { rounds: 3 });
  await start(r);
  const a = r.bots[0];
  const b = r.bots[1];
  const imgA = a.view.image;
  const imgB = b.view.image;
  assert.notEqual(imgA, imgB, 'herkese ayrı jeton');
  assert.equal((await fetchMedia(srv, imgA, b)).status, 403);
  const outsider = new Bot(srv.wsUrl, 'Dışarıdan');
  all.push(outsider);
  await outsider.connect();
  assert.equal((await fetchMedia(srv, imgA, outsider)).status, 403);
  const ok = await fetchMedia(srv, imgA, a);
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'image/jpeg');
  assert.ok(!ok.body.includes('SECRET') && !ok.body.includes('file='));
});

test('yeniden bağlanma: aynı görsel adresi ve kilit durumu korunur; geç gelen izleyici olur, tahmin edemez', async () => {
  const r = await room(2, { rounds: 3, time: 60 });
  const v0 = await start(r);
  await untilServer(v0.startAt + 20);
  const img = r.bots[1].view.image;
  await r.bots[1].act({ type: 'guess', index: 0, guess: { lat: 10, lon: 10, year: 1950 } });
  await r.bots[1].reconnect();
  const back = await r.bots[1].waitFreshView((x) => x.phase === 'play');
  assert.equal(back.image, img);
  assert.equal(back.me.locked, true);
  assert.deepEqual(back.me.guess, { lat: 10, lon: 10, year: 1950 });
  const late = new Bot(srv.wsUrl, 'Geç');
  all.push(late);
  await late.connect();
  await late.join(r.code);
  const lv = await late.waitView((x) => x.phase === 'play');
  assert.equal(lv.me.playing, false);
  assert.match(lv.image, /^\/api\/media\//, 'izleyici de fotoğrafı görür');
  const e = await late.expectError({ type: 'guess', index: 0, guess: { lat: 1, lon: 1, year: 1900 } });
  assert.match(e.message, /İzleyici|oyunda değilsin/);
  // Kalan oyuncu kilitleyince tur kapanır (izleyici beklenmez)
  await r.bots[0].act({ type: 'guess', index: 0, guess: { lat: 1, lon: 1, year: 1900 } });
  const rev = await late.waitView((x) => x.phase === 'reveal');
  assert.ok(rev.last.truth);
});

test('oyuncu ayrılınca kalanlar beklemez; ayarlar temizlenir; Eski İstanbul ölçeği', async () => {
  const r = await room(3, { set: 'istanbul', rounds: 3, time: 90 });
  assert.deepEqual(r.host.room.settings, { set: 'istanbul', rounds: 3, time: 90 });
  const v0 = await start(r);
  const truth = await targets(r.code);
  for (const t of truth) assert.ok(t.lat > 40.8 && t.lat < 41.4);
  await untilServer(v0.startAt + 20);
  await r.bots[0].act({ type: 'guess', index: 0, guess: { lat: truth[0].lat + 0.009, lon: truth[0].lon, year: truth[0].year } }); // ~1 km
  await r.bots[1].act({ type: 'guess', index: 0, guess: { ...truth[0] } });
  r.bots[2].send({ t: 'leave' });
  const rev = await r.host.waitView((x) => x.phase === 'reveal');
  const s0 = rev.last.results[r.bots[0].playerId];
  assert.ok(s0.km > 0.9 && s0.km < 1.1);
  assert.equal(s0.place, scoreRound({ lat: truth[0].lat + 0.009, lon: truth[0].lon, year: truth[0].year }, truth[0], KM_SCALE.istanbul).place);
  assert.ok(s0.place < 400, 'İstanbul ölçeği: 1 km ciddi kayıp');
  // Ayar temizliği (yeni oda)
  const r2 = await room(1);
  r2.host.send({ t: 'settings', settings: { set: '../x', rounds: 7, time: 45 } });
  const st = await r2.host.waitRoom((x) => x.settings.rounds === 5 && x.settings.time === 60);
  assert.equal(st.settings.set, 'karisik');
  // Seti yetmeyen tur sayısı başlatılamaz (test havuzunda Savaş teması 1 fotoğraf)
  r2.host.send({ t: 'settings', settings: { set: 'tema-savas', rounds: 3 } });
  await r2.host.waitRoom((x) => x.settings.set === 'tema-savas');
  const err = r2.host.waitFor((m) => m.t === 'error', { timeout: 3000 });
  r2.host.send({ t: 'start' });
  assert.match((await err).message, /yeterli fotoğraf/);
});

test('tek kişi tam oyun + host "Sonraki" ile hızlı geçiş, oyun sonu', async () => {
  const r = await room(1, { rounds: 3, time: 30 });
  const v0 = await start(r);
  for (let i = 0; i < 3; i++) {
    const p = await r.host.waitView((x) => x.gameKey === v0.gameKey && x.phase === 'play' && x.index === i, { timeout: 8000 });
    await untilServer(p.startAt + 20);
    await r.host.act({ type: 'guess', index: i, guess: { lat: 0, lon: 0, year: 1900 } });
    await r.host.waitView((x) => x.phase === 'reveal' && x.index === i);
    r.host.action({ type: 'next', index: i });
  }
  const over = await r.host.waitView((x) => x.phase === 'over');
  assert.equal(over.history.length, 3);
  assert.equal(over.over, true);
  assert.equal(over.image, null);
});
