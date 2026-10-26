// 👁️ Algıla — tek oyunculu günlük algı testi (perceptle.com tarzı). Kurallar: PLAN.md §4.7.
// Beş test sırayla: Say, Yörünge, Açı, Ritim, Böl. Her test 0–100; sonuç 5 testin ortalaması + harf notu.
// Uyaran (nokta konumları, top atışı, hedef açı, tempo, kesir) sadece o test başlarken, bir kez gönderilir;
// önceki test cevaplanmadan sonraki başlatılamaz. Puanı her zaman sunucu hesaplar (public/perceptle-math.js).
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cryptoRng } from './rng.js';
import { GameError, num } from './errors.js';
import { jsonStore } from './store.js';
import { todayIstanbul } from './wordle.js';
import {
  TESTS, TEMPO, SPLIT_RANGE, evaluate, splitLabel, finalScore, gradeOf, makeStimulus, stimulusMs, truthOf,
} from '../public/perceptle-math.js';

const TIME_SCALE = Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1;
const scaled = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

const EPOCH = '2026-10-26'; // 1 numaralı günlük
const ANSWER_MS = 90_000; // uyaran bittikten sonra cevap için bol süre; geçerse test 0 sayılır
const SUBMIT_GRACE_MS = 3000; // ağ gecikmesi payı
const EARLY_SLACK_MS = 150; // saat/ağ farkı payı
const BOARD_LIMIT = 50;
const KEEP_DAYS = 45;
const FREE_TTL_MS = 6 * 3600_000;
const MAX_FREE_GAMES = 5000;
const FREE_PER_PLAYER = 3;

// ---------- Günlük uyaranlar ----------
// Gizli tuz + tarih + test sırası ile HMAC'ten türetilir: bir testin uyaranı açılınca sonrakiler hesaplanamaz.

const secrets = jsonStore('secrets', {});
const identityStore = jsonStore('identities', {}); // lobby.js ile aynı kayıt (sıralamada güncel ad)
if (!secrets.data.perceptleSalt) { secrets.data.perceptleSalt = randomBytes(16).toString('hex'); secrets.flushNow(); }
const SALT = process.env.PERCEPTLE_SALT || secrets.data.perceptleSalt;

function hmacRng(text) {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  const next = () => {
    if (pos + 6 > buf.length) {
      buf = createHmac('sha256', SALT).update(`${text}#${counter++}`).digest();
      pos = 0;
    }
    const v = buf.readUIntBE(pos, 6) / 2 ** 48;
    pos += 6;
    return v;
  };
  return { next };
}

// İstanbul tarihinin haftanın günü (tarih zaten İstanbul günü; öğlen UTC güvenli)
export const isFriday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 5;

export function dailyStimulus(date, index) {
  return makeStimulus(TESTS[index], hmacRng(`tosun-perceptle-v1:${date}:${index}`), isFriday(date));
}

const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);

// ---------- Kayıtlar ----------
// Oyun: { playerId, friday, stimuli? (sadece sınırsız), tests: [{ startedAt, answer, score, error, detail, timedOut }], done, total, finishedAt }

const daily = jsonStore('perceptle-daily', {}); // { date: { playerId: { name, friday, tests, done, total, finishedAt } } }
const freeGames = new Map(); // gameId -> oyun

function pruneDaily() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  let changed = false;
  for (const date of Object.keys(daily.data)) if (date < cutoff) { delete daily.data[date]; changed = true; }
  if (changed) daily.save();
}
pruneDaily();
setInterval(pruneDaily, 6 * 3600_000).unref();

function pruneFree() {
  const cutoff = Date.now() - FREE_TTL_MS;
  for (const [id, g] of freeGames) if (g.createdAt < cutoff) freeGames.delete(id);
}
setInterval(pruneFree, 600_000).unref();

const showMsOf = (index, stim, friday) => scaled(stimulusMs(TESTS[index], stim, friday));
const recallAtOf = (t, index, stim, friday) => t.startedAt + showMsOf(index, stim, friday);
const deadlineOf = (t, index, stim, friday) => recallAtOf(t, index, stim, friday) + scaled(ANSWER_MS);
const graceMs = () => Math.max(250, scaled(SUBMIT_GRACE_MS));

function finishIfDone(game) {
  if (!game.done && game.tests.length >= TESTS.length && game.tests.every((t) => t.answer !== undefined)) {
    game.done = true;
    game.total = finalScore(game.tests.map((t) => t.score));
    game.finishedAt = Date.now();
  }
}

function timeOut(t) {
  t.answer = null;
  t.score = 0;
  t.error = null;
  t.detail = null;
  t.timedOut = true;
}

// Süresi geçmiş, cevaplanmamış test 0 puan olur (sayfayı kapatan oyuncu testi "dondurmasın").
function settle(game, stimOf, now = Date.now()) {
  const i = game.tests.length - 1;
  const last = game.tests[i];
  if (last && last.answer === undefined && now > deadlineOf(last, i, stimOf(i), game.friday) + graceMs()) timeOut(last);
  finishIfDone(game);
}

