// 🎵 Shazam online: ses vekili (proxy). İstemci şarkının kimliğini (YouTube kimliği, CDN önizleme adresi) HİÇ görmez;
// her oyuncuya, her adım için tek kullanımlık-benzeri opak bir adres verilir: /api/clip/<128 bit rastgele>.
// - Sunucu önizlemeyi izinli CDN'den kendisi indirir (SSRF yok: sadece sabit alan adları, https, yönlendirme de denetlenir),
//   bellekte tutar (parça başına ≤ 1.5 MB, genel LRU sınırı) ve sadece o adımın süresi kadar MP3 çerçevesi gönderir.
// - Adres oyuncuya bağlıdır: istekte imzalı, HttpOnly bir çerez (tss_clip, POST /api/clip-session ile kimlik+token
//   karşılığında verilir) aynı oyuncuyu göstermiyorsa 403. Başkasıyla paylaşılan adres işe yaramaz.
// - Adres tur bitince (açılış) / sonraki turda geçersizleşir; ayrıca mutlak süre sınırı var.
// Bkz. PLAN.md §4.4 "Ses vekili".
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cutMp3, parseMp3, synthMp3 } from './mp3.js';
import { windowCounter } from './limits.js';

export const AUDIO_HOSTS = [/^p\.scdn\.co$/, /^cdnt-preview\.dzcdn\.net$/, /^cdns-preview-[a-z0-9]\.dzcdn\.net$/];

const env = (name, def) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : def);
export const CLIP_LIMITS = {
  maxTrackBytes: 1_500_000, // tek önizleme (30 sn × 320 kbps ≈ 1.2 MB)
  maxCacheBytes: env('CLIP_CACHE_BYTES', 48_000_000), // tüm odalar toplamı (LRU)
  maxCacheEntries: 64,
  upstreamTimeoutMs: 10_000,
  maxConcurrentFetches: 6,
  failTtlMs: 60_000, // indirilemeyen önizleme bu kadar süre tekrar denenmez
  tokenTtlMs: 15 * 60_000, // tur sonunda iptal edilmezse (oda silindi vb.) en geç bu kadar sonra geçersiz
  maxTokens: 20_000,
  sessionTtlSec: 12 * 3600,
  perIpPerMinute: env('LIMIT_CLIP_PER_MIN', 900), // aynı evdeki 12 telefon, Safari'nin Range istekleri
  perPlayerPerMinute: env('LIMIT_CLIP_PER_PLAYER_PER_MIN', 120),
};

const ipLimiter = windowCounter(CLIP_LIMITS.perIpPerMinute, 60_000);
const playerLimiter = windowCounter(CLIP_LIMITS.perPlayerPerMinute, 60_000);

// Test sunucusunda (TEST_MODE=1) dış ağa çıkılmaz: izinli adres için deterministik sentetik MP3 üretilir.
// Adres yolunda "yok" geçiyorsa 404 taklidi (yüklenemeyen şarkı testleri).
const FAKE_UPSTREAM = process.env.TEST_MODE === '1' && process.env.CLIP_REAL_UPSTREAM !== '1';

export function allowedAudioUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 600) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.port) return null;
    return u.protocol === 'https:' && AUDIO_HOSTS.some((re) => re.test(u.hostname)) ? u : null;
  } catch {
    return null;
  }
}

// ---------- Yukarı akış önbelleği ----------

const cache = new Map(); // src -> { buf, parsed, bytes } | { failedAt } | { pending: Promise }  (Map sırası = LRU)
let cacheBytes = 0;
let active = 0;
const queue = [];

function touch(src, entry) { cache.delete(src); cache.set(src, entry); }

function evict() {
  for (const [src, e] of cache) {
    if (cacheBytes <= CLIP_LIMITS.maxCacheBytes && cache.size <= CLIP_LIMITS.maxCacheEntries) break;
    if (e.pending) continue;
    cache.delete(src);
    cacheBytes -= e.bytes ?? 0;
  }
}

