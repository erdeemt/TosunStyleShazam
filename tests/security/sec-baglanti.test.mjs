// 🔗 Bağlantı Avı güvenlik testleri (tek oyunculu HTTP uçları + kişi dizini + fotoğraf vekili):
// bitmeden hiçbir yanıtta en kısa yol / ara kişiler / komşu listesi yok; günlük tek deneme; bozuk girdiler reddedilir;
// başkasının oyunu oynanamaz; fotoğraf sadece kümedeki kişi için, üst verisiz, IP sınırlı; sıralama + "🆕 sıralama dışı";
// başkalarının zinciri sen bitirmeden görünmez; Sınırsız'da yapboz tekrarı yok. Kurallar: PLAN.md §4.12.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';

const DAY = '2026-11-10'; // gerçek bugünle çakışmasın (bugün açılan hesaplar sıralama dışı olurdu)
const GRAPH = JSON.parse(readFileSync(new URL('../../content/baglanti/test-graph.json', import.meta.url), 'utf8'));
const Q = GRAPH.people.map((p) => p.q);
const adjacent = (a, b) => GRAPH.edges.some(([x, y]) => (Q[x] === a && Q[y] === b) || (Q[x] === b && Q[y] === a));
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
const api = (s, who, ep, body = {}) => post(s, `/api/baglanti/${ep}`, { ...who, ...body });

// Yanıtta en kısa yolun ara kişileri (oyuncunun kendi eklediği hariç), komşu listesi ya da yol alanı var mı
function assertNoLeak(json, path, own, where) {
  const s = JSON.stringify(json);
  for (const q of path.slice(1, -1)) if (!own.includes(q)) assert.ok(!s.includes(`"${q}"`), `${where}: ara kişi ${q} sızdı → ${s.slice(0, 300)}`);
  assert.ok(!/"(path|neighbors|neighbours|adj|edges|key)"/.test(s), `${where}: yasak anahtar → ${s.slice(0, 300)}`);
  assert.ok(!/"optimal":\[/.test(s), `${where}: en kısa yol`);
}

test('günlük: başlamadan uçlar yok; oynarken hiçbir yanıtta en kısa yol yok; bitince açılır; tek deneme', async () => {
  const me = await player(srv, 'Sızdırmaz');
  const { path } = await secret(srv, { baglanti: 1, gameId: DAY });
  assert.equal(path.length, 5, 'günlük = Orta (3 ara kişi)');
  const pre = await api(srv, me, 'start', { mode: 'daily' });
  assert.equal(pre.status, 200);
  assert.equal(pre.json.run, null);
  for (const q of path) assert.ok(!JSON.stringify(pre.json).includes(q), 'başlamadan uçlar bile yok');
  const g = await api(srv, me, 'begin', { mode: 'daily' });
  assert.equal(g.json.run.start, path[0]);
  assert.equal(g.json.run.target, path.at(-1));
  assertNoLeak(g.json, path, [], 'begin');
  const bad = Q.find((q) => !path.includes(q) && !adjacent(path[0], q));
  const w = await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: bad });
  assert.equal(w.status, 200);
  assert.equal(w.json.fb.ok, false);
  assert.equal(w.json.run.wrong, 1);
  assertNoLeak(w.json, path, [], 'yanlış');
  const h = await api(srv, me, 'hint', { mode: 'daily', gameId: DAY, kind: 'field' });
  assertNoLeak(h.json, path, [], 'ipucu');
  const own = [];
  for (const q of path.slice(1, -2)) {
    const r = await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: q });
    own.push(q);
    assert.equal(r.json.fb.ok, true);
    assertNoLeak(r.json, path, own, `adım ${own.length}`);
    // Sayfa yenilendi: aynı zincir, yine sızıntı yok
    const again = await api(srv, me, 'start', { mode: 'daily' });
    assert.deepEqual(again.json.run.chain.map((c) => c.q), own);
    assertNoLeak(again.json, path, own, 'yenile');
  }
  const rm = await api(srv, me, 'remove', { mode: 'daily', gameId: DAY, pos: 1 });
  assertNoLeak(rm.json, path, own, 'sil');
  assert.equal(rm.json.run.chain.length, 1);
  await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: path[2] });
  const done = await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: path[3] });
  assert.equal(done.json.run.done, true);
  assert.deepEqual(done.json.run.optimal.map((x) => x.q), path.slice(1));
  assert.ok(done.json.run.final.t);
  // Tek deneme: tekrar başlatma aynı (biten) zinciri döner, adım eklenemez
  const again = await api(srv, me, 'begin', { mode: 'daily' });
  assert.equal(again.json.run.done, true);
  const more = await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: path[1] });
  assert.equal(more.status, 400);
  assert.match(more.json.error, /bitti/);
  for (const ep of ['hint', 'giveup', 'remove']) assert.equal((await api(srv, me, ep, { mode: 'daily', gameId: DAY, kind: 'letter', pos: 0 })).status, 400, ep);
});

