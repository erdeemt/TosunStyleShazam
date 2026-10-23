// Wordle TR HTTP uçları: cevap sızmaz, günlük tek oynanır, sıralama, kalıcılık, sınırsız mod.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../lib/server.js';

const DAY = '2026-11-05';
process.env.TEST_GAMES = '1';
process.env.WORDLE_SALT = 'test-salt'; // tests/lib/server.js ile aynı
process.env.FAKE_TODAY = DAY;
const { dailyAnswer } = await import('../../server/wordle.js');
const ANSWER = dailyAnswer(DAY);
const VALID = JSON.parse(readFileSync(new URL('../../content/wordle/valid.json', import.meta.url)));
const WRONG = VALID.filter((w) => w !== ANSWER).slice(100, 110);

let srv;
const env = { FAKE_TODAY: DAY };
before(async () => { srv = await startServer({ env }); });
after(async () => { await srv.stop(); });

async function post(path, body, { raw } = {}) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json, text: JSON.stringify(json) };
}

async function identity(name) {
  return (await post('/api/identity', { name })).json;
}

test('kimlik oluşur, aynı token ile korunur, yanlış token reddedilir', async () => {
  const a = await identity('Ayşe');
  assert.ok(a.playerId && a.token && a.name === 'Ayşe');
  const again = (await post('/api/identity', { playerId: a.playerId, token: a.token })).json;
  assert.equal(again.playerId, a.playerId);
  const bad = await post('/api/wordle/start', { playerId: a.playerId, token: 'yanlis' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Kimlik/);
});

test('günlük: cevap sızmaz, geçersiz kelime hak yemez, kayıp sonunda cevap açılır, tekrar oynanmaz', async () => {
  const me = await identity('Mert');
  const start = await post('/api/wordle/start', { ...me, mode: 'daily' });
  assert.equal(start.json.gameId, DAY);
  assert.ok(!start.text.includes(ANSWER), 'başlangıç yanıtında cevap var');

  const invalid = await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: DAY, word: 'qqqqq' });
  assert.equal(invalid.status, 400);
  const short = await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: DAY, word: 'kal' });
  assert.match(short.json.error, /5 harfli/);

  for (let i = 0; i < 6; i++) {
    const r = await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: DAY, word: WRONG[i].toLocaleUpperCase('tr') });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.guesses.length, i + 1, 'geçersiz tahminler sayılmamalı');
    if (i < 5) assert.ok(!r.text.includes(`"${ANSWER}"`), 'bitmeden cevap sızdı');
    else { assert.equal(r.json.done, true); assert.equal(r.json.answer, ANSWER); }
  }
  const seventh = await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: DAY, word: WRONG[6] });
  assert.match(seventh.json.error, /bitirdin/);
  // yeniden başlatınca ilerleme geri gelir
  const resume = await post('/api/wordle/start', { ...me, mode: 'daily' });
  assert.equal(resume.json.guesses.length, 6);
  assert.equal(resume.json.done, true);
});

test('günlük: kazanma, sıralama; bitirmeyen kişi başkalarının desenini göremez', async () => {
  const winner = await identity('Kazanan');
  await post('/api/wordle/guess', { ...winner, mode: 'daily', gameId: DAY, word: WRONG[0] });
  const win = await post('/api/wordle/guess', { ...winner, mode: 'daily', gameId: DAY, word: ANSWER });
  assert.equal(win.json.won, true);

  const lb = (await post('/api/wordle/leaderboard', winner)).json;
  const top = lb.entries[0];
  assert.equal(top.name, 'Kazanan');
  assert.equal(top.tries, 2);
  assert.ok(top.grid, 'bitiren kişi desenleri görmeli');
  assert.ok(!JSON.stringify(lb).includes(WRONG[0]), 'sıralamada kelimeler görünmemeli');

  const newbie = await identity('Yeni');
  const lb2 = (await post('/api/wordle/leaderboard', newbie)).json;
  assert.ok(lb2.entries.every((e) => e.grid === null), 'bitirmeyen kişi desenleri görmemeli');
  assert.ok(!JSON.stringify(lb2).includes(ANSWER));
});

test('eski günün bulmacası oynanamaz', async () => {
  const me = await identity('Dünkü');
  const r = await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: '2026-11-04', word: WRONG[0] });
  assert.match(r.json.error, /değişti/);
});

test('sınırsız mod: başkasının oyununa tahmin yapılamaz; kayıpta cevap açılır', async () => {
  const a = await identity('A');
  const b = await identity('B');
  const game = (await post('/api/wordle/start', { ...a, mode: 'free' })).json;
  assert.ok(game.gameId);
  assert.ok(!JSON.stringify(game).includes('answer'));
  const steal = await post('/api/wordle/guess', { ...b, mode: 'free', gameId: game.gameId, word: WRONG[0] });
  assert.match(steal.json.error, /bulunamadı/);
  let last;
  for (let i = 0; i < 6; i++) last = (await post('/api/wordle/guess', { ...a, mode: 'free', gameId: game.gameId, word: VALID[2000 + i] })).json;
  assert.equal(last.done, true);
  if (!last.won) assert.equal([...last.answer].length, 5);
});

test('büyük gövde, bozuk JSON, GET reddedilir', async () => {
  assert.equal((await post('/api/identity', null, { raw: JSON.stringify({ name: 'x'.repeat(5000) }) })).status, 400);
  assert.equal((await post('/api/identity', null, { raw: '{bozuk' })).status, 400);
  assert.equal((await post('/api/identity', null, { raw: '[1,2]' })).status, 400);
  const get = await fetch(`${srv.url}/api/wordle/start`);
  assert.equal(get.status, 400);
});

test('sunucu yeniden başlayınca kimlik ve günlük ilerleme korunur', async () => {
  const me = await identity('Kalıcı');
  await post('/api/wordle/guess', { ...me, mode: 'daily', gameId: DAY, word: WRONG[3] });
  await new Promise((r) => setTimeout(r, 700)); // gecikmeli yazma
  await srv.stop();
  srv = await startServer({ env, dataDir: srv.dataDir });
  const resume = await post('/api/wordle/start', { ...me, mode: 'daily' });
  assert.equal(resume.status, 200, resume.text);
  assert.equal(resume.json.guesses.length, 1);
});
