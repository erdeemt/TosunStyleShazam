// Gizli uyaran medyası: PNG/WAV kodlayıcıları (geçerli dosya, CRC, çözülen boy), Nüans gürültü sınırı,
// Algıla nokta görseli (nokta sayısı, Cuma kare şeridi), yörünge örnekleri (parametresiz, sekmeler dahil), günlük sıralama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, countBlobs, parseWav, estimateFreq } from '../lib/media.js';
import {
  crc32, encodePng, encodeWav, nuancePng, toneWav, dotsPng, countFrames, NUANCE_NOISE, TONE_RATE,
} from '../../server/media-encode.js';
import {
  FIELD, makeStimulus, trackPublic, trackReveal, trackSamples, samplePos, trackPos, trackLanding, flightTime,
} from '../../public/perceptle-math.js';
import { hexToRgb } from '../../public/recall-math.js';
import { createRng } from '../../server/rng.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-media-unit-'));
const { rankDaily, isFreshAccount, istanbulDate } = await import('../../server/wordle.js');

test('CRC32 bilinen değer', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
});

test('PNG: imza, parçalar, CRC ve çözülen boy doğru (RGB, RGBA, gri+alfa)', async () => {
  for (const ch of [2, 3, 4]) {
    const w = 7;
    const h = 5;
    const px = new Uint8Array(w * h * ch).map((_, i) => (i * 37) % 256);
    const png = await encodePng(w, h, px, ch);
    const img = decodePng(png, crc32);
    assert.deepEqual(img.types, ['IHDR', 'IDAT', 'IEND']);
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.equal(img.depth, 8);
    assert.equal(img.channels, ch);
    assert.deepEqual([...img.pixels], [...px], 'pikseller aynen geri gelmeli');
  }
  await assert.rejects(() => encodePng(2, 2, new Uint8Array(3), 3));
});

test('Nüans PNG: 64×64 RGB, her kanal hedefin ±3 içinde, gürültü gerçekten var, ortalama hedefe yakın', async () => {
  for (const hex of ['#3a7bd5', '#000000', '#ffffff', '#ff0080']) {
    const img = decodePng(await nuancePng(hex), crc32);
    assert.equal(img.width, 64);
    assert.equal(img.channels, 3);
    const base = hexToRgb(hex);
    const sums = [0, 0, 0];
    const distinct = new Set();
    for (let i = 0; i < img.pixels.length; i++) {
      const d = img.pixels[i] - base[i % 3];
      assert.ok(Math.abs(d) <= NUANCE_NOISE, `${hex}: kanal sapması ${d}`);
      sums[i % 3] += img.pixels[i];
      distinct.add(img.pixels[i]);
    }
    if (hex === '#3a7bd5') {
      assert.ok(distinct.size > 6, 'gürültü yok');
      sums.forEach((s, c) => assert.ok(Math.abs(s / 4096 - base[c]) < 0.5));
    }
  }
  // Her istek yeni tohum: iki görsel farklı
  const [a, b] = await Promise.all([nuancePng('#3a7bd5'), nuancePng('#3a7bd5')]);
  assert.notDeepEqual(decodePng(a).pixels, decodePng(b).pixels);
});

test('WAV: RIFF/PCM16 mono 22050 Hz başlığı, süre = ezber, frekans hedefte, 30 ms rampa', () => {
  const buf = toneWav(440, 3000);
  const w = parseWav(buf);
  assert.equal(w.riff, 'RIFF');
  assert.equal(w.wave, 'WAVE');
  assert.equal(w.format, 1);
  assert.equal(w.channels, 1);
  assert.equal(w.rate, TONE_RATE);
  assert.equal(w.bits, 16);
  assert.equal(w.dataBytes, 3 * TONE_RATE * 2);
  assert.equal(buf.readUInt32LE(4), buf.length - 8);
  assert.ok(Math.abs(estimateFreq(w) - 440) < 2, `frekans ${estimateFreq(w)}`);
  assert.equal(w.samples[0], 0);
  assert.ok(Math.abs(w.samples.at(-1)) < 50, 'sonda kapanış rampası');
  const peak = Math.max(...w.samples.slice(TONE_RATE, TONE_RATE + 200));
  assert.ok(peak > 28000 && peak < 30000, `tepe ${peak}`);
  const early = Math.max(...w.samples.slice(0, 100).map(Math.abs));
  assert.ok(early < peak * 0.2, 'açılış rampası yok');
  for (const f of [60, 1400]) assert.ok(Math.abs(estimateFreq(parseWav(toneWav(f, 1000))) - f) < 3);
  assert.equal(encodeWav(new Int16Array(0), 8000).length, 44);
});

