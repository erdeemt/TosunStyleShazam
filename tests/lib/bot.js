// Sahte oyuncu: WebSocket ile bağlanır, lobi protokolünü konuşur, aldığı her mesajı kaydeder.
// Sürü testleri ve gizli bilgi sızıntı kontrolleri bunun üzerine kurulur (bkz. PLAN.md §3.3, §5).
import WebSocket from 'ws';

export class Bot {
  constructor(wsUrl, name) {
    this.wsUrl = wsUrl;
    this.name = name;
    this.playerId = null;
    this.token = null;
    this.ws = null;
    this.messages = []; // aldığı her mesaj (sızıntı taraması için)
    this.room = null;
    this.view = null;
    this.errors = [];
    this.waiters = [];
    this.closed = null;
    this.taps = []; // her gelen mesajda çağrılır: (msg, bot) => void (değişmez/invariant kontrolleri için)
    this.connections = 0; // kaçıncı bağlantı; yeniden bağlanınca artar
  }

  get isOpen() {
    return this.ws?.readyState === 1;
  }

  async connect({ origin } = {}) {
    const ws = new WebSocket(this.wsUrl, origin ? { headers: { Origin: origin } } : undefined);
    this.ws = ws;
    this.closed = null;
    this.connections++;
    // Eski (kopmuş) soketten geç gelen mesaj/kapanış yeni bağlantının durumunu bozmasın.
    ws.on('message', (data) => { if (this.ws === ws) this.#onMessage(JSON.parse(String(data))); });
    ws.on('close', (code, reason) => { if (this.ws !== ws) return; this.closed = { code, reason: String(reason) }; this.#check(); });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.sendRaw({ t: 'hello', playerId: this.playerId, token: this.token, name: this.name });
    const welcome = await this.waitFor((m) => m.t === 'welcome');
    this.playerId = welcome.playerId;
    this.token = welcome.token;
    this.name = welcome.name;
    return this;
  }

  #onMessage(msg) {
    msg.receivedAt = Date.now();
    this.messages.push(msg);
    if (msg.t === 'room') this.room = msg.room;
    if (msg.t === 'view') this.view = msg.view;
    if (msg.t === 'error') this.errors.push(msg);
    for (const tap of this.taps) tap(msg, this);
    this.#check();
  }

  #check() {
    this.waiters = this.waiters.filter((w) => {
      for (let i = w.from; i < this.messages.length; i++) {
        if (w.pred(this.messages[i])) { clearTimeout(w.timer); w.resolve(this.messages[i]); return false; }
      }
      w.from = this.messages.length;
      if (w.onClose && this.closed) { clearTimeout(w.timer); w.reject(new Error(`bağlantı kapandı ${this.closed.code}`)); return false; }
      return true;
    });
  }

  // Bu çağrıdan sonra gelecek (veya `fromStart` ise önceden gelmiş) bir mesajı bekler.
  waitFor(pred, { timeout = 5000, fromStart = false } = {}) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, from: fromStart ? 0 : this.messages.length, onClose: true };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.name}: mesaj beklenirken zaman aşımı`));
      }, timeout);
      this.waiters.push(w);
      this.#check();
    });
  }

  // Görünüm koşulu sağlanana kadar bekler (mevcut görünüm zaten uyuyorsa hemen döner).
  async waitView(pred, opts) {
    if (this.view && pred(this.view)) return this.view;
    return (await this.waitFor((m) => m.t === 'view' && m.view && pred(m.view), opts)).view;
  }

  async waitRoom(pred, opts) {
    if (this.room && pred(this.room)) return this.room;
    return (await this.waitFor((m) => m.t === 'room' && m.room && pred(m.room), opts)).room;
  }

  // Bağlantı açık değilse sessizce düşer (kaos testlerinde kopuk bot da eylem denemeye devam eder).
  sendRaw(obj) {
    if (!this.isOpen) return false;
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    return true;
  }

  send(obj) {
    this.sendRaw(obj);
  }

  async create(game) {
    const p = this.waitFor((m) => m.t === 'room' && m.room?.game === game || m.t === 'error');
    this.send({ t: 'create', game });
    const m = await p;
    if (m.t === 'error') throw new Error(m.message);
    return m.room.code;
  }

  async join(code) {
    const want = String(code).toUpperCase();
    const p = this.waitFor((m) => (m.t === 'room' && m.room?.code === want) || m.t === 'error');
    this.send({ t: 'join', code });
    const m = await p;
    if (m.t === 'error') throw new Error(m.message);
    return m.room;
  }

  action(action) {
    this.send({ t: 'action', action });
  }

  // Bir eylem gönderip ya bir görünüm güncellemesi ya da hata bekler.
  async act(action, opts) {
    const p = this.waitFor((m) => m.t === 'view' || m.t === 'error', opts);
    this.action(action);
    return p;
  }

  // Reddedilmesi beklenen eylem: sadece hata mesajını bekler (arada gelen görünümleri atlar).
  async expectError(action, opts) {
    const p = this.waitFor((m) => m.t === 'error', opts);
    this.action(action);
    return p;
  }

  // Ağ kopması gibi: kapanış el sıkışması olmadan bağlantıyı keser.
  drop() {
    this.ws.terminate();
  }

  async reconnect() {
    this.drop();
    await new Promise((r) => setTimeout(r, 20));
    return this.connect();
  }

  close() {
    this.waiters.forEach((w) => clearTimeout(w.timer));
    this.waiters = [];
    this.ws?.terminate();
  }

  // Aldığı tüm mesajların düz metni (gizli değer araması için).
  transcript() {
    return JSON.stringify(this.messages);
  }
}

export async function makeBots(wsUrl, n, prefix = 'Bot') {
  return Promise.all(Array.from({ length: n }, (_, i) => new Bot(wsUrl, `${prefix}${i + 1}`).connect()));
}

// Bir host oda kurar, diğerleri katılır.
export async function makeRoom(wsUrl, game, n, prefix) {
  const bots = await makeBots(wsUrl, n, prefix);
  const code = await bots[0].create(game);
  for (const b of bots.slice(1)) await b.join(code);
  await Promise.all(bots.map((b) => b.waitRoom((r) => r.players.length === n)));
  return { bots, code, host: bots[0] };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
