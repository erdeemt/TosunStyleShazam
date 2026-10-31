// Hafıza oyunları ortak motoru: 🎨 Nüans (renk) ve 🔊 Ton Avı (perde). Kurallar: PLAN.md §4.4, §4.5.
// Her turda hedef gösterilir/çalınır, sonra gizlenir; oyuncu hafızadan yeniden kurar, puan uzaklığa göre.
// Bu dosya: oyun tanımları (hedef üretimi, girdi temizliği, puan), tek oyunculu HTTP uçları (günlük + sınırsız)
// ve lobi oyun modülü fabrikası (server/games/nuance.js, tone.js).
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cryptoRng } from './rng.js';
import { GameError, num, str } from './errors.js';
import { jsonStore } from './store.js';
import { mintMedia } from './media-tokens.js';
import { nuancePng, toneWav } from './media-encode.js';
import { isFreshAccount, rankDaily, todayIstanbul } from './wordle.js';
import {
  TONE_RANGES, hexToRgb, hsbToRgb, normalizeHex, rgbToHex, round2, scoreColor, scoreTone, freqAt,
} from '../public/recall-math.js';

// Süre ölçeği sadece test sunucusunda (TEST_MODE=1, tests/lib/server.js): üretimde yanlışlıkla bırakılırsa süreler değişmesin.
const TIME_SCALE = process.env.TEST_MODE === '1' && Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1;
const scaled = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

export const ROUNDS = 5;
export const RECALL_MS = 30_000;
const SUBMIT_GRACE_MS = 3000; // tek oyunculu: ağ gecikmesi payı
const EPOCH = '2026-10-24'; // 1 numaralı günlük

// ---------- Oyun tanımları ----------

export const RECALL_GAMES = {
  nuance: {
    id: 'nuance',
    name: 'Nüans',
    difficulties: { normal: { memorizeMs: 5000 }, expert: { memorizeMs: 2000 } },
    defaultDifficulty: 'normal',
    dailyDifficulty: 'normal',
    // Ton düzgün, doygunluk ve parlaklık 25–100 (neredeyse siyah/gri yığını olmasın)
    makeTarget(rng) {
      const h = rng.next() * 360;
      const s = 25 + rng.next() * 75;
      const b = 25 + rng.next() * 75;
      return rgbToHex(hsbToRgb(h, s, b));
    },
    cleanGuess(raw) {
      const hex = normalizeHex(str(raw));
      if (!hex) throw new GameError('Geçersiz renk.');
      return hex;
    },
    score: (target, guess) => scoreColor(hexToRgb(target), hexToRgb(guess)),
    // Ezberde hedef hex JSON'a yazılmaz: gürültülü küçük PNG olarak opak adresten gelir (bkz. media-tokens.js).
    media: { contentType: 'image/png', hidden: () => true, render: (target) => nuancePng(target) },
    // Chroma: turların ortalaması (0–1000)
    total: (scores) => (scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0),
  },
  tone: {
    id: 'tone',
    name: 'Ton Avı',
    difficulties: {
      easy: { memorizeMs: 3000, ...TONE_RANGES.easy, showHz: true },
      hard: { memorizeMs: 3000, ...TONE_RANGES.hard, showHz: false },
    },
    defaultDifficulty: 'easy',
    dailyDifficulty: 'easy',
    // Logaritmik frekansta (sent) düzgün dağılım
    makeTarget(rng, difficulty) {
      return Math.round(freqAt(rng.next(), this.difficulties[difficulty]) * 10) / 10;
    },
    cleanGuess(raw, difficulty) {
      const f = num(raw);
      if (!Number.isFinite(f)) throw new GameError('Geçersiz frekans.');
      const { min, max } = this.difficulties[difficulty];
      return Math.round(Math.min(max, Math.max(min, f)) * 10) / 10;
    },
    score: (target, guess) => scoreTone(target, guess),
    // Zor modda Hz JSON'a yazılmaz: ton WAV olarak opak adresten gelir. Kolayda sayı gider (istemci osilatörle çalar).
    media: { contentType: 'audio/wav', hidden: (difficulty) => difficulty === 'hard', render: (target, ms) => toneWav(target, ms) },
    // Toplam: tur puanlarının toplamı (0–50)
    total: (scores) => round2(scores.reduce((a, b) => a + b, 0)),
  },
};

