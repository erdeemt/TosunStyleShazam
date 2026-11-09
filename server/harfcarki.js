// 🔤 Harf Çarkı — sunucu: ipucu bankası, çark kurma, oyun (run) durumu, tek oyunculu uçlar (Günlük + Sınırsız).
// Lobili sürüm: server/games/harfcarki.js (aynı run fonksiyonlarını kullanır). Kurallar: PLAN.md §4.13.
// Güvenlik: cevaplar ve alt biçimleri oyun bitene kadar hiçbir yanıtta yok; istemci sadece o anki ipucunu görür,
// cevap sunucuda kontrol edilir, saat sunucudadır.
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRng, cryptoRng, seedFrom } from './rng.js';
import { GameError, num, str } from './errors.js';
import { jsonStore } from './store.js';
import { CATEGORIES, LETTERS, checkAnswer, compact, fold, rivalIndex } from './harfcarki-text.js';
import { isFreshAccount, rankDaily, todayIstanbul } from './wordle.js';

export { todayIstanbul };

const BANK = JSON.parse(readFileSync(new URL('../content/harfcarki/clues.json', import.meta.url), 'utf8')).clues;
export const BY_ID = new Map(BANK.map((c) => [c.id, c]));
const BY_LETTER = new Map(LETTERS.map((L) => [L, BANK.filter((c) => c.letter === L)]));
const RIVALS = rivalIndex(BANK);

// Çark kurarken "ipucu başka bir harfin cevabını ele veriyor" kontrolü için önceden hesaplanan biçimler.
const META = new Map(BANK.map((c) => [c.id, {
  key: compact(c.answer),
  clueText: ` ${fold(c.clue)} `,
  names: [...new Set([c.answer, ...c.alt].map(fold).filter((f) => f.replace(/ /g, '').length >= 4))],
}]));

// Süre ölçeği sadece test sunucusunda (TEST_MODE=1): üretimde yanlışlıkla bırakılırsa süreler değişmesin.
const TIME_SCALE = process.env.TEST_MODE === '1' && Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1;
const scaled = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

export const MINUTE_OPTIONS = [3, 5, 7];
export const DIFFICULTIES = { easy: 'Kolay', mixed: 'Karışık', hard: 'Zor' };
export const DAILY_MINUTES = 5;
export const GRACE_MS = 1500; // süre dolduktan sonra ağ payı (son cevap yoldaysa sayılır)
const MAX_TYPED = 40;
const MAX_MOVES = 600; // oyun başına (pas döngüsü dahil); fazlası reddedilir

// ---------- Çark kurma ----------

// Zorluk planı: 28 harfin kaçı 1/2/3 zorlukta olsun.
const DIFF_PLANS = {
  easy: { 1: 22, 2: 6, 3: 0 },
  mixed: { 1: 13, 2: 11, 3: 4 },
  hard: { 1: 4, 2: 14, 3: 10 },
};
const CAT_CAP = { genel: 10 }; // diğer kategoriler en fazla 4
const capOf = (cat) => CAT_CAP[cat] ?? 4;
const CONTAINS_MAX = 3; // "… harfini içerir" ipucu bir çarkta en fazla

// İki ipucu aynı çarkta olamaz mı? Aynı cevap ya da birinin ipucu diğerinin cevabını içeriyor.
function clash(a, b) {
  const ma = META.get(a.id), mb = META.get(b.id);
  if (ma.key === mb.key) return true;
  return ma.names.some((n) => mb.clueText.includes(` ${n} `)) || mb.names.some((n) => ma.clueText.includes(` ${n} `));
}

