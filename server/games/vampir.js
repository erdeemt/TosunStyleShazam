// 🧛 Vampir Köylü. Kurallar: PLAN.md §4.3.
// Gizli bilgi: roller (vampirler birbirini bilir), gece seçimleri, gözcü sonuçları oyun bitene kadar sahibi dışında kimseye gitmez.
// Ölüm duyurularında rol yok.
import { randomInt } from 'node:crypto';
import { GameError, num, str } from '../errors.js';

const NOMINATION_MS = 30_000; // destek gelmezse aday bu süre sonra düşer
const TRIAL_VOTE_MS = 30_000;

// Anlatıcı ara fazları (PLAN.md §4.3): kısa, herkeste eş zamanlı "sinema" anları. Bu sırada oyun eylemi kabul edilmez;
// gece/gündüz/savunma süreleri bunlardan yemez. Süreler lobideki TIME_SCALE ile ölçeklenir (setTimer).
export const NARRATION_MS = { intro: 6000, dusk: 5000, dawn: 8000, verdict: 7000 };
export const INTERMISSIONS = ['dusk', 'dawn', 'verdict'];
const inIntermission = (state) => INTERMISSIONS.includes(state.phase);

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

// Ara faza geç. narration herkese aynı gider (view): sadece zaten açık bilgiler (ölen, oy sayısı), rol/seçim/oy yok.
function narrate(state, ctx, phase, kind, extra = {}) {
  const ms = NARRATION_MS[kind];
  state.phase = phase;
  state.endsAt = ctx.setTimer(ms);
  state.narration = {
    kind,
    night: state.night,
    deadId: null,
    trial: null,
    ...extra,
    startedAt: state.endsAt - Math.round(ms * (ctx.timeScale ?? 1)),
    endsAt: state.endsAt,
  };
}

// Gün bitti (süre, host ya da asılma): akşam anlatımı, sonra gece.
function startDusk(state, ctx, kind = 'dusk') {
  state.nomination = null;
  state.trial = null;
  ctx.clearTimer('nomination');
  narrate(state, ctx, 'dusk', kind, { night: state.night + 1 }); // gelecek gecenin numarası
}

function startDay(state, ctx) {
  state.phase = 'day';
  state.narration = null;
  state.endsAt = ctx.setTimer(state.settings.dayMinutes * 60_000);
}

function startNight(state, ctx) {
  state.night += 1;
  state.phase = 'night';
  state.narration = null;
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
    if (p.role === 'vampir' && alivePlayer(state, target)) tally[target] = (tally[target] ?? 0) + 1;
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
  // Önce sabah anlatımı (ölüm animasyonu); kazanma kontrolü anlatım bitince (finishDawn). Süre her durumda aynı.
  narrate(state, ctx, 'dawn', 'dawn', { deadId: victimId });
}

function finishDawn(state, ctx) {
  if (checkWin(state, ctx)) return;
  startDay(state, ctx);
}

// Asılan deli: karar anlatımı bitince (ya da bu sırada biri ayrılırsa) deli kazanır.
function pendingJester(state) {
  const lt = state.lastTrial;
  return state.phase === 'verdict' && lt?.hanged && player(state, lt.targetId)?.role === 'deli';
}

function finishVerdict(state, ctx) {
  if (!state.lastTrial?.hanged) return resumeDay(state, ctx);
  if (pendingJester(state)) return endGame(state, ctx, 'jester');
  if (checkWin(state, ctx)) return;
  startDusk(state, ctx);
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
  // Kısa kapanış anlatımı (istemci kazananı view.result'tan duyurur; bitiş saati yok).
  state.narration = { kind: 'over', night: state.night, deadId: null, trial: null, startedAt: ctx.now ?? Date.now(), endsAt: null };
}

function nominationActive(state, now) {
  const n = state.nomination;
  return n && now < n.expiresAt ? n : null;
}

