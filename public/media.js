// Gizli uyaran medyası: sunucu JSON'da cevabı değil opak bir adres (/api/media/<jeton>) verir; burada kimlikle indirilir.
// Adres sahibine bağlı, kısa ömürlü ve sınırlı kullanımlıdır (server/media-tokens.js). Aynı adres bir kez indirilir.
import { net } from './net.js';

const MEDIA_RE = /^\/api\/media\/[0-9a-f]{32}$/;
const cache = new Map(); // url -> Promise<Blob> (son birkaç adres)

export function fetchMedia(url) {
  if (typeof url !== 'string' || !MEDIA_RE.test(url)) return Promise.reject(new Error('Geçersiz medya adresi.'));
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token }),
    }).then((res) => {
      if (!res.ok) throw new Error(res.status === 404 ? 'Gösterim süresi geçti.' : 'Görsel/ses alınamadı.');
      return res.blob();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return p;
}

// Canvas'a çizilecek görsel (createImageBitmap; yoksa blob: adresli <img>).
export async function fetchBitmap(url) {
  const blob = await fetchMedia(url);
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(src), 1000);
  }
}

// <img> için blob: adresi (CSP img-src blob:). Çağıran işi bitince URL.revokeObjectURL ile bırakır.
export async function fetchObjectUrl(url) {
  return URL.createObjectURL(await fetchMedia(url));
}