test('bozuk girdiler: kimlik, kişi, konum, ipucu türü, başka gün, başkasının oyunu', async () => {
  const me = await player(srv, 'Bozuk');
  const g = (await api(srv, me, 'begin', { mode: 'daily' })).json;
  const bads = ['Q0', 'Q', 'Q12a', 'Q1234567890123', '../etc', '<img>', 42, null, {}, [], { toString: 'Q1' }, 'Q99999999'];
  for (const qid of bads) {
    const r = await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid });
    assert.equal(r.status, 400, JSON.stringify(qid));
  }
  for (const pos of [-1, 0, 99, 'a', null, {}]) assert.equal((await api(srv, me, 'remove', { mode: 'daily', gameId: DAY, pos })).status, 400);
  for (const kind of ['path', '', null, { k: 1 }, '__proto__', 'constructor']) assert.equal((await api(srv, me, 'hint', { mode: 'daily', gameId: DAY, kind })).status, 400, String(kind));
  assert.equal((await api(srv, me, 'add', { mode: 'daily', gameId: '2026-01-01', qid: g.run.start })).status, 400, 'başka gün');
  assert.equal((await api(srv, { playerId: me.playerId, token: 'x'.repeat(32) }, 'begin', { mode: 'daily' })).status, 400, 'sahte jeton');
  // Kendi başlangıcını ekleyemez
  assert.match((await api(srv, me, 'add', { mode: 'daily', gameId: DAY, qid: g.run.start })).json.error, /zaten/);
  // Sınırsız oyun sahibine bağlı
  const free = (await api(srv, me, 'start', { mode: 'free', difficulty: 'kolay' })).json;
  const other = await player(srv, 'Başkası');
  assert.equal((await api(srv, other, 'add', { mode: 'free', gameId: free.gameId, qid: free.run.start })).status, 400);
  assert.equal((await api(srv, other, 'hint', { mode: 'free', gameId: free.gameId, kind: 'letter' })).status, 400);
  // Büyük gövde
  const big = await post(srv, '/api/baglanti/add', { ...me, mode: 'daily', gameId: DAY, qid: 'Q1', pad: 'x'.repeat(5000) });
  assert.equal(big.status, 400);
  assert.equal((await fetch(`${srv.url}/api/baglanti/add`)).status, 400, 'GET reddedilir');
});

test('Sınırsız: zorluk = yol uzunluğu, aynı kimliğe yapboz tekrar gelmez (havuz bitene kadar)', async () => {
  const me = await player(srv, 'Sınırsız');
  for (const [diff, len] of [['kolay', 3], ['zor', 5]]) {
    const n = GRAPH.puzzles[diff].length;
    const keys = new Set();
    for (let i = 0; i < n; i++) {
      const g = (await api(srv, me, 'start', { mode: 'free', difficulty: diff })).json;
      assert.equal(g.run.diff, diff);
      assert.equal(g.run.opt, len - 1);
      const { path } = await secret(srv, { baglanti: 1, gameId: g.gameId });
      assert.equal(path.length, len + 1);
      assertNoLeak(g, path, [], 'serbest');
      keys.add(`${g.run.start}-${g.run.target}`);
    }
    assert.equal(keys.size, n, `${diff}: tekrar yok`);
  }
  // Bozuk zorluk → Orta
  assert.equal((await api(srv, me, 'start', { mode: 'free', difficulty: { x: 1 } })).json.run.diff, 'orta');
});

