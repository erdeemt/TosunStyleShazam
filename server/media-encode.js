// Bağımlılıksız küçük medya kodlayıcıları: PNG (zlib + CRC32) ve WAV (PCM16 mono).
// Gizli cevapları (Nüans hedef rengi, Ton Avı Zor perdesi, Algıla noktaları) JSON yerine medya olarak göndermek için.
// Bkz. PLAN.md §4.5–4.7 "Gizli uyaran medyası".
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { hexToRgb } from '../public/recall-math.js';
import { dotAt } from '../public/perceptle-math.js';

const deflateAsync = promisify(deflate);

// ---------- CRC32 (PNG parçaları) ----------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- PNG ----------

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// pixels: Uint8Array, satır satır, kanal sayısı = channels (2 = gri+alfa, 3 = RGB, 4 = RGBA). 8 bit, filtre 0, taramasız.
export async function encodePng(width, height, pixels, channels = 4) {
  const COLOR_TYPE = { 2: 4, 3: 2, 4: 6 };
  if (!COLOR_TYPE[channels]) throw new Error('kanal 2, 3 ya da 4 olmalı');
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new Error('piksel boyu uymuyor');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtre: yok
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit derinliği
  ihdr[9] = COLOR_TYPE[channels]; // renk tipi: gri+alfa / RGB / RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await deflateAsync(raw, { level: 6 });
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- WAV ----------

// samples: Int16Array (mono). 44 baytlık standart RIFF başlığı.
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt parça boyu
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // bayt/sn
  buf.writeUInt16LE(2, 32); // blok hizası
  buf.writeUInt16LE(16, 34); // bit/örnek
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

// ---------- Oyun görselleri / sesleri ----------

export const TONE_RATE = 22050;
export const TONE_AMPLITUDE = 0.9; // istemci kazancı buna göre (tss:volume ile) ayarlar
const FADE_S = 0.03;

// Ton Avı hedefi: sinüs, 30 ms doğrusal açılış/kapanış (osilatördeki rampayla aynı), mono 22050 Hz.
export function toneWav(freq, ms) {
  const n = Math.max(Math.round((Math.max(100, ms) / 1000) * TONE_RATE), 2);
  const fade = Math.min(Math.round(FADE_S * TONE_RATE), Math.floor(n / 2));
  const out = new Int16Array(n);
  const w = (2 * Math.PI * freq) / TONE_RATE;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = Math.round(Math.sin(w * i) * env * TONE_AMPLITUDE * 32767);
  }
  return encodeWav(out, TONE_RATE);
}

export const NUANCE_SIZE = 64;
export const NUANCE_NOISE = 3; // her kanalda ±3 (eyedropper yaklaşık değer verir)

// Nüans hedefi: düz renk + piksel başına küçük gürültü (her istekte yeni tohum).
export function nuancePng(hex, { size = NUANCE_SIZE, noise = NUANCE_NOISE } = {}) {
  const base = hexToRgb(hex);
  const px = new Uint8Array(size * size * 3);
  const rnd = randomBytes(px.length);
  const span = 2 * noise + 1;
  for (let i = 0; i < px.length; i++) {
    const v = base[i % 3] + (rnd[i] % span) - noise;
    px[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return encodePng(size, size, px, 3);
}

// Algıla "Say" noktaları: şeffaf zemin üzerine kenarı yumuşatılmış beyaz daireler (gri+alfa; istemci INK rengine boyar).
// Cuma (hareketli): frames kare alt alta tek bir PNG şeridinde (sprite sheet), kare i = i / fps saniye.
export const COUNT_IMAGE = { still: { size: 640, frames: 1, fps: 0 }, moving: { size: 320, fps: 15 } };

export function countFrames(friday, showMs) {
  if (!friday) return { ...COUNT_IMAGE.still };
  const { size, fps } = COUNT_IMAGE.moving;
  return { size, fps, frames: Math.floor((showMs / 1000) * fps) + 1 };
}

export function dotsPng(dots, { size, frames, fps }) {
  const px = new Uint8Array(size * size * 2 * frames);
  for (let f = 0; f < frames; f++) {
    const t = fps ? f / fps : 0;
    const base = f * size * size * 2;
    for (const d of dots) {
      const [ux, uy] = dotAt(d, t);
      const cx = ux * size;
      const cy = uy * size;
      const R = d[2] * size;
      const x0 = Math.max(0, Math.floor(cx - R - 1));
      const x1 = Math.min(size - 1, Math.ceil(cx + R + 1));
      const y0 = Math.max(0, Math.floor(cy - R - 1));
      const y1 = Math.min(size - 1, Math.ceil(cy + R + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const cover = R - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5; // kenar yumuşatma (1 px)
          if (cover <= 0) continue;
          const a = Math.round(Math.min(1, cover) * 255);
          const i = base + (y * size + x) * 2;
          if (a <= px[i + 1]) continue;
          px[i] = 255;
          px[i + 1] = a;
        }
      }
    }
  }
  return encodePng(size, size * frames, px, 2);
}