function startTrial(state, ctx, targetId, supportById) {
  state.dayRemainingMs = Math.max(0, state.endsAt - ctx.now);
  state.phase = 'trial';
  state.trial = { targetId, votes: {}, supportById: supportById ?? null };
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
  state.narration = null;
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
  const hanged = !!target && yes * 2 > voters.length;
  if (hanged) kill(state, target.id, 'hanged');
  state.lastTrial = { targetId: state.trial.targetId, hanged, yes, voters: voters.length };
  state.trial = null;
  // Karar anlatımı: sadece zaten açık olan sonuç (Evet sayısı / oy hakkı), kimin ne oy verdiği yok.
  // Sonra: asılmadıysa gündüz kaldığı yerden, asıldıysa (deli → deli kazanır) kazanma kontrolü ya da akşam.
  narrate(state, ctx, 'verdict', 'verdict', { trial: { ...state.lastTrial } });
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
      phase: 'dusk',
      night: 0,
      narration: null,
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
    startDusk(state, ctx, 'intro'); // "Köye hoş geldiniz…" → 1. gece
    return state;
  },

  action(state, playerId, action, ctx) {
    if (state.phase === 'over') throw new GameError('Oyun bitti.');
    if (inIntermission(state)) throw new GameError('Anlatıcı konuşuyor, az bekle… 🎙️');
    // Oda sahibi ölmüş olsa da tartışmayı bitirebilir (yönetim düğmesi, oyun eylemi değil).
    if (action.type === 'endDay') {
      if (state.phase !== 'day') throw new GameError('Şu an gündüz tartışması yok.');
      if (playerId !== ctx.hostId) throw new GameError('Geceye oda sahibi geçirir.');
      if (nominationActive(state, ctx.now)) throw new GameError('Bekleyen bir aday var; önce destek süresi dolsun.');
      return startDusk(state, ctx);
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
        return startTrial(state, ctx, nom.targetId, me.id);
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
    if (state.phase === 'dusk') startNight(state, ctx);
    else if (state.phase === 'night') resolveNight(state, ctx);
    else if (state.phase === 'dawn') finishDawn(state, ctx);
    else if (state.phase === 'verdict') finishVerdict(state, ctx);
    else if (state.phase === 'day') startDusk(state, ctx); // süre bitti, kimse asılmadı
    else if (state.phase === 'trial') startTrialVote(state, ctx);
    else if (state.phase === 'trialVote') resolveTrial(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = player(state, playerId);
    if (!p || !p.alive || state.phase === 'over') return;
    kill(state, playerId, 'left');
    delete state.nightPicks[playerId];
    // Ayrılan kişiye yapılmış seçimler geçersiz: vampirler/doktor yeniden seçsin (öldürme boşa gitmesin).
    // Gözcünün bakışı zaten kullanıldı, o kalır.
    for (const [id, target] of Object.entries(state.nightPicks)) {
      if (target === playerId && player(state, id)?.role !== 'gozcu') delete state.nightPicks[id];
    }
    if (state.nomination && (state.nomination.byId === playerId || state.nomination.targetId === playerId)) state.nomination = null;
    if (pendingJester(state)) return endGame(state, ctx, 'jester'); // deli zaten asıldı; ayrılan biri bunu değiştirmez
    if (checkWin(state, ctx)) return;
    if (state.phase === 'night') return maybeEndNight(state, ctx);
    if (state.trial) {
      if (state.trial.targetId === playerId) return resumeDay(state, ctx);
      delete state.trial.votes[playerId];
      if (state.phase === 'trialVote') maybeEndTrialVote(state, ctx);
    }
  },

  // Lobi botları (server/lobby.js scheduleBots, PLAN.md §3.8): tek telefonla deneme için basit, biraz rastgele oyuncular.
  // Sunucuda çalışır; görünüme hiçbir şey eklemez (rolleri sadece state'te). Eylemler insanlarla aynı action() yolundan geçer.
  bots: {
    // Şu an yapacak bir şey varsa { key, delayMs }. Aynı key bekliyorken gecikme sıfırlanmaz.
    plan(state, botId, { mem, rng, now }) {
      const me = alivePlayer(state, botId);
      if (!me || state.phase === 'over' || inIntermission(state)) return null; // ölüler ve anlatıcı konuşurken kimse bir şey yapmaz
      const between = (lo, hi) => lo + Math.floor(rng.next() * (hi - lo));
      const stage = `${state.night}:${state.log.length}`; // aynı gün içindeki her yargılama ayrı
      switch (state.phase) {
        case 'night':
          if (botId in state.nightPicks) return null; // gözcü tek bakar; diğerleri de bir kez seçer
          return { key: `night:${state.night}`, delayMs: between(2000, 8000) };
        case 'day': {
          const nom = nominationActive(state, now);
          if (nom) {
            if (nom.byId === botId || nom.targetId === botId) return null;
            const k = `support:${nom.at}:${nom.targetId}`;
            mem[k] ??= rng.next() < 0.35;
            return mem[k] ? { key: k, delayMs: between(3000, 10000) } : null;
          }
          const k = `nominate:${state.night}`;
          mem[k] ??= rng.next() < 0.15; // günde bir kez zar
          if (!mem[k] || state.nominatedToday.includes(botId)) return null;
          return { key: k, delayMs: between(10_000, 40_000) };
        }
        case 'trial':
          return state.trial.targetId === botId ? { key: `defense:${stage}`, delayMs: between(5000, 10_000) } : null;
        case 'trialVote':
          if (state.trial.targetId === botId || botId in state.trial.votes) return null;
          return { key: `vote:${stage}`, delayMs: between(2000, 8000) };
        default:
          return null;
      }
    },
    // Zamanı gelince güncel duruma göre eylem.
    act(state, botId, { rng, now }) {
      const me = alivePlayer(state, botId);
      if (!me || inIntermission(state)) return null;
      switch (state.phase) {
        case 'night': {
          const targets = nightTargets(state, me);
          if (!targets.length) return null;
          let pick = rng.pick(targets);
          if (me.role === 'vampir') {
            const allyPicks = state.players
              .filter((p) => p.alive && p.role === 'vampir' && p.id !== botId && targets.includes(state.nightPicks[p.id]))
              .map((p) => state.nightPicks[p.id]);
            if (allyPicks.length) pick = rng.pick(allyPicks);
          }
          return { type: 'nightPick', targetId: pick };
        }
        case 'day': {
          if (nominationActive(state, now)) return { type: 'support' };
          const others = alive(state).filter((p) => p.id !== botId);
          return others.length ? { type: 'nominate', targetId: rng.pick(others).id } : null;
        }
        case 'trial':
          return { type: 'endDefense' };
        case 'trialVote':
          return { type: 'trialVote', yes: rng.next() < 0.5 };
        default:
          return null;
      }
    },
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
      // Anlatıcı (ara fazlar + oyun sonu): herkese birebir aynı, sadece açık bilgi.
      narration: inIntermission(state) || over ? state.narration ?? null : null,
      nomination: nom && { byId: nom.byId, targetId: nom.targetId, expiresAt: nom.expiresAt },
      trial: state.trial && {
        targetId: state.trial.targetId,
        supportById: state.trial.supportById ?? null,
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
