// Bağımlılıksız MP3 (MPEG-1/2/2.5 Layer III) çerçeve ayrıştırıcı + kesici. Shazam online modunda sunucu önizlemeyi
// kendisi indirir ve istemciye sadece o adımın süresi kadar çerçeve gönderir (tam önizleme açılıştan önce gitmez).
// Çerçeve sınırında kesildiği için çıktı geçerli bir MP3 akışıdır; ID3v2 etiketi ve Xing/Info/VBRI çerçevesi atlanır.

// kbps, bitrate indeksi 1..14 (0 = serbest biçim, 15 = geçersiz; ikisi de desteklenmez)
const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// Sürüm bitleri: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 (1 ayrılmış)
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// off konumundaki 4 baytlık başlığı çöz; geçerli bir Layer III başlığı değilse null.
export function parseHeader(buf, off) {
  if (off < 0 || off + 4 > buf.length) return null;
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const b3 = buf[off + 3];
  if (buf[off] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (version === 1 || layer !== 1) return null; // sadece Layer III
  const brIndex = b2 >> 4;
  const srIndex = (b2 >> 2) & 3;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATE_V1 : BITRATE_V2)[brIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIndex];
  const padding = (b2 >> 1) & 1;
  const mono = b3 >> 6 === 3;
  const samples = mpeg1 ? 1152 : 576;
  return {
    version,
    sampleRate,
    bitrate,
    samples,
    crc: (b1 & 1) === 0,
    sideInfo: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
    size: Math.floor((samples / 8) * bitrate / sampleRate) + padding,
  };
}

// Baştaki ID3v2 etiket(ler)inin toplam uzunluğu.
function id3v2Length(buf) {
  let off = 0;
  while (off + 10 <= buf.length && buf[off] === 0x49 && buf[off + 1] === 0x44 && buf[off + 2] === 0x33) { // "ID3"
    const s = buf.subarray(off + 6, off + 10);
    if (s.some((b) => b & 0x80)) break; // senkron-güvenli değil → etiket değil
    const size = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3];
    off += 10 + size + (buf[off + 5] & 0x10 ? 10 : 0); // altbilgi bayrağı
  }
  return Math.min(off, buf.length);
}

// Xing/Info (LAME) veya VBRI çerçevesi: ses değil, üst veri → atlanır.
function isInfoFrame(buf, off, h) {
  const xing = off + 4 + (h.crc ? 2 : 0) + h.sideInfo;
  const tag = (o) => buf.toString('latin1', o, o + 4);
  return (xing + 4 <= buf.length && (tag(xing) === 'Xing' || tag(xing) === 'Info')) || (off + 40 <= buf.length && tag(off + 36) === 'VBRI');
}

const sameStream = (a, b) => a.version === b.version && a.sampleRate === b.sampleRate;

// Akışı çerçevelere ayır. Döner: { frames: [{ off, size }], sampleRate, frameDuration, duration } veya null (MP3 değil).
// İlk çerçeve, ardından gelen çerçeveyle doğrulanır (ID3 içindeki rastgele 0xFFE baytlarıyla yanlış senkron olmasın).
// Aradaki çöp bayt atlanıp yeniden senkronlanır; sondaki yarım çerçeve ve ID3v1 ("TAG") atılır.
export function parseMp3(buf, { maxFrames = 20_000 } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let off = id3v2Length(buf);
  let first = null;
  for (; off + 4 <= buf.length; off++) {
    const h = parseHeader(buf, off);
    if (!h) continue;
    const n = parseHeader(buf, off + h.size);
    if (n && sameStream(h, n)) { first = h; break; }
    if (off + h.size === buf.length) { first = h; break; } // tek çerçevelik dosya
  }
  if (!first) return null;
  const frames = [];
  let skippedInfo = false;
  while (off + 4 <= buf.length && frames.length < maxFrames) {
    const h = parseHeader(buf, off);
    if (!h || !sameStream(h, first)) {
      if (buf.toString('latin1', off, off + 3) === 'TAG') break; // ID3v1 (son 128 bayt)
      off++; // çöp: bir sonraki geçerli başlığa kadar ilerle
      continue;
    }
    if (off + h.size > buf.length) break; // yarım çerçeve
    if (!skippedInfo && frames.length === 0 && isInfoFrame(buf, off, h)) {
      skippedInfo = true;
    } else {
      frames.push({ off, size: h.size });
    }
    off += h.size;
  }
  if (!frames.length) return null;
  const frameDuration = first.samples / first.sampleRate;
  return { frames, sampleRate: first.sampleRate, frameDuration, duration: frames.length * frameDuration };
}

