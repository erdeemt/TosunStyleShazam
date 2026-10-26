// 👁️ Algıla (perceptle.com tarzı günlük algı testi) saf matematiği: uyaran üretimi, fizik ve puanlama.
// Hem sunucu (server/perceptle.js) hem istemci aynı dosyayı kullanır; puan sunucuda hesaplanır, istemci sadece çizer.
// Kurallar ve sabitler: PLAN.md §4.7.

export const TESTS = ['count', 'track', 'angle', 'tempo', 'split'];

// Her testin hata toleransı (puan = 100 · e^(−½·(hata/tolerans)²)). Cuma kuralları daha zor, toleransı daha geniş.
export const TOLERANCE = {
  normal: { count: 0.20, track: 60, angle: 8, tempo: 60, split: 0.05 },
  friday: { count: 0.32, track: 90, angle: 14, tempo: 85, split: 0.10 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const intOf = (rng, n) => Math.floor(rng.next() * n); // 0..n-1
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

export const scoreFromError = (error, tol) => Math.round(100 * Math.exp(-0.5 * (error / tol) ** 2));

export function finalScore(scores) {
  if (!scores.length) return 0;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function gradeOf(score) {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export const squareOf = (score) => (score >= 85 ? '🟩' : score >= 55 ? '🟨' : '🟥');

// Duvarlardan seken nokta: v'yi [lo, hi] aralığına yansıtarak katla.
export function foldInto(v, lo, hi) {
  const span = hi - lo;
  if (span <= 0) return lo;
  let u = (v - lo) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u > span ? 2 * span - u : u);
}

// ---------- 1. Say ----------
// Birim karede (0–1) üst üste binmeyen noktalar; Cuma'da noktalar hareket eder ve duvarlardan seker.

export const COUNT = { min: 45, max: 85, showMs: 2000 };

function makeCount(rng, friday) {
  const n = COUNT.min + intOf(rng, COUNT.max - COUNT.min + 1);
  const dots = [];
  for (let tries = 0; dots.length < n && tries < 50_000; tries++) {
    const r = 0.012 + rng.next() * 0.014;
    const x = r + rng.next() * (1 - 2 * r);
    const y = r + rng.next() * (1 - 2 * r);
    if (dots.some((d) => Math.hypot(d[0] - x, d[1] - y) < d[2] + r + 0.008)) continue;
    const dot = [r3(x), r3(y), r3(r)];
    if (friday) {
      const a = rng.next() * 2 * Math.PI;
      const speed = 0.12 + rng.next() * 0.18; // birim / sn
      dot.push(r3(Math.cos(a) * speed), r3(Math.sin(a) * speed));
    }
    dots.push(dot);
  }
  return { dots };
}

// Noktanın t saniyedeki yeri (Cuma: duvarlardan sekerek)
export function dotAt(dot, t) {
  const [x, y, r, vx = 0, vy = 0] = dot;
  return [foldInto(x + vx * t, r, 1 - r), foldInto(y + vy * t, r, 1 - r)];
}

// ---------- 2. Yörünge ----------
// Saha 1000 birim geniş, 700 birim yüksek; y yukarı, zemin y = 0. Top bir süre görünür, sonra kaybolur.
// Cuma: yerçekimi zayıf, top yan duvarlardan seker (iniş noktası yansımalarla hesaplanır).

export const FIELD = { w: 1000, h: 700, ball: 12 };
const GRAVITY = { normal: 600, friday: 320 };

export const flightTime = ({ y0, vy, g }) => (vy + Math.sqrt(vy * vy + 2 * g * y0)) / g;

export function trackPos(p, t) {
  const rawX = p.x0 + p.vx * t;
  return {
    x: p.walls ? foldInto(rawX, FIELD.ball, FIELD.w - FIELD.ball) : rawX,
    y: p.y0 + p.vy * t - 0.5 * p.g * t * t,
  };
}

export const trackLanding = (p) => trackPos(p, flightTime(p)).x;

function makeTrack(rng, friday) {
  const g = friday ? GRAVITY.friday : GRAVITY.normal;
  for (let i = 0; i < 1000; i++) {
    const dir = rng.next() < 0.5 ? -1 : 1;
    const p = {
      x0: r1(60 + rng.next() * 880),
      y0: r1(80 + rng.next() * 270),
      vx: r1(dir * (friday ? 260 + rng.next() * 320 : 100 + rng.next() * 220)),
      vy: r1(150 + rng.next() * 300),
      g,
      walls: friday,
    };
    if (p.y0 + (p.vy * p.vy) / (2 * g) > FIELD.h - 40) continue; // tepe noktası sahada kalsın
    const T = flightTime(p);
    const raw = p.x0 + p.vx * T;
    if (!friday && (raw < 40 || raw > FIELD.w - 40)) continue; // normalde duvar yok: saha içine düşsün
    if (friday) {
      if (raw >= FIELD.ball && raw <= FIELD.w - FIELD.ball) continue; // en az bir sekme
      if (raw < -FIELD.w || raw > 2 * FIELD.w) continue; // en fazla iki sekme
      const land = trackLanding(p);
      if (land < 40 || land > FIELD.w - 40) continue;
    }
    // Uçuşun %38–52'si görünür (en az 0.55 sn, en fazla uçuşun %60'ı)
    p.visible = r3(Math.min(T * 0.6, Math.max(0.55, T * (0.38 + rng.next() * 0.14))));
    return p;
  }
  return { x0: 150, y0: 200, vx: friday ? -400 : 200, vy: 300, g, walls: friday, visible: 0.6 };
}

// ---------- 3. Açı ----------
// Normal: 10–350°, hata en kısa açısal uzaklık (359 ile 1 arası 2°). Cuma: 30–1080°, sarım sayılır, hata düz fark.

function makeAngle(rng, friday) {
  return { target: friday ? 30 + intOf(rng, 1051) : 10 + intOf(rng, 341) };
}

export function angleError(guess, target, friday) {
  if (friday) return Math.abs(guess - target);
  const d = ((((guess - target) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

// ---------- 4. Ritim ----------
// 4 duyulur vuruş (0, I, 2I, 3I; ısınma), sonra 8 sessiz vuruş oyuncunun: normal 4I…11I, Cuma vuruş aralarında 4.5I…11.5I.
// Gecikme: ısınma dokunuşlarının duyulur vuruşlara göre medyan sapması (yoksa 0), ±150 ms ile sınırlı.

export const TEMPO = { audible: 4, silent: 8, leadMs: 1500, missMs: 250, maxLatencyMs: 150, maxTaps: 40 };

function makeTempo(rng) {
  return { bpm: 80 + intOf(rng, 61) };
}

export const beatMsOf = (bpm) => 60_000 / bpm;

export function tempoExpected(bpm, friday) {
  const I = beatMsOf(bpm);
  return Array.from({ length: TEMPO.silent }, (_, j) => I * (TEMPO.audible + j + (friday ? 0.5 : 0)));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// taps: ilk duyulur vuruşa göre ms (gerçek zaman). → { rms, latency, hits, extra }
export function scoreTempoTaps(bpm, taps, friday) {
  const I = beatMsOf(bpm);
  const boundary = (TEMPO.audible - 0.5) * I; // son duyulur vuruştan yarım vuruş sonrası sessiz bölüm
  const warm = taps.filter((t) => t >= -I / 2 && t < boundary); // ilk vuruştan çok önceki dokunuşlar yok sayılır
  const offsets = warm.map((t) => t - clamp(Math.round(t / I), 0, TEMPO.audible - 1) * I);
  const latency = offsets.length ? clamp(median(offsets), -TEMPO.maxLatencyMs, TEMPO.maxLatencyMs) : 0;
  const expected = tempoExpected(bpm, friday);
  const best = expected.map(() => Infinity);
  let extra = 0;
  for (const t of taps) {
    if (t < boundary) continue;
    const j = clamp(Math.round((t - expected[0]) / I), 0, expected.length - 1);
    const d = Math.abs(t - expected[j] - latency);
    if (best[j] === Infinity) best[j] = d;
    else { extra++; best[j] = Math.min(best[j], d); }
  }
  // Eksik vuruş 250 ms sayılır; aynı vuruşa fazladan her dokunuş da 250 ms'lik bir terim ekler (rastgele dokunma ödüllenmesin).
  const terms = [...best.map((b) => Math.min(b, TEMPO.missMs)), ...Array(extra).fill(TEMPO.missMs)];
  const rms = Math.sqrt(terms.reduce((a, b) => a + b * b, 0) / terms.length);
  return { rms: r1(rms), latency: Math.round(latency), hits: best.filter((b) => b < TEMPO.missMs).length, extra };
}

// ---------- 5. Böl ----------
// Normal: kesir a/b (b 2–12) veya yüzde (%3–97), 0–1 arası. Cuma: bileşik/negatif kesir veya yüzde, uç noktanın dışında (−0.5…1.5).

export const SPLIT_RANGE = { normal: [0, 1], friday: [-0.5, 1.5] };

function makeSplit(rng, friday) {
  const pct = rng.next() < 0.4;
  if (!friday) {
    if (pct) {
      let p = 3 + intOf(rng, 95);
      if (p === 50) p = 42;
      return { kind: 'pct', pct: p };
    }
    for (;;) {
      const den = 2 + intOf(rng, 11);
      const num = 1 + intOf(rng, den - 1);
      if (gcd(num, den) === 1) return { kind: 'frac', num, den };
    }
  }
  const negative = rng.next() < 0.35;
  if (pct) return { kind: 'pct', pct: negative ? -(5 + intOf(rng, 46)) : 105 + intOf(rng, 46) };
  for (;;) {
    const den = 2 + intOf(rng, 8);
    const num = negative ? -(1 + intOf(rng, Math.floor(den / 2))) : den + 1 + intOf(rng, Math.floor(den / 2));
    if (gcd(num, den) === 1) return { kind: 'frac', num, den };
  }
}

export const splitValue = (s) => (s.kind === 'pct' ? s.pct / 100 : s.num / s.den);
export const splitLabel = (s) => (s.kind === 'pct' ? `%${s.pct}`.replace('%-', '−%') : `${s.num < 0 ? '−' : ''}${Math.abs(s.num)}/${s.den}`);

// ---------- Ortak ----------

export function makeStimulus(test, rng, friday) {
  switch (test) {
    case 'count': return makeCount(rng, friday);
    case 'track': return makeTrack(rng, friday);
    case 'angle': return makeAngle(rng, friday);
    case 'tempo': return makeTempo(rng);
    case 'split': return makeSplit(rng, friday);
    default: throw new Error(`bilinmeyen test ${test}`);
  }
}

// Uyaranın gerçek (ölçeksiz) süresi, ms: bu süre bitmeden gelen cevap reddedilir.
export function stimulusMs(test, stim, friday) {
  if (test === 'count') return COUNT.showMs;
  if (test === 'track') return Math.round(stim.visible * 1000);
  if (test === 'tempo') return Math.round(TEMPO.leadMs + tempoExpected(stim.bpm, friday).at(-1));
  return 0;
}

// Doğru cevap (sonuç ekranında gösterilir)
export function truthOf(test, stim) {
  if (test === 'count') return stim.dots.length;
  if (test === 'track') return r1(trackLanding(stim));
  if (test === 'angle') return stim.target;
  if (test === 'tempo') return stim.bpm;
  return r4(splitValue(stim));
}

// Temizlenmiş cevabı puanla → { score, error, detail }
export function evaluate(test, stim, answer, friday) {
  const tol = TOLERANCE[friday ? 'friday' : 'normal'][test];
  let error;
  let detail = null;
  if (test === 'count') error = Math.abs(answer - stim.dots.length) / stim.dots.length;
  else if (test === 'track') error = Math.abs(answer - trackLanding(stim));
  else if (test === 'angle') error = angleError(answer, stim.target, friday);
  else if (test === 'tempo') {
    const t = scoreTempoTaps(stim.bpm, answer, friday);
    error = t.rms;
    detail = { latency: t.latency, hits: t.hits, extra: t.extra };
  } else error = Math.abs(answer - splitValue(stim));
  return { score: scoreFromError(error, tol), error: r4(error), detail };
}
