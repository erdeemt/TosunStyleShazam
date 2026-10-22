// Küçük, zararsız doğrulamalar: path traversal, HTTP uçlarında hız sınırı var mı, /api/identity ile kimlik artışı.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../lib/server.js';

const srv = await startServer();
const post = (p, b) => fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

// 1) Path traversal denemeleri (zararsız: sadece dosya okunabiliyor mu bakıyoruz)
for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/....//server.js']) {
  const r = await fetch(srv.url + p);
  const t = await r.text();
  console.log(`GET ${p} → ${r.status} ${t.slice(0, 40).replace(/\n/g, ' ')}${/attachLobby|import http/.test(t) ? '  <== KAYNAK SIZDI' : ''}`);
}

// 2) HTTP uçlarında hız sınırı var mı? 50 ardışık /api/identity
let ok = 0;
for (let i = 0; i < 50; i++) { const r = await post('/api/identity', { name: 'A' }); if (r.ok) ok++; }
console.log(`50 ardışık POST /api/identity → ${ok} başarılı (HTTP hız sınırı ${ok === 50 ? 'YOK' : 'VAR'})`);
const n = Object.keys(JSON.parse(readFileSync(join(srv.dataDir, 'identities.json'), 'utf8') || '{}')).length;
console.log(`identities.json kayıt sayısı: ${n} (her anonim POST yeni kalıcı kimlik yaratıyor)`);

// 3) Wordle free: aynı oyuncu çok oyun açarsa? (oyuncu başına 3 sınırı)
const id = await (await post('/api/identity', { name: 'W' })).json();
for (let i = 0; i < 5; i++) await post('/api/wordle/start', { ...id, mode: 'free' });
console.log('Wordle free 5 kez başlatıldı (oyuncu başına 3 ile sınırlı — kod incelemesi).');

await srv.stop();
