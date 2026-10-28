// 👁️ Algıla çekirdek matematiği: puan eğrisi, notlar, açı sarımı, ritim RMS + gecikme, top yansıması, uyaran kuralları.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TESTS, TOLERANCE, TEMPO, FIELD, scoreFromError, finalScore, gradeOf, squareOf, angleError, foldInto, flightTime,
  trackPos, trackLanding, tempoExpected, scoreTempoTaps, splitValue, splitLabel, makeStimulus, evaluate, stimulusMs, truthOf, dotAt,
} from '../../public/perceptle-math.js';

process.env.TEST_GAMES = '1';
process.env.PERCEPTLE_SALT = 'unit-salt';
process.env.DATA_DIR ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'tss-unit-'));
const { dailyStimulus, isFriday } = await import('../../server/perceptle.js');

function seeded(seed) {
  let s = seed;
  return { next: () => { s = (s * 16807) % 2147483647; return s / 2147483647; } };
}

test('puan tablosu: hata 0 → 100, 0.5×tol → 88, 1× → 61, 2× → 14', () => {
  for (const tol of [0.2, 60, 8, 85]) {
    assert.equal(scoreFromError(0, tol), 100);
    assert.equal(scoreFromError(0.5 * tol, tol), 88);
    assert.equal(scoreFromError(tol, tol), 61);
    assert.equal(scoreFromError(2 * tol, tol), 14);
    assert.equal(scoreFromError(5 * tol, tol), 0);
  }
  assert.deepEqual(TOLERANCE.normal, { count: 0.20, track: 60, angle: 8, tempo: 60, split: 0.05 });
  assert.deepEqual(TOLERANCE.friday, { count: 0.32, track: 90, angle: 14, tempo: 85, split: 0.10 });
  assert.deepEqual(TESTS, ['count', 'track', 'angle', 'tempo', 'split']);
});

test('sonuç = ortalama (yuvarlanmış); harf notları ve kareler', () => {
  assert.equal(finalScore([100, 88, 61, 14, 0]), 53);
  assert.equal(finalScore([90, 91, 90, 90, 90]), 90);
  assert.equal(finalScore([]), 0);
  const cases = [[100, 'S'], [95, 'S'], [94, 'A'], [85, 'A'], [84, 'B'], [70, 'B'], [69, 'C'], [55, 'C'], [54, 'D'], [40, 'D'], [39, 'F'], [0, 'F']];
  for (const [s, g] of cases) assert.equal(gradeOf(s), g, `${s}`);
  assert.equal(squareOf(85), '🟩');
  assert.equal(squareOf(84), '🟨');
  assert.equal(squareOf(55), '🟨');
  assert.equal(squareOf(54), '🟥');
});

test('açı: normalde en kısa yay (359 ile 1 arası 2°), Cuma’da sarım düz fark', () => {
  assert.equal(angleError(359, 1, false), 2);
  assert.equal(angleError(1, 359, false), 2);
  assert.equal(angleError(180, 0, false), 180);
  assert.equal(angleError(137, 137, false), 0);
  assert.equal(angleError(720 + 137, 137, false), 0);
  assert.equal(angleError(-10, 350, false), 0);
  // Cuma: 810° hedef, 90° çizgi (tur sayılmadı) → 720° fark
  assert.equal(angleError(90, 810, true), 720);
  assert.equal(angleError(800, 810, true), 10);
  assert.equal(evaluate('angle', { target: 810 }, 796, true).score, 61); // 14° = 1 × tolerans
  assert.equal(evaluate('angle', { target: 10 }, 2, false).score, 61);
  assert.equal(evaluate('angle', { target: 10 }, 362, false).score, 61);
});

