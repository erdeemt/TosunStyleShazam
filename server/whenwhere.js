// 📸 Ne Zaman Nerede? — fotoğraf havuzu, görsel vekili ve tek oyunculu (Günlük + Serbest) oyun. Kurallar: PLAN.md §4.11.
// Lobili sürüm: server/games/whenwhere.js (havuz ve görsel vekili buradan).
//
// Güvenlik: fotoğrafın kimliği, dosya adı, başlığı, koordinatı ve yılı, o turun tahmini kilitlenene kadar hiçbir yanıtta
// yok. Görsel sadece opak, sahibine bağlı /api/media/<jeton> adresinden; sunucu Wikimedia'dan küçük resmi kendisi çeker
// (sadece havuzdaki adresler, sadece upload.wikimedia.org), üst verisini siler, diskte önbellekler.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cryptoRng } from './rng.js';
import { GameError, num, str } from './errors.js';
import { jsonStore } from './store.js';
import { isFreshAccount, rankDaily, todayIstanbul } from './wordle.js';
import { mintMedia } from './media-tokens.js';
import { stripImage } from './image-strip.js';
import { DAILY_ROUNDS, SET_IDS, cleanGuess, scaleOf, scoreRound, titleFor } from '../public/whenwhere-math.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_MODE = process.env.TEST_MODE === '1';
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const CACHE_DIR = join(DATA_DIR, 'whenwhere-cache');
const CACHE_MAX_BYTES = (Number(process.env.WW_CACHE_MB) > 0 ? Number(process.env.WW_CACHE_MB) : 400) * 1024 * 1024;
const UPSTREAM_HOST = 'upload.wikimedia.org';
const UPSTREAM_MAX_BYTES = 12 * 1024 * 1024;
const UPSTREAM_CONCURRENCY = 3;
const UA = 'TosunStyleGames/1.0 (https://github.com/erdeemt/TosunStyleShazam; game image cache) node';

const EPOCH = '2026-11-02'; // 1 numaralı günlük
const BOARD_LIMIT = 50;
const KEEP_DAYS = 45;
const FREE_TTL_MS = 6 * 3600_000;
const MAX_FREE_GAMES = 5000;
const FREE_PER_PLAYER = 3;
const SEEN_KEEP = 150; // serbest modda yakın zamanda görülen fotoğraflar tekrar gelmesin
const MEDIA_TTL_MS = 20 * 60_000; // tek oyunculu süresiz; sayfa yenilenirse yeni jeton verilir
const MEDIA_USES = 3;

// ---------- Havuz ----------

function loadPool() {
  const file = TEST_MODE && process.env.WW_POOL !== 'real' ? 'test-photos.json' : 'photos.json';
  let json;
  try {
    json = JSON.parse(readFileSync(join(ROOT, 'content', 'whenwhere', file), 'utf8'));
  } catch (err) {
    // Havuz yoksa/bozuksa sunucu yine açılsın (diğer oyunlar etkilenmesin); bu oyun "yeterli fotoğraf yok" der.
    console.error(`📸 Ne Zaman Nerede? havuzu okunamadı (${file}): ${err.message}`);
    return [];
  }
  return json.photos.filter((p) => p && typeof p.id === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isInteger(p.year));
}

export const POOL = loadPool();
const BY_ID = new Map(POOL.map((p) => [p.id, p]));
export const photoById = (id) => BY_ID.get(id) ?? null;

export function inSet(p, setId) {
  if (setId === 'turkiye') return p.tags.sets.includes('turkiye');
  if (setId === 'istanbul') return p.tags.sets.includes('istanbul');
  if (setId.startsWith('era-')) return p.tags.era === setId.slice(4);
  if (setId.startsWith('tema-')) return p.tags.themes.includes(setId.slice(5));
  return true;
}
export const cleanSet = (raw) => (SET_IDS.has(str(raw)) ? str(raw) : 'karisik');
export const poolOf = (setId) => POOL.filter((p) => inSet(p, setId));
export const setCounts = () => Object.fromEntries([...SET_IDS].map((id) => [id, poolOf(id).length]));

