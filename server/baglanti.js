// 🔗 Bağlantı Avı — kişi grafiği, zincir motoru (tek + çok oyunculu ortak), kişi dizini, fotoğraf vekili ve tek oyunculu
// (Günlük + Sınırsız) uçlar. Kurallar: PLAN.md §4.12. Lobili sürüm: server/games/baglanti.js (motor buradan).
//
// Güvenlik: bağlantı listesi (komşular) ve en kısa yol hiçbir yanıtta yok; istemci her adımı tek tek gönderir, sunucu
// kenarı doğrular ve sadece o kenarın etiketini döner. En kısa yol sadece zincir bittikten sonra (lobide tur kapanınca).
// İstemcinin elindeki kişi dizini (ad, yıl, kısa açıklama, alan, fotoğraf var mı) bağlantı bilgisi taşımaz.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { cryptoRng } from './rng.js';
import { GameError, num, str } from './errors.js';
import { jsonStore } from './store.js';
import { isFreshAccount, rankDaily, todayIstanbul } from './wordle.js';
import { stripImage } from './image-strip.js';
import { windowCounter } from './limits.js';
import { DAILY_DIFF, DIFF_IDS, HINT_COST, MAX_CHAIN, MAX_HINTS, catText, initialOf, scoreRun, titleFor } from '../public/baglanti-math.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_MODE = process.env.TEST_MODE === '1';
const TEST_DATA = TEST_MODE && process.env.BG_DATA !== 'real';
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const CACHE_DIR = join(DATA_DIR, 'baglanti-cache');
const CACHE_MAX_BYTES = (Number(process.env.BG_CACHE_MB) > 0 ? Number(process.env.BG_CACHE_MB) : 150) * 1024 * 1024;
const UPSTREAM_HOST = 'upload.wikimedia.org';
const UPSTREAM_MAX_BYTES = 4 * 1024 * 1024;
const UPSTREAM_CONCURRENCY = 3;
const THUMB_PX = 330; // Wikimedia'nın standart küçük resim adımlarından biri
const UA = 'TosunStyleGames/1.0 (https://github.com/erdeemt/TosunStyleShazam; game image cache) node';

const EPOCH = '2026-11-09'; // 1 numaralı günlük
const BOARD_LIMIT = 50;
const KEEP_DAYS = 45;
const FREE_TTL_MS = 6 * 3600_000;
const MAX_FREE_GAMES = 5000;
const FREE_PER_PLAYER = 3;
const SEEN_KEEP = 300;

// ---------- Veri ----------

function readJson(name) {
  return JSON.parse(readFileSync(join(ROOT, 'content', 'baglanti', name), 'utf8'));
}

function loadData() {
  try {
    if (TEST_DATA) {
      const t = readJson('test-graph.json');
      return { people: t.people, types: t.types, ctx: t.ctx, edges: t.edges, puzzles: t.puzzles };
    }
    const p = readJson('people.json');
    const e = readJson('edges.json');
    const z = readJson('puzzles.json');
    return { people: p.people, types: e.types, ctx: e.ctx, edges: e.edges, puzzles: { kolay: z.kolay, orta: z.orta, zor: z.zor } };
  } catch (err) {
    // Veri yoksa/bozuksa sunucu yine açılsın (diğer oyunlar etkilenmesin); bu oyun "hazır değil" der.
    console.error(`🔗 Bağlantı Avı verisi okunamadı: ${err.message}`);
    return { people: [], types: [], ctx: [], edges: [], puzzles: { kolay: [], orta: [], zor: [] } };
  }
}

const DATA = loadData();
export const PEOPLE = DATA.people;
const TYPES = DATA.types;
const CTX = DATA.ctx;
const EDGES = DATA.edges;
const BY_Q = new Map(PEOPLE.map((p, i) => [p.q, i]));
const ADJ = PEOPLE.map(() => new Map()); // kişi sırası -> (komşu sırası -> kenar)
for (const e of EDGES) {
  const [a, b] = e;
  if (!PEOPLE[a] || !PEOPLE[b] || a === b) continue;
  ADJ[a].set(b, e);
  ADJ[b].set(a, e);
}

