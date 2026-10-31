// 🧛 Vampir bot kancası (server/games/vampir.js bots.plan/act) sanal saatle: lobi zamanlayıcısının aynısını taklit eder
// (aynı key bekliyorsa gecikme sıfırlanmaz). Botların döndürdüğü her eylem kurallarca geçerli olmalı, oyun bitmeli.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vampir from '../../server/games/vampir.js';
import { createRng } from '../../server/rng.js';
import { GameError } from '../../server/errors.js';

function simulate(seed, n, { settings = {}, maxEvents = 20_000 } = {}) {
  let now = 0;
  const gameTimers = new Map(); // isim -> bitiş
  const botTimers = new Map(); // id -> { at, key }
  const ctxFor = (hostId) => ({
    get now() { return now; }, rng, hostId, timeScale: 1,
    setTimer(ms, name = 'main') { gameTimers.set(name, now + ms); return now + ms; },
    clearTimer(name = 'main') { gameTimers.delete(name); },
    log() {},
  });
  const rng = createRng(seed);
  const botRng = createRng(seed + 1000);
  const players = Array.from({ length: n }, (_, i) => ({ id: `bot-${i}`, name: `B${i}` }));
  const ctx = ctxFor(players[0].id);
  const state = vampir.setup({ players, settings: vampir.validateSettings({ ...vampir.defaultSettings, ...settings }), rng, ctx });
  const mem = new Map(players.map((p) => [p.id, {}]));
  const stats = { actions: {}, rejected: 0 };
  const schedule = () => {
    for (const p of players) {
      const plan = vampir.bots.plan(state, p.id, { mem: mem.get(p.id), rng: botRng, now });
      const cur = botTimers.get(p.id);
      if (cur && plan && cur.key === plan.key) continue;
      botTimers.delete(p.id);
      if (plan) {
        assert.ok(plan.delayMs >= 2000 && plan.delayMs <= 40_000, `gecikme ${plan.delayMs}`);
        botTimers.set(p.id, { at: now + plan.delayMs, key: plan.key });
      }
    }
  };
  schedule();
  for (let i = 0; i < maxEvents && state.phase !== 'over'; i++) {
    const evs = [...[...gameTimers].map(([name, at]) => ({ at, game: name })), ...[...botTimers].map(([id, t]) => ({ at: t.at, bot: id }))];
    evs.sort((a, b) => a.at - b.at);
    const ev = evs[0];
    assert.ok(ev, 'olay kalmadı, oyun takıldı');
    now = Math.max(now, ev.at);
    if (ev.game) {
      gameTimers.delete(ev.game);
      vampir.tick(state, ctx, ev.game);
    } else {
      botTimers.delete(ev.bot);
      const action = vampir.bots.act(state, ev.bot, { mem: mem.get(ev.bot), rng: botRng, now });
      if (action) {
        try {
          vampir.action(state, ev.bot, action, ctx);
          stats.actions[action.type] = (stats.actions[action.type] ?? 0) + 1;
        } catch (err) {
          if (!(err instanceof GameError)) throw err;
          stats.rejected++;
        }
      }
    }
    schedule();
  }
  return { state, stats };
}

test('sadece botlarla oyunlar biter; bot eylemleri neredeyse hiç reddedilmez', () => {
  const total = {};
  for (let seed = 1; seed <= 40; seed++) {
    const n = 5 + (seed % 8);
    const { state, stats } = simulate(seed, n, { settings: { dayMinutes: 2 } });
    assert.equal(state.phase, 'over', `seed ${seed}`);
    assert.ok(stats.rejected <= 2, `seed ${seed}: ${stats.rejected} reddedildi`);
    for (const [k, v] of Object.entries(stats.actions)) total[k] = (total[k] ?? 0) + v;
  }
  for (const type of ['nightPick', 'nominate', 'support', 'endDefense', 'trialVote']) assert.ok(total[type] > 0, `${type} hiç yok: ${JSON.stringify(total)}`);
});

const base = (overrides = {}) => {
  const rng = createRng(5);
  const ctx = { now: 0, rng, hostId: 'a', timeScale: 1, setTimer: (ms) => ms, clearTimer() {}, log() {} };
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id, name: id }));
  const state = vampir.setup({ players, settings: vampir.validateSettings({ ...vampir.defaultSettings, vampires: 2, ...overrides }), rng, ctx });
  return { state, ctx };
};
const bctx = (now = 0) => ({ mem: {}, rng: createRng(9), now });

test('ölü bot bir şey yapmaz; gece bir kez seçer', () => {
  const { state } = base();
  const id = state.players[1].id;
  assert.equal(vampir.bots.plan(state, id, bctx()).key, 'night:1');
  state.nightPicks[id] = state.players[2].id;
  assert.equal(vampir.bots.plan(state, id, bctx()), null);
  delete state.nightPicks[id];
  state.players[1].alive = false;
  assert.equal(vampir.bots.plan(state, id, bctx()), null);
  assert.equal(vampir.bots.act(state, id, bctx()), null);
});

test('vampir bot müttefikinin seçimini tercih eder', () => {
  const { state } = base();
  const [v1, v2] = state.players.filter((p) => p.role === 'vampir');
  const victim = state.players.find((p) => p.role !== 'vampir');
  state.nightPicks[v1.id] = victim.id;
  for (let s = 0; s < 20; s++) {
    const a = vampir.bots.act(state, v2.id, { mem: {}, rng: createRng(s), now: 0 });
    assert.deepEqual(a, { type: 'nightPick', targetId: victim.id });
  }
});

test('sanık bot savunmayı bitirir; oylamada oy vermiş bot beklemez', () => {
  const { state } = base();
  state.phase = 'trial';
  state.trial = { targetId: 'c', votes: {} };
  const plan = vampir.bots.plan(state, 'c', bctx());
  assert.ok(plan.key.startsWith('defense:') && plan.delayMs >= 5000 && plan.delayMs < 10_000);
  assert.deepEqual(vampir.bots.act(state, 'c', bctx()), { type: 'endDefense' });
  assert.equal(vampir.bots.plan(state, 'd', bctx()), null);
  state.phase = 'trialVote';
  assert.equal(vampir.bots.plan(state, 'c', bctx()), null);
  assert.ok(vampir.bots.plan(state, 'd', bctx()).key.startsWith('vote:'));
  state.trial.votes.d = true;
  assert.equal(vampir.bots.plan(state, 'd', bctx()), null);
});

test('gündüz: destek zarı aday başına bir kez atılır; aday gösteren/aday destek planlamaz', () => {
  const { state } = base();
  state.phase = 'day';
  state.nomination = { byId: 'a', targetId: 'b', at: 1, expiresAt: 30_000 };
  assert.equal(vampir.bots.plan(state, 'a', bctx(10)), null);
  assert.equal(vampir.bots.plan(state, 'b', bctx(10)), null);
  const mem = {};
  const first = vampir.bots.plan(state, 'c', { mem, rng: createRng(3), now: 10 });
  for (let s = 0; s < 10; s++) assert.deepEqual(vampir.bots.plan(state, 'c', { mem, rng: createRng(s), now: 10 })?.key, first?.key);
  // Süre dolmuş aday desteklenmez
  assert.notEqual(vampir.bots.act(state, 'c', bctx(40_000))?.type, 'support');
});
