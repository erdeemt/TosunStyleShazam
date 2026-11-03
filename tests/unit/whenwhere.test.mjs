// 📸 Ne Zaman Nerede? birim testleri: puan matematiği, tahmin temizliği, üst veri silme (JPEG/PNG), günlük belirlenimcilik,
// açık vekil koruması ve gerçek fotoğraf havuzunun (content/whenwhere/photos.json) şeması. Kurallar: PLAN.md §4.11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KM_SCALE, YEAR_MAX, YEAR_MIN, cleanGuess, distanceKm, placePoints, scaleOf, scoreRound, titleFor, yearPoints, wrapLon, fmtKm, fmtDy,
} from '../../public/whenwhere-math.js';
import { stripImage, stripJpeg, stripPng } from '../../server/image-strip.js';
import { crc32, encodePng } from '../../server/media-encode.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-ww-unit-'));
process.env.TEST_MODE = '1';
process.env.WHENWHERE_SALT = 'unit-salt';
const ww = await import('../../server/whenwhere.js');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ISTANBUL = { lat: 41.0082, lon: 28.9784 };
const ANKARA = { lat: 39.9334, lon: 32.8597 };

// ---------- Puan ----------

test('yıl puanı: tam 500, 5 yıl ≈ 330, 20 yıl ≈ 95, simetrik', () => {
  assert.equal(yearPoints(0), 500);
  assert.ok(Math.abs(yearPoints(5) - 330) <= 2, `5 yıl: ${yearPoints(5)}`);
  assert.ok(Math.abs(yearPoints(20) - 95) <= 2, `20 yıl: ${yearPoints(20)}`);
  assert.equal(yearPoints(-7), yearPoints(7));
  assert.equal(yearPoints(180), 0);
});

test('yer puanı: dünya ölçeğinde doğru şehir ≥ 450, Türkiye ve İstanbul ölçekleri', () => {
  assert.equal(KM_SCALE.world, 1500);
  assert.equal(placePoints(0, KM_SCALE.world), 500);
  assert.ok(placePoints(50, KM_SCALE.world) >= 480);
  assert.ok(placePoints(150, KM_SCALE.world) >= 450, 'doğru şehir (150 km içi)');
  assert.ok(placePoints(distanceKm(ISTANBUL, ANKARA), KM_SCALE.world) > 380);
  assert.ok(placePoints(distanceKm(ISTANBUL, ANKARA), KM_SCALE.turkiye) < 50, 'Türkiye setinde İstanbul↔Ankara ciddi kayıp');
  assert.ok(placePoints(0.3, KM_SCALE.istanbul) >= 450, 'İstanbul: 300 m');
  assert.ok(placePoints(5, KM_SCALE.istanbul) < 100, 'İstanbul: 5 km uzak');
  assert.equal(placePoints(20_000, KM_SCALE.world), 0);
  assert.equal(scaleOf('istanbul'), 3);
  assert.equal(scaleOf('era-1900-1945'), 1500);
  assert.equal(scaleOf('bilinmeyen'), 1500);
});

test('mesafe: İstanbul–Ankara ≈ 350 km, antimeridyen kısa yol', () => {
  const d = distanceKm(ISTANBUL, ANKARA);
  assert.ok(d > 340 && d < 360, `${d}`);
  assert.ok(distanceKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }) < 120);
  assert.equal(distanceKm(ISTANBUL, ISTANBUL), 0);
});

test('tur puanı = yer + yıl, tahmin yoksa 0', () => {
  const truth = { lat: 41.0256, lon: 28.9741, year: 1895 };
  const r = scoreRound({ ...truth }, truth, KM_SCALE.world);
  assert.deepEqual([r.place, r.yearPts, r.score, r.km, r.dy], [500, 500, 1000, 0, 0]);
  const r2 = scoreRound({ lat: 39.93, lon: 32.86, year: 1900 }, truth, KM_SCALE.world);
  assert.equal(r2.score, r2.place + r2.yearPts);
  assert.equal(r2.dy, 5);
  assert.deepEqual(scoreRound(null, truth, KM_SCALE.world), { km: null, dy: null, place: 0, yearPts: 0, score: 0 });
});

