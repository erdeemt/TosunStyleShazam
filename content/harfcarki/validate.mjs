// 🔤 Harf Çarkı ipucu bankası doğrulayıcı.
// Kullanım: node content/harfcarki/validate.mjs [dosya.json ...] [--quiet] [--min 80]
//   Dosya verilmezse content/harfcarki/clues.json. Parça dosyaları (id'siz dizi) de doğrulanabilir.
// Hatalar (çıkış kodu 1): şema, harf kuralı, harf içinde tekrar eden cevap/ipucu, başka ipucunun cevabıyla çakışan alt,
//   çok uzun ipucu, cevabın ipucunda geçmesi. Uyarılar: belirsiz kalıplar, uzun ipucu, rakamlı/uzun cevap vb.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, LETTERS, acceptedForms, compact, fold, letterRuleOk, lowerTr } from '../../server/harfcarki-text.js';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const minIdx = args.indexOf('--min');
const MIN_PER_LETTER = minIdx >= 0 ? Number(args[minIdx + 1]) : 80;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--min');
if (!files.length) files.push(fileURLToPath(new URL('./clues.json', import.meta.url)));

const MAX_CLUE = 150;
const WARN_CLUE = 115;
const VAGUE = /(^|\s)(bir şey|bir tür|bir çeşit|vb\.?|vs\.?|falan|şey)(\s|$|[,.])/iu;