test('Algıla nokta görseli: nokta sayısı = gerçek; Cuma şeridi 2 sn × 15 kare, her karede aynı sayı', async () => {
  const rng = createRng(7);
  for (const friday of [false, true]) {
    const stim = makeStimulus('count', rng, friday);
    const layout = countFrames(friday, 2000);
    const img = decodePng(await dotsPng(stim.dots, layout), crc32);
    assert.equal(img.channels, 2);
    assert.equal(img.width, layout.size);
    assert.equal(img.height, layout.size * layout.frames);
    if (!friday) assert.equal(layout.frames, 1);
    else assert.equal(layout.frames, 31);
    assert.equal(countBlobs(img, 0), stim.dots.length, 'ilk kare');
    // Hareket sırasında noktalar üst üste geçebilir (eski canvas çiziminde de böyleydi): sayı düşebilir, artmaz
    if (friday) for (const f of [15, 30]) { const n = countBlobs(img, f); assert.ok(n <= stim.dots.length && n >= stim.dots.length * 0.75, `kare ${f}: ${n}`); }
    // Kenar yumuşatma: tam opak ve yarı saydam pikseller var
    const alphas = new Set();
    for (let i = 1; i < img.pixels.length; i += 2) alphas.add(img.pixels[i]);
    assert.ok(alphas.has(255) && alphas.size > 10);
  }
});

test('yörünge örnekleri: parametre/iniş yok, eğri üzerinde, sekme anları dahil; sonuç örnekleri inişte biter', () => {
  const rng = createRng(11);
  for (const friday of [false, true]) {
    for (let k = 0; k < 20; k++) {
      const p = makeStimulus('track', rng, friday);
      const pub = trackPublic(p);
      assert.deepEqual(Object.keys(pub).sort(), ['samples', 'visible', 'walls']);
      assert.ok(pub.samples.length >= 49);
      assert.equal(pub.samples[0][0], 0);
      assert.equal(pub.samples.at(-1)[0], Math.round(p.visible * 1000) / 1000);
      for (const [t, x, y] of pub.samples) {
        const q = trackPos(p, t);
        assert.ok(Math.abs(q.x - x) <= 0.5 && Math.abs(q.y - y) <= 0.5, `örnek eğride değil ${t} ${x} ${q.x}`); // t ms'ye yuvarlı
      }
      // Ara değer eğriden çok uzaklaşmaz (sekmede köşe kesilmez)
      for (let t = 0; t < p.visible; t += 0.013) {
        const a = samplePos(pub.samples, t);
        const b = trackPos(p, t);
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 3, `t=${t} sapma ${Math.hypot(a.x - b.x, a.y - b.y)}`);
      }
      const rev = trackReveal(p);
      assert.ok(Math.abs(rev.samples.at(-1)[0] - flightTime(p)) < 0.001);
      assert.ok(Math.abs(rev.landing - trackLanding(p)) < 0.06);
      assert.ok(Math.abs(rev.samples.at(-1)[1] - rev.landing) < 0.1);
    }
  }
  // Cuma: duvar anı örneklerde
  const p = { x0: 900, y0: 200, vx: 400, vy: 300, g: 320, walls: true, visible: 1 };
  const s = trackSamples(p, 0, 1, 10);
  const hit = s.find(([t]) => Math.abs(t - (FIELD.w - FIELD.ball - 900) / 400) < 0.001);
  assert.ok(hit && Math.abs(hit[1] - (FIELD.w - FIELD.ball)) < 0.1, 'sekme anı eklenmeli');
});

test('günlük sıralama: bugün açılan hesap sıralama dışı en altta; createdAt yoksa eski sayılır', () => {
  const day = istanbulDate(Date.now());
  assert.equal(isFreshAccount({ createdAt: Date.now() }, day), true);
  assert.equal(isFreshAccount({ createdAt: Date.now() - 2 * 86_400_000 }, day), false);
  assert.equal(isFreshAccount({}, day), false);
  assert.equal(isFreshAccount(undefined, day), false);
  // İstanbul gece yarısı: 21:00 UTC
  assert.equal(istanbulDate(Date.parse('2026-10-30T21:30:00Z')), '2026-10-31');
  const cmp = (a, b) => b.total - a.total;
  const out = rankDaily([
    { name: 'yeni', total: 99, fresh: true },
    { name: 'a', total: 50, fresh: false },
    { name: 'b', total: 70, fresh: false },
    { name: 'yeni2', total: 10, fresh: true, me: true },
  ], cmp, 1);
  assert.deepEqual(out.map((e) => [e.name, e.rank]), [['b', 1], ['yeni', null], ['yeni2', null]]);
});
