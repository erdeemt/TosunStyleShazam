// Casus Kim? "monkey" sürüsü: birçok tohum × 3/6/10/12 oyuncu, rastgele ama kurallara uygun oyun, oyun bitene kadar.
// Her mesajdan sonra SpyfallReferee değişmezleri kontrol eder (skor, casus sayısı, faz geçişi, gizli bilgi sızıntısı).
// Tohum sayısı: SWARM_SEEDS=10 npm test   |   tek tohum: SWARM_SEED=7 node --test tests/swarm/swarm-spyfall-monkey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, SpyfallReferee, monkey, createRng, summarize } from './swarm-lib.mjs';

const SEEDS = process.env.SWARM_SEED
  ? [Number(process.env.SWARM_SEED)]
  : Array.from({ length: Number(process.env.SWARM_SEEDS) || 4 }, (_, i) => 101 + i);
const SIZES = [3, 6, 10, 12];

async function playGame(srv, seed, n, log) {
  const rng = createRng(seed * 100 + n);
  const rounds = 1 + rng.int(3);
  const spies = n >= 9 && rng.next() < 0.6 ? 2 : 1;
  const minutes = 3 + rng.int(6);
  const { bots, host, code } = await makeRoom(srv.wsUrl, 'spyfall', n, `S${seed}n${n}-`);
  const ref = new SpyfallReferee({ label: `seed=${seed} n=${n} code=${code} rounds=${rounds} spies=${spies} min=${minutes}`, spiesSetting: spies }).attachAll(bots);
  host.send({ t: 'settings', settings: { rounds, spies, minutes } });
  await host.waitRoom((r) => r.settings.rounds === rounds && r.settings.spies === spies && r.settings.minutes === minutes);
  const stop = { done: false };
  const oracle = {};
  const loops = bots.map((b, i) => monkey(b, { rng: createRng(seed * 1000 + n * 13 + i), oracle, stop }));
  host.send({ t: 'start' });
  try {
    await host.waitRoom((r) => r.phase === 'over', { timeout: 30_000 });
    await Promise.all(bots.map((b) => b.waitView((v) => v.over, { timeout: 3000 })));
  } finally {
    stop.done = true;
    await Promise.all(loops);
  }
  // Sonuç tutarlılığı: final skorlar = turların puan toplamı
  const reveals = new Map();
  for (const m of host.messages) if (m.t === 'view' && m.view.result) reveals.set(m.view.round, m.view.result);
  assert.equal(reveals.size, host.view.round, `${ref.label}: her tur açıklanmalı`);
  for (const p of host.view.players) {
    const sum = [...reveals.values()].reduce((s, r) => s + (r.points[p.id] ?? 0), 0);
    assert.equal(p.score, sum, `${ref.label}: ${p.name} skoru tur puanlarının toplamı değil`);
  }
  assert.ok(host.view.round === rounds || host.view.players.length < 3, `${ref.label}: tur sayısı ayarla uyuşmalı (${host.view.round}/${rounds})`);
  const violations = ref.finalChecks();
  log.push(summarize(ref));
  bots.forEach((b) => b.close());
  return violations;
}

for (const seed of SEEDS) {
  test(`monkey seed=${seed}: 3/6/10/12 oyuncu eş zamanlı, oyun sonuna kadar, değişmezler`, async () => {
    const srv = await startProbedServer({ timeScale: 0.002, seed });
    const log = [];
    try {
      const results = await Promise.all(SIZES.map((n) => playGame(srv, seed, n, log)));
      const violations = results.flat();
      const internal = srv.log().match(/(hatası|Lobi hatası)[^\n]*/g) ?? [];
      assert.deepEqual(internal, [], 'sunucu logunda hata olmamalı');
      assert.deepEqual(violations, [], `değişmez ihlali (seed=${seed}):\n${violations.join('\n')}`);
      // Herkes çıktıktan sonra odalar silinmeli (koltuk süresi 120 sn × 0.002 = 240 ms)
      await srv.waitProbe((p) => p.rooms === 0, 5000);
    } finally {
      console.log(log.join('\n'));
      await srv.stop();
    }
  });
}
