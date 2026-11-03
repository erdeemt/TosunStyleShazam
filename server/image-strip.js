// Görsel üst verisini (metadata) sil: dosya adı, başlık, yazar, GPS, tarih, açıklama gibi her şey ipucu/cevap olabilir.
// Bağımlılıksız; görüntü yeniden kodlanmaz, sadece bölütler ayıklanır. Bkz. PLAN.md §4.10 "Görsel vekili".
//
// JPEG: SOI'den SOS'a kadar bölütler tek tek okunur. Kalır: APP0 (sadece "JFIF\0"), APP2 (sadece ICC renk profili),
// APP14 (Adobe; renk dönüşümü için gerekli) ve tüm görüntü bölütleri (DQT, DHT, SOFn, DRI…). Atılır: APP1 (EXIF/XMP),
// APP13 (IPTC/Photoshop), COM (yorum), diğer tüm APPn. SOS'tan sonra sıkıştırılmış veri ilk EOI'ye kadar kopyalanır
// (EOI sonrası eklenmiş veri atılır).
// PNG: sadece görüntü için gerekli/zararsız parçalar kalır (IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT,
// bKGD, pHYs); tEXt/zTXt/iTXt/tIME/eXIf ve bilinmeyen her şey atılır.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs']);

export const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isPng = (b) => b.length > 8 && b.subarray(0, 8).equals(PNG_SIG);

export function imageType(buf) {
  if (isJpeg(buf)) return 'image/jpeg';
  if (isPng(buf)) return 'image/png';
  return null;
}

function keepJpegApp(marker, payload) {
  if (marker === 0xe0) return payload.subarray(0, 5).toString('latin1') === 'JFIF\0';
  if (marker === 0xe2) return payload.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0';
  if (marker === 0xee) return payload.subarray(0, 5).toString('latin1') === 'Adobe';
  return false;
}

export function stripJpeg(buf) {
  if (!isJpeg(buf)) throw new Error('JPEG değil');
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('JPEG bölütü bozuk');
    // Doldurma baytları (FF FF …)
    while (buf[i] === 0xff && buf[i + 1] === 0xff) i++;
    const marker = buf[i + 1];
    if (marker === undefined) throw new Error('JPEG kesik');
    // Uzunluksuz işaretler
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); break; }
    if (i + 4 > buf.length) throw new Error('JPEG kesik');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('JPEG bölüt uzunluğu bozuk');
    const seg = buf.subarray(i, i + 2 + len);
    const payload = buf.subarray(i + 4, i + 2 + len);
    if (marker === 0xda) {
      // SOS: başlık + sıkıştırılmış veri ilk EOI'ye kadar (veride FF hep FF00 ya da RSTn olarak gelir).
      let j = i + 2 + len;
      while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) j++;
      if (j >= buf.length - 1) throw new Error('JPEG sonu (EOI) yok');
      out.push(buf.subarray(i, j + 2));
      break;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const drop = marker === 0xfe || (isApp && !keepJpegApp(marker, payload));
    if (!drop) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

export function stripPng(buf) {
  if (!isPng(buf)) throw new Error('PNG değil');
  const out = [PNG_SIG];
  let i = 8;
  let ended = false;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    if (i + 12 + len > buf.length) throw new Error('PNG parçası bozuk');
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error('PNG sonu (IEND) yok');
  return Buffer.concat(out);
}

// Tür tanınmazsa hata: bilinmeyen içerik asla olduğu gibi gönderilmez.
export function stripImage(buf) {
  if (isJpeg(buf)) return { type: 'image/jpeg', body: stripJpeg(buf) };
  if (isPng(buf)) return { type: 'image/png', body: stripPng(buf) };
  throw new Error('Desteklenmeyen görsel türü');
}