async function withSlot(fn) {
  if (active >= CLIP_LIMITS.maxConcurrentFetches) await new Promise((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

class UpstreamError extends Error {}

async function readCapped(res, cap) {
  const len = Number(res.headers.get('content-length'));
  if (len > cap) throw new UpstreamError('çok büyük');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > cap) throw new UpstreamError('çok büyük');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchUpstream(src) {
  if (FAKE_UPSTREAM) {
    if (/yok/.test(new URL(src).pathname)) throw new UpstreamError('404');
    return synthMp3({ seconds: 30, id3: 64, xing: true });
  }
  let url = allowedAudioUrl(src);
  // Yönlendirmeler elle izlenir: her adımda alan adı yeniden denetlenir (izinli CDN başka yere yönlendiremesin).
  for (let hop = 0; hop < 3 && url; hop++) {
    const res = await fetch(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CLIP_LIMITS.upstreamTimeoutMs),
      headers: { Accept: 'audio/mpeg,audio/*;q=0.9', 'User-Agent': 'Mozilla/5.0 TosunStyle' },
    });
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel().catch(() => {});
      url = allowedAudioUrl(new URL(res.headers.get('location') ?? '', url).href);
      continue;
    }
    if (res.status !== 200) { res.body?.cancel().catch(() => {}); throw new UpstreamError(String(res.status)); }
    const type = String(res.headers.get('content-type') ?? '').toLowerCase();
    if (type && !/^(audio\/|application\/octet-stream|binary\/octet-stream)/.test(type)) {
      res.body?.cancel().catch(() => {});
      throw new UpstreamError('ses değil');
    }
    return readCapped(res, CLIP_LIMITS.maxTrackBytes);
  }
  throw new UpstreamError('yönlendirme');
}

// Önizlemeyi indir + ayrıştır (eşzamanlı istekler tek indirmeyi paylaşır). Döner { buf, parsed } veya null.
export function loadTrack(src) {
  const e = cache.get(src);
  if (e?.buf) { touch(src, e); return Promise.resolve(e); }
  if (e?.pending) return e.pending;
  if (e?.failedAt && Date.now() - e.failedAt < CLIP_LIMITS.failTtlMs) return Promise.resolve(null);
  if (!allowedAudioUrl(src)) return Promise.resolve(null);
  const pending = withSlot(() => fetchUpstream(src))
    .then((buf) => {
      const parsed = parseMp3(buf);
      if (!parsed) throw new UpstreamError('MP3 değil');
      const entry = { buf, parsed, bytes: buf.length };
      cache.set(src, entry);
      cacheBytes += entry.bytes;
      evict();
      return entry;
    })
    .catch(() => {
      cache.set(src, { failedAt: Date.now() });
      evict();
      return null;
    });
  cache.set(src, { pending });
  return pending;
}

// Turun başında arka planda indir (oyuncu 3-2-1 sayarken hazır olsun).
export function prefetch(src) { if (src) loadTrack(src); }

// ---------- Belirteçler (token) ----------

const tokens = new Map(); // token -> { playerId, group, src, startFraction, lastStage, dur, exp, clip }
const groups = new Map(); // group -> Set(token)

function sweep() {
  const now = Date.now();
  for (const [t, rec] of tokens) if (rec.exp <= now) dropToken(t);
}
setInterval(sweep, 60_000).unref();

function dropToken(t) {
  const rec = tokens.get(t);
  if (!rec) return;
  tokens.delete(t);
  const g = groups.get(rec.group);
  g?.delete(t);
  if (g && !g.size) groups.delete(rec.group);
}

// Bir oyuncu için bir klip adresi üret. dur: saniye (adım süresi) veya Infinity (açılış: başlangıçtan sona).
// group: aynı anda iptal edilecek belirteçler (ör. "<oyun>:<tur>:play").
export function issueClip({ group, playerId, src, startFraction, lastStage, dur }) {
  if (tokens.size >= CLIP_LIMITS.maxTokens) sweep();
  if (tokens.size >= CLIP_LIMITS.maxTokens) dropToken(tokens.keys().next().value); // en eski
  const token = randomBytes(16).toString('base64url'); // 128 bit
  tokens.set(token, { playerId, group, src, startFraction, lastStage, dur, exp: Date.now() + CLIP_LIMITS.tokenTtlMs, clip: null });
  if (!groups.has(group)) groups.set(group, new Set());
  groups.get(group).add(token);
  return `/api/clip/${token}`;
}

