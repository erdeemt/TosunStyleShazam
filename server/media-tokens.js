// Tek kullanımlık (az kullanımlı) opak medya adresleri: /api/media/<128 bit jeton>.
// Gizli uyaranlar (Nüans hedef PNG'si, Ton Avı Zor WAV'ı, Algıla nokta PNG'si) JSON'a yazılmaz; JSON'da sadece bu adres
// gider. Jeton sahibine (kimlik + lobide oda kodu) bağlı, kısa ömürlü (ezber/gösterim penceresi + pay), sınırlı kullanımlı.
// Toplam jeton sayısı sınırlı (en eskisi atılır), IP başına hız sınırı var. Bkz. PLAN.md §3.4, §4.5–4.7.
import { randomBytes } from 'node:crypto';
import { windowCounter } from './limits.js';

const MAX_TOKENS = Number(process.env.MEDIA_MAX_TOKENS) > 0 ? Number(process.env.MEDIA_MAX_TOKENS) : 5000;
const DEFAULT_USES = 2; // bir kez ağ hatası payı
const RENDER_CACHE_MAX = 16; // aynı uyaran (günlük / aynı oda) için üretilmiş medya
export const MEDIA_TYPES = new Set(['image/png', 'audio/wav']);
export const TOKEN_RE = /^[0-9a-f]{32}$/;

const tokens = new Map(); // jeton -> { owner, room, contentType, render, cacheKey, expiresAt, usesLeft } (ekleme sırası = yaş)
const rendered = new Map(); // cacheKey -> Promise<Buffer>
const limiter = windowCounter(Number(process.env.LIMIT_MEDIA_PER_MIN) > 0 ? Number(process.env.LIMIT_MEDIA_PER_MIN) : 120, 60_000);

function sweep(now = Date.now()) {
  for (const [k, t] of tokens) if (t.expiresAt <= now) tokens.delete(k);
}
setInterval(sweep, 30_000).unref();

// render: () => Buffer | Promise<Buffer> (ilk istekte çağrılır). cacheKey verilirse aynı anahtarlı çıktı paylaşılır.
export function mintMedia({ owner, room = null, contentType, ttlMs, render, cacheKey = null, uses = DEFAULT_USES }) {
  if (!owner || typeof render !== 'function' || !MEDIA_TYPES.has(contentType)) throw new Error('mintMedia: geçersiz');
  if (tokens.size >= MAX_TOKENS) sweep();
  while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value); // en eskisi
  const token = randomBytes(16).toString('hex');
  tokens.set(token, { owner, room, contentType, render, cacheKey, expiresAt: Date.now() + Math.max(500, ttlMs), usesLeft: uses });
  return `/api/media/${token}`;
}

function renderOnce(t) {
  if (!t.cacheKey) return Promise.resolve().then(t.render);
  let p = rendered.get(t.cacheKey);
  if (!p) {
    p = Promise.resolve().then(t.render);
    p.catch(() => rendered.delete(t.cacheKey));
    rendered.set(t.cacheKey, p);
    while (rendered.size > RENDER_CACHE_MAX) rendered.delete(rendered.keys().next().value);
  }
  return p;
}

const sendErr = (res, status, error) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
};

// server.js çağırır: identity doğrulanmış kimlik ya da null. Yanlış sahip → 403; yok/süresi geçmiş/bitmiş → 404.
export async function serveMedia(res, rawToken, identity, ip) {
  if (!limiter.hit(ip)) return sendErr(res, 429, 'Çok fazla istek, biraz yavaşla.');
  const token = TOKEN_RE.test(String(rawToken)) ? rawToken : null;
  const t = token ? tokens.get(token) : null;
  if (!t || t.expiresAt <= Date.now() || t.usesLeft <= 0) {
    if (t) tokens.delete(token);
    return sendErr(res, 404, 'Süresi geçti.');
  }
  if (!identity || identity.id !== t.owner || (t.room && identity.roomCode !== t.room)) return sendErr(res, 403, 'Bu sana ait değil.');
  t.usesLeft--;
  if (t.usesLeft <= 0) tokens.delete(token);
  let body;
  try {
    body = await renderOnce(t);
  } catch (err) {
    console.error('medya üretilemedi:', err);
    return sendErr(res, 500, 'Medya üretilemedi.');
  }
  res.writeHead(200, {
    'Content-Type': t.contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
}

export const mediaStats = () => ({ tokens: tokens.size, rendered: rendered.size });
