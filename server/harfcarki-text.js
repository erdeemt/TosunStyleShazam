// 🔤 Harf Çarkı — metin işlemleri: harf kuralı, Türkçe normalleştirme, cevap karşılaştırma (yazım payı).
// Hem sunucu (server/harfcarki.js, server/games/harfcarki.js) hem içerik doğrulayıcı (content/harfcarki/validate.mjs) kullanır.
// Kurallar PLAN.md §4.13.

// Çarktaki harfler (sıra = çark sırası). Ğ ile başlayan kelime yok, çarkta yok.
export const LETTERS = ['A', 'B', 'C', 'Ç', 'D', 'E', 'F', 'G', 'H', 'I', 'İ', 'J', 'K', 'L', 'M', 'N', 'O', 'Ö', 'P', 'R', 'S', 'Ş', 'T', 'U', 'Ü', 'V', 'Y', 'Z'];
// Kimlik (id) önekleri: ASCII, Türkçe harfler iki harfle (İ düz I, noktasız I → IH).
export const LETTER_CODE = { Ç: 'CH', I: 'IH', İ: 'I', Ö: 'OE', Ş: 'SH', Ü: 'UE' };
export const codeOf = (letter) => LETTER_CODE[letter] ?? letter;

export const CATEGORIES = {
  genel: 'Genel kelime',
  cografya: 'Coğrafya',
  tarih: 'Tarih',
  bilim: 'Bilim',
  spor: 'Spor',
  sinema: 'Sinema & dizi',
  muzik: 'Müzik',
  edebiyat: 'Edebiyat',
  yemek: 'Yemek',
  doga: 'Hayvan & bitki',
  deyim: 'Deyim & atasözü',
  populer: 'Popüler kültür',
};

export const lowerTr = (s) => String(s ?? '').normalize('NFC').toLocaleLowerCase('tr');
export const upperTr = (s) => String(s ?? '').normalize('NFC').toLocaleUpperCase('tr');

const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

// Karşılaştırma biçimi: Türkçe küçük harf, ç/ğ/ı/ö/ş/ü/â/î/û katlanır (İ/i, I/ı aynı), diğer aksanlar atılır,
// kesme işareti silinir, diğer noktalama boşluk olur, boşluklar tek boşluğa iner, baş/son kırpılır.
export function fold(raw) {
  return lowerTr(raw)
    .replace(/[çğıöşüâîû]/g, (c) => FOLD[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // é, ñ, ä… (ve tr dışı "i̇" birleşik noktası)
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Boşluksuz biçim: "ay çiçeği" = "ayçiçeği".
export const compact = (raw) => fold(raw).replace(/ /g, '');

// Cevabın harf kuralına uyup uymadığı (içerik doğrulaması): starts → ilk harf; contains → içinde geçer ama ilk harf değil.
// Noktalı/noktasız I ayrımı burada korunur (katlamadan önce).
export function letterRuleOk(letter, mode, answer) {
  const a = lowerTr(answer).replace(/[^\p{L}]/gu, '');
  const l = lowerTr(letter);
  if (!a) return false;
  if (mode === 'starts') return a.startsWith(l);
  if (mode === 'contains') return !a.startsWith(l) && a.includes(l);
  return false;
}

// Damerau-Levenshtein (optimal hizalama) mesafesi, `max`'ı aşınca erken çıkar.
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

export const TYPO_MIN_LENGTH = 6; // bu uzunluktan (boşluksuz) itibaren 1 yazım hatası kabul
export const MAX_ANSWER_CHARS = 60;

// Bir ipucunun kabul edilen biçimleri (boşluksuz katlanmış).
export const acceptedForms = (clue) => [...new Set([clue.answer, ...(clue.alt ?? [])].map(compact).filter(Boolean))];

// Harf başına "rakip kelimeler": aynı harfin diğer ipuçlarının cevap/alt biçimleri. Yazım payı bunlardan birine
// denk gelen tahmini kabul etmez (ör. cevap "kaplan", yazılan başka ipucunun cevabı "kaplam" ise yanlış).
export function rivalIndex(clues) {
  const byLetter = new Map();
  for (const c of clues) {
    if (!byLetter.has(c.letter)) byLetter.set(c.letter, new Map());
    const m = byLetter.get(c.letter);
    for (const f of acceptedForms(c)) {
      if (!m.has(f)) m.set(f, new Set());
      m.get(f).add(c.id);
    }
  }
  return byLetter;
}

// Tahmin doğru mu? → { ok, exact }. rivals: rivalIndex(...) çıktısı (opsiyonel).
export function checkAnswer(clue, raw, rivals = null) {
  const guess = compact(String(raw ?? '').slice(0, MAX_ANSWER_CHARS));
  if (!guess) return { ok: false, exact: false };
  const forms = acceptedForms(clue);
  if (forms.includes(guess)) return { ok: true, exact: true };
  // Başka bir ipucunun (aynı harf) geçerli cevabı: yazım hatası sayılmaz.
  const rival = rivals?.get(clue.letter)?.get(guess);
  if (rival && !rival.has(clue.id)) return { ok: false, exact: false };
  for (const f of forms) {
    if (f.length < TYPO_MIN_LENGTH) continue;
    if (clue.mode === 'starts' && guess[0] !== f[0]) continue; // baş harf kuralın kendisi: orada hata affedilmez
    if (editDistance(guess, f, 1) <= 1) return { ok: true, exact: false };
  }
  return { ok: false, exact: false };
}
