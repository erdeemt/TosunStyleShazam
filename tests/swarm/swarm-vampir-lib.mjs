// Vampir Köylü sürü araçları (test dosyası değil; swarm-vampir-*.test.mjs dosyaları kullanır).
// - VampirReferee: her mesajdan sonra değişmezleri (invariant) kontrol eder; oyun bitince (roller açılınca) geriye dönük
//   sızıntı taraması + kazanma/gece/yargılama kayıtlarının çapraz kontrolü yapar. İhlalleri toplar, fırlatmaz.
// - vampMonkey: kurallara uygun rastgele oynayan bot döngüsü (arada kasıtlı geçersiz / ölüyken eylem).
// - expectedRoleCounts: ayarlardan beklenen rol sayıları (PLAN.md §4.3).
import { sleep } from '../lib/bot.js';

export const ROLE_IDS = ['vampir', 'koylu', 'doktor', 'gozcu', 'deli'];
const TEAM = { vampir: 'vampires', koylu: 'town', doktor: 'town', gozcu: 'town', deli: 'jester' };
const PHASES = ['night', 'day', 'trial', 'trialVote', 'over'];
// Aynı gece numarasında izinli geçişler; '+night' = gece numarası 1 artarak gece.
const NEXT_OK = {
  night: ['night', 'day', 'over'],
  day: ['day', 'trial', '+night', 'over'],
  trial: ['trial', 'trialVote', 'day', 'over'],
  trialVote: ['trialVote', 'day', '+night', 'over'],
  over: ['over'],
};
const VIEW_KEYS = ['gameKey', 'phase', 'night', 'endsAt', 'players', 'roleCounts', 'announcement', 'lastTrial', 'nomination', 'trial', 'nightProgress', 'me', 'result'];
const PLAYER_KEYS = ['id', 'name', 'alive', 'death'];
const ANN_KEYS = ['night', 'deadId'];
const LAST_TRIAL_KEYS = ['targetId', 'hanged', 'yes', 'voters'];
const NOM_KEYS = ['byId', 'targetId', 'expiresAt'];
const TRIAL_KEYS = ['targetId', 'votedCount', 'voterCount', 'myVote'];
const RESULT_KEYS = ['winner', 'winnerIds', 'roles', 'seerResults', 'log'];
// Sahibinden başkasına asla gitmemesi gereken anahtar adları (ham metin taraması).
const SECRET_KEYS_ALL = ['"vampireTally"', '"doctorPick"', '"savedId"', '"log"', '"votes"', '"nightPicks"', '"winnerIds"', '"roles"', '"role":"', '"seerResults"', '"isVampire"', '"lastProtected"', '"allies"', '"allyPicks"'];

const sameKeys = (obj, keys) => JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());

export function autoVampires(n) {
  return n <= 7 ? 1 : n <= 10 ? 2 : 3;
}

