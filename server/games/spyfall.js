// 🕵️ Casus Kim? (Spyfall). Kurallar: PLAN.md §4.1.
// Gizli bilgi: mekân ve roller casusun görünümüne, casusların kimliği diğerlerinin görünümüne sonuç açıklanana kadar girmez.
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { GameError, num, str } from '../errors.js';

const { locations: LOCATIONS } = JSON.parse(readFileSync(new URL('../../content/spyfall/locations.json', import.meta.url), 'utf8'));
const LOCATION_LIST = LOCATIONS.map(({ id, name, emoji }) => ({ id, name, emoji }));

const ACCUSE_VOTE_MS = 45_000; // suçlama oylaması süresi
const FINAL_VOTE_MS = 60_000; // süre bitince zorunlu oylama
// Spyfall standardı: casus süre dolup kimse mahkûm edilmezse 2, masum mahkûm edilirse veya mekânı bilirse 4.
const POINTS = { spyWin: 2, spyBig: 4, townWin: 1, accuserBonus: 1 };
const SPY_BIG_REASONS = new Set(['guess', 'wrong_accuse', 'final_wrong']);

const active = (state) => state.players.filter((p) => !p.left);
const isSpy = (state, id) => state.round.spyIds.includes(id);
const findPlayer = (state, id) => state.players.find((p) => p.id === id && !p.left);

// Soru-cevap sırası: X → Y'ye soruyor; ikisi de onaylayınca cevap veren yeni soran olur ve kendisine
// az önce sorana geri soramaz (Spyfall kuralı). Hedef kalanlardan rastgele.
function pickTarget(state, rng, askerId, excludeId) {
  const others = active(state).filter((p) => p.id !== askerId);
  const preferred = others.filter((p) => p.id !== excludeId);
  const pool = preferred.length ? preferred : others;
  return pool.length ? rng.pick(pool).id : null;
}

function newPair(state, rng, askerId, excludeId = null) {
  const r = state.round;
  r.qa = { number: (r.qa?.number ?? 0) + 1, askerId, targetId: pickTarget(state, rng, askerId, excludeId), done: [] };
}

function startRound(state, ctx) {
  const rng = ctx.rng;
  const players = active(state);
  const unused = LOCATIONS.filter((l) => !state.usedLocations.includes(l.id));
  const location = rng.pick(unused.length ? unused : LOCATIONS);
  state.usedLocations.push(location.id);

  const spyCount = Math.min(state.settings.spies, players.length >= 9 ? 2 : 1);
  const shuffled = rng.shuffle(players.map((p) => p.id));
  const spyIds = shuffled.slice(0, spyCount);
  const roles = {};
  const rolePool = rng.shuffle(location.roles);
  shuffled.slice(spyCount).forEach((id, i) => { roles[id] = rolePool[i % rolePool.length]; });

  state.round = {
    number: (state.round?.number ?? 0) + 1,
    locationId: location.id,
    spyIds,
    roles,
    firstAskerId: rng.pick(players).id,
    qa: null, // { number, askerId, targetId, done: [playerId] }
    phase: 'play', // play | accuse | final | reveal
    endsAt: ctx.setTimer(state.settings.minutes * 60_000),
    remainingMs: null, // suçlama sırasında saat durur
    accusation: null,
    accusersUsed: [],
    finalVotes: {},
    result: null,
  };
  newPair(state, rng, state.round.firstAskerId);
}

function finishRound(state, ctx, { winner, reason, accuserId = null, accusedId = null, guessId = null }) {
  ctx.clearTimer();
  const r = state.round;
  const points = {};
  for (const p of active(state)) {
    const spy = r.spyIds.includes(p.id);
    let pts = 0;
    if (winner === 'spy' && spy) pts = SPY_BIG_REASONS.has(reason) ? POINTS.spyBig : POINTS.spyWin;
    if (winner === 'town' && !spy) pts = POINTS.townWin + (p.id === accuserId ? POINTS.accuserBonus : 0);
    points[p.id] = pts;
    p.score += pts;
  }
  r.phase = 'reveal';
  r.endsAt = null;
  r.result = { winner, reason, accuserId, accusedId, guessId, points };
}

function resumePlay(state, ctx) {
  const r = state.round;
  r.phase = 'play';
  r.accusation = null;
  r.endsAt = ctx.setTimer(Math.max(1000, r.remainingMs ?? 0) / ctx.timeScale);
  r.remainingMs = null;
}

// ctx.setTimer ölçekli süre bekler; kalan süre gerçek ms olarak saklanıyor, bu yüzden geri ölçekle.
function pauseClock(state, ctx) {
  const r = state.round;
  r.remainingMs = Math.max(0, r.endsAt - ctx.now);
  ctx.clearTimer();
}