export function getDef(gameId) {
  const def = Object.hasOwn(RECALL_GAMES, gameId) ? RECALL_GAMES[gameId] : null;
  if (!def) throw new GameError('Böyle bir oyun yok.');
  return def;
}

const cleanDifficulty = (def, raw) => (Object.hasOwn(def.difficulties, str(raw)) ? str(raw) : def.defaultDifficulty);

// ---------- Günlük hedefler ----------

// Günlük hedefler gizli tuz + tarih + tur ile HMAC'ten türetilir: bir turun hedefi açılınca
// sonraki turlar (veya ertesi gün) hesaplanamaz. Tuz data/secrets.json'da (testler RECALL_SALT verir).
const secrets = jsonStore('secrets', {});
const identityStore = jsonStore('identities', {}); // lobby.js ile aynı kayıt (sıralamada güncel ad)
if (!secrets.data.recallSalt) { secrets.data.recallSalt = randomBytes(16).toString('hex'); secrets.flushNow(); }
const SALT = process.env.RECALL_SALT || secrets.data.recallSalt;

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
  return { next, int: (n) => Math.floor(next() * n) };
}

export function dailyTarget(gameId, date, round) {
  const def = getDef(gameId);
  return def.makeTarget(hmacRng(`tosun-${gameId}-v1:${date}:${round}`), def.dailyDifficulty);
}

const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);

// ---------- Tek oyunculu oyun kaydı ----------
// Oyun: { playerId, difficulty, targets?, rounds: [{ startedAt, guess, score, timedOut }], done, total, finishedAt }
// Günlük kayıtta hedefler saklanmaz (tarihten yeniden hesaplanır).

const daily = jsonStore('recall-daily', {}); // { game: { date: { playerId: { name, rounds, done, total, finishedAt } } } }
const freeGames = new Map(); // gameId -> oyun
const FREE_TTL_MS = 6 * 3600_000;
const MAX_FREE_GAMES = 5000;
const BOARD_LIMIT = 50;
const KEEP_DAYS = 45;

// Eski günlerin kayıtlarını at (dosya sınırsız büyümesin).
function pruneDaily() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  let changed = false;
  for (const byDate of Object.values(daily.data)) {
    for (const date of Object.keys(byDate)) if (date < cutoff) { delete byDate[date]; changed = true; }
  }
  if (changed) daily.save();
}
pruneDaily();
setInterval(pruneDaily, 6 * 3600_000).unref();

const timing = (def, difficulty) => ({ memorizeMs: scaled(def.difficulties[difficulty].memorizeMs), recallMs: scaled(RECALL_MS) });
const deadlineOf = (def, difficulty, startedAt) => {
  const t = timing(def, difficulty);
  return startedAt + t.memorizeMs + t.recallMs;
};
const EARLY_SLACK_MS = 150; // saat/ağ farkı payı
const graceMs = () => Math.max(250, scaled(SUBMIT_GRACE_MS));
const MEDIA_GRACE_MS = 3000; // medya adresi ezber bitince + bu kadar (gerçek ms) geçerli

// Gizli hedef: JSON'da { media: '/api/media/<jeton>' } (sahibine bağlı, kısa ömürlü); açık hedef: { target }.
function targetPayload(def, difficulty, target, { owner, room = null, memorizeMs, ttlMs }) {
  if (!def.media.hidden(difficulty)) return { target };
  return {
    media: mintMedia({
      owner, room, contentType: def.media.contentType, ttlMs,
      render: () => def.media.render(target, memorizeMs),
    }),
  };
}

// Süresi geçmiş, cevaplanmamış tur 0 puan olur (sayfayı kapatan oyuncu turu "dondurmasın").
function settle(def, game, now = Date.now()) {
  const last = game.rounds.at(-1);
  if (last && last.guess === undefined && now > deadlineOf(def, game.difficulty, last.startedAt) + graceMs()) {
    last.guess = null;
    last.score = 0;
    last.timedOut = true;
  }
  finishIfDone(def, game);
}