// Sürerken yenilenen sayfada sadece süresiz uyaranlar (açı, böl: hedef zaten ekranda yazılı) tekrar gönderilir.
const RESENDABLE = new Set(['angle', 'split']);

function publicGame(game, stimOf, extra) {
  const pendingIndex = game.tests.findIndex((t) => t.answer === undefined);
  const played = game.tests.map((t, i) => (t.answer === undefined ? null : {
    index: i,
    test: TESTS[i],
    truth: truthOf(TESTS[i], stimOf(i)),
    label: TESTS[i] === 'split' ? splitLabel(stimOf(i)) : null, // "3/7", "%42"
    answer: t.answer,
    score: t.score,
    error: t.error,
    detail: t.detail ?? null,
    timedOut: Boolean(t.timedOut),
  })).filter(Boolean);
  let pending = null;
  if (pendingIndex >= 0) {
    const t = game.tests[pendingIndex];
    const stim = stimOf(pendingIndex);
    pending = {
      index: pendingIndex,
      test: TESTS[pendingIndex],
      stimulus: RESENDABLE.has(TESTS[pendingIndex]) ? stim : null,
      recallAt: recallAtOf(t, pendingIndex, stim, game.friday),
      endsAt: deadlineOf(t, pendingIndex, stim, game.friday),
    };
  }
  const scores = played.map((p) => p.score);
  return {
    tests: TESTS,
    friday: game.friday,
    played,
    pending,
    serverNow: Date.now(),
    done: game.done,
    total: game.done ? game.total : finalScore(scores),
    grade: game.done ? gradeOf(game.total) : null,
    ...extra,
  };
}

function lookup(identity, mode, rawGameId, create = false) {
  if (mode === 'free') {
    const id = typeof rawGameId === 'string' ? rawGameId : '';
    const game = freeGames.get(id);
    if (!game || game.playerId !== identity.id) throw new GameError('Oyun bulunamadı, yeni oyun başlat.');
    return { game, stimOf: (i) => game.stimuli[i], extra: { mode, gameId: id } };
  }
  const date = todayIstanbul();
  if (rawGameId !== date) throw new GameError('Günün testi değişti, sayfayı yenile.');
  const byDate = (daily.data[date] ??= {});
  if (!byDate[identity.id] && create) {
    byDate[identity.id] = { name: identity.name ?? 'Oyuncu', friday: isFriday(date), tests: [], done: false, total: 0, finishedAt: null };
  }
  // Günlük kayıtta uyaranlar saklanmaz (tarihten yeniden hesaplanır); aynı istek içinde önbellek.
  const cache = new Map();
  const stimOf = (i) => {
    if (!cache.has(i)) cache.set(i, dailyStimulus(date, i));
    return cache.get(i);
  };
  return { game: byDate[identity.id] ?? null, stimOf, extra: { mode, gameId: date, puzzleNo: dayIndex(date) + 1 } };
}

// ---------- Cevap temizliği ----------

function cleanAnswer(test, raw, friday) {
  if (test === 'tempo') {
    if (!Array.isArray(raw) || raw.length > TEMPO.maxTaps) throw new GameError('Geçersiz cevap.');
    const taps = raw.map((v) => {
      const n = num(v);
      if (!Number.isFinite(n)) throw new GameError('Geçersiz cevap.');
      return Math.round(Math.min(120_000, Math.max(-5000, n)) * 10) / 10;
    });
    return taps.sort((a, b) => a - b);
  }
  const n = num(raw);
  if (!Number.isFinite(n)) throw new GameError('Geçersiz cevap.');
  switch (test) {
    case 'count': return Math.min(999, Math.max(0, Math.round(n)));
    case 'track': return Math.round(Math.min(1000, Math.max(0, n)) * 10) / 10;
    case 'angle': {
      if (friday) return Math.round(Math.min(3600, Math.max(-3600, n)) * 10) / 10;
      const a = Math.round((((n % 360) + 360) % 360) * 10) / 10;
      return a >= 360 ? 0 : a;
    }
    default: {
      const [lo, hi] = SPLIT_RANGE[friday ? 'friday' : 'normal'];
      return Math.round(Math.min(hi, Math.max(lo, n)) * 10000) / 10000;
    }
  }
}

// ---------- HTTP uçları (server.js çağırır; identity doğrulanmış gelir) ----------

export function startGame(identity, mode, rawRules) {
  if (mode === 'free') {
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - (FREE_PER_PLAYER - 1)))) freeGames.delete(oldId);
    if (freeGames.size >= MAX_FREE_GAMES) pruneFree();
    if (freeGames.size >= MAX_FREE_GAMES) throw new GameError('Sunucu şu an çok yoğun, biraz sonra tekrar dene.');
    const friday = rawRules === 'friday';
    const rng = cryptoRng();
    const id = randomUUID();
    const game = {
      playerId: identity.id,
      friday,
      stimuli: TESTS.map((test) => makeStimulus(test, rng, friday)),
      tests: [],
      done: false,
      total: 0,
      createdAt: Date.now(),
    };
    freeGames.set(id, game);
    return publicGame(game, (i) => game.stimuli[i], { mode, gameId: id });
  }
  const date = todayIstanbul();
  const { game, stimOf, extra } = lookup(identity, 'daily', date);
  if (!game) return publicGame({ friday: isFriday(date), tests: [], done: false, total: 0 }, stimOf, extra);
  settle(game, stimOf);
  daily.save();
  return publicGame(game, stimOf, extra);
}

