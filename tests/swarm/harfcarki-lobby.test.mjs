// 🔤 Harf Çarkı lobi (kapışma) sürü testleri: herkes aynı çark + aynı saat, kendi hızında; oyun bitene kadar hiçbir
// görünümde cevap / başkasının yazdığı / başkasının ipucu yok; sıralama; süre sunucuda; yeniden bağlanma (kaldığı
// yerden, aynı kalan süre); oyun ortası gelen izleyici; ayrılma; erken/bozuk eylem; ayar temizliği. PLAN.md §4.13.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { Bot, makeRoom, sleep } from '../lib/bot.js';
import { secret } from '../lib/media.js';
import { fold } from '../../server/harfcarki-text.js';

const TS = 0.04; // 3 dk → 7,2 sn; 7 dk → 16,8 sn; 3-2-1 → 120 ms
const PACE = 180; // WS hız sınırı 30 mesaj / 5 sn (insan hızı); botlar hamle arası bekler
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: TS }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function room(n, settings = {}, prefix = 'Harf') {
  const r = await makeRoom(srv.wsUrl, 'harfcarki', n, prefix);
  all.push(...r.bots);
  if (Object.keys(settings).length) {
    r.host.send({ t: 'settings', settings });
    await Promise.all(r.bots.map((b) => b.waitRoom((x) => Object.entries(settings).every(([k, v]) => x.settings[k] === v))));
  }
  return r;
}

async function start(r) {
  r.host.send({ t: 'start' });
  const v = await r.host.waitView((x) => x.phase === 'play', { timeout: 8000 });
  await Promise.all(r.bots.map((b) => b.waitView((x) => x.gameKey === v.gameKey && x.phase === 'play')));
  return v;
}

const answersOf = async (code) => (await secret(srv, { room: code })).targets;

function leaks(obj, answers) {
  const text = ` ${fold(JSON.stringify(obj))} `;
  return answers.filter((a) => fold(a).replace(/ /g, '').length >= 4 && text.includes(` ${fold(a)} `));
}

// Botun kendi sırasındaki harfe hamlesi; KENDİ hamlesinin işlendiği görünümü bekler (başkasının hamlesi de görünüm yollar).
async function move(b, kind, text) {
  await sleep(PACE);
  const run = b.view.me.run;
  const pos = run.current.pos;
  const seq = run.last?.seq ?? 0;
  const p = b.waitFor((m) => m.t === 'error' || (m.t === 'view' && (m.view?.me.run?.last?.seq ?? 0) > seq), { timeout: 5000 });
  b.action(kind === 'pass' ? { type: 'pass', pos } : { type: 'answer', pos, text });
  const m = await p;
  assert.equal(m.t, 'view', JSON.stringify(m));
  return m.view;
}

test('3 kişi kapışma: aynı çark, kendi hızı, canlı renkler; bitene kadar cevap sızmaz; sıralama + açılış', async () => {
  const r = await room(3, { minutes: 7, difficulty: 'mixed' });
  const v0 = await start(r);
  assert.equal(v0.settings.minutes, 7);
  const answers = await answersOf(r.code);
  assert.equal(answers.length, 28);
  const [a, b, c] = r.bots;
  // Herkes aynı ilk harfi (A) görür, ipucu sadece kendi görünümünde
  for (const x of r.bots) {
    assert.equal(x.view.me.playing, true);
    assert.equal(x.view.me.run.current.letter, 'A');
    assert.equal(x.view.me.run.current.pos, 0);
  }
  const clue0 = a.view.me.run.current.clue;
  assert.equal(b.view.me.run.current.clue, clue0, 'aynı çark');
  // a: hepsi doğru; b: her 3. yanlış; c: ilk 5'i pas sonra doğru
  for (let i = 0; i < 28; i++) await move(a, 'answer', answers[a.view.me.run.current.pos]);
  assert.equal(a.view.me.run.done, true);
  assert.equal(a.view.over, false, 'diğerleri bitmedi');
  assert.equal(a.view.me.run.recap, null, 'oyun bitmeden cevaplar yok (bitiren için de)');
  const playB = (async () => { for (let i = 0; i < 28; i++) await move(b, 'answer', i % 3 === 0 ? 'olmayankelime' : answers[b.view.me.run.current.pos]); })();
  for (let i = 0; i < 5; i++) await move(c, 'pass');
  // Canlı: c'nin görünümünde a ve b'nin renkleri var, c'nin pasları sarı
  const live = c.view;
  const pa = live.players.find((p) => p.id === a.playerId);
  assert.equal(pa.correct, 28);
  assert.equal(pa.done, true);
  assert.ok(live.players.find((p) => p.id === c.playerId).states.slice(0, 5).every((s) => s === 'pass'));
  assert.equal(live.me.run.current.pos, 5);
  while (!c.view.me.run.done) await move(c, 'answer', answers[c.view.me.run.current.pos]);
  await playB;
  const over = await a.waitView((x) => x.over);
  // Sızıntı taraması: bitişten önceki her mesaj
  for (const bot of r.bots) {
    const idx = bot.messages.findIndex((m) => m.t === 'view' && m.view?.gameKey === v0.gameKey && m.view.over);
    const before = bot.messages.slice(0, idx);
    assert.deepEqual(leaks(before, answers), [], `${bot.name}: cevap sızdı`);
    for (const m of before) {
      if (m.t !== 'view' || !m.view) continue;
      const s = JSON.stringify(m.view);
      assert.ok(!/"answer"|"typed"|"targets"|"ids"/.test(s), `${bot.name}: gizli alan`);
      assert.equal(m.view.reveal, null);
    }
  }
  // Sıralama: a (28/0), c (28/0 ama daha yavaş), b
  assert.deepEqual(over.ranking.map((p) => p.id), [a.playerId, c.playerId, b.playerId]);
  assert.equal(over.ranking[2].wrong, 10);
  assert.equal(over.reveal.recap.length, 28);
  assert.equal(over.reveal.recap[0].answer, answers[0]);
  assert.equal(over.reveal.results[b.playerId].typed[0], 'olmayankelime');
  assert.equal(over.me.run.recap.length, 28);
  // Bittikten sonra eylem sessizce yok sayılır
  a.action({ type: 'answer', pos: 0, text: 'x' });
  await sleep(100);
  assert.ok(!a.errors?.some?.((e) => /Bilinmeyen/.test(e)));
});

