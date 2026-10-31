// 🧛 Vampir 3D sahne tarifi (public/games/vampir-3d.js describe): kart kapalıyken rol türevli hiçbir şey yok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe as describeScene, lookOf, HATS, COLORS } from '../../public/games/vampir-3d.js';

const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => ({ id, name: `P${i}`, alive: id !== 'g', death: id === 'g' ? { cause: 'night', night: 1 } : null }));
const base = { gameKey: 1, night: 2, players, roleCounts: { vampir: 2, koylu: 5 }, nomination: null, trial: null };

const vampireView = {
  ...base, phase: 'night',
  me: { role: 'vampir', alive: true, nightTargets: ['c', 'd', 'e', 'f'], nightPick: 'c', allies: ['b'], allyPicks: { b: 'c' } },
};
const villagerView = {
  ...base, phase: 'night',
  me: { role: 'koylu', alive: true, nightTargets: ['a', 'b', 'd', 'e', 'f'], nightPick: 'a' },
};
const seerView = {
  ...base, phase: 'night',
  me: { role: 'gozcu', alive: true, nightTargets: ['a', 'b', 'c', 'e', 'f'], nightPick: 'b', seerResults: [{ night: 1, targetId: 'b', isVampire: true }] },
};

test('kart kapalıyken vampir, köylü, gözcü ve izleyici aynı sahneyi görür', () => {
  const closed = [vampireView, villagerView, seerView, { ...base, phase: 'night', me: null }]
    .map((v) => JSON.stringify(describeScene(v, { cardOpen: false })));
  assert.equal(new Set(closed).size, 1);
  const d = JSON.parse(closed[0]);
  assert.equal(d.sky, 'night');
  assert.ok(d.chars.every((c) => !c.ring && !c.allies));
  assert.ok(d.chars.filter((c) => c.alive).every((c) => c.sleeping));
  assert.equal(d.chars.find((c) => c.id === 'g').sleeping, false);
});

test('kart açıkken: seçim halkası ve müttefik işareti', () => {
  const d = describeScene(vampireView, { cardOpen: true });
  assert.equal(d.chars.find((c) => c.id === 'c').ring, true);
  assert.equal(d.chars.find((c) => c.id === 'c').allies, 1);
  const v = describeScene(villagerView, { cardOpen: true });
  assert.equal(v.chars.find((c) => c.id === 'a').ring, true);
  assert.ok(v.chars.every((c) => !c.allies));
});

test('gündüz: aday ünlemi; yargılama: spot ve herkes sanığa bakar', () => {
  const day = describeScene({ ...base, phase: 'day', me: vampireView.me, nomination: { byId: 'a', targetId: 'd', expiresAt: 0 } }, { cardOpen: true });
  assert.equal(day.sky, 'day');
  assert.equal(day.chars.find((c) => c.id === 'd').nominee, true);
  assert.ok(day.chars.every((c) => !c.ring && !c.allies && !c.sleeping), 'gündüz kart açık olsa da gece işaretleri yok');
  const trial = describeScene({ ...base, phase: 'trialVote', me: null, trial: { targetId: 'e', votedCount: 0, voterCount: 5, myVote: null } });
  assert.equal(trial.spotlight, 'e');
  assert.ok(trial.chars.filter((c) => c.alive && c.id !== 'e').every((c) => c.look === 'accused'));
  assert.equal(trial.chars.find((c) => c.id === 'e').look, 'fire');
});

test('görünüm (renk/şapka) sadece kimlikten, sabit', () => {
  assert.deepEqual(lookOf('abc'), lookOf('abc'));
  const looks = Array.from({ length: 200 }, (_, i) => lookOf(`id-${i}`));
  assert.ok(looks.every((l) => HATS.includes(l.hat) && COLORS.includes(l.color)));
  assert.equal(new Set(looks.map((l) => l.hat)).size, HATS.length, 'tüm şapkalar kullanılabilmeli');
});