export const QID_RE = /^Q[1-9]\d{0,11}$/;
export const personOf = (q) => (typeof q === 'string' && BY_Q.has(q) ? PEOPLE[BY_Q.get(q)] : null);
export const connected = (qa, qb) => BY_Q.has(qa) && BY_Q.has(qb) && ADJ[BY_Q.get(qa)].has(BY_Q.get(qb));

// En kısa yol (BFS). Komşular ünlüden aza (küçük sıra = ünlü) gezilir: aynı uzunlukta yollardan ünlüsü seçilir.
export function distancesTo(q) {
  const n = PEOPLE.length;
  const dist = new Int16Array(n).fill(-1);
  const src = BY_Q.get(q);
  if (src == null) return dist;
  dist[src] = 0;
  const queue = [src];
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (const v of ADJ[u].keys()) if (dist[v] < 0) { dist[v] = dist[u] + 1; queue.push(v); }
  }
  return dist;
}

export function shortestPath(qa, qb) {
  if (!BY_Q.has(qa) || !BY_Q.has(qb)) return null;
  const dist = distancesTo(qb);
  let u = BY_Q.get(qa);
  if (dist[u] < 0) return null;
  const path = [u];
  while (dist[u] > 0) {
    let best = -1;
    for (const v of ADJ[u].keys()) if (dist[v] === dist[u] - 1 && (best < 0 || v < best)) best = v;
    u = best;
    path.push(u);
  }
  return path.map((i) => PEOPLE[i].q);
}

// Yapboz havuzları (betik üretir; burada doğrulanır: her adım gerçekten bağlı ve yol en kısa uzunlukta).
const LENS = { kolay: 3, orta: 4, zor: 5 };
export const PUZZLES = {};
for (const diff of Object.keys(LENS)) {
  PUZZLES[diff] = (DATA.puzzles[diff] ?? []).map(([s, t, path]) => ({ diff, s: PEOPLE[s]?.q, t: PEOPLE[t]?.q, path: (path ?? []).map((i) => PEOPLE[i]?.q) }))
    .filter((z) => z.s && z.t && z.path.length === LENS[diff] + 1 && z.path.every(Boolean) && z.path[0] === z.s && z.path.at(-1) === z.t
      && z.path.every((q, i) => i === 0 || connected(z.path[i - 1], q)))
    .map((z) => ({ ...z, key: `${diff}:${z.s}-${z.t}` }));
}
export const puzzleCounts = () => Object.fromEntries(Object.entries(PUZZLES).map(([k, v]) => [k, v.length]));

// ---------- Bağlantı etiketi ----------
// "to" kişisinin "from" kişisine göre ne olduğu: { e: simge, t: metin } (ör. 👪 babası, ⚽ takım arkadaşı: Fenerbahçe (1998–2000)).

const byGender = (p, m, f, n) => (p?.g === 'f' ? f : p?.g === 'm' ? m : n);