// Rastgele n fotoğraf (tekrarsız). avoid: kaçınılacak kimlikler (yetmezse en eskisinden başlayarak serbest bırakılır).
export function pickPhotos(setId, n, rng = cryptoRng(), avoid = []) {
  const pool = poolOf(setId);
  const avoidList = avoid.filter((id) => BY_ID.has(id));
  let banned = new Set(avoidList);
  let cands = pool.filter((p) => !banned.has(p.id));
  for (let drop = 0; cands.length < n && drop < avoidList.length; drop += Math.max(1, n)) {
    banned = new Set(avoidList.slice(drop + n));
    cands = pool.filter((p) => !banned.has(p.id));
  }
  const out = [];
  const list = [...cands];
  while (out.length < n && list.length) out.push(list.splice(Math.floor(rng.next() * list.length), 1)[0]);
  return out;
}

// Herkese açık sonuç (tur kilitlendikten sonra): cevap + künye. Ham kaynak adresi (thumb) gitmez.
export function revealOf(p) {
  return {
    truth: { lat: p.lat, lon: p.lon, year: p.year },
    title: p.title_tr,
    caption: p.caption_tr,
    descEn: p.desc_en ?? null,
    wikiUrl: p.wikiUrl,
    fileUrl: p.fileUrl,
    author: p.author,
    license: p.license,
    licenseUrl: p.licenseUrl,
  };
}

// ---------- Görsel vekili (önbellek + üst veri silme) ----------

const cacheIndex = new Map(); // dosya adı -> { size, used }
let cacheBytes = 0;
try {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const f of readdirSync(CACHE_DIR)) {
    if (!/^[0-9a-f]{40}\.(jpg|png)$/.test(f)) continue;
    const st = statSync(join(CACHE_DIR, f));
    cacheIndex.set(f, { size: st.size, used: st.mtimeMs });
    cacheBytes += st.size;
  }
} catch (err) { console.error('whenwhere önbellek klasörü:', err.message); }

function evict() {
  if (cacheBytes <= CACHE_MAX_BYTES) return;
  const old = [...cacheIndex].sort((a, b) => a[1].used - b[1].used);
  for (const [f, e] of old) {
    if (cacheBytes <= CACHE_MAX_BYTES * 0.9) break;
    try { unlinkSync(join(CACHE_DIR, f)); } catch { /* zaten yok */ }
    cacheIndex.delete(f);
    cacheBytes -= e.size;
  }
}

export const contentTypeOf = (p) => (TEST_MODE && process.env.WW_POOL !== 'real' ? 'image/jpeg' : /\.png$/i.test(p.src.thumb) ? 'image/png' : 'image/jpeg');