export function validate(clues, { minPerLetter = MIN_PER_LETTER, partial = false } = {}) {
  const errors = [];
  const warnings = [];
  const E = (c, m) => errors.push(`${c.id ?? `${c.letter}?`} "${c.answer}": ${m}`);
  const W = (c, m) => warnings.push(`${c.id ?? `${c.letter}?`} "${c.answer}": ${m}`);
  const ids = new Set();
  const formsByLetter = new Map(); // harf -> Map(biçim -> ipucu)
  const cluesSeen = new Map();
  for (const c of clues) {
    if (!partial || c.id != null) {
      if (typeof c.id !== 'string' || !c.id) E(c, 'id yok');
      else if (ids.has(c.id)) E(c, 'id tekrar');
      ids.add(c.id);
    }
    if (!LETTERS.includes(c.letter)) { E(c, `bilinmeyen harf ${c.letter}`); continue; }
    if (c.mode !== 'starts' && c.mode !== 'contains') E(c, `mode ${c.mode}`);
    if (typeof c.clue !== 'string' || c.clue.trim().length < 8) E(c, 'ipucu yok/çok kısa');
    if (typeof c.answer !== 'string' || !compact(c.answer)) { E(c, 'cevap yok'); continue; }
    if (!Array.isArray(c.alt) || c.alt.some((a) => typeof a !== 'string')) E(c, 'alt dizi değil');
    if (!CATEGORIES[c.category]) E(c, `kategori ${c.category}`);
    if (![1, 2, 3].includes(c.difficulty)) E(c, `zorluk ${c.difficulty}`);
    if (!letterRuleOk(c.letter, c.mode, c.answer)) E(c, `harf kuralı (${c.mode} ${c.letter})`);
    const clue = String(c.clue ?? '');
    if (clue.length > MAX_CLUE) E(c, `ipucu çok uzun (${clue.length})`);
    else if (clue.length > WARN_CLUE) W(c, `uzun ipucu (${clue.length})`);
    if (clue.trim().split(/\s+/).length < 3) W(c, 'ipucu 3 kelimeden kısa');
    if (VAGUE.test(lowerTr(clue))) W(c, 'belirsiz kalıp (bir tür/bir şey/vb.)');
    if (/\d/.test(c.answer)) W(c, 'cevapta rakam');
    if (fold(c.answer).split(' ').length > 3) W(c, 'cevap 3 kelimeden uzun');
    if (/(harfi(yle|ni)?|ile başla|harfle)/iu.test(clue)) W(c, 'ipucu harften bahsediyor (arayüz zaten gösterir)');
    // Cevap (ya da alt biçimi) ipucunda geçiyor mu? Kelime başı eşleşmesi, en az 4 harf kök.
    const clueWords = fold(clue).split(' ');
    for (const form of [c.answer, ...(c.alt ?? [])]) {
      const words = fold(form).split(' ').filter((w) => w.length >= 3);
      for (const w of words) {
        const root = w.length >= 6 ? w.slice(0, w.length - 2) : w;
        if (root.length >= 4 && clueWords.some((cw) => cw.startsWith(root))) { E(c, `cevap ipucunda geçiyor ("${w}")`); break; }
      }
    }
    if (c.category === 'deyim' && !/(…|\.\.\.|_{2,})/.test(clue)) W(c, 'deyim ipucunda boşluk (…) yok');
    if (c.mode === 'starts') {
      for (const a of c.alt ?? []) if (compact(a)[0] !== compact(c.answer)[0]) W(c, `alt "${a}" başka harfle başlıyor`);
    }
    // Harf içinde tekrar: cevap/alt biçimleri başka ipucuyla çakışmasın.
    if (!formsByLetter.has(c.letter)) formsByLetter.set(c.letter, new Map());
    const m = formsByLetter.get(c.letter);
    for (const f of acceptedForms(c)) {
      const other = m.get(f);
      if (other && other !== c) E(c, `aynı harfte tekrar eden cevap/alt "${f}" (${other.id ?? other.answer})`);
      else m.set(f, c);
    }
    const ck = `${c.letter}|${fold(clue)}`;
    if (cluesSeen.has(ck)) E(c, 'aynı ipucu metni tekrar');
    cluesSeen.set(ck, c);
  }

  // Sayımlar
  const per = {};
  for (const L of LETTERS) per[L] = { total: 0, starts: 0, contains: 0, d1: 0, d2: 0, d3: 0, cats: {} };
  const cats = {};
  const diffs = { 1: 0, 2: 0, 3: 0 };
  for (const c of clues) {
    const p = per[c.letter];
    if (!p) continue;
    p.total++;
    p[c.mode] = (p[c.mode] ?? 0) + 1;
    p[`d${c.difficulty}`]++;
    p.cats[c.category] = (p.cats[c.category] ?? 0) + 1;
    cats[c.category] = (cats[c.category] ?? 0) + 1;
    diffs[c.difficulty] = (diffs[c.difficulty] ?? 0) + 1;
  }
  if (!partial) {
    for (const L of LETTERS) {
      if (per[L].total < minPerLetter) errors.push(`${L}: ${per[L].total} ipucu (< ${minPerLetter})`);
      // Her zorluk ve kolay çark için yeterli: harf başına en az 15 kolay (1), 15 zor-ish (2–3).
      if (per[L].d1 < 15) warnings.push(`${L}: kolay ipucu az (${per[L].d1})`);
      if (per[L].d2 + per[L].d3 < 15) warnings.push(`${L}: orta/zor ipucu az (${per[L].d2 + per[L].d3})`);
    }
  }
  return { errors, warnings, per, cats, diffs, total: clues.length };
}

// Komut satırı
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let all = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    all = all.concat(Array.isArray(data) ? data : data.clues);
  }
  const partial = files.some((f) => !f.endsWith('clues.json'));
  const r = validate(all, { partial });
  if (!quiet) {
    console.log(`Toplam ${r.total} ipucu`);
    for (const L of LETTERS) {
      const p = r.per[L];
      if (!p.total && partial) continue;
      console.log(`${L.padEnd(2)} ${String(p.total).padStart(4)}  başlar ${p.starts} içerir ${p.contains}  zorluk ${p.d1}/${p.d2}/${p.d3}  ${Object.entries(p.cats).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    }
    console.log('Kategoriler:', JSON.stringify(r.cats));
    console.log('Zorluk:', JSON.stringify(r.diffs));
    for (const w of r.warnings) console.log(`UYARI ${w}`);
  }
  for (const e of r.errors) console.log(`HATA ${e}`);
  console.log(`${r.errors.length} hata, ${r.warnings.length} uyarı`);
  process.exit(r.errors.length ? 1 : 0);
}
