// Lobi / oda yöneticisi: kimlik, oda kur/katıl, yeniden bağlanma, host devri, oyun eylemlerini yönlendirme.
// Sunucu yetkilidir: oyun durumu burada yaşar, istemciye sadece view(state, playerId) gider. Bkz. PLAN.md §3.
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRng, cryptoRng } from './rng.js';
import { GameError, str } from './errors.js';
import { jsonStore } from './store.js';
import { IP_LIMITS, clientIp, identityLimiter } from './limits.js';
import { GAMES } from './games/index.js';

// Süre ölçeği sadece test sunucusunda (TEST_MODE=1, tests/lib/server.js): üretimde yanlışlıkla bırakılırsa süreler değişmesin.
const TIME_SCALE = process.env.TEST_MODE === '1' && Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1;
const BASE_SEED = process.env.SEED ? Number(process.env.SEED) : null;

export const LIMITS = {
  maxMessageBytes: 8 * 1024,
  rateWindowMs: 5000,
  rateMaxMessages: 30, // pencere başına; fazlası düşer
  rateKillMessages: 120, // pencere başına; aşan bağlantı kapanır
  maxRooms: 200,
  maxPlayersPerRoom: 12,
  maxIdentities: 5000,
  nameMaxLength: 16,
  seatHoldMs: 120_000, // bağlantısı kopan oyuncunun yeri bu kadar korunur
  hostHandoffMs: 15_000, // host bu kadar kopuk kalırsa oda sahipliği bağlı birine geçer
  emptyRoomMs: 600_000, // herkes kopmuşsa oda bu süre sonra silinir
  idleRoomMs: Number(process.env.ROOM_IDLE_MS) || 2 * 3600_000, // 2 saat hiç mesaj yoksa oda silinir
  hellosPerSocket: 3, // tek bağlantıdan sınırsız kimlik üretilmesin
  // Gerçek zamanlı oyunlar (PLAN.md §3.7): girdi + ping genel sayaçtan ayrı, saniyede en fazla bu kadar işlenir.
  fastWindowMs: 1000,
  fastMaxMessages: 64, // fazlası sessizce düşer
  fastKillMessages: 600, // pencerede bunu aşan bağlantı kapanır (sel)
  fastMaxBytes: 256,
  frameSkipBytes: 32 * 1024, // yavaş sokete kare biriktirme: tampon doluysa kare atlanır (bağlantı kesilmez)
  maxLoopCatchUp: 8, // takılmadan sonra en fazla bu kadar adım yetişilir
  maxLiveLoops: 20, // sunucu genelinde aynı anda en fazla bu kadar gerçek zamanlı maç
  killGraceMs: 200, // hız sınırı aşan bağlantı: kapanış çerçevesi gider, bu kadar sonra soket yok edilir
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPRSTUVYZ';

export { GameError };

// Kimlikler data/identities.json'da kalıcı (sunucu yeniden başlasa da aynı kişi aynı kişi; günlük sıralama buna dayanır).
// socket ve roomCode sadece çalışma zamanı alanları, dosyaya yazılmaz.
const identityStore = jsonStore('identities', {});
const identities = new Map(
  Object.values(identityStore.data).map((i) => [i.id, { ...i, socket: null, roomCode: null }]),
); // playerId -> { id, token, name, socket, roomCode, lastSeen, createdAt? }

function persistIdentity(identity) {
  identityStore.data[identity.id] = { id: identity.id, token: identity.token, name: identity.name, lastSeen: identity.lastSeen, ...(identity.createdAt ? { createdAt: identity.createdAt } : {}) };
  identityStore.save();
}
const rooms = new Map(); // code -> room
const loops = new Set(); // gerçek zamanlı döngüsü çalışan odalar (testler sızıntı için sayar)
let roomCounter = 0;

const scaled = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

// ---------- Yardımcılar ----------

// Kontrol karakterleri, sıfır genişlikli ve yön değiştiren karakterler atılır.
const BAD_CHARS = new RegExp(`[${['0000-001f', '007f-009f', '200b-200f', '2028-202e', '2060-2069', 'feff-feff'].map((r) => r.split('-').map((h) => `\\u${h}`).join('-')).join('')}]`, 'g');

export function sanitizeName(raw) {
  const clean = str(raw).replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim();
  const chars = [...clean].slice(0, LIMITS.nameMaxLength).join('').trim();
  return chars || 'Oyuncu';
}

function uniqueName(room, name, exceptId) {
  const taken = new Set([...room.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name.toLocaleLowerCase('tr')));
  if (!taken.has(name.toLocaleLowerCase('tr'))) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = [...name].slice(0, LIMITS.nameMaxLength - suffix.length).join('') + suffix;
    if (!taken.has(candidate.toLocaleLowerCase('tr'))) return candidate;
  }
}

function newCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const bytes = randomBytes(4);
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!rooms.has(code)) return code;
  }
  throw new GameError('Oda kodu üretilemedi, tekrar dene.');
}

const MAX_BUFFERED_BYTES = 1_000_000;

function send(socket, msg) {
  if (!socket || socket.readyState !== 1) return;
  // Okumayan (veya çok yavaş) istemciye mesaj biriktirme: bellek tükenmesin.
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.terminate(); return; }
  socket.send(JSON.stringify(msg));
}

function sendError(socket, code, message) {
  send(socket, { t: 'error', code, message });
}

// ---------- Oda durumu yayını ----------

function roomInfo(room) {
  return {
    code: room.code,
    game: room.gameId,
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId, spectator: p.spectator })),
    settings: room.settings,
    // Oyuna özel hazırlık verisinin herkese açık özeti (ör. Shazam: kaç şarkı, hangi kaynaklar)
    prep: room.game.prepInfo ? room.game.prepInfo(room.prep) : null,
    minPlayers: room.game.minPlayers,
    maxPlayers: Math.min(room.game.maxPlayers, LIMITS.maxPlayersPerRoom),
  };
}

function viewFor(room, playerId) {
  if (!room.state) return null;
  try {
    return room.game.view(room.state, playerId);
  } catch (err) {
    console.error(`[${room.code}] view hatası:`, err);
    return null;
  }
}

// Büyük ve oyun boyunca değişmeyen veri (ör. Shazam öneri listesi) her görünümde değil, oyuncu başına bir kez gider.
// game.shared(state) → { key, data }; anahtar değişince (yeni oyun) veya yeniden bağlanınca tekrar gönderilir.
function sendShared(room, p, socket) {
  const sh = room.state && room.game.shared ? room.game.shared(room.state) : null;
  if (!sh || p.sharedKey === sh.key) return;
  send(socket, { t: 'shared', key: sh.key, data: sh.data });
  p.sharedKey = sh.key;
}

function sendTo(room, p, info = roomInfo(room)) {
  const socket = identities.get(p.id)?.socket;
  if (!socket) return;
  send(socket, { t: 'room', room: info });
  if (room.state) {
    sendShared(room, p, socket);
    send(socket, { t: 'view', view: viewFor(room, p.id), seq: room.seq, serverNow: Date.now() });
  }
}

function broadcast(room) {
  const info = roomInfo(room);
  room.seq++;
  for (const p of room.players.values()) sendTo(room, p, info);
}

// ---------- Oyun bağlamı ve zamanlayıcı ----------

function makeCtx(room) {
  return {
    now: Date.now(),
    rng: room.rng,
    hostId: room.hostId,
    roomCode: room.code, // medya jetonlarını odaya bağlamak için (server/media-tokens.js)
    timeScale: TIME_SCALE,
    // ms: oyun süresi (gerçek dakika cinsinden düşünülür); dönen değer bitiş anı (epoch ms, ölçeklenmiş).
    // Aynı anda birden fazla zamanlayıcı olabilir (ör. gündüz saati + aday destek süresi); isim verilmezse 'main'.
    // Dolunca game.tick(state, ctx, name) çağrılır.
    setTimer(ms, name = 'main') {
      clearTimeout(room.timers.get(name)?.handle);
      const delay = scaled(ms);
      const token = ++room.timerSeq;
      room.timers.set(name, { token, handle: setTimeout(() => runTick(room, name, token), delay) });
      return Date.now() + delay;
    },
    clearTimer(name = 'main') {
      clearTimeout(room.timers.get(name)?.handle);
      room.timers.delete(name);
    },
    log: (...args) => console.log(`[${room.code}]`, ...args),
  };
}

function clearAllTimers(room) {
  for (const t of room.timers.values()) clearTimeout(t.handle);
  room.timers.clear();
}

function afterChange(room) {
  if (room.state && room.phase === 'playing' && room.game.isOver(room.state)) {
    room.phase = 'over';
    clearAllTimers(room);
  }
  if (room.phase === 'playing' && room.state && room.game.realtime) startLoop(room);
  else stopLoop(room);
  broadcast(room);
}

// ---------- Gerçek zamanlı döngü (opsiyonel oyun kancası) ----------
// game.realtime = { hz, sendHz, step(state, ctx) → görünüm değişti mi, frame(state) → herkese aynı kısa kare }.
// Faz 'playing' iken oda başına tek setInterval; birikimli sabit adım (performance.now) ile hz kez/sn step,
// sendHz kez/sn kare. Kare bir kez JSON'lanır, tüm soketlere aynı metin gider. Bkz. PLAN.md §3.7.

