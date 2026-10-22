// Uzun soak testi (varsayılan npm test'te ATLANIR): SOAK=1 npm test  veya
//   SOAK=1 SOAK_SECONDS=120 SOAK_ROOMS=20 SOAK_BOTS=8 node --test tests/swarm/swarm-soak.test.mjs
// 20 oda × 8 bot aynı anda Casus Kim? oynar; oyun biter → host bekleme odasına döner → yeniden başlatır. Bu sırada
// oyuncular ayrılıp geri gelir, bağlantıları kopar, bazıları tamamen yeni kimlikle değişir. Test-only sonda
// (swarm-probe.mjs, --expose-gc) ile sunucu RSS/heap ve oda/kimlik sayıları izlenir; sonunda odalar temizlenmeli,
// bellek makul sınırda geri dönmeli.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, SpyfallReferee, monkey, createRng, sleep, Bot, until } from './swarm-lib.mjs';

const ON = process.env.SOAK === '1';
const SECONDS = Number(process.env.SOAK_SECONDS) || 120;
const ROOMS = Number(process.env.SOAK_ROOMS) || 20;
const BOTS = Number(process.env.SOAK_BOTS) || 8;
const MB = (b) => Math.round(b / 1048576);

test(`soak: ${ROOMS} oda × ${BOTS} bot, ${SECONDS} sn`, { skip: !ON && 'SOAK=1 ile çalışır', timeout: (SECONDS + 120) * 1000 }, async () => {
  const SCALE = 0.005; // tur 3 dk = 0.9 sn, koltuk 0.6 sn
  const srv = await startProbedServer({ timeScale: SCALE, seed: 77, gc: true, probeMs: 1000 });
  const everyBot = new Set();
  const stats = { games: 0, churn: 0, replaced: 0, errors: [] };
  const refs = [];
  try {
    await sleep(1500);
    const base = srv.lastProbe();
    console.log(`başlangıç: rss=${MB(base.rss)} MB heap=${MB(base.heapUsed)} MB rooms=${base.rooms} identities=${base.identities}`);
    const deadline = Date.now() + SECONDS * 1000;

    const runRoom = async (ri) => {
      const rng = createRng(1000 + ri);
      const { bots, host, code } = await makeRoom(srv.wsUrl, 'spyfall', BOTS, `R${ri}-`);
      bots.forEach((b) => everyBot.add(b));
      const ref = new SpyfallReferee({ label: `soak r${ri} ${code}` }).attachAll(bots);
      refs.push(ref);
      const stop = { done: false };
      const oracle = {};
      const players = [...bots];
      const loops = players.map((b, i) => monkey(b, { rng: createRng(ri * 100 + i), oracle, stop, guessRate: 0.01, accuseRate: 0.02 }));
      const churn = (async () => {
        while (!stop.done) {
          await sleep(800 + rng.int(2000));
          if (stop.done) break;
          const i = 1 + rng.int(players.length - 1); // host (0) sabit
          const b = players[i];
          const x = rng.next();
          stats.churn++;
          try {
            if (x < 0.4) { b.drop(); await sleep(50 + rng.int(300)); await b.connect(); } else if (x < 0.75) {
              b.send({ t: 'leave' });
              await sleep(50 + rng.int(300));
              await b.join(code).catch(() => {});
            } else {
              // tamamen yeni kimlik: eskisi kalıcı gider (koltuk süresi sonunda düşer)
              b.close();
              const nb = await new Bot(srv.wsUrl, `R${ri}-n${stats.replaced++}`).connect();
              everyBot.add(nb);
              ref.attach(nb);
              await nb.join(code).catch(() => {});
              players[i] = nb;
              loops.push(monkey(nb, { rng: createRng(ri * 1000 + stats.replaced), oracle, stop, guessRate: 0.01, accuseRate: 0.02 }));
            }
          } catch (err) {
            stats.errors.push(`r${ri} churn: ${err.message}`);
          }
        }
      })();
      try {
        while (Date.now() < deadline) {
          host.send({ t: 'settings', settings: { rounds: 1 + rng.int(2), minutes: 3, spies: 1 + rng.int(2) } });
          await sleep(30);
          host.send({ t: 'start' });
          try {
            await until(() => host.room?.phase === 'over', { timeout: 20_000, what: `r${ri} oyun bitmedi` });
            stats.games++;
          } catch (err) {
            stats.errors.push(`${err.message} phase=${host.room?.phase} view=${host.view?.phase}`);
          }
          host.send({ t: 'backToLobby' });
          await until(() => host.room?.phase === 'lobby', { timeout: 5000, what: `r${ri} lobiye dönmedi` }).catch((e) => stats.errors.push(e.message));
        }
      } finally {
        stop.done = true;
        await Promise.all([churn, ...loops]);
      }
    };

    // Ara ölçümler
    const sampler = setInterval(() => {
      const p = srv.lastProbe();
      if (p) console.log(`t+${Math.round((p.t - base.t) / 1000)}s rss=${MB(p.rss)} MB heap=${MB(p.heapUsed)} MB rooms=${p.rooms} identities=${p.identities}`);
    }, 15_000);
    await Promise.all(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
    clearInterval(sampler);
    const peak = srv.probes().reduce((m, p) => Math.max(m, p.rss), 0);

    // Herkes gider → odalar koltuk süresi sonunda silinmeli
    for (const b of everyBot) b.close();
    const cleaned = await srv.waitProbe((p) => p.rooms === 0, 15_000).catch(() => srv.lastProbe());
    await sleep(3000); // birkaç gc'li sonda
    const end = srv.lastProbe();
    const violations = refs.flatMap((r) => r.violations);
    console.log(`bitiş: oyun=${stats.games} churn=${stats.churn} yeniKimlik=${stats.replaced} hata=${stats.errors.length} ihlal=${violations.length}`);
    console.log(`bellek: başlangıç rss=${MB(base.rss)} MB, tepe=${MB(peak)} MB, son rss=${MB(end.rss)} MB; heap ${MB(base.heapUsed)} → ${MB(end.heapUsed)} MB; rooms=${end.rooms} identities=${end.identities}`);
    if (stats.errors.length) console.log(`hatalar (ilk 10):\n  ${stats.errors.slice(0, 10).join('\n  ')}`);
    assert.equal(cleaned.rooms, 0, 'tüm odalar silinmeli');
    assert.deepEqual(violations.slice(0, 20), [], violations.slice(0, 20).join('\n'));
    assert.ok(stats.games >= ROOMS, `yeterli oyun oynanmalı (${stats.games})`);
    assert.ok(stats.errors.length <= Math.ceil(stats.games * 0.02), `takılan oyun oranı yüksek: ${stats.errors.length}/${stats.games}`);
    assert.ok(end.heapUsed - base.heapUsed < 30 * 1048576, `heap büyümesi ${MB(end.heapUsed - base.heapUsed)} MB`);
    assert.ok(end.rss - base.rss < 80 * 1048576, `RSS büyümesi ${MB(end.rss - base.rss)} MB`);
    assert.doesNotMatch(srv.log(), /hatası|Yakalanmamış/);
  } finally {
    for (const b of everyBot) b.close();
    await srv.stop();
  }
});
