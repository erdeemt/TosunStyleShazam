// 🧛 Vampir Aşama 2 — anlatıcı ara fazları (server/games/vampir.js: dusk/dawn/verdict) sanal saatle + istemci
// anlatıcı satırları (public/games/vampir-flow.js) ve sahne tarifi. Anlatım herkese aynı, gizli bilgi içermez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vampir, { NARRATION_MS } from '../../server/games/vampir.js';
import { createRng } from '../../server/rng.js';
import { GameError } from '../../server/errors.js';
import { narrationBeats, beatAt, deathStyle, DEATH_STYLES, cuesBetween } from '../../public/games/vampir-flow.js';
import { describe as describeScene } from '../../public/games/vampir-3d.js';

const ROLE_RE = /vampir|koylu|doktor|gozcu|deli|role|savedId|doctorPick|votes|nightPicks|seer|isVampire|lastProtected|allies/;

function game(n = 7, settings = {}, seed = 3) {
  let now = 1_000_000;
  const timers = new Map();
  const rng = createRng(seed);
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Oyuncu${i}` }));
  const ctx = {
    get now() { return now; }, rng, hostId: 'p0', timeScale: 1,
    setTimer(ms, name = 'main') { timers.set(name, now + ms); return now + ms; },
    clearTimer(name = 'main') { if (name === 'main' && arguments.length === 0) timers.clear(); else timers.delete(name); },
    log() {},
  };
  const state = vampir.setup({ players, settings: vampir.validateSettings({ ...vampir.defaultSettings, ...settings }), rng, ctx });
  const g = {
    state, ctx, players,
    get now() { return now; },
    advance(ms) { now += ms; },
    // ana zamanlayıcıyı doldur
    tick() { now = Math.max(now, timers.get('main') ?? now); timers.delete('main'); vampir.tick(state, ctx); },
    act(id, action) { vampir.action(state, id, action, ctx); },
    by: (role) => state.players.filter((p) => p.role === role),
    views: () => players.map((p) => vampir.view(state, p.id)).concat([vampir.view(state, 'izleyici')]),
  };
  return g;
}

function assertNarrationPublic(g) {
  const vs = g.views();
  const texts = vs.map((v) => JSON.stringify(v.narration));
  assert.equal(new Set(texts).size, 1, 'anlatım herkese birebir aynı olmalı');
  assert.doesNotMatch(texts[0], ROLE_RE, `anlatımda gizli bilgi: ${texts[0]}`);
  return vs[0].narration;
}

function playNight(g, victimId, protectId) {
  for (const p of g.state.players.filter((x) => x.alive)) {
    const me = vampir.view(g.state, p.id).me;
    let target = me.nightTargets.find((id) => id !== victimId) ?? me.nightTargets[0];
    if (p.role === 'vampir') target = victimId;
    if (p.role === 'doktor') target = protectId ?? target;
    g.act(p.id, { type: 'nightPick', targetId: target });
  }
}

test('açılış: dusk/intro anlatımı, eylem kabul edilmez; süre dolunca 1. gece', () => {
  const g = game();
  assert.equal(g.state.phase, 'dusk');
  const n = assertNarrationPublic(g);
  assert.equal(n.kind, 'intro');
  assert.equal(n.night, 1);
  assert.equal(n.endsAt - n.startedAt, NARRATION_MS.intro);
  assert.equal(g.state.endsAt, n.endsAt);
  assert.throws(() => g.act('p1', { type: 'nightPick', targetId: 'p2' }), GameError);
  assert.throws(() => g.act('p0', { type: 'endDay' }), /Anlatıcı/);
  g.tick();
  assert.equal(g.state.phase, 'night');
  assert.equal(g.state.night, 1);
  assert.equal(vampir.view(g.state, 'p0').narration, null);
});

test('sabah: önce dawn anlatımı (ölen, rol yok, kurtarılan yok), sonra gündüz; gündüz süresi tam', () => {
  const g = game(8, { vampires: 2 });
  g.tick();
  const victim = g.state.players.find((p) => p.role === 'koylu');
  playNight(g, victim.id);
  assert.equal(g.state.phase, 'dawn');
  const n = assertNarrationPublic(g);
  assert.deepEqual(Object.keys(n).sort(), ['deadId', 'endsAt', 'kind', 'night', 'startedAt', 'trial']);
  assert.equal(n.kind, 'dawn');
  assert.equal(n.deadId, victim.id);
  assert.equal(n.endsAt - n.startedAt, NARRATION_MS.dawn);
  assert.throws(() => g.act(g.by('vampir')[0].id, { type: 'nominate', targetId: 'p1' }), GameError);
  for (const id of g.by('vampir').map((p) => p.id)) assert.equal(vampir.bots.plan(g.state, id, { mem: {}, rng: createRng(1), now: g.now }), null);
  g.tick();
  assert.equal(g.state.phase, 'day');
  assert.equal(g.state.endsAt - g.now, g.state.settings.dayMinutes * 60_000);
  assert.equal(vampir.view(g.state, 'p0').narration, null);
});

test('doktor kurtarırsa: dawn deadId null, kimin saldırıya uğradığı/kurtarıldığı görünmez', () => {
  const g = game(8, { vampires: 2 });
  g.tick();
  const victim = g.state.players.find((p) => p.role === 'koylu');
  playNight(g, victim.id, victim.id);
  const n = assertNarrationPublic(g);
  assert.equal(n.deadId, null);
  assert.ok(!JSON.stringify(g.views().map((v) => ({ ...v, me: null }))).includes('savedId'));
});

function toTrial(g, targetId) {
  const alive = g.state.players.filter((p) => p.alive && p.id !== targetId);
  const [nominator, supporter] = alive;
  g.act(nominator.id, { type: 'nominate', targetId });
  g.act(supporter.id, { type: 'support' });
  assert.equal(vampir.view(g.state, 'p0').trial.supportById, supporter.id);
  g.act(targetId, { type: 'endDefense' });
  return alive;
}

test('karar: asılmazsa verdict (Evet sayısı, oylar yok) → gündüz kaldığı yerden', () => {
  const g = game(7);
  g.tick();
  playNight(g, g.state.players.find((p) => p.role === 'koylu').id);
  g.tick();
  g.advance(30_000);
  const target = g.state.players.find((p) => p.alive && p.role === 'koylu');
  const voters = toTrial(g, target.id);
  const remaining = g.state.dayRemainingMs;
  voters.forEach((p, i) => g.act(p.id, { type: 'trialVote', yes: i < 2 }));
  assert.equal(g.state.phase, 'verdict');
  const n = assertNarrationPublic(g);
  assert.deepEqual(n.trial, { targetId: target.id, hanged: false, yes: 2, voters: voters.length });
  assert.equal(vampir.view(g.state, 'p0').trial, null, 'karar sırasında trial nesnesi yok (oylar gizli)');
  g.tick();
  assert.equal(g.state.phase, 'day');
  assert.equal(g.state.endsAt - g.now, remaining, 'karar anlatımı tartışma süresinden yemez');
});

test('karar: asılırsa verdict → dusk → gece; deli asılırsa karar bitince deli kazanır (biri ayrılsa da)', () => {
  const g = game(7);
  g.tick();
  playNight(g, g.state.players.find((p) => p.role === 'koylu').id);
  g.tick();
  const target = g.state.players.find((p) => p.alive && p.role === 'koylu');
  toTrial(g, target.id).forEach((p) => g.act(p.id, { type: 'trialVote', yes: true }));
  assert.equal(g.state.phase, 'verdict');
  assert.equal(assertNarrationPublic(g).trial.hanged, true);
  g.tick();
  assert.equal(g.state.phase, 'dusk');
  const dusk = assertNarrationPublic(g);
  assert.equal(dusk.kind, 'dusk');
  assert.equal(dusk.night, 2);
  g.tick();
  assert.equal(g.state.phase, 'night');
  assert.equal(g.state.night, 2);

  const h = game(7, {}, 11);
  h.tick();
  const deli = h.by('deli')[0];
  playNight(h, h.state.players.find((p) => p.role === 'koylu').id);
  h.tick();
  assert.ok(deli.alive, "tohum: deli gece ölmemeli");
  toTrial(h, deli.id).forEach((p) => h.act(p.id, { type: 'trialVote', yes: true }));
  assert.equal(h.state.phase, 'verdict', 'önce karar anlatımı');
  const leaver = h.state.players.find((p) => p.alive && p.role === 'koylu');
  vampir.onPlayerLeave(h.state, leaver.id, h.ctx);
  assert.equal(h.state.phase, 'over');
  assert.equal(h.state.winner, 'jester');
  assert.equal(vampir.view(h.state, 'p0').narration.kind, 'over');
});

test('gece oyunu bitirirse önce sabah anlatımı, sonra over', () => {
  const g = game(5, { deli: false, doktor: false, gozcu: false }); // 1 vampir, 4 köylü
  g.tick();
  const vamp = g.by('vampir')[0];
  const town = () => g.state.players.filter((p) => p.alive && p.role !== 'vampir');
  playNight(g, town()[0].id);
  g.tick();
  const t = town()[0];
  toTrial(g, t.id).forEach((p) => g.act(p.id, { type: 'trialVote', yes: true }));
  g.tick(); // verdict → dusk
  g.tick(); // dusk → night 2
  playNight(g, town()[0].id); // 1 vampir vs 1 köylü
  assert.equal(g.state.phase, 'dawn');
  assert.equal(g.state.winner, null);
  g.tick();
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.winner, 'vampires');
  assert.ok(vamp.alive);
});

test('istemci: anlatıcı satırları, sunucu saatine göre satır, ölüm türü herkeste aynı', () => {
  const name = (id) => ({ a: 'Ayşe', b: 'Can' })[id] ?? '?';
  const dawn = { kind: 'dawn', night: 2, deadId: 'a', trial: null, startedAt: 1000, endsAt: 9000 };
  const beats = narrationBeats(dawn, name);
  assert.equal(beats[0].title, 'Sabah oldu…');
  assert.ok(beats.some((b) => b.title === 'Ayşe bu gece öldü.'));
  assert.equal(beatAt(beats, dawn, 1000).index, 0);
  assert.equal(beats[beatAt(beats, dawn, 1000 + 8000 * 0.5).index].title, 'Ayşe bu gece öldü.');
  assert.ok(narrationBeats({ ...dawn, deadId: null }, name).some((b) => b.title === 'Bu gece kimse ölmedi!'));
  const verdict = { kind: 'verdict', night: 1, deadId: null, trial: { targetId: 'b', yes: 4, voters: 6, hanged: true }, startedAt: 0, endsAt: 7000 };
  const vb = narrationBeats(verdict, name);
  assert.equal(vb[0].title, 'Oylama: 4/6 Evet');
  assert.ok(vb.some((b) => b.title.includes('Can') && b.title.includes('fırlatıldı')));
  assert.ok(narrationBeats({ ...verdict, trial: { ...verdict.trial, hanged: false, yes: 2 } }, name).some((b) => b.title === 'Can kurtuldu!'));
  assert.equal(narrationBeats({ kind: 'over', startedAt: 0, endsAt: null }, name, 'town')[1].title, 'Köy kazandı!');
  for (let k = 0; k < 30; k++) assert.equal(deathStyle(k, 1), deathStyle(k, 1));
  assert.equal(new Set(Array.from({ length: 60 }, (_, k) => deathStyle(k, k % 4))).size, DEATH_STYLES.length);
  // ipuçları: aday, destek → yargılama, oylama
  const base = { gameKey: 1, phase: 'day', nomination: null, trial: null };
  assert.match(cuesBetween(base, { ...base, nomination: { byId: 'b', targetId: 'a', expiresAt: 5 } }, name)[0][1], /Ayşe aday/);
  const tr = { ...base, phase: 'trial', trial: { targetId: 'a', supportById: 'b' } };
  assert.match(cuesBetween({ ...base, nomination: { byId: 'b', targetId: 'a', expiresAt: 5 } }, tr, name)[0][1], /Can destekledi/);
  assert.match(cuesBetween(tr, { ...tr, phase: 'trialVote' }, name)[0][1], /Oylama başladı/);
});

test('sahne tarifi: ara fazlarda anlatım + ölüm türü herkeste aynı; akşam gökyüzü gece, sabah gündüz', () => {
  const g = game(8, { vampires: 2 });
  assert.equal(describeScene(vampir.view(g.state, 'p0')).sky, 'night', 'açılış akşam');
  g.tick();
  playNight(g, g.state.players.find((p) => p.role === 'koylu').id);
  const descs = g.views().map((v) => JSON.stringify(describeScene(v, { cardOpen: true })));
  assert.equal(new Set(descs).size, 1, 'sabah anlatımında kart açık olsa da sahne herkeste aynı');
  const d = JSON.parse(descs[0]);
  assert.equal(d.sky, 'day');
  assert.ok(DEATH_STYLES.includes(d.narr.style));
  assert.doesNotMatch(JSON.stringify(d.narr), ROLE_RE);
});
