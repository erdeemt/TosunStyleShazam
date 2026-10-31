// 🎵 Shazam online testleri: hangi şarkının çaldığını bilmek için. İstemciye şarkı kimliği gitmez (opak klip adresi);
// test sunucusunda (TEST_MODE=1) tur anahtarı oyun anahtarı + başlıktan türetilir (server/games/shazam.js testRoundKey).
// Üretimde anahtar rastgeledir. SHAZAM_OPAQUE_KEYS=1 ile test sunucusunda da rastgele.
import { createHash } from 'node:crypto';

export const roundKeyOf = (gameKey, title) => createHash('sha256').update(`tss-test|${gameKey}|${title}`).digest('hex').slice(0, 12);

// Görünümdeki turun şarkısı (verilen listeden; başlık sunucunun temizlediği hâliyle eşleşmeli).
export const trackOfView = (view, tracks) => (view?.media ? tracks.findLast((t) => roundKeyOf(view.gameKey, t.title) === view.media.key) : undefined);

// Ses vekili oturumu: bot kimliğiyle çerez al (tarayıcıdaki ensureClipSession gibi). Döner "tss_clip=..." başlık değeri.
export async function clipCookie(baseUrl, bot) {
  const res = await fetch(`${baseUrl}/api/clip-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: bot.playerId, token: bot.token }),
  });
  if (!res.ok) throw new Error(`clip-session ${res.status}`);
  return String(res.headers.get('set-cookie')).split(';')[0];
}

export async function getClip(baseUrl, path, cookie, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}
