// 🔤 Harf Çarkı tek oyunculu uç güvenliği: oyun bitmeden hiçbir yanıtta cevap/alt yok (sadece o anki ipucu), saat
// sunucuda (süre dolunca hamle sayılmaz), günlükte tek deneme, eski harfe hamle, başkasının oyunu, bozuk girdi,
// sınırsızda tekrar önleme, sıralama + 🆕 kuralı. Kurallar PLAN.md §4.13.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { secret } from '../lib/media.js';
import { fold } from '../../server/harfcarki-text.js';

const DAY = '2030-03-03';
let srv; // FAKE_TODAY'li, normal süre
let fast; // süre ölçeği 0.01 (5 dk → 3 sn)
before(async () => {
  [srv, fast] = await Promise.all([
    startServer({ timeScale: 1, env: { FAKE_TODAY: DAY, HARFCARKI_SALT: 'sec' } }),
    startServer({ timeScale: 0.01, env: { HARFCARKI_SALT: 'sec' } }),
  ]);
});
after(async () => { await srv?.stop(); await fast?.stop(); });

async function post(s, path, body) {
  const res = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function ident(s, name) {
  const { json } = await post(s, '/api/identity', { name });
  return { playerId: json.playerId, token: json.token };
}
const hc = (s, who, ep, body = {}) => post(s, `/api/harfcarki/${ep}`, { ...who, ...body });

// Cevaplardan herhangi biri (kelime olarak, katlanmış) metinde geçiyor mu?
function leaks(json, answers) {
  const text = ` ${fold(JSON.stringify(json))} `;
  return answers.filter((a) => fold(a).replace(/ /g, '').length >= 4 && text.includes(` ${fold(a)} `));
}

test('günlük: başlamadan ipucu yok; oynarken sadece o anki ipucu, cevap/alt hiçbir yanıtta yok; bitince döküm', async () => {
  const me = await ident(srv, 'Güvenlik');
  const sec = await secret(srv, { harfcarki: 1, gameId: DAY });
  assert.equal(sec.answers.length, 28);
  const seen = [];
  const r0 = await hc(srv, me, 'start', { mode: 'daily' });
  assert.equal(r0.json.status, 'ready');
  assert.equal(r0.json.current, undefined);
  seen.push(r0.json);
  const r1 = await hc(srv, me, 'begin', { mode: 'daily' });
  assert.equal(r1.json.status, 'playing');
  assert.equal(r1.json.current.pos, 0);
  assert.equal(r1.json.current.letter, 'A');
  assert.equal(r1.json.recap, null);
  seen.push(r1.json);
  let v = r1.json;
  for (let i = 0; i < 28 && v.status === 'playing'; i++) {
    const pos = v.current.pos;
    const body = i % 4 === 0 ? { kind: 'pass' } : i % 4 === 1 ? { kind: 'answer', answer: 'qqqqqq yanlış' } : { kind: 'answer', answer: sec.answers[pos].toLocaleUpperCase('tr') };
    const r = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    v = r.json;
    if (v.status === 'playing') seen.push(v);
  }
  for (const j of seen) {
    const s = JSON.stringify(j);
    assert.ok(!/"answer"|"alt"|"typed"|"recap":\[/.test(s), `alan sızdı: ${s.slice(0, 200)}`);
    assert.deepEqual(leaks(j, sec.answers), [], 'cevap metni sızdı');
  }
  // Paslananlar geri gelir: hepsini doğru bitir
  while (v.status === 'playing') {
    const r = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: v.current.pos, kind: 'answer', answer: sec.answers[v.current.pos] });
    v = r.json;
  }
  assert.equal(v.status, 'done');
  assert.equal(v.reason, 'all');
  assert.equal(v.summary.wrong, 7);
  assert.equal(v.summary.correct, 21);
  assert.equal(v.recap.length, 28);
  assert.equal(v.recap[0].answer, sec.answers[0]);
  assert.equal(v.recap[1].typed, 'qqqqqq yanlış');
  // Tek deneme: yeniden başlat → aynı bitmiş sonuç; hamle bir şey değiştirmez
  const again = await hc(srv, me, 'begin', { mode: 'daily' });
  assert.equal(again.json.status, 'done');
  assert.deepEqual(again.json.summary, v.summary);
  const late = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 0, kind: 'answer', answer: sec.answers[0] });
  assert.equal(late.json.status, 'done');
  assert.deepEqual(late.json.summary, v.summary);
  // Sıralama: FAKE_TODAY ileri tarih → hesap "bugün açılmış" sayılmaz
  const lb = await hc(srv, me, 'leaderboard');
  const mine = lb.json.entries.find((e) => e.me);
  assert.equal(mine.rank, 1);
  assert.equal(mine.correct, 21);
  assert.equal(mine.grid.length, 28);
});

