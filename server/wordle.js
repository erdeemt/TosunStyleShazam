// 🟩 Wordle TR — sunucu tarafı. Kurallar: PLAN.md §4.2, günlük sıralama: §3.6.
// Cevap istemciye oyun bitene kadar gitmez; her tahmin burada değerlendirilir.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRng, seedFrom } from './rng.js';
import { GameError, str } from './errors.js';
import { jsonStore } from './store.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../content/wordle/${name}.json`, import.meta.url), 'utf8'));
const ANSWERS = read('answers');
const VALID = new Set(read('valid'));
for (const w of ANSWERS) VALID.add(w);

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;
const EPOCH = '2026-10-22'; // 1 numaralı günlük bulmaca
const DAILY_ORDER = createRng(seedFrom('tosun-wordle-v1')).shuffle(ANSWERS);
const FREE_TTL_MS = 6 * 3600_000;
const MAX_FREE_GAMES = 5000;

const daily = jsonStore('wordle-daily', {}); // { 'YYYY-MM-DD': { playerId: { name, guesses: [{ word, marks }], done, won, finishedAt } } }
const freeGames = new Map(); // gameId -> { playerId, answer, guesses, done, won, createdAt }

// ---------- Kelime işlemleri ----------

const FOLD = { â: 'a', î: 'i', û: 'u' };

export function normalizeWord(raw) {
  return str(raw).trim().toLocaleLowerCase('tr').normalize('NFC').replace(/[âîû]/g, (c) => FOLD[c]);
}

// NYT kuralları: önce yeşiller, sonra kalan harf sayısına göre sarılar.
export function score(guess, answer) {
  const g = [...guess];
  const a = [...answer];
  const marks = Array(g.length).fill('absent');
  const left = {};
  for (let i = 0; i < a.length; i++) {
    if (g[i] === a[i]) marks[i] = 'correct';
    else left[a[i]] = (left[a[i]] ?? 0) + 1;
  }
  for (let i = 0; i < g.length; i++) {
    if (marks[i] === 'correct') continue;
    if (left[g[i]] > 0) { marks[i] = 'present'; left[g[i]]--; }
  }
  return marks;
}

function checkGuess(raw) {
  const word = normalizeWord(raw);
  if ([...word].length !== WORD_LENGTH) throw new GameError(`${WORD_LENGTH} harfli bir kelime yaz.`);
  if (!VALID.has(word)) throw new GameError('Sözlükte yok.');
  return word;
}

// ---------- Günlük bulmaca ----------

export function todayIstanbul(now = new Date()) {
  // Sadece testlerde: günü taklit et (gece yarısı geçişi, farklı günler).
  if (process.env.TEST_GAMES === '1' && process.env.FAKE_TODAY) return process.env.FAKE_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function dayIndex(date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);
}

// Sadece sunucu içi ve testler için (istemciye hiçbir uçtan gönderilmez).
export function dailyAnswer(date) {
  const idx = dayIndex(date);
  return DAILY_ORDER[((idx % DAILY_ORDER.length) + DAILY_ORDER.length) % DAILY_ORDER.length];
}

function publicGame(entry, { reveal }) {
  return {
    guesses: entry.guesses,
    done: entry.done,
    won: entry.won,
    answer: entry.done && reveal ? reveal : undefined,
  };
}

function dailyEntry(date, identity, create) {
  const day = (daily.data[date] ??= {});
  if (!day[identity.id] && create) {
    day[identity.id] = { name: identity.name ?? 'Oyuncu', guesses: [], done: false, won: false, finishedAt: null };
  }
  return day[identity.id];
}

// ---------- HTTP uçları (server.js çağırır; identity doğrulanmış gelir) ----------

