// Lobi / oda yöneticisi: kimlik, oda kur/katıl, yeniden bağlanma, host devri, oyun eylemlerini yönlendirme.
// Sunucu yetkilidir: oyun durumu burada yaşar, istemciye sadece view(state, playerId) gider. Bkz. PLAN.md §3.
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRng } from './rng.js';
import { GameError } from './errors.js';
import { jsonStore } from './store.js';
import { IP_LIMITS, clientIp, identityLimiter } from './limits.js';
import { GAMES } from './games/index.js';

const TIME_SCALE = Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1;
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
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPRSTUVYZ';

export { GameError };

// Kimlikler data/identities.json'da kalıcı (sunucu yeniden başlasa da aynı kişi aynı kişi; günlük sıralama buna dayanır).
// socket ve roomCode sadece çalışma zamanı alanları, dosyaya yazılmaz.
const identityStore = jsonStore('identities', {});
const identities = new Map(
  Object.values(identityStore.data).map((i) => [i.id, { ...i, socket: null, roomCode: null }]),
); // playerId -> { id, token, name, socket, roomCode, lastSeen }

function persistIdentity(identity) {
  identityStore.data[identity.id] = { id: identity.id, token: identity.token, name: identity.name, lastSeen: identity.lastSeen };
  identityStore.save();
}
const rooms = new Map(); // code -> room
let roomCounter = 0;

const scaled = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

// ---------- Yardımcılar ----------

// Kontrol karakterleri, sıfır genişlikli ve yön değiştiren karakterler atılır.
const BAD_CHARS = new RegExp(`[${['0000-001f', '007f-009f', '200b-200f', '2028-202e', '2060-2069', 'feff-feff'].map((r) => r.split('-').map((h) => `\\u${h}`).join('-')).join('')}]`, 'g');

export function sanitizeName(raw) {
  const clean = String(raw ?? '').replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim();
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

function send(socket, msg) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
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

function broadcast(room) {
  const info = roomInfo(room);
  room.seq++;
  for (const p of room.players.values()) {
    const socket = identities.get(p.id)?.socket;
    if (!socket) continue;
    send(socket, { t: 'room', room: info });
    if (room.state) send(socket, { t: 'view', view: viewFor(room, p.id), seq: room.seq, serverNow: Date.now() });
  }
}

// ---------- Oyun bağlamı ve zamanlayıcı ----------

function makeCtx(room) {
  return {
    now: Date.now(),
    rng: room.rng,
    hostId: room.hostId,
    timeScale: TIME_SCALE,
    // ms: oyun süresi (gerçek dakika cinsinden düşünülür); dönen değer bitiş anı (epoch ms, ölçeklenmiş)
    setTimer(ms) {
      clearTimeout(room.timer);
      const delay = scaled(ms);
      const token = ++room.timerToken;
      room.timer = setTimeout(() => runTick(room, token), delay);
      return Date.now() + delay;
    },
    clearTimer() {
      clearTimeout(room.timer);
      room.timer = null;
      room.timerToken++;
    },
    log: (...args) => console.log(`[${room.code}]`, ...args),
  };
}

function afterChange(room) {
  if (room.state && room.phase === 'playing' && room.game.isOver(room.state)) {
    room.phase = 'over';
    clearTimeout(room.timer);
  }
  broadcast(room);
}

function runTick(room, token) {
  if (!rooms.has(room.code) || token !== room.timerToken || !room.state || room.phase !== 'playing') return;
  room.timer = null;
  try {
    room.game.tick?.(room.state, makeCtx(room));
  } catch (err) {
    console.error(`[${room.code}] tick hatası:`, err);
  }
  afterChange(room);
}

// ---------- Oda işlemleri ----------

function createRoom(identity, gameId, ip) {
  const game = Object.hasOwn(GAMES, gameId) ? GAMES[gameId] : null;
  if (!game) throw new GameError('Böyle bir oyun yok.');
  leaveRoom(identity, 'switch');
  if (rooms.size >= LIMITS.maxRooms) throw new GameError('Sunucu dolu, biraz sonra tekrar dene.');
  const fromIp = [...rooms.values()].filter((r) => r.creatorIp === ip).length;
  if (fromIp >= IP_LIMITS.roomsPerIp) throw new GameError('Bu ağdan çok fazla oda açık. Eski odaları kapatın.');
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
    state: null,
    rng: createRng(BASE_SEED != null ? BASE_SEED + roomCounter : undefined),
    timer: null,
    timerToken: 0,
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
  const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
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
  p.connected = true;
  clearTimeout(p.leaveTimer);
  p.leaveTimer = null;
  clearTimeout(room.emptyTimer);
  broadcast(room);
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
    const next = [...room.players.values()].sort((a, b) => (b.connected - a.connected) || (a.joinedAt - b.joinedAt))[0];
    room.hostId = next.id;
  }
  if (reason) room.lastEvent = reason;
  afterChange(room);
}

