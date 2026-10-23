// Tosun Shazam (online) soak testi (varsayılan npm test'te ATLANIR): SOAK=1 npm test  veya
//   SOAK=1 SOAK_SECONDS=120 SOAK_ROOMS=20 SOAK_BOTS=8 node --test tests/swarm/swarm-shazam-soak.test.mjs
// N oda × M bot aynı anda Shazam oynar; oyun biter → host bekleme odasına döner → (bazen prep'i yeniler) → yeniden başlatır.
// Bu sırada oyuncular düşüp geri gelir, ayrılıp izleyici olarak döner, bazıları yeni kimlikle değişir. Test-only sonda ile
// sunucu RSS/heap ve oda sayısı izlenir; sonunda odalar temizlenmeli, bellek makul kalmalı, hakem ihlali olmamalı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, createRng, sleep, Bot, until } from './swarm-lib.mjs';
import { ShazamReferee, shazamMonkey, makeTracks, sendPrep, summarizeS } from './swarm-shazam-lib.mjs';

const ON = process.env.SOAK === '1';
const SECONDS = Number(process.env.SOAK_SECONDS) || 120;
const ROOMS = Number(process.env.SOAK_ROOMS) || 20;
const BOTS = Number(process.env.SOAK_BOTS) || 8;
const MB = (b) => Math.round(b / 1048576);

test(`shazam soak: ${ROOMS} oda × ${BOTS} bot, ${SECONDS} sn`, { skip: !ON && 'SOAK=1 ile çalışır', timeout: (SECONDS + 120) * 1000 }, async () => {
  const srv = await startProbedServer({ timeScale: 0.01, seed: 98, gc: true, probeMs: 1000 });
  const everyBot = new Set();
  const stats = { games: 0, churn: 0, replaced: 0, reprep: 0, errors: [] };
  const refs = [];
  try {
    await sleep(1500);
    const base = srv.lastProbe();
    console.log(`başlangıç: rss=${MB(base.rss)} MB heap=${MB(base.heapUsed)} MB rooms=${base.rooms}`);
    const deadline = Date.now() + SECONDS * 1000;

    const runRoom = async (ri) => {
      const rng = createRng(4000 + ri);
      let tracks = makeTracks(10 + rng.int(60), 500 + ri);
      const { bots, host, code } = await makeRoom(srv.wsUrl, 'shazam', BOTS, `Z${ri}-`);
      bots.forEach((b) => everyBot.add(b));
      const ref = new ShazamReferee({ label: `soak r${ri} ${code}`, tracks: [...tracks], clockTol: 800 }).attachAll(bots);
      refs.push(ref);
      await sendPrep(host, tracks, { gap: 200 });
      host.send({ t: 'settings', settings: { rounds: 3 + rng.int(5), roundSeconds: 45 } });
      const stop = { done: false };
      const players = [...bots];
      const loops = players.map((b, i) => shazamMonkey(b, { rng: createRng(ri * 100 + i), ref, stop, profile: rng.pick(['random', 'sharp', 'quitter', 'idle']) }));
      const churn = (async () => {
        while (!stop.done) {
          await sleep(1000 + rng.int(2500));
          if (stop.done) break;
          const i = 1 + rng.int(players.length - 1); // host (0) sabit
          const b = players[i];
          const x = rng.next();
          stats.churn++;
          try {
            if (x < 0.5) { b.drop(); await sleep(30 + rng.int(300)); await b.connect(); } else if (x < 0.8) {
              b.leave();
              await sleep(50 + rng.int(300));
              await b.join(code).catch(() => {});
            } else {
              b.close();
              const nb = await new Bot(srv.wsUrl, `Z${ri}-n${stats.replaced++}`).connect();
              everyBot.add(nb);
              ref.attach(nb);
              await nb.join(code).catch(() => {});
              players[i] = nb;
              loops.push(shazamMonkey(nb, { rng: createRng(ri * 1000 + stats.replaced), ref, stop }));
            }
          } catch (err) { stats.errors.push(`churn r${ri}: ${err.message}`); }
        }
      })();
      while (Date.now() < deadline) {
        try {
          host.send({ t: 'start' });
          await host.waitRoom((r) => r.phase === 'playing', { timeout: 3000 });
          await host.waitRoom((r) => r.phase === 'over', { timeout: 60_000 });
          stats.games++;
          await sleep(100 + rng.int(300));
          host.send({ t: 'backToLobby' });
          await host.waitRoom((r) => r.phase === 'lobby', { timeout: 3000 });
          if (rng.next() < 0.3) { // prep'i yenile (yeni şarkılar hakeme de bildirilir)
            tracks = makeTracks(10 + rng.int(60), 900 + ri * 10 + stats.reprep++);
            ref.tracks.push(...tracks);
            for (const t of tracks) ref.byMedia.set(t.ytId ? `yt:${t.ytId}` : `au:${t.audio}`, t);
            await sendPrep(host, tracks, { gap: 200 });
          }
        } catch (err) { stats.errors.push(`oyun r${ri}: ${err.message}`); await sleep(500); }
      }
      stop.done = true;
      await churn;
      await Promise.all(loops);
      players.forEach((b) => b.close());
    };
    await Promise.all(Array.from({ length: ROOMS }, (_, ri) => runRoom(ri)));
    const peak = srv.probes().reduce((m, p) => (p.rss > m.rss ? p : m), base);
    console.log(`zirve: rss=${MB(peak.rss)} MB heap=${MB(peak.heapUsed)} MB rooms=${peak.rooms}; oyun=${stats.games} churn=${stats.churn}`);
    everyBot.forEach((b) => b.close());
    const end = await srv.waitProbe((p) => p.rooms === 0, 15_000);
    console.log(`son: rss=${MB(end.rss)} MB heap=${MB(end.heapUsed)} MB rooms=${end.rooms} identities=${end.identities}`);
    const violations = refs.flatMap((r) => r.violations);
    for (const r of refs) console.log(summarizeS(r));
    const internal = srv.log().match(/(hatası|Lobi hatası)[^\n]*/g) ?? [];
    assert.deepEqual(internal, [], 'sunucu logunda hata olmamalı');
    assert.deepEqual(violations.slice(0, 30), [], `değişmez ihlali:\n${violations.slice(0, 30).join('\n')}`);
    assert.ok(stats.games >= ROOMS, `yeterince oyun oynanmalı (${stats.games})`);
    assert.ok(end.heapUsed < base.heapUsed + 64 * 1048576, `heap sızıntısı şüphesi: ${MB(base.heapUsed)} → ${MB(end.heapUsed)} MB`);
    if (stats.errors.length) console.log(`uyarılar (${stats.errors.length}):\n${stats.errors.slice(0, 20).join('\n')}`);
    await until(() => true);
  } finally {
    await srv.stop();
  }
});
