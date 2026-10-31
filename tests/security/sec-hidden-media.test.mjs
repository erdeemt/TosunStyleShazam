// Gizli uyaranlar ağ sekmesinden okunamaz: ezber/gösterim sırasında hiçbir JSON'da (REST yanıtı ya da lobi ws mesajı)
// Nüans hex'i, Ton Avı Zor Hz'i, Algıla nokta koordinatları ya da yörünge parametreleri (g, hız, iniş) yok.
// Medya opak tek kullanımlık adresten gelir: sahibine (kimlik + lobide oda) bağlı, süreli, sınırlı kullanım, doğru başlıklar.
// Ayrıca günlük "yan hesap" kuralı: bulmacanın gününde açılan hesap sıralama dışı (FAKE_TODAY dahil).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { secret, fetchMedia, decodePng, countBlobs, parseWav, estimateFreq, hasKey } from '../lib/media.js';
import { hexToRgb } from '../../public/recall-math.js';
import { TESTS, trackLanding, tempoExpected, splitValue } from '../../public/perceptle-math.js';

const DAY = '2026-11-02';
const TS = 0.02;
process.env.TEST_GAMES = '1';
process.env.RECALL_SALT = 'test-salt';
process.env.WORDLE_SALT = 'test-salt';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-hidden-'));
const { dailyTarget } = await import('../../server/recall.js');
const { dailyAnswer, istanbulDate } = await import('../../server/wordle.js');

let srv;
const bots = [];
before(async () => { srv = await startServer({ timeScale: TS, env: { FAKE_TODAY: DAY } }); });
after(async () => { bots.forEach((b) => b.close()); await srv.stop(); });

async function post(server, path, body) {
  const res = await fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json, text: JSON.stringify(json) };
}
const identity = async (name, server = srv) => (await post(server, '/api/identity', { name })).json;
const recall = (game, ep, body, server = srv) => post(server, `/api/recall/${game}/${ep}`, body);
const perc = (ep, body, server = srv) => post(server, `/api/perceptle/${ep}`, body);
const MEDIA = /^\/api\/media\/[0-9a-f]{32}$/;
// Sayı tek başına duruyorsa (başka sayının parçası değil)
const hasNum = (text, v) => new RegExp(`(^|[^0-9.])${String(v).replace('.', '[.]')}($|[^0-9])`).test(text);
const PHYSICS = ['g', 'vx', 'vy', 'x0', 'y0', 'landing', 'dots'];

function meanRgb(img) {
  const sums = [0, 0, 0];
  for (let i = 0; i < img.pixels.length; i++) sums[i % 3] += img.pixels[i];
  return sums.map((s) => s / (img.pixels.length / 3));
}

test('Nüans tek oyunculu: hex JSON\'da yok; PNG sadece sahibine, 2 kullanım, doğru başlıklar; renk hedefe yakın', async () => {
  const me = await identity('Göz');
  const other = await identity('Hırsız');
  const target = dailyTarget('nuance', DAY, 0);
  const texts = [];
  const st = await recall('nuance', 'start', { ...me, mode: 'daily' });
  texts.push(st.text);
  const r = await recall('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
  assert.equal(r.status, 200, r.text);
  texts.push(r.text);
  assert.match(r.json.media, MEDIA);
  assert.equal(r.json.target, undefined);
  texts.push((await recall('nuance', 'start', { ...me, mode: 'daily' })).text); // sayfa yenileme
  for (const t of texts) assert.ok(!t.toLowerCase().includes(target.slice(1)), `hex JSON'da: ${t.slice(0, 200)}`);
  // Başkası / kimliksiz / sahte jeton
  assert.equal((await fetchMedia(srv, r.json.media, other)).status, 403);
  assert.equal((await fetchMedia(srv, r.json.media, { playerId: me.playerId, token: 'yanlis' })).status, 403);
  assert.equal((await fetchMedia(srv, r.json.media, null)).status, 403);
  assert.equal((await fetchMedia(srv, `/api/media/${randomBytes(16).toString('hex')}`, me)).status, 404);
  assert.equal((await fetchMedia(srv, '/api/media/../../server.js', me)).status, 404);
  // Sahibi: 200, image/png, no-store, nosniff; ortalama renk hedef ±1
  const m = await fetchMedia(srv, r.json.media, me);
  assert.equal(m.status, 200);
  assert.equal(m.type, 'image/png');
  assert.equal(m.cache, 'no-store');
  assert.equal(m.nosniff, 'nosniff');
  const img = decodePng(m.body);
  assert.equal(img.width, 64);
  meanRgb(img).forEach((v, c) => assert.ok(Math.abs(v - hexToRgb(target)[c]) < 1, `kanal ${c}`));
  assert.equal((await fetchMedia(srv, r.json.media, me)).status, 200, 'ikinci kullanım (ağ hatası payı)');
  assert.equal((await fetchMedia(srv, r.json.media, me)).status, 404, 'üçüncü kullanım reddedilmeli');
  // Sonuçta kesin hex görünür
  await sleep(r.json.memorizeMs + 20);
  const s = await recall('nuance', 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess: '#808080' });
  assert.equal(s.json.played[0].target, target);
});

