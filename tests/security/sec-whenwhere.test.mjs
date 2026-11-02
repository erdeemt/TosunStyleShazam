// 📸 Ne Zaman Nerede? güvenlik testleri (tek oyunculu HTTP uçları + görsel vekili):
// kilitlenmeden önce hiçbir yanıtta kimlik/başlık/dosya/koordinat/yıl yok; görsel jetonu sahibine bağlı ve sınırlı;
// görselde üst veri yok; günlük tek deneme ve sıralı tur; bozuk tahminler reddedilir; yan hesap "🆕 sıralama dışı".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { fetchMedia, secret } from '../lib/media.js';
import { scoreRound, KM_SCALE } from '../../public/whenwhere-math.js';

const DAY = '2026-10-30'; // gerçek bugünle çakışmasın (bugün açılan hesaplar sıralama dışı olurdu)
let srv;
before(async () => { srv = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY } }); });
after(async () => { await srv?.stop(); });

async function post(s, path, body) {
  const res = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function player(s, name) {
  const { json } = await post(s, '/api/identity', { name });
  return { playerId: json.playerId, token: json.token };
}
const api = (s, who, ep, body = {}) => post(s, `/api/whenwhere/${ep}`, { ...who, ...body });

// Bir gizli değerin yanıtta geçip geçmediği (kimlik, dosya, başlık, koordinatlar, yıl alanı)
function assertNoLeak(json, truth, where) {
  const s = JSON.stringify(json);
  for (const needle of [truth.id, truth.file, truth.title, String(truth.lat), String(truth.lon)]) {
    assert.ok(!s.includes(needle), `${where}: "${needle}" sızdı → ${s.slice(0, 300)}`);
  }
  assert.ok(!/"(truth|title|caption|lat|lon|year|wikiUrl|fileUrl|thumb|src|id)"/.test(s), `${where}: yasak anahtar → ${s.slice(0, 300)}`);
}

test('günlük: tur açılırken ve yeniden yüklenirken cevap sızmaz; kilitten sonra açılır; puan sunucuda', async () => {
  const me = await player(srv, 'Sızdırmaz');
  const truths = (await secret(srv, { whenwhere: 1, gameId: DAY })).truths;
  assert.equal(truths.length, 5);
  const start = await api(srv, me, 'start', { mode: 'daily' });
  assert.equal(start.status, 200);
  for (const t of truths) assertNoLeak(start.json, t, 'start');
  for (let i = 0; i < 5; i++) {
    const r = await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: i });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), ['gameId', 'image', 'index', 'mode', 'puzzleNo', 'rounds']);
    assert.match(r.json.image, /^\/api\/media\/[0-9a-f]{32}$/);
    for (const t of truths.slice(i)) assertNoLeak(r.json, t, `round ${i}`);
    // Sayfa yenilendi: bekleyen tur yeni görsel adresiyle gelir, yine cevapsız
    const again = await api(srv, me, 'start', { mode: 'daily' });
    assert.equal(again.json.pending.index, i);
    for (const t of truths.slice(i)) assertNoLeak({ ...again.json, played: [] }, t, `restart ${i}`);
    // Görsel: JPEG, üst veri (sunucunun enjekte ettiği SECRET/dosya adı) yok, no-store
    const img = await fetchMedia(srv, r.json.image, me);
    assert.equal(img.status, 200);
    assert.equal(img.type, 'image/jpeg');
    assert.equal(img.cache, 'no-store');
    assert.deepEqual([...img.body.subarray(0, 2)], [0xff, 0xd8]);
    for (const needle of ['SECRET', 'Exif', 'file=', truths[i].id, truths[i].title]) assert.ok(!img.body.includes(needle), needle);
    const guess = { lat: 41 + i, lon: 29 - i, year: 1900 + i * 10 };
    const g = await api(srv, me, 'guess', { mode: 'daily', gameId: DAY, round: i, guess });
    assert.equal(g.status, 200);
    const played = g.json.played.find((p) => p.index === i);
    assert.deepEqual(played.truth, { lat: truths[i].lat, lon: truths[i].lon, year: truths[i].year });
    assert.equal(played.score, scoreRound(guess, truths[i], KM_SCALE.world).score);
    assert.ok(played.author && played.license && played.licenseUrl && played.title);
    for (const t of truths.slice(i + 1)) assertNoLeak({ ...g.json, played: [] }, t, `guess ${i} sonrası`);
  }
  const end = await api(srv, me, 'start', { mode: 'daily' });
  assert.equal(end.json.done, true);
  assert.equal(end.json.played.length, 5);
});

