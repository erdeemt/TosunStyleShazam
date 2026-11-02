// 📸 Ne Zaman Nerede? — lobili (çok oyunculu) sürüm. Kurallar: PLAN.md §4.10 "Çok oyunculu".
// Herkes aynı fotoğrafı aynı sunucu anında görür, haritaya iğne + yıl tahmini kilitler (ya da süre dolar → 0).
// Tur kapanınca herkese aynı anda açıklama: gerçek yer/yıl, herkesin iğnesi, mesafe, puan, ara sıralama. Sonunda kürsü.
// Cevaplar (yer/yıl/başlık) tur kapanmadan hiçbir görünümde yok; fotoğraf sadece sahibine + odaya bağlı medya jetonuyla.
import { randomBytes } from 'node:crypto';
import { cryptoRng } from '../rng.js';
import { GameError, num, str } from '../errors.js';
import { ROUND_OPTIONS, TIME_OPTIONS, cleanGuess, scaleOf, scoreRound, titleFor } from '../../public/whenwhere-math.js';
import { cleanSet, photoMedia, pickPhotos, poolOf, revealOf, warm } from '../whenwhere.js';

const SYNC_MS = 1500; // görünüm + görsel herkese ulaşsın diye tur biraz sonra başlar (startAt)
const GRACE_MS = 2000; // süre dolduktan sonra ağ payı (geç otomatik kilit)
const REVEAL_MS = 20_000;
const EARLY_SLACK_MS = 150;

const activePlayers = (state) => state.players.filter((p) => !p.left);
const sc = (ctx, ms) => Math.max(1, Math.round(ms * ctx.timeScale));

function startRound(state, ctx, index) {
  ctx.clearTimer('reveal');
  state.index = index;
  state.phase = 'play';
  state.guesses = {};
  state.shown = new Map();
  const now = Date.now();
  state.startAt = now + sc(ctx, SYNC_MS);
  state.endsAt = state.startAt + sc(ctx, state.settings.time * 1000);
  ctx.setTimer(SYNC_MS + state.settings.time * 1000 + GRACE_MS, 'play');
  warm(state.photos.slice(index + 1, index + 2));
}

function closeRound(state, ctx) {
  ctx.clearTimer('play');
  const photo = state.photos[state.index];
  const results = {};
  for (const p of activePlayers(state)) {
    const g = state.guesses[p.id];
    const r = scoreRound(g?.guess ?? null, photo, state.scale);
    results[p.id] = { guess: g?.guess ?? null, ...r, timedOut: !g };
    p.scores.push(r.score);
  }
  state.history.push({ index: state.index, ...revealOf(photo), results });
  state.phase = 'reveal';
  state.startAt = null;
  state.endsAt = ctx.setTimer(REVEAL_MS, 'reveal');
}

function endGame(state, ctx) {
  for (const name of ['play', 'reveal']) ctx.clearTimer(name);
  state.phase = 'over';
  state.over = true;
  state.endsAt = null;
  state.startAt = null;
}

function advance(state, ctx) {
  if (state.index + 1 >= state.photos.length) endGame(state, ctx);
  else startRound(state, ctx, state.index + 1);
}

function maybeAllIn(state, ctx) {
  if (state.phase === 'play' && activePlayers(state).every((p) => state.guesses[p.id])) closeRound(state, ctx);
}

const total = (p) => p.scores.reduce((s, x) => s + x, 0);