function finishIfDone(def, game) {
  if (!game.done && game.rounds.length >= ROUNDS && game.rounds.every((r) => r.guess !== undefined)) {
    game.done = true;
    game.total = def.total(game.rounds.map((r) => r.score));
    game.finishedAt = Date.now();
  }
}

function publicGame(def, game, targetOf, extra) {
  const pending = game.rounds.findIndex((r) => r.guess === undefined);
  return {
    game: def.id,
    difficulty: game.difficulty,
    rounds: ROUNDS,
    ...timing(def, game.difficulty),
    // Bitmiş turların hedefi görünür; süren turunki görünmez.
    played: game.rounds.map((r, i) => (r.guess === undefined ? null
      : { round: i, target: targetOf(i), guess: r.guess, score: r.score, timedOut: Boolean(r.timedOut) })).filter(Boolean),
    pending: pending >= 0 ? {
      round: pending,
      recallAt: game.rounds[pending].startedAt + timing(def, game.difficulty).memorizeMs,
      endsAt: deadlineOf(def, game.difficulty, game.rounds[pending].startedAt),
    } : null,
    serverNow: Date.now(),
    done: game.done,
    total: game.done ? game.total : def.total(game.rounds.filter((r) => r.guess !== undefined).map((r) => r.score)),
    ...extra,
  };
}

function lookup(def, identity, mode, rawGameId, create = false) {
  if (mode === 'free') {
    const game = freeGames.get(str(rawGameId));
    if (!game || game.playerId !== identity.id || game.gameType !== def.id) throw new GameError('Oyun bulunamadı, yeni oyun başlat.');
    return { game, targetOf: (i) => game.targets[i], extra: { mode, gameId: str(rawGameId) } };
  }
  const date = todayIstanbul();
  if (str(rawGameId) !== date) throw new GameError('Günün bulmacası değişti, sayfayı yenile.');
  const byDate = ((daily.data[def.id] ??= {})[date] ??= {});
  if (!byDate[identity.id] && create) {
    byDate[identity.id] = { name: identity.name ?? 'Oyuncu', difficulty: def.dailyDifficulty, rounds: [], done: false, total: 0, finishedAt: null };
  }
  const game = byDate[identity.id] ?? null;
  return { game, targetOf: (i) => dailyTarget(def.id, date, i), extra: { mode, gameId: date, puzzleNo: dayIndex(date) + 1 } };
}

// ---------- HTTP uçları (server.js çağırır; identity doğrulanmış gelir) ----------

export function startGame(identity, gameId, mode, rawDifficulty) {
  const def = getDef(gameId);
  if (mode === 'free') {
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - 2))) freeGames.delete(oldId); // oyuncu başına en fazla 3
    if (freeGames.size >= MAX_FREE_GAMES) pruneFree();
    if (freeGames.size >= MAX_FREE_GAMES) throw new GameError('Sunucu şu an çok yoğun, biraz sonra tekrar dene.');
    const difficulty = cleanDifficulty(def, rawDifficulty);
    const rng = cryptoRng();
    const id = randomUUID();
    const game = {
      gameType: def.id,
      playerId: identity.id,
      difficulty,
      targets: Array.from({ length: ROUNDS }, () => def.makeTarget(rng, difficulty)),
      rounds: [],
      done: false,
      total: 0,
      createdAt: Date.now(),
    };
    freeGames.set(id, game);
    return publicGame(def, game, (i) => game.targets[i], { mode, gameId: id });
  }
  const { game, targetOf, extra } = lookup(def, identity, 'daily', todayIstanbul());
  if (!game) {
    return publicGame(def, { difficulty: def.dailyDifficulty, rounds: [], done: false, total: 0 }, targetOf, extra);
  }
  settle(def, game);
  daily.save();
  return publicGame(def, game, targetOf, extra);
}

