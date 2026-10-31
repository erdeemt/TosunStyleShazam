// 🎵 Shazam online, ses vekili uçtan uca: 2 telefon (360 px), klipler /api/clip/<opak> adresinden gerçekten çalar,
// tur başında 3-2-1 sonrası kendiliğinden başlar; tarayıcı hiçbir CDN'e ses isteği atmaz; açılıştan önce hiçbir
// WS çerçevesinde / HTTP yanıtında / istek adresinde şarkı adı, sanatçı, CDN adresi yok. Ekran görüntüleri: test-results/shazam-secure/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from './qa-shazam-online-lib.mjs';

const SHOTS = fileURLToPath(new URL('../../test-results/shazam-secure/', import.meta.url));
let env;
before(async () => { mkdirSync(SHOTS, { recursive: true }); env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const shot = (p, label) => p.page.screenshot({ path: `${SHOTS}${label}.png`, fullPage: true });

// Ses öğesinin gerçekten çaldığını (medya saati ilerliyor) ve kaynağın vekil olduğunu bekle
async function waitPlaying(p, timeout = 15000) {
  await p.page.waitForFunction(() => {
    const a = window.tss?.media?.audio;
    return a && !a.paused && a.currentTime > 0.05 && /\/api\/clip\/[\w-]{22}$/.test(a.currentSrc);
  }, undefined, { timeout, polling: 20 });
}

test('2 telefon: klipler vekilden çalar, otomatik başlar; hiçbir trafikte cevap yok', async () => {
  const TR = Q.makeTracks(6);
  const ps = [await Q.phone(env, 'Ece', { hash: '?debug#/multi/shazam' }), await Q.phone(env, 'Can', { hash: '?debug#/multi/shazam' })];
  // HTTP yanıt gövdeleri (JSON/metin) ve başlıklar taranır
  const http = [];
  for (const p of ps) {
    p.page.on('response', async (r) => {
      const u = r.url();
      if (!u.startsWith(env.srv.url)) return;
      let body = '';
      try {
        const type = r.headers()['content-type'] ?? '';
        body = /json|text\/plain/.test(type) ? await r.text() : /audio/.test(type) ? (await r.body()).toString('latin1') : '';
      } catch { /* yönlendirme/iptal */ }
      http.push({ who: p.name, url: u, status: r.status(), headers: JSON.stringify(r.headers()), body, at: Date.now() });
    });
  }
  const [host, guest] = ps;
  // ?debug olmadan da çalışmalı; burada sadece window.tss için
  await host.page.waitForSelector('#shazam-online');
  const code = await Q.createRoom(host);
  await Q.joinCode(guest, code);
  await Q.waitNet(host.page, 'room.players.length === 2');
  await Q.injectTracks(host, TR);
  await Q.waitNet(guest.page, 'room.prep.trackCount === 6');
  await Q.setSetting(host, 'Şarkı sayısı', 3);
  await shot(guest, '00-lobi');
  await Q.start(host, ps);
  const playStart = Date.now();

  // Otomatik başlama: 3-2-1 sonrası, dokunmadan, iki telefonda da vekilden çalar
  await shot(guest, '01-geri-sayim');
  await Promise.all(ps.map((p) => waitPlaying(p)));
  await shot(guest, '02-caliyor');
  await Promise.all(ps.map((p) => Q.waitAutoPlayDone(p)));
  const v = (await Q.st(host.page)).view;
  const track = Q.trackOf(v, TR);
  assert.ok(track);

  // Misafir: yanlış → 1.5 sn klibi (yeni adres) ▶ ile çalar
  await Q.guess(guest, 'kesinlikle yanlış');
  await guest.page.waitForFunction(() => /1\.5 sn dinle/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? ''), undefined, { timeout: 6000 });
  const before = guest.clipReqs.length;
  await guest.page.click('#shazam-online .play-btn');
  await waitPlaying(guest);
  await shot(guest, '03-adim2-caliyor');
  assert.ok(guest.clipReqs.length > before || (await guest.page.evaluate(() => window.tss.media.audio.currentSrc)).includes('/api/clip/'));
  const dur = await guest.page.evaluate(() => window.tss.media.audio.duration);
  assert.ok(dur > 1.3 && dur < 1.8, `1.5 sn adımının klibi ${dur} sn (tam önizleme değil)`);
  await Q.waitAutoPlayDone(guest);

  // Host doğru bilir, misafir pes eder → açılış
  await Q.guess(host, track.title);
  await Q.giveUp(guest);
  await Q.waitNet(guest.page, "view.phase === 'reveal'");
  const revealAt = Date.now();
  await waitPlaying(guest); // açılışta sona kadar olan klip çalar
  await shot(guest, '04-acilis');
  const revealDur = await guest.page.evaluate(() => window.tss.media.audio.duration);
  assert.ok(revealDur > 15, `açılış klibi ${revealDur} sn`);

  // Tarayıcı hiçbir CDN'e ses isteği atmadı (kapak resimleri hariç; onlar açılışta)
  for (const p of ps) {
    const audioCdn = p.audioReqs.filter((u) => !/images|image-cdn|i\.scdn|ytimg/.test(u));
    assert.deepEqual(audioCdn, [], `${p.name} CDN'e ses isteği attı`);
    assert.ok(p.clipReqs.length >= 2, `${p.name} vekilden klip istemedi`);
    for (const u of p.clipReqs) assert.match(u, /\/api\/clip\/[\w-]{22}$/);
  }

  // Açılıştan önceki tüm trafik: WS çerçeveleri (öneri havuzu hariç) + HTTP yanıtları
  const needles = TR.flatMap((t) => [t.title, t.artist, t.spotifyId, t.audio, t.cover]).concat(['dzcdn', 'scdn', 'ytId']);
  for (const p of ps) {
    for (const raw of p.frames) {
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.t === 'shared' || (m.t === 'view' && m.view?.phase !== 'play')) continue;
      if (m.t === 'room' && m.room?.phase !== 'playing') continue; // lobide host kendi listesini zaten biliyor
      if (m.view?.me) m.view.me.guesses = m.view.me.guesses.filter((g) => !g.ok);
      const s = JSON.stringify(m);
      for (const n of needles) assert.ok(!s.includes(n), `${p.name} WS (${m.t}) içinde "${n}"`);
    }
  }
  for (const r of http.filter((x) => x.at >= playStart && x.at < revealAt)) {
    const s = `${r.url} ${r.headers} ${r.body}`;
    for (const n of needles) assert.ok(!s.includes(n), `${r.who} HTTP ${r.url} içinde "${n}"`);
  }
  for (const p of ps) assert.deepEqual(Q.realErrors(p).filter((e) => !/status of 5\d\d/.test(e)), [], `${p.name} hataları`);
});