// rng: tohumlu (günlük) ya da kripto (sınırsız/lobi). avoid: kaçınılacak ipucu kimlikleri (yakında görülenler).
export function composeWheel(rng, { difficulty = 'mixed', avoid = new Set() } = {}) {
  const plan = DIFF_PLANS[difficulty] ?? DIFF_PLANS.mixed;
  const levels = rng.shuffle(Object.entries(plan).flatMap(([d, n]) => Array(n).fill(Number(d))));
  const order = rng.shuffle(LETTERS.map((L, i) => i));
  const chosen = Array(LETTERS.length).fill(null);
  const cats = {};
  let contains = 0;
  order.forEach((idx, k) => {
    const L = LETTERS[idx];
    const want = levels[k];
    const picked = chosen.filter(Boolean);
    const free = (c) => !picked.some((p) => clash(c, p));
    const tiers = [
      (c) => c.difficulty === want && !avoid.has(c.id) && (cats[c.category] ?? 0) < capOf(c.category) && (c.mode === 'starts' || contains < CONTAINS_MAX),
      (c) => Math.abs(c.difficulty - want) <= 1 && !avoid.has(c.id) && (cats[c.category] ?? 0) < capOf(c.category) && (c.mode === 'starts' || contains < CONTAINS_MAX),
      (c) => Math.abs(c.difficulty - want) <= 1 && !avoid.has(c.id),
      (c) => !avoid.has(c.id),
      () => true,
    ];
    const all = BY_LETTER.get(L);
    let pool = [];
    for (const t of tiers) { pool = all.filter((c) => t(c) && free(c)); if (pool.length) break; }
    if (!pool.length) pool = all; // olmaz ama çark eksik kalmasın
    const c = rng.pick(pool);
    chosen[idx] = c;
    cats[c.category] = (cats[c.category] ?? 0) + 1;
    if (c.mode === 'contains') contains++;
  });
  return chosen.map((c) => c.id);
}

// ---------- Oyun (run) durumu: tek oyunculu ve lobi ortak ----------
// states[i]: 'todo' | 'pass' | 'ok' | 'bad'

export function newRun(ids, startAt, durationMs) {
  return {
    ids,
    states: ids.map(() => 'todo'),
    typed: ids.map(() => null),
    pos: 0,
    moves: 0,
    startAt,
    endsAt: startAt + durationMs,
    done: false,
    finishedAt: null,
    reason: null, // 'all' | 'time' | 'quit' | 'left'
  };
}

const open = (s) => s === 'todo' || s === 'pass';

// Sıradaki harf: ilk turda ileri, sonra paslananlar çark sırasıyla geri gelir. Yoksa -1.
function nextPos(run, from) {
  const n = run.states.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (open(run.states[i])) return i;
  }
  return -1;
}

export function finishRun(run, reason, at) {
  if (run.done) return;
  run.done = true;
  run.reason = reason;
  run.finishedAt = Math.min(at, run.endsAt);
}

// Süre dolduysa (ağ payıyla) bitir. Döner: bitti mi.
export function expireRun(run, now, grace = scaled(GRACE_MS)) {
  if (!run.done && now > run.endsAt + grace) finishRun(run, 'time', run.endsAt);
  return run.done;
}

// Hamle: kind 'answer' | 'pass' | 'quit'. pos istemcinin gördüğü harf (eski/çift gönderim ayıklanır).
// Döner: { pos, result: 'ok'|'bad'|'pass'|'quit' }.
export function applyMove(run, { pos, kind, answer }, now, { grace = scaled(GRACE_MS), early = 0 } = {}) {
  if (expireRun(run, now, grace)) throw new GameError('Süre doldu.');
  if (run.done) throw new GameError('Bu oyun bitti.');
  if (now < run.startAt - early) throw new GameError('Oyun henüz başlamadı.');
  if (++run.moves > MAX_MOVES) throw new GameError('Çok fazla hamle.');
  if (kind === 'quit') { finishRun(run, 'quit', now); return { pos: run.pos, result: 'quit' }; }
  if (num(pos) !== run.pos) throw new GameError('Bu harf geçildi, ekran yenileniyor.');
  let result;
  if (kind === 'pass') {
    result = 'pass';
    run.states[run.pos] = 'pass';
  } else if (kind === 'answer') {
    const text = str(answer).trim().slice(0, MAX_TYPED);
    if (!compact(text)) throw new GameError('Bir cevap yaz ya da pas geç.');
    const clue = BY_ID.get(run.ids[run.pos]);
    result = checkAnswer(clue, text, RIVALS).ok ? 'ok' : 'bad';
    run.states[run.pos] = result;
    run.typed[run.pos] = text;
  } else throw new GameError('Bilinmeyen hamle.');
  const at = run.pos;
  const next = nextPos(run, run.pos);
  if (next < 0) finishRun(run, 'all', now);
  else run.pos = next;
  return { pos: at, result };
}