let active = 0;
const waiters = [];
async function slot(fn) {
  if (active >= UPSTREAM_CONCURRENCY) await new Promise((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

// Sadece havuzdaki adres ve sadece upload.wikimedia.org (açık vekil olmasın). Yönlendirme izlenmez.
export function upstreamUrl(p) {
  let u;
  try { u = new URL(p.src.thumb); } catch { return null; }
  return u.protocol === 'https:' && u.hostname === UPSTREAM_HOST && !u.username && !u.password && !u.port ? u.href : null;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
  if (Number(res.headers.get('content-length')) > UPSTREAM_MAX_BYTES) throw new Error('görsel çok büyük');
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > UPSTREAM_MAX_BYTES) throw new Error('görsel çok büyük');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// TEST_MODE: Wikimedia'ya gidilmez; yerel yer tutucu görsele fotoğraf kimliğini ve başlığını içeren sahte EXIF/yorum
// bölütleri eklenir (testler üst verinin silindiğini uçtan uca doğrular).
let placeholder = null;
function testImage(p) {
  placeholder ??= readFileSync(join(ROOT, 'content', 'whenwhere', 'test-placeholder.jpg'));
  const secret = Buffer.from(`Exif\0\0SECRET ${p.id} ${p.title_tr} ${p.lat},${p.lon} ${p.year}`, 'utf8');
  const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([placeholder.subarray(0, 2), seg(0xe1, secret), seg(0xfe, Buffer.from(`file=${p.src.file}`)), placeholder.subarray(2)]);
}

const inflight = new Map();

// Fotoğrafın üst verisi silinmiş baytları (önce disk önbelleği).
export function photoBytes(p) {
  const key = createHash('sha1').update(p.src.file).digest('hex');
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    if (TEST_MODE && process.env.WW_POOL !== 'real') return stripImage(testImage(p)).body;
    const ext = contentTypeOf(p) === 'image/png' ? 'png' : 'jpg';
    const name = `${key}.${ext}`;
    const hit = cacheIndex.get(name);
    if (hit) {
      try {
        const body = readFileSync(join(CACHE_DIR, name));
        hit.used = Date.now();
        return body;
      } catch { cacheIndex.delete(name); cacheBytes -= hit.size; }
    }
    const url = upstreamUrl(p);
    if (!url) throw new Error('geçersiz kaynak adresi');
    const raw = await slot(() => download(url));
    const { type, body } = stripImage(raw);
    if (type !== contentTypeOf(p)) throw new Error('beklenmeyen görsel türü');
    try {
      const tmp = join(CACHE_DIR, `${name}.tmp`);
      writeFileSync(tmp, body);
      renameSync(tmp, join(CACHE_DIR, name));
      cacheIndex.set(name, { size: body.length, used: Date.now() });
      cacheBytes += body.length;
      evict();
    } catch (err) { console.error('whenwhere önbelleğe yazılamadı:', err.message); }
    return body;
  })();
  inflight.set(key, job);
  job.finally(() => inflight.delete(key)).catch(() => {});
  return job;
}

// Arka planda önbelleği ısıt (tur başlamadan indirilsin). Hata sessiz: asıl istek tekrar dener.
export const warm = (photos) => { for (const p of photos) photoBytes(p).catch(() => {}); };

// Fotoğraf için opak medya adresi (sahibine, lobide odaya bağlı).
export function photoMedia(p, { owner, room = null, ttlMs = MEDIA_TTL_MS, uses = MEDIA_USES }) {
  return mintMedia({ owner, room, contentType: contentTypeOf(p), ttlMs, uses, cacheKey: `whenwhere:${p.id}`, render: () => photoBytes(p) });
}

export const cacheStats = () => ({ files: cacheIndex.size, bytes: cacheBytes });

// ---------- Günlük ----------

const secrets = jsonStore('secrets', {});
const identityStore = jsonStore('identities', {});
if (!secrets.data.whenwhereSalt) { secrets.data.whenwhereSalt = randomBytes(16).toString('hex'); secrets.flushNow(); }
const SALT = process.env.WHENWHERE_SALT || secrets.data.whenwhereSalt;

function hmacRng(text) {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return {
    next() {
      if (pos + 6 > buf.length) { buf = createHmac('sha256', SALT).update(`${text}#${counter++}`).digest(); pos = 0; }
      const v = buf.readUIntBE(pos, 6) / 2 ** 48;
      pos += 6;
      return v;
    },
  };
}

export const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);

// Günün 5 fotoğrafı: gizli tuzla karıştırılmış havuz sırasından ardışık dilim (döngü bitene kadar tekrar yok).
// Tarih + tuz → hep aynı sonuç. Gün ilk kez istendiğinde kimlikler kaydedilir: havuz gün içinde güncellense de değişmez.
export function dailyPhotoIds(date) {
  const ids = [...POOL].map((p) => p.id).sort();
  const rng = hmacRng(`tosun-whenwhere-perm-v1:${Math.floor(dayIndex(date) * DAILY_ROUNDS / Math.max(1, ids.length))}`);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const start = ((dayIndex(date) * DAILY_ROUNDS) % ids.length + ids.length) % ids.length;
  const out = [];
  for (let k = 0; out.length < Math.min(DAILY_ROUNDS, ids.length); k++) {
    const id = ids[(start + k) % ids.length];
    if (!out.includes(id)) out.push(id);
  }
  // Sıra da karışık olsun (hep aynı dönem/bölge düzeni gelmesin)
  const order = hmacRng(`tosun-whenwhere-order-v1:${date}`);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(order.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const days = jsonStore('whenwhere-days', {}); // { date: [photoId…] } — günün sabitlenmiş fotoğrafları
const daily = jsonStore('whenwhere-daily', {}); // { date: { playerId: { name, rounds, done, total, finishedAt } } }
const seen = jsonStore('whenwhere-seen', {}); // { playerId: [photoId…] } (serbest modda tekrar önleme)
const freeGames = new Map(); // gameId -> oyun

function dayPhotos(date) {
  let ids = days.data[date];
  if (!Array.isArray(ids) || ids.some((id) => !BY_ID.has(id))) {
    ids = dailyPhotoIds(date);
    days.data[date] = ids;
    days.save();
  }
  return ids.map((id) => BY_ID.get(id));
}

function prune() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const store of [daily, days]) {
    let changed = false;
    for (const date of Object.keys(store.data)) if (date < cutoff) { delete store.data[date]; changed = true; }
    if (changed) store.save();
  }
  const freeCut = Date.now() - FREE_TTL_MS;
  for (const [id, g] of freeGames) if (g.createdAt < freeCut) freeGames.delete(id);
}
prune();
setInterval(prune, 3600_000).unref();