export function relation(fromQ, toQ) {
  const a = BY_Q.get(fromQ);
  const b = BY_Q.get(toQ);
  const e = a != null && b != null ? ADJ[a].get(b) : null;
  if (!e) return null;
  const type = TYPES[e[2]];
  const fwd = e[0] === a; // kenarın yönü from → to mu
  const to = PEOPLE[b];
  const c = e[3] >= 0 && CTX[e[3]] ? CTX[e[3]] : null;
  const meta = c && c.length > 1 ? c[0] : '';
  const label = c ? c[c.length - 1] : '';
  const y1 = e[4] || null;
  const y2 = e[5] || null;
  const yrs = y1 ? (y2 && y2 !== y1 ? ` (${y1}–${y2})` : ` (${y1})`) : '';
  switch (type) {
    case 'spouse': return { e: '💍', t: 'eşi' };
    case 'parent': return fwd ? { e: '👪', t: byGender(to, 'babası', 'annesi', 'ebeveyni') } : { e: '👶', t: byGender(to, 'oğlu', 'kızı', 'çocuğu') };
    case 'sibling': return { e: '👫', t: 'kardeşi' };
    case 'relative': return { e: '👪', t: 'akrabası' };
    case 'partner': return { e: '❤️', t: 'sevgilisi / hayat arkadaşı' };
    case 'teacher': return fwd ? { e: '🎓', t: 'hocası' } : { e: '🎓', t: 'öğrencisi' };
    case 'successor': {
      const where = meta === '👑' ? 'tahtta' : 'görevde';
      const pos = label ? `: ${label}` : '';
      return fwd ? { e: meta || '🏛️', t: `${where} ardılı${pos}${yrs}` } : { e: meta || '🏛️', t: `${where} selefi${pos}${yrs}` };
    }
    case 'influence': return fwd ? { e: '💡', t: 'etkilendiği isim' } : { e: '💡', t: 'ondan etkilendi' };
    case 'band': return { e: '🎵', t: `aynı grupta: ${label}` };
    case 'team': return { e: meta || '⚽', t: `takım arkadaşı: ${label}${yrs}` };
    case 'coach': return fwd ? { e: meta || '⚽', t: `oyuncusuydu: ${label}${yrs}` } : { e: '📋', t: `teknik direktörüydü: ${label}${yrs}` };
    case 'cast': return { e: meta || '🎬', t: `${meta === '📺' ? 'aynı dizide' : 'aynı filmde'}: ${label}` };
    case 'director': return fwd ? { e: meta || '🎬', t: `yönettiği yapımda oynadı: ${label}` } : { e: meta || '🎬', t: `yönetmeni: ${label}` };
    case 'election': return { e: '🗳️', t: `aynı seçimde yarıştılar: ${label}` };
    case 'founder': return { e: '🏢', t: `birlikte kurdular: ${label}` };
    case 'battle': return { e: '⚔️', t: `aynı muharebede: ${label}` };
    case 'duet': return { e: '🎤', t: `birlikte söylediler: ${label}` };
    case 'song': return fwd ? { e: '🎼', t: `yazdığı şarkıyı söyledi: ${label}` } : { e: '🎼', t: `şarkısını yazdı: ${label}` };
    case 'associate': return { e: '🤝', t: 'ortağı / çalışma arkadaşı' };
    case 'significant': return { e: '🤝', t: label ? `hayatında önemli: ${label}` : 'hayatında önemli bir isim' };
    default: return { e: '🔗', t: 'bağlantılı' };
  }
}

export const pathLabeled = (path) => path.slice(1).map((q, i) => ({ q, ...relation(path[i], q) }));

// ---------- Zincir motoru (tek + çok oyunculu) ----------
// run = { s, t, diff, opt (en kısa yoldaki ara kişi), path (en kısa yol, gizli), chain: [{ q, e, t }], wrong, hints,
//         hintFor, startedAt, finishedAt, done, gaveUp, final, fbN, fb }

export function newRun(puzzle, now = Date.now()) {
  return {
    s: puzzle.s, t: puzzle.t, diff: puzzle.diff, key: puzzle.key, path: puzzle.path, opt: puzzle.path.length - 2,
    chain: [], wrong: 0, hints: [], hintFor: null, startedAt: now, finishedAt: null, done: false, gaveUp: false, final: null, fbN: 0, fb: null,
  };
}

const endOf = (run) => (run.chain.length ? run.chain.at(-1).q : run.s);

function feedback(run, fb) {
  run.fbN += 1;
  run.fb = { n: run.fbN, ...fb };
  return run.fb;
}