function startLoop(room) {
  if (room.loop) return;
  const rt = room.game.realtime;
  const stepMs = 1000 / rt.hz;
  const loop = {
    handle: null, last: performance.now(), acc: 0, ticks: 0, seq: 0, stepMs,
    sendEvery: Math.max(1, Math.round(rt.hz / rt.sendHz)),
    ctx: { timeScale: TIME_SCALE, rng: room.rng, log: (...args) => console.log(`[${room.code}]`, ...args) },
  };
  loop.handle = setInterval(() => runLoop(room, loop), Math.max(1, Math.floor(stepMs)));
  room.loop = loop;
  loops.add(room);
}

function stopLoop(room) {
  if (!room.loop) return;
  clearInterval(room.loop.handle);
  room.loop = null;
  loops.delete(room);
}

function runLoop(room, loop) {
  if (rooms.get(room.code) !== room || room.loop !== loop || room.phase !== 'playing' || !room.state) return stopLoop(room);
  const rt = room.game.realtime;
  const now = performance.now();
  loop.acc = Math.min(loop.acc + now - loop.last, loop.stepMs * LIMITS.maxLoopCatchUp);
  loop.last = now;
  try {
    while (loop.acc >= loop.stepMs) {
      loop.acc -= loop.stepMs;
      // Görünüm (ör. yeni disk listesi) aynı adımın karesinden ÖNCE gider: istemci yeni sürümü tanısın.
      if (rt.step(room.state, loop.ctx) || room.game.isOver(room.state)) {
        afterChange(room);
        if (room.loop !== loop) return; // maç bitti
      }
      if (++loop.ticks % loop.sendEvery === 0) sendFrame(room, loop);
    }
  } catch (err) {
    // Bir kez loglanır; maç "teknik hata" ile biter (oda kilitli kalmaz, host bekleme odasına dönebilir).
    console.error(`[${room.code}] realtime hatası:`, err);
    stopLoop(room);
    try { room.game.abort?.(room.state, err); } catch { /* yok say */ }
    room.phase = 'over';
    clearAllTimers(room);
    broadcast(room);
  }
}

function sendFrame(room, loop) {
  const frame = room.game.realtime.frame(room.state);
  frame.t = 'frame';
  frame.s = ++loop.seq;
  const data = JSON.stringify(frame);
  for (const p of room.players.values()) {
    const socket = identities.get(p.id)?.socket;
    if (!socket || socket.readyState !== 1) continue;
    if (socket.bufferedAmount > LIMITS.frameSkipBytes) { socket.framesSkipped = (socket.framesSkipped ?? 0) + 1; continue; }
    socket.send(data);
  }
}

function runTick(room, name, token) {
  if (rooms.get(room.code) !== room || room.timers.get(name)?.token !== token || !room.state || room.phase !== 'playing') return;
  room.timers.delete(name);
  try {
    room.game.tick?.(room.state, makeCtx(room), name);
  } catch (err) {
    console.error(`[${room.code}] tick hatası:`, err);
  }
  afterChange(room);
}

// ---------- Oda işlemleri ----------

function createRoom(identity, gameId, ip) {
  const game = Object.hasOwn(GAMES, gameId) ? GAMES[gameId] : null;
  if (!game) throw new GameError('Böyle bir oyun yok.');
  // Önce kontroller: reddedilen istek kullanıcıyı mevcut odasından çıkarmasın. Ayrılacağı kendi odası sayılmaz.
  const own = identity.roomCode && rooms.get(identity.roomCode);
  const freesOwn = own && own.players.size === 1 ? 1 : 0;
  if (rooms.size - freesOwn >= LIMITS.maxRooms) throw new GameError('Sunucu dolu, biraz sonra tekrar dene.');
  const fromIp = [...rooms.values()].filter((r) => r.creatorIp === ip && !(r === own && freesOwn)).length;
  if (fromIp >= IP_LIMITS.roomsPerIp) throw new GameError('Bu ağdan çok fazla oda açık. Eski odaları kapatın.');
  leaveRoom(identity, 'switch');
  const code = newCode();
  roomCounter++;
  const room = {
    code,
    gameId,
    game,
    hostId: identity.id,
    creatorIp: ip,
    lastActivity: Date.now(),
    phase: 'lobby',
    players: new Map(),
    settings: game.validateSettings({ ...game.defaultSettings }),
    prep: game.initialPrep ? game.initialPrep() : null, // oyunlar arası korunur (bekleme odasında host doldurur)
    state: null,
    rng: BASE_SEED != null ? createRng(BASE_SEED + roomCounter) : cryptoRng(),
    timers: new Map(), // isim -> { token, handle }
    timerSeq: 0,
    seq: 0,
    emptyTimer: null,
  };
  rooms.set(code, room);
  addPlayer(room, identity);
  return room;
}