test('tahmin temizliği: sadece sayılar, aralıklar, boylam sarma', () => {
  assert.deepEqual(cleanGuess({ lat: 41.123456789, lon: 28.5, year: 1925 }), { lat: 41.12346, lon: 28.5, year: 1925 });
  assert.equal(cleanGuess({ lat: 10, lon: 200, year: 1900 }).lon, -160);
  assert.equal(wrapLon(-190), 170);
  for (const bad of [
    null, [], 'x', {}, { lat: '41', lon: 29, year: 1900 }, { lat: 41, lon: 29, year: '1900' }, { lat: 91, lon: 0, year: 1900 },
    { lat: 0, lon: 0, year: YEAR_MIN - 1 }, { lat: 0, lon: 0, year: YEAR_MAX + 1 }, { lat: 0, lon: 0, year: 1900.5 },
    { lat: NaN, lon: 0, year: 1900 }, { lat: 0, lon: Infinity, year: 1900 }, { lat: 0, lon: 0, year: { valueOf: 1 } }, { lat: 0, lon: 1e9, year: 1900 },
  ]) assert.equal(cleanGuess(bad), null, JSON.stringify(bad));
});

test('unvan bantları ve biçimleme', () => {
  assert.equal(titleFor(5000, 5).name, 'Zaman Yolcusu');
  assert.equal(titleFor(0, 5).name, 'Pusulasız');
  assert.equal(titleFor(2500, 5).name, 'Gezgin');
  assert.equal(fmtKm(0.42), '420 m');
  assert.equal(fmtKm(1234.4), '1.234 km');
  assert.equal(fmtDy(0), 'tam isabet');
  assert.equal(fmtDy(-3), '3 yıl');
});

// ---------- Üst veri silme ----------

const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), Buffer.from(payload)]);

test('JPEG: EXIF/XMP/IPTC/COM/bilinmeyen APPn silinir; JFIF, ICC, Adobe ve görüntü verisi kalır', () => {
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
  const jpg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, 'JFIF\0\x01\x02\0\0\x01\0\x01\0\0'),
    seg(0xe1, 'Exif\0\0GPS 41.0256 28.9741 Galata 1895'),
    seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Galata Tower</x:xmpmeta>'),
    seg(0xe2, 'ICC_PROFILE\0\x01\x01sRGB'),
    seg(0xed, 'Photoshop 3.0\x008BIM IPTC caption Galata'),
    seg(0xee, 'Adobe\0d\0\0\0\0\x01'),
    seg(0xe5, 'secret vendor block Galata'),
    seg(0xfe, 'comment: Galata Tower 1895'),
    seg(0xdb, '\0'.repeat(65)),
    sos,
    Buffer.from([0xff, 0xd9]),
    Buffer.from('trailing Galata data'),
  ]);
  const out = stripJpeg(jpg);
  assert.ok(!out.includes('Galata'), 'gizli metin kalmadı');
  assert.ok(!out.includes('Exif') && !out.includes('xmpmeta') && !out.includes('8BIM'));
  assert.ok(out.includes('JFIF') && out.includes('ICC_PROFILE') && out.includes('Adobe'));
  assert.ok(out.includes(sos), 'görüntü verisi aynen');
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
  assert.deepEqual(stripJpeg(out), out, 'tekrar silmek değiştirmez');
});

test('JPEG: gerçek yer tutucu görsel + enjekte EXIF → temiz ve geçerli', () => {
  const ph = readFileSync(join(ROOT, 'content', 'whenwhere', 'test-placeholder.jpg'));
  const dirty = Buffer.concat([ph.subarray(0, 2), seg(0xe1, 'Exif\0\0SECRET-ID'), ph.subarray(2)]);
  const { type, body } = stripImage(dirty);
  assert.equal(type, 'image/jpeg');
  assert.ok(!body.includes('SECRET-ID'));
  assert.ok(body.length <= ph.length);
});

test('JPEG: bozuk/kesik dosya hata verir (olduğu gibi gönderilmez)', () => {
  assert.throws(() => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])));
  assert.throws(() => stripJpeg(Buffer.from([0xff, 0xd8, 0x00, 0x00])));
  assert.throws(() => stripImage(Buffer.from('GIF89a....')));
  assert.throws(() => stripImage(Buffer.from('<html>')));
});

test('PNG: tEXt/zTXt/iTXt/tIME/eXIf atılır, görüntü parçaları kalır', async () => {
  const png = await encodePng(2, 2, Buffer.alloc(16, 200));
  const chunk = (type, data) => {
    const bytes = Buffer.from(data, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), bytes]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdrEnd = 8 + 25;
  const dirty = Buffer.concat([png.subarray(0, ihdrEnd), chunk('tEXt', 'Title\0Galata'), chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0Galata'),
    chunk('eXIf', 'MM\0*Galata'), chunk('tIME', '\x07\xd0\x01\x01\0\0\0'), png.subarray(ihdrEnd)]);
  const out = stripPng(dirty);
  assert.ok(!out.includes('Galata'));
  assert.deepEqual(out, png);
});

// ---------- Havuz, günlük, vekil ----------

