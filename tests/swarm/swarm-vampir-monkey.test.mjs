// Vampir Köylü "monkey" sürüsü: birkaç tohum × 5/7/10/12 oyuncu, roller rastgele açık/kapalı, vampir sayısı otomatik/elle;
// rastgele ama kurallara uygun oyun (arada geçersiz ve ölüyken eylem) oyun bitene kadar. Her mesajdan sonra VampirReferee
// değişmezleri denetler; oyun bitince roller açılınca geriye dönük sızıntı taraması + kayıt çapraz kontrolü yapılır.
// Tohum sayısı: SWARM_SEEDS=10 npm test   |   tek tohum: SWARM_SEED=7 node --test tests/swarm/swarm-vampir-monkey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, createRng } from './swarm-lib.mjs';
import { VampirReferee, vampMonkey, summarizeV, FAST } from './swarm-vampir-lib.mjs';

const SEEDS = process.env.SWARM_SEED
  ? [Number(process.env.SWARM_SEED)]
  : Array.from({ length: Number(process.env.SWARM_SEEDS) || 3 }, (_, i) => 201 + i);
const SIZES = [5, 7, 10, 12];
const SCALE = 0.01; // gece 30 sn = 0.3 sn, gündüz 2 dk = 1.2 sn, savunma 0.15 sn, oylama 0.3 sn

async function playGame(srv, seed, n, log) {
  const rng = createRng(seed * 100 + n);
  const settings = {
    ...FAST,
    vampires: rng.next() < 0.5 ? 0 : 1 + rng.int(3),
    doktor: rng.next() < 0.75,
    gozcu: rng.next() < 0.75,
    deli: rng.next() < 0.6,
  };
  const { bots, host, code } = await makeRoom(srv.wsUrl, 'vampir', n, `M${seed}n${n}-`);
  const ref = new VampirReferee({ label: `seed=${seed} n=${n} code=${code} ${JSON.stringify(settings)}` }).attachAll(bots);
  host.send({ t: 'settings', settings });
  await host.waitRoom((r) => Object.entries(settings).every(([k, v]) => r.settings[k] === v));
  const stop = { done: false };
  const stats = {};
  const loops = bots.map((b, i) => vampMonkey(b, { rng: createRng(seed * 1000 + n * 17 + i), stop, stats }));
  host.send({ t: 'start' });
  try {
    await host.waitRoom((r) => r.phase === 'over', { timeout: 60_000 });
    await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'over', { timeout: 3000 })));
  } finally {
    stop.done = true;
    await Promise.all(loops);
  }
  const violations = ref.finalChecks();
  if (ref.stats.overs !== 1) violations.push(`[${ref.label}] oyun sonu bir kez denetlenmeli (${ref.stats.overs})`);
  log.push(`${summarizeV(ref)} actions=${JSON.stringify(stats)}`);
  bots.forEach((b) => b.close());
  return { violations, ref };
}

for (const seed of SEEDS) {
  test(`vampir monkey seed=${seed}: 5/7/10/12 oyuncu eş zamanlı, oyun sonuna kadar, değişmezler`, async () => {
    const srv = await startProbedServer({ timeScale: SCALE, seed });
    const log = [];
    try {
      const results = await Promise.all(SIZES.map((n) => playGame(srv, seed, n, log)));
      const violations = results.flatMap((r) => r.violations);
      const internal = srv.log().match(/(hatası|Lobi hatası)[^\n]*/g) ?? [];
      assert.deepEqual(internal, [], 'sunucu logunda hata olmamalı');
      assert.deepEqual(violations, [], `değişmez ihlali (seed=${seed}):\n${violations.join('\n')}`);
      // monkey gerçekten oynadı mı (gece, yargılama)
      const nights = results.reduce((s, r) => s + r.ref.stats.nights, 0);
      assert.ok(nights >= SIZES.length, `yeterince gece oynanmalı (${nights})`);
      await srv.waitProbe((p) => p.rooms === 0, 5000);
    } finally {
      console.log(log.join('\n'));
      await srv.stop();
    }
  });
}
