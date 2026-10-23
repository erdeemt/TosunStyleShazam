// Tosun Shazam (online) "monkey" sürüsü: birkaç tohum × 2/4/8/12 oyuncu aynı sunucuda eş zamanlı, oyun sonuna kadar.
// Host şarkıları prep ile verir (test cevapları bilir); botlar rastgele tahmin/geç/pes eder, bazen doğru cevabı yazar,
// bitirdikten sonra da eylem dener, arada geçersiz eylem gönderir; bazı botlar hiç oynamaz (süre dolsun diye).
// ShazamReferee her mesajdan sonra değişmezleri denetler (puan kuralları, bonus, skor = tur puanları toplamı, adım ≤ 4,
// bitiren oyuncunun durumu değişmez, tur herkes bitince ya da süre dolunca açılır, gizlilik, totalRounds ≤ şarkı sayısı).
// Tohum sayısı: SWARM_SEEDS=10 npm test   |   tek tohum: SWARM_SEED=7 node --test tests/swarm/swarm-shazam-monkey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, createRng } from './swarm-lib.mjs';
import { ShazamReferee, shazamMonkey, makeTracks, sendPrep, summarizeS } from './swarm-shazam-lib.mjs';

const SEEDS = process.env.SWARM_SEED
  ? [Number(process.env.SWARM_SEED)]
  : Array.from({ length: Number(process.env.SWARM_SEEDS) || 3 }, (_, i) => 301 + i);
const SIZES = [2, 4, 8, 12];
const SCALE = 0.01; // tur 45 sn ≈ 0.45 sn

async function playGame(srv, seed, n, log) {
  const rng = createRng(seed * 100 + n);
  const trackCount = 4 + rng.int(rng.next() < 0.3 ? 5 : 40); // bazen ayardaki şarkı sayısından az şarkı (≥ 4: başlatma koşulu)
  const tracks = makeTracks(trackCount, seed * 13 + n, { tag: '' });
  const settings = { rounds: 3 + rng.int(6), roundSeconds: rng.pick([45, 90]), start: rng.next() < 0.5 ? 'begin' : 'random' };
  const { bots, host, code } = await makeRoom(srv.wsUrl, 'shazam', n, `S${seed}n${n}-`);
  const ref = new ShazamReferee({ label: `seed=${seed} n=${n} code=${code} tracks=${trackCount} ${JSON.stringify(settings)}`, tracks, noLeaves: true }).attachAll(bots);
  await sendPrep(host, tracks);
  host.send({ t: 'settings', settings });
  await host.waitRoom((r) => r.settings.rounds === settings.rounds && r.settings.start === settings.start);
  const stop = { done: false };
  const stats = {};
  // Profil karışımı: 2 kişide biri bazen hiç oynamaz (süre dolsun), kalabalıkta keskin/pes eden/boşta karışık.
  const profiles = bots.map((_, i) => (i === 0 ? 'random' : rng.pick(['random', 'random', 'sharp', 'quitter', n > 2 ? 'idle' : 'random'])));
  if (n === 2 && rng.next() < 0.5) profiles[1] = 'idle';
  const loops = bots.map((b, i) => shazamMonkey(b, { rng: createRng(seed * 1000 + n * 17 + i), ref, stop, stats, profile: profiles[i] }));
  host.send({ t: 'start' });
  try {
    await host.waitRoom((r) => r.phase === 'over', { timeout: 60_000 });
    await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'over', { timeout: 3000 })));
  } finally {
    stop.done = true;
    await Promise.all(loops);
  }
  const violations = ref.finalChecks();
  const expectedRounds = Math.min(settings.rounds, trackCount - 3); // en az 3 şarkı çalınmadan kalır (elemeyle bulunamasın)
  if (ref.stats.overs !== 1) violations.push(`[${ref.label}] oyun sonu bir kez görülmeli (${ref.stats.overs})`);
  if (ref.stats.reveals !== expectedRounds) violations.push(`[${ref.label}] ${expectedRounds} tur bekleniyordu, ${ref.stats.reveals} açıklama görüldü`);
  // Son skorlar: bütün botlar aynı skoru görür
  const finals = bots.map((b) => JSON.stringify(b.view.players.map((p) => [p.id, p.score])));
  if (new Set(finals).size !== 1) violations.push(`[${ref.label}] botlar farklı son skor gördü`);
  log.push(`${summarizeS(ref)} profiles=${profiles.join(',')} actions=${JSON.stringify(stats)}`);
  bots.forEach((b) => b.close());
  return { violations, ref, stats };
}

for (const seed of SEEDS) {
  test(`shazam monkey seed=${seed}: 2/4/8/12 oyuncu eş zamanlı, oyun sonuna kadar, değişmezler`, async () => {
    const srv = await startProbedServer({ timeScale: SCALE, seed });
    const log = [];
    try {
      const results = await Promise.all(SIZES.map((n) => playGame(srv, seed, n, log)));
      const violations = results.flatMap((r) => r.violations);
      const internal = srv.log().match(/(hatası|Lobi hatası)[^\n]*/g) ?? [];
      assert.deepEqual(internal, [], 'sunucu logunda hata olmamalı');
      assert.deepEqual(violations, [], `değişmez ihlali (seed=${seed}):\n${violations.join('\n')}`);
      // Monkey gerçekten oynadı mı: doğru tahmin, bonus, süre dolması ve herkes bitince açılma görülmeli
      const sum = (k) => results.reduce((s, r) => s + r.ref.stats[k], 0);
      assert.ok(sum('wins') > 0 && sum('bonus') > 0, 'bilen/bonus görülmeli');
      assert.ok(sum('timerReveals') + sum('earlyReveals') >= SIZES.length * 3, 'yeterince tur oynanmalı');
      assert.ok(results.some((r) => (r.stats.afterDone ?? 0) > 0), 'bitirdikten sonra eylem denenmeli');
      await srv.waitProbe((p) => p.rooms === 0, 5000);
    } finally {
      console.log(log.join('\n'));
      await srv.stop();
    }
  });
}