test('günlük: aynı tarih → aynı 5 fotoğraf; farklı günler farklı; ardışık günlerde tekrar yok', () => {
  const a = ww.dailyPhotoIds('2026-11-02');
  assert.deepEqual(ww.dailyPhotoIds('2026-11-02'), a);
  assert.equal(a.length, 5);
  assert.equal(new Set(a).size, 5);
  const b = ww.dailyPhotoIds('2026-11-03');
  assert.notDeepEqual(b, a);
  assert.equal(a.filter((id) => b.includes(id)).length, 0, 'ardışık günler kesişmez (döngü içinde)');
  for (const id of [...a, ...b]) assert.ok(ww.photoById(id));
});

test('serbest seçim: set süzgeci ve yakında görülenlerden kaçınma', () => {
  const ist = ww.poolOf('istanbul');
  assert.ok(ist.length >= 5 && ist.every((p) => p.tags.sets.includes('istanbul')));
  const avoid = ist.slice(0, 2).map((p) => p.id);
  for (let i = 0; i < 20; i++) {
    const pick = ww.pickPhotos('istanbul', 3, { next: Math.random }, avoid);
    assert.equal(pick.length, 3);
    assert.ok(pick.every((p) => !avoid.includes(p.id)));
  }
  // Yetmezse kaçınma listesi gevşer (oyun yine kurulur)
  const all = ww.pickPhotos('istanbul', ist.length, { next: Math.random }, ist.map((p) => p.id));
  assert.equal(all.length, ist.length);
  assert.ok(ww.poolOf('era-1850-1900').every((p) => p.tags.era === '1850-1900'));
  assert.ok(ww.poolOf('tema-ulasim').every((p) => p.tags.themes.includes('ulasim')));
  assert.equal(ww.cleanSet('../../etc'), 'karisik');
});

test('vekil: sadece https://upload.wikimedia.org (açık vekil değil)', () => {
  const mk = (thumb) => ({ src: { thumb } });
  assert.ok(ww.upstreamUrl(mk('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1280px-X.jpg')));
  for (const bad of ['http://upload.wikimedia.org/x.jpg', 'https://upload.wikimedia.org.evil.com/x.jpg', 'https://evil.com/upload.wikimedia.org/x.jpg',
    'https://user@upload.wikimedia.org/x.jpg', 'https://upload.wikimedia.org:8443/x.jpg', 'file:///etc/passwd', 'not a url', 'https://127.0.0.1/x.jpg']) {
    assert.equal(ww.upstreamUrl(mk(bad)), null, bad);
  }
});

test('açıklama (reveal) ham kaynak adresini ve kimliği içermez', () => {
  const p = ww.POOL[0];
  const r = ww.revealOf(p);
  const s = JSON.stringify(r);
  assert.ok(!s.includes(p.id));
  assert.ok(!s.includes(p.src.thumb));
  assert.deepEqual(Object.keys(r.truth), ['lat', 'lon', 'year']);
});

// Gerçek havuz (betikle üretilir, commit'lenir)
const POOL_FILE = join(ROOT, 'content', 'whenwhere', 'photos.json');
test('gerçek havuz: şema, lisans, yıl aralığı, tekil kimlik, set sayıları', { skip: !existsSync(POOL_FILE) }, () => {
  const { photos } = JSON.parse(readFileSync(POOL_FILE, 'utf8'));
  assert.ok(photos.length >= 250, `${photos.length} fotoğraf`);
  const ids = new Set();
  const lic = /^(public domain|pd\b|pd-|cc0|cc[- ]zero|cc by(-sa)? [0-9.]+|cc by(-sa)?$|cc-by(-sa)?-[0-9.]+|no restrictions)/i;
  for (const p of photos) {
    assert.match(p.id, /^[0-9a-f]{12}$/);
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    assert.ok(p.year >= 1850 && p.year <= 2015, `${p.id} ${p.year}`);
    assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
    assert.ok(new URL(p.src.thumb).hostname === 'upload.wikimedia.org', p.src.thumb);
    assert.match(p.license, lic, `${p.id} ${p.license}`);
    assert.ok(p.title_tr && p.caption_tr && p.author && p.wikiUrl && p.licenseUrl);
    assert.ok(['1850-1900', '1900-1945', '1945-1980', '1980-2015'].includes(p.tags.era));
  }
  const tr = photos.filter((p) => p.tags.sets.includes('turkiye')).length;
  const ist = photos.filter((p) => p.tags.sets.includes('istanbul')).length;
  assert.ok(tr / photos.length >= 0.2 && tr / photos.length <= 0.4, `Türkiye oranı ${tr}/${photos.length}`);
  assert.ok(ist >= 40, `Eski İstanbul ${ist}`);
});