test('günlük: eski harfe hamle, başlamadan hamle, bozuk girdi, yanlış gün reddedilir', async () => {
  const me = await ident(srv, 'Bozuk');
  const pre = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 0, kind: 'pass' });
  assert.equal(pre.status, 400);
  const b = await hc(srv, me, 'begin', { mode: 'daily' });
  assert.equal(b.json.current.pos, 0);
  await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 0, kind: 'pass' });
  const stale = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 0, kind: 'pass' });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /geçildi/);
  for (const bad of [{ answer: { $gt: '' } }, { answer: ['a'] }, { answer: '' }, { answer: null }]) {
    const r = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 1, kind: 'answer', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const weird = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 1, kind: '__proto__' });
  assert.equal(weird.status, 400);
  const wrongDay = await hc(srv, me, 'move', { mode: 'daily', gameId: '2030-03-02', pos: 1, kind: 'pass' });
  assert.match(wrongDay.json.error, /değişti/);
  const noAuth = await post(srv, '/api/harfcarki/move', { playerId: me.playerId, token: 'x', mode: 'daily', gameId: DAY, pos: 1, kind: 'pass' });
  assert.equal(noAuth.status, 400);
  // Uzun cevap kırpılır, sunucu düşmez
  const long = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 1, kind: 'answer', answer: 'ş'.repeat(1200) });
  assert.equal(long.status, 400, 'gövde sınırı (2 KB) aşıldı');
  const ok = await hc(srv, me, 'move', { mode: 'daily', gameId: DAY, pos: 1, kind: 'answer', answer: 'ş'.repeat(200) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.last.result, 'bad');
});

test('saat sunucuda: süre dolunca hamle sayılmaz, oyun "time" ile biter; istemci süreyi uzatamaz', async () => {
  const me = await ident(fast, 'Saat');
  const b = await hc(fast, me, 'begin', { mode: 'daily' });
  const date = b.json.gameId;
  assert.ok(b.json.endsAt - b.json.startAt <= 3100, 'ölçekli 5 dk');
  const sec = await secret(fast, { harfcarki: 1, gameId: date });
  await new Promise((r) => setTimeout(r, b.json.endsAt - Date.now() + 200));
  const r = await hc(fast, me, 'move', { mode: 'daily', gameId: date, pos: 0, kind: 'answer', answer: sec.answers[0], endsAt: Date.now() + 1e6 });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'done');
  assert.equal(r.json.reason, 'time');
  assert.equal(r.json.summary.correct, 0, 'süre sonrası cevap sayılmadı');
  assert.equal(r.json.last, null);
  // Bugün açılan hesap: sıralama dışı (🆕)
  const lb = await hc(fast, me, 'leaderboard');
  const mine = lb.json.entries.find((e) => e.me);
  assert.equal(mine.fresh, true);
  assert.equal(mine.rank, null);
});

test('sıralama: bitirmemiş biri başkalarının harf renklerini göremez, cevap yok', async () => {
  const other = await ident(srv, 'Meraklı');
  await hc(srv, other, 'begin', { mode: 'daily' });
  const lb = await hc(srv, other, 'leaderboard');
  assert.ok(lb.json.entries.length >= 1);
  for (const e of lb.json.entries) assert.equal(e.grid, null);
  assert.ok(lb.json.playing >= 1);
  assert.ok(!/"answer"|"typed"/.test(JSON.stringify(lb.json)));
});

test('sınırsız: yeni çark, yakında görülen ipuçları tekrar gelmez, başkasının oyununa hamle yapılamaz', async () => {
  const me = await ident(srv, 'Sınırsız');
  const you = await ident(srv, 'Başkası');
  const ids = new Set();
  let first;
  for (let k = 0; k < 3; k++) {
    const g = await hc(srv, me, 'begin', { mode: 'free', difficulty: k === 0 ? 'easy' : 'hard', minutes: 3 });
    assert.equal(g.json.status, 'playing');
    assert.equal(g.json.minutes, 3);
    first ??= g.json;
    const sec = await secret(srv, { harfcarki: 1, gameId: g.json.gameId });
    for (const id of sec.ids) { assert.ok(!ids.has(id), `tekrar ${id}`); ids.add(id); }
    assert.deepEqual(leaks(g.json, sec.answers), []);
  }
  const steal = await hc(srv, you, 'move', { mode: 'free', gameId: first.gameId, pos: 0, kind: 'pass' });
  assert.equal(steal.status, 400);
  // Bozuk ayarlar varsayılana döner
  const g = await hc(srv, me, 'begin', { mode: 'free', difficulty: 'çok zor', minutes: 999 });
  assert.equal(g.json.difficulty, 'mixed');
  assert.equal(g.json.minutes, 5);
  // Sayfa yenilenince açık oyun geri gelir
  const resume = await hc(srv, me, 'start', { mode: 'free' });
  assert.equal(resume.json.gameId, g.json.gameId);
  assert.equal(resume.json.status, 'playing');
});
