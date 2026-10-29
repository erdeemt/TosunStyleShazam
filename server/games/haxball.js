// ⚽ Tosun Top — HaxBall tarzı gerçek zamanlı futbol. Kurallar ve ağ tasarımı: PLAN.md §4.8.
// Sunucu yetkilidir: fizik burada 60 Hz çalışır (lobi `realtime` kancasıyla sürer), istemciden sadece
// yön + şut girdisi gelir. Konumlar ~30 Hz "frame" mesajıyla, yavaş değişen durum (skor, faz, takımlar) `view` ile gider.
import { GameError, num, str } from '../errors.js';
import {
  HZ, RED, BLUE, PITCHES, createWorld, step, resetKickoff, removePlayer, setInput,
} from '../../public/haxball-physics.js';

const SEND_HZ = 30;
const GOAL_PAUSE_TICKS = Math.round(2.5 * HZ); // gol sevinci; sonra başlama vuruşu
const DISCONNECT_REMOVE_TICKS = 5 * HZ; // bağlantısı kopan oyuncunun diski bu kadar sonra sahadan kalkar
const INPUT_STALE_TICKS = Math.round(1.5 * HZ); // girdi (kalp atışı) gelmezse oyuncu durur
const OVERTIME_MAX_MIN = 3; // altın gol en fazla bu kadar sürer, sonra berabere
const TEAM_KEYS = ['red', 'blue'];
const DEBUG = process.env.TEST_GAMES === '1'; // e2e için yerleştirme kancası; üretimde kapalı

const MINUTES = [2, 3, 5];
const GOAL_LIMITS = [3, 5, 0]; // 0 = sınırsız
const SIZES = ['auto', 'small', 'medium'];

const teamOf = (t) => (t === 'red' ? RED : t === 'blue' ? BLUE : null);

function balance(ids, teams, rng) {
  // Seçmeyenleri az olan takıma koy (eşitse rastgele).
  const count = { red: 0, blue: 0 };
  for (const id of ids) if (teams[id] === 'red' || teams[id] === 'blue') count[teams[id]]++;
  for (const id of ids) {
    if (teams[id]) continue;
    const t = count.red < count.blue ? 'red' : count.blue < count.red ? 'blue' : (rng.int(2) === 0 ? 'red' : 'blue');
    teams[id] = t;
    count[t]++;
  }
  return teams;
}

function frameClock(state) {
  if (state.overtime) return -Math.floor((state.clock - state.duration) / HZ); // eksi: uzatma süresi (sayar)
  return Math.max(0, Math.ceil((state.duration - state.clock) / HZ));
}

function finish(state, reason) {
  const [r, b] = state.score;
  state.phase = 'over';
  state.result = { winner: r > b ? 'red' : b > r ? 'blue' : 'draw', reason };
}

// Bir takımın sahada hiç oyuncusu kalmazsa maç biter (diğer takım hükmen kazanır).
function checkForfeit(state) {
  if (state.phase === 'over') return;
  const n = [0, 0];
  for (const d of state.world.players) n[d.team]++;
  if (n[RED] > 0 && n[BLUE] > 0) return;
  state.phase = 'over';
  state.result = { winner: n[RED] ? 'red' : n[BLUE] ? 'blue' : 'draw', reason: 'forfeit' };
}

function dropDisc(state, id) {
  const slot = state.slots.get(id);
  if (!slot || slot.removed) return false;
  slot.removed = true;
  removePlayer(state.world, id);
  state.discById.delete(id);
  state.ver++;
  checkForfeit(state);
  return true;
}

