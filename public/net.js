// Lobi sunucusuyla WebSocket bağlantısı: kimliği hatırlar, kopunca yeniden bağlanır. Bkz. PLAN.md §3.3.

const IDENTITY_KEY = 'tss:identity';

function loadIdentity() {
  try { return JSON.parse(localStorage.getItem(IDENTITY_KEY)) ?? {}; } catch { return {}; }
}
function saveIdentity(identity) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch { /* yok say */ }
}

class Net {
  constructor() {
    this.identity = loadIdentity(); // { playerId, token, name }
    this.ws = null;
    this.connected = false;
    this.room = null;
    this.view = null;
    this.shared = null; // oyun başına bir kez gelen büyük veri { key, data } (ör. Shazam öneri listesi)
    this.serverOffset = 0; // sunucu saati - yerel saat
    this.listeners = new Map();
    this.queue = [];
    this.retry = 0;
    this.stopped = false;
    this.replaced = false; // aynı kimlik başka sekmede açıldı; kullanıcı onaylamadan geri bağlanma
    this.gotRoom = false; // bağlandıktan sonra ilk oda bilgisi geldi mi
  }

  // Eski sürümler ad seçilmeden "Oyuncu" kaydediyordu; onu seçilmemiş say.
  get name() { const n = this.identity.name ?? ''; return n === 'Oyuncu' ? '' : n; }
  get playerId() { return this.identity.playerId ?? null; }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn(data);
    for (const fn of this.listeners.get('*') ?? []) fn(type, data);
  }

  connect() {
    if (this.replaced) return;
    if (this.ws && this.ws.readyState <= 1) return;
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', ...this.identity }));
    };
    ws.onmessage = (e) => this.#onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.emit('status', { connected: false });
      if (e.code === 4000) { this.stopped = true; this.replaced = true; this.emit('replaced'); return; } // başka sekmeden bağlanıldı
      if (this.stopped) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  #onMessage(msg) {
    switch (msg.t) {
      case 'welcome': {
        this.identity = { playerId: msg.playerId, token: msg.token, name: msg.name };
        saveIdentity(this.identity);
        this.connected = true;
        this.emit('status', { connected: true });
        for (const m of this.queue.splice(0)) this.ws.send(JSON.stringify(m));
        break;
      }
      case 'room':
        this.room = msg.room;
        this.gotRoom = true;
        if (!msg.room || msg.room.phase === 'lobby') this.view = null;
        this.emit('room', msg.room);
        break;
      case 'shared':
        this.shared = { key: msg.key, data: msg.data };
        this.emit('shared', this.shared);
        break;
      case 'view':
        this.view = msg.view;
        this.serverOffset = msg.serverNow - Date.now();
        this.emit('view', msg.view);
        break;
      case 'kicked':
        this.emit('kicked');
        break;
      case 'error':
        this.emit('error', msg);
        break;
      default:
        break;
    }
  }

  send(msg) {
    if (this.connected && this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
    else {
      this.queue.push(msg);
      this.connect();
    }
  }

  setName(name) {
    this.identity.name = name;
    saveIdentity(this.identity);
    if (this.connected) this.send({ t: 'rename', name });
  }

  // "Bu sekmede devam et": diğer sekmeyi düşürüp burada bağlan.
  takeover() {
    this.replaced = false;
    this.connect();
  }

  // İlk oda bilgisi gelene kadar bekle (davet linki kararları için).
  whenReady() {
    if (this.gotRoom && this.connected) return Promise.resolve();
    this.connect();
    return new Promise((resolve) => { const off = this.on('room', () => { off(); resolve(); }); });
  }

  action(action) {
    this.send({ t: 'action', action });
  }
}

export const net = new Net();
