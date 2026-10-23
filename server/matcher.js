// Şarkı adı tahmin kontrolü + aynı şarkı anahtarı. public/shazam.js'teki tek oyunculu sürümle BİREBİR aynı
// (oradan kopyalandı; online modda karar sunucuda verilir). Değiştirirsen ikisini birlikte değiştir.

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function norm(s) {
  return (s ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (c) => TR_MAP[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s[-–—]\s.*\b(remaster\w*|version|edit|mix|live|mono|stereo|from|radio|acoustic|akustik|featured|soundtrack|ost|theme)\b.*$/, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ') // Türkçe katlandıktan sonra her dildeki harfler kalır
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function answerCandidates(track) {
  const raw = [track.title, ...(track.alt ?? [])];
  const out = new Set();
  for (const r of raw) {
    const n = norm(r);
    if (n) { out.add(n); out.add(n.replace(/^the /, '')); }
  }
  return [...out].filter(Boolean);
}

function isCorrect(guess, track) {
  const g = norm(guess);
  if (!g) return false;
  const gCompact = g.replace(/ /g, '');
  const artistLen = norm(track.artist ?? '').length;
  for (const c of answerCandidates(track)) {
    if (g === c || gCompact === c.replace(/ /g, '')) return true;
    // Ufak yazım hataları: kısa isimlerde tam eşleşme, 6+ harfte 1, 9+ harfte 2 hata, uzunlarda ~%20.
    const maxEdits = Math.max(c.length >= 9 ? 2 : c.length >= 6 ? 1 : 0, Math.floor(c.length * 0.2));
    if (maxEdits && levenshtein(g, c) <= maxEdits) return true;
    // "tarkan şımarık" gibi sanatçı + şarkı yazılmışsa
    if (c.length >= 3 && ` ${g} `.includes(` ${c} `) && g.length <= c.length + artistLen + 3) return true;
    // Uzun isimlerin büyük kısmı yazılmışsa ("bohemian rhapsody" yerine "bohemian rhaps")
    if (g.length >= 6 && c.startsWith(g) && g.length >= c.length * 0.6) return true;
  }
  return false;
}

function trackKey(t) {
  const artist = norm((t.artist ?? '').split(/,|&|\s+(?:feat\.?|ft\.?|x|ve|and|with)\s+/i)[0]);
  const title = norm(t.title);
  return artist && title ? `${title.replace(/ /g, '')}|${artist.replace(/ /g, '')}` : t.id ?? `src:${t.ytId ?? t.audio ?? t.title}`;
}

export { norm, isCorrect, trackKey };