function finish(run, now) {
  run.done = true;
  run.finishedAt = now;
}

// Adım ekle. Bağlı değilse yanlış deneme sayılır (hata fırlatmaz; geri bildirim döner). Geçersiz girdi → GameError.
export function addStep(run, rawQ, now = Date.now()) {
  if (run.done) throw new GameError('Bu zincir bitti.');
  const q = str(rawQ);
  if (!QID_RE.test(q) || !BY_Q.has(q)) throw new GameError('Bu kişi listede yok.');
  if (q === run.s || run.chain.some((c) => c.q === q)) throw new GameError('Bu kişi zaten zincirde.');
  const end = endOf(run);
  if (q === run.t) {
    if (!connected(end, q)) { run.wrong = Math.min(999, run.wrong + 1); return feedback(run, { ok: false, q }); }
    run.final = relation(end, q);
    finish(run, now);
    return feedback(run, { ok: true, q, done: true });
  }
  if (run.chain.length >= MAX_CHAIN) throw new GameError(`En fazla ${MAX_CHAIN} ara kişi olur. Birkaçını çıkar.`);
  if (!connected(end, q)) { run.wrong = Math.min(999, run.wrong + 1); return feedback(run, { ok: false, q }); }
  run.chain.push({ q, ...relation(end, q) });
  if (connected(q, run.t)) {
    run.final = relation(q, run.t);
    finish(run, now);
  }
  return feedback(run, { ok: true, q, done: run.done });
}

// pos ve sonrasını sil (zincir ortadan kopamaz).
export function removeStep(run, rawPos) {
  if (run.done) throw new GameError('Bu zincir bitti.');
  const pos = num(rawPos);
  if (!Number.isInteger(pos) || pos < 0 || pos >= run.chain.length) throw new GameError('Geçersiz adım.');
  run.chain.length = pos;
  return feedback(run, { ok: true, removed: pos });
}

function eraText(b) {
  if (b == null) return '';
  if (b >= 1800) return ` · ${Math.floor(b / 10) * 10}'larda doğdu`;
  if (b <= 0) return ` · MÖ ${Math.floor((1 - b - 1) / 100) + 1}. yüzyıl`;
  return ` · ${Math.floor((b - 1) / 100) + 1}. yüzyıl`;
}

// İpucu: zincirin ucundan hedefe en kısa yoldaki SIRADAKİ kişi hakkında (baş harf / alan). Aynı uç için aynı ipucu tekrar ücretsiz.
export function useHint(run, rawKind) {
  if (run.done) throw new GameError('Bu zincir bitti.');
  const kind = str(rawKind);
  if (!Object.hasOwn(HINT_COST, kind)) throw new GameError('Bilinmeyen ipucu.');
  const end = endOf(run);
  if (run.hintFor?.end !== end) {
    const path = shortestPath(end, run.t);
    run.hintFor = { end, next: path && path.length > 1 ? path[1] : null };
  }
  const next = run.hintFor.next;
  if (run.hints.some((h) => h.end === end && h.k === kind)) return feedback(run, { ok: true, hint: kind });
  if (run.hints.length >= MAX_HINTS) throw new GameError('İpucu hakkın bitti.');
  let text;
  if (!next) text = 'Bu kişiden hedefe yol yok; zinciri kısalt.';
  else if (next === run.t) text = 'Hedefe tek adımdasın!';
  else if (kind === 'letter') text = `Sıradaki kişinin adı “${initialOf(personOf(next).n)}” ile başlıyor.`;
  else text = `Sıradaki kişi: ${catText(personOf(next).c?.[0])}${eraText(personOf(next).b)}`;
  run.hints.push({ k: kind, end, at: run.chain.length, text });
  return feedback(run, { ok: true, hint: kind });
}

export function giveUp(run, now = Date.now()) {
  if (run.done) throw new GameError('Bu zincir bitti.');
  run.gaveUp = true;
  finish(run, now);
  return feedback(run, { ok: true, gaveUp: true });
}

