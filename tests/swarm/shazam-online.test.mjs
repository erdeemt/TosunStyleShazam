// Online Shazam sürü testleri: host şarkı ekler (prep), doğrulama, cevap sızıntısı, puanlama, tur akışı.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.01 }); }); // tur 90 sn ≈ 0.9 sn
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const TRACKS = [
  { title: 'Şımarık', artist: 'Tarkan', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/aaa.mp3?hdnea=x', cover: 'https://e-cdns-images.dzcdn.net/images/cover/1.jpg' },
  { title: 'Gidiyorum', artist: 'Sezen Aksu', audio: 'https://p.scdn.co/mp3-preview/bbb', spotifyId: 'abcdefghij12345678' },
  { title: 'Never Gonna Give You Up', artist: 'Rick Astley', ytId: 'dQw4w9WgXcQ', alt: ['Never Gonna Give You Up', 'Rick Astley - Never Gonna Give You Up'] },
  { title: 'Bohemian Rhapsody', artist: 'Queen', audio: 'https://p.scdn.co/mp3-preview/ccc' },
  { title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/d/e/f/0/ddd.mp3' },
  // Havuzda her zaman ≥ 3 çalınmayan şarkı kalır; 5 tur için en az 8 şarkı gerekir.
  { title: 'Kuzu Kuzu', artist: 'Tarkan', audio: 'https://p.scdn.co/mp3-preview/eee' },
  { title: 'Yalnızlar Rıhtımı', artist: 'Sezen Aksu', audio: 'https://p.scdn.co/mp3-preview/fff' },
  { title: 'Dudu', artist: 'Tarkan', audio: 'https://p.scdn.co/mp3-preview/ggg' },
];
const SECRET_WORDS = ['Şımarık', 'Tarkan', 'Gidiyorum', 'Sezen', 'Rick Astley', 'Bohemian', 'Queen', 'Daft Punk', 'abcdefghij12345678', 'cover/1.jpg'];

async function setup(n, settings = {}, tracks = TRACKS) {
  const room = await makeRoom(srv.wsUrl, 'shazam', n, 'Dinleyen');
  all.push(...room.bots);
  room.host.send({ t: 'prep', data: { op: 'add', source: 'Test listesi', tracks } });
  await room.host.waitRoom((r) => r.prep?.trackCount > 0);
  room.host.send({ t: 'settings', settings: { rounds: 5, ...settings } });
  await room.host.waitRoom((r) => r.settings.rounds === (settings.rounds ?? 5));
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'play')));
  return room;
}

// Kendi eyleminin sonucunu bekle (başkasının eylemiyle gelen güncellemeyi değil).
async function play(bot, action) {
  const before = bot.view?.me?.guesses.length ?? 0;
  const wasDone = bot.view?.me?.done;
  bot.action(action);
  return bot.waitView((v) => !v.me || v.me.guesses.length > before || (v.me.done && !wasDone) || v.phase !== 'play');
}

const answerOf = (view) => TRACKS.find((t) => (t.ytId && t.ytId === view.media.ytId) || (t.audio && t.audio === view.media.audio));

test('prep: sadece host, geçersiz şarkılar elenir, kötü adresler süzülür, tekrarlar tek sayılır', async () => {
  const { bots, host } = await makeRoom(srv.wsUrl, 'shazam', 3, 'Prep');
  all.push(...bots);
  const err = bots[1].waitFor((m) => m.t === 'error');
  bots[1].send({ t: 'prep', data: { op: 'add', tracks: TRACKS } });
  assert.match((await err).message, /oda sahibi/);
  // başlatılamaz: şarkı yok
  const e2 = host.waitFor((m) => m.t === 'error');
  host.send({ t: 'start' });
  assert.match((await e2).message, /en az 4 şarkı/);
  host.send({ t: 'prep', data: { op: 'add', source: 'Kötü', tracks: [
    { title: 'Kötü ses', audio: 'https://evil.example/track.mp3' },
    { title: 'http', audio: 'http://p.scdn.co/mp3-preview/x' },
    { title: 'Sessiz', artist: 'Yok' }, // çalınacak bir şey yok
    { title: '', ytId: 'dQw4w9WgXcQ' },
    { title: 'Kötü yt', ytId: '../../etc' },
    { title: 'İyi', artist: 'A', ytId: 'abcdefghijk', cover: 'https://evil.example/x.png' },
    { title: 'İyi', artist: 'A', ytId: 'abcdefghijk' }, // tekrar
    { title: { toString: 1 }, ytId: 'abcdefghijk' },
  ] } });
  const room = await host.waitRoom((r) => r.prep?.sources.includes('Kötü'));
  assert.equal(room.prep.trackCount, 1, 'sadece geçerli tek şarkı kalmalı');
  host.send({ t: 'prep', data: { op: 'reset' } });
  assert.equal((await host.waitRoom((r) => r.prep.trackCount === 0)).prep.sources.length, 0);
});

