// Kullanıcıya gösterilebilir oyun hatası (Türkçe mesaj). Diğer hatalar "Bir şeyler ters gitti" olur.
export class GameError extends Error {}

// İstemciden gelen değerler için güvenli dönüştürücüler. JSON'dan gelen nesneler (ör. {"toString":1})
// String()/Number() ile TypeError fırlatır; bunlar sadece metin/sayıyı kabul eder.
export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
export const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