export function runResult(run, now = Date.now()) {
  const ms = (run.finishedAt ?? now) - run.startedAt;
  const r = scoreRun({ steps: run.chain.length, optimal: run.opt, wrong: run.wrong, hints: run.hints.map((h) => h.k), seconds: ms / 1000, done: run.done, gaveUp: run.gaveUp });
  return { ...r, steps: run.chain.length, ms };
}

// İstemciye giden görünüm. reveal=false iken en kısa yol YOK (sadece uzunluğu, yani zorluk).
export function publicRun(run, { reveal = false, now = Date.now() } = {}) {
  const result = run.done ? runResult(run, now) : null;
  return {
    start: run.s,
    target: run.t,
    diff: run.diff,
    opt: run.opt,
    chain: run.chain.map((c) => ({ q: c.q, e: c.e, t: c.t })),
    wrong: run.wrong,
    hints: run.hints.map((h) => ({ k: h.k, at: h.at, text: h.text })),
    done: run.done,
    gaveUp: run.gaveUp,
    final: run.done && !run.gaveUp ? run.final : null,
    elapsedMs: (run.finishedAt ?? now) - run.startedAt,
    fb: run.fb,
    result: result ? { ...result, title: titleFor(result.score) } : null,
    optimal: reveal && run.done ? pathLabeled(run.path) : null,
  };
}

// ---------- Kişi dizini (istemcinin araması için; bağlantı içermez) ----------

let indexCache = null;
export function peopleIndex() {
  if (!indexCache) {
    const rows = PEOPLE.map((p) => [p.q, p.n, p.a ?? '', p.b ?? null, p.d ?? null, p.s ?? '', (p.c ?? []).join(','), p.img ? 1 : 0, p.k ?? '']);
    const body = Buffer.from(JSON.stringify({ v: 1, people: rows }));
    indexCache = { body, gz: gzipSync(body, { level: 9 }), etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
  }
  return indexCache;
}

export function servePeople(req, res) {
  const idx = peopleIndex();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: idx.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === idx.etag) { res.writeHead(304, headers); return res.end(); }
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': idx.gz.length });
    return res.end(idx.gz);
  }
  res.writeHead(200, { ...headers, 'Content-Length': idx.body.length });
  return res.end(idx.body);
}

// ---------- Fotoğraf vekili (önbellek + üst veri silme) ----------
// Sadece kümedeki kişinin P18 dosyası, sadece upload.wikimedia.org (adres sunucuda hesaplanır, istemci adres vermez).

export function thumbUrl(file) {
  if (typeof file !== 'string' || !/\.(jpe?g|png)$/i.test(file) || file.includes('/')) return null;
  const h = createHash('md5').update(file).digest('hex');
  const enc = encodeURIComponent(file);
  const u = new URL(`https://${UPSTREAM_HOST}/wikipedia/commons/thumb/${h[0]}/${h.slice(0, 2)}/${enc}/${THUMB_PX}px-${enc}`);
  return u.protocol === 'https:' && u.hostname === UPSTREAM_HOST && !u.username && !u.password && !u.port ? u.href : null;
}

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
} catch (err) { console.error('baglanti önbellek klasörü:', err.message); }

function evict() {
  if (cacheBytes <= CACHE_MAX_BYTES) return;
  for (const [f, e] of [...cacheIndex].sort((a, b) => a[1].used - b[1].used)) {
    if (cacheBytes <= CACHE_MAX_BYTES * 0.9) break;
    try { unlinkSync(join(CACHE_DIR, f)); } catch { /* zaten yok */ }
    cacheIndex.delete(f);
    cacheBytes -= e.size;
  }
}