test('şarkı adı/sanatçı/kapak tur açıklanana kadar hiçbir görünümde yok; öneri havuzu oyun başına bir kez (shared)', async () => {
  const { bots } = await setup(4);
  for (const b of bots) {
    const shared = b.messages.filter((m) => m.t === 'shared');
    assert.equal(shared.length, 1, 'öneri havuzu bir kez gelmeli');
    assert.ok(shared[0].data.pool.includes('Şımarık — Tarkan'));
    assert.ok(b.messages.filter((m) => m.t === 'view').every((m) => !('pool' in m.view)), 'görünümde havuz olmamalı');
  }
  for (const b of bots) {
    for (const m of b.messages) {
      if (m.t !== 'view' || m.view.reveal) continue;
      const text = JSON.stringify(m.view);
      for (const w of SECRET_WORDS) assert.ok(!text.includes(w), `${b.name} açıklanmadan "${w}" gördü`);
    }
  }
});

test('puan: bildiği adıma göre 5..1, o adımda ilk bilen +1; yanlış tahmin süreyi uzatır', async () => {
  const { bots } = await setup(3, { rounds: 3 });
  const [a, b, c] = bots;
  const ans = answerOf(a.view);
  // a: ilk adımda doğru → 5 + 1
  let v = (await play(a, { type: 'guess', text: ans.title.toLocaleLowerCase('tr') }));
  assert.equal(v.me.won, true);
  assert.equal(v.me.points, 6);
  // b: yanlış → 2. adım, sonra doğru → 4 + 1 (2. adımda ilk)
  v = (await play(b, { type: 'guess', text: 'yanlış cevap' }));
  assert.equal(v.me.stage, 1);
  v = (await play(b, { type: 'guess', text: ans.title }));
  assert.equal(v.me.points, 5);
  // c: geç geç → 3. adım, doğru → 3 + 1
  await play(c, { type: 'skip' });
  await play(c, { type: 'skip' });
  const rv = (await play(c, { type: 'guess', text: ans.title }));
  assert.equal(rv.phase, 'reveal', 'herkes bitince tur açılır');
  assert.equal(rv.reveal.title, ans.title);
  assert.deepEqual(rv.players.map((p) => p.roundPoints), [6, 5, 4]);
});

test('aynı adımda ikinci bilen bonus almaz; 5 yanlışta tur o oyuncu için biter; pes et', async () => {
  const { bots } = await setup(3);
  const [a, b, c] = bots;
  const ans = answerOf(a.view);
  await play(a, { type: 'guess', text: ans.title });
  const v = (await play(b, { type: 'guess', text: ans.title }));
  assert.equal(v.me.points, 5, 'aynı adımda ikinci: bonus yok');
  for (let i = 0; i < 5; i++) await play(c, { type: 'guess', text: `yanlış ${i}` });
  const end = await c.waitView((x) => x.phase === 'reveal');
  assert.equal(end.phase, 'reveal');
  assert.equal(end.players.find((p) => p.id === c.playerId).roundPoints, 0);
});

test('başkalarının tahmin metni görünmez; bitirmiş oyuncu tekrar tahmin edemez; host olmayan sonraki şarkıya geçemez', async () => {
  const { bots, host } = await setup(3);
  const [a, b] = bots;
  await play(b, { type: 'guess', text: 'GİZLİ-TAHMİN-XYZ' });
  await sleep(50);
  assert.ok(!a.transcript().includes('GİZLİ-TAHMİN-XYZ'), 'başkasının tahmini sızdı');
  const ans = answerOf(a.view);
  await play(a, { type: 'guess', text: ans.title });
  assert.match((await a.expectError({ type: 'guess', text: 'tekrar' })).message, /bitirdin/);
  for (const x of bots) if (!x.view.me.done) x.action({ type: 'giveUp' });
  await host.waitView((v) => v.phase === 'reveal');
  const nonHost = bots.find((x) => x !== host);
  assert.match((await nonHost.expectError({ type: 'next' })).message, /oda sahibi/);
});