test('medya adresi ezber + pay bitince geçersiz (404)', async () => {
  const me = await identity('Geç Kalan');
  const g = (await recall('nuance', 'start', { ...me, mode: 'free', difficulty: 'expert' })).json;
  const r = (await recall('nuance', 'round', { ...me, mode: 'free', gameId: g.gameId, round: 0 })).json;
  await sleep(r.memorizeMs + 3000 + 300);
  assert.equal((await fetchMedia(srv, r.media, me)).status, 404);
});

test('Ton Avı Zor tek oyunculu: Hz hiçbir JSON\'da yok, WAV hedef perdede; Kolay modda sayı gelir', async () => {
  const me = await identity('Kulak');
  const g = await recall('tone', 'start', { ...me, mode: 'free', difficulty: 'hard' });
  const r = await recall('tone', 'round', { ...me, mode: 'free', gameId: g.json.gameId, round: 0 });
  const target = (await secret(srv, { recall: 'tone', gameId: g.json.gameId })).targets[0];
  for (const t of [g.text, r.text]) assert.ok(!hasNum(t, target), `Hz JSON'da: ${t}`);
  assert.equal(r.json.target, undefined);
  assert.match(r.json.media, MEDIA);
  const m = await fetchMedia(srv, r.json.media, me);
  assert.equal(m.type, 'audio/wav');
  assert.equal(m.cache, 'no-store');
  const wav = parseWav(m.body);
  assert.equal(wav.rate, 22050);
  assert.equal(wav.dataBytes, Math.round((Math.max(100, r.json.memorizeMs) / 1000) * 22050) * 2, 'uzunluk = ezber süresi');
  // Kısa (ölçekli) tonda sıfır geçişi kaba: ±%15
  assert.ok(Math.abs(estimateFreq(wav) / target - 1) < 0.15 || target < 150, `frekans ${estimateFreq(wav)} ≠ ${target}`);
  const mid = await recall('tone', 'start', { ...me, mode: 'free', difficulty: 'hard' });
  assert.ok(!hasNum(mid.text, target));
  const easy = await recall('tone', 'start', { ...me, mode: 'free', difficulty: 'easy' });
  const re = await recall('tone', 'round', { ...me, mode: 'free', gameId: easy.json.gameId, round: 0 });
  assert.equal(typeof re.json.target, 'number', 'Kolay: Hz ekranda zaten');
  assert.equal(re.json.media, undefined);
});

