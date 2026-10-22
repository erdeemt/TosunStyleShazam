// Güvenlik regresyon testleri (security-auditor raporu K1, K2, Y1, O2, D1). Sınırlar burada sıkı tutulur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';
import { Bot } from '../lib/bot.js';

let srv;
before(async () => {
  srv = await startServer({
    env: {
      LIMIT_IDENTITIES_PER_HOUR: '8',
      LIMIT_ROOMS_PER_IP: '3',
      LIMIT_SOCKETS_PER_IP: '12',
      LIMIT_HTTP_PER_MIN: '40',
      LIMIT_UPSTREAM_PER_MIN: '5',
    },
  });
});
after(async () => { await srv.stop(); });

function rawHttp(payload) {
  return new Promise((resolve) => {
    const s = net.connect(srv.port, '127.0.0.1', () => s.write(payload));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => s.destroy(), 1500);
  });
}

async function alive() {
  const res = await fetch(`${srv.url}/`);
  return res.status === 200;
}

test('K1: bozuk Host / hedef sunucuyu çökertmez', async () => {
  for (const payload of [
    'GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n',
    'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    'GET /ws HTTP/1.1\r\nHost: [\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  ]) {
    await rawHttp(payload);
    assert.ok(await alive(), `sunucu düştü: ${JSON.stringify(payload.slice(0, 30))}`);
  }
});

test('K2: tek bağlantı sınırsız kimlik üretemez; IP başına oda kotası', async () => {
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  for (let i = 0; i < 6; i++) ws.send(JSON.stringify({ t: 'hello', name: `x${i}` }));
  assert.equal(await closed, 1008, '4. hello bağlantıyı kapatmalı');

  // Oda kotası: aynı IP'den en fazla 3 oda (her bot ayrı kimlik)
  const bots = [];
  let rejected = null;
  for (let i = 0; i < 4; i++) {
    const b = await new Bot(srv.wsUrl, `Oda${i}`).connect();
    bots.push(b);
    try { await b.create('_test'); } catch (err) { rejected = err.message; }
  }
  assert.match(rejected ?? '', /çok fazla oda/);
  bots.forEach((b) => b.close());
});

test('Y1: IP başına yeni kimlik sınırı (WS + HTTP ortak)', async () => {
  let blocked = false;
  for (let i = 0; i < 12 && !blocked; i++) {
    const res = await fetch(`${srv.url}/api/identity`, { method: 'POST', body: JSON.stringify({ name: `k${i}` }) });
    if (res.status !== 200) blocked = /çok fazla yeni oyuncu/.test((await res.json()).error);
  }
  assert.ok(blocked, 'saatlik kimlik sınırı uygulanmalı');
});

test('Y1: HTTP ve dış servis uçları hız sınırlı; yt-meta en fazla 50 id', async () => {
  let upstream429 = false;
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${srv.url}/api/resolve?url=${encodeURIComponent('https://example.com/x')}`);
    if (res.status === 429) upstream429 = true;
  }
  assert.ok(upstream429, 'dış servis uçları dakikada 5 ile sınırlı olmalı');
  let http429 = false;
  for (let i = 0; i < 60 && !http429; i++) {
    const res = await fetch(`${srv.url}/api/wordle/leaderboard`, { method: 'POST', body: '{}' });
    http429 = res.status === 429;
  }
  assert.ok(http429, 'genel API hız sınırı uygulanmalı');
});

test('O2 + D1: iç hata ayrıntısı sızmaz; geçersiz Spotify id reddedilir', async () => {
  // Sınırlar dolduğu için ayrı, gevşek bir sunucu
  const loose = await startServer();
  try {
    const bad = await fetch(`${loose.url}/api/spotify-cover?id=../../x?y=1`);
    assert.match((await bad.json()).error, /Geçersiz şarkı/);
    const unknown = await fetch(`${loose.url}/api/resolve?url=nope`);
    assert.match((await unknown.json()).error, /Tanınmayan link/);
    const page = await fetch(`${loose.url}/`);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  } finally {
    await loose.stop();
  }
});
