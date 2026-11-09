// 🔗 Bağlantı Avı — lobili (çok oyunculu) sürüm: herkes aynı iki kişiyi aynı anda görür, zinciri ilk ve en kısa kuran kazanır.
// Kurallar: PLAN.md §4.12 "Çok oyunculu". Motor (kenar doğrulama, etiket, puan): server/baglanti.js.
// Tur sürerken başkalarının sadece adım SAYISI görünür (zincirdeki adlar değil); en kısa yol ve herkesin zinciri tur kapanınca.
import { randomBytes } from 'node:crypto';
import { cryptoRng } from '../rng.js';
import { GameError, num, str } from '../errors.js';
import { MINUTE_OPTIONS, ROUND_OPTIONS, titleFor } from '../../public/baglanti-math.js';
import { PUZZLES, addStep, cleanDiff, giveUp, newRun, pathLabeled, pickPuzzles, publicRun, removeStep, runResult, useHint } from '../baglanti.js';

const SYNC_MS = 1500; // görünüm herkese ulaşsın diye tur biraz sonra başlar (startAt)
const GRACE_MS = 1500; // süre bitince ağ payı
const REVEAL_MS = 30_000;
const EARLY_SLACK_MS = 150;

const activePlayers = (state) => state.players.filter((p) => !p.left);
const sc = (ctx, ms) => Math.max(1, Math.round(ms * ctx.timeScale));

function startRound(state, ctx, index) {
  ctx.clearTimer('reveal');
  state.index = index;
  state.phase = 'play';
  const now = Date.now();
  state.startAt = now + sc(ctx, SYNC_MS);
  state.endsAt = state.startAt + sc(ctx, state.settings.minutes * 60_000);
  state.runs = new Map();
  for (const p of activePlayers(state)) state.runs.set(p.id, newRun(state.puzzles[index], state.startAt));
  state.finishOrder = [];
  ctx.setTimer(SYNC_MS + state.settings.minutes * 60_000 + GRACE_MS, 'play');
}

function closeRound(state, ctx) {
  ctx.clearTimer('play');
  const z = state.puzzles[state.index];
  const now = Math.min(Date.now(), state.endsAt);
  const results = {};
  for (const p of activePlayers(state)) {
    const run = state.runs.get(p.id);
    if (!run) continue;
    const r = runResult(run, now);
    const place = state.finishOrder.indexOf(p.id);
    results[p.id] = {
      chain: run.chain.map((c) => ({ q: c.q, e: c.e, t: c.t })),
      final: run.done && !run.gaveUp ? run.final : null,
      done: run.done && !run.gaveUp,
      gaveUp: run.gaveUp,
      wrong: run.wrong,
      hints: run.hints.length,
      ms: r.ms,
      score: r.score,
      place: place >= 0 ? place + 1 : null,
    };
    p.scores.push(r.score);
  }
  state.history.push({ index: state.index, start: z.s, target: z.t, opt: z.path.length - 2, optimal: pathLabeled(z.path), results });
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
  if (state.index + 1 >= state.puzzles.length) endGame(state, ctx);
  else startRound(state, ctx, state.index + 1);
}

function maybeAllDone(state, ctx) {
  if (state.phase !== 'play') return;
  if (activePlayers(state).every((p) => state.runs.get(p.id)?.done)) closeRound(state, ctx);
}

const total = (p) => p.scores.reduce((s, x) => s + x, 0);