test('Algıla tek oyunculu: Say PNG (koordinat yok, sayı doğru), Yörünge örnekleri (g/hız/iniş yok), sonuç doğru puanlanır', async () => {
  const me = await identity('Algı');
  const other = await identity('Başkası');
  const texts = [];
  const raw = (await secret(srv, { gameId: DAY })).stimuli;
  texts.push((await perc('start', { ...me, mode: 'daily' })).text);
  // Say
  const c = await perc('test', { ...me, mode: 'daily', gameId: DAY, index: 0 });
  texts.push(c.text);
  texts.push((await perc('start', { ...me, mode: 'daily' })).text);
  assert.match(c.json.stimulus.image, MEDIA);
  assert.equal((await fetchMedia(srv, c.json.stimulus.image, other)).status, 403);
  const m = await fetchMedia(srv, c.json.stimulus.image, me);
  assert.equal(m.type, 'image/png');
  const img = decodePng(m.body);
  assert.equal(img.width, c.json.stimulus.size);
  assert.equal(countBlobs(img, 0), raw[0].dots.length, 'görseldeki nokta sayısı');
  await sleep(c.json.showMs + 30);
  const sc = await perc('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: raw[0].dots.length });
  assert.equal(sc.json.played[0].score, 100);
  // Yörünge
  const t = await perc('test', { ...me, mode: 'daily', gameId: DAY, index: 1 });
  texts.push(t.text);
  texts.push((await perc('start', { ...me, mode: 'daily' })).text);
  assert.ok(t.json.stimulus.samples.length >= 30 && t.json.stimulus.samples.length <= 70);
  for (const txt of texts) {
    const j = JSON.parse(txt);
    assert.ok(!hasKey(j, PHYSICS), `uyaran sırasında fizik/nokta alanı: ${txt.slice(0, 300)}`);
    for (const d of raw[0].dots.slice(0, 5)) assert.ok(!txt.includes(JSON.stringify(d.slice(0, 2)).slice(1, -1)), 'nokta koordinatı');
    assert.ok(!hasNum(txt, Math.round(trackLanding(raw[1]) * 10) / 10), 'iniş noktası');
  }
  await sleep(t.json.showMs + 30);
  const st = await perc('submit', { ...me, mode: 'daily', gameId: DAY, index: 1, answer: trackLanding(raw[1]) });
  assert.equal(st.json.played[1].score, 100);
  // Sonuçta çizim örnekleri + iniş var, parametre yine yok
  const rev = st.json.played[1].stimulus;
  assert.ok(rev.samples.length > 50 && Math.abs(rev.landing - trackLanding(raw[1])) < 0.1);
  assert.ok(!hasKey(rev, ['g', 'vx', 'vy', 'x0', 'y0']));
});

async function lobby(game, n, settings, prefix) {
  const r = await makeRoom(srv.wsUrl, game, n, prefix);
  bots.push(...r.bots);
  r.host.send({ t: 'settings', settings });
  await r.host.waitRoom((x) => Object.entries(settings).every(([k, v]) => x.settings[k] === v));
  r.host.send({ t: 'start' });
  return r;
}

test('lobi Nüans + Ton Avı Zor: ezberde hedef ws mesajlarında yok; medya oyuncuya ve odaya bağlı', async () => {
  for (const [game, settings] of [['nuance', { rounds: 3, recallSeconds: 60 }], ['tone', { rounds: 3, difficulty: 'hard', recallSeconds: 60 }]]) {
    const r = await lobby(game, 3, settings, `H${game[0]}`);
    const [a, b] = r.bots;
    const outsider = new Bot(srv.wsUrl, 'Dışarıdan');
    bots.push(outsider);
    await outsider.connect();
    const memo = await Promise.all(r.bots.map((x) => x.waitView((v) => v.round === 1 && v.phase === 'memorize', { fromStart: true })));
    const target = (await secret(srv, { room: r.code })).targets[0];
    for (const v of memo) { assert.equal(v.target, null); assert.match(v.media, MEDIA); }
    assert.equal(new Set(memo.map((v) => v.media)).size, 3, 'oyuncu başına ayrı adres');
    const creds = (x) => ({ playerId: x.playerId, token: x.token });
    assert.equal((await fetchMedia(srv, memo[0].media, creds(b))).status, 403, 'aynı odadaki başka oyuncu');
    assert.equal((await fetchMedia(srv, memo[0].media, creds(outsider))).status, 403, 'odada olmayan');
    const m = await fetchMedia(srv, memo[0].media, creds(a));
    assert.equal(m.status, 200);
    if (game === 'nuance') {
      assert.equal(m.type, 'image/png');
      meanRgb(decodePng(m.body)).forEach((v, c) => assert.ok(Math.abs(v - hexToRgb(target)[c]) < 1));
    } else {
      assert.equal(m.type, 'audio/wav');
      assert.equal(parseWav(m.body).channels, 1);
    }
    // b odadan ayrılınca kendi adresi de geçersiz (oda bağı)
    b.leave();
    await sleep(60); // (adres ezber + 3 sn geçerli; süre dolmadan dene)
    assert.equal((await fetchMedia(srv, memo[1].media, creds(b))).status, 403, 'odadan çıkan oyuncu');
    // Turu bitir, açıklamaya kadar hiçbir mesajda hedef yok
    const rv = await a.waitView((v) => v.round === 1 && v.phase === 'recall', { timeout: 5000 });
    assert.equal(rv.target, null);
    for (const x of [a, r.bots[2]]) x.action({ type: 'submit', round: 1, guess: game === 'nuance' ? '#123456' : 300 });
    const reveal = await a.waitView((v) => v.round === 1 && v.phase === 'reveal', { timeout: 5000 });
    assert.equal(reveal.lastRound.target, target);
    for (const x of [a, r.bots[2]]) {
      const idx = x.messages.findIndex((msg) => msg.t === 'view' && msg.view?.round === 1 && msg.view.phase === 'reveal');
      const before = JSON.stringify(x.messages.slice(0, idx));
      if (game === 'nuance') assert.ok(!before.toLowerCase().includes(target.slice(1)), 'hex açıklamadan önce sızdı');
      else assert.ok(!hasNum(before, target), 'Hz açıklamadan önce sızdı');
    }
  }
});

test('lobi Algıla: Say görseli oyuncuya bağlı, koordinat ve yörünge parametresi hiçbir mesajda yok', async () => {
  const r = await lobby('perceptle', 2, { tests: 'count,track' }, 'HP');
  const [a, b] = r.bots;
  await a.waitView((v) => v.phase === 'intro');
  a.action({ type: 'go', index: 0 });
  const pv = await a.waitView((v) => v.phase === 'play' && v.index === 0);
  const pb = await b.waitView((v) => v.phase === 'play' && v.index === 0);
  const raw = (await secret(srv, { room: r.code })).stimuli;
  const creds = (x) => ({ playerId: x.playerId, token: x.token });
  assert.equal((await fetchMedia(srv, pv.stimulus.image, creds(b))).status, 403);
  const m = await fetchMedia(srv, pv.stimulus.image, creds(a));
  assert.equal(countBlobs(decodePng(m.body), 0), raw[0].dots.length);
  assert.equal((await fetchMedia(srv, pb.stimulus.image, creds(b))).status, 200);
  await sleep(Math.max(0, pv.recallAt - Date.now()) + 20);
  a.action({ type: 'answer', index: 0, answer: raw[0].dots.length });
  b.action({ type: 'answer', index: 0, answer: 1 });
  const rv = await a.waitView((v) => v.phase === 'reveal' && v.index === 0);
  assert.equal(rv.last.results[a.playerId].score, 100);
  a.action({ type: 'next', index: 0 });
  await a.waitView((v) => v.phase === 'intro' && v.index === 1);
  a.action({ type: 'go', index: 1 });
  const tv = await a.waitView((v) => v.phase === 'play' && v.index === 1);
  assert.ok(tv.stimulus.samples.length >= 30);
  await sleep(Math.max(0, tv.recallAt - Date.now()) + 20);
  a.action({ type: 'answer', index: 1, answer: trackLanding(raw[1]) });
  b.action({ type: 'answer', index: 1, answer: 10 });
  const tr = await a.waitView((v) => v.phase === 'reveal' && v.index === 1);
  assert.equal(tr.last.results[a.playerId].score, 100);
  await a.waitView((v) => v.phase === 'reveal' && v.index === 1);
  for (const x of [a, b]) {
    const all = x.transcript();
    assert.ok(!all.includes('"dots"') && !/"(vx|vy|g|x0|y0)":/.test(all), `${x.name}: ham uyaran sızdı`);
    assert.ok(!all.includes(JSON.stringify(raw[0].dots[0])));
  }
});

// ---------- Günlük yan hesap kuralı ----------

const today = istanbulDate(Date.now());

test('günlük: bulmacanın gününde açılan hesap sıralama dışı, eski hesap (createdAt yok) sıralı (Wordle, Nüans, Algıla; FAKE_TODAY = bugün)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tss-fresh-'));
  const old = { id: randomUUID(), token: randomBytes(16).toString('hex'), name: 'Eski', lastSeen: Date.now() };
  const lastWeek = { id: randomUUID(), token: randomBytes(16).toString('hex'), name: 'Geçen hafta', lastSeen: Date.now(), createdAt: Date.now() - 7 * 86_400_000 };
  writeFileSync(join(dir, 'identities.json'), JSON.stringify({ [old.id]: old, [lastWeek.id]: lastWeek }));
  const s2 = await startServer({ timeScale: TS, dataDir: dir, env: { FAKE_TODAY: today } });
  try {
    const oldMe = { playerId: old.id, token: old.token };
    const weekMe = { playerId: lastWeek.id, token: lastWeek.token };
    const fresh = await identity('Yeni Hesap', s2);
    // Wordle: yeni hesap ilk denemede bilir, eski 2.'de, geçen hafta 3.'de
    const answer = dailyAnswer(today);
    const WRONG = JSON.parse(readFileSync(new URL('../../content/wordle/valid.json', import.meta.url))).filter((w) => w !== answer).slice(50, 53);
    const wordle = async (who, wrongs) => {
      for (const w of [...wrongs, answer]) await post(s2, '/api/wordle/guess', { ...who, mode: 'daily', gameId: today, word: w });
    };
    await wordle(fresh, []);
    await wordle(oldMe, WRONG.slice(0, 1));
    await wordle(weekMe, WRONG.slice(0, 2));
    const wb = (await post(s2, '/api/wordle/leaderboard', fresh)).json;
    assert.deepEqual(wb.entries.map((e) => [e.name, e.rank, e.fresh]), [['Eski', 1, false], ['Geçen hafta', 2, false], ['Yeni Hesap', null, true]]);
    // Nüans: yeni hesap kusursuz, eski orta
    const nuance = async (who, perfect) => {
      for (let i = 0; i < 5; i++) {
        const r = (await recall('nuance', 'round', { ...who, mode: 'daily', gameId: today, round: i }, s2)).json;
        await sleep(r.memorizeMs + 10);
        await recall('nuance', 'submit', { ...who, mode: 'daily', gameId: today, round: i, guess: perfect ? dailyTarget('nuance', today, i) : '#777777' }, s2);
      }
    };
    await nuance(fresh, true);
    await nuance(oldMe, false);
    const nb = (await recall('nuance', 'leaderboard', oldMe, s2)).json;
    assert.deepEqual(nb.entries.map((e) => [e.name, e.rank, e.fresh]), [['Eski', 1, false], ['Yeni Hesap', null, true]]);
    assert.equal(nb.entries[1].total, 1000, 'sıralama dışı ama sonucu görünür');
    // Algıla: yeni hesap kusursuz, eski sıfıra yakın
    const raw = (await secret(s2, { gameId: today })).stimuli;
    const friday = new Date(`${today}T12:00:00Z`).getUTCDay() === 5;
    const perfectOf = (i) => {
      const st = raw[i];
      switch (TESTS[i]) {
        case 'count': return st.dots.length;
        case 'track': return trackLanding(st);
        case 'angle': return st.target;
        case 'tempo': { const I = 60_000 / st.bpm; return [0, 1, 2, 3].map((k) => k * I).concat(tempoExpected(st.bpm, friday)).map((t) => t * TS); }
        default: return splitValue(st);
      }
    };
    const play = async (who, good) => {
      for (let i = 0; i < 5; i++) {
        const r = (await perc('test', { ...who, mode: 'daily', gameId: today, index: i }, s2)).json;
        await sleep(r.showMs + 30);
        await perc('submit', { ...who, mode: 'daily', gameId: today, index: i, answer: good ? perfectOf(i) : TESTS[i] === 'tempo' ? [] : 0 }, s2);
      }
    };
    await play(fresh, true);
    await play(oldMe, false);
    const pb = (await perc('leaderboard', fresh, s2)).json;
    assert.deepEqual(pb.entries.map((e) => [e.name, e.rank, e.fresh]), [['Eski', 1, false], ['Yeni Hesap', null, true]]);
    assert.ok(pb.entries[1].me && pb.entries[1].total > pb.entries[0].total);
  } finally {
    await s2.stop();
  }
});

test('günlük: FAKE_TODAY başka bir günse bugün açılan hesap o günün sıralamasına girer (gerçek açılış tarihine bakılır)', async () => {
  const a = await identity('Normal');
  const answer = dailyAnswer(DAY);
  await post(srv, '/api/wordle/guess', { ...a, mode: 'daily', gameId: DAY, word: answer });
  const wb = (await post(srv, '/api/wordle/leaderboard', a)).json;
  const mine = wb.entries.find((e) => e.me);
  assert.equal(mine.fresh, false);
  assert.equal(mine.rank, 1);
});
