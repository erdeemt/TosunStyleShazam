// Tosun Style sunucusu: statik dosyalar, müzik linki çözümleme (Shazam), günlük bulmacalar ve WebSocket lobi.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachLobby, resolveIdentity, verifyIdentity } from './server/lobby.js';
import * as wordle from './server/wordle.js';
import { GameError } from './server/errors.js';
import { clientIp, httpLimiter, upstreamLimiter } from './server/limits.js';

const PORT = process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- Spotify (embed sayfası, giriş gerektirmez) ----------

async function spotifyEmbed(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new GameError(res.status === 404 ? "Spotify'da bulunamadı (gizli olabilir)." : 'Spotify şu an yanıt vermiyor.');
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new GameError('Spotify sayfası okunamadı.');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new GameError('Spotify içeriği bulunamadı.');
  return entity;
}

const pickImage = (vi) => {
  const imgs = vi?.image ?? [];
  return imgs.sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0]?.url ?? null;
};

async function resolveSpotify(type, id) {
  const e = await spotifyEmbed(type, id);
  if (type === 'track') {
    return {
      name: e.name,
      tracks: [{
        id: `sp:${e.id}`,
        spotifyId: e.id,
        title: e.name,
        artist: (e.artists ?? []).map((a) => a.name).join(', '),
        audio: e.audioPreview?.url ?? null,
        cover: pickImage(e.visualIdentity),
      }],
    };
  }
  const cover = pickImage(e.visualIdentity);
  return {
    name: e.name,
    tracks: (e.trackList ?? []).map((t) => {
      const spotifyId = t.uri?.split(':').pop();
      return {
        id: `sp:${spotifyId}`,
        spotifyId,
        title: t.title,
        artist: t.subtitle,
        audio: t.audioPreview?.url ?? null,
        // Playlist öğelerinde kapak yok; albümde albüm kapağı doğru, playlist'te tur sonunda çekilir.
        cover: type === 'album' ? cover : null,
      };
    }),
  };
}

// ---------- Deezer (açık API, 30 sn önizleme) ----------

const deezerTrack = (t) => ({
  id: `dz:${t.id}`,
  title: t.title,
  artist: t.artist?.name ?? '',
  audio: t.preview || null,
  cover: t.album?.cover_xl ?? t.album?.cover_big ?? null,
});

async function deezer(path) {
  const res = await fetch(`https://api.deezer.com/${path}`);
  const j = await res.json();
  if (j.error) throw new GameError("Deezer'da bulunamadı.");
  return j;
}

async function resolveDeezer(type, id) {
  if (type === 'track') {
    const t = await deezer(`track/${id}`);
    return { name: t.title, tracks: [deezerTrack(t)] };
  }
  const info = await deezer(`${type}/${id}`);
  const tracks = [];
  let next = `${type}/${id}/tracks?limit=100`;
  while (next && tracks.length < 1000) {
    const page = await deezer(next);
    for (const t of page.data ?? []) {
      // Albüm sayfasındaki şarkılarda albüm bilgisi gelmiyor.
      if (!t.album && info.cover_xl) t.album = { cover_xl: info.cover_xl };
      tracks.push(deezerTrack(t));
    }
    next = page.next ? page.next.replace('https://api.deezer.com/', '') : null;
  }
  return { name: info.title, tracks };
}

async function deezerSearch(q) {
  const j = await deezer(`search?limit=1&q=${encodeURIComponent(q)}`);
  return j.data?.[0] ? deezerTrack(j.data[0]) : null;
}

// ---------- YouTube (oEmbed; playlist ID'leri tarayıcıdaki oynatıcıdan gelir) ----------

const NOISE = /\s*[([【][^)\]】]*(official|video|audio|lyric|klip|clip|music|hd|4k|remaster|visuali[sz]er|live|canlı|akustik|acoustic)[^)\]】]*[)\]】]/gi;

// Parantezsiz sondaki ekler: "... Official Music Video", "... M/V", "... Performance Video"
const TRAILING_NOISE = /\s*(official\s+)?(music\s+|lyric\s+|performance\s+|dance\s+)?(video|audio|mv|m\/v|klip|clip|visuali[sz]er)\s*$/i;

