// PoC: clientIp() — tünel arkasında IP başına sınırlar.
// a) Doğrudan (loopback olmayan) bağlantıda sahte CF-Connecting-IP / X-Forwarded-For yok sayılıyor mu?
// b) Loopback (cloudflared gibi) üzerinden gelen her farklı IPv6 adresi ayrı kova mı? (bir /64 = 2^64 "farklı kişi")
// Cloudflare'in davranışını taklit etmek için başlıkları loopback'ten kendimiz gönderiyoruz; dış servise istek yok.
// Kullanım: node tests/security/poc-shazam-clientip.mjs
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';

const srv = await startServer({ env: { LIMIT_ROOMS_PER_IP: '1', LIMIT_SOCKETS_PER_IP: '2', LIMIT_IDENTITIES_PER_HOUR: '2' } });

function tryRoom(host, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${srv.port}/ws`, { headers });
    ws.on('unexpected-response', (_q, r) => resolve(`HTTP ${r.statusCode}`));
    ws.on('error', (e) => resolve(`hata ${e.code}`));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'x' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'create', game: 'shazam' }));
      if (m.t === 'room' && m.room) resolve('oda açıldı'); // soket açık kalır (oda yaşasın)
      if (m.t === 'error') resolve(`red: ${m.message}`);
    });
  });
}

console.log('--- b) loopback + farklı IPv6 (aynı /64) ---');
for (let i = 1; i <= 5; i++) console.log(`2001:db8:1:1::${i}`, '→', await tryRoom('127.0.0.1', { 'CF-Connecting-IP': `2001:db8:1:1::${i}` }));
console.log('aynı IPv4 tekrar:', await tryRoom('127.0.0.1', { 'CF-Connecting-IP': '203.0.113.7' }), '/', await tryRoom('127.0.0.1', { 'CF-Connecting-IP': '203.0.113.7' }));

const lan = Object.values(networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
if (lan) {
  console.log(`\n--- a) doğrudan bağlantı (${lan}) + sahte başlıklar ---`);
  for (let i = 1; i <= 3; i++) console.log(`CF-Connecting-IP 198.51.100.${i}`, '→', await tryRoom(lan, { 'CF-Connecting-IP': `198.51.100.${i}`, 'X-Forwarded-For': `198.51.100.${i}` }));
} else console.log('LAN adresi yok, (a) atlandı');
await srv.stop();
process.exit(0);
