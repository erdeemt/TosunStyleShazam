// 🧛 Vampir Köylü. Kurallar: PLAN.md §4.3.
// Gizli bilgi: roller (vampirler birbirini bilir), gece seçimleri, gözcü sonuçları oyun bitene kadar sahibi dışında kimseye gitmez.
// Ölüm duyurularında rol yok.
import { randomInt } from 'node:crypto';
import { GameError, num, str } from '../errors.js';

const NOMINATION_MS = 30_000; // destek gelmezse aday bu süre sonra düşer
const TRIAL_VOTE_MS = 30_000;

export const ROLES = {
  vampir: { name: 'Vampir', icon: '🧛', team: 'vampires' },
  koylu: { name: 'Köylü', icon: '🧑‍🌾', team: 'town' },
  doktor: { name: 'Doktor', icon: '🩺', team: 'town' },
  gozcu: { name: 'Gözcü', icon: '🔮', team: 'town' },
  deli: { name: 'Deli', icon: '🤡', team: 'jester' },
};

export function autoVampires(n) {
  return n <= 7 ? 1 : n <= 10 ? 2 : 3;
}

// Elle seçilen vampir sayısı için üst sınır: oyuncuların üçte birinden az (5–6 kişide 1, 7–9'da 2, 10+ 3).
// Daha fazlası ilk geceden sonra oyunu bitirir.
export function maxVampires(n) {
  return Math.max(1, Math.floor((n - 1) / 3));
}

const alive = (state) => state.players.filter((p) => p.alive);
const player = (state, id) => state.players.find((p) => p.id === id);
const alivePlayer = (state, id) => {
  const p = player(state, id);
  return p && p.alive ? p : null;
};

// ---------- Faz geçişleri ----------

function startNight(state, ctx) {
  state.night += 1;
  state.phase = 'night';
  state.nightPicks = {}; // playerId -> targetId (rolüne göre anlamı farklı)
  state.nomination = null;
  state.trial = null;
  state.nominatedToday = [];
  ctx.clearTimer('nomination');
  state.endsAt = ctx.setTimer(state.settings.nightSeconds * 1000);
}

function resolveNight(state, ctx) {
  const picks = state.nightPicks;
  const tally = {};
  let doctorPick = null;
  for (const p of alive(state)) {
    const target = picks[p.id];
    if (!target) continue;
    if (p.role === 'vampir') tally[target] = (tally[target] ?? 0) + 1;
    if (p.role === 'doktor') doctorPick = target;
  }
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  let victimId = top.length ? (top.length === 1 ? top[0] : ctx.rng.pick(top)) : null;
  const saved = victimId && victimId === doctorPick;
  if (saved || !alivePlayer(state, victimId)) victimId = null;
  state.lastProtected = doctorPick; // üst üste aynı kişi korunamaz
  state.log.push({ night: state.night, victimId, savedId: saved ? doctorPick : null, doctorPick, vampireTally: tally });

  if (victimId) kill(state, victimId, 'night');
  state.announcement = { night: state.night, deadId: victimId };
  state.lastTrial = null; // dünün oylama sonucu yeni güne taşınmasın (asılma bilgisi gece boyunca kalır)
  if (checkWin(state, ctx)) return;
  state.phase = 'day';
  state.endsAt = ctx.setTimer(state.settings.dayMinutes * 60_000);
}

function kill(state, id, cause) {
  const p = player(state, id);
  if (!p || !p.alive) return;
  p.alive = false;
  p.death = { cause, night: state.night };
}

function checkWin(state, ctx) {
  const living = alive(state);
  const vamps = living.filter((p) => p.role === 'vampir').length;
  const others = living.length - vamps;
  let winner = null;
  if (vamps === 0) winner = 'town';
  else if (vamps >= others) winner = 'vampires';
  if (!winner) return false;
  endGame(state, ctx, winner);
  return true;
}