function addPlayer(room, identity, { spectator = false } = {}) {
  room.players.set(identity.id, {
    id: identity.id,
    name: uniqueName(room, identity.name ?? 'Oyuncu', identity.id),
    connected: true,
    joinedAt: Date.now() + room.players.size, // aynı ms'de katılanlar için sıra
    spectator,
    leaveTimer: null,
  });
  identity.roomCode = room.code;
  clearTimeout(room.emptyTimer);
}

function joinRoom(identity, rawCode) {
  const code = str(rawCode).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const room = rooms.get(code);
  if (!room) throw new GameError('Bu kodla bir oda bulunamadı.');
  if (identity.roomCode === code && room.players.has(identity.id)) return reconnect(identity, room);
  leaveRoom(identity, 'switch');
  const max = Math.min(room.game.maxPlayers, LIMITS.maxPlayersPerRoom);
  if (room.players.size >= max) throw new GameError('Oda dolu.');
  // Oyun sürerken gelen yeni kişi izleyici olur; lobiye dönünce oyuncu olur.
  addPlayer(room, identity, { spectator: room.phase !== 'lobby' });
  broadcast(room);
}

function reconnect(identity, room) {
  const p = room.players.get(identity.id);
  if (!p) return;
  const wasConnected = p.connected;
  p.connected = true;
  p.sharedKey = null; // yeni soket paylaşılan veriyi almadı
  clearTimeout(p.leaveTimer);
  p.leaveTimer = null;
  clearTimeout(room.emptyTimer);
  if (!wasConnected) notifyConnection(room, p, true);
  // Zaten bağlıysa (ör. tekrar "join") sadece ona gönder: herkese yeniden yayın yapıp trafik çoğaltılmasın.
  if (wasConnected) sendTo(room, p);
  else broadcast(room);
}

// Opsiyonel oyun kancası: oyun sırasında oyuncunun bağlantısı koptu / geri geldi (ör. Tosun Top diski durdurur).
function notifyConnection(room, p, connected) {
  if (!room.state || room.phase !== 'playing' || p.spectator || !room.game.onConnection) return;
  try {
    room.game.onConnection(room.state, p.id, connected, makeCtx(room));
  } catch (err) {
    console.error(`[${room.code}] onConnection hatası:`, err);
  }
}

// Oda sahibi adayı: bağlı oyuncu > bağlı izleyici > herhangi biri; eşitlikte en eski katılan.
// (İzleyici host olursa oyun "sonraki tur"da takılır.)
function pickHost(room) {
  const score = (p) => (p.connected ? 2 : 0) + (p.spectator && room.phase !== 'lobby' ? 0 : 1);
  return [...room.players.values()].sort((a, b) => score(b) - score(a) || a.joinedAt - b.joinedAt)[0];
}

// Ayar nesnesinden sadece düz değerleri al (nesne/dizi tuzakları validateSettings'e ulaşmasın).
function primitives(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  return out;
}

function removePlayer(room, playerId, reason) {
  const p = room.players.get(playerId);
  if (!p) return;
  clearTimeout(p.leaveTimer);
  room.players.delete(playerId);
  const identity = identities.get(playerId);
  if (identity?.roomCode === room.code) identity.roomCode = null;

  if (room.state && room.phase === 'playing' && !p.spectator) {
    try {
      room.game.onPlayerLeave?.(room.state, playerId, makeCtx(room));
    } catch (err) {
      console.error(`[${room.code}] onPlayerLeave hatası:`, err);
    }
  }
  if (room.players.size === 0) return deleteRoom(room);
  if (room.hostId === playerId) {
    room.hostId = pickHost(room).id;
  }
  if (reason) room.lastEvent = reason;
  afterChange(room);
}

function deleteRoom(room) {
  stopLoop(room);
  clearAllTimers(room);
  clearTimeout(room.hostTimer);
  clearTimeout(room.emptyTimer);
  for (const p of room.players.values()) clearTimeout(p.leaveTimer);
  rooms.delete(room.code);
}

function leaveRoom(identity, reason = 'leave') {
  const room = identity.roomCode && rooms.get(identity.roomCode);
  identity.roomCode = null;
  if (room) removePlayer(room, identity.id, reason);
}