test('saat sunucuda: kimse bitirmezse süre dolunca oyun biter; sonra gelen cevap sayılmaz', async () => {
  const r = await room(2, { minutes: 3 });
  const v = await start(r);
  const answers = await answersOf(r.code);
  await move(r.host, 'answer', answers[0]);
  const over = await r.host.waitView((x) => x.over, { timeout: 8000 });
  assert.ok(Date.now() >= v.endsAt, 'süreden önce bitmedi');
  const me = over.ranking.find((p) => p.id === r.host.playerId);
  assert.equal(me.correct, 1);
  assert.equal(over.me.run.reason, 'time');
  r.host.action({ type: 'answer', pos: 1, text: answers[1] });
  await sleep(150);
  assert.equal(r.host.view.ranking.find((p) => p.id === r.host.playerId).correct, 1);
});

test('erken eylem (3-2-1 sırasında), bozuk/eski eylem, bilinmeyen tür', async () => {
  const r = await room(2, { minutes: 7 });
  r.host.send({ t: 'start' });
  const ready = await r.host.waitView((x) => x.phase === 'ready' || x.phase === 'play');
  if (ready.phase === 'ready') {
    assert.equal(ready.me.run.current, null, '3-2-1 sırasında ipucu yok');
    const e = await r.host.expectError({ type: 'pass', pos: 0 });
    assert.match(e.message, /başlamadı/);
  }
  await r.host.waitView((x) => x.phase === 'play');
  const e2 = await r.host.expectError({ type: 'uç' });
  assert.match(e2.message, /Bilinmeyen/);
  // Eski harfe (pos uyuşmaz) ve bozuk metin: sessizce yok sayılır ya da yanlış sayılır, sunucu düşmez
  r.host.action({ type: 'pass', pos: 5 });
  r.host.action({ type: 'answer', pos: 0, text: { a: 1 } });
  await sleep(150);
  const v = await r.host.act({ type: 'pass', pos: r.host.view.me.run.current.pos });
  assert.equal(v.t, 'view');
});

test('yeniden bağlanma: kaldığı harften, aynı bitiş anıyla devam; oyun ortası gelen izleyici olur', async () => {
  const r = await room(2, { minutes: 7 });
  const v = await start(r);
  const answers = await answersOf(r.code);
  const [a, b] = r.bots;
  await move(a, 'answer', answers[0]);
  await move(a, 'pass');
  await a.reconnect();
  const back = await a.waitFreshView((x) => x.gameKey === v.gameKey);
  assert.equal(back.me.run.current.pos, 2);
  assert.equal(back.endsAt, v.endsAt);
  assert.deepEqual(back.me.run.letters.slice(0, 2).map((l) => l.state), ['ok', 'pass']);
  // Geç gelen: izleyici, ipucu/run yok ama canlı ilerleme var
  const late = new Bot(srv.wsUrl, 'Geç');
  all.push(late);
  await late.connect();
  await late.join(r.code);
  const lv = await late.waitView((x) => x.gameKey === v.gameKey);
  assert.equal(lv.me.playing, false);
  assert.equal(lv.me.run, null);
  assert.equal(lv.players.length, 2);
  assert.ok(!JSON.stringify(lv).includes('"clue"'));
  const e = await late.expectError({ type: 'pass', pos: 0 });
  assert.match(e.message, /İzleyici/);
  // b ayrılır → kalan a bitirince oyun biter
  b.leave();
  while (!a.view.me.run.done) await move(a, 'pass').then(() => (a.view.me.run.done ? null : move(a, 'answer', 'yok')));
  const over = await a.waitView((x) => x.over);
  assert.equal(over.ranking.length, 2);
  assert.equal(over.ranking.at(-1).id, b.playerId, 'ayrılan en sonda');
  assert.equal(over.ranking.at(-1).left, true);
});

test('ayarlar temizlenir; tek kişi oda açıp oynayabilir', async () => {
  const r = await room(1, {}, 'Tek');
  r.host.send({ t: 'settings', settings: { minutes: 99, difficulty: '<script>' } });
  const room1 = await r.host.waitRoom((x) => x.settings.minutes === 5);
  assert.equal(room1.settings.difficulty, 'mixed');
  r.host.send({ t: 'settings', settings: { minutes: 3, difficulty: 'easy' } });
  await r.host.waitRoom((x) => x.settings.minutes === 3 && x.settings.difficulty === 'easy');
  const v = await start(r);
  assert.equal(v.players.length, 1);
  r.host.action({ type: 'quit' });
  const over = await r.host.waitView((x) => x.over);
  assert.equal(over.me.run.reason, 'quit');
  assert.equal(over.ranking[0].passed, 28);
});
