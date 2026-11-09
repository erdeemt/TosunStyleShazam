// 🔤 Harf Çarkı — lobili "kapışma" sürümü. Kurallar: PLAN.md §4.13 "Çok oyunculu". Tek oyunculu: server/harfcarki.js.
// Herkes AYNI çarkı aynı anda, aynı saatle oynar; herkes kendi hızında ilerler. Görünümde sadece kendi ipucun ve
// herkesin harf renkleri var; cevaplar (ve başkalarının yazdıkları) oyun bitene kadar hiçbir görünümde yok.
import { randomBytes } from 'node:crypto';
import { cryptoRng } from '../rng.js';
import { GameError, num, str } from '../errors.js';
import {
  BY_ID, DIFFICULTIES, GRACE_MS, MINUTE_OPTIONS, applyMove, composeWheel, expireRun, finishRun, markSeen,
  newRun, publicRun, rankCmp, recapOf, seenOf, summarize,
} from '../harfcarki.js';

const SYNC_MS = 3000; // 3-2-1: görünüm herkese ulaşsın, herkes aynı anda başlasın
const EARLY_SLACK_MS = 150;

const sc = (ctx, ms) => Math.max(1, Math.round(ms * ctx.timeScale));
const active = (state) => state.players.filter((p) => !p.left);

function endGame(state, ctx) {
  ctx.clearTimer('go');
  ctx.clearTimer('end');
  for (const p of state.players) if (!p.run.done) finishRun(p.run, 'time', ctx.now);
  state.phase = 'over';
  state.over = true;
}

function maybeAllDone(state, ctx) {
  if (state.phase !== 'over' && active(state).every((p) => p.run.done)) endGame(state, ctx);
}

export default {
  id: 'harfcarki',
  name: 'Harf Çarkı',
  minPlayers: 1, // tek kişi de oda açıp oynayabilir
  maxPlayers: 12,
  defaultSettings: { minutes: 5, difficulty: 'mixed' },

  validateSettings(s) {
    return {
      minutes: MINUTE_OPTIONS.includes(Number(s.minutes)) ? Number(s.minutes) : 5,
      difficulty: Object.hasOwn(DIFFICULTIES, s.difficulty) ? s.difficulty : 'mixed',
    };
  },

  setup({ players, settings, ctx }) {
    // Çark kripto üreteçle; oyuncuların yakında gördüğü ipuçlarından kaçınır.
    const avoid = new Set(players.flatMap((p) => seenOf(p.id)));
    const ids = composeWheel(cryptoRng(), { difficulty: settings.difficulty, avoid });
    markSeen(players.map((p) => p.id), ids);
    const now = Date.now();
    const startAt = now + sc(ctx, SYNC_MS);
    const duration = sc(ctx, settings.minutes * 60_000);
    const state = {
      settings,
      gameKey: randomBytes(4).readUInt32BE(0),
      ids,
      targets: ids.map((id) => BY_ID.get(id).answer), // sadece sunucu içi (/api/_test/secret, TEST_GAMES); görünüme girmez
      phase: 'ready',
      startAt,
      endsAt: startAt + duration,
      players: players.map((p) => ({ id: p.id, name: p.name, left: false, run: newRun(ids, startAt, duration), last: null, seq: 0 })),
      over: false,
    };
    ctx.setTimer(SYNC_MS, 'go');
    ctx.setTimer(SYNC_MS + settings.minutes * 60_000 + GRACE_MS, 'end');
    return state;
  },

  action(state, playerId, action, ctx) {
    const me = state.players.find((p) => p.id === playerId && !p.left);
    if (!me) throw new GameError('Bu oyunda değilsin.');
    const type = str(action.type);
    if (!['answer', 'pass', 'quit'].includes(type)) throw new GameError('Bilinmeyen eylem.');
    if (state.over || me.run.done) return; // geç/çift gönderim sessizce yok sayılır
    if (ctx.now < state.startAt - sc(ctx, EARLY_SLACK_MS)) throw new GameError('Daha başlamadı.');
    if (type !== 'quit' && num(action.pos) !== me.run.pos) return; // eski harfe ait (çift dokunma)
    if (expireRun(me.run, ctx.now, sc(ctx, GRACE_MS))) { maybeAllDone(state, ctx); return; }
    const r = applyMove(me.run, { pos: action.pos, kind: type, answer: action.text }, ctx.now, { grace: sc(ctx, GRACE_MS), early: sc(ctx, EARLY_SLACK_MS) });
    me.last = { ...r, seq: ++me.seq };
    maybeAllDone(state, ctx);
  },

  tick(state, ctx, name) {
    if (state.over) return;
    if (name === 'go' && state.phase === 'ready') state.phase = 'play';
    else if (name === 'end') endGame(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p || p.left) return;
    p.left = true;
    finishRun(p.run, 'left', ctx.now);
    if (!active(state).length) { endGame(state, ctx); return; }
    maybeAllDone(state, ctx);
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const me = state.players.find((p) => p.id === playerId && !p.left);
    const playing = Boolean(me);
    const over = state.over;
    // Kendi ipucun sadece oyun başladıktan sonra; cevaplar sadece oyun bitince (herkes bitirdi ya da süre doldu).
    let mine = null;
    if (me) {
      const pub = publicRun(me.run, { reveal: over });
      if (state.phase === 'ready') pub.current = null;
      mine = { ...pub, last: me.last };
    }
    const ranking = [...state.players]
      .map((p) => ({ id: p.id, name: p.name, left: p.left, ...summarize(p.run) }))
      .sort((a, b) => Number(a.left) - Number(b.left) || rankCmp(a, b));
    return {
      game: 'harfcarki',
      gameKey: state.gameKey,
      phase: state.phase,
      over,
      settings: state.settings,
      startAt: state.startAt,
      endsAt: state.endsAt,
      me: { playing, run: mine },
      // Herkesin harf renkleri (cevap yok). Bitirmiş oyuncunun kalan pasları da açılmaz.
      players: state.players.filter((p) => !p.left).map((p) => {
        const s = summarize(p.run);
        return { id: p.id, name: p.name, states: p.run.states, pos: p.run.done ? null : p.run.pos, done: p.run.done, correct: s.correct, wrong: s.wrong };
      }),
      ranking: over ? ranking : null,
      // Final: herkesin harf harf sonucu + yazdıkları + doğru cevaplar.
      reveal: over ? {
        recap: recapOf({ ids: state.ids, typed: state.ids.map(() => null), states: state.ids.map(() => 'todo') })
          .map(({ letter, mode, clue, answer }) => ({ letter, mode, clue, answer })),
        results: Object.fromEntries(state.players.map((p) => [p.id, { states: p.run.states, typed: p.run.typed }])),
      } : null,
    };
  },
};
