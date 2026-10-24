// Hafıza oyunları çekirdek matematiği: Nüans ve Ton Avı puan formülleri, renk dönüşümleri, perde ölçeği.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hsbToRgb, rgbToHsb, hexToRgb, rgbToHex, normalizeHex, scoreColor, scorePlaynuance, scoreFromDeltaE,
  deltaE2000, deltaE2000Rgb, srgbToLab, nuanceTier, scoreTone, centsBetween, centsHint, freqAt, posOf, TONE_RANGES,
} from '../../public/recall-math.js';

process.env.TEST_GAMES = '1';
process.env.RECALL_SALT = 'unit-salt';
process.env.DATA_DIR ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'tss-unit-'));
const { RECALL_GAMES, dailyTarget } = await import('../../server/recall.js');

const semis = (f, n) => f * 2 ** (n / 12);

test('Nüans (CIEDE2000): aynı renk 1000, ΔE 5/10/20 → 852/590/265, siyah–beyaz 14', () => {
  assert.equal(scoreColor([12, 200, 99], [12, 200, 99]), 1000);
  assert.equal(scoreFromDeltaE(0), 1000);
  assert.equal(scoreFromDeltaE(5), 852);
  assert.equal(scoreFromDeltaE(10), 590);
  assert.equal(scoreFromDeltaE(20), 265);
  assert.equal(scoreColor([0, 0, 0], [255, 255, 255]), 14); // ΔE 100 → 1000 / (1 + (100/12)²)
  assert.equal(scoreColor([0, 0, 0], [255, 255, 255]), scoreColor([255, 255, 255], [0, 0, 0]));
  assert.equal(scoreColor([200, 50, 50], [180, 70, 60]), scoreFromDeltaE(deltaE2000Rgb([200, 50, 50], [180, 70, 60])));
  // Eski playnuance formülü sadece yardımcı olarak duruyor
  assert.equal(scorePlaynuance([0, 0, 0], [255, 255, 255]), 0);
  assert.equal(scorePlaynuance([200, 50, 50], [180, 70, 60]), 851);
});

test('Nüans: "hep orta gri" tembel stratejisi puan toplayamaz', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let sum = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const target = hsbToRgb(rnd() * 360, 25 + rnd() * 75, 25 + rnd() * 75);
    sum += scoreColor(target, [128, 128, 128]);
  }
  const avg = sum / N;
  assert.ok(avg < 300, `orta gri ortalaması çok yüksek: ${avg}`);
  // karşılaştırma: playnuance formülünde aynı strateji daha çok puan alırdı
  seed = 7;
  let old = 0;
  for (let i = 0; i < N; i++) old += scorePlaynuance(hsbToRgb(rnd() * 360, 25 + rnd() * 75, 25 + rnd() * 75), [128, 128, 128]);
  assert.ok(old / N > avg, `playnuance ${old / N} vs ΔE00 ${avg}`);
});

test('Nüans seviyeleri', () => {
  assert.equal(nuanceTier(0), 'Acemi');
  assert.equal(nuanceTier(399), 'Acemi');
  assert.equal(nuanceTier(400), 'Orta');
  assert.equal(nuanceTier(600), 'İyi');
  assert.equal(nuanceTier(750), 'Uzman');
  assert.equal(nuanceTier(879), 'Uzman');
  assert.equal(nuanceTier(880), 'Elit');
  assert.equal(nuanceTier(1000), 'Elit');
});

test('CIEDE2000: aynı renk 0, siyah–beyaz 100.0, Sharma test çiftleri', () => {
  assert.equal(deltaE2000Rgb([40, 120, 200], [40, 120, 200]), 0);
  assert.equal(Math.round(deltaE2000Rgb([0, 0, 0], [255, 255, 255]) * 10) / 10, 100);
  assert.deepEqual(srgbToLab([255, 255, 255]).map((v) => Math.round(v * 100) / 100 + 0), [100, 0, 0]);
  // Sharma, Wu, Dalal (2005) Tablo 1: çift 1, 7, 17
  assert.equal(Math.round(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]) * 1e4) / 1e4, 2.0425);
  assert.equal(Math.round(deltaE2000([50, 0, 0], [50, -1, 2]) * 1e4) / 1e4, 2.3669);
  assert.equal(Math.round(deltaE2000([50, 2.5, 0], [73, 25, -18]) * 1e4) / 1e4, 27.1492);
});