export function startGame(identity, mode) {
  if (mode === 'free') {
    if (freeGames.size >= MAX_FREE_GAMES) pruneFree(true);
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - 2))) freeGames.delete(oldId); // oyuncu başına en fazla 3
    const id = randomUUID();
    freeGames.set(id, {
      playerId: identity.id,
      answer: ANSWERS[Math.floor(Math.random() * ANSWERS.length)],
      guesses: [],
      done: false,
      won: false,
      createdAt: Date.now(),
    });
    return { mode, gameId: id, length: WORD_LENGTH, maxGuesses: MAX_GUESSES, guesses: [], done: false, won: false };
  }
  const date = todayIstanbul();
  const entry = dailyEntry(date, identity, false);
  const answer = dailyAnswer(date);
  return {
    mode: 'daily',
    gameId: date,
    puzzleNo: dayIndex(date) + 1,
    length: WORD_LENGTH,
    maxGuesses: MAX_GUESSES,
    ...(entry ? publicGame(entry, { reveal: answer }) : { guesses: [], done: false, won: false }),
  };
}

export function guess(identity, mode, gameId, rawWord) {
  if (mode === 'free') {
    const game = freeGames.get(str(gameId));
    if (!game || game.playerId !== identity.id) throw new GameError('Oyun bulunamadı, yeni oyun başlat.');
    if (game.done) throw new GameError('Bu oyun bitti.');
    const word = checkGuess(rawWord);
    const marks = score(word, game.answer);
    game.guesses.push({ word, marks });
    game.won = word === game.answer;
    game.done = game.won || game.guesses.length >= MAX_GUESSES;
    return publicGame(game, { reveal: game.answer });
  }

  // Günlük: sadece bugünün bulmacası oynanabilir (gece yarısı değişince eski oyun kapanır).
  const date = todayIstanbul();
  if (str(gameId) !== date) throw new GameError('Günün bulmacası değişti, sayfayı yenile.');
  const entry = dailyEntry(date, identity, true);
  if (entry.done) throw new GameError('Bugünkü bulmacayı bitirdin. Yarın yeni kelime!');
  const word = checkGuess(rawWord);
  const answer = dailyAnswer(date);
  const marks = score(word, answer);
  entry.name = identity.name ?? 'Oyuncu';
  entry.guesses.push({ word, marks });
  entry.won = word === answer;
  entry.done = entry.won || entry.guesses.length >= MAX_GUESSES;
  if (entry.done) entry.finishedAt = Date.now();
  daily.save();
  return publicGame(entry, { reveal: answer });
}

// Sıralama: kelimeler değil sadece renkler görünür (bitirmeyenlerin ilerlemesi de gizli).
export function leaderboard(date, viewerId) {
  const day = daily.data[date] ?? {};
  const viewerDone = Boolean(day[viewerId]?.done);
  return {
    date,
    puzzleNo: dayIndex(date) + 1,
    entries: Object.entries(day)
      .filter(([, e]) => e.done)
      .map(([id, e]) => ({
        name: e.name,
        me: id === viewerId,
        won: e.won,
        tries: e.won ? e.guesses.length : null,
        finishedAt: e.finishedAt,
        // Bulmacayı bitirmemiş biri başkalarının renk desenlerinden ipucu almasın.
        grid: viewerDone ? e.guesses.map((g) => g.marks) : null,
      }))
      .sort((a, b) => (a.won === b.won ? (a.tries ?? 99) - (b.tries ?? 99) || a.finishedAt - b.finishedAt : a.won ? -1 : 1)),
    playing: Object.values(day).filter((e) => !e.done && e.guesses.length).length,
  };
}

function pruneFree(force = false) {
  const cutoff = Date.now() - FREE_TTL_MS;
  for (const [id, g] of freeGames) if (g.createdAt < cutoff) freeGames.delete(id);
  // Hâlâ doluysa en eski yarıyı at (Map ekleme sırasını korur).
  if (force && freeGames.size >= MAX_FREE_GAMES) {
    let n = Math.ceil(freeGames.size / 2);
    for (const id of freeGames.keys()) { if (n-- <= 0) break; freeGames.delete(id); }
  }
}
setInterval(() => pruneFree(), 600_000).unref();

export const stats = () => ({ answers: ANSWERS.length, valid: VALID.size, freeGames: freeGames.size });
