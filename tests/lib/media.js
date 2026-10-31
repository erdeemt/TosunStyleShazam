// Testler için: gizli medya (opak /api/media/<jeton>) indirme, PNG/WAV çözme ve TEST_GAMES'e özel gizli veri.
import { inflateSync } from 'node:zlib';

// Sunucunun gizli hedef/uyaranları (sadece TEST_GAMES=1): { room } | { recall, gameId } | { gameId } (Algıla).
export async function secret(srv, params) {
  const res = await fetch(`${srv.url}/api/_test/secret?${new URLSearchParams(params)}`);
  return res.json();
}

// Medya isteği: { status, type, cache, body: Buffer }
export async function fetchMedia(srv, url, who) {
  const res = await fetch(srv.url + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: who?.playerId, token: who?.token }),
  });
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    cache: res.headers.get('cache-control'),
    nosniff: res.headers.get('x-content-type-options'),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Basit PNG çözücü (8 bit, filtre 0 — sunucunun ürettiği biçim). CRC'leri de doğrular.
export function decodePng(buf, crc32) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('PNG imzası yok');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  const types = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    if (crc32 && crc32(buf.subarray(pos + 4, pos + 8 + len)) !== crc) throw new Error(`${type} CRC hatalı`);
    types.push(type);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = CHANNELS[ihdr.colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * ch;
  if (raw.length !== (stride + 1) * ihdr.height) throw new Error('çözülen boy uymuyor');
  const pixels = Buffer.alloc(stride * ihdr.height);
  for (let y = 0; y < ihdr.height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('beklenmeyen filtre');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { ...ihdr, channels: ch, pixels, types };
}

// Gri+alfa nokta görselinin bir karesindeki ayrık nokta sayısı (alfa > 127 bağlı bileşenleri).
export function countBlobs(img, frame = 0) {
  const { width: w, channels: ch } = img;
  const h = w; // kareler kare biçimli, alt alta
  const off = frame * w * h;
  const seen = new Uint8Array(w * h);
  const on = (i) => img.pixels[(off + i) * ch + ch - 1] > 127;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !on(i)) continue;
    n++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!seen[k] && on(k)) { seen[k] = 1; stack.push(k); }
      }
    }
  }
  return n;
}

export function parseWav(buf) {
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    rate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
    samples: new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length)),
  };
}

// Sıfır geçişlerinden frekans tahmini (test: WAV gerçekten hedef perdede mi)
export function estimateFreq(wav) {
  const s = wav.samples;
  let crossings = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings++;
  return crossings / (s.length / wav.rate);
}

// JSON içinde anahtar (her derinlikte) var mı
export function hasKey(obj, keys) {
  const want = new Set(keys);
  const walk = (o) => {
    if (!o || typeof o !== 'object') return false;
    for (const [k, v] of Object.entries(o)) if (want.has(k) || walk(v)) return true;
    return false;
  };
  return walk(obj);
}