test('günlük tek deneme: tekrar tahmin, tur atlama, bitince yeni tur reddedilir', async () => {
  const me = await player(srv, 'TekSefer');
  await api(srv, me, 'start', { mode: 'daily' });
  assert.equal((await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: 1 })).status, 400, 'tur atlanamaz');
  assert.equal((await api(srv, me, 'guess', { mode: 'daily', gameId: DAY, round: 0, guess: { lat: 1, lon: 1, year: 1900 } })).status, 400, 'açılmamış tur');
  await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: 0 });
  assert.equal((await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: 1 })).status, 400, 'önceki tur bitmeden');
  const ok = await api(srv, me, 'guess', { mode: 'daily', gameId: DAY, round: 0, guess: { lat: 1, lon: 1, year: 1900 } });
  assert.equal(ok.status, 200);
  const twice = await api(srv, me, 'guess', { mode: 'daily', gameId: DAY, round: 0, guess: { lat: 2, lon: 2, year: 1901 } });
  assert.equal(twice.status, 400);
  assert.match(twice.json.error, /zaten/);
  assert.equal((await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: 0 })).status, 400, 'biten tur yeniden açılmaz');
  for (let i = 1; i < 5; i++) {
    await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: i });
    await api(srv, me, 'guess', { mode: 'daily', gameId: DAY, round: i, guess: { lat: 1, lon: 1, year: 1900 } });
  }
  const over = await api(srv, me, 'round', { mode: 'daily', gameId: DAY, round: 4 });
  assert.equal(over.status, 400);
  assert.equal((await api(srv, me, 'round', { mode: 'daily', gameId: '2026-11-03', round: 0 })).status, 400, 'başka gün');
});

test('bozuk tahminler ve kimliksiz istekler reddedilir', async () => {
  const me = await player(srv, 'Bozuk');
  const g = (await api(srv, me, 'start', { mode: 'free', set: 'karisik' })).json;
  await api(srv, me, 'round', { mode: 'free', gameId: g.gameId, round: 0 });
  for (const guess of [null, 'x', [1, 2], { lat: '41', lon: 29, year: 1900 }, { lat: 95, lon: 0, year: 1900 }, { lat: 0, lon: 0, year: 1700 },
    { lat: 0, lon: 0, year: 2100 }, { lat: 0, lon: 0, year: 1950.5 }, { lat: 0, lon: 0 }, { lat: { toString: 1 }, lon: 0, year: 1900 }]) {
    const r = await api(srv, me, 'guess', { mode: 'free', gameId: g.gameId, round: 0, guess });
    assert.equal(r.status, 400, JSON.stringify(guess));
  }
  assert.equal((await api(srv, { playerId: me.playerId, token: 'yanlis' }, 'start', { mode: 'daily' })).status, 400);
  const other = await player(srv, 'Başkası');
  assert.equal((await api(srv, other, 'round', { mode: 'free', gameId: g.gameId, round: 0 })).status, 400, 'başkasının serbest oyunu');
  assert.equal((await api(srv, me, 'guess', { mode: 'free', gameId: g.gameId, round: 0, guess: { lat: 0, lon: 0, year: 1900 } })).status, 200);
});

test('görsel jetonu: sahibine bağlı, kimliksiz/başkası 403, sınırlı kullanım, sahte jeton 404', async () => {
  const me = await player(srv, 'Sahip');
  const thief = await player(srv, 'Hırsız');
  const g = (await api(srv, me, 'start', { mode: 'free', set: 'turkiye' })).json;
  const { json } = await api(srv, me, 'round', { mode: 'free', gameId: g.gameId, round: 0 });
  assert.equal((await fetchMedia(srv, json.image, thief)).status, 403);
  assert.equal((await fetchMedia(srv, json.image, null)).status, 403);
  assert.equal((await fetchMedia(srv, '/api/media/00000000000000000000000000000000', me)).status, 404);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetchMedia(srv, json.image, me)).status);
  assert.deepEqual(codes, [200, 200, 200, 404]);
});