function onDisconnect(identity) {
  const room = identity.roomCode && rooms.get(identity.roomCode);
  if (!room) return;
  const p = room.players.get(identity.id);
  if (!p) return;
  p.connected = false;
  notifyConnection(room, p, false);
  p.leaveTimer = setTimeout(() => removePlayer(room, identity.id, 'timeout'), scaled(LIMITS.seatHoldMs));
  if (room.hostId === identity.id) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room || room.hostId !== identity.id || room.players.get(identity.id)?.connected) return;
      const next = pickHost(room);
      if (next.connected && next.id !== identity.id) { room.hostId = next.id; broadcast(room); }
    }, scaled(LIMITS.hostHandoffMs));
  }
  if (![...room.players.values()].some((x) => x.connected)) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => deleteRoom(room), scaled(LIMITS.emptyRoomMs));
  }
  broadcast(room);
}

// ---------- Mesaj işleyici ----------

function requireRoom(identity) {
  const room = identity.roomCode && rooms.get(identity.roomCode);
  if (!room) throw new GameError('Bir odada değilsin.');
  return room;
}

function requireHost(room, identity) {
  if (room.hostId !== identity.id) throw new GameError('Bunu sadece oda sahibi yapabilir.');
}

const handlers = {
  create(identity, msg, socket) {
    const room = createRoom(identity, str(msg.game), socket.ip);
    broadcast(room);
  },
  join(identity, msg) {
    joinRoom(identity, msg.code);
  },
  leave(identity, _msg, socket) {
    leaveRoom(identity);
    send(socket, { t: 'room', room: null });
  },
  settings(identity, msg) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    if (room.phase !== 'lobby') throw new GameError('Ayarlar sadece bekleme odasında değişir.');
    const incoming = msg.settings && typeof msg.settings === 'object' && !Array.isArray(msg.settings) ? primitives(msg.settings) : {};
    room.settings = room.game.validateSettings({ ...room.settings, ...incoming });
    broadcast(room);
  },
  // Host bekleme odasında oyuna özel veri gönderir (ör. Shazam şarkı listesi, parça parça). Oyun modülü doğrular.
  prep(identity, msg) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    if (!room.game.prep) throw new GameError('Bu oyunda hazırlık yok.');
    if (room.phase !== 'lobby') throw new GameError('Hazırlık sadece bekleme odasında yapılır.');
    const data = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : {};
    room.prep = room.game.prep(room.prep, data);
    broadcast(room);
  },
  // Bekleme odasında her oyuncunun yapabildiği oyuna özel seçim (ör. Tosun Top takım seçimi). Oyun modülü doğrular
  // ve yeni prep döner: game.lobbyAction(prep, playerId, data, { isHost, playerIds, rng }).
  lobbyAction(identity, msg) {
    const room = requireRoom(identity);
    if (!room.game.lobbyAction) throw new GameError('Bu oyunda bu işlem yok.');
    if (room.phase !== 'lobby') throw new GameError('Bu sadece bekleme odasında yapılır.');
    const data = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? primitives(msg.data) : {};
    room.prep = room.game.lobbyAction(room.prep, identity.id, data, {
      isHost: room.hostId === identity.id, playerIds: [...room.players.keys()], rng: room.rng,
    });
    broadcast(room);
  },
  start(identity) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    if (room.phase !== 'lobby') throw new GameError('Oyun zaten başladı.');
    const players = [...room.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    if (players.length < room.game.minPlayers) throw new GameError(`Bu oyun için en az ${room.game.minPlayers} kişi gerekli.`);
    if (room.game.realtime) {
      // Gerçek zamanlı maç işlemci yer: sunucu geneli ve oda kuran ağ başına sınır.
      if (loops.size >= LIMITS.maxLiveLoops) throw new GameError('Sunucuda şu an çok fazla canlı maç var, biraz sonra tekrar dene.');
      const fromIp = [...loops].filter((r) => r.creatorIp === room.creatorIp).length;
      if (fromIp >= IP_LIMITS.liveLoopsPerIp) throw new GameError(`Bu ağdan aynı anda en fazla ${IP_LIMITS.liveLoopsPerIp} canlı maç oynanabilir.`);
    }
    const notReady = room.game.canStart?.(room.prep, room.settings, [...room.players.values()].map((p) => ({ id: p.id, connected: p.connected })));
    if (notReady) throw new GameError(notReady);
    // Kopuk oyuncular oyuna alınmaz, izleyici olur.
    for (const p of room.players.values()) p.spectator = !p.connected;
    const ctx = makeCtx(room);
    room.state = room.game.setup({ players: players.map((p) => ({ id: p.id, name: p.name })), settings: room.settings, prep: room.prep, rng: room.rng, ctx });
    room.phase = 'playing';
    afterChange(room);
  },
  action(identity, msg) {
    const room = requireRoom(identity);
    if (room.phase !== 'playing' || !room.state) throw new GameError('Şu an oyun oynanmıyor.');
    const p = room.players.get(identity.id);
    if (!p || p.spectator) throw new GameError('İzleyiciler oyuna müdahale edemez.');
    const action = msg.action && typeof msg.action === 'object' ? msg.action : {};
    room.game.action(room.state, identity.id, action, makeCtx(room));
    afterChange(room);
  },
  kick(identity, msg) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    const targetId = str(msg.playerId);
    if (targetId === identity.id || !room.players.has(targetId)) throw new GameError('Bu oyuncu çıkarılamaz.');
    const target0 = room.players.get(targetId);
    // Oyun sırasında host kick ile oyunu yönlendiremesin (ör. köylüleri atıp vampirleri kazandırmak).
    if (room.phase === 'playing' && target0.connected && !target0.spectator) {
      throw new GameError('Oyun sırasında sadece bağlantısı kopmuş oyuncular çıkarılabilir.');
    }
    // Oyun ortası gelen izleyici host olduysa, bağlantısı kısa süre kopan oyuncuları atıp oyunu bitiremesin.
    if (room.phase === 'playing' && room.players.get(identity.id)?.spectator && !target0.spectator) {
      throw new GameError('İzleyici, oyun sırasında oyuncu çıkaramaz.');
    }
    const target = identities.get(targetId);
    removePlayer(room, targetId, 'kick');
    send(target?.socket, { t: 'kicked' });
    send(target?.socket, { t: 'room', room: null });
  },
  rename(identity, msg) {
    const room = identity.roomCode && rooms.get(identity.roomCode);
    if (room && room.phase !== 'lobby') throw new GameError('Ad sadece bekleme odasında değişir.');
    identity.name = sanitizeName(msg.name);
    persistIdentity(identity);
    if (room) {
      room.players.get(identity.id).name = uniqueName(room, identity.name, identity.id);
      broadcast(room);
    }
    send(identity.socket, { t: 'welcome', playerId: identity.id, token: identity.token, name: identity.name });
  },
  backToLobby(identity) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    // Oyun sürerken host oyunu iptal edemez (ör. asılmak üzere olan vampir host sonucu engelleyemesin).
    if (room.phase === 'playing') throw new GameError('Oyun bitmeden bekleme odasına dönülemez.');
    clearAllTimers(room);
    stopLoop(room);
    room.state = null;
    room.phase = 'lobby';
    for (const p of room.players.values()) p.spectator = false;
    broadcast(room);
  },
};