// ---------- Oyun durumu ----------
// Oyun: { playerId, set, photos: [photo], rounds: [{ startedAt, guess, result }], done, total, finishedAt }

function publicGame(game, extra) {
  const played = game.rounds
    .map((r, i) => (r.guess === undefined ? null : { index: i, guess: r.guess, ...r.result, ...revealOf(game.photos[i]) }))
    .filter(Boolean);
  const total = played.reduce((s, r) => s + r.score, 0);
  const pendingIndex = game.rounds.findIndex((r) => r.guess === undefined);
  return {
    rounds: game.photos.length,
    set: game.set,
    played,
    // Yarıda kalan tur (sayfa yenilendi): görsel adresi yeniden verilir (süresiz mod; fotoğraf zaten ekrandaydı).
    pending: pendingIndex >= 0 ? { index: pendingIndex, image: photoMedia(game.photos[pendingIndex], { owner: game.playerId }) } : null,
    done: Boolean(game.done),
    total,
    badge: game.done ? titleFor(total, game.photos.length) : null, // bitiş unvanı
    ...extra,
  };
}

function lookup(identity, mode, rawGameId, create = false) {
  if (mode === 'free') {
    const game = freeGames.get(str(rawGameId));
    if (!game || game.playerId !== identity.id) throw new GameError('Oyun bulunamadı, yeni oyun başlat.');
    return { game, extra: { mode, gameId: str(rawGameId) } };
  }
  const date = todayIstanbul();
  if (rawGameId !== date) throw new GameError('Günün fotoğrafları değişti, sayfayı yenile.');
  const byDate = (daily.data[date] ??= {});
  const photos = dayPhotos(date);
  if (!byDate[identity.id] && create) byDate[identity.id] = { name: identity.name ?? 'Oyuncu', rounds: [], done: false, total: 0, finishedAt: null };
  const rec = byDate[identity.id];
  // Günlük kayıtta fotoğraflar saklanmaz (gün listesinden); oyun nesnesi istek boyunca kurulur, durum kayıtta.
  const game = rec ? {
    playerId: identity.id,
    set: 'karisik',
    photos,
    rec,
    get rounds() { return rec.rounds; },
    get done() { return rec.done; },
    set done(v) { rec.done = v; },
  } : null;
  return { game, extra: { mode, gameId: date, puzzleNo: dayIndex(date) + 1 } };
}

// ---------- HTTP uçları (server.js; identity doğrulanmış) ----------

export function startGame(identity, mode, rawSet) {
  if (POOL.length < DAILY_ROUNDS) throw new GameError('Fotoğraf havuzu hazır değil.');
  if (mode === 'free') {
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - (FREE_PER_PLAYER - 1)))) freeGames.delete(oldId);
    if (freeGames.size >= MAX_FREE_GAMES) prune();
    if (freeGames.size >= MAX_FREE_GAMES) throw new GameError('Sunucu şu an çok yoğun, biraz sonra tekrar dene.');
    const set = cleanSet(rawSet);
    const photos = pickPhotos(set, DAILY_ROUNDS, cryptoRng(), seen.data[identity.id] ?? []);
    if (photos.length < DAILY_ROUNDS) throw new GameError('Bu sette yeterli fotoğraf yok.');
    const id = randomUUID();
    const game = { playerId: identity.id, set, photos, rounds: [], done: false, createdAt: Date.now() };
    freeGames.set(id, game);
    warm(photos.slice(0, 2));
    return publicGame(game, { mode, gameId: id, counts: setCounts() });
  }
  const date = todayIstanbul();
  const { game, extra } = lookup(identity, 'daily', date);
  warm(dayPhotos(date));
  if (!game) return { ...publicGame({ playerId: identity.id, set: 'karisik', photos: dayPhotos(date), rounds: [], done: false }, extra), counts: setCounts() };
  return { ...publicGame(game, extra), counts: setCounts() };
}