let active = 0;
const waiters = [];
async function slot(fn) {
  if (active >= UPSTREAM_CONCURRENCY) await new Promise((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw Object.assign(new Error(`Wikimedia ${res.status}`), { status: res.status });
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

// TEST_MODE: Wikimedia'ya gidilmez; yer tutucu görsele kişinin adını/kimliğini içeren sahte EXIF + yorum eklenir
// (testler üst verinin silindiğini uçtan uca doğrular).
let placeholder = null;
function testImage(p) {
  placeholder ??= readFileSync(join(ROOT, 'content', 'baglanti', 'test-placeholder.jpg'));
  const secret = Buffer.from(`Exif\0\0SECRET ${p.q} ${p.n} ${p.img}`, 'utf8');
  const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([placeholder.subarray(0, 2), seg(0xe1, secret), seg(0xfe, Buffer.from(`file=${p.img}`)), placeholder.subarray(2)]);
}

const inflight = new Map();
const failed = new Map(); // dosya -> zaman (kaynakta yok/küçük: bir süre tekrar denenmez)
const FAIL_TTL_MS = 6 * 3600_000;

export function photoBytes(p) {
  const key = createHash('sha1').update(p.img).digest('hex');
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    if (TEST_DATA) return stripImage(testImage(p));
    const ext = /\.png$/i.test(p.img) ? 'png' : 'jpg';
    const type = ext === 'png' ? 'image/png' : 'image/jpeg';
    const name = `${key}.${ext}`;
    const hit = cacheIndex.get(name);
    if (hit) {
      try {
        const body = readFileSync(join(CACHE_DIR, name));
        hit.used = Date.now();
        return { type, body };
      } catch { cacheIndex.delete(name); cacheBytes -= hit.size; }
    }
    if (Date.now() - (failed.get(key) ?? 0) < FAIL_TTL_MS) throw new Error('kaynak yok');
    const url = thumbUrl(p.img);
    if (!url) throw new Error('geçersiz kaynak');
    let raw;
    try { raw = await slot(() => download(url)); } catch (err) {
      if (err.status && err.status !== 429 && err.status < 500) failed.set(key, Date.now());
      throw err;
    }
    const out = stripImage(raw);
    if (out.type !== type) throw new Error('beklenmeyen görsel türü');
    try {
      const tmp = join(CACHE_DIR, `${name}.tmp`);
      writeFileSync(tmp, out.body);
      renameSync(tmp, join(CACHE_DIR, name));
      cacheIndex.set(name, { size: out.body.length, used: Date.now() });
      cacheBytes += out.body.length;
      evict();
    } catch (err) { console.error('baglanti önbelleğe yazılamadı:', err.message); }
    return out;
  })();
  inflight.set(key, job);
  job.finally(() => inflight.delete(key)).catch(() => {});
  return job;
}

const env = (name, def) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : def);
export const photoLimiter = windowCounter(env('LIMIT_PHOTO_PER_MIN', 900), 60_000);

// GET /api/baglanti/photo/<qid>. Kişi açık bilgidir (dizinde var); tarayıcı önbelleğe alabilir.
export async function servePhoto(res, rawQ, ip) {
  const fail = (status) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }); res.end(status === 429 ? 'Çok fazla istek' : 'Yok'); };
  if (!photoLimiter.hit(ip)) return fail(429);
  const p = QID_RE.test(rawQ) ? personOf(rawQ) : null;
  if (!p?.img) return fail(404);
  try {
    const { type, body } = await photoBytes(p);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    return res.end(body);
  } catch {
    return fail(404);
  }
}

export const cacheStats = () => ({ files: cacheIndex.size, bytes: cacheBytes });

// ---------- Yapboz seçimi ----------

const secrets = jsonStore('secrets', {});
const identityStore = jsonStore('identities', {});
if (!secrets.data.baglantiSalt) { secrets.data.baglantiSalt = randomBytes(16).toString('hex'); secrets.flushNow(); }
const SALT = process.env.BAGLANTI_SALT || secrets.data.baglantiSalt;

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

