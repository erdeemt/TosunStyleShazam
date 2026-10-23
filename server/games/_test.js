// Test oyunu: her oyuncunun gizli bir sayısı var, sırayla "press" yapılır, süre dolunca veya
// herkes basınca biter. Lobi testleri (gizli bilgi sızıntısı, sıra, zamanlayıcı, yeniden bağlanma) için.
import { GameError, num } from '../errors.js';

export default {
  id: '_test',
  name: 'Test',
  minPlayers: 2,
  maxPlayers: 12,
  defaultSettings: { seconds: 60 },

  validateSettings(s) {
    const seconds = Math.min(600, Math.max(5, Math.round(num(s.seconds) || 60)));
    return { seconds };
  },

  setup({ players, settings, rng, ctx }) {
    const state = {
      players: players.map((p) => ({ ...p, secret: `secret-${p.id.slice(0, 8)}-${rng.int(1e9)}`, pressed: false })),
      turn: 0,
      endsAt: 0,
      over: false,
      reason: null,
    };
    state.endsAt = ctx.setTimer(settings.seconds * 1000);
    return state;
  },

  action(state, playerId, action) {
    if (state.over) throw new GameError('Oyun bitti.');
    if (action.type !== 'press') throw new GameError('Bilinmeyen eylem.');
    const current = state.players[state.turn];
    if (current.id !== playerId) throw new GameError('Sıra sende değil.');
    current.pressed = true;
    state.turn++;
    if (state.turn >= state.players.length) { state.over = true; state.reason = 'all'; }
  },

  tick(state) {
    state.over = true;
    state.reason = 'timeout';
  },

  onPlayerLeave(state, playerId) {
    const idx = state.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return;
    state.players.splice(idx, 1);
    if (idx < state.turn) state.turn--;
    if (state.turn >= state.players.length) { state.over = true; state.reason = 'all'; }
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const me = state.players.find((p) => p.id === playerId);
    return {
      mySecret: me?.secret ?? null,
      turnPlayerId: state.players[state.turn]?.id ?? null,
      players: state.players.map((p) => ({ id: p.id, name: p.name, pressed: p.pressed })),
      endsAt: state.endsAt,
      over: state.over,
      reason: state.reason,
    };
  },
};
