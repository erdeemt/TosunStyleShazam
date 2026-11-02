// 📸 Ne Zaman Nerede? — ortak saf hesaplar (sunucu puanlar, istemci sadece gösterim için kullanır). Bkz. PLAN.md §4.10.
//
// Tur puanı 0–1000 = yer 0–500 + yıl 0–500.
//   yer = 500 · exp(−d / k)   d: büyük daire mesafesi (km), k sete göre (dünya 1500 km, Türkiye 150 km, Eski İstanbul 3 km)
//   yıl = 500 · exp(−|Δ| / 12) Δ: yıl farkı → tam 500, 5 yıl ≈ 330, 20 yıl ≈ 94
// Her iki parça ayrı ayrı tam sayıya yuvarlanır.

export const YEAR_MIN = 1840;
export const YEAR_MAX = 2020;
export const YEAR_K = 12;
export const PLACE_MAX = 500;
export const YEAR_MAX_PTS = 500;
export const ROUND_MAX = PLACE_MAX + YEAR_MAX_PTS;
export const DAILY_ROUNDS = 5;
export const ROUND_OPTIONS = [3, 5, 10];
export const TIME_OPTIONS = [30, 60, 90]; // sn (çok oyunculu)

// Mesafe ölçeği (km): "doğru şehir" tahmini dünya modunda ~450+ alsın (50 km → 483, 150 km → 452).
export const KM_SCALE = { world: 1500, turkiye: 150, istanbul: 3 };

// Seçilebilir setler. scale: hangi mesafe ölçeği. Filtreler sunucuda (fotoğraf etiketleri istemciye gitmez).
export const SETS = [
  { id: 'karisik', name: 'Karışık', icon: '🌍', hint: 'Dünyanın her yerinden', scale: 'world' },
  { id: 'turkiye', name: 'Türkiye', icon: '🇹🇷', hint: 'Sadece Türkiye', scale: 'turkiye' },
  { id: 'istanbul', name: 'Eski İstanbul', icon: '🕌', hint: 'Sokak sokak İstanbul', scale: 'istanbul' },
  { id: 'era-1850-1900', name: '1850–1900', icon: '🎩', hint: 'İlk fotoğraflar', scale: 'world' },
  { id: 'era-1900-1945', name: '1900–1945', icon: '🚂', hint: 'Savaşlar arası', scale: 'world' },
  { id: 'era-1945-1980', name: '1945–1980', icon: '📻', hint: 'Savaş sonrası', scale: 'world' },
  { id: 'era-1980-2015', name: '1980–2015', icon: '📼', hint: 'Yakın geçmiş', scale: 'world' },
  { id: 'tema-savas', name: 'Savaş', icon: '🪖', hint: 'Cepheler ve izleri', scale: 'world' },
  { id: 'tema-ulasim', name: 'Ulaşım', icon: '🚋', hint: 'Köprü, tren, vapur', scale: 'world' },
  { id: 'tema-spor', name: 'Spor', icon: '🏟️', hint: 'Stadyumlar, olimpiyatlar', scale: 'world' },
  { id: 'tema-sehir', name: 'Şehir', icon: '🏙️', hint: 'Meydanlar, caddeler', scale: 'world' },
  { id: 'tema-icat', name: 'İcat & Yapı', icon: '💡', hint: 'Fuarlar, inşaatlar', scale: 'world' },
];
export const SET_IDS = new Set(SETS.map((s) => s.id));
export const setById = (id) => SETS.find((s) => s.id === id) ?? SETS[0];
export const scaleOf = (setId) => KM_SCALE[setById(setId).scale];

const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

// Büyük daire (haversine) mesafesi, km.
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const placePoints = (km, scaleKm) => Math.round(PLACE_MAX * Math.exp(-Math.max(0, km) / scaleKm));
export const yearPoints = (dy) => Math.round(YEAR_MAX_PTS * Math.exp(-Math.abs(dy) / YEAR_K));

// guess: { lat, lon, year } (temizlenmiş) ya da null (tahmin yok → 0). truth: { lat, lon, year }.
export function scoreRound(guess, truth, scaleKm) {
  if (!guess) return { km: null, dy: null, place: 0, yearPts: 0, score: 0 };
  const km = distanceKm(guess, truth);
  const dy = guess.year - truth.year;
  const place = placePoints(km, scaleKm);
  const yp = yearPoints(dy);
  return { km: Math.round(km * 1000) / 1000, dy, place, yearPts: yp, score: place + yp };
}

// Boylamı [-180, 180) aralığına sar (harita yatayda tekrar ettiği için 200° gibi değerler gelebilir).
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// İstemciden gelen tahmini doğrula: sadece sayı (ya da sayı metni), aralık dışı reddedilir (enlem) / sarılır (boylam).
// Geçersizse null döner (çağıran hata verir).
export function cleanGuess(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  const lat = n(raw.lat);
  const lon = n(raw.lon);
  const year = n(raw.year);
  if (![lat, lon, year].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || Math.abs(lon) > 540) return null;
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(wrapLon(lon) * 1e5) / 1e5, year };
}

// Bitiş unvanı: tur başına ortalama puana göre.
export const TITLES = [
  { min: 900, icon: '🕰️', name: 'Zaman Yolcusu' },
  { min: 750, icon: '🧭', name: 'Arşiv Kurdu' },
  { min: 600, icon: '📚', name: 'Tarih Meraklısı' },
  { min: 450, icon: '🗺️', name: 'Gezgin' },
  { min: 300, icon: '🎒', name: 'Turist' },
  { min: 150, icon: '🌫️', name: 'Yolunu Kaybetmiş' },
  { min: 0, icon: '🙈', name: 'Pusulasız' },
];
export function titleFor(total, rounds) {
  const avg = rounds > 0 ? total / rounds : 0;
  return TITLES.find((t) => avg >= t.min) ?? TITLES.at(-1);
}

// Gösterim: "1.234 km" / "850 m"; yıl farkı "7 yıl" / "tam isabet".
export function fmtKm(km) {
  if (km == null) return '—';
  if (km < 1) return `${Math.round(km * 1000).toLocaleString('tr-TR')} m`;
  return `${(km < 10 ? Math.round(km * 10) / 10 : Math.round(km)).toLocaleString('tr-TR')} km`;
}
export const fmtDy = (dy) => (dy == null ? '—' : dy === 0 ? 'tam isabet' : `${Math.abs(dy)} yıl`);

// Sonuç paylaşımı için kare: tur puanına göre.
export const squareOf = (s) => (s >= 850 ? '🟩' : s >= 600 ? '🟨' : s >= 300 ? '🟧' : '🟥');
