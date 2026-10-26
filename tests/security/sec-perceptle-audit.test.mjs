// Güvenlik denetimi (👁️ Algıla):
// 1) KABUL EDİLEN SINIR: günlük uyaranlar herkes için aynı (Wordle gibi, adil karşılaştırma); yan hesapla önizleme mümkün.
// 2) DÜZELTİLDİ: günlük uyaranlar gün başına bir kez üretilip önbellekte tutulur; sıralama maliyeti bekleyenlerle büyümez.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-09'; // Pazartesi (Cuma değil)
let srv;
before(async () => { srv = await startServer({ env: { FAKE_TODAY: DAY }, timeScale: 0.05 }); });
after(async () => { await srv.stop(); });

async function post(path, body) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
const identity = async (name) => (await post('/api/identity', { name })).json;
const api = (ep, body) => post(`/api/perceptle/${ep}`, body);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function playAll(me, answerOf) {
  let last;
  for (let index = 0; index < 5; index++) {
    const t = await api('test', { ...me, mode: 'daily', gameId: DAY, index });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    await wait(t.json.showMs + 30);
    last = await api('submit', { ...me, mode: 'daily', gameId: DAY, index, answer: answerOf(t.json, index) });
    assert.equal(last.status, 200, JSON.stringify(last.json));
  }
  return last.json;
}

test('KABUL EDİLEN SINIR: yan hesap günün tüm doğrularını öğrenir, ana hesap neredeyse tam puan alır', async () => {
  const alt = await identity('Yan');
  const garbage = (t) => (t.test === 'tempo' ? [] : 0);
  const preview = await playAll(alt, garbage);
  const truths = preview.played.map((p) => p.truth);
  const main = await identity('Ana');
  const res = await playAll(main, (t, i) => {
    if (t.test !== 'tempo') return truths[i];
    const I = 60_000 / truths[i];
    return Array.from({ length: 8 }, (_, j) => I * (4 + j) * t.timeScale);
  });
  assert.ok(res.total >= 95, `toplam ${res.total}`);
});

test('sıralama maliyeti bekleyen (cevaplanmamış Say testi) oyuncu sayısıyla büyümez', async () => {
  const me = await identity('Ölçen');
  const time = async () => {
    const s = performance.now();
    for (let k = 0; k < 5; k++) await api('leaderboard', me);
    return (performance.now() - s) / 5;
  };
  const base = await time();
  // Ayrı sunucu yok: aynı günde 60 kimlik Say testini başlatıp bırakır (pencere 90 sn × 0.05 ölçek ≈ 4.5 sn açık kalır)
  const ids = await Promise.all(Array.from({ length: 60 }, (_, k) => identity(`B${k}`)));
  await Promise.all(ids.map((id) => api('test', { ...id, mode: 'daily', gameId: DAY, index: 0 })));
  const loaded = await time();
  console.log(`sıralama: boş ${base.toFixed(1)} ms, 60 bekleyenle ${loaded.toFixed(1)} ms`);
  assert.ok(loaded < base + 60, `sıralama yavaşladı (${base} → ${loaded})`);
});