// playerId + token doğruysa mevcut kimlik, değilse yeni kimlik. HTTP uçları (günlük bulmacalar) da bunu kullanır.
export function resolveIdentity({ playerId, token, name } = {}, ip = null) {
  let identity = typeof playerId === 'string' ? identities.get(playerId) : null;
  if (!identity || typeof token !== 'string' || identity.token !== token) {
    if (ip && !identityLimiter.hit(ip)) throw new GameError('Bu ağdan çok fazla yeni oyuncu oluşturuldu. Biraz sonra tekrar dene.');
    if (identities.size >= LIMITS.maxIdentities) pruneIdentities();
    // createdAt: günlük sıralamada aynı gün açılan yan hesaplar "sıralama dışı" (eski kayıtlarda yok = eski hesap)
    identity = { id: randomUUID(), token: randomBytes(16).toString('hex'), name: null, socket: null, roomCode: null, lastSeen: Date.now(), createdAt: Date.now() };
    identities.set(identity.id, identity);
  }
  if (str(name).trim()) identity.name = sanitizeName(name);
  identity.lastSeen = Date.now();
  persistIdentity(identity);
  return identity;
}

// Sadece doğrulama: yeni kimlik üretmez.
export function verifyIdentity(playerId, token) {
  const identity = typeof playerId === 'string' && identities.get(playerId);
  return identity && typeof token === 'string' && identity.token === token ? identity : null;
}