function deleteRoom(room) {
  clearTimeout(room.timer);
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
  p.leaveTimer = setTimeout(() => removePlayer(room, identity.id, 'timeout'), scaled(LIMITS.seatHoldMs));
  if (room.hostId === identity.id) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.hostId !== identity.id || room.players.get(identity.id)?.connected) return;
      const next = [...room.players.values()].filter((x) => x.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) { room.hostId = next.id; broadcast(room); }
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
    const room = createRoom(identity, String(msg.game ?? ''), socket.ip);
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
    const incoming = msg.settings && typeof msg.settings === 'object' ? msg.settings : {};
    room.settings = room.game.validateSettings({ ...room.settings, ...incoming });
    broadcast(room);
  },
  start(identity) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    if (room.phase !== 'lobby') throw new GameError('Oyun zaten başladı.');
    const players = [...room.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    if (players.length < room.game.minPlayers) throw new GameError(`Bu oyun için en az ${room.game.minPlayers} kişi gerekli.`);
    // Kopuk oyuncular oyuna alınmaz, izleyici olur.
    for (const p of room.players.values()) p.spectator = !p.connected;
    const ctx = makeCtx(room);
    room.state = room.game.setup({ players: players.map((p) => ({ id: p.id, name: p.name })), settings: room.settings, rng: room.rng, ctx });
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
    const targetId = String(msg.playerId ?? '');
    if (targetId === identity.id || !room.players.has(targetId)) throw new GameError('Bu oyuncu çıkarılamaz.');
    const target = identities.get(targetId);
    removePlayer(room, targetId, 'kick');
    send(target?.socket, { t: 'kicked' });
    send(target?.socket, { t: 'room', room: null });
  },
  rename(identity, msg) {
    identity.name = sanitizeName(msg.name);
    persistIdentity(identity);
    const room = identity.roomCode && rooms.get(identity.roomCode);
    if (room) {
      if (room.phase !== 'lobby') throw new GameError('Ad sadece bekleme odasında değişir.');
      room.players.get(identity.id).name = uniqueName(room, identity.name, identity.id);
      broadcast(room);
    }
    send(identity.socket, { t: 'welcome', playerId: identity.id, token: identity.token, name: identity.name });
  },
  backToLobby(identity) {
    const room = requireRoom(identity);
    requireHost(room, identity);
    clearTimeout(room.timer);
    room.timerToken++;
    room.state = null;
    room.phase = 'lobby';
    for (const p of room.players.values()) p.spectator = false;
    broadcast(room);
  },
};

// playerId + token doğruysa mevcut kimlik, değilse yeni kimlik. HTTP uçları (günlük bulmacalar) da bunu kullanır.
export function resolveIdentity({ playerId, token, name } = {}, ip = null) {
  let identity = playerId && identities.get(String(playerId));
  if (!identity || typeof token !== 'string' || identity.token !== token) {
    if (ip && !identityLimiter.hit(ip)) throw new GameError('Bu ağdan çok fazla yeni oyuncu oluşturuldu. Biraz sonra tekrar dene.');
    if (identities.size >= LIMITS.maxIdentities) pruneIdentities();
    identity = { id: randomUUID(), token: randomBytes(16).toString('hex'), name: null, socket: null, roomCode: null, lastSeen: Date.now() };
    identities.set(identity.id, identity);
  }
  if (name != null && String(name).trim()) identity.name = sanitizeName(name);
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
    if (err instanceof GameError) return sendError(socket, 'identity', err.message);
    throw err;
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

function handleMessage(socket, raw) {
  // Hız sınırı
  const now = Date.now();
  if (now - socket.rate.start > LIMITS.rateWindowMs) socket.rate = { start: now, count: 0, warned: false };
  socket.rate.count++;
  if (socket.rate.count > LIMITS.rateKillMessages) return socket.close(1008, 'rate limit');
  if (socket.rate.count > LIMITS.rateMaxMessages) {
    if (!socket.rate.warned) sendError(socket, 'rate', 'Çok hızlı! Biraz yavaşla.');
    socket.rate.warned = true;
    return;
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(socket, 'bad_json', 'Geçersiz mesaj.');
  }
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
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return socket.close(1003, 'binary');
      handleMessage(socket, data.toString());
    });
    socket.on('close', () => {
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
export function stats() {
  return { rooms: rooms.size, identities: identities.size, timeScale: TIME_SCALE };
}