// Turu başlat: hedef SADECE burada, bir kez gönderilir. Başlamış tur yeniden başlatılamaz.
export function startRound(identity, gameId, mode, rawGameId, rawRound) {
  const def = getDef(gameId);
  const { game, targetOf, extra } = lookup(def, identity, mode, rawGameId, true);
  settle(def, game);
  const round = num(rawRound);
  if (!Number.isInteger(round) || round < 0 || round >= ROUNDS) throw new GameError('Geçersiz tur.');
  if (game.done) throw new GameError(mode === 'daily' ? 'Bugünkü oyunu bitirdin. Yarın yeni hedefler!' : 'Bu oyun bitti.');
  if (round < game.rounds.length) throw new GameError('Bu tur zaten başladı; hedef tekrar gösterilmez.');
  if (round > game.rounds.length || game.rounds.at(-1)?.guess === undefined && game.rounds.length) throw new GameError('Önce önceki turu bitir.');
  const now = Date.now();
  game.rounds.push({ startedAt: now });
  if (mode === 'daily') { game.name = identity.name ?? game.name; daily.save(); }
  const t = timing(def, game.difficulty);
  const shown = targetPayload(def, game.difficulty, targetOf(round), { owner: identity.id, memorizeMs: t.memorizeMs, ttlMs: t.memorizeMs + MEDIA_GRACE_MS });
  return { ...extra, round, ...shown, ...t, startedAt: now, endsAt: deadlineOf(def, game.difficulty, now), serverNow: now };
}

export function submitGuess(identity, gameId, mode, rawGameId, rawRound, rawGuess) {
  const def = getDef(gameId);
  const { game, targetOf, extra } = lookup(def, identity, mode, rawGameId);
  if (!game) throw new GameError('Önce turu başlat.');
  const round = num(rawRound);
  const r = Number.isInteger(round) ? game.rounds[round] : null;
  if (!r) throw new GameError('Bu tur başlamadı.');
  if (r.guess !== undefined) throw new GameError('Bu turun cevabı zaten alındı.');
  if (Date.now() < r.startedAt + timing(def, game.difficulty).memorizeMs - EARLY_SLACK_MS) throw new GameError('Önce ezberleme süresi bitmeli.');
  const late = Date.now() > deadlineOf(def, game.difficulty, r.startedAt) + graceMs();
  if (late) {
    // Süre çoktan doldu: tahmin sayılmaz, tur 0 puan.
    r.guess = null;
    r.score = 0;
    r.timedOut = true;
  } else {
    const guess = def.cleanGuess(rawGuess, game.difficulty);
    r.guess = guess;
    r.score = def.score(targetOf(round), guess);
  }
  if (mode === 'daily') game.name = identity.name ?? game.name;
  finishIfDone(def, game);
  if (mode === 'daily') daily.save();
  return publicGame(def, game, targetOf, extra);
}

// Sıralama: sadece bitirenler. Başkalarının tur ayrıntıları ancak sen bitirince görünür.
export function leaderboard(gameId, date, viewerId) {
  const def = getDef(gameId);
  const day = daily.data[def.id]?.[date] ?? {};
  for (const g of Object.values(day)) settle(def, g);
  const viewerDone = Boolean(day[viewerId]?.done);
  return {
    game: def.id,
    date,
    puzzleNo: dayIndex(date) + 1,
    viewerDone,
    entries: rankDaily(Object.entries(day)
      .filter(([, e]) => e.done)
      .map(([id, e]) => ({
        name: identityStore.data[id]?.name ?? e.name, // oyun bittikten sonra ad değişirse sıralama da güncel olsun
        me: id === viewerId,
        fresh: isFreshAccount(identityStore.data[id], date), // bugün açılmış hesap: sıralama dışı
        total: e.total,
        finishedAt: e.finishedAt,
        rounds: viewerDone ? e.rounds.map((r, i) => ({ target: dailyTarget(def.id, date, i), guess: r.guess, score: r.score })) : null,
      })), (a, b) => b.total - a.total || a.finishedAt - b.finishedAt, BOARD_LIMIT),
    finishers: Object.values(day).filter((e) => e.done).length,
    playing: Object.values(day).filter((e) => !e.done && e.rounds.length).length,
  };
}

function pruneFree() {
  const cutoff = Date.now() - FREE_TTL_MS;
  for (const [id, g] of freeGames) if (g.createdAt < cutoff) freeGames.delete(id);
}
setInterval(() => pruneFree(), 600_000).unref();

export { todayIstanbul };