test('renk dönüşümleri: HSB ↔ RGB ↔ hex gidiş-dönüş', () => {
  assert.deepEqual(hsbToRgb(0, 100, 100), [255, 0, 0]);
  assert.deepEqual(hsbToRgb(120, 100, 100), [0, 255, 0]);
  assert.deepEqual(hsbToRgb(240, 100, 50), [0, 0, 128]);
  assert.deepEqual(hsbToRgb(360, 0, 100), [255, 255, 255]);
  assert.equal(rgbToHex(hsbToRgb(210, 50, 80)), '#6699cc');
  assert.deepEqual(hexToRgb('#6699CC'), [102, 153, 204]);
  assert.deepEqual(hexToRgb('6699cc'), [102, 153, 204]);
  assert.equal(hexToRgb('#69c'), null);
  assert.equal(hexToRgb('#gg0000'), null);
  assert.equal(hexToRgb({ toString: () => '#000000' }), null);
  assert.equal(normalizeHex(' #ABCDEF '), '#abcdef');
  // Her RGB rengi HSB'ye ve geri aynı renge döner (hex kutusuna yazılan renk kaybolmaz)
  for (let i = 0; i < 5000; i++) {
    const rgb = [(i * 37) % 256, (i * 101) % 256, (i * 211) % 256];
    const { h, s, b } = rgbToHsb(...rgb);
    assert.deepEqual(hsbToRgb(h, s, b), rgb, `gidiş-dönüş bozuk: ${rgb}`);
    assert.equal(rgbToHex(hexToRgb(rgbToHex(rgb))), rgbToHex(rgb));
  }
  // Tamsayı HSB → hex → HSB: kaydırıcılar en fazla ~1 birim oynar
  for (const [h, s, b] of [[17, 63, 88], [200, 25, 40], [333, 100, 100], [90, 50, 25]]) {
    const back = rgbToHsb(...hsbToRgb(h, s, b));
    assert.ok(Math.abs(back.h - h) < 1.5 && Math.abs(back.s - s) < 1.5 && Math.abs(back.b - b) < 1.5, `${[h, s, b]} → ${JSON.stringify(back)}`);
  }
});

test('Ton Avı: sent farkına göre puan (frekanstan bağımsız)', () => {
  const at = (cents, base = 440) => scoreTone(base, base * 2 ** (cents / 1200));
  assert.equal(at(0), 10);
  assert.equal(at(10), 9.95);
  assert.equal(at(50), 8.8);
  assert.equal(at(100), 6);
  assert.equal(at(200), 4.49);
  assert.equal(at(1200), 0.35);
  assert.equal(at(-100), 6, 'pes/tiz simetrik');
  assert.equal(at(100, 90), at(100, 1100), 'alçak ve yüksek notada aynı aralık aynı puan');
  assert.equal(scoreTone(440, semis(440, 1)), 6);
  for (let c = 0; c < 2400; c += 25) assert.ok(at(c) >= at(c + 25), 'puan uzaklıkla azalmalı');
});

test('Ton Avı: sent hesabı, yorum, logaritmik ped ölçeği', () => {
  assert.equal(Math.round(centsBetween(440, 880)), 1200);
  assert.equal(Math.round(centsBetween(440, semis(440, -1))), -100);
  assert.equal(centsHint(5), 'Tam isabet!');
  assert.equal(centsHint(-40), 'Biraz pes');
  assert.equal(centsHint(100), 'Yarım ton tiz');
  assert.equal(centsHint(-1200), 'Yaklaşık bir oktav pes');
  const r = TONE_RANGES.easy;
  assert.equal(freqAt(0, r), 80);
  assert.equal(Math.round(freqAt(1, r)), 1200);
  assert.ok(Math.abs(posOf(freqAt(0.37, r), r) - 0.37) < 1e-12);
  // Eşit kaydırma = eşit sent
  const c1 = centsBetween(freqAt(0.2, r), freqAt(0.3, r));
  const c2 = centsBetween(freqAt(0.7, r), freqAt(0.8, r));
  assert.ok(Math.abs(c1 - c2) < 1e-9);
});

test('hedef üretimi ve girdi temizliği', () => {
  const nuance = RECALL_GAMES.nuance;
  const tone = RECALL_GAMES.tone;
  let seed = 1;
  const rng = { next: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; } };
  for (let i = 0; i < 500; i++) {
    const hex = nuance.makeTarget(rng, 'normal');
    assert.match(hex, /^#[0-9a-f]{6}$/);
    const { s, b } = rgbToHsb(...hexToRgb(hex));
    assert.ok(s >= 24 && b >= 24, `çok soluk/koyu hedef: ${hex}`);
    const f = tone.makeTarget(rng, 'easy');
    assert.ok(f >= 80 && f <= 1200, `aralık dışı ${f}`);
    const fh = tone.makeTarget(rng, 'hard');
    assert.ok(fh >= 60 && fh <= 1400);
  }
  assert.equal(nuance.cleanGuess('#ABCDEF'), '#abcdef');
  assert.throws(() => nuance.cleanGuess('red'));
  assert.throws(() => nuance.cleanGuess({}));
  assert.equal(tone.cleanGuess(5000, 'easy'), 1200);
  assert.equal(tone.cleanGuess(-3, 'hard'), 60);
  assert.equal(tone.cleanGuess('440.04', 'easy'), 440);
  assert.throws(() => tone.cleanGuess('abc', 'easy'));
  assert.throws(() => tone.cleanGuess(null, 'easy'));
  assert.equal(nuance.total([1000, 0, 500, 333, 0]), 367);
  assert.equal(tone.total([9.95, 8.8, 6, 4.49, 0.35]), 29.59);
});

test('günlük hedefler: aynı gün aynı, farklı gün/tur farklı', () => {
  assert.equal(dailyTarget('nuance', '2026-11-01', 0), dailyTarget('nuance', '2026-11-01', 0));
  const day = [0, 1, 2, 3, 4].map((i) => dailyTarget('nuance', '2026-11-01', i));
  assert.equal(new Set(day).size, 5);
  assert.notEqual(dailyTarget('nuance', '2026-11-02', 0), day[0]);
  assert.equal(dailyTarget('tone', '2026-11-01', 3), dailyTarget('tone', '2026-11-01', 3));
});
