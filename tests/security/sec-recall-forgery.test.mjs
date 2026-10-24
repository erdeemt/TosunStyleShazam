// Güvenlik regresyonu (hafıza oyunları REST API): hedefi hemen geri yollayıp tam puan alma ve
// günün 5 hedefini cevap vermeden toplama artık engelli.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-08';
let srv;
// timeScale 1 = gerçek süreler (ezber 5 sn, hatırlama 30 sn)
before(async () => { srv = await startServer({ env: { FAKE_TODAY: DAY }, timeScale: 1 }); });
after(async () => { await srv.stop(); });

async function post(path, body) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
const identity = async (name) => (await post('/api/identity', { name })).json;
const api = (game, ep, body) => post(`/api/recall/${game}/${ep}`, body);

test('ezber süresi bitmeden gelen cevap reddedilir ve turu tüketmez', async () => {
  for (const game of ['nuance', 'tone']) {
    const me = await identity(`Hile-${game}`);
    await api(game, 'start', { ...me, mode: 'daily' });
    const r = await api(game, 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = await api(game, 'submit', { ...me, mode: 'daily', gameId: DAY, round: 0, guess: r.json.target });
    assert.equal(s.status, 400, 'erken cevap kabul edildi');
    assert.match(s.json.error ?? s.json.message ?? '', /ezber/i);
    const st = await api(game, 'start', { ...me, mode: 'daily' });
    assert.equal(st.json.played.length, 0, 'erken cevap tur olarak sayıldı');
    assert.equal(st.json.pending.round, 0);
    assert.ok(st.json.pending.recallAt > st.json.serverNow, 'pending.recallAt ezber bitişini vermeli');
  }
});

test('önceki tur cevaplanmadan sonraki turun hedefi alınamaz', async () => {
  const me = await identity('Toplayıcı');
  const first = await api('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 0 });
  assert.equal(first.status, 200);
  const second = await api('nuance', 'round', { ...me, mode: 'daily', gameId: DAY, round: 1 });
  assert.equal(second.status, 400, 'cevapsız turdan sonra yeni hedef verildi');
  assert.equal(second.json.target, undefined);
});