// Turu başlat: görsel adresi SADECE burada verilir. Tur atlanamaz; önceki tur kilitlenmeden yenisi açılmaz.
export function startRound(identity, mode, rawGameId, rawIndex) {
  const { game, extra } = lookup(identity, mode, rawGameId, true);
  const index = num(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= game.photos.length) throw new GameError('Geçersiz tur.');
  if (game.done) throw new GameError(mode === 'daily' ? 'Bugünkü fotoğrafları bitirdin. Yarın yenileri!' : 'Bu oyun bitti.');
  const r = game.rounds[index];
  if (r && r.guess !== undefined) throw new GameError('Bu tur zaten bitti.');
  if (!r) {
    if (index !== game.rounds.length || game.rounds.some((x) => x.guess === undefined)) throw new GameError('Önce önceki turu bitir.');
    game.rounds.push({ startedAt: Date.now() });
    if (mode === 'daily') { game.rec.name = identity.name ?? game.rec.name; daily.save(); }
    if (mode === 'free') {
      const list = (seen.data[identity.id] ??= []);
      list.push(game.photos[index].id);
      if (list.length > SEEN_KEEP) list.splice(0, list.length - SEEN_KEEP);
      seen.save();
    }
    warm(game.photos.slice(index + 1, index + 2));
  }
  return { ...extra, index, rounds: game.photos.length, image: photoMedia(game.photos[index], { owner: identity.id }) };
}

export function submitGuess(identity, mode, rawGameId, rawIndex, rawGuess) {
  const { game, extra } = lookup(identity, mode, rawGameId);
  if (!game) throw new GameError('Önce turu başlat.');
  const index = num(rawIndex);
  const r = Number.isInteger(index) ? game.rounds[index] : null;
  if (!r) throw new GameError('Bu tur başlamadı.');
  if (r.guess !== undefined) throw new GameError('Bu turun tahmini zaten alındı.');
  const guess = cleanGuess(rawGuess);
  if (!guess) throw new GameError('Geçersiz tahmin.');
  const scale = scaleOf(game.set);
  r.guess = guess;
  r.result = scoreRound(guess, game.photos[index], scale);
  r.lockedAt = Date.now();
  if (game.rounds.length >= game.photos.length && game.rounds.every((x) => x.guess !== undefined)) {
    game.done = true;
    const total = game.rounds.reduce((s, x) => s + x.result.score, 0);
    if (mode === 'daily') { game.rec.total = total; game.rec.finishedAt = Date.now(); }
  }
  if (mode === 'daily') { game.rec.name = identity.name ?? game.rec.name; daily.save(); }
  return publicGame(game, extra);
}

export function leaderboard(date, viewerId) {
  const day = daily.data[date] ?? {};
  const viewerDone = Boolean(day[viewerId]?.done);
  const entries = Object.entries(day).filter(([, e]) => e.done).map(([id, e]) => ({
    name: identityStore.data[id]?.name ?? e.name,
    me: id === viewerId,
    fresh: isFreshAccount(identityStore.data[id], date),
    total: e.total,
    finishedAt: e.finishedAt,
    badge: titleFor(e.total, DAILY_ROUNDS).name,
    scores: viewerDone ? e.rounds.map((x) => x.result?.score ?? 0) : null,
  }));
  return {
    date,
    puzzleNo: dayIndex(date) + 1,
    viewerDone,
    entries: rankDaily(entries, (a, b) => b.total - a.total || a.finishedAt - b.finishedAt, BOARD_LIMIT),
    finishers: entries.length,
    playing: Object.values(day).filter((e) => !e.done && e.rounds.length).length,
  };
}

export { todayIstanbul };

// Sadece testler (TEST_GAMES=1 + TEST_MODE=1, /api/_test/secret): bir oyunun gerçek cevapları.
export function _testSecrets(rawGameId) {
  const free = freeGames.get(str(rawGameId));
  const photos = free ? free.photos : dayPhotos(str(rawGameId));
  return { truths: photos.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, year: p.year, title: p.title_tr, file: p.src.file })) };
}