export function expectedRoleCounts(n, s) {
  // Otomatik: 5–7 → 1, 8–10 → 2, 11–12 → 3 (PLAN §4.3). Elle: en fazla oyuncuların üçte birinden az (sunucu maxVampires).
  const v = s.vampires ? Math.min(s.vampires, Math.max(1, Math.floor((n - 1) / 3))) : autoVampires(n);
  const out = { vampir: v };
  let used = v;
  for (const r of ['doktor', 'gozcu', 'deli']) if (s[r] !== false) { out[r] = 1; used++; }
  if (n - used > 0) out.koylu = n - used;
  return out;
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
// Herkese açık kısım: aynı yayında (seq) her alıcıya bayt bayt aynı olmalı.
export function publicPart(v) {
  const { me, trial, ...rest } = v;
  return JSON.stringify({ ...rest, trial: trial && { ...trial, myVote: 0 } });
}

export class VampirReferee {
  // settings: odanın oyun ayarları (beklenen rol sayıları için). strictClock: gün saati devam kontrolü (yük altında kapatılabilir).
  constructor({ label = 'room', settings = {}, clockTolerance = 60 } = {}) {
    this.label = label;
    this.settings = settings;
    this.clockTolerance = clockTolerance;
    this.violations = [];
    this.bots = new Map();
    this.per = new Map();
    this.games = new Map(); // gameKey -> kayıt
    this.seqPublic = new Map(); // `${gameKey}:${seq}` -> { text, by }
    this.stats = { views: 0, overs: 0, winners: {}, nights: 0, trials: 0, hanged: 0, resumes: 0, clockChecks: 0, saves: 0, seerPeeks: 0 };
  }

  fail(bot, msg, detail) {
    if (this.violations.length < 200) this.violations.push(`[${this.label}] ${bot?.name ?? '-'}: ${msg}${detail !== undefined ? ` | ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
  }

  attach(bot) {
    this.bots.set(bot.playerId, bot);
    this.per.set(bot, { conn: bot.connections, last: null, lastMsg: null, gameKey: null, dayEnd: null, remaining: null, role: null, allies: null, seerLen: 0 });
    bot.taps.push((msg) => this.onMessage(bot, msg));
    return this;
  }

  attachAll(bots) { bots.forEach((b) => this.attach(b)); return this; }

  onMessage(bot, msg) {
    try {
      if (msg.t === 'error' && msg.code === 'internal') this.fail(bot, 'sunucu iç hatası (internal)', msg);
      if (msg.t === 'room' && msg.room) this.checkRoom(bot, msg.room);
      if ((msg.t === 'room' && !msg.room) || msg.t === 'kicked') { const st = this.per.get(bot); st.last = null; st.lastMsg = null; st.remaining = null; }
      if (msg.t === 'view' && msg.view) this.checkView(bot, msg.view, msg);
    } catch (err) {
      this.fail(bot, `hakem hatası: ${err.stack}`);
    }
  }

  checkRoom(bot, room) {
    const hosts = room.players.filter((p) => p.isHost);
    if (hosts.length !== 1 || hosts[0].id !== room.hostId) this.fail(bot, 'tam olarak bir host olmalı', room.players);
    if (room.players.length > 12) this.fail(bot, 'odada 12\'den fazla kişi');
    if (JSON.stringify(room).includes('"role')) this.fail(bot, 'room mesajında rol alanı');
    if (room.settings) this.settings = room.settings;
  }

  game(gameKey) {
    if (!this.games.has(gameKey)) this.games.set(gameKey, { views: [], n0: null, settings: { ...this.settings }, done: false, roleSeen: new Map(), alliesSeen: new Map() });
    return this.games.get(gameKey);
  }

  checkView(bot, v, msg) {
    this.stats.views++;
    const st = this.per.get(bot);
    const reconnected = st.conn !== bot.connections;
    if (st.gameKey !== v.gameKey) { st.last = null; st.lastMsg = null; st.gameKey = v.gameKey; st.remaining = null; st.seerLen = 0; }
    const g = this.game(v.gameKey);
    if (reconnected) st.remaining = null;
    const prev = reconnected ? null : st.last;
    const prevMsg = reconnected ? null : st.lastMsg;

    // ---- 1) Yapı / izin listesi ----
    if (!sameKeys(v, VIEW_KEYS)) this.fail(bot, 'görünüm alanları izin listesinde değil', Object.keys(v));
    if (!PHASES.includes(v.phase)) this.fail(bot, `geçersiz faz ${v.phase}`);
    const over = v.phase === 'over';
    if (over !== Boolean(v.result)) this.fail(bot, 'result yalnızca oyun bitince dolu olmalı', { phase: v.phase });
    for (const p of v.players) {
      if (!sameKeys(p, PLAYER_KEYS)) this.fail(bot, 'oyuncu girdisinde beklenmeyen alan', p);
      if (p.alive !== (p.death == null)) this.fail(bot, 'alive/death tutarsız', p);
      if (p.death && (!sameKeys(p.death, ['cause', 'night']) || !['night', 'hanged', 'left'].includes(p.death.cause))) this.fail(bot, 'death alanı beklenmedik', p.death);
    }
    if (g.n0 == null) g.n0 = v.players.length;
    if (v.players.length !== g.n0) this.fail(bot, 'oyun içinde oyuncu listesi boyu değişti', { n0: g.n0, n: v.players.length });
    const expected = expectedRoleCounts(g.n0, g.settings);
    if (JSON.stringify(sortObj(v.roleCounts)) !== JSON.stringify(sortObj(expected))) this.fail(bot, 'roleCounts ayarlarla uyuşmuyor', { got: v.roleCounts, expected, settings: g.settings, n: g.n0 });
    const aliveIds = new Set(v.players.filter((p) => p.alive).map((p) => p.id));
    const isAlive = (id) => aliveIds.has(id);
    if (v.announcement && !sameKeys(v.announcement, ANN_KEYS)) this.fail(bot, 'announcement alanları', v.announcement);
    if (v.announcement?.deadId && isAlive(v.announcement.deadId)) this.fail(bot, 'duyurulan ölü hâlâ yaşıyor', v.announcement);
    if (v.lastTrial) {
      if (!sameKeys(v.lastTrial, LAST_TRIAL_KEYS)) this.fail(bot, 'lastTrial alanları', v.lastTrial);
      const lt = v.lastTrial;
      if (lt.hanged !== (lt.yes * 2 > lt.voters)) this.fail(bot, 'yargılama sonucu "Evet > oy hakkı/2" kuralına uymuyor', lt);
      if (lt.yes > lt.voters || lt.yes < 0) this.fail(bot, 'Evet sayısı seçmen sayısını aştı', lt);
      if (lt.hanged) {
        const t = v.players.find((p) => p.id === lt.targetId);
        if (!t || t.death?.cause !== 'hanged') this.fail(bot, 'asıldı denen oyuncu asılmış görünmüyor', { lt, t });
      }
    }
    if (v.nomination) {
      const n = v.nomination;
      if (!sameKeys(n, NOM_KEYS)) this.fail(bot, 'nomination alanları', n);
      if (v.phase !== 'day') this.fail(bot, 'gündüz dışında aday', v.phase);
      if (!isAlive(n.byId) || !isAlive(n.targetId) || n.byId === n.targetId) this.fail(bot, 'aday gösteren/aday yaşamıyor veya aynı kişi', n);
    }
    if (v.trial) {
      const t = v.trial;
      if (!sameKeys(t, TRIAL_KEYS)) this.fail(bot, 'trial alanları', t);
      if (!['trial', 'trialVote', 'over'].includes(v.phase)) this.fail(bot, `trial nesnesi ${v.phase} fazında`);
      if (v.phase !== 'over') {
        if (!isAlive(t.targetId)) this.fail(bot, 'yargılanan yaşamıyor', t);
        if (t.voterCount !== aliveIds.size - 1) this.fail(bot, 'oy hakkı = yaşayanlar - aday olmalı', { t, alive: aliveIds.size });
        if (t.votedCount > t.voterCount) this.fail(bot, 'oy sayısı seçmen sayısını aştı (ölü/aday oy vermiş olabilir)', t);
        if (v.phase === 'trial' && t.votedCount !== 0) this.fail(bot, 'savunma sırasında oy sayılmış', t);
        if (t.targetId === bot.playerId && t.myVote != null) this.fail(bot, 'aday kendi yargılamasına oy vermiş', t);
      }
    } else if (['trial', 'trialVote'].includes(v.phase)) this.fail(bot, `${v.phase} fazında trial yok`);
    if ((v.phase === 'night') !== Boolean(v.nightProgress)) this.fail(bot, 'nightProgress yalnızca gece olmalı', { phase: v.phase });
    if (v.nightProgress) {
      const np = v.nightProgress;
      if (!sameKeys(np, ['done', 'total'])) this.fail(bot, 'nightProgress alanları', np);
      if (np.total !== aliveIds.size) this.fail(bot, 'nightProgress.total yaşayan sayısı değil (ölü gece görevi alıyor olabilir)', { np, alive: aliveIds.size });
      if (np.done > np.total || np.done < 0) this.fail(bot, 'nightProgress.done > total', np);
    }
    if (!over && v.endsAt == null) this.fail(bot, 'oyun sürerken endsAt boş');
    if (over && v.endsAt != null) this.fail(bot, 'oyun bitince endsAt dolu');

    // ---- 2) Kişisel görünüm ----
    const me = v.me;
    const myEntry = v.players.find((p) => p.id === bot.playerId);
    if (myEntry && !me) this.fail(bot, 'oyuncunun me alanı boş');
    if (!myEntry && me) this.fail(bot, 'izleyiciye me gönderildi', me);
    if (me) {
      if (!ROLE_IDS.includes(me.role)) this.fail(bot, `geçersiz rol ${me.role}`);
      const keys = ['role', 'alive', 'canNominate'];
      if (me.alive && v.phase === 'night') keys.push('nightTargets', 'nightPick');
      if (me.role === 'vampir') { keys.push('allies'); if (v.phase === 'night' && me.alive) keys.push('allyPicks'); }
      if (me.role === 'gozcu') keys.push('seerResults');
      if (me.role === 'doktor') keys.push('lastProtected');
      if (!sameKeys(me, keys)) this.fail(bot, `me alanları role (${me.role}) göre izin listesinde değil`, { got: Object.keys(me), want: keys });
      if (me.alive !== myEntry?.alive) this.fail(bot, 'me.alive oyuncu listesiyle uyuşmuyor');
      if (me.canNominate && (!me.alive || v.phase !== 'day')) this.fail(bot, 'ölü/gündüz dışı canNominate');
      const r0 = g.roleSeen.get(bot.playerId);
      if (r0 && r0 !== me.role) this.fail(bot, `oyun içinde rol değişti ${r0} → ${me.role}`);
      g.roleSeen.set(bot.playerId, me.role);
      if (me.allies) {
        const a0 = g.alliesSeen.get(bot.playerId);
        const a = JSON.stringify([...me.allies].sort());
        if (a0 && a0 !== a) this.fail(bot, 'müttefik listesi değişti');
        g.alliesSeen.set(bot.playerId, a);
        if (me.allies.length !== (v.roleCounts.vampir ?? 0) - 1) this.fail(bot, 'müttefik sayısı vampir sayısı - 1 değil', me.allies);
      }
      if (me.nightTargets) {
        if (!me.nightTargets.every(isAlive)) this.fail(bot, 'gece hedeflerinde ölü var', me.nightTargets);
        if (me.role !== 'doktor' && me.nightTargets.includes(bot.playerId)) this.fail(bot, 'kendini seçebiliyor (doktor dışı)');
        if (me.role === 'vampir' && me.nightTargets.some((id) => me.allies.includes(id))) this.fail(bot, 'vampir müttefikini seçebiliyor');
        if (me.role === 'doktor' && me.lastProtected && me.nightTargets.includes(me.lastProtected)) this.fail(bot, 'doktor dün korunanı tekrar seçebiliyor', me);
        if (me.nightPick != null && !me.nightTargets.includes(me.nightPick)) {
          const t = v.players.find((p) => p.id === me.nightPick);
          if (!(t && t.death?.cause === 'left')) this.fail(bot, 'seçim hedef listesinde değil', me);
        }
      }
      if (me.allyPicks) for (const [id, t] of Object.entries(me.allyPicks)) {
        if (!me.allies.includes(id)) this.fail(bot, 'allyPicks müttefik olmayanın seçimini içeriyor', me.allyPicks);
        if (!isAlive(id)) this.fail(bot, 'ölü müttefikin seçimi gösteriliyor', { id, t });
      }
      if (me.seerResults) {
        if (me.seerResults.length < st.seerLen) this.fail(bot, 'gözcü sonuçları azaldı');
        st.seerLen = me.seerResults.length;
        if (me.seerResults.length > v.night) this.fail(bot, 'gözcü geceden fazla bakmış', me.seerResults);
      }
    }

    // ---- 3) Yayın tutarlılığı (yan kanal): aynı seq'te herkese açık kısım herkese aynı ----
    if (msg.seq != null) {
      const k = `${v.gameKey}:${msg.seq}`;
      const text = publicPart(v);
      const got = this.seqPublic.get(k);
      if (!got) { this.seqPublic.set(k, { text, by: bot.name }); if (this.seqPublic.size > 5000) this.seqPublic.delete(this.seqPublic.keys().next().value); } else if (got.text !== text) this.fail(bot, `aynı yayında (seq ${msg.seq}) herkese açık görünüm alıcıya göre farklı (bkz. ${got.by})`, { a: got.text.slice(0, 300), b: text.slice(0, 300) });
    }

    // ---- 4) Faz geçişi + gün saati ----
    if (prev) {
      const ok = NEXT_OK[prev.phase] ?? [];
      const sameNight = v.night === prev.night;
      const legal = (sameNight && ok.includes(v.phase)) || (v.phase === 'night' && v.night === prev.night + 1 && ok.includes('+night'));
      if (!legal) this.fail(bot, `geçersiz faz geçişi ${prev.phase}#${prev.night} → ${v.phase}#${v.night}`);
      if (prev.phase === 'day' && v.phase === 'trial') st.remaining = prev.endsAt - msg.serverNow;
      if (['trial', 'trialVote'].includes(prev.phase) && v.phase === 'day' && st.remaining != null && prevMsg) {
        const want = Math.max(1000, st.remaining);
        const got = v.endsAt - msg.serverNow;
        this.stats.clockChecks++;
        if (Math.abs(got - want) > this.clockTolerance) this.fail(bot, `başarısız yargılamadan sonra gün saati kaldığı yerden sürmedi: beklenen ~${Math.round(want)} ms, kalan ${Math.round(got)} ms`);
        st.remaining = null;
      }
      if (prev.phase === 'trialVote' && v.phase !== 'trialVote' && v.phase !== 'over') {
        // oylama çözüldü: geceye geçildiyse sanık asılmış, gündüz sürüyorsa bu sanık için "asılmadı" sonucu (veya sanık ayrıldı)
        const tid = prev.trial.targetId;
        const t = v.players.find((p) => p.id === tid);
        if (v.phase === 'night' && t?.death?.cause !== 'hanged') this.fail(bot, 'oylama sonrası geceye geçildi ama sanık asılmadı', { t, lastTrial: v.lastTrial, seq: [prevMsg?.seq, msg.seq] });
        if (v.phase === 'day' && !(v.lastTrial?.targetId === tid && v.lastTrial.hanged === false) && t?.death?.cause !== 'left') this.fail(bot, 'oylama sonrası gündüz sürüyor ama sonuç "asılmadı" değil', { lastTrial: v.lastTrial, seq: [prevMsg?.seq, msg.seq] });
      }
    }
    if (!over) g.views.push({ bot, v });
    st.last = v;
    st.lastMsg = msg;
    st.conn = bot.connections;
    if (over && !g.done) this.checkOver(bot, v, g);
  }

  checkOver(bot, v, g) {
    g.done = true;
    this.stats.overs++;
    const r = v.result;
    if (!sameKeys(r, RESULT_KEYS)) this.fail(bot, 'result alanları', Object.keys(r));
    this.stats.winners[r.winner] = (this.stats.winners[r.winner] ?? 0) + 1;
    const roles = r.roles;
    const ids = v.players.map((p) => p.id);
    const counts = {};
    for (const id of ids) counts[roles[id]] = (counts[roles[id]] ?? 0) + 1;
    const expected = expectedRoleCounts(g.n0, g.settings);
    if (JSON.stringify(sortObj(counts)) !== JSON.stringify(sortObj(expected))) this.fail(bot, 'açıklanan roller ayarlarla uyuşmuyor', { counts, expected, settings: g.settings });
    const vamps = ids.filter((id) => roles[id] === 'vampir');
    const pl = Object.fromEntries(v.players.map((p) => [p.id, p]));
    const special = (id) => roles[id] !== 'koylu';

    // Kazanan: tam olarak bir koşul
    const liveV = v.players.filter((p) => p.alive && roles[p.id] === 'vampir').length;
    const liveO = v.players.filter((p) => p.alive && roles[p.id] !== 'vampir').length;
    const deliHanged = ids.some((id) => roles[id] === 'deli' && pl[id].death?.cause === 'hanged');
    const conds = { jester: deliHanged, town: !deliHanged && liveV === 0, vampires: !deliHanged && liveV > 0 && liveV >= liveO };
    const holding = Object.keys(conds).filter((k) => conds[k]);
    if (holding.length !== 1 || holding[0] !== r.winner) this.fail(bot, `oyun sonunda kazanma koşulu tutarsız: kazanan=${r.winner}, sağlanan=${holding.join(',') || 'yok'}`, { liveV, liveO, deliHanged });
    const wantIds = ids.filter((id) => (r.winner === 'jester' ? roles[id] === 'deli' : TEAM[roles[id]] === r.winner)).sort();
    if (JSON.stringify([...r.winnerIds].sort()) !== JSON.stringify(wantIds)) this.fail(bot, 'winnerIds takımla uyuşmuyor', { winner: r.winner });
    if (r.winner === 'jester') {
      const deli = ids.find((id) => roles[id] === 'deli');
      if (pl[deli].death?.cause !== 'hanged') this.fail(bot, 'deli asılmadan kazandı', pl[deli]);
    }

    // Her ara görünüm: kazanma koşulu sağlanırken oyun sürmemeli; rol/sızıntı taraması
    const seenSeq = new Set();
    for (const { bot: b, v: pv } of g.views) {
      const lv = pv.players.filter((p) => p.alive && roles[p.id] === 'vampir').length;
      const lo = pv.players.filter((p) => p.alive && roles[p.id] !== 'vampir').length;
      const key = JSON.stringify(pv.players.map((p) => p.alive));
      if (!seenSeq.has(key) && (lv === 0 || lv >= lo)) this.fail(b, `kazanma koşulu sağlandığı halde oyun sürdü (${pv.phase}#${pv.night}, vampir=${lv}, diğer=${lo})`);
      seenSeq.add(key);
      if (pv.players.some((p) => roles[p.id] === 'deli' && p.death?.cause === 'hanged')) this.fail(b, 'deli asıldı ama oyun bitmedi');
      this.scanLeak(b, pv, roles, vamps);
    }

    // Gerçek rollerle çapraz kontrol
    for (const [id, role] of g.roleSeen) if (roles[id] !== role) this.fail(this.bots.get(id), `bot rolünü ${role} gördü, gerçek ${roles[id]}`);
    for (const [id, a] of g.alliesSeen) {
      const want = JSON.stringify(vamps.filter((x) => x !== id).sort());
      if (a !== want) this.fail(this.bots.get(id), 'vampirin gördüğü müttefikler gerçek vampirler değil');
    }
    for (const { bot: b, v: pv } of g.views) {
      if (pv.me?.nightTargets && pv.me.role === 'vampir' && pv.me.nightTargets.some((id) => roles[id] === 'vampir')) this.fail(b, 'vampir hedeflerinde vampir');
    }

    const aliveAtNight = (id, n) => pl[id].alive || pl[id].death.night >= n;
    // Gözcü sonuçları
    const seerNights = new Set();
    const seer = ids.find((id) => roles[id] === 'gozcu');
    for (const s of r.seerResults) {
      if (!seer || !(pl[seer].alive || pl[seer].death.night >= s.night)) this.fail(bot, 'ölü/olmayan gözcü baktı', s);
      if (s.isVampire !== (roles[s.targetId] === 'vampir')) this.fail(bot, 'gözcü sonucu yanlış', s);
      if (seerNights.has(s.night)) this.fail(bot, 'gözcü aynı gece iki kez baktı', s);
      seerNights.add(s.night);
      this.stats.seerPeeks++;
    }

    // Gece / yargılama kayıtları
    const doctor = ids.find((id) => roles[id] === 'doktor');
    let prevNight = null;
    for (const e of r.log) {
      if ('vampireTally' in e) {
        this.stats.nights++;
        const n = e.night;
        if (prevNight && n !== prevNight.night + 1) this.fail(bot, `gece kayıtları ardışık değil ${prevNight.night} → ${n}`);
        const tally = e.vampireTally;
        const sum = Object.values(tally).reduce((a, b) => a + b, 0);
        const liveVamps = vamps.filter((id) => aliveAtNight(id, n)).length;
        if (sum > liveVamps) this.fail(bot, `gece ${n}: vampir oyu (${sum}) yaşayan vampir sayısından (${liveVamps}) fazla — ölü oy vermiş`, e);
        if (Object.keys(tally).some((id) => roles[id] === 'vampir')) this.fail(bot, `gece ${n}: vampire oy verilmiş`, e);
        const max = Math.max(0, ...Object.values(tally));
        const top = Object.keys(tally).filter((id) => tally[id] === max);
        if (e.victimId) {
          if (!top.includes(e.victimId)) this.fail(bot, `gece ${n}: kurban en çok oy alan değil`, e);
          if (pl[e.victimId].death?.cause !== 'night' || pl[e.victimId].death.night !== n) this.fail(bot, `gece ${n}: kurbanın ölüm kaydı yanlış`, pl[e.victimId]);
        }
        if (e.savedId) {
          this.stats.saves++;
          if (e.savedId !== e.doctorPick || !top.includes(e.savedId) || e.victimId) this.fail(bot, `gece ${n}: kurtarma kaydı tutarsız`, e);
        }
        if (!e.victimId && !e.savedId && top.length && !top.some((id) => pl[id].death?.cause === 'left')) this.fail(bot, `gece ${n}: oy vardı ama kimse ölmedi/kurtarılmadı`, e);
        if (e.doctorPick) {
          if (!doctor || !aliveAtNight(doctor, n)) this.fail(bot, `gece ${n}: ölü/olmayan doktorun seçimi sayıldı`, e);
          if (prevNight && prevNight.night === n - 1 && prevNight.doctorPick === e.doctorPick) this.fail(bot, `doktor aynı kişiyi üst üste iki gece korudu (gece ${n - 1},${n})`, e);
        }
        // duyuru
        for (const { bot: b, v: pv } of g.views) if (pv.announcement?.night === n && pv.announcement.deadId !== e.victimId) { this.fail(b, `gece ${n} duyurusu kayıtla uyuşmuyor`, { ann: pv.announcement, victim: e.victimId }); break; }
        prevNight = e;
      } else if ('trial' in e) {
        this.stats.trials++;
        const n = e.night;
        const yes = Object.values(e.votes).filter((x) => x === true).length;
        if (yes !== e.yes) this.fail(bot, 'yargılama kaydında Evet sayısı oylarla uyuşmuyor', e);
        if (e.trial in e.votes) this.fail(bot, 'aday kendi yargılamasında oy vermiş', e);
        if (Object.keys(e.votes).length > e.voters) this.fail(bot, 'oy sayısı seçmen sayısından fazla', e);
        for (const id of Object.keys(e.votes)) {
          const d = pl[id]?.death;
          if (!pl[id] || (d && (d.night < n || (d.night === n && d.cause === 'night')))) this.fail(bot, 'ölü oyuncunun yargılama oyu sayıldı', { id, d, e });
        }
        if (e.yes * 2 > e.voters) this.stats.hanged++;
      }
    }
    g.views = []; // bellek
  }

  // Oyun bitmeden alınmış bir görünümde başkasına ait gizli bilgi var mı? (izin listesi zaten yapıyı denetler; bu ham değer taraması)
  scanLeak(b, pv, roles, vamps) {
    const self = b.playerId;
    const myRole = roles[self];
    const { roleCounts, me, ...rest } = pv;
    const meText = me ? JSON.stringify({ ...me, role: 0 }) : '';
    const restText = JSON.stringify(rest);
    // 1) rol adları (string değer olarak) — sadece roleCounts anahtarları ve kendi me.role izinli
    for (const role of ROLE_IDS) {
      if (restText.includes(`"${role}"`) || meText.includes(`"${role}"`)) this.fail(b, `açıklama öncesi görünümde rol adı "${role}"`, { phase: pv.phase });
    }
    // 2) gizli anahtar adları: herkese açık kısımda hiçbiri; me içinde sadece kendi rolüne ait olanlar
    for (const k of SECRET_KEYS_ALL) if (restText.includes(k)) this.fail(b, `herkese açık kısımda gizli alan ${k}`);
    if (me) {
      const allowed = new Set();
      if (myRole === 'vampir') allowed.add('"allies"').add('"allyPicks"');
      if (myRole === 'gozcu') allowed.add('"seerResults"').add('"isVampire"');
      if (myRole === 'doktor') allowed.add('"lastProtected"');
      for (const k of SECRET_KEYS_ALL) if (!allowed.has(k) && k !== '"role":"' && meText.includes(k)) this.fail(b, `${myRole} görünümünde başkasına ait gizli alan ${k}`);
    }
    // 3) özel rollü oyuncuların id'leri nötr olmayan alanlarda geçmemeli
    const neutral = { ...me, nightTargets: 0, nightPick: 0, seerResults: 0, lastProtected: 0, role: 0 };
    if (myRole === 'vampir') { neutral.allies = 0; neutral.allyPicks = 0; }
    const t = pv.trial;
    const strip = JSON.stringify({ ...rest, players: 0, announcement: 0, lastTrial: 0, nomination: 0, trial: t && { ...t, targetId: 0 }, me: me ? neutral : null });
    for (const [id, role] of Object.entries(roles)) {
      if (id === self || role === 'koylu') continue;
      if (myRole === 'vampir' && role === 'vampir') continue;
      if (strip.includes(id)) this.fail(b, `açıklama öncesi görünümde ${role} oyuncunun id'si nötr olmayan bir alanda`);
    }
    // 4) gözcünün sonuçları gerçek
    if (me?.seerResults) for (const s of me.seerResults) if (s.isVampire !== (roles[s.targetId] === 'vampir')) this.fail(b, 'gözcünün gördüğü sonuç yanlış', s);
    void vamps;
  }

  // Hiçbir bot başkasının token'ını görmemeli.
  finalChecks(bots = [...this.bots.values()]) {
    for (const b of bots) {
      const text = b.transcript();
      for (const o of bots) if (o !== b && o.token && text.includes(o.token)) this.fail(b, `${o.name} token'ını gördü`);
    }
    return this.violations;
  }
}

export function summarizeV(ref) {
  const s = ref.stats;
  return `${ref.label}: views=${s.views} overs=${s.overs} winners=${JSON.stringify(s.winners)} nights=${s.nights} saves=${s.saves} seer=${s.seerPeeks} trials=${s.trials} hanged=${s.hanged} clockChecks=${s.clockChecks}`;
}

// ---------- Monkey oyuncu ----------
// Kurallara uygun rastgele eylemler; `illegalRate` olasılıkla geçersiz / ölüyken eylem dener (sunucu reddetmeli).
// Hız sınırına (30 mesaj / 5 sn) takılmamak için eylemler arası en az `cooldown` ms.
export function vampMonkey(bot, {
  rng, stop, cooldown = 180, minDelay = 20, maxDelay = 90, illegalRate = 0.04, nominateRate = 0.08, supportRate = 0.5,
  endDefenseRate = 0.25, abstainRate = 0.1, yesRate = 0.55, repickRate = 0.03, endDayRate = 0.01, deadActRate = 0.15, stats = {},
}) {
  let lastSent = 0;
  const act = (a, kind) => { lastSent = Date.now(); stats[kind] = (stats[kind] ?? 0) + 1; bot.action(a); };
  return (async () => {
    while (!stop.done) {
      await sleep(minDelay + rng.int(maxDelay - minDelay + 1));
      if (stop.done) break;
      if (!bot.isOpen || !bot.view || !bot.room || bot.room.phase !== 'playing') continue;
      if (Date.now() - lastSent < cooldown) continue;
      const v = bot.view;
      const me = v.me;
      const anyId = () => rng.pick(v.players).id;
      if (!me || !me.alive || rng.next() < illegalRate) {
        // izleyici / ölü / kasıtlı geçersiz: hepsi reddedilmeli, durumu değiştirmemeli
        if (rng.next() < (me && me.alive ? 1 : deadActRate)) {
          act(rng.pick([
            { type: 'nightPick', targetId: anyId() }, { type: 'nominate', targetId: anyId() }, { type: 'support' },
            { type: 'endDefense' }, { type: 'trialVote', yes: true }, { type: 'nightPick', targetId: bot.playerId },
            { type: 'nominate', targetId: bot.playerId }, { type: 'zz' }, { type: 'trialVote', yes: 'evet' },
          ]), me?.alive ? 'illegal' : 'deadAct');
        }
        continue;
      }
      switch (v.phase) {
        case 'night': {
          if (!me.nightTargets.length) break;
          if (me.nightPick == null || (me.role !== 'gozcu' && rng.next() < repickRate)) {
            let t = rng.pick(me.nightTargets);
            if (me.role === 'vampir' && me.allyPicks && rng.next() < 0.7) {
              const ally = Object.values(me.allyPicks).find((x) => me.nightTargets.includes(x));
              if (ally) t = ally;
            }
            act({ type: 'nightPick', targetId: t }, 'nightPick');
          }
          break;
        }
        case 'day': {
          const nom = v.nomination && v.nomination.expiresAt > Date.now() ? v.nomination : null;
          if (bot.room.hostId === bot.playerId && rng.next() < endDayRate) act({ type: 'endDay' }, 'endDay');
          else if (nom && nom.byId !== bot.playerId && nom.targetId !== bot.playerId) { if (rng.next() < supportRate) act({ type: 'support' }, 'support'); } else if (!nom && me.canNominate && rng.next() < nominateRate) {
            const others = v.players.filter((p) => p.alive && p.id !== bot.playerId);
            if (others.length) act({ type: 'nominate', targetId: rng.pick(others).id }, 'nominate');
          }
          break;
        }
        case 'trial':
          if (v.trial.targetId === bot.playerId && rng.next() < endDefenseRate) act({ type: 'endDefense' }, 'endDefense');
          break;
        case 'trialVote':
          if (v.trial.targetId !== bot.playerId && v.trial.myVote == null && rng.next() > abstainRate) act({ type: 'trialVote', yes: rng.next() < yesRate }, 'trialVote');
          break;
        default:
      }
    }
  })();
}

// Hızlı testler için kısa süreler (TIME_SCALE ile çarpılır).
export const FAST = { nightSeconds: 30, dayMinutes: 2, defenseSeconds: 15 };

// ---------- Senaryo yardımcıları ----------
// Oda kur, ayarla, başlat; hakemi bağla. Uzun varsayılan süreler: senaryolar süreye değil eylemlere göre ilerlesin.
export async function setupVampir(wsUrl, makeRoom, n, settings = {}, prefix = 'V') {
  const room = await makeRoom(wsUrl, 'vampir', n, prefix);
  const s = { nightSeconds: 120, dayMinutes: 8, defenseSeconds: 60, ...settings };
  const ref = new VampirReferee({ label: `${prefix} n=${n} ${room.code}` }).attachAll(room.bots);
  room.host.send({ t: 'settings', settings: s });
  await room.host.waitRoom((r) => Object.entries(s).every(([k, v]) => r.settings[k] === v));
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'night' && v.night === 1)));
  const by = (role) => room.bots.filter((b) => b.view.me?.role === role);
  return { ...room, ref, by, vamps: by('vampir'), roleOf: (b) => b.view.me.role };
}