export function summarize(run) {
  const count = (s) => run.states.filter((x) => x === s).length;
  const correct = count('ok');
  const wrong = count('bad');
  const passed = run.states.length - correct - wrong;
  const durationMs = run.done ? Math.max(0, run.finishedAt - run.startAt) : null;
  // Küçük süre ödülü: bütün harfler süre bitmeden cevaplandıysa kalan her 20 sn'ye 1 puan, en fazla 9 (bir doğrudan az).
  const total = run.endsAt - run.startAt;
  const leftSec = run.reason === 'all' ? Math.max(0, (total - durationMs) / TIME_SCALE / 1000) : 0;
  const bonus = Math.min(9, Math.floor(leftSec / 20));
  return { correct, wrong, passed, durationMs, bonus, points: correct * 10 + bonus };
}

// Sıralama karşılaştırıcısı: doğru ↓, yanlış ↑, süre ↑.
export const rankCmp = (a, b) => b.correct - a.correct || a.wrong - b.wrong || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity);

// İstemciye giden görünüm. Cevaplar SADECE oyun bitince (reveal) eklenir.
export function publicRun(run, { reveal = true } = {}) {
  const cur = !run.done ? BY_ID.get(run.ids[run.pos]) : null;
  return {
    letters: run.ids.map((id, i) => ({ letter: BY_ID.get(id).letter, state: run.states[i] })),
    current: cur ? {
      pos: run.pos,
      letter: cur.letter,
      mode: cur.mode,
      clue: cur.clue,
      category: CATEGORIES[cur.category],
      lap: run.states[run.pos] === 'pass' ? 2 : 1,
    } : null,
    startAt: run.startAt,
    endsAt: run.endsAt,
    done: run.done,
    reason: run.done ? run.reason : null,
    summary: summarize(run),
    recap: run.done && reveal ? recapOf(run) : null,
  };
}

export function recapOf(run) {
  return run.ids.map((id, i) => {
    const c = BY_ID.get(id);
    return { letter: c.letter, mode: c.mode, clue: c.clue, answer: c.answer, typed: run.typed[i], state: run.states[i] };
  });
}

// ---------- Görülen ipuçları (sınırsız + lobi tekrar önleme) ----------

const MAX_SEEN = 1200; // kimlik başına son ~40 çark
const MAX_SEEN_PLAYERS = 5000;
const seenStore = jsonStore('harfcarki-seen', {}); // { playerId: [clueId…] }

export const seenOf = (playerId) => seenStore.data[playerId] ?? [];

export function markSeen(playerIds, ids) {
  for (const pid of playerIds) {
    const list = (seenStore.data[pid] ?? []).filter((x) => !ids.includes(x));
    list.push(...ids);
    seenStore.data[pid] = list.slice(-MAX_SEEN);
  }
  const keys = Object.keys(seenStore.data);
  if (keys.length > MAX_SEEN_PLAYERS) for (const k of keys.slice(0, keys.length - MAX_SEEN_PLAYERS)) delete seenStore.data[k];
  seenStore.save();
}

// ---------- Günlük ----------

