// Sürü testleri için ortak araçlar (test dosyası değil; swarm-*.test.mjs dosyaları kullanır).
// - startProbedServer: sunucuyu test-only bellek/oda sondasıyla başlatır (swarm-probe.mjs).
// - SpyfallReferee: her mesajdan sonra değişmezleri (invariant) kontrol eder; ihlalleri toplar.
// - monkey: rastgele ama kurallara uygun oynayan bot döngüsü.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.js';
import { Bot, sleep } from '../lib/bot.js';
import { createRng } from '../../server/rng.js';

export { createRng, sleep, Bot };

const PROBE_URL = pathToFileURL(fileURLToPath(new URL('./swarm-probe.mjs', import.meta.url))).href;

export async function startProbedServer({ timeScale = 0.02, seed = 1, gc = false, probeMs = 200, env = {} } = {}) {
  const srv = await startServer({
    timeScale,
    seed,
    env: { NODE_OPTIONS: `--import=${PROBE_URL}${gc ? ' --expose-gc' : ''}`, PROBE_MS: String(probeMs), PROBE_GC: gc ? '1' : '0', ...env },
  });
  srv.probes = () => [...srv.log().matchAll(/@@probe (\{.*\})/g)].map((m) => JSON.parse(m[1]));
  srv.lastProbe = () => srv.probes().at(-1);
  // Bir sonraki sonda satırı koşulu sağlayana kadar bekle.
  srv.waitProbe = async (pred, timeout = 8000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = srv.lastProbe();
      if (last && pred(last)) return last;
      await sleep(probeMs);
    }
    throw new Error(`probe koşulu sağlanmadı, son: ${JSON.stringify(last)}`);
  };
  // Sunucu hâlâ yaşıyor mu? (yeni bağlantı + hello → welcome)
  srv.alive = async () => {
    const b = new Bot(srv.wsUrl, 'Nabız');
    try { await b.connect(); return true; } catch { return false; } finally { b.close(); }
  };
  srv.crashed = () => /Node\.js v\d|Sunucu kapandı|^\s+at /m.test(srv.log()) && !srv.log().includes('@@never');
  return srv;
}

// ---------- Casus Kim? hakem ----------

const PHASES = ['play', 'accuse', 'final', 'reveal'];
const NEXT_OK = {
  play: ['play', 'accuse', 'final', 'reveal'],
  accuse: ['accuse', 'play', 'reveal'],
  final: ['final', 'reveal'],
  reveal: ['reveal'],
};
const ROOM_PHASE_NEXT = { lobby: ['lobby', 'playing'], playing: ['playing', 'over', 'lobby'], over: ['over', 'lobby'] };

// Açıklama öncesi görünümde izin verilen alanlar (yeni bir alan eklenirse sızıntı şüphesi olarak işaretlenir).
const VIEW_KEYS = new Set(['gameKey', 'round', 'totalRounds', 'phase', 'over', 'endsAt', 'paused', 'firstAskerId', 'players', 'locations', 'me', 'canAccuse', 'accusation', 'finalVote', 'result']);
const ME_SPY_KEYS = ['spy', 'spyCount'];
const ME_TOWN_KEYS = ['location', 'role', 'spy'];
const ACC_KEYS = ['byId', 'myVote', 'targetId', 'votedCount', 'voterCount'];
const FINAL_KEYS = ['myVote', 'votedCount', 'voterCount'];
const sameKeys = (obj, keys) => JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());

export class SpyfallReferee {
  constructor({ label = 'room', spiesSetting = 1 } = {}) {
    this.label = label;
    this.spiesSetting = spiesSetting;
    this.violations = [];
    this.bots = new Map(); // playerId -> bot
    this.per = new Map(); // bot -> takip durumu
    this.rounds = new Map(); // `${game}:${round}` -> { preViews: Map(bot -> [view]), spySeen: Map(id->bool), n0, result }
    this.game = 0; // kaçıncı oyun (backToLobby sonrası artar)
    this.reveals = 0;
    this.stats = { views: 0, rooms: 0, reasons: {} };
  }