test('süre dolunca tur açılır; son şarkıdan sonra oyun biter, skorlar toplanır', async () => {
  const { bots, host } = await setup(2, { rounds: 3 });
  for (let round = 1; round <= 3; round++) {
    await host.waitView((v) => v.round === round && v.phase === 'play');
    const ans = answerOf(host.view);
    await play(host, { type: 'guess', text: ans.title });
    // diğer oyuncu hiçbir şey yapmaz → süre dolar (90 sn × 0.01)
    await host.waitView((v) => v.phase === 'reveal', { timeout: 3000 });
    host.action({ type: 'next' });
  }
  const room = await host.waitRoom((r) => r.phase === 'over');
  assert.equal(room.phase, 'over');
  assert.equal(host.view.players.find((p) => p.id === host.playerId).score, 18, '3 × (5+1)');
  assert.equal(bots[1].view.players.find((p) => p.id === bots[1].playerId).score, 0);
});

test('oyuncu ayrılınca tur kalanlarla biter; yeniden bağlanan ilerlemesini korur', async () => {
  const { bots, host } = await setup(3);
  const [a, b, c] = bots;
  await play(b, { type: 'guess', text: 'yanlış' });
  b.drop();
  await host.waitRoom((r) => r.players.find((p) => p.id === b.playerId)?.connected === false);
  await sleep(30);
  await b.connect();
  assert.equal((await b.waitView((v) => v.me)).me.stage, 1);
  c.send({ t: 'leave' });
  const ans = answerOf(a.view);
  await play(a, { type: 'guess', text: ans.title });
  const v = await play(b, { type: 'guess', text: ans.title });
  assert.equal(v.phase, 'reveal');
});

test('güvenlik: kullanıcı adı/portlu adresler reddedilir; metindeki kontrol karakterleri atılır; ≥ 3 şarkı çalınmadan kalır', async () => {
  const { bots, host } = await makeRoom(srv.wsUrl, 'shazam', 2, 'Güv');
  all.push(...bots);
  host.send({ t: 'prep', data: { op: 'add', source: 'S', tracks: [
    { title: 'a', audio: 'https://evil.com@p.scdn.co/x' },
    { title: 'b', audio: 'https://p.scdn.co:8443/x' },
    { title: 'Te' + String.fromCharCode(1).repeat(50) + 'mi' + String.fromCharCode(0x202e) + 'z', artist: 'X', audio: 'https://p.scdn.co/mp3-preview/ok1' },
    { title: 'İki', artist: 'Y', audio: 'https://p.scdn.co/mp3-preview/ok2' },
    { title: 'Üç', artist: 'Z', audio: 'https://p.scdn.co/mp3-preview/ok3' },
    { title: 'Dört', artist: 'W', audio: 'https://p.scdn.co/mp3-preview/ok4' },
  ] } });
  assert.equal((await host.waitRoom((r) => r.prep?.trackCount > 0)).prep.trackCount, 4);
  host.send({ t: 'settings', settings: { rounds: 10 } });
  await host.waitRoom((r) => r.settings.rounds === 10);
  host.send({ t: 'start' });
  const v = await host.waitView((x) => x.phase === 'play');
  assert.equal(v.totalRounds, 1, '4 şarkıda 3 tanesi çalınmadan kalmalı');
  const pool = host.messages.find((m) => m.t === 'shared').data.pool;
  assert.ok(pool.includes('Temiz — X'), 'kontrol karakterleri temizlenmeli: ' + JSON.stringify(pool));
});

test('güvenlik: odadaki birinin tekrar katılması herkese yayın yapmaz; host beklerse açılıştan sonra kendiliğinden geçilir', async () => {
  const { bots, host } = await setup(2, { rounds: 3 }); // ayar en az 3 şarkı
  const [, guest] = bots;
  const before = host.messages.length;
  guest.send({ t: 'join', code: host.room.code });
  await guest.waitFor((m) => m.t === 'room');
  await sleep(100);
  assert.equal(host.messages.length, before, 'host yeni mesaj almamalı');
  for (const b of bots) b.action({ type: 'giveUp' });
  await host.waitView((x) => x.phase === 'reveal');
  // 30 sn × 0.01 = 0.3 sn sonra kimse basmadan 2. şarkı
  const next = await host.waitView((x) => x.round === 2 && x.phase === 'play', { timeout: 3000 });
  assert.equal(next.round, 2);
});