const EPOCH = '2026-11-09'; // 1 numaralı günlük çark
const secrets = jsonStore('secrets', {});
if (!secrets.data.harfcarkiSalt) { secrets.data.harfcarkiSalt = randomBytes(16).toString('hex'); secrets.flushNow(); }
const SALT = process.env.HARFCARKI_SALT || secrets.data.harfcarkiSalt;

const identityStore = jsonStore('identities', {});
const days = jsonStore('harfcarki-days', {}); // { date: [clueId×28] } gün ilk istendiğinde sabitlenir
const daily = jsonStore('harfcarki-daily', {}); // { date: { playerId: { name, run } } }
const KEEP_DAYS = 45;

export const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);

// Gizli tuzla tohumlanır (repo açık: çark koddan hesaplanamasın); günün içinde banka değişse de sabit kalır.
export function dailyWheel(date) {
  if (!days.data[date]) {
    days.data[date] = composeWheel(createRng(seedFrom(`harfcarki-v1:${SALT}:${date}`)), { difficulty: 'mixed' });
    pruneDays();
    days.save();
  }
  return days.data[date].filter((id) => BY_ID.has(id)).length === LETTERS.length
    ? days.data[date]
    : composeWheel(createRng(seedFrom(`harfcarki-v1:${SALT}:${date}`)), { difficulty: 'mixed' });
}

function pruneDays() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const store of [days, daily]) for (const d of Object.keys(store.data)) if (d < cutoff) delete store.data[d];
}

const lettersOnly = () => LETTERS.map((letter) => ({ letter, state: 'todo' }));

function dailyView(date, entry) {
  const base = { mode: 'daily', gameId: date, puzzleNo: dayIndex(date) + 1, minutes: DAILY_MINUTES, difficulty: 'mixed', timeScale: TIME_SCALE, serverNow: Date.now() };
  if (!entry) return { ...base, status: 'ready', letters: lettersOnly() };
  expireRun(entry.run, Date.now());
  return { ...base, status: entry.run.done ? 'done' : 'playing', ...publicRun(entry.run) };
}

// ---------- Sınırsız ----------

const FREE_TTL_MS = 2 * 3600_000;
const MAX_FREE_GAMES = 5000;
const freeGames = new Map(); // gameId -> { playerId, run, difficulty, minutes, createdAt }

function freeView(id, g) {
  expireRun(g.run, Date.now());
  return { mode: 'free', gameId: id, minutes: g.minutes, difficulty: g.difficulty, timeScale: TIME_SCALE, serverNow: Date.now(), status: g.run.done ? 'done' : 'playing', ...publicRun(g.run) };
}

function pruneFree(force = false) {
  const cutoff = Date.now() - FREE_TTL_MS;
  for (const [id, g] of freeGames) if (g.createdAt < cutoff) freeGames.delete(id);
  if (force && freeGames.size >= MAX_FREE_GAMES) {
    let n = Math.ceil(freeGames.size / 2);
    for (const id of freeGames.keys()) { if (n-- <= 0) break; freeGames.delete(id); }
  }
}
setInterval(() => pruneFree(), 600_000).unref();

// ---------- HTTP uçları (server.js; kimlik doğrulanmış gelir) ----------

export const cleanDifficulty = (d) => (Object.hasOwn(DIFFICULTIES, d) ? d : 'mixed');
export const cleanMinutes = (m) => (MINUTE_OPTIONS.includes(Number(m)) ? Number(m) : 5);

// Sayfa açılışı: günlükte mevcut durum (hazır / sürüyor / bitti); serbestte açık oyun varsa onu döner.
export function startGame(identity, mode) {
  if (mode === 'free') {
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id && !expireRun(g.run, Date.now()));
    const last = mine.at(-1);
    return last ? freeView(...last) : { mode: 'free', status: 'ready', letters: lettersOnly(), timeScale: TIME_SCALE, serverNow: Date.now() };
  }
  const date = todayIstanbul();
  return dailyView(date, daily.data[date]?.[identity.id]);
}

