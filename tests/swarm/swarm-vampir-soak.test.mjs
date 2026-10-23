// Vampir Köylü soak testi (varsayılan npm test'te ATLANIR): SOAK=1 npm test  veya
//   SOAK=1 SOAK_SECONDS=120 SOAK_ROOMS=20 SOAK_BOTS=8 node --test tests/swarm/swarm-vampir-soak.test.mjs
// N oda × M bot aynı anda Vampir oynar (her oyunda ayarlar rastgele); oyun biter → host bekleme odasına döner → yeniden başlatır.
// Bu sırada oyuncular düşüp geri gelir, ayrılıp izleyici olarak döner, bazıları yeni kimlikle değişir. Test-only sonda ile
// sunucu RSS/heap ve oda sayısı izlenir; sonunda odalar temizlenmeli, bellek makul sınırda kalmalı, hakem ihlali olmamalı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, createRng, sleep, Bot, until } from './swarm-lib.mjs';
import { VampirReferee, vampMonkey, summarizeV, FAST } from './swarm-vampir-lib.mjs';

const ON = process.env.SOAK === '1';
const SECONDS = Number(process.env.SOAK_SECONDS) || 120;
const ROOMS = Number(process.env.SOAK_ROOMS) || 20;
const BOTS = Number(process.env.SOAK_BOTS) || 8;
const MB = (b) => Math.round(b / 1048576);

test(`vampir soak: ${ROOMS} oda × ${BOTS} bot, ${SECONDS} sn`, { skip: !ON && 'SOAK=1 ile çalışır', timeout: (SECONDS + 120) * 1000 }, async () => {
  const SCALE = 0.01; // gece 0.3 sn, gündüz 1.2 sn, koltuk 1.2 sn
  const srv = await startProbedServer({ timeScale: SCALE, seed: 97, gc: true, probeMs: 1000 });
  const everyBot = new Set();
  const stats = { games: 0, churn: 0, replaced: 0, errors: [] };
  const refs = [];
  try {
    await sleep(1500);
    const base = srv.lastProbe();
    console.log(`başlangıç: rss=${MB(base.rss)} MB heap=${MB(base.heapUsed)} MB rooms=${base.rooms}`);
    const deadline = Date.now() + SECONDS * 1000;

    const runRoom = async (ri) => {
      const rng = createRng(3000 + ri);
      const { bots, host, code } = await makeRoom(srv.wsUrl, 'vampir', BOTS, `V${ri}-`);
      bots.forEach((b) => everyBot.add(b));
      const ref = new VampirReferee({ label: `soak r${ri} ${code}`, clockTolerance: 250 }).attachAll(bots);
      refs.push(ref);
      const stop = { done: false };
      const players = [...bots];
      const loops = players.map((b, i) => vampMonkey(b, { rng: createRng(ri * 100 + i), stop }));
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
              const nb = await new Bot(srv.wsUrl, `V${ri}-n${stats.replaced++}`).connect();
              everyBot.add(nb);
              ref.attach(nb);
              await nb.join(code).catch(() => {});
              players[i] = nb;
              loops.push(vampMonkey(nb, { rng: createRng(ri * 1000 + stats.replaced), stop }));
            }
          } catch (err) {
            stats.errors.push(`r${ri} churn: ${err.message}`);
          }
        }
      })();
      try {
        while (Date.now() < deadline) {
          const settings = { ...FAST, vampires: rng.next() < 0.5 ? 0 : 1 + rng.int(3), doktor: rng.next() < 0.8, gozcu: rng.next() < 0.8, deli: rng.next() < 0.6 };
          host.send({ t: 'settings', settings });
          await sleep(30);
          host.send({ t: 'start' });
          try {
            await until(() => host.room?.phase === 'playing' || host.room?.phase === 'over', { timeout: 3000, what: `r${ri} başlamadı` });
            await until(() => host.room?.phase === 'over', { timeout: 40_000, what: `r${ri} oyun bitmedi` });
            stats.games++;
          } catch (err) {
            stats.errors.push(`${err.message} phase=${host.room?.phase} view=${host.view?.phase} players=${host.room?.players.filter((p) => p.connected).length}`);
          }
          await sleep(50);
          host.send({ t: 'backToLobby' });
          await until(() => host.room?.phase === 'lobby', { timeout: 5000, what: `r${ri} lobiye dönmedi` }).catch((e) => stats.errors.push(e.message));
        }
      } finally {
        stop.done = true;
        await Promise.all([churn, ...loops]);
      }
    };

    const sampler = setInterval(() => {
      const p = srv.lastProbe();
      if (p) console.log(`t+${Math.round((p.t - base.t) / 1000)}s rss=${MB(p.rss)} MB heap=${MB(p.heapUsed)} MB rooms=${p.rooms} identities=${p.identities}`);
    }, 15_000);
    await Promise.all(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
    clearInterval(sampler);
    const peak = srv.probes().reduce((m, p) => Math.max(m, p.rss), 0);

    for (const b of everyBot) b.close();
    const cleaned = await srv.waitProbe((p) => p.rooms === 0, 15_000).catch(() => srv.lastProbe());
    await sleep(3000);
    const end = srv.lastProbe();
    const violations = refs.flatMap((r) => r.finalChecks());
    const overs = refs.reduce((s, r) => s + r.stats.overs, 0);
    const winners = refs.reduce((acc, r) => { for (const [k, v] of Object.entries(r.stats.winners)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
    console.log(`bitiş: oyun=${stats.games} hakemOyunSonu=${overs} kazananlar=${JSON.stringify(winners)} churn=${stats.churn} yeniKimlik=${stats.replaced} hata=${stats.errors.length} ihlal=${violations.length}`);
    console.log(`bellek: başlangıç rss=${MB(base.rss)} MB, tepe=${MB(peak)} MB, son rss=${MB(end.rss)} MB; heap ${MB(base.heapUsed)} → ${MB(end.heapUsed)} MB; rooms=${end.rooms}`);
    console.log(refs.slice(0, 3).map(summarizeV).join('\n'));
    if (stats.errors.length) console.log(`hatalar (ilk 10):\n  ${stats.errors.slice(0, 10).join('\n  ')}`);
    assert.equal(cleaned.rooms, 0, 'tüm odalar silinmeli');
    assert.deepEqual(violations.slice(0, 20), [], violations.slice(0, 20).join('\n'));
    assert.ok(stats.games >= ROOMS, `yeterli oyun (${stats.games})`);
    assert.ok(stats.errors.length <= Math.ceil(stats.games * 0.03), `takılan oyun oranı yüksek: ${stats.errors.length}/${stats.games}`);
    assert.ok(end.heapUsed - base.heapUsed < 30 * 1048576, `heap büyümesi ${MB(end.heapUsed - base.heapUsed)} MB`);
    assert.ok(end.rss - base.rss < 80 * 1048576, `RSS büyümesi ${MB(end.rss - base.rss)} MB`);
    assert.doesNotMatch(srv.log(), /hatası|Yakalanmamış/);
  } finally {
    for (const b of everyBot) b.close();
    await srv.stop();
  }
});