test('ritim: gecikme ısınmadan ölçülür, RMS, eksik vuruş 250 ms, fazladan dokunuş cezası', () => {
  const I = 500; // 120 BPM
  const beats = (offs, friday = false) => [0, 1, 2, 3].map((k) => k * I + offs).concat(tempoExpected(120, friday).map((t) => t + offs));
  assert.deepEqual(tempoExpected(120, false), [2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500]);
  assert.deepEqual(tempoExpected(120, true), [2250, 2750, 3250, 3750, 4250, 4750, 5250, 5750]);
  // Tamamen tutarlı +40 ms gecikme → 0 hata
  let r = scoreTempoTaps(120, beats(40), false);
  assert.equal(r.latency, 40);
  assert.equal(r.rms, 0);
  assert.equal(r.hits, 8);
  // Isınma yoksa gecikme 0: +40 ms sapma RMS 40
  r = scoreTempoTaps(120, tempoExpected(120, false).map((t) => t + 40), false);
  assert.equal(r.latency, 0);
  assert.equal(r.rms, 40);
  // Gecikme ±150 ms ile sınırlı
  r = scoreTempoTaps(120, beats(200), false);
  assert.equal(r.latency, 150);
  assert.equal(r.rms, 50);
  // Hiç dokunmayan: 250 ms → 0 puan
  r = scoreTempoTaps(120, [], false);
  assert.equal(r.rms, 250);
  assert.equal(evaluate('tempo', { bpm: 120 }, [], false).score, 0);
  // Dört vuruşu eksik: sqrt(4·250² / 8) ≈ 176.8
  r = scoreTempoTaps(120, tempoExpected(120, false).slice(0, 4), false);
  assert.equal(r.rms, 176.8);
  // Rastgele hızlı dokunma (her 25 ms) ödüllenmez
  const spam = Array.from({ length: 40 }, (_, i) => 2000 + i * 100);
  assert.ok(scoreTempoTaps(120, spam, false).rms > 200);
  assert.ok(evaluate('tempo', { bpm: 120 }, spam, false).score < 5);
  // ±30 ms sallantı: RMS 30 → 88
  const jitter = tempoExpected(120, false).map((t, j) => t + (j % 2 ? 30 : -30));
  assert.equal(scoreTempoTaps(120, jitter, false).rms, 30);
  assert.equal(evaluate('tempo', { bpm: 120 }, jitter, false).score, 88);
  // Cuma: vuruş aralarına dokunmak gerekir; vuruşun üstüne dokunmak yarım vuruş (250 ms) hata
  assert.equal(scoreTempoTaps(120, beats(0, true), true).rms, 0);
  assert.equal(scoreTempoTaps(120, beats(0, false), true).rms, 250);
});

test('yörünge: uçuş süresi, iniş noktası, Cuma duvar yansıması', () => {
  const p = { x0: 100, y0: 0, vx: 200, vy: 300, g: 600, walls: false };
  assert.equal(flightTime(p), 1); // (300 + 300) / 600
  assert.equal(trackLanding(p), 300);
  assert.ok(Math.abs(trackPos(p, 0.5).y - 75) < 1e-9);
  // Yansıma: 100 + 1000 = 1100 → sağ duvar (988) → 876
  const f = { x0: 100, y0: 0, vx: 1000, vy: 300, g: 600, walls: true };
  const hi = FIELD.w - FIELD.ball;
  assert.equal(trackLanding(f), hi - (1100 - hi));
  // İki yansıma
  const f2 = { ...f, x0: 900, vx: -2000 };
  assert.equal(trackLanding(f2), foldInto(-1100, FIELD.ball, hi));
  assert.ok(trackLanding(f2) > FIELD.ball && trackLanding(f2) < hi);
  assert.equal(foldInto(-5, 0, 10), 5);
  assert.equal(foldInto(25, 0, 10), 5);
  assert.equal(foldInto(7, 0, 10), 7);
  assert.equal(evaluate('track', p, 360, false).score, 61);
  assert.equal(evaluate('track', f, trackLanding(f) + 90, true).score, 61);
});