function handleHello(socket, msg) {
  socket.hellos = (socket.hellos ?? 0) + 1;
  if (socket.hellos > LIMITS.hellosPerSocket) return socket.close(1008, 'too many hellos');
  let identity;
  try {
    identity = resolveIdentity(msg, socket.ip);
  } catch (err) {
    if (!(err instanceof GameError)) console.error('hello hatası:', err);
    return sendError(socket, 'identity', err instanceof GameError ? err.message : 'Kimlik doğrulanamadı.');
  }
  // Aynı bağlantıda kimlik değişirse eski kimliğin bağlantısı kopmuş sayılır.
  if (socket.identity && socket.identity !== identity && socket.identity.socket === socket) {
    socket.identity.socket = null;
    onDisconnect(socket.identity);
  }
  // Aynı kimlikle ikinci sekme açılırsa eskisi kapanır.
  if (identity.socket && identity.socket !== socket) {
    send(identity.socket, { t: 'error', code: 'replaced', message: 'Başka bir sekmeden bağlandın.' });
    identity.socket.close(4000, 'replaced');
  }
  identity.socket = socket;
  identity.lastSeen = Date.now();
  socket.identity = identity;
  send(socket, { t: 'welcome', playerId: identity.id, token: identity.token, name: identity.name });

  const room = identity.roomCode && rooms.get(identity.roomCode);
  if (room?.players.has(identity.id)) reconnect(identity, room);
  else send(socket, { t: 'room', room: null });
}

// Kimlik sayısı sınıra ulaşınca: önce 60 günden eski olanlar, yetmezse en eski bağlı olmayanlar silinir.
function pruneIdentities() {
  const idle = [...identities.values()].filter((i) => !i.socket && !i.roomCode).sort((a, b) => a.lastSeen - b.lastSeen);
  const cutoff = Date.now() - 60 * 24 * 3600_000;
  const drop = idle.filter((i) => i.lastSeen < cutoff);
  if (identities.size - drop.length >= LIMITS.maxIdentities) drop.push(...idle.slice(drop.length, drop.length + 100));
  for (const i of drop) {
    identities.delete(i.id);
    delete identityStore.data[i.id];
  }
  identityStore.save();
}

// Hızlı yol: gerçek zamanlı girdi ve ping. Kendi hız sınırı var, görünüm üretmez, hata yanıtı göndermez.
// Hız sınırını aşan bağlantı: kapanış çerçevesi (1008) gider, kısa süre sonra soket yok edilir. O ana kadar gelen
// mesajlar hiç ayrıştırılmaz (socket.dead).
function kill(socket) {
  if (socket.dead) return;
  socket.dead = true;
  clearTimeout(socket.pendingTimer);
  socket.close(1008, 'rate limit');
  setTimeout(() => socket.terminate(), LIMITS.killGraceMs);
}

function playingRoom(identity) {
  const room = identity?.roomCode && rooms.get(identity.roomCode);
  return room && room.phase === 'playing' && room.state ? room : null;
}

function applyInput(socket, msg, now) {
  const identity = socket.identity;
  const room = playingRoom(identity);
  if (!room || !room.game.input) return;
  const p = room.players.get(identity.id);
  if (!p || p.spectator) return;
  room.lastActivity = now;
  try {
    room.game.input(room.state, identity.id, msg);
  } catch (err) {
    console.error(`[${room.code}] input hatası:`, err);
  }
}

function handleFast(socket, msg, now) {
  if (now - socket.fast.start > LIMITS.fastWindowMs) { socket.fast.start = now; socket.fast.count = 0; }
  if (++socket.fast.count > LIMITS.fastKillMessages) return kill(socket);
  const identity = socket.identity;
  if (!identity) return;
  if (socket.fast.count > LIMITS.fastMaxMessages) {
    // Pencere doldu: en yeni girdi bekletilir ve pencere sıfırlanınca uygulanır (yön değişimi kaybolmasın).
    if (msg.t !== 'input') return;
    socket.pendingInput = msg;
    if (!socket.pendingTimer) {
      socket.pendingTimer = setTimeout(() => {
        socket.pendingTimer = null;
        const pending = socket.pendingInput;
        socket.pendingInput = null;
        if (!pending || socket.dead || socket.readyState !== 1) return;
        const t = Date.now();
        if (t - socket.fast.start > LIMITS.fastWindowMs) { socket.fast.start = t; socket.fast.count = 0; }
        socket.fast.count++;
        applyInput(socket, pending, t);
      }, Math.max(1, socket.fast.start + LIMITS.fastWindowMs - now + 1));
    }
    return;
  }
  if (msg.t === 'ping') {
    // Sadece oynanan bir odadayken (gecikme göstergesi); odasız ping yanıtsız düşer.
    if (playingRoom(identity) && typeof msg.c === 'number' && Number.isFinite(msg.c)) send(socket, { t: 'pong', c: msg.c, now: Date.now() });
    return;
  }
  socket.pendingInput = null; // daha yeni girdi geldi
  applyInput(socket, msg, now);
}