test('kişi dizini: GET, sıkıştırılmış, ETag/304; bağlantı bilgisi yok', async () => {
  const res = await fetch(`${srv.url}/api/baglanti/people`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 200);
  const etag = res.headers.get('etag');
  assert.ok(etag);
  const j = await res.json();
  assert.equal(j.people.length, GRAPH.people.length);
  for (const r of j.people) assert.equal(r.length, 9);
  const s = JSON.stringify(j);
  assert.ok(!/edges|puzzles|path/.test(s));
  const again = await fetch(`${srv.url}/api/baglanti/people`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

test('fotoğraf vekili: kümedeki kişi → üst verisiz JPEG; bilinmeyen/bozuk → 404; önbellek başlıkları', async () => {
  const withImg = GRAPH.people.find((p) => p.img);
  const res = await fetch(`${srv.url}/api/baglanti/photo/${withImg.q}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /max-age/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body[0], 0xff);
  assert.equal(body[1], 0xd8);
  const text = body.toString('latin1');
  assert.ok(!text.includes('SECRET') && !text.includes('Exif') && !text.includes(withImg.q) && !text.includes('file='), 'üst veri silinmeli');
  const noImg = GRAPH.people.find((p) => !p.img);
  if (noImg) assert.equal((await fetch(`${srv.url}/api/baglanti/photo/${noImg.q}`)).status, 404);
  for (const bad of ['Q99999999', 'Q0', 'Q1.jpg', '..%2F..%2Fserver.js', 'https:%2F%2Fevil.com%2Fx.jpg']) {
    assert.equal((await fetch(`${srv.url}/api/baglanti/photo/${bad}`)).status, 404, bad);
  }
  assert.equal((await fetch(`${srv.url}/api/baglanti/photo/${withImg.q}`, { method: 'POST' })).status, 404, 'sadece GET');
});

test('fotoğraf vekili IP sınırı (LIMIT_PHOTO_PER_MIN)', async () => {
  const s2 = await startServer({ timeScale: 1, env: { FAKE_TODAY: DAY, LIMIT_PHOTO_PER_MIN: '5' } });
  try {
    const q = GRAPH.people.find((p) => p.img).q;
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(`${s2.url}/api/baglanti/photo/${q}`)).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  } finally { await s2.stop(); }
});

test('sıralama: puan ↓ sonra süre; pes eden sıralanmaz; başkalarının zinciri ancak sen bitirince; bugün açılan hesap 🆕', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const s2 = await startServer({ timeScale: 1, env: { FAKE_TODAY: today } });
  try {
    const { path } = await secret(s2, { baglanti: 1, gameId: today });
    const a = await player(s2, 'Ayşe');
    const b = await player(s2, 'Burak');
    const c = await player(s2, 'Cem');
    for (const who of [a, b, c]) await api(s2, who, 'begin', { mode: 'daily' });
    for (const q of path.slice(1, -1)) await api(s2, a, 'add', { mode: 'daily', gameId: today, qid: q });
    await api(s2, c, 'giveup', { mode: 'daily', gameId: today });
    const lbB = (await api(s2, b, 'leaderboard')).json;
    assert.equal(lbB.viewerDone, false);
    assert.equal(lbB.entries.length, 1);
    assert.equal(lbB.entries[0].chain, null, 'bitirmeyen başkasının zincirini görmez');
    assert.equal(lbB.gaveUp, 1);
    assert.equal(lbB.playing, 1);
    // Bu hesaplar bugün açıldı → sıralama dışı
    assert.equal(lbB.entries[0].fresh, true);
    assert.equal(lbB.entries[0].rank, null);
    const lbA = (await api(s2, a, 'leaderboard')).json;
    assert.deepEqual(lbA.entries[0].chain, path.slice(1, -1));
    assert.equal(lbA.entries[0].score > 0, true);
  } finally { await s2.stop(); }
});