export default {
  id: 'haxball',
  name: 'Tosun Top',
  minPlayers: 2,
  maxPlayers: 8,
  defaultSettings: { minutes: 3, goals: 3, size: 'auto' },

  validateSettings(s) {
    const minutes = MINUTES.includes(num(s.minutes)) ? num(s.minutes) : 3;
    const goals = GOAL_LIMITS.includes(num(s.goals)) ? num(s.goals) : 3;
    const size = SIZES.includes(str(s.size)) ? str(s.size) : 'auto';
    return { minutes, goals, size };
  },

  // Bekleme odası: takımlar room.prep.teams'te { playerId: 'red' | 'blue' | 'spec' }.
  initialPrep: () => ({ teams: {} }),
  prepInfo: (prep) => ({ teams: { ...prep.teams } }),

  lobbyAction(prep, playerId, data, { isHost, playerIds, rng }) {
    const teams = {};
    for (const id of playerIds) if (prep.teams[id]) teams[id] = prep.teams[id]; // ayrılanlar silinir
    if (data.type === 'team') {
      const team = str(data.team);
      if (!['red', 'blue', 'spec'].includes(team)) throw new GameError('Geçersiz takım.');
      teams[playerId] = team;
    } else if (data.type === 'shuffle') {
      if (!isHost) throw new GameError('Takımları sadece oda sahibi karıştırır.');
      const field = rng.shuffle(playerIds.filter((id) => teams[id] !== 'spec'));
      const flip = rng.int(2);
      field.forEach((id, i) => { teams[id] = TEAM_KEYS[(i + flip) % 2]; });
    } else {
      throw new GameError('Bilinmeyen işlem.');
    }
    return { teams };
  },

  canStart(prep, _settings, players) {
    if (!players) return null;
    const ids = players.filter((p) => p.connected).map((p) => p.id);
    const teams = balance(ids, Object.fromEntries(ids.filter((id) => prep.teams[id]).map((id) => [id, prep.teams[id]])), { int: () => 0 });
    const red = ids.filter((id) => teams[id] === 'red').length;
    const blue = ids.filter((id) => teams[id] === 'blue').length;
    if (!red || !blue) return 'İki takımda da en az bir oyuncu olmalı.';
    return null;
  },

  setup({ players, settings, prep, rng, ctx }) {
    const ids = players.map((p) => p.id);
    const teams = balance(ids, Object.fromEntries(ids.filter((id) => prep?.teams?.[id]).map((id) => [id, prep.teams[id]])), rng);
    const field = players.filter((p) => teams[p.id] === 'red' || teams[p.id] === 'blue');
    if (!field.some((p) => teams[p.id] === 'red') || !field.some((p) => teams[p.id] === 'blue')) {
      throw new GameError('İki takımda da en az bir oyuncu olmalı.');
    }
    const pitchId = settings.size === 'auto' ? (field.length <= 4 ? 'small' : 'medium') : settings.size;
    const world = createWorld(pitchId, field.map((p) => ({ id: p.id, team: teamOf(teams[p.id]) })));
    const scale = ctx?.timeScale ?? 1;
    const state = {
      world,
      settings: { ...settings, size: pitchId },
      slots: new Map(players.map((p) => [p.id, {
        id: p.id, name: p.name, team: teams[p.id] === 'spec' ? 'spec' : teams[p.id], removed: false, offAt: null, lastInput: 0,
      }])),
      discById: new Map(world.players.map((d) => [d.id, d])),
      ver: 1, // disk listesi değişince artar (kare dizisinin sırası)
      phase: 'kickoff', // kickoff | play | goal | over
      score: [0, 0],
      goals: [], // { team, id, name, own, sec }
      clock: 0, // adım; gol arasında durur
      duration: Math.max(HZ, Math.round(settings.minutes * 60 * HZ * scale)),
      overtimeMax: Math.max(HZ, Math.round(OVERTIME_MAX_MIN * 60 * HZ * scale)),
      goalLimit: settings.goals,
      overtime: false,
      pause: 0,
      endAfterPause: false,
      kickoffTeam: 'red',
      lastGoal: null,
      result: null,
      tick: 0,
    };
    return state;
  },

  // Lobi bunu 60 Hz sürer (PLAN.md §3.7). step true dönerse lobi görünümleri yeniden yayınlar.
  realtime: {
    hz: HZ,
    sendHz: SEND_HZ,
    step(state) {
      if (state.phase === 'over') return false;
      let changed = false;
      const tick = ++state.tick;
      for (const slot of state.slots.values()) {
        if (slot.removed) continue;
        const d = state.discById.get(slot.id);
        if (!d) continue;
        if (slot.offAt != null && tick - slot.offAt >= DISCONNECT_REMOVE_TICKS) { changed = dropDisc(state, slot.id) || changed; continue; }
        if (tick - slot.lastInput > INPUT_STALE_TICKS && (d.ix || d.iy || d.kick)) setInput(d, 0, 0, false);
      }
      if (state.phase === 'over') return true;

      const world = state.world;
      const ev = step(world);
      if (state.phase === 'kickoff' && world.kickoff == null) { state.phase = 'play'; changed = true; }

      if (state.phase === 'goal') {
        if (--state.pause <= 0) {
          if (state.endAfterPause) { finish(state, state.overtime ? 'golden' : 'limit'); return true; }
          resetKickoff(world, teamOf(state.kickoffTeam));
          state.phase = 'kickoff';
          changed = true;
        }
        return changed;
      }

      state.clock++;
      if (ev.goal >= 0) {
        const team = TEAM_KEYS[ev.goal];
        state.score[ev.goal]++;
        const toucher = world.lastTouch >= 0 ? world.players[world.lastTouch] : null;
        const slot = toucher ? state.slots.get(toucher.id) : null;
        const goal = { team, id: slot?.id ?? null, name: slot?.name ?? null, own: toucher ? toucher.team !== ev.goal : false, sec: Math.floor(state.clock / HZ) };
        state.goals.push(goal);
        state.lastGoal = goal;
        world.goalsEnabled = false;
        state.phase = 'goal';
        state.pause = GOAL_PAUSE_TICKS;
        state.kickoffTeam = TEAM_KEYS[1 - ev.goal]; // yiyen takım başlar
        state.endAfterPause = state.overtime || (state.goalLimit > 0 && state.score[ev.goal] >= state.goalLimit);
        return true;
      }
      if (!state.overtime && state.clock >= state.duration) {
        if (state.score[0] === state.score[1]) state.overtime = true;
        else finish(state, 'time');
        return true;
      }
      if (state.overtime && state.clock - state.duration >= state.overtimeMax) { finish(state, 'time'); return true; }
      return changed;
    },

    // Herkese aynı kısa kare: k = sunucu adımı, v = disk listesi sürümü, c = saat (sn; eksi = uzatma),
    // b = top [x,y], p = oyuncular [x,y,...] (view.discs sırasıyla), f = şut tuşu basılı olanların bit maskesi.
    // Konumlar 0.1 birim hassasiyetle tamsayı (×10).
    frame(state) {
      const w = state.world;
      const p = new Array(w.players.length * 2);
      let f = 0;
      for (let i = 0; i < w.players.length; i++) {
        const d = w.players[i];
        p[2 * i] = Math.round(d.x * 10);
        p[2 * i + 1] = Math.round(d.y * 10);
        if (d.kick) f |= 1 << i;
      }
      return { k: state.tick, v: state.ver, c: frameClock(state), b: [Math.round(w.ball.x * 10), Math.round(w.ball.y * 10)], p, f };
    },
  },

  // Hızlı yol: { t:'input', x, y, k } (lobi görünüm üretmeden buraya yollar). Asla hata fırlatmaz.
  input(state, playerId, msg) {
    if (state.phase === 'over') return;
    const d = state.discById.get(playerId);
    if (!d) return;
    setInput(d, num(msg.x), num(msg.y), msg.k === 1 || msg.k === true);
    state.slots.get(playerId).lastInput = state.tick;
  },

  // Bağlantı koptu/geri geldi (oyun sırasında). Kopan oyuncu durur; 5 sn içinde dönmezse diski kalkar.
  onConnection(state, playerId, connected) {
    const slot = state.slots.get(playerId);
    if (!slot || slot.removed) return;
    slot.offAt = connected ? null : state.tick;
    const d = state.discById.get(playerId);
    if (d && !connected) setInput(d, 0, 0, false);
  },

  onPlayerLeave(state, playerId) {
    dropDisc(state, playerId);
  },

  action(state, playerId, action) {
    // Sadece testlerde: e2e topu/oyuncuyu bir yere koyabilsin (TEST_GAMES=1). Üretimde bilinmeyen eylem.
    if (DEBUG && action.type === 'debugPlace') {
      const w = state.world;
      const pos = (v, lim) => Math.max(-lim, Math.min(lim, Number.isFinite(num(v)) ? num(v) : 0));
      if (action.ball && typeof action.ball === 'object') {
        w.ball.x = pos(action.ball.x, w.pitch.w); w.ball.y = pos(action.ball.y, w.pitch.h);
        w.ball.vx = 0; w.ball.vy = 0; w.ball.px = w.ball.x; w.ball.py = w.ball.y;
      }
      const d = state.discById.get(playerId);
      if (d && action.me && typeof action.me === 'object') { d.x = pos(action.me.x, w.pitch.outerW); d.y = pos(action.me.y, w.pitch.outerH); d.vx = 0; d.vy = 0; }
      if (state.phase === 'kickoff') { w.kickoff = null; state.phase = 'play'; }
      return;
    }
    throw new GameError('Bilinmeyen eylem.');
  },

  isOver: (state) => state.phase === 'over',

  view(state, playerId) {
    const slot = state.slots.get(playerId);
    const discs = state.world.players.map((d) => {
      const s = state.slots.get(d.id);
      return { id: d.id, name: s.name, team: TEAM_KEYS[d.team] };
    });
    const roster = { red: [], blue: [], spec: [] };
    for (const s of state.slots.values()) roster[s.team === 'spec' ? 'spec' : s.team].push({ id: s.id, name: s.name, removed: s.removed });
    return {
      phase: state.phase,
      score: state.score,
      goals: state.goals,
      lastGoal: state.lastGoal,
      discs,
      ver: state.ver,
      roster,
      myTeam: slot && slot.team !== 'spec' && !slot.removed ? slot.team : null,
      removed: !!slot?.removed,
      pitch: state.settings.size,
      minutes: state.settings.minutes,
      goalLimit: state.goalLimit,
      overtime: state.overtime,
      kickoffTeam: state.kickoffTeam,
      result: state.result,
      hz: HZ,
      sendHz: SEND_HZ,
      tick: state.tick,
    };
  },
};

export { PITCHES };
