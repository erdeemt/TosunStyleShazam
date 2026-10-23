// PoC: view.gameKey = rng.int(1e9) mulberry32 çıktısıdır. mulberry32'nin durumu sadece bir sayaçtır
// (a += 0x6d2b79f5), bu yüzden tek bir çıktıdan 2^32 durumu taramak durumu verir; önceki/sonraki tüm
// çıktılar hesaplanabilir. Vampir'de gameKey karıştırmadan HEMEN SONRA üretilir → tüm roller çıkar.
// Spyfall'da gameKey startRound'dan HEMEN ÖNCE üretilir → mekân + casus çıkar.
// Çalıştır: node tests/security/poc-vampir-rng.mjs   (yerel sunucu başlatır, rastgele tohum, ~10-60 sn)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const C = 0x6d2b79f5;
const out = (a) => {
  let t = a >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

if (!isMainThread) {
  const { key, from, to } = workerData;
  const hits = [];
  for (let a = from; a < to; a++) if (Math.floor(out(a) * 1e9) === key) hits.push(a >>> 0);
  parentPort.postMessage(hits);
} else {
  const { startServer } = await import('../lib/server.js');
  const { makeRoom, sleep } = await import('../lib/bot.js');

  async function crack(key) {
    const n = cpus().length;
    const step = Math.ceil(2 ** 32 / n);
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res, rej) => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { key, from: i * step, to: Math.min(2 ** 32, (i + 1) * step) } });
      w.once('message', res); w.once('error', rej);
    })));
    return parts.flat();
  }
  const outAt = (a, k) => out((a + k * C) >>> 0); // a: gameKey durumundan k adım ötesi

  // --- Vampir ---
  const srv = await startServer({ timeScale: 1, env: { SEED: '' } }); // SEED boş → crypto tohum (üretimdeki gibi)
  const N = 8;
  const room = await makeRoom(srv.wsUrl, 'vampir', N, 'P');
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'night')));
  const attacker = room.bots[3]; // sıradan bir oyuncu; sadece KENDİ view'ını kullanır
  const v = attacker.view;
  console.log(`Saldırgan: ${attacker.name} (kendi rolü: ${v.me.role}), gameKey=${v.gameKey}`);
  const t0 = Date.now();
  const cands = await crack(v.gameKey);
  console.log(`2^32 tarama ${((Date.now() - t0) / 1000).toFixed(1)} sn, aday durum: ${cands.length}`);

  // Rol dizisi setup() ile aynı sırada (roleCounts herkese açık).
  const rc = v.roleCounts;
  const roles = [...Array(rc.vampir).fill('vampir'), ...['doktor', 'gozcu', 'deli'].filter((r) => rc[r]), ...Array(rc.koylu ?? 0).fill('koylu')];
  const ids = v.players.map((p) => p.id); // start'taki sıra (joinedAt) = view.players sırası
  const predictions = cands.map((a) => {
    const arr = [...ids];
    let k = -(ids.length - 1);
    for (let i = arr.length - 1; i > 0; i--, k++) {
      const j = Math.floor(outAt(a, k) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return Object.fromEntries(arr.map((id, i) => [id, roles[i]]));
  }).filter((p) => p[attacker.playerId] === v.me.role); // kendi rolüyle tutarsız adayları ele
  console.log(`Kendi rolüyle tutarlı aday: ${predictions.length}`);
  const truth = Object.fromEntries(room.bots.map((b) => [b.playerId, b.view.me.role]));
  for (const pred of predictions) {
    const ok = ids.every((id) => pred[id] === truth[id]);
    console.log(ok ? '  <== TÜM ROLLER DOĞRU TAHMİN EDİLDİ:' : '  (yanlış aday)');
    if (ok) for (const b of room.bots) console.log(`     ${b.name.padEnd(5)} tahmin=${pred[b.playerId].padEnd(7)} gerçek=${truth[b.playerId]}`);
  }
  room.bots.forEach((b) => b.close());

  // --- Spyfall (aynı kök neden) ---
  const room2 = await makeRoom(srv.wsUrl, 'spyfall', 5, 'S');
  room2.host.send({ t: 'start' });
  await Promise.all(room2.bots.map((b) => b.waitView((x) => x.round)));
  await sleep(100);
  const sv = room2.bots[1].view;
  const c2 = await crack(sv.gameKey);
  const sids = room2.bots.map((b) => b.playerId); // start sırası
  const spyTruth = room2.bots.filter((b) => b.view.me.spy).map((b) => b.name);
  const locTruth = room2.bots.find((b) => !b.view.me.spy).view.me.location.name;
  for (const a of c2) {
    const loc = sv.locations[Math.floor(outAt(a, 1) * sv.locations.length)];
    const arr = [...sids];
    let k = 2; // k=1: mekân seçimi, sonra karıştırma
    for (let i = arr.length - 1; i > 0; i--, k++) {
      const j = Math.floor(outAt(a, k) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const spy = room2.bots.find((b) => b.playerId === arr[0]);
    const ok = spyTruth.includes(spy.name) && loc.name === locTruth;
    console.log(`Spyfall aday: casus=${spy.name} mekân=${loc.name} | gerçek: casus=${spyTruth} mekân=${locTruth}${ok ? '  <== DOĞRU' : ''}`);
  }
  room2.bots.forEach((b) => b.close());
  await srv.stop();
}