export default {
  id: 'whenwhere',
  name: 'Ne Zaman Nerede?',
  minPlayers: 1,
  maxPlayers: 12,
  defaultSettings: { set: 'karisik', rounds: 5, time: 60 },

  validateSettings(s) {
    const rounds = ROUND_OPTIONS.includes(num(s.rounds)) ? num(s.rounds) : 5;
    const time = TIME_OPTIONS.includes(num(s.time)) ? num(s.time) : 60;
    return { set: cleanSet(s.set), rounds, time };
  },

  canStart(_prep, settings) {
    if (poolOf(settings.set).length < settings.rounds) return 'Bu sette bu kadar tur için yeterli fotoğraf yok.';
    return null;
  },

  setup({ players, settings, ctx }) {
    // Fotoğraflar her zaman kripto üreteçle (tohumlu oda üreteci değil): sıradakiler tahmin edilemesin.
    const photos = pickPhotos(settings.set, settings.rounds, cryptoRng());
    warm(photos.slice(0, 2));
    const state = {
      settings: { ...settings, rounds: photos.length },
      scale: scaleOf(settings.set),
      roomCode: ctx.roomCode ?? null,
      gameKey: randomBytes(4).readUInt32BE(0),
      photos,
      // Sadece testler (_testRoomSecrets → /api/_test/secret): gerçek cevaplar. Hiçbir görünüme girmez.
      targets: photos.map((p) => ({ lat: p.lat, lon: p.lon, year: p.year })),
      players: players.map((p) => ({ id: p.id, name: p.name, left: false, scores: [] })),
      index: 0,
      phase: 'play',
      guesses: {}, // bu turun kilitli tahminleri: playerId -> { guess, at }
      shown: new Map(), // bu turun oyuncu başına görsel adresi
      history: [], // kapanan turlar: [{ index, truth, title, …, results: { playerId: {...} } }]
      startAt: null,
      endsAt: null,
      over: false,
    };
    startRound(state, ctx, 0);
    return state;
  },

  action(state, playerId, action, ctx) {
    const me = state.players.find((p) => p.id === playerId && !p.left);
    if (!me) throw new GameError('Bu oyunda değilsin.');
    const type = str(action.type);
    if (!['guess', 'next'].includes(type)) throw new GameError('Bilinmeyen eylem.');
    // Eski tura/faza ait eylemler (geç otomatik kilit, çift dokunma) sessizce yok sayılır.
    if (num(action.index) !== state.index || state.over) return;
    if (type === 'next') {
      if (state.phase !== 'reveal') return;
      if (playerId !== ctx.hostId) throw new GameError('Sonraki turu oda sahibi başlatır.');
      advance(state, ctx);
      return;
    }
    if (state.phase !== 'play') return;
    if (state.guesses[playerId]) throw new GameError('Tahminini zaten kilitledin.');
    if (ctx.now < state.startAt - EARLY_SLACK_MS) throw new GameError('Tur henüz başlamadı.');
    if (ctx.now > state.endsAt + sc(ctx, GRACE_MS)) throw new GameError('Süre doldu, tahmin sayılmadı.');
    const guess = cleanGuess(action.guess);
    if (!guess) throw new GameError('Geçersiz tahmin.');
    state.guesses[playerId] = { guess, at: ctx.now };
    maybeAllIn(state, ctx);
  },

  tick(state, ctx, name) {
    if (name !== state.phase) return; // eski zamanlayıcı
    if (state.phase === 'play') closeRound(state, ctx); // kilitlemeyen 0 puan
    else if (state.phase === 'reveal') advance(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p || p.left) return;
    p.left = true;
    delete state.guesses[playerId];
    if (!activePlayers(state).length) { endGame(state, ctx); return; }
    maybeAllIn(state, ctx);
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const playing = state.players.some((p) => p.id === playerId && !p.left);
    const inPlay = state.phase === 'play';
    // Fotoğraf adresi: oyun fazında, oyuncuya ve izleyiciye (izleyici de görsün), kişi başına bir kez üretilir.
    let image = null;
    if (inPlay) {
      image = state.shown.get(playerId);
      if (!image) {
        image = photoMedia(state.photos[state.index], {
          owner: playerId,
          room: state.roomCode,
          ttlMs: state.endsAt - Date.now() + 30_000,
          uses: 4, // yeniden bağlanma / sayfa yenileme payı
        });
        state.shown.set(playerId, image);
      }
    }
    const mine = inPlay ? state.guesses[playerId] : null;
    const rows = state.players.filter((p) => !p.left);
    return {
      game: 'whenwhere',
      gameKey: state.gameKey,
      phase: state.phase,
      over: state.over,
      set: state.settings.set,
      time: state.settings.time,
      rounds: state.photos.length,
      index: state.index,
      startAt: inPlay ? state.startAt : null,
      endsAt: state.endsAt,
      image,
      me: { playing, locked: Boolean(mine), guess: mine ? mine.guess : null },
      players: rows.map((p) => ({
        id: p.id,
        name: p.name,
        locked: inPlay ? Boolean(state.guesses[p.id]) : null,
        scores: p.scores,
        total: total(p),
        badge: state.over ? titleFor(total(p), state.photos.length) : null,
      })),
      // Başkalarının tahminleri ve gerçek cevap sadece tur kapandıktan sonra (history).
      history: state.history,
      last: state.phase === 'reveal' || state.phase === 'over' ? state.history.at(-1) ?? null : null,
    };
  },
};
