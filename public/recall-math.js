// Hafıza oyunlarının (🎨 Nüans, 🔊 Ton Avı) saf matematiği: renk dönüşümleri, perde ölçeği ve puanlama.
// Hem sunucu (server/recall.js) hem istemci aynı dosyayı kullanır; puan sunucuda hesaplanır, istemci sadece gösterir.
// Formüller ve sabitler: PLAN.md §4.4 / §4.5.

// ---------- Renk ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// HSB (Ton 0–360, Doygunluk 0–100, Parlaklık 0–100; ondalık olabilir) → [r, g, b] (0–255 tamsayı)
export function hsbToRgb(h, s, b) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = clamp(s, 0, 100) / 100;
  const bb = clamp(b, 0, 100) / 100;
  const f = (n) => {
    const k = (n + hh) % 6;
    return bb * (1 - ss * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)].map((v) => Math.round(v * 255));
}

// [r, g, b] → { h, s, b } (yuvarlanmamış; tekrar RGB'ye çevrilince aynı renk çıkar)
export function rgbToHsb(r, g, b) {
  const [R, G, B] = [r, g, b].map((v) => clamp(v, 0, 255) / 255);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : (d / max) * 100, b: max * 100 };
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

// '#rrggbb' (veya 'rrggbb') → [r, g, b]; geçersizse null
export function hexToRgb(hex) {
  const m = typeof hex === 'string' ? hex.trim().match(HEX_RE) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

export const normalizeHex = (hex) => {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : null;
};

// ---------- Nüans puanı ----------

// Kullanılan formül (kullanıcı kararı, 2026-10-24): algısal CIEDE2000 — aşağıda scoreColor.
// Eski playnuance.com formülü (RGB uzaklığı → 1000 × isabet^2.3) sadece karşılaştırma için duruyor:
// RGB uzaklığı algıyla örtüşmez ve "hep orta gri" stratejisi puan toplar.
export const NUANCE_MAX_DIST = 441.67;
export const NUANCE_EXPONENT = 2.3;

export function rgbDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function scorePlaynuance(targetRgb, guessRgb) {
  const precision = Math.max(0, 1 - rgbDistance(targetRgb, guessRgb) / NUANCE_MAX_DIST);
  return Math.round(1000 * precision ** NUANCE_EXPONENT);
}

// CIEDE2000 (ΔE00): RGB → doğrusal sRGB → XYZ (D65) → Lab → ΔE00. Tur puanı = 1000 / (1 + (ΔE/12)²).
export function srgbToLab([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  // D65 beyaz noktası
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.0;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Sharma, Wu, Dalal (2005) uygulaması; kL = kC = kH = 1.
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export const deltaE2000Rgb = (a, b) => deltaE2000(srgbToLab(a), srgbToLab(b));

// ΔE 12'de puan yarıya iner: ΔE 5 → 852, 10 → 590, 20 → 265.
export const NUANCE_HALF_DE = 12;
export const scoreFromDeltaE = (dE) => Math.round(1000 / (1 + (dE / NUANCE_HALF_DE) ** 2));

// Nüans tur puanı (0–1000 tamsayı). Oyunun tek puan fonksiyonu budur.
export function scoreColor(targetRgb, guessRgb) {
  return scoreFromDeltaE(deltaE2000Rgb(targetRgb, guessRgb));
}

export const NUANCE_TIERS = [
  { min: 880, name: 'Elit' },
  { min: 750, name: 'Uzman' },
  { min: 600, name: 'İyi' },
  { min: 400, name: 'Orta' },
  { min: 0, name: 'Acemi' },
];

export const nuanceTier = (score) => NUANCE_TIERS.find((t) => score >= t.min).name;

// ---------- Ton Avı ----------

export const TONE_RANGES = {
  easy: { min: 80, max: 1200 },
  hard: { min: 60, max: 1400 },
};

// İşaretli fark (sent): pozitif = tahmin daha tiz
export const centsBetween = (target, guess) => 1200 * Math.log2(guess / target);

// Perde aralığına göre puan (frekanstan ve moddan bağımsız). c = |sent farkı|.
// 10 × max(exp(−(c/140)²), 0.75·exp(−c/390)), 2 ondalık. 10 sent → 9.95, 100 → 6.00, 1200 → 0.35.
export const TONE_SIGMA_CENTS = 140;
export const TONE_TAIL_WEIGHT = 0.75;
export const TONE_TAIL_CENTS = 390;

export function scoreTone(target, guess) {
  const c = Math.abs(centsBetween(target, guess));
  const s = 10 * Math.max(Math.exp(-((c / TONE_SIGMA_CENTS) ** 2)), TONE_TAIL_WEIGHT * Math.exp(-c / TONE_TAIL_CENTS));
  return Math.round(s * 100) / 100;
}

// Ped / hedef ölçeği: logaritmik frekans (eşit kaydırma = eşit sent). t ∈ [0,1]
export const freqAt = (t, { min, max }) => min * (max / min) ** clamp(t, 0, 1);
export const posOf = (f, { min, max }) => clamp(Math.log(f / min) / Math.log(max / min), 0, 1);

// Sonuç ekranı için kısa yorum
export function centsHint(cents) {
  const c = Math.abs(cents);
  const dir = cents > 0 ? 'tiz' : 'pes';
  if (c < 15) return 'Tam isabet!';
  if (c < 70) return `Biraz ${dir}`;
  if (c < 140) return `Yarım ton ${dir}`;
  if (c < 300) return `Bir-iki ton ${dir}`;
  if (c < 900) return `Epey ${dir}`;
  if (c < 1500) return `Yaklaşık bir oktav ${dir}`;
  return `Oktavlarca ${dir}`;
}

export const round2 = (v) => Math.round(v * 100) / 100;
