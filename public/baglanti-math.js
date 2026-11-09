// 🔗 Bağlantı Avı — sunucu ve istemcinin ortak saf hesapları: Türkçe duyarsız arama, puan, yıl biçimi, alan adları.
// Kurallar: PLAN.md §4.12. DOM/ağ yok (birim testli).

export const DIFFS = [
  { id: 'kolay', name: 'Kolay', len: 3, hint: '2 ara kişi' },
  { id: 'orta', name: 'Orta', len: 4, hint: '3 ara kişi' },
  { id: 'zor', name: 'Zor', len: 5, hint: '4 ara kişi' },
];
export const DIFF_IDS = new Set(DIFFS.map((d) => d.id));
export const diffById = (id) => DIFFS.find((d) => d.id === id) ?? DIFFS[1];
export const DAILY_DIFF = 'orta';

export const ROUND_OPTIONS = [1, 3, 5];
export const MINUTE_OPTIONS = [3, 5, 8];
export const MAX_CHAIN = 12; // en fazla ara kişi
export const MAX_HINTS = 8;

// Alanlar (ipucu + kart rozetleri). Sıra: betikteki CATS ile aynı kimlikler.
export const CATS = {
  monarch: ['👑', 'hükümdar'],
  football: ['⚽', 'futbolcu'],
  sport: ['🏅', 'sporcu'],
  music: ['🎵', 'müzisyen'],
  actor: ['🎬', 'oyuncu'],
  director: ['🎥', 'yönetmen'],
  politics: ['🏛️', 'siyasetçi'],
  military: ['⚔️', 'asker'],
  science: ['🔬', 'bilim insanı'],
  writer: ['✍️', 'yazar'],
  philosophy: ['🤔', 'düşünür'],
  art: ['🎨', 'sanatçı'],
  religion: ['🕌', 'din insanı'],
  business: ['💼', 'iş insanı'],
};
export const catText = (id) => (CATS[id] ? `${CATS[id][0]} ${CATS[id][1]}` : '🌟 tanınmış biri');

// ---------- Puan ----------
// En kısa yol = tam puan. Fazladan her ara kişi −150 (taban 300). Yanlış deneme −25 (en çok −250), ipucu (baş harf −100,
// alan −50), süre: ilk 60 sn ücretsiz, sonra her 10 sn −5 (en çok −200). Bitiren en az 50 alır; bitirmeyen / pes eden 0.
export const HINT_COST = { letter: 100, field: 50 };
export const SCORE = { max: 1000, extraStep: 150, floor: 300, wrong: 25, wrongCap: 250, freeSec: 60, timeStep: 10, timePer: 5, timeCap: 200, min: 50 };

export function scoreRun({ steps, optimal, wrong = 0, hints = [], seconds = 0, done = true, gaveUp = false }) {
  if (!done || gaveUp) return { score: 0, base: 0, wrongPen: 0, hintPen: 0, timePen: 0 };
  const extra = Math.max(0, steps - optimal);
  const base = Math.max(SCORE.floor, SCORE.max - SCORE.extraStep * extra);
  const wrongPen = Math.min(SCORE.wrongCap, SCORE.wrong * Math.max(0, wrong));
  const hintPen = hints.reduce((s, h) => s + (HINT_COST[h] ?? 0), 0);
  const over = Math.max(0, seconds - SCORE.freeSec);
  const timePen = Math.min(SCORE.timeCap, Math.floor(over / SCORE.timeStep) * SCORE.timePer);
  return { score: Math.max(SCORE.min, base - wrongPen - hintPen - timePen), base, wrongPen, hintPen, timePen };
}

export function titleFor(score) {
  if (score >= 950) return { icon: '🕸️', name: 'Altı Derece Ustası' };
  if (score >= 800) return { icon: '🔗', name: 'Zincir Ustası' };
  if (score >= 600) return { icon: '🧭', name: 'İz Sürücü' };
  if (score >= 400) return { icon: '🗺️', name: 'Yolunu Bulan' };
  if (score > 0) return { icon: '🐢', name: 'Dolambaçlı Yolcu' };
  return { icon: '🙈', name: 'Kayıp Halka' };
}

// ---------- Yıl ----------
// Wikidata yılları astronomik: 0 = MÖ 1, −68 = MÖ 69.
export const fmtYear = (y) => (y == null ? '?' : y <= 0 ? `MÖ ${1 - y}` : String(y));
export function fmtYears(b, d) {
  if (b == null && d == null) return '';
  if (d == null) return b != null && b < 1900 ? fmtYear(b) : `${fmtYear(b)}–`;
  return `${fmtYear(b)} – ${fmtYear(d)}`;
}
export function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Türkçe duyarsız arama ----------
const FOLD_MAP = { ı: 'i', İ: 'i', I: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c', ß: 'ss', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o', đ: 'd', Đ: 'd', ł: 'l', Ł: 'l', œ: 'oe', Œ: 'oe' };
const FOLD_RE = new RegExp(`[${Object.keys(FOLD_MAP).join('')}]`, 'g');

// "İsmet İnönü" → "ismet inonu", "Ğ/ğ", "â/î/û", "é/ñ" vb. → düz harf; noktalama boşluk olur.
export function fold(s) {
  return String(s ?? '')
    .replace(FOLD_RE, (c) => FOLD_MAP[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// entries: [{ q, keys: [katlanmış ad, ...] }] (ünlüden aza sıralı). Dönen: en fazla `limit` kayıt.
// Sıra: ad sorguyla başlıyor > her sorgu kelimesi bir kelimenin başı > ad sorguyu içeriyor; eşitlikte ünlülük.
export function search(entries, query, limit = 8) {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(' ');
  const hits = [[], [], []];
  for (const e of entries) {
    let rank = 3;
    for (const k of e.keys) {
      if (k.startsWith(q)) { rank = 0; break; }
      if (rank > 1) {
        const kw = k.split(' ');
        if (words.every((w) => kw.some((x) => x.startsWith(w)))) rank = 1;
        else if (rank > 2 && q.length >= 3 && k.includes(q)) rank = 2;
      }
    }
    if (rank < 3) {
      hits[rank].push(e);
      if (rank === 0 && hits[0].length >= limit) break;
    }
  }
  return [...hits[0], ...hits[1], ...hits[2]].slice(0, limit);
}

// Kişi dizini (sunucunun /api/baglanti/people yanıtı) → arama girdileri.
// Satır: [qid, ad, diğer ad, doğum, ölüm, kısa açıklama, alanlar ("football,actor"), fotoğraf var mı (1/0), ek adlar ("a|b")]
export function indexEntries(rows) {
  return rows.map((r, i) => ({
    i,
    q: r[0],
    name: r[1],
    alt: r[2] || '',
    b: r[3],
    d: r[4],
    desc: r[5] || '',
    cats: r[6] ? r[6].split(',') : [],
    photo: r[7] === 1,
    keys: [r[1], r[2], ...(r[8] ? r[8].split('|') : [])].filter(Boolean).map(fold),
  }));
}

// Baş harf (ipucu): "II. Mehmed" → "M" değil "I" olmasın diye Romen rakamı ve noktalı ön ekler atlanır.
export function initialOf(name) {
  const words = String(name ?? '').split(/\s+/).filter((w) => !/^[IVXLC]+\.$/.test(w) && !/^\d+\.$/.test(w));
  const ch = [...(words[0] ?? name ?? '?')][0] ?? '?';
  return ch.toLocaleUpperCase('tr');
}