// Testi başlat: uyaran SADECE burada, bir kez gönderilir. Başlamış test yeniden başlatılamaz, test atlanamaz.
export function startTest(identity, mode, rawGameId, rawIndex) {
  const { game, stimOf, extra } = lookup(identity, mode, rawGameId, true);
  settle(game, stimOf);
  const index = num(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= TESTS.length) throw new GameError('Geçersiz test.');
  if (game.done) throw new GameError(mode === 'daily' ? 'Bugünkü testi bitirdin. Yarın yenisi!' : 'Bu oyun bitti.');
  if (index < game.tests.length) throw new GameError('Bu test zaten başladı; tekrar gösterilmez.');
  if (index > game.tests.length || (game.tests.length && game.tests.at(-1).answer === undefined)) throw new GameError('Önce önceki testi bitir.');
  const now = Date.now();
  const t = { startedAt: now };
  game.tests.push(t);
  if (mode === 'daily') { game.name = identity.name ?? game.name; daily.save(); }
  const stim = stimOf(index);
  return {
    ...extra,
    index,
    test: TESTS[index],
    friday: game.friday,
    stimulus: stim,
    timeScale: TIME_SCALE, // istemci animasyonu (gerçek süre × ölçek) ve ritim aralığı için
    showMs: showMsOf(index, stim, game.friday),
    leadMs: TESTS[index] === 'tempo' ? scaled(TEMPO.leadMs) : 0,
    startedAt: now,
    endsAt: deadlineOf(t, index, stim, game.friday),
    serverNow: now,
  };
}

export function submitAnswer(identity, mode, rawGameId, rawIndex, rawAnswer) {
  const { game, stimOf, extra } = lookup(identity, mode, rawGameId);
  if (!game) throw new GameError('Önce testi başlat.');
  const index = num(rawIndex);
  const t = Number.isInteger(index) ? game.tests[index] : null;
  if (!t) throw new GameError('Bu test başlamadı.');
  if (t.answer !== undefined) throw new GameError('Bu testin cevabı zaten alındı.');
  const stim = stimOf(index);
  const now = Date.now();
  if (now < recallAtOf(t, index, stim, game.friday) - EARLY_SLACK_MS) throw new GameError('Önce gösterim bitmeli.');
  const test = TESTS[index];
  if (now > deadlineOf(t, index, stim, game.friday) + graceMs()) {
    timeOut(t); // süre çoktan doldu: cevap sayılmaz
  } else {
    let answer = cleanAnswer(test, rawAnswer, game.friday);
    // Ritim: dokunuşlar ölçekli zamanda gelir; puan gerçek zamana çevrilerek hesaplanır.
    const forScore = test === 'tempo' ? answer.map((x) => x / TIME_SCALE) : answer;
    if (test === 'tempo') answer = answer.length; // kayıtta sadece dokunuş sayısı
    const r = evaluate(test, stim, forScore, game.friday);
    Object.assign(t, { answer, score: r.score, error: r.error, detail: r.detail });
  }
  if (mode === 'daily') game.name = identity.name ?? game.name;
  finishIfDone(game);
  if (mode === 'daily') daily.save();
  return publicGame(game, stimOf, extra);
}

// Sıralama: sadece bitirenler (ilk 50 + sen). Başkalarının test puanları ancak sen bitirince görünür.
export function leaderboard(date, viewerId) {
  const day = daily.data[date] ?? {};
  for (const g of Object.values(day)) if (!g.done) settle(g, (i) => dailyStimulus(date, i));
  const viewerDone = Boolean(day[viewerId]?.done);
  return {
    date,
    puzzleNo: dayIndex(date) + 1,
    friday: isFriday(date),
    viewerDone,
    entries: Object.entries(day)
      .filter(([, e]) => e.done)
      .map(([id, e]) => ({
        name: identityStore.data[id]?.name ?? e.name,
        me: id === viewerId,
        total: e.total,
        grade: gradeOf(e.total),
        finishedAt: e.finishedAt,
        scores: viewerDone ? e.tests.map((t) => t.score) : null,
      }))
      .sort((a, b) => b.total - a.total || a.finishedAt - b.finishedAt)
      .map((e, i) => ({ ...e, rank: i + 1 }))
      .filter((e) => e.rank <= BOARD_LIMIT || e.me),
    finishers: Object.values(day).filter((e) => e.done).length,
    playing: Object.values(day).filter((e) => !e.done && e.tests.length).length,
  };
}

export { todayIstanbul };