test('serbest: set süzgeci uygulanır ve yakında görülen fotoğraf tekrar gelmez', async () => {
  const me = await player(srv, 'Gezgin');
  const seen = new Set();
  // Test havuzunda Eski İstanbul = 5 fotoğraf: ilk oyun hepsini gösterir; ikinci oyun (yetmediği için) en eskilerden açar.
  const g = (await api(srv, me, 'start', { mode: 'free', set: 'istanbul' })).json;
  assert.equal(g.set, 'istanbul');
  const truths = (await secret(srv, { whenwhere: 1, gameId: g.gameId })).truths;
  for (const t of truths) { assert.ok(t.lat > 40.8 && t.lat < 41.4, 'İstanbul'); seen.add(t.id); }
  const tr = (await api(srv, me, 'start', { mode: 'free', set: 'era-1900-1945' })).json;
  const trTruths = (await secret(srv, { whenwhere: 1, gameId: tr.gameId })).truths;
  assert.ok(trTruths.every((t) => t.year >= 1900 && t.year < 1945));
  // Karışık sette (16) iki oyun arka arkaya: oynanan (açılan) turlar tekrar gelmez
  const a = (await api(srv, me, 'start', { mode: 'free', set: 'karisik' })).json;
  for (let i = 0; i < 5; i++) {
    await api(srv, me, 'round', { mode: 'free', gameId: a.gameId, round: i });
    await api(srv, me, 'guess', { mode: 'free', gameId: a.gameId, round: i, guess: { lat: 0, lon: 0, year: 1900 } });
  }
  const aIds = (await secret(srv, { whenwhere: 1, gameId: a.gameId })).truths.map((t) => t.id);
  const b = (await api(srv, me, 'start', { mode: 'free', set: 'karisik' })).json;
  const bIds = (await secret(srv, { whenwhere: 1, gameId: b.gameId })).truths.map((t) => t.id);
  assert.equal(aIds.filter((id) => bIds.includes(id)).length, 0);
  const bogus = (await api(srv, me, 'start', { mode: 'free', set: '<script>' })).json;
  assert.equal(bogus.set, 'karisik');
});

test('sıralama: bitirmeyen görünmez, tur puanları ancak sen bitirince; bugün açılan hesap "sıralama dışı"', async () => {
  // Gerçek bugünle çalışan ayrı sunucu: yeni hesaplar bugünün hesabı → sıralama dışı
  const live = await startServer({ timeScale: 1 });
  try {
    const me = await player(live, 'Yeni');
    const g = (await api(live, me, 'start', { mode: 'daily' })).json;
    for (let i = 0; i < 5; i++) {
      await api(live, me, 'round', { mode: 'daily', gameId: g.gameId, round: i });
      await api(live, me, 'guess', { mode: 'daily', gameId: g.gameId, round: i, guess: { lat: 41, lon: 29, year: 1920 } });
    }
    const board = (await api(live, me, 'leaderboard')).json;
    assert.equal(board.entries.length, 1);
    assert.equal(board.entries[0].fresh, true);
    assert.equal(board.entries[0].rank, null);
    assert.equal(board.entries[0].scores.length, 5);
  } finally { await live.stop(); }
  // Sabit (geçmiş) günde: eski hesap sıralamada; bitirmeyen başkası puanları göremez
  const a = await player(srv, 'Bitiren');
  for (let i = 0; i < 5; i++) {
    if (i === 0) await api(srv, a, 'start', { mode: 'daily' });
    await api(srv, a, 'round', { mode: 'daily', gameId: DAY, round: i });
    await api(srv, a, 'guess', { mode: 'daily', gameId: DAY, round: i, guess: { lat: 41, lon: 29, year: 1920 } });
  }
  const peek = await player(srv, 'Bakan');
  const b2 = (await api(srv, peek, 'leaderboard')).json;
  const row = b2.entries.find((e) => e.name === 'Bitiren');
  assert.ok(row && row.rank >= 1 && row.fresh === false);
  assert.equal(row.scores, null, 'bitirmeden başkasının tur puanları yok');
  assertNoLeak(b2, { id: 'x'.repeat(12), file: 'Test photo', title: 'Galata Kulesi', lat: 41.02562, lon: 28.97417 }, 'leaderboard');
});