export default {
  id: 'baglanti',
  name: 'Bağlantı Avı',
  minPlayers: 1,
  maxPlayers: 12,
  defaultSettings: { difficulty: 'orta', rounds: 3, minutes: 5 },

  validateSettings(s) {
    const rounds = ROUND_OPTIONS.includes(num(s.rounds)) ? num(s.rounds) : 3;
    const minutes = MINUTE_OPTIONS.includes(num(s.minutes)) ? num(s.minutes) : 5;
    return { difficulty: cleanDiff(s.difficulty), rounds, minutes };
  },

  canStart(_prep, settings) {
    if ((PUZZLES[settings.difficulty]?.length ?? 0) < settings.rounds) return 'Bu zorlukta bu kadar tur için yeterli yapboz yok.';
    return null;
  },

  setup({ players, settings, ctx }) {
    // Yapbozlar kripto üreteçle (tohumlu oda üreteci değil): sıradakiler tahmin edilemesin.
    const puzzles = pickPuzzles(settings.difficulty, settings.rounds, cryptoRng());
    const state = {
      settings: { ...settings, rounds: puzzles.length },
      gameKey: randomBytes(4).readUInt32BE(0),
      puzzles,
      // Sadece testler (_testRoomSecrets → /api/_test/secret): en kısa yollar. Hiçbir görünüme girmez.
      targets: puzzles.map((z) => z.path),
      players: players.map((p) => ({ id: p.id, name: p.name, left: false, scores: [] })),
      index: 0,
      phase: 'play',
      runs: new Map(),
      finishOrder: [],
      history: [],
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
    const type = str(action?.type);
    if (!['add', 'remove', 'hint', 'giveup', 'next'].includes(type)) throw new GameError('Bilinmeyen eylem.');
    // Eski tura/faza ait eylemler (geç dokunma, çift gönderim) sessizce yok sayılır.
    if (num(action.index) !== state.index || state.over) return;
    if (type === 'next') {
      if (state.phase !== 'reveal') return;
      if (playerId !== ctx.hostId) throw new GameError('Sonraki turu oda sahibi başlatır.');
      advance(state, ctx);
      return;
    }
    if (state.phase !== 'play') return;
    if (ctx.now < state.startAt - EARLY_SLACK_MS) throw new GameError('Tur henüz başlamadı.');
    if (ctx.now > state.endsAt + sc(ctx, GRACE_MS)) throw new GameError('Süre doldu.');
    const run = state.runs.get(playerId);
    if (!run) throw new GameError('Bu turda oynamıyorsun.');
    if (type === 'add') addStep(run, action.qid, ctx.now);
    else if (type === 'remove') removeStep(run, action.pos);
    else if (type === 'hint') useHint(run, action.kind);
    else giveUp(run, ctx.now);
    if (run.done && !run.gaveUp && !state.finishOrder.includes(playerId)) state.finishOrder.push(playerId);
    maybeAllDone(state, ctx);
  },

  tick(state, ctx, name) {
    if (name !== state.phase) return; // eski zamanlayıcı
    if (state.phase === 'play') closeRound(state, ctx);
    else if (state.phase === 'reveal') advance(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p || p.left) return;
    p.left = true;
    if (!activePlayers(state).length) { endGame(state, ctx); return; }
    maybeAllDone(state, ctx);
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const playing = state.players.some((p) => p.id === playerId && !p.left);
    const inPlay = state.phase === 'play';
    const z = state.puzzles[state.index];
    const run = inPlay ? state.runs.get(playerId) : null;
    const rows = state.players.filter((p) => !p.left);
    return {
      game: 'baglanti',
      gameKey: state.gameKey,
      phase: state.phase,
      over: state.over,
      difficulty: state.settings.difficulty,
      minutes: state.settings.minutes,
      rounds: state.puzzles.length,
      index: state.index,
      startAt: inPlay ? state.startAt : null,
      endsAt: state.endsAt,
      // Uçlar herkese açık (izleyici de görür); en kısa yol sadece history'de (tur kapanınca).
      start: z.s,
      target: z.t,
      opt: z.path.length - 2,
      me: { playing, run: run ? publicRun(run, { reveal: false }) : null },
      players: rows.map((p) => {
        const r = inPlay ? state.runs.get(p.id) : null;
        const place = inPlay ? state.finishOrder.indexOf(p.id) : -1;
        return {
          id: p.id,
          name: p.name,
          // Canlı ilerleme: sadece adım sayısı + bitti mi (zincirdeki adlar değil)
          steps: r ? r.chain.length : null,
          done: r ? r.done && !r.gaveUp : null,
          gaveUp: r ? r.gaveUp : null,
          place: place >= 0 ? place + 1 : null,
          scores: p.scores,
          total: total(p),
          badge: state.over ? titleFor(p.scores.length ? total(p) / p.scores.length : 0) : null,
        };
      }),
      last: state.phase === 'reveal' ? state.history.at(-1) ?? null : null,
      // Final: her turun özeti (zincirler sadece son turda değil hepsinde; oyun bitti)
      history: state.over ? state.history : null,
    };
  },
};