// Sadece testler (server.js bunu TEST_GAMES=1 iken /api/_test/secret ile açar): oyunun hedefleri.
export function _testSecrets(gameId, rawGameId) {
  const def = getDef(gameId);
  const free = freeGames.get(str(rawGameId));
  if (free) return { targets: free.targets };
  return { targets: Array.from({ length: ROUNDS }, (_, i) => dailyTarget(def.id, str(rawGameId), i)) };
}

// ---------- Lobi oyun modülü ----------
// Fazlar (her tur): memorize (hedef görünür) → recall (hedef yok, herkes cevaplar) → reveal (hedef + herkesin cevabı) → … → over
// Zamanlayıcılar isimli: 'memorize', 'recall', 'reveal'. Hatırlama süresi dolunca sunucu 2 sn daha bekler (ağ payı).

const LOBBY_GRACE_MS = 2000;
const REVEAL_MS = 20_000;

export function lobbyGame(gameId) {
  const def = getDef(gameId);
  const activePlayers = (state) => state.players.filter((p) => !p.left);

  function startRound(state, ctx) {
    state.round++;
    state.phase = 'memorize';
    state.answers = {};
    ctx.clearTimer('reveal');
    state.endsAt = ctx.setTimer(def.difficulties[state.settings.difficulty].memorizeMs, 'memorize');
    state.media = new Map(); // bu turun medya adresleri: playerId -> url (görünümde bir kez üretilir)
  }

  function startRecall(state, ctx) {
    state.phase = 'recall';
    const ms = state.settings.recallSeconds * 1000;
    const timerEnd = ctx.setTimer(ms + LOBBY_GRACE_MS, 'recall');
    state.endsAt = timerEnd - Math.round(LOBBY_GRACE_MS * ctx.timeScale);
  }

  function finishRound(state, ctx) {
    ctx.clearTimer('recall');
    const target = state.targets[state.round - 1];
    const answers = {};
    for (const p of activePlayers(state)) {
      const a = state.answers[p.id];
      const score = a ? def.score(target, a.guess) : 0;
      answers[p.id] = { guess: a ? a.guess : null, score };
      p.scores.push(score);
    }
    state.history.push({ round: state.round, target, answers });
    state.phase = 'reveal';
    state.endsAt = ctx.setTimer(REVEAL_MS, 'reveal');
  }

  function advance(state, ctx) {
    if (state.round >= state.settings.rounds) {
      state.phase = 'over';
      state.over = true;
      state.endsAt = null;
      return;
    }
    startRound(state, ctx);
  }

  function maybeAllIn(state, ctx) {
    if (state.phase === 'recall' && activePlayers(state).every((p) => state.answers[p.id])) finishRound(state, ctx);
  }

  const totalOf = (p) => def.total(p.scores);

  return {
    id: def.id,
    name: def.name,
    minPlayers: 1, // tek kişi de oda açıp oynayabilir (arkadaş gelene kadar ısınma)
    maxPlayers: 12,
    defaultSettings: { rounds: ROUNDS, difficulty: def.defaultDifficulty, recallSeconds: RECALL_MS / 1000 },

    validateSettings(s) {
      const clampInt = (v, lo, hi, d) => {
        const n = Math.round(num(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
      };
      return {
        rounds: clampInt(s.rounds, 3, 10, ROUNDS),
        difficulty: cleanDifficulty(def, s.difficulty),
        recallSeconds: clampInt(s.recallSeconds, 15, 60, RECALL_MS / 1000),
      };
    },

    setup({ players, settings, rng, ctx }) {
      const state = {
        settings,
        roomCode: ctx.roomCode ?? null, // medya jetonu odaya bağlı
        media: new Map(),
        gameKey: randomBytes(4).readUInt32BE(0), // istemci yeni oyunu ayırt etsin
        players: players.map((p) => ({ id: p.id, name: p.name, left: false, scores: [] })),
        targets: Array.from({ length: settings.rounds }, () => def.makeTarget(rng, settings.difficulty)),
        round: 0,
        phase: 'memorize',
        endsAt: null,
        answers: {}, // bu turun cevapları: playerId -> { guess, at }
        history: [], // [{ round, target, answers: { playerId: { guess, score } } }]
        over: false,
      };
      startRound(state, ctx);
      return state;
    },

    action(state, playerId, action, ctx) {
      const me = state.players.find((p) => p.id === playerId && !p.left);
      if (!me) throw new GameError('Bu oyunda değilsin.');
      const round = num(action.round);
      // Eski tura ait eylemler (geç gelen otomatik gönderim, çift dokunma) sessizce yok sayılır.
      if (round !== state.round || state.over) return;
      switch (str(action.type)) {
        case 'submit': {
          if (state.phase === 'memorize') throw new GameError('Önce hedefi ezberle, sonra cevap ver.');
          if (state.phase !== 'recall') return; // süre doldu, tur kapandı
          if (state.answers[playerId]) throw new GameError('Cevabını zaten gönderdin.');
          state.answers[playerId] = { guess: def.cleanGuess(action.guess, state.settings.difficulty), at: ctx.now };
          maybeAllIn(state, ctx);
          return;
        }
        case 'next': {
          if (state.phase !== 'reveal') return;
          if (playerId !== ctx.hostId) throw new GameError('Sonraki turu oda sahibi başlatır.');
          advance(state, ctx);
          return;
        }
        default:
          throw new GameError('Bilinmeyen eylem.');
      }
    },

    tick(state, ctx, name) {
      if (name !== state.phase) return; // eski zamanlayıcı
      if (state.phase === 'memorize') startRecall(state, ctx);
      else if (state.phase === 'recall') finishRound(state, ctx); // cevap vermeyen 0 puan
      else if (state.phase === 'reveal') advance(state, ctx);
    },

    onPlayerLeave(state, playerId, ctx) {
      const p = state.players.find((x) => x.id === playerId);
      if (!p || p.left) return;
      p.left = true;
      delete state.answers[playerId];
      if (!activePlayers(state).length) { state.over = true; state.phase = 'over'; return; }
      maybeAllIn(state, ctx);
    },

    isOver: (state) => state.over,

    view(state, playerId) {
      const showTarget = state.phase === 'memorize' || state.phase === 'reveal' || state.phase === 'over';
      const mine = state.answers[playerId];
      const last = state.history.at(-1);
      const difficulty = state.settings.difficulty;
      const memoTarget = state.phase === 'memorize' ? state.targets[state.round - 1] : null;
      let media = null;
      if (memoTarget != null && def.media.hidden(difficulty)) {
        media = state.media.get(playerId);
        if (!media) {
          const memorizeMs = Math.round(def.difficulties[difficulty].memorizeMs * TIME_SCALE);
          media = targetPayload(def, difficulty, memoTarget, {
            owner: playerId, room: state.roomCode, memorizeMs, ttlMs: state.endsAt - Date.now() + MEDIA_GRACE_MS,
          }).media;
          state.media.set(playerId, media);
        }
      }
      return {
        game: def.id,
        gameKey: state.gameKey,
        round: state.round,
        totalRounds: state.settings.rounds,
        difficulty: state.settings.difficulty,
        phase: state.phase,
        over: state.over,
        endsAt: state.endsAt,
        memorizeMs: Math.round(def.difficulties[state.settings.difficulty].memorizeMs * TIME_SCALE),
        recallMs: Math.round(state.settings.recallSeconds * 1000 * TIME_SCALE),
        // Hedef sadece ezber ve açıklama anında görünür.
        // Oyun tur ortasında bittiyse (herkes ayrıldı) oynanmamış turun hedefi değil, son açıklanan gösterilir.
        // Gizli hedefli modda ezberde target yok, sadece opak medya adresi (media) var.
        target: state.phase === 'over' ? last?.target ?? null : media ? null : showTarget ? state.targets[state.round - 1] : null,
        media,
        me: { submitted: Boolean(mine), guess: mine ? mine.guess : null },
        players: state.players.filter((p) => !p.left).map((p) => ({
          id: p.id,
          name: p.name,
          submitted: state.phase === 'recall' ? Boolean(state.answers[p.id]) : null,
          total: totalOf(p),
        })),
        // Başkalarının cevapları sadece tur bittikten sonra (history) görünür.
        history: state.history,
        lastRound: state.phase === 'reveal' || state.phase === 'over' ? last ?? null : null,
      };
    },
  };
}