function endGame(state, ctx, winner) {
  ctx.clearTimer();
  state.phase = 'over';
  state.endsAt = null;
  state.winner = winner;
  state.winnerIds = state.players
    .filter((p) => (winner === 'jester' ? p.role === 'deli' : ROLES[p.role].team === winner))
    .map((p) => p.id);
}

function nominationActive(state, now) {
  const n = state.nomination;
  return n && now < n.expiresAt ? n : null;
}

function startTrial(state, ctx, targetId) {
  state.dayRemainingMs = Math.max(0, state.endsAt - ctx.now);
  state.phase = 'trial';
  state.trial = { targetId, votes: {} };
  state.nomination = null;
  ctx.clearTimer('nomination');
  state.endsAt = ctx.setTimer(state.settings.defenseSeconds * 1000);
}

function startTrialVote(state, ctx) {
  state.phase = 'trialVote';
  state.endsAt = ctx.setTimer(TRIAL_VOTE_MS);
}

function resumeDay(state, ctx) {
  state.phase = 'day';
  state.trial = null;
  // Kalan süre gerçek ms; setTimer ölçekli süre bekler.
  state.endsAt = ctx.setTimer(Math.max(1000, state.dayRemainingMs ?? 0) / ctx.timeScale);
  state.dayRemainingMs = null;
}

function trialVoters(state) {
  return alive(state).filter((p) => p.id !== state.trial.targetId);
}

function resolveTrial(state, ctx) {
  const voters = trialVoters(state);
  const yes = voters.filter((p) => state.trial.votes[p.id] === true).length;
  const target = alivePlayer(state, state.trial.targetId);
  state.log.push({ night: state.night, trial: state.trial.targetId, yes, voters: voters.length, votes: { ...state.trial.votes } });
  if (!target || yes * 2 <= voters.length) {
    state.lastTrial = { targetId: state.trial.targetId, hanged: false, yes, voters: voters.length };
    return resumeDay(state, ctx);
  }
  kill(state, target.id, 'hanged');
  state.lastTrial = { targetId: target.id, hanged: true, yes, voters: voters.length };
  if (target.role === 'deli') return endGame(state, ctx, 'jester');
  if (checkWin(state, ctx)) return;
  startNight(state, ctx);
}

function maybeEndNight(state, ctx) {
  if (alive(state).every((p) => p.id in state.nightPicks)) resolveNight(state, ctx);
}

function maybeEndTrialVote(state, ctx) {
  if (trialVoters(state).every((p) => p.id in state.trial.votes)) resolveTrial(state, ctx);
}

// Bu gece kimi seçebilir? (Tüm roller için aynı sayıda düğme görünür; geçersizler pasif.)
function nightTargets(state, me) {
  return alive(state)
    .filter((p) => {
      if (me.role === 'vampir') return p.role !== 'vampir';
      if (me.role === 'doktor') return p.id !== state.lastProtected;
      return p.id !== me.id;
    })
    .map((p) => p.id);
}

// ---------- Modül ----------

