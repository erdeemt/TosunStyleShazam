// Güvenlik PoC (Tosun Top / gerçek zamanlı döngü): DoS ve kötüye kullanım.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { startServer } from '../lib/server.js';
import { Bot, sleep } from '../lib/bot.js';

const servers = [];
after(async () => { for (const s of servers) await s.stop(); });

async function stats(url) { return (await fetch(`${url}/api/_test/stats`)).json(); }
const cpuMs = (s) => (s.cpu.user + s.cpu.system) / 1000;

// Ham WebSocket istemcisi: kapanış çerçevesini yok sayar, göndermeye devam eder.
function rawWs(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buf = '';
    const st = { sock, closeFrame: false, ended: false };
    sock.on('error', () => {});
    sock.on('close', () => { st.ended = true; });
    sock.on('data', (d) => {
      if (!st.open) {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) { st.open = true; resolve(st); }
        return;
      }
      for (let i = 0; i < d.length; i++) if (d[i] === 0x88) st.closeFrame = true;
    });
    sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    setTimeout(() => reject(new Error('handshake timeout')), 3000);
  });
}
function frame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

test('F1 (düzeltildi): rate-kill sonrası soket hemen yok edilir, gelen mesajlar ayrıştırılmaz', async () => {
  const srv = await startServer({ timeScale: 1 });
  servers.push(srv);
  const c = await rawWs(srv.port);
  // ~8KB, ayrıştırması pahalı (çok sayıda küçük sayı) geçerli JSON; t hızlı yol değil.
  const big = frame(JSON.stringify({ t: 'x', a: Array.from({ length: 2600 }, (_, i) => i % 10) }).slice(0, 8000).replace(/,?\d*$/, ']}'));
  for (let i = 0; i < 130; i++) c.sock.write(big);
  await sleep(300);
  assert.ok(c.closeFrame, 'sunucu 1008 kapanış çerçevesi göndermeli');
  const s0 = await stats(srv.url);
  const t0 = Date.now();
  let sent = 0;
  while (Date.now() - t0 < 3000) {
    if (c.ended) break;
    if (c.sock.writableLength < 1 << 20) { for (let i = 0; i < 50; i++) c.sock.write(big); sent += 50; }
    await sleep(1);
  }
  const s1 = await stats(srv.url);
  const used = cpuMs(s1) - cpuMs(s0);
  console.log(`kapanıştan sonra gönderilen=${sent} mesaj, TCP kapandı mı=${c.ended}, sunucu CPU=${used.toFixed(0)} ms / 3000 ms`);
  assert.equal(c.ended, true, 'sunucu soketi kapanış çerçevesinden kısa süre sonra yok etmeli');
  assert.ok(used < 1500, `kapanıştan sonra sunucu işlemcisi ${used.toFixed(0)} ms`);
  c.sock.destroy();
});

test('F2 (düzeltildi): tek IP aynı anda en fazla 2 canlı maç başlatır, 3. reddedilir', async () => {
  const srv = await startServer({
    timeScale: 1,
    env: { LIMIT_ROOMS_PER_IP: '10', LIMIT_SOCKETS_PER_IP: '30', LIMIT_IDENTITIES_PER_HOUR: '30', LIMIT_LIVE_PER_IP: '2' }, // üretim varsayılanları
  });
  servers.push(srv);
  const bots = [];
  let refused = null;
  for (let r = 0; r < 3; r++) {
    const host = await new Bot(srv.wsUrl, `H${r}`).connect();
    const guest = await new Bot(srv.wsUrl, `G${r}`).connect();
    bots.push(host, guest);
    host.send({ t: 'create', game: 'haxball' });
    const room = await host.waitRoom((x) => !!x?.code);
    guest.send({ t: 'join', code: room.code });
    await host.waitRoom((x) => x.players.length === 2);
    host.send({ t: 'lobbyAction', data: { type: 'team', team: 'red' } });
    guest.send({ t: 'lobbyAction', data: { type: 'team', team: 'blue' } });
    await host.waitRoom((x) => x.prep?.teams?.[guest.playerId] === 'blue' && x.prep?.teams?.[host.playerId] === 'red');
    host.send({ t: 'settings', settings: { minutes: 5, goals: 0 } });
    await sleep(50);
    const res = host.waitFor((m) => (m.t === 'view' && m.view?.phase === 'kickoff') || m.t === 'error');
    host.send({ t: 'start' });
    const m = await res;
    if (r < 2) assert.equal(m.t, 'view', `${r + 1}. maç başlamalı`);
    else refused = m;
  }
  const s = await stats(srv.url);
  console.log(`odalar=${s.rooms} döngüler=${s.loops}`);
  assert.equal(s.loops, 2);
  assert.equal(refused?.t, 'error');
  assert.match(refused.message, /en fazla 2 canlı maç/);
  const a = await stats(srv.url);
  await sleep(3000);
  const b = await stats(srv.url);
  console.log(`2 boşta döngü CPU: ${(cpuMs(b) - cpuMs(a)).toFixed(0)} ms / 3000 ms`);
  bots.forEach((x) => x.close());
});

test('F3 (düzeltildi): odasız ping yanıtsız; büyük ping yavaş yoldan', async () => {
  const srv = await startServer({ timeScale: 1 });
  servers.push(srv);
  const b = await new Bot(srv.wsUrl, 'P').connect();
  for (let i = 0; i < 500; i++) b.sendRaw({ t: 'ping', c: i });
  await sleep(500);
  const pongs = b.messages.filter((m) => m.t === 'pong').length;
  console.log(`500 ping → ${pongs} pong, kapandı=${!!b.closed}`);
  assert.equal(pongs, 0, 'sadece oynanan odadayken pong');
  // Ayrıca: 256 baytı aşan ping yavaş yola düşer ve genel sayaca yazılır (bilinmeyen mesaj).
  b.sendRaw({ t: 'ping', c: 1, pad: 'x'.repeat(300) });
  const e = await b.waitFor((m) => m.t === 'error');
  assert.equal(e.code, 'unknown');
  b.close();
});