// raw: metin, bytes: ham uzunluk (bayt). Kısa mesajlar önce ayrıştırılır (hızlı yol); uzunlar önce hız sınırından geçer.
function handleMessage(socket, raw, bytes = Buffer.byteLength(raw)) {
  if (socket.dead) return;
  const now = Date.now();
  let msg;
  const parse = () => { try { return JSON.parse(raw); } catch { return undefined; } };
  const small = bytes <= LIMITS.fastMaxBytes;
  if (small) {
    msg = parse();
    if (msg && (msg.t === 'input' || msg.t === 'ping')) return handleFast(socket, msg, now);
  }

  // Hız sınırı
  if (now - socket.rate.start > LIMITS.rateWindowMs) socket.rate = { start: now, count: 0, warned: false };
  socket.rate.count++;
  if (socket.rate.count > LIMITS.rateKillMessages) return kill(socket);
  if (socket.rate.count > LIMITS.rateMaxMessages) {
    if (!socket.rate.warned) sendError(socket, 'rate', 'Çok hızlı! Biraz yavaşla.');
    socket.rate.warned = true;
    return;
  }

  if (!small) msg = parse();
  if (msg === undefined) return sendError(socket, 'bad_json', 'Geçersiz mesaj.');
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return sendError(socket, 'bad_msg', 'Geçersiz mesaj.');

  if (msg.t === 'hello') return handleHello(socket, msg);
  const identity = socket.identity;
  if (!identity) return sendError(socket, 'no_hello', 'Önce kimlik gönder.');
  const handler = Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
  if (!handler) return sendError(socket, 'unknown', 'Bilinmeyen mesaj.');
  identity.lastSeen = now;
  const activeRoom = identity.roomCode && rooms.get(identity.roomCode);
  if (activeRoom) activeRoom.lastActivity = now;
  try {
    handler(identity, msg, socket);
  } catch (err) {
    if (err instanceof GameError) sendError(socket, 'game', err.message);
    else {
      console.error('Lobi hatası:', err);
      sendError(socket, 'internal', 'Bir şeyler ters gitti.');
    }
  }
}

// ---------- HTTP sunucusuna bağla ----------

export function attachLobby(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  const socketsByIp = new Map();
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { url = null; }
    if (!url) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }
    const ip = clientIp(req);
    if ((socketsByIp.get(ip) ?? 0) >= IP_LIMITS.socketsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return socket.destroy();
    }
    // Başka sitelerden gelen WebSocket bağlantılarını reddet (Origin varsa Host ile aynı olmalı).
    const origin = req.headers.origin;
    let sameOrigin = true;
    if (origin) {
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    }
    if (url.pathname !== '/ws' || !sameOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.ip = ip; wss.emit('connection', ws, req); });
  });

  wss.on('connection', (socket) => {
    socketsByIp.set(socket.ip, (socketsByIp.get(socket.ip) ?? 0) + 1);
    socket.rate = { start: Date.now(), count: 0, warned: false };
    socket.fast = { start: Date.now(), count: 0 };
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, isBinary) => {
      if (socket.dead) return;
      if (isBinary) return socket.close(1003, 'binary');
      handleMessage(socket, data.toString(), data.length);
    });
    socket.on('close', () => {
      clearTimeout(socket.pendingTimer);
      const n = (socketsByIp.get(socket.ip) ?? 1) - 1;
      if (n > 0) socketsByIp.set(socket.ip, n); else socketsByIp.delete(socket.ip);
      const identity = socket.identity;
      if (identity && identity.socket === socket) {
        identity.socket = null;
        identity.lastSeen = Date.now();
        onDisconnect(identity);
      }
    });
    socket.on('error', () => {});
  });

  // Ölü bağlantıları yakala (telefon uykuya geçti, Wi-Fi koptu).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
    const idleCutoff = Date.now() - LIMITS.idleRoomMs;
    for (const room of rooms.values()) {
      if (room.lastActivity < idleCutoff) {
        for (const p of room.players.values()) {
          const ident = identities.get(p.id);
          if (ident?.roomCode === room.code) { ident.roomCode = null; send(ident.socket, { t: 'room', room: null }); }
        }
        deleteRoom(room);
      }
    }
  }, 15_000);
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

// Testler ve izleme için
// Sadece testler (server.js bunu TEST_GAMES=1 iken /api/_test/secret ile açar): odanın gizli oyun verisi.
export function _testRoomSecrets(code) {
  const s = rooms.get(String(code))?.state;
  return s ? { targets: s.targets ?? null, stimuli: s.stimuli ?? null } : null;
}

export function stats() {
  return { rooms: rooms.size, identities: identities.size, timeScale: TIME_SCALE, loops: loops.size };
}