export const cleanDiff = (raw) => (DIFF_IDS.has(str(raw)) ? str(raw) : 'orta');

// Rastgele yapboz (kaçınılacak anahtarlar; yetmezse en eskisinden serbest bırakılır).
export function pickPuzzles(diff, n, rng = cryptoRng(), avoid = []) {
  const pool = PUZZLES[diff] ?? [];
  const avoidList = avoid.filter((k) => typeof k === 'string');
  let banned = new Set(avoidList);
  let cands = pool.filter((z) => !banned.has(z.key));
  for (let drop = 0; cands.length < n && drop < avoidList.length; drop += Math.max(1, n)) {
    banned = new Set(avoidList.slice(drop + n));
    cands = pool.filter((z) => !banned.has(z.key));
  }
  const out = [];
  const used = new Set();
  const list = [...cands];
  while (out.length < n && list.length) {
    const z = list.splice(Math.floor(rng.next() * list.length), 1)[0];
    // Aynı oyunda aynı kişi iki yapbozda uç olmasın
    if (used.has(z.s) || used.has(z.t)) continue;
    used.add(z.s); used.add(z.t);
    out.push(z);
  }
  return out;
}

export const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86_400_000);

// Günün yapbozu: gizli tuzla karıştırılmış havuz sırasından (döngü bitene kadar tekrar yok). Tarih + tuz → hep aynı.
export function dailyPuzzle(date) {
  const pool = [...(PUZZLES[DAILY_DIFF] ?? [])].sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!pool.length) return null;
  const day = dayIndex(date);
  const cycle = Math.floor(day / pool.length);
  const rng = hmacRng(`tosun-baglanti-perm-v1:${cycle}`);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool[((day % pool.length) + pool.length) % pool.length];
}

const days = jsonStore('baglanti-days', {}); // { date: { diff, s, t, path, key } } — gün ilk istendiğinde sabitlenir
const daily = jsonStore('baglanti-daily', {}); // { date: { playerId: { name, run } } }
const seen = jsonStore('baglanti-seen', {}); // { playerId: [puzzleKey…] }
const freeGames = new Map(); // gameId -> { playerId, run, createdAt }

const validPath = (path) => Array.isArray(path) && path.length >= 3 && path.every((q, i) => BY_Q.has(q) && (i === 0 || connected(path[i - 1], q)));