export default {
  id: 'vampir',
  name: 'Vampir Köylü',
  minPlayers: 5,
  maxPlayers: 12,
  defaultSettings: { dayMinutes: 4, defenseSeconds: 30, nightSeconds: 60, vampires: 0, doktor: true, gozcu: true, deli: true },

  validateSettings(s) {
    const clamp = (v, lo, hi, def) => {
      const n = Math.round(num(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    return {
      dayMinutes: clamp(s.dayMinutes, 2, 8, 4),
      defenseSeconds: clamp(s.defenseSeconds, 15, 60, 30),
      nightSeconds: clamp(s.nightSeconds, 30, 120, 60),
      vampires: clamp(s.vampires, 0, 3, 0), // 0 = otomatik
      doktor: bool(s.doktor, true),
      gozcu: bool(s.gozcu, true),
      deli: bool(s.deli, true),
    };
  },

  setup({ players, settings, rng, ctx }) {
    const n = players.length;
    // Vampirler her zaman yarıdan az olmalı.
    const vampCount = settings.vampires ? Math.min(settings.vampires, maxVampires(n)) : autoVampires(n);
    const roles = Array(vampCount).fill('vampir');
    for (const special of ['doktor', 'gozcu', 'deli']) if (settings[special] && roles.length < n) roles.push(special);
    while (roles.length < n) roles.push('koylu');
    const shuffled = rng.shuffle(players);
    const state = {
      settings,
      players: shuffled.map((p, i) => ({ id: p.id, name: p.name, role: roles[i], alive: true, death: null }))
        .sort((a, b) => players.findIndex((x) => x.id === a.id) - players.findIndex((x) => x.id === b.id)),
      roleCounts: roles.reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {}),
      phase: 'night',
      night: 0,
      endsAt: null,
      nightPicks: {},
      lastProtected: null,
      seerResults: [], // { night, targetId, isVampire }
      announcement: null,
      nomination: null,
      nominatedToday: [],
      trial: null,
      lastTrial: null,
      dayRemainingMs: null,
      log: [],
      winner: null,
      winnerIds: [],
      gameKey: randomInt(1e9), // RNG'den üretilmez (iç durumu sızdırırdı)
    };
    startNight(state, ctx);
    return state;
  },

  action(state, playerId, action, ctx) {
    if (state.phase === 'over') throw new GameError('Oyun bitti.');
    // Oda sahibi ölmüş olsa da tartışmayı bitirebilir (yönetim düğmesi, oyun eylemi değil).
    if (action.type === 'endDay') {
      if (state.phase !== 'day') throw new GameError('Şu an gündüz tartışması yok.');
      if (playerId !== ctx.hostId) throw new GameError('Geceye oda sahibi geçirir.');
      if (nominationActive(state, ctx.now)) throw new GameError('Bekleyen bir aday var; önce destek süresi dolsun.');
      return startNight(state, ctx);
    }
    const me = alivePlayer(state, playerId);
    if (!me) throw new GameError('Ölüler konuşmaz. 🤫');
    const targetId = str(action.targetId);

    switch (action.type) {
      case 'nightPick': {
        if (state.phase !== 'night') throw new GameError('Şu an gece değil.');
        // Hata metinleri bilerek genel: yandaki kişi ekranda okuyunca rol anlaşılmasın.
        if (!nightTargets(state, me).includes(targetId)) throw new GameError('Bu seçim yapılamaz.');
        if (me.role === 'gozcu') {
          if (me.id in state.nightPicks) return; // gözcü tek bakar; tekrar dokunuş sessizce yok sayılır
          state.seerResults.push({ night: state.night, targetId, isVampire: player(state, targetId).role === 'vampir' });
        }
        state.nightPicks[me.id] = targetId; // vampir/doktor/sahte görev seçimini gece bitene kadar değiştirebilir
        return maybeEndNight(state, ctx);
      }
      case 'nominate': {
        if (state.phase !== 'day') throw new GameError('Aday sadece gündüz tartışmasında gösterilir.');
        if (nominationActive(state, ctx.now)) throw new GameError('Şu an bekleyen bir aday var.');
        if (state.nominatedToday.includes(me.id)) throw new GameError('Bugün aday gösterme hakkını kullandın.');
        const target = alivePlayer(state, targetId);
        if (!target || target.id === me.id) throw new GameError('Geçersiz aday.');
        state.nominatedToday.push(me.id);
        // Destek gelmezse aday kendi zamanlayıcısıyla düşer ve herkese yayınlanır.
        state.nomination = { byId: me.id, targetId: target.id, at: ctx.now, expiresAt: ctx.setTimer(NOMINATION_MS, 'nomination') };
        return;
      }
      case 'support': {
        if (state.phase !== 'day') throw new GameError('Şu an destek verilemez.');
        const nom = nominationActive(state, ctx.now);
        if (!nom) throw new GameError('Destekleyecek aday yok.');
        if (me.id === nom.byId || me.id === nom.targetId) throw new GameError('Bu adayı sen destekleyemezsin.');
        return startTrial(state, ctx, nom.targetId);
      }
      case 'endDefense': {
        if (state.phase !== 'trial') throw new GameError('Şu an savunma yok.');
        if (me.id !== state.trial.targetId) throw new GameError('Savunmayı sadece aday bitirebilir.');
        return startTrialVote(state, ctx);
      }
      case 'trialVote': {
        if (state.phase !== 'trialVote') throw new GameError('Şu an oylama yok.');
        if (me.id === state.trial.targetId) throw new GameError('Kendi yargılamana oy veremezsin.');
        if (me.id in state.trial.votes) throw new GameError('Oyunu zaten verdin.');
        state.trial.votes[me.id] = action.yes === true;
        return maybeEndTrialVote(state, ctx);
      }
      default:
        throw new GameError('Bilinmeyen eylem.');
    }
  },

  tick(state, ctx, name = 'main') {
    if (name === 'nomination') { state.nomination = null; return; }
    if (state.phase === 'night') resolveNight(state, ctx);
    else if (state.phase === 'day') startNight(state, ctx); // süre bitti, kimse asılmadı
    else if (state.phase === 'trial') startTrialVote(state, ctx);
    else if (state.phase === 'trialVote') resolveTrial(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = player(state, playerId);
    if (!p || !p.alive || state.phase === 'over') return;
    kill(state, playerId, 'left');
    delete state.nightPicks[playerId];
    if (state.nomination && (state.nomination.byId === playerId || state.nomination.targetId === playerId)) state.nomination = null;
    if (checkWin(state, ctx)) return;
    if (state.phase === 'night') return maybeEndNight(state, ctx);
    if (state.trial) {
      if (state.trial.targetId === playerId) return resumeDay(state, ctx);
      delete state.trial.votes[playerId];
      if (state.phase === 'trialVote') maybeEndTrialVote(state, ctx);
    }
  },

  isOver: (state) => state.phase === 'over',

  view(state, playerId) {
    const me = player(state, playerId);
    const over = state.phase === 'over';
    const nom = state.phase === 'day' ? nominationActive(state, Date.now()) : null;
    const view = {
      gameKey: state.gameKey,
      phase: state.phase,
      night: state.night,
      endsAt: state.endsAt,
      // Herkesin bildiği bilgiler
      players: state.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, death: p.death })),
      roleCounts: state.roleCounts,
      announcement: state.announcement,
      lastTrial: state.lastTrial,
      nomination: nom && { byId: nom.byId, targetId: nom.targetId, expiresAt: nom.expiresAt },
      trial: state.trial && {
        targetId: state.trial.targetId,
        votedCount: Object.keys(state.trial.votes).length,
        voterCount: trialVoters(state).length,
        myVote: state.trial.votes[playerId] ?? null,
      },
      nightProgress: state.phase === 'night'
        ? { done: alive(state).filter((p) => p.id in state.nightPicks).length, total: alive(state).length }
        : null,
      me: null,
      result: null,
    };

    if (me) {
      const mine = {
        role: me.role,
        alive: me.alive,
        canNominate: me.alive && state.phase === 'day' && !state.nominatedToday.includes(me.id),
      };
      if (me.alive && state.phase === 'night') {
        mine.nightTargets = nightTargets(state, me);
        mine.nightPick = state.nightPicks[me.id] ?? null;
      }
      if (me.role === 'vampir') {
        mine.allies = state.players.filter((p) => p.role === 'vampir' && p.id !== me.id).map((p) => p.id);
        if (state.phase === 'night' && me.alive) {
          mine.allyPicks = Object.fromEntries(mine.allies.filter((id) => id in state.nightPicks).map((id) => [id, state.nightPicks[id]]));
        }
      }
      if (me.role === 'gozcu') mine.seerResults = state.seerResults;
      if (me.role === 'doktor') mine.lastProtected = state.lastProtected;
      view.me = mine;
    }

    if (over) {
      view.result = {
        winner: state.winner,
        winnerIds: state.winnerIds,
        roles: Object.fromEntries(state.players.map((p) => [p.id, p.role])),
        seerResults: state.seerResults,
        log: state.log,
      };
    }
    return view;
  },
};