test('uyaranlar kurallara uyar (1000 rastgele set, normal + Cuma)', () => {
  const rng = seeded(42);
  for (let k = 0; k < 500; k++) {
    for (const friday of [false, true]) {
      const c = makeStimulus('count', rng, friday);
      assert.ok(c.dots.length >= 45 && c.dots.length <= 85);
      for (const [i, a] of c.dots.entries()) {
        assert.ok(a[0] - a[2] >= -1e-3 && a[0] + a[2] <= 1 + 1e-3 && a[1] - a[2] >= -1e-3 && a[1] + a[2] <= 1 + 1e-3);
        assert.equal(a.length, friday ? 5 : 3);
        if (k < 20) for (const b of c.dots.slice(i + 1)) assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= a[2] + b[2], 'noktalar üst üste');
      }
      const tr = makeStimulus('track', rng, friday);
      const land = trackLanding(tr);
      assert.ok(land >= 40 && land <= 960, `iniş ${land}`);
      assert.ok(tr.visible > 0 && tr.visible < flightTime(tr));
      const raw = tr.x0 + tr.vx * flightTime(tr);
      if (friday) assert.ok(raw < FIELD.ball || raw > FIELD.w - FIELD.ball, 'Cuma: en az bir sekme');
      else assert.equal(land, raw);
      assert.ok(tr.y0 + tr.vy ** 2 / (2 * tr.g) <= FIELD.h);
      const an = makeStimulus('angle', rng, friday);
      assert.ok(Number.isInteger(an.target));
      assert.ok(friday ? an.target >= 30 && an.target <= 1080 : an.target >= 10 && an.target <= 350);
      const te = makeStimulus('tempo', rng, friday);
      assert.ok(Number.isInteger(te.bpm) && te.bpm >= 80 && te.bpm <= 140);
      const sp = makeStimulus('split', rng, friday);
      const v = splitValue(sp);
      if (friday) assert.ok((v < 0 && v >= -0.5) || (v > 1 && v <= 1.5), `Cuma kesri dışarıda olmalı: ${splitLabel(sp)}`);
      else assert.ok(v > 0 && v < 1);
    }
  }
});

test('böl: etiketler ve değerler', () => {
  assert.equal(splitLabel({ kind: 'frac', num: 3, den: 7 }), '3/7');
  assert.equal(splitLabel({ kind: 'frac', num: -1, den: 4 }), '−1/4');
  assert.equal(splitLabel({ kind: 'pct', pct: 42 }), '%42');
  assert.equal(splitLabel({ kind: 'pct', pct: -20 }), '−%20');
  assert.equal(splitValue({ kind: 'frac', num: 8, den: 5 }), 1.6);
  assert.equal(evaluate('split', { kind: 'pct', pct: 42 }, 0.47, false).score, 61);
  assert.equal(truthOf('split', { kind: 'frac', num: 3, den: 7 }), 0.4286);
});

test('say: hata oranı; Cuma noktaları duvarlardan seker', () => {
  const stim = { dots: Array.from({ length: 50 }, () => [0.5, 0.5, 0.02]) };
  assert.equal(evaluate('count', stim, 50, false).score, 100);
  assert.equal(evaluate('count', stim, 60, false).score, 61);
  assert.equal(evaluate('count', stim, 66, true).score, 61);
  assert.equal(stimulusMs('count', stim, false), 2000);
  const [x, y] = dotAt([0.9, 0.5, 0.05, 0.2, 0], 1); // 1.1 → duvar 0.95 → 0.8
  assert.ok(Math.abs(x - 0.8) < 1e-9 && y === 0.5);
  assert.equal(stimulusMs('tempo', { bpm: 120 }, false), TEMPO.leadMs + 5500);
});

test('günlük uyaranlar: tarihe ve tuza bağlı, tekrarlanabilir; Cuma tespiti', () => {
  assert.equal(isFriday('2026-10-30'), true);
  assert.equal(isFriday('2026-10-26'), false);
  assert.equal(isFriday('2026-11-06'), true);
  const a = TESTS.map((_, i) => dailyStimulus('2026-11-02', i));
  const b = TESTS.map((_, i) => dailyStimulus('2026-11-02', i));
  const c = TESTS.map((_, i) => dailyStimulus('2026-11-03', i));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(dailyStimulus('2026-10-30', 0).dots[0].length, 5, 'Cuma noktaları hareketli');
  assert.equal(dailyStimulus('2026-10-30', 1).walls, true);
  assert.equal(dailyStimulus('2026-11-02', 1).walls, false);
});