export function revokeGroup(group) {
  for (const t of [...(groups.get(group) ?? [])]) dropToken(t);
}

export function revokePlayer(groupPrefix, playerId) {
  for (const [g, set] of groups) {
    if (!g.startsWith(groupPrefix)) continue;
    for (const t of [...set]) if (tokens.get(t)?.playerId === playerId) dropToken(t);
  }
}

export const clipStats = () => ({ tokens: tokens.size, cacheEntries: cache.size, cacheBytes });

// ---------- Oturum çerezi (oyuncu kimliğine bağlama) ----------

const SECRET = randomBytes(32);
const COOKIE = 'tss_clip';
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url');

export function sessionCookie(playerId, secure) {
  const exp = Math.floor(Date.now() / 1000) + CLIP_LIMITS.sessionTtlSec;
  const value = `${playerId}.${exp}.${sign(`${playerId}.${exp}`)}`;
  return `${COOKIE}=${value}; Path=/api/clip; Max-Age=${CLIP_LIMITS.sessionTtlSec}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function sessionPlayer(req) {
  const raw = String(req.headers.cookie ?? '');
  const m = raw.match(/(?:^|;\s*)tss_clip=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const [pid, exp, mac] = parts;
  if (!/^[\w-]{1,64}$/.test(pid) || !/^\d{1,12}$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
  const want = Buffer.from(sign(`${pid}.${exp}`));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? pid : null;
}

// ---------- HTTP: GET/HEAD /api/clip/<token> ----------

function plain(res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

// Tek aralık (Safari <audio> önce "bytes=0-1" ister ve 206 bekler). Çoklu aralık → yok sayılır (tamamı, 200).
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return String(header).includes(',') ? null : 'bad';
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return 'bad';
  if (m[1] === '') { // son N bayt
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'bad';
  return { start, end };
}

export async function handleClip(req, res, token, ip) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'GET bekleniyor', { Allow: 'GET, HEAD' });
  if (!ipLimiter.hit(ip)) return plain(res, 429, 'Çok fazla istek');
  const playerId = sessionPlayer(req);
  if (!playerId) return plain(res, 403, 'Oturum yok');
  if (!playerLimiter.hit(playerId)) return plain(res, 429, 'Çok fazla istek');
  if (!/^[\w-]{22}$/.test(token)) return plain(res, 404, 'Bulunamadı');
  const rec = tokens.get(token);
  if (!rec || rec.exp <= Date.now()) return plain(res, 404, 'Bulunamadı');
  if (rec.playerId !== playerId) return plain(res, 403, 'Bu klip senin değil');

  if (!rec.clip) {
    const track = await loadTrack(rec.src);
    if (!track) return plain(res, 502, 'Önizleme alınamadı');
    if (!tokens.has(token)) return plain(res, 404, 'Bulunamadı'); // indirirken tur bitti
    const { parsed } = track;
    const f = rec.startFraction;
    // Herkes aynı noktadan: son adımın tamamı önizlemeye sığsın (istemcinin eski hesabıyla aynı).
    const start = f == null ? 0 : f * Math.max(0, parsed.duration - rec.lastStage - 0.5);
    rec.clip = cutMp3(track.buf, parsed, start, rec.dur);
  }
  const body = rec.clip;
  const headers = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': 'inline; filename="klip.mp3"',
  };
  const range = parseRange(req.headers.range, body.length);
  if (range === 'bad') return plain(res, 416, 'Geçersiz aralık', { 'Content-Range': `bytes */${body.length}` });
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`, 'Content-Length': range.end - range.start + 1 });
    return res.end(req.method === 'HEAD' ? undefined : body.subarray(range.start, range.end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  return res.end(req.method === 'HEAD' ? undefined : body);
}