export const isAliveBot = (b) => b.view?.players.find((p) => p.id === b.playerId)?.alive;
// Odada ve bağlı ilk bot (host ayrılmış olabilir)
export const observerOf = (g) => g.bots.find((b) => b.isOpen && b.room && b.view);
// Yaşayanlar: kendi (bayat olabilecek) görünümüne değil, odadaki bir gözlemcinin güncel görünümüne göre
export const livingBots = (g) => {
  const obs = observerOf(g);
  const alive = new Set(obs?.view.players.filter((p) => p.alive).map((p) => p.id));
  return g.bots.filter((b) => b.room && b.view?.me && alive.has(b.playerId));
};

// Odadaki tüm bağlı botlar en son yayını almış olsun (farklı soketler aynı yayını birkaç ms arayla işler; bayat görünümle eylem olmasın).
const lastSeq = (b) => { for (let i = b.messages.length - 1; i >= 0; i--) if (b.messages[i].t === 'view') return b.messages[i].seq; return -1; };
export async function settle(g, timeout = 3000) {
  const inRoom = () => g.bots.filter((b) => b.isOpen && b.room);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const seqs = inRoom().map(lastSeq);
    if (Math.min(...seqs) === Math.max(...seqs)) return;
    await sleep(5);
  }
}

// Geceyi oynat: picks = Map(bot -> targetId); verilmeyenler izin verilen ilk "kendisi olmayan" hedefi seçer.
// victim: vampirlerin ortak hedefi; doktor varsayılan olarak kurbanı korumaz.
export async function playNight(g, { victim, protect, picks = new Map() } = {}) {
  await settle(g);
  const night = observerOf(g).view.night;
  for (const b of livingBots(g)) {
    const me = b.view.me;
    let t = picks.get(b) ?? me.nightTargets.find((id) => id !== b.playerId && id !== victim?.playerId) ?? me.nightTargets[0];
    if (me.role === 'vampir' && victim && !picks.has(b)) t = victim.playerId;
    if (me.role === 'doktor' && protect && !picks.has(b)) t = protect.playerId;
    b.action({ type: 'nightPick', targetId: t });
  }
  const watchers = g.bots.filter((b) => b.isOpen && b.room);
  await Promise.all(watchers.map((b) => b.waitView((v) => v.phase !== 'night' || v.night > night)));
  return observerOf(g).view;
}

// Aday + destek → savunma → oylama. votes: (bot) => true/false/null(oy vermez)
export async function startTrialOn(g, target, { nominator, supporter } = {}) {
  await settle(g);
  const voters = livingBots(g).filter((b) => b !== target);
  nominator ??= voters[0];
  supporter ??= voters.find((b) => b !== nominator);
  await nominator.act({ type: 'nominate', targetId: target.playerId });
  supporter.action({ type: 'support' });
  await observerOf(g).waitView((v) => v.phase === 'trial');
  return { voters, nominator, supporter };
}