function dayPuzzle(date) {
  let z = days.data[date];
  if (!z || !validPath(z.path)) {
    z = dailyPuzzle(date);
    if (!z) return null;
    days.data[date] = { diff: z.diff, s: z.s, t: z.t, path: z.path, key: z.key };
    days.save();
  }
  return z;
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

// ---------- HTTP uçları (tek oyunculu; server.js kimliği doğrular) ----------

function lookup(identity, mode, rawGameId) {
  if (mode === 'free') {
    const g = freeGames.get(str(rawGameId));
    if (!g || g.playerId !== identity.id) throw new GameError('Oyun bulunamadı, yeni oyun başlat.');
    return { run: g.run, extra: { mode, gameId: str(rawGameId) }, save: () => {} };
  }
  const date = todayIstanbul();
  if (str(rawGameId) !== date) throw new GameError('Günün yapbozu değişti, sayfayı yenile.');
  const rec = daily.data[date]?.[identity.id];
  if (!rec) throw new GameError('Önce oyunu başlat.');
  rec.name = identity.name ?? rec.name;
  return { run: rec.run, extra: { mode, gameId: date, puzzleNo: dayIndex(date) + 1 }, save: () => daily.save() };
}

const out = (run, extra, fb) => ({ ...extra, run: publicRun(run, { reveal: run.done }), fb: fb ?? null });

export function startGame(identity, mode, rawDiff, begin = false) {
  if (!PEOPLE.length) throw new GameError('Kişi verisi hazır değil.');
  const counts = puzzleCounts();
  if (mode === 'free') {
    const diff = cleanDiff(rawDiff);
    const mine = [...freeGames].filter(([, g]) => g.playerId === identity.id);
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - (FREE_PER_PLAYER - 1)))) freeGames.delete(oldId);
    if (freeGames.size >= MAX_FREE_GAMES) prune();
    if (freeGames.size >= MAX_FREE_GAMES) throw new GameError('Sunucu şu an çok yoğun, biraz sonra tekrar dene.');
    const [z] = pickPuzzles(diff, 1, cryptoRng(), seen.data[identity.id] ?? []);
    if (!z) throw new GameError('Bu zorlukta yapboz yok.');
    const list = (seen.data[identity.id] ??= []);
    list.push(z.key);
    if (list.length > SEEN_KEEP) list.splice(0, list.length - SEEN_KEEP);
    seen.save();
    const id = randomUUID();
    const run = newRun(z);
    freeGames.set(id, { playerId: identity.id, run, createdAt: Date.now() });
    return { ...out(run, { mode, gameId: id }), counts };
  }
  const date = todayIstanbul();
  const z = dayPuzzle(date);
  if (!z) throw new GameError('Günün yapbozu hazır değil.');
  const extra = { mode: 'daily', gameId: date, puzzleNo: dayIndex(date) + 1, diff: z.diff, opt: z.path.length - 2, counts };
  const byDate = (daily.data[date] ??= {});
  let rec = byDate[identity.id];
  if (!rec && begin) {
    rec = byDate[identity.id] = { name: identity.name ?? 'Oyuncu', run: newRun(z) };
    daily.save();
  }
  // Başlamadan önce uçlar bile gösterilmez (süre "Başla"ya basınca işler).
  if (!rec) return { ...extra, run: null };
  return { ...extra, ...out(rec.run, extra) };
}

export function step(identity, mode, rawGameId, action, arg) {
  const { run, extra, save } = lookup(identity, mode, rawGameId);
  let fb;
  if (action === 'add') fb = addStep(run, arg);
  else if (action === 'remove') fb = removeStep(run, arg);
  else if (action === 'hint') fb = useHint(run, arg);
  else if (action === 'giveup') fb = giveUp(run);
  else throw new GameError('Bilinmeyen işlem.');
  save();
  return out(run, extra, fb);
}

export function leaderboard(date, viewerId) {
  const day = daily.data[date] ?? {};
  const viewerDone = Boolean(day[viewerId]?.run?.done);
  const done = Object.entries(day).filter(([, e]) => e.run?.done);
  const entries = done.filter(([, e]) => !e.run.gaveUp).map(([id, e]) => {
    const r = runResult(e.run);
    return {
      name: identityStore.data[id]?.name ?? e.name,
      me: id === viewerId,
      fresh: isFreshAccount(identityStore.data[id], date),
      score: r.score,
      steps: r.steps,
      opt: e.run.opt,
      wrong: e.run.wrong,
      hints: e.run.hints.length,
      ms: r.ms,
      // Başkalarının zinciri ancak sen bitirince (yoksa ipucu olur)
      chain: viewerDone ? e.run.chain.map((c) => c.q) : null,
    };
  });
  return {
    date,
    puzzleNo: dayIndex(date) + 1,
    viewerDone,
    entries: rankDaily(entries, (a, b) => b.score - a.score || a.ms - b.ms, BOARD_LIMIT),
    finishers: entries.length,
    gaveUp: done.length - entries.length,
    playing: Object.values(day).filter((e) => e.run && !e.run.done).length,
  };
}

export { todayIstanbul };

// Sadece testler (TEST_GAMES=1 + TEST_MODE=1, /api/_test/secret): bir oyunun en kısa yolu.
export function _testSecrets(rawGameId) {
  const free = freeGames.get(str(rawGameId));
  if (free) return { path: free.run.path };
  const z = dayPuzzle(str(rawGameId));
  return { path: z?.path ?? null };
}
