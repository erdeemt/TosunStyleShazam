// Güvenlik regresyonu (👁️ Algıla REST API): gösterim bitmeden cevabı geri yollayıp tam puan alma, günün
// uyaranlarını cevap vermeden toplama, başkasının oyununa cevap yazma ve büyük gövdeyle sunucuyu yorma engelli.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-09';
let srv;
// timeScale 1 = gerçek süreler (say 2 sn)
before(async () => { srv = await startServer({ env: { FAKE_TODAY: DAY }, timeScale: 1 }); });
after(async () => { await srv.stop(); });

async function post(path, body) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
const identity = async (name) => (await post('/api/identity', { name })).json;
const api = (ep, body) => post(`/api/perceptle/${ep}`, body);

test('gösterim bitmeden gelen cevap reddedilir ve testi tüketmez', async () => {
  const me = await identity('Hileci');
  const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 });
  assert.equal(r.status, 200);
  for (let k = 0; k < 5; k++) {
    const s = await api('submit', { ...me, mode: 'daily', gameId: DAY, index: 0, answer: r.json.stimulus.dots.length });
    assert.equal(s.status, 400, 'erken cevap kabul edildi');
  }
  const st = await api('start', { ...me, mode: 'daily' });
  assert.equal(st.json.played.length, 0);
});

test('cevapsız testten sonra hiçbir sonraki uyaran alınamaz', async () => {
  const me = await identity('Toplayıcı');
  assert.equal((await api('test', { ...me, mode: 'daily', gameId: DAY, index: 0 })).status, 200);
  for (const index of [1, 2, 3, 4]) {
    const r = await api('test', { ...me, mode: 'daily', gameId: DAY, index });
    assert.equal(r.status, 400);
    assert.equal(r.json.stimulus, undefined);
  }
  const lb = await api('leaderboard', me);
  assert.ok(!/dots|bpm|target|Salt/i.test(JSON.stringify(lb.json)));
});

test('başkasının sınırsız oyununa cevap yazılamaz; büyük gövde reddedilir', async () => {
  const a = await identity('A');
  const b = await identity('B');
  const g = (await api('start', { ...a, mode: 'free' })).json;
  await api('test', { ...a, mode: 'free', gameId: g.gameId, index: 0 });
  const s = await api('submit', { ...b, mode: 'free', gameId: g.gameId, index: 0, answer: 50 });
  assert.equal(s.status, 400);
  const big = await post('/api/perceptle/submit', JSON.stringify({ ...a, mode: 'free', gameId: g.gameId, index: 0, answer: Array(40).fill(1e300.toString().repeat(3)) }));
  assert.equal(big.status, 400);
});