function resolveAccusation(state, ctx) {
  const r = state.round;
  const acc = r.accusation;
  const voters = active(state).filter((p) => p.id !== acc.targetId);
  const allYes = voters.every((p) => acc.votes[p.id] === true);
  if (!allYes) return resumePlay(state, ctx);
  if (isSpy(state, acc.targetId)) finishRound(state, ctx, { winner: 'town', reason: 'caught', accuserId: acc.byId, accusedId: acc.targetId });
  else finishRound(state, ctx, { winner: 'spy', reason: 'wrong_accuse', accuserId: acc.byId, accusedId: acc.targetId });
}

function resolveFinalVote(state, ctx) {
  const r = state.round;
  const tally = {};
  for (const target of Object.values(r.finalVotes)) tally[target] = (tally[target] ?? 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  // Kimse oy vermediyse veya eşitlik varsa casus kazanır.
  if (!top || (sorted[1] && sorted[1][1] === top[1])) {
    return finishRound(state, ctx, { winner: 'spy', reason: top ? 'tie' : 'no_votes' });
  }
  const accusedId = top[0];
  if (isSpy(state, accusedId)) finishRound(state, ctx, { winner: 'town', reason: 'final_caught', accusedId });
  else finishRound(state, ctx, { winner: 'spy', reason: 'final_wrong', accusedId });
}

function maybeResolveAccusation(state, ctx) {
  const acc = state.round.accusation;
  const voters = active(state).filter((p) => p.id !== acc.targetId);
  // Biri Hayır derse beklemeye gerek yok.
  if (voters.some((p) => acc.votes[p.id] === false) || voters.every((p) => p.id in acc.votes)) resolveAccusation(state, ctx);
}

function maybeResolveFinal(state, ctx) {
  if (active(state).every((p) => p.id in state.round.finalVotes)) resolveFinalVote(state, ctx);
}

export default {
  id: 'spyfall',
  name: 'Casus Kim?',
  minPlayers: 3,
  maxPlayers: 12,
  defaultSettings: { rounds: 3, minutes: 8, spies: 1 },

  validateSettings(s) {
    const clamp = (v, lo, hi, def) => {
      const n = Math.round(num(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    return {
      rounds: clamp(s.rounds, 1, 10, 3),
      minutes: clamp(s.minutes, 3, 15, 8),
      spies: clamp(s.spies, 1, 2, 1),
    };
  },

  setup({ players, settings, ctx }) {
    const state = {
      settings,
      players: players.map((p) => ({ id: p.id, name: p.name, score: 0, left: false })),
      gameKey: randomInt(1e9), // istemci yeni oyunu ayırt etsin; RNG'den üretilmez (iç durumu sızdırırdı)
      usedLocations: [],
      round: null,
      over: false,
    };
    startRound(state, ctx);
    return state;
  },

  action(state, playerId, action, ctx) {
    const r = state.round;
    const me = findPlayer(state, playerId);
    if (!me) throw new GameError('Bu oyunda değilsin.');

    switch (action.type) {
      case 'qaDone': {
        if (r.phase !== 'play') throw new GameError('Şu an soru sırası yok.');
        const qa = r.qa;
        if (playerId !== qa.askerId && playerId !== qa.targetId) throw new GameError('Bu soru-cevap senin değil.');
        if (!qa.done.includes(playerId)) qa.done.push(playerId);
        if (qa.done.includes(qa.askerId) && qa.done.includes(qa.targetId)) newPair(state, ctx.rng, qa.targetId, qa.askerId);
        return;
      }
      case 'accuse': {
        if (r.phase !== 'play') throw new GameError('Şu an suçlama yapılamaz.');
        if (r.accusersUsed.includes(playerId)) throw new GameError('Bu turdaki suçlama hakkını kullandın.');
        const target = findPlayer(state, str(action.targetId));
        if (!target || target.id === playerId) throw new GameError('Geçersiz oyuncu.');
        r.accusersUsed.push(playerId);
        pauseClock(state, ctx);
        r.phase = 'accuse';
        r.accusation = { byId: playerId, targetId: target.id, votes: { [playerId]: true } };
        r.endsAt = ctx.setTimer(ACCUSE_VOTE_MS);
        maybeResolveAccusation(state, ctx);
        return;
      }
      case 'vote': {
        if (r.phase !== 'accuse') throw new GameError('Şu an oylama yok.');
        const acc = r.accusation;
        if (playerId === acc.targetId) throw new GameError('Kendi suçlamana oy veremezsin.');
        if (playerId in acc.votes) throw new GameError('Oyunu zaten verdin.');
        acc.votes[playerId] = action.yes === true;
        maybeResolveAccusation(state, ctx);
        return;
      }
      case 'guess': {
        if (r.phase !== 'play') throw new GameError('Şu an tahmin yapılamaz.');
        if (!isSpy(state, playerId)) throw new GameError('Sadece casus mekân tahmin edebilir.');
        const guess = LOCATIONS.find((l) => l.id === str(action.locationId));
        if (!guess) throw new GameError('Böyle bir mekân yok.');
        if (guess.id === r.locationId) finishRound(state, ctx, { winner: 'spy', reason: 'guess', guessId: guess.id });
        else finishRound(state, ctx, { winner: 'town', reason: 'bad_guess', guessId: guess.id });
        return;
      }
      case 'finalVote': {
        if (r.phase !== 'final') throw new GameError('Şu an oylama yok.');
        if (playerId in r.finalVotes) throw new GameError('Oyunu zaten verdin.');
        const target = findPlayer(state, str(action.targetId));
        if (!target || target.id === playerId) throw new GameError('Geçersiz oyuncu.');
        r.finalVotes[playerId] = target.id;
        maybeResolveFinal(state, ctx);
        return;
      }
      case 'next': {
        if (r.phase !== 'reveal') throw new GameError('Tur henüz bitmedi.');
        if (playerId !== ctx.hostId) throw new GameError('Sonraki turu oda sahibi başlatır.');
        if (r.number >= state.settings.rounds || active(state).length < 3) { state.over = true; return; }
        startRound(state, ctx);
        return;
      }
      default:
        throw new GameError('Bilinmeyen eylem.');
    }
  },

  tick(state, ctx) {
    const r = state.round;
    if (r.phase === 'play') {
      r.phase = 'final';
      r.finalVotes = {};
      r.endsAt = ctx.setTimer(FINAL_VOTE_MS);
    } else if (r.phase === 'accuse') {
      resolveAccusation(state, ctx); // oy vermeyen "Hayır" sayılır
    } else if (r.phase === 'final') {
      resolveFinalVote(state, ctx);
    }
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p || p.left) return;
    p.left = true;
    const r = state.round;
    if (active(state).length < 3) {
      if (r.phase !== 'reveal') finishRound(state, ctx, { winner: 'none', reason: 'not_enough' });
      state.over = true;
      return;
    }
    if (r.phase === 'reveal') return;
    if (r.qa && (r.qa.askerId === playerId || r.qa.targetId === playerId)) {
      const stay = r.qa.askerId === playerId ? r.qa.targetId : r.qa.askerId;
      newPair(state, ctx.rng, findPlayer(state, stay) ? stay : active(state)[0]?.id, playerId);
    }
    if (r.spyIds.includes(playerId) && r.spyIds.every((id) => state.players.find((x) => x.id === id)?.left)) {
      return finishRound(state, ctx, { winner: 'none', reason: 'spy_left' });
    }
    if (r.phase === 'accuse') {
      if (r.accusation.targetId === playerId) return resumePlay(state, ctx);
      delete r.accusation.votes[playerId];
      maybeResolveAccusation(state, ctx);
    } else if (r.phase === 'final') {
      delete r.finalVotes[playerId];
      for (const [voter, target] of Object.entries(r.finalVotes)) if (target === playerId) delete r.finalVotes[voter];
      maybeResolveFinal(state, ctx);
    }
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const r = state.round;
    const me = state.players.find((p) => p.id === playerId);
    const inGame = me && !me.left;
    const revealed = r.phase === 'reveal';
    const spy = inGame && isSpy(state, playerId);
    const location = LOCATIONS.find((l) => l.id === r.locationId);

    const view = {
      gameKey: state.gameKey,
      round: r.number,
      totalRounds: state.settings.rounds,
      phase: r.phase,
      over: state.over,
      endsAt: r.endsAt,
      paused: r.phase === 'accuse',
      firstAskerId: r.firstAskerId,
      qa: r.qa && { number: r.qa.number, askerId: r.qa.askerId, targetId: r.qa.targetId, done: r.qa.done },
      players: state.players.filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, score: p.score })),
      locations: LOCATION_LIST,
      me: inGame
        ? spy
          ? { spy: true, spyCount: r.spyIds.length } // 2 casusta casuslar birbirini bilmez
          : { spy: false, location: { id: location.id, name: location.name, emoji: location.emoji }, role: r.roles[playerId] }
        : null,
      canAccuse: inGame && r.phase === 'play' && !r.accusersUsed.includes(playerId),
      accusation: r.accusation && {
        byId: r.accusation.byId,
        targetId: r.accusation.targetId,
        votedCount: Object.keys(r.accusation.votes).length,
        voterCount: active(state).length - 1,
        myVote: r.accusation.votes[playerId] ?? null,
      },
      finalVote: r.phase === 'final'
        ? { votedCount: Object.keys(r.finalVotes).length, voterCount: active(state).length, myVote: r.finalVotes[playerId] ?? null }
        : null,
      result: null,
    };

    if (revealed) {
      view.result = {
        ...r.result,
        spyIds: r.spyIds,
        location: { id: location.id, name: location.name, emoji: location.emoji },
        roles: r.roles,
        finalVotes: r.finalVotes,
        guess: r.result.guessId ? LOCATION_LIST.find((l) => l.id === r.result.guessId) : null,
      };
    }
    return view;
  },
};