function parseYoutubeTitle(rawTitle, author) {
  const cleaned = rawTitle.replace(NOISE, '').replace(TRAILING_NOISE, '').replace(/\s{2,}/g, ' ').trim();
  const channel = (author ?? '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*official$/i, '').trim();
  // K-pop kalıbı: SANATÇI 'Şarkı' → tırnak içi şarkı adıdır.
  const quoted = cleaned.match(/^(.+?)\s+['‘’"“”]([^'‘’"“”]+)['‘’"“”]\s*$/);
  if (quoted) return { artist: quoted[1].trim(), title: quoted[2].trim(), alt: [quoted[2].trim(), cleaned] };
  const parts = cleaned.split(/\s+[-–—|]\s+/);
  if (parts.length >= 2) {
    const title = parts.slice(1).join(' - ').trim();
    // Sanatçı tek başına doğru cevap sayılmasın; tam başlık da kabul edilsin.
    return { artist: parts[0].trim(), title, alt: [title, cleaned] };
  }
  return { artist: channel, title: cleaned, alt: [cleaned] };
}

const ytCache = new Map(); // videoId -> meta | null
const YT_CACHE_MAX = 5000;

async function youtubeMeta(videoId) {
  if (!/^[w-]{6,20}$/.test(videoId)) return null;
  if (ytCache.has(videoId)) return ytCache.get(videoId);
  const meta = await youtubeMetaUncached(videoId);
  if (ytCache.size >= YT_CACHE_MAX) ytCache.delete(ytCache.keys().next().value);
  ytCache.set(videoId, meta);
  return meta;
}

async function youtubeMetaUncached(videoId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null; // gizli / silinmiş / gömülemez
  const j = await res.json();
  const parsed = parseYoutubeTitle(j.title ?? '', j.author_name);
  return {
    id: `yt:${videoId}`,
    ytId: videoId,
    title: parsed.title,
    artist: parsed.artist,
    alt: parsed.alt,
    rawTitle: j.title,
    cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Link çözümleme ----------

function parseLink(raw) {
  const input = raw.trim();
  let m;
  if ((m = input.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)/))) return { src: 'spotify', type: m[1], id: m[2] };

  let u;
  try { u = new URL(input); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');

  if (host === 'open.spotify.com') {
    m = u.pathname.match(/\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (m) return { src: 'spotify', type: m[1], id: m[2] };
  }
  if (host.endsWith('deezer.com')) {
    m = u.pathname.match(/\/(track|album|playlist)\/(\d+)/);
    if (m) return { src: 'deezer', type: m[1], id: m[2] };
  }
  if (host === 'youtu.be') {
    const v = u.pathname.slice(1).split('/')[0];
    if (v) return { src: 'youtube', type: 'video', id: v };
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    // RD... otomatik "mix" listeleri, oynatıcı bunları tutarlı açamıyor → tek video gibi davran.
    if (list && !list.startsWith('RD')) return { src: 'youtube', type: 'playlist', id: list };
    const v = u.searchParams.get('v') ?? u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1];
    if (v) return { src: 'youtube', type: 'video', id: v };
  }
  return null;
}

async function resolve(rawUrl) {
  const link = parseLink(rawUrl);
  if (!link) throw new GameError('Tanınmayan link. Spotify, YouTube veya Deezer linki gir.');
  if (link.src === 'spotify') return resolveSpotify(link.type, link.id);
  if (link.src === 'deezer') return resolveDeezer(link.type, link.id);
  if (link.type === 'playlist') {
    const playlistUrl = `https://www.youtube.com/playlist?list=${link.id}`;
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(playlistUrl)}`, { headers: { 'User-Agent': UA } })
      .catch(() => null);
    const name = res?.ok ? (await res.json()).title : null;
    return { youtubePlaylist: link.id, name };
  }
  const t = await youtubeMeta(link.id);
  if (!t) throw new GameError('YouTube videosu bulunamadı (gizli veya silinmiş olabilir).');
  return { name: t.rawTitle, tracks: [t] };
}

// ---------- HTTP ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 2048;

// Küçük JSON gövdeleri (günlük bulmaca uçları). Sınırı aşan istek kesilir.
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(new GameError('POST bekleniyor.'));
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume(); // gövdeyi okumadan at; yanıt gönderilince bağlantı kapanır
      return reject(new GameError('İstek çok büyük.'));
    }
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES * 32) return req.destroy(); // durmayan gönderici
      if (size > MAX_BODY_BYTES) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new GameError('İstek çok büyük.'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new GameError('Geçersiz istek.')); }
    });
    req.on('error', () => reject(new GameError('Geçersiz istek.')));
  });
}

function requireIdentity(body) {
  const identity = verifyIdentity(body.playerId, body.token);
  if (!identity) throw new GameError('Kimlik doğrulanamadı, sayfayı yenile.');
  return identity;
}

const UPSTREAM_PATHS = new Set(['/api/resolve', '/api/yt-meta', '/api/deezer-search', '/api/spotify-cover']);

async function handleApi(url, res, req) {
  const q = url.searchParams;
  const ip = clientIp(req);
  if (!httpLimiter.hit(ip)) return sendJson(res, 429, { error: 'Çok fazla istek, biraz yavaşla.' });
  if (UPSTREAM_PATHS.has(url.pathname) && !upstreamLimiter.hit(ip)) {
    return sendJson(res, 429, { error: 'Çok fazla link isteği, bir dakika sonra tekrar dene.' });
  }
  switch (url.pathname) {
    // ---------- Kimlik + günlük bulmacalar ----------
    case '/api/identity': {
      const body = await readJson(req);
      const identity = resolveIdentity({ playerId: body.playerId, token: body.token, name: body.name }, ip);
      return sendJson(res, 200, { playerId: identity.id, token: identity.token, name: identity.name });
    }
    case '/api/wordle/start': {
      const body = await readJson(req);
      return sendJson(res, 200, wordle.startGame(requireIdentity(body), body.mode === 'free' ? 'free' : 'daily'));
    }
    case '/api/wordle/guess': {
      const body = await readJson(req);
      return sendJson(res, 200, wordle.guess(requireIdentity(body), body.mode === 'free' ? 'free' : 'daily', body.gameId, body.word));
    }
    case '/api/wordle/leaderboard': {
      const body = await readJson(req);
      const identity = requireIdentity(body);
      return sendJson(res, 200, wordle.leaderboard(wordle.todayIstanbul(), identity.id));
    }
    // ---------- Müzik kaynakları (Shazam) ----------
    case '/api/resolve':
      return sendJson(res, 200, await resolve(q.get('url') ?? ''));
    case '/api/yt-meta': {
      const ids = (q.get('ids') ?? '').split(',').filter(Boolean).slice(0, 50);
      const tracks = (await mapLimit(ids, 8, youtubeMeta)).filter(Boolean);
      return sendJson(res, 200, { tracks });
    }
    case '/api/deezer-search':
      return sendJson(res, 200, { track: await deezerSearch(q.get('q') ?? '') });
    case '/api/spotify-cover': {
      const id = q.get('id') ?? '';
      if (!/^[A-Za-z0-9]{10,30}$/.test(id)) throw new GameError('Geçersiz şarkı.');
      const e = await spotifyEmbed('track', id);
      return sendJson(res, 200, { cover: pickImage(e.visualIdentity) });
    }
    default:
      return sendJson(res, 404, { error: 'Bulunamadı' });
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Bulunamadı');
  }
}

// YouTube iframe API, Google Fonts, müzik kapakları/önizlemeleri (https) dışında dış kaynak yok.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // YouTube gömme için referrer gerekli
  let url;
  try {
    url = new URL(req.url, 'http://localhost'); // Host başlığına güvenme
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (!url.pathname.startsWith('/api/')) res.setHeader('Content-Security-Policy', CSP);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(url, res, req);
    else await serveStatic(url.pathname, res);
  } catch (err) {
    if (!(err instanceof GameError)) console.error(`${req.method} ${url.pathname} hatası:`, err);
    if (!res.headersSent) sendJson(res, 400, { error: err instanceof GameError ? err.message : 'İstek işlenemedi, tekrar dene.' });
  }
});

// Yavaş istemcilerle bağlantı tüketilmesin.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;

attachLobby(server);

// Beklenmeyen bir hata tek bir isteği düşürsün, tüm sunucuyu değil.
process.on('uncaughtException', (err) => console.error('Yakalanmamış hata:', err));
process.on('unhandledRejection', (err) => console.error('Yakalanmamış söz (promise):', err));

// PORT=0 → işletim sistemi boş bir port seçer (testler bunu kullanır, gerçek portu stdout'tan okur).
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Tosun Style → http://localhost:${server.address().port}`);
});
