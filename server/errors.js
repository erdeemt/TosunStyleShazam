// Kullanıcıya gösterilebilir oyun hatası (Türkçe mesaj). Diğer hatalar "Bir şeyler ters gitti" olur.
export class GameError extends Error {}

// İstemciden gelen değerler için güvenli dönüştürücüler. JSON'dan gelen nesneler (ör. {"toString":1})
// String()/Number() ile TypeError fırlatır; bunlar sadece metin/sayıyı kabul eder.
export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
export const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// Kontrol, sıfır genişlikli ve yön değiştiren karakterler (görsel aldatma + JSON şişmesi) atılır.
const BAD_TEXT = new RegExp(`[${['0000-001f', '007f-009f', '200b-200f', '2028-202e', '2060-2069', 'feff-feff'].map((r) => r.split('-').map((h) => `\\u${h}`).join('-')).join('')}]`, 'g');

// Kullanıcı/host metnini güvenle kısalt: sadece metin, kötü karakterler atılır, boşluklar sadeleşir, en fazla `max` karakter.
export function cleanText(v, max = 100) {
  const s = str(v).replace(BAD_TEXT, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}