  fail(bot, msg, detail) {
    if (this.violations.length < 200) this.violations.push(`[${this.label}] ${bot?.name ?? '-'}: ${msg}${detail ? ` | ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  }

  attach(bot) {
    this.bots.set(bot.playerId, bot);
    this.per.set(bot, { conn: bot.connections, phase: null, round: 0, roomPhase: null, scores: new Map(), lastView: null });
    bot.taps.push((msg) => this.onMessage(bot, msg));
  }

  attachAll(bots) { bots.forEach((b) => this.attach(b)); return this; }

  onMessage(bot, msg) {
    try {
      if (msg.t === 'error' && msg.code === 'internal') this.fail(bot, 'sunucu iç hatası (internal) döndü', msg);
      if (msg.t === 'room') this.checkRoom(bot, msg.room);
      if (msg.t === 'view' && msg.view) this.checkView(bot, msg.view);
    } catch (err) {
      this.fail(bot, `hakem hatası: ${err.stack}`);
    }
  }

  checkRoom(bot, room) {
    this.stats.rooms++;
    const st = this.per.get(bot);
    if (!room) { // odadan çıktı/atıldı: tekrar katılırsa takip baştan
      st.roomPhase = null; st.scores = new Map(); st.round = 0; st.phase = null; st.lastView = null;
      return;
    }
    const hosts = room.players.filter((p) => p.isHost);
    if (hosts.length !== 1 || hosts[0].id !== room.hostId) this.fail(bot, 'tam olarak bir host olmalı ve hostId ile eşleşmeli', room);
    if (room.players.length > 12) this.fail(bot, 'odada 12\'den fazla oyuncu', room.players.length);
    if (new Set(room.players.map((p) => p.id)).size !== room.players.length) this.fail(bot, 'oyuncu listesinde tekrar eden id');
    if (new Set(room.players.map((p) => p.name.toLocaleLowerCase('tr'))).size !== room.players.length) this.fail(bot, 'oda içinde aynı ad iki kez', room.players.map((p) => p.name));
    if (JSON.stringify(room).includes('token')) this.fail(bot, 'room mesajında token alanı');
    const reconnected = st.conn !== bot.connections;
    if (st.roomPhase && !reconnected && !ROOM_PHASE_NEXT[st.roomPhase].includes(room.phase)) this.fail(bot, `geçersiz oda fazı geçişi ${st.roomPhase} → ${room.phase}`);
    if (room.phase === 'lobby' && st.roomPhase && st.roomPhase !== 'lobby') {
      // Yeni oyun: skor takibini sıfırla
      st.scores = new Map(); st.round = 0; st.phase = null; st.lastView = null;
      if (bot === [...this.per.keys()][0]) this.game++;
    }
    st.roomPhase = room.phase;
  }

  roundKey(round, gameKey) { return `${gameKey ?? this.game}:${round}`; }

  roundRec(round, gameKey) {
    const k = this.roundKey(round, gameKey);
    if (!this.rounds.has(k)) this.rounds.set(k, { preViews: new Map(), spySeen: new Map(), n0: null, done: false });
    return this.rounds.get(k);
  }

  checkView(bot, v) {
    this.stats.views++;
    const st = this.per.get(bot);
    const reconnected = st.conn !== bot.connections;
    // Yeni oyun (gameKey değişti): bot lobi mesajını kaçırmış olsa bile takip sıfırlanır
    if (v.gameKey != null && st.gameKey !== v.gameKey) {
      if (st.gameKey != null) { st.scores = new Map(); st.lastView = null; }
      st.gameKey = v.gameKey;
    }

    // 1) Alan izin listesi (açıklama öncesi)
    for (const k of Object.keys(v)) if (!VIEW_KEYS.has(k)) this.fail(bot, `görünümde beklenmeyen alan: ${k}`);
    if (!PHASES.includes(v.phase)) this.fail(bot, `geçersiz faz ${v.phase}`);
    if (v.phase !== 'reveal' && v.result != null) this.fail(bot, 'açıklama öncesi result dolu', v.result);
    if (v.me) {
      if (v.me.spy === true && !sameKeys(v.me, ME_SPY_KEYS)) this.fail(bot, 'casus görünümünde fazladan alan', v.me);
      if (v.me.spy === false && !sameKeys(v.me, ME_TOWN_KEYS)) this.fail(bot, 'köylü görünümünde beklenmeyen alan', v.me);
    }
    if (v.accusation && !sameKeys(v.accusation, ACC_KEYS)) this.fail(bot, 'accusation alanları beklenmedik', v.accusation);
    if (v.finalVote && !sameKeys(v.finalVote, FINAL_KEYS)) this.fail(bot, 'finalVote alanları beklenmedik', v.finalVote);
    // Not: çözülmüş suçlama reveal görünümünde kalıyor (kimin suçladığını göstermek için) — izinli.
    if ((v.phase === 'accuse' && !v.accusation) || (v.accusation && !['accuse', 'reveal'].includes(v.phase))) this.fail(bot, 'accuse fazı ile accusation tutarsız', { phase: v.phase, acc: v.accusation });
    if ((v.phase === 'final') !== Boolean(v.finalVote)) this.fail(bot, 'final fazı ile finalVote tutarsız', { phase: v.phase });
    if (v.paused !== (v.phase === 'accuse')) this.fail(bot, 'paused yalnızca accuse fazında true olmalı');
    if (v.accusation && v.phase === 'accuse') { // reveal'da kalan eski suçlamanın sayıları güncel değil (bkz. rapor)
      const a = v.accusation;
      if (a.votedCount > a.voterCount) this.fail(bot, 'suçlamada oy sayısı seçmen sayısını aştı', a);
      if (!v.players.some((p) => p.id === a.targetId)) this.fail(bot, 'suçlanan oyunda değil', a);
    }
    if (v.finalVote && v.finalVote.votedCount > v.finalVote.voterCount) this.fail(bot, 'final oy sayısı seçmen sayısını aştı', v.finalVote);
    if (v.players.length < 2 && !v.over) this.fail(bot, 'oyun 3 kişinin altında sürüyor', v.players.length);

    // 2) Faz geçişi
    if (st.lastView && !reconnected) {
      const pv = st.lastView;
      if (v.round < pv.round) this.fail(bot, `tur geri gitti ${pv.round} → ${v.round}`);
      else if (v.round === pv.round) {
        if (!NEXT_OK[pv.phase]?.includes(v.phase)) this.fail(bot, `geçersiz faz geçişi ${pv.phase} → ${v.phase} (tur ${v.round})`);
      } else {
        if (v.round !== pv.round + 1) this.fail(bot, `tur atladı ${pv.round} → ${v.round}`);
        if (pv.phase !== 'reveal') this.fail(bot, `tur açıklanmadan yeni tur başladı (${pv.phase})`);
        if (v.phase !== 'play') this.fail(bot, `yeni tur play dışında başladı: ${v.phase}`);
      }
      if (pv.over && !v.over) this.fail(bot, 'oyun bitti sonra tekrar başladı (over true → false)');
    }

    // 3) Skorlar: sadece artar, sadece açıklama anında, izinli miktarlarla
    for (const p of v.players) {
      const prev = st.scores.get(p.id);
      if (prev != null && p.score < prev) this.fail(bot, `skor azaldı ${p.name} ${prev} → ${p.score}`);
      const enteringReveal = v.phase === 'reveal' && (!st.lastView || st.lastView.phase !== 'reveal' || st.lastView.round !== v.round);
      if (prev != null && p.score !== prev && !enteringReveal && !reconnected) this.fail(bot, `skor açıklama dışında değişti ${p.name} ${prev} → ${p.score}`, { phase: v.phase });
      if (prev != null && enteringReveal && !reconnected && v.result) {
        const pts = v.result.points?.[p.id] ?? 0;
        if (p.score - prev !== pts) this.fail(bot, `skor farkı puanla uyuşmuyor ${p.name}: ${prev}+${pts} ≠ ${p.score}`);
      }
      st.scores.set(p.id, p.score);
    }

    // 4) Tur kayıtları (sızıntı ve casus sayısı kontrolü açıklama anında)
    const rec = this.roundRec(v.round, v.gameKey);
    if (rec.n0 == null && v.phase === 'play') rec.n0 = v.players.length;
    if (v.phase !== 'reveal') {
      if (!rec.preViews.has(bot)) rec.preViews.set(bot, []);
      rec.preViews.get(bot).push(v);
      if (v.me) {
        const prevSpy = rec.spySeen.get(bot.playerId);
        if (prevSpy != null && prevSpy !== v.me.spy) this.fail(bot, 'tur içinde casus/köylü rolü değişti');
        rec.spySeen.set(bot.playerId, v.me.spy);
        if (!v.me.spy) {
          const firstTown = rec.preViews.get(bot).find((x) => x.me && !x.me.spy);
          if (firstTown && (firstTown.me.location.id !== v.me.location.id || firstTown.me.role !== v.me.role)) this.fail(bot, 'tur içinde mekân/rol değişti');
        }
      }
    } else if (v.result) {
      this.checkReveal(bot, v, rec);
    }

    st.lastView = v;
    st.conn = bot.connections;
    st.round = v.round;
    st.phase = v.phase;
  }

  checkReveal(bot, v, rec) {
    const r = v.result;
    if (!['spy', 'town', 'none'].includes(r.winner)) this.fail(bot, `geçersiz kazanan ${r.winner}`);
    // Puan kuralları
    for (const [id, pts] of Object.entries(r.points ?? {})) {
      const spy = r.spyIds.includes(id);
      let ok;
      if (r.winner === 'none') ok = pts === 0;
      // PLAN §4.1: masum mahkûm edilirse veya doğru tahminde 4, eşitlik/oy yoksa 2
      else if (r.winner === 'spy') ok = spy ? pts === (['guess', 'wrong_accuse', 'final_wrong'].includes(r.reason) ? 4 : 2) : pts === 0;
      else ok = spy ? pts === 0 : pts === 1 + (id === r.accuserId && ['caught'].includes(r.reason) ? 1 : 0);
      if (!ok) this.fail(bot, `puan kuralı ihlali id=${id.slice(0, 6)} spy=${spy} pts=${pts}`, { winner: r.winner, reason: r.reason });
    }
    const expectedReasons = { spy: ['guess', 'wrong_accuse', 'tie', 'no_votes', 'final_wrong'], town: ['caught', 'bad_guess', 'final_caught'], none: ['not_enough', 'spy_left'] };
    if (!expectedReasons[r.winner]?.includes(r.reason)) this.fail(bot, `kazanan/sebep tutarsız ${r.winner}/${r.reason}`);
    if (rec.done) return; // tur başına bir kez çapraz kontrol
    rec.done = true;
    this.reveals++;
    this.stats.reasons[r.reason] = (this.stats.reasons[r.reason] ?? 0) + 1;

    // Casus sayısı
    if (rec.n0 != null) {
      const expected = Math.min(this.spiesSetting, rec.n0 >= 9 ? 2 : 1);
      if (r.spyIds.length !== expected) this.fail(bot, `casus sayısı ${r.spyIds.length}, beklenen ${expected} (n=${rec.n0}, ayar=${this.spiesSetting})`);
    }
    if (new Set(r.spyIds).size !== r.spyIds.length) this.fail(bot, 'aynı casus iki kez');
    // Her botun gördüğü casus bilgisi gerçekle uyuşmalı
    for (const [id, sawSpy] of rec.spySeen) {
      if (sawSpy !== r.spyIds.includes(id)) this.fail(this.bots.get(id), `bot kendini casus=${sawSpy} gördü ama gerçek ${r.spyIds.includes(id)}`);
    }
    const loc = r.location;
    const roles = r.roles ?? {};
    for (const [id, role] of Object.entries(roles)) if (r.spyIds.includes(id)) this.fail(bot, 'casusa rol atanmış', { id, role });
    // Sızıntı taraması: açıklama öncesi görünümlerde başkasına ait gizli değerler
    for (const [b, views] of rec.preViews) {
      const iAmSpy = r.spyIds.includes(b.playerId);
      for (const pv of views) {
        // nötr alanlar (herkese açık listeler / id'ler / kendi oyu) taramadan çıkarılır
        const { locations, players, firstAskerId, accusation, finalVote, ...rest } = pv;
        const text = JSON.stringify({ ...rest, accusation: accusation && { ...accusation, byId: 0, targetId: 0 }, finalVote: finalVote && { ...finalVote, myVote: 0 } });
        if (iAmSpy || !pv.me) {
          if (text.includes(`"${loc.id}"`) || text.includes(`"${loc.name}"`)) this.fail(b, `casus/izleyici açıklama öncesi mekânı gördü (${loc.id})`);
          for (const role of new Set(Object.values(roles))) if (text.includes(`"${role}"`)) this.fail(b, `casus/izleyici açıklama öncesi bir rol gördü (${role})`);
        } else {
          for (const [id, role] of Object.entries(roles)) {
            if (id !== b.playerId && role !== roles[b.playerId] && text.includes(`"${role}"`)) this.fail(b, `köylü başkasının rolünü gördü (${role})`);
          }
          if (pv.me.location.id !== loc.id) this.fail(b, 'köylünün gördüğü mekân gerçek mekân değil');
          if (pv.me.role !== roles[b.playerId]) this.fail(b, 'köylünün gördüğü rol gerçek rol değil');
        }
        for (const sid of r.spyIds) if (sid !== b.playerId && text.includes(sid)) this.fail(b, 'açıklama öncesi görünümde casus id\'si nötr olmayan bir alanda');
      }
    }
    rec.preViews.clear(); // bellek
  }

  // Oyun sonu: hiçbir bot başkasının token'ını görmemeli.
  finalChecks(bots = [...this.bots.values()]) {
    for (const b of bots) {
      const text = b.transcript();
      for (const o of bots) if (o !== b && o.token && text.includes(o.token)) this.fail(b, `${o.name} token'ını gördü`);
    }
    return this.violations;
  }
}

// ---------- Monkey oyuncu ----------
// Kurallara uygun rastgele eylemler (arada bir kasıtlı geçersiz eylem). Hız sınırına takılmamak için
// bot başına eylemler arasında en az `cooldown` ms bekler.
export function monkey(bot, { rng, oracle = {}, stop, cooldown = 200, illegalRate = 0.05, guessRate = 0.04, accuseRate = 0.04, minDelay = 20, maxDelay = 120 }) {
  let lastSent = 0;
  const act = (a) => { lastSent = Date.now(); bot.action(a); };
  return (async () => {
    while (!stop.done) {
      await sleep(minDelay + rng.int(maxDelay - minDelay + 1));
      if (stop.done) break;
      if (!bot.isOpen || !bot.view || !bot.room || bot.room.phase !== 'playing') continue;
      if (Date.now() - lastSent < cooldown) continue;
      const v = bot.view;
      if (!v.me) continue; // izleyici
      const others = v.players.filter((p) => p.id !== bot.playerId);
      if (!others.length) continue;
      const randomOther = () => rng.pick(others).id;
      if (rng.next() < illegalRate) {
        const bogus = rng.pick([
          { type: 'vote', yes: true }, { type: 'finalVote', targetId: bot.playerId }, { type: 'next' },
          { type: 'guess', locationId: 'yok' }, { type: 'accuse', targetId: bot.playerId }, { type: 'zz' },
        ]);
        act(bogus);
        continue;
      }
      if (!v.me.spy && v.me.location) oracle.locationId = v.me.location.id;
      switch (v.phase) {
        case 'play': {
          const x = rng.next();
          if (v.me.spy && x < guessRate) act({ type: 'guess', locationId: rng.next() < 0.5 && oracle.locationId ? oracle.locationId : rng.pick(v.locations).id });
          else if (v.canAccuse && x < guessRate + accuseRate) act({ type: 'accuse', targetId: randomOther() });
          break;
        }
        case 'accuse':
          if (v.accusation.targetId !== bot.playerId && v.accusation.myVote == null) act({ type: 'vote', yes: rng.next() < 0.75 });
          break;
        case 'final':
          if (v.finalVote.myVote == null) act({ type: 'finalVote', targetId: randomOther() });
          break;
        case 'reveal':
          if (bot.room.hostId === bot.playerId && !v.over) act({ type: 'next' });
          break;
        default:
      }
    }
  })();
}

// Kopma/kapanmada reddetmeyen, yoklamalı bekleme (bot düşüp geri gelirken de çalışır).
export async function until(pred, { timeout = 10_000, every = 25, what = 'koşul' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(every);
  }
  throw new Error(`zaman aşımı: ${what}`);
}

export function summarize(ref) {
  return `${ref.label}: views=${ref.stats.views} reveals=${ref.reveals} reasons=${JSON.stringify(ref.stats.reasons)}`;
}