// Saati başlatır. Günlük: kimlik başına tek deneme (başlamışsa kaldığı yerden döner).
export function beginGame(identity, mode, opts = {}) {
  const now = Date.now();
  if (mode === 'free') {
    if (freeGames.size >= MAX_FREE_GAMES) pruneFree(true);
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - 2))) freeGames.delete(oldId); // kişi başına en fazla 3
    const difficulty = cleanDifficulty(opts.difficulty);
    const minutes = cleanMinutes(opts.minutes);
    const ids = composeWheel(cryptoRng(), { difficulty, avoid: new Set(seenOf(identity.id)) });
    markSeen([identity.id], ids);
    const id = randomUUID();
    const g = { playerId: identity.id, run: newRun(ids, now, scaled(minutes * 60_000)), difficulty, minutes, createdAt: now };
    freeGames.set(id, g);
    return freeView(id, g);
  }
  const date = todayIstanbul();
  const day = (daily.data[date] ??= {});
  if (!day[identity.id]) {
    day[identity.id] = { name: identity.name ?? 'Oyuncu', run: newRun(dailyWheel(date), now, scaled(DAILY_MINUTES * 60_000)) };
    daily.save();
  }
  return dailyView(date, day[identity.id]);
}

export function move(identity, mode, gameId, body) {
  const now = Date.now();
  const m = { pos: body.pos, kind: str(body.kind), answer: body.answer };
  if (mode === 'free') {
    const g = freeGames.get(str(gameId));
    if (!g || g.playerId !== identity.id) throw new GameError('Oyun bulunamadı, yeni çark başlat.');
    const last = applyMoveSafe(g.run, m, now);
    return { ...freeView(str(gameId), g), last };
  }
  const date = todayIstanbul();
  if (str(gameId) !== date) throw new GameError('Günün çarkı değişti, sayfayı yenile.');
  const entry = daily.data[date]?.[identity.id];
  if (!entry) throw new GameError('Önce oyunu başlat.');
  entry.name = identity.name ?? entry.name;
  const last = applyMoveSafe(entry.run, m, now);
  daily.save();
  return { ...dailyView(date, entry), last };
}

// Süre dolmuş ya da bitmiş oyunda hamle hata yerine "bitti" görünümü döndürsün (istemci sonucu göstersin).
function applyMoveSafe(run, m, now) {
  if (expireRun(run, now) || run.done) return null;
  return applyMove(run, m, now);
}

// Sıralama: bitirenler; harf renkleri sadece sen bitirdiysen (cevaplar hiç yok).
export function leaderboard(date, viewerId) {
  const day = daily.data[date] ?? {};
  const now = Date.now();
  let changed = false;
  for (const e of Object.values(day)) if (!e.run.done && expireRun(e.run, now)) changed = true;
  if (changed) daily.save();
  const viewerDone = Boolean(day[viewerId]?.run.done);
  return {
    date,
    puzzleNo: dayIndex(date) + 1,
    entries: rankDaily(Object.entries(day)
      .filter(([, e]) => e.run.done)
      .map(([id, e]) => ({
        name: e.name,
        me: id === viewerId,
        fresh: isFreshAccount(identityStore.data[id], date),
        ...summarize(e.run),
        grid: viewerDone ? e.run.states : null,
      })), rankCmp, 50),
    playing: Object.values(day).filter((e) => !e.run.done).length,
  };
}

export const stats = () => ({ clues: BANK.length, freeGames: freeGames.size });

// Sadece testler (TEST_GAMES=1 + TEST_MODE=1, server.js): günün / serbest oyunun cevapları.
export function _testSecrets(gameId) {
  const free = freeGames.get(str(gameId));
  const ids = free ? free.run.ids : dailyWheel(str(gameId));
  return { ids, answers: ids.map((id) => BY_ID.get(id).answer), alts: ids.map((id) => BY_ID.get(id).alt) };
}
export const _bank = BANK;
