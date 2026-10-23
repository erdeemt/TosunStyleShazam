// IP başına kötüye kullanım sınırları (HTTP + WebSocket). Varsayılanlar arkadaş ortamı için rahat,
// internete açılınca tek kişinin sunucuyu kilitlemesini engelleyecek kadar sıkı. Testler ortam değişkeniyle gevşetir.
const env = (name, def) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : def);

export const IP_LIMITS = {
  httpPerMinute: env('LIMIT_HTTP_PER_MIN', 240), // /api/* istekleri
  upstreamPerMinute: env('LIMIT_UPSTREAM_PER_MIN', 30), // dış servise giden müzik uçları
  newIdentitiesPerHour: env('LIMIT_IDENTITIES_PER_HOUR', 30),
  socketsPerIp: env('LIMIT_SOCKETS_PER_IP', 30), // aynı evdeki telefonlar aynı IP'den gelebilir
  roomsPerIp: env('LIMIT_ROOMS_PER_IP', 10),
};

// Sabit pencereli sayaç: hit(key) false dönerse sınır aşıldı.
export function windowCounter(limit, windowMs) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.start > windowMs) buckets.delete(k);
  }, windowMs).unref();
  return {
    hit(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
      b.count++;
      return b.count <= limit;
    },
    stop: () => clearInterval(sweep),
  };
}

export const httpLimiter = windowCounter(IP_LIMITS.httpPerMinute, 60_000);
export const upstreamLimiter = windowCounter(IP_LIMITS.upstreamPerMinute, 60_000);
export const identityLimiter = windowCounter(IP_LIMITS.newIdentitiesPerHour, 3_600_000);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Sınır anahtarı: IPv4 olduğu gibi; IPv6 /64 ağına indirgenir (bir ev/hat genelde tüm /64'e sahip — tek tek adreslerle
// sınırlar sonsuz kez atlatılmasın). IPv4-mapped (::ffff:1.2.3.4) IPv4'e çevrilir.
export function ipKey(ip) {
  let s = String(ip ?? '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (!s.includes(':')) return s || 'unknown';
  s = s.split('%')[0]; // bölge kimliği (fe80::1%eth0)
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail != null && tail !== '' ? tail.split(':') : [];
  const groups = tail != null ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

// Gerçek istemci IP'si. Bağlantı aynı makinedeki bir tünel/vekilden geliyorsa (cloudflared, nginx, Caddy → loopback)
// iletilen başlıklara güvenilir; dışarıdan doğrudan gelen bağlantıda başlıklar yok sayılır (sahte başlıkla sınır atlatılamaz).
// Başka makinedeki bir vekil için TRUST_PROXY=1.
export function clientIp(req) {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(remote) && process.env.TRUST_PROXY !== '1') return ipKey(remote);
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim(); // Cloudflare Tunnel: gerçek ziyaretçi
  if (cf) return ipKey(cf);
  // nginx/Caddy/Cloudflare gelen başlığın SONUNA istemcinin adresini ekler; baştaki öğeler istemci tarafından yazılabilir.
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
  return ipKey(fwd || remote);
}