// [start, start + dur] aralığını çerçeve sınırında kes. lead/tail: kod çözücü ısınması (bit rezervuarı bir önceki
// çerçeveye başvurabilir) ve yuvarlama için baştan/sondan fazladan çerçeve. dur = Infinity → sona kadar.
export function cutMp3(buf, parsed, start, dur, { lead = 2, tail = 1 } = {}) {
  const { frames, frameDuration } = parsed;
  const s = Math.max(0, Number(start) || 0);
  const i0 = Math.max(0, Math.floor(s / frameDuration) - lead);
  const i1 = Number.isFinite(dur) ? Math.min(frames.length, Math.ceil((s + Math.max(0, dur)) / frameDuration) + tail) : frames.length;
  if (i1 <= i0) return Buffer.alloc(0);
  const parts = [];
  let runStart = frames[i0].off;
  let runEnd = runStart;
  for (let i = i0; i < i1; i++) {
    const f = frames[i];
    if (f.off !== runEnd) { parts.push(buf.subarray(runStart, runEnd)); runStart = f.off; }
    runEnd = f.off + f.size;
  }
  parts.push(buf.subarray(runStart, runEnd));
  return Buffer.concat(parts);
}

// Sentetik MP3 (testler ve TEST_MODE yukarı akışı için): sessiz çerçeveler (yan bilgi sıfır → sessizlik çözülür).
// İsteğe bağlı ID3v2 etiketi, Xing çerçevesi, aradaki çöp ve ID3v1 etiketi.
export function synthMp3({ seconds = 30, kbps = 128, sampleRate = 44100, mono = false, id3 = 0, xing = false, junkAt = -1, id3v1 = false } = {}) {
  const version = { 44100: 3, 48000: 3, 32000: 3, 22050: 2, 24000: 2, 16000: 2, 11025: 0, 12000: 0, 8000: 0 }[sampleRate];
  if (version == null) throw new Error('örnekleme hızı desteklenmiyor');
  const mpeg1 = version === 3;
  const brIndex = (mpeg1 ? BITRATE_V1 : BITRATE_V2).indexOf(kbps);
  if (brIndex < 1) throw new Error('bit hızı desteklenmiyor');
  const srIndex = SAMPLE_RATES[version].indexOf(sampleRate);
  const samples = mpeg1 ? 1152 : 576;
  const count = Math.ceil((seconds * sampleRate) / samples);
  const parts = [];
  if (id3) {
    const body = Buffer.alloc(id3, 0xff); // içi 0xFF dolu: yanlış senkron tuzağı
    const head = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f]);
    parts.push(head, body);
  }
  // Doldurma (padding) bitiyle ortalama bit hızı tutturulur (44.1 kHz'de 417/418 bayt).
  let acc = 0;
  const exact = (samples / 8) * (kbps * 1000) / sampleRate;
  const frame = (pad) => {
    const size = Math.floor(exact) + pad;
    const f = Buffer.alloc(size, 0);
    f[0] = 0xff;
    f[1] = 0xe0 | (version << 3) | (1 << 1) | 1; // Layer III, CRC yok
    f[2] = (brIndex << 4) | (srIndex << 2) | (pad << 1);
    f[3] = mono ? 0xc0 : 0x00;
    return f;
  };
  if (xing) {
    const f = frame(0);
    f.write('Xing', 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17)), 'latin1');
    parts.push(f);
  }
  for (let i = 0; i < count; i++) {
    acc += exact - Math.floor(exact);
    let pad = 0;
    if (acc >= 1) { acc -= 1; pad = 1; }
    parts.push(frame(pad));
    if (i === junkAt) parts.push(Buffer.from([0x00, 0x12, 0x34, 0xff, 0x00]));
  }
  if (id3v1) { const t = Buffer.alloc(128, 0x20); t.write('TAG', 0, 'latin1'); parts.push(t); }
  return Buffer.concat(parts);
}
