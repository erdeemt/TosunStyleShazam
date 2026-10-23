// QA (GERÇEK AĞ): Shazam online — host lobide gerçek Deezer / Spotify / YouTube linklerini yapıştırır; misafir telefonları
// şarkıyı gerçekten yükleyip çalıyor mu ("0.5 sn dinle" → çalıyor → durur), açılışta kapak/başlık geliyor mu.
// `npm run e2e` bunu ÇALIŞTIRMAZ (adında .test. yok). Elle: node --test tests/e2e/qa-shazam-online-real-play.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

const LINKS = {
  deezerAlbum: 'https://www.deezer.com/tr/album/302127',
  spotifyPlaylist: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  youtubeVideo: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  youtubeVideo2: 'https://youtu.be/kJQP7kiw5Fk',
  youtubePlaylist: 'https://www.youtube.com/playlist?list=PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj',
  deezerBigPlaylist: 'https://www.deezer.com/tr/playlist/1249073201', // 51 şarkı (8 KB mesaj sınırı denemesi)
};

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

// ?debug → window.tss = { state, media, yt } (sayfanın kendi hata ayıklama kancası)
async function realPhone(name, desktop = false) {
  // Gerçek CSP ile (bypassCSP yok): kapak/ses alan adları CSP'ye takılıyor mu görülsün
  const ctx = await env.browser.newContext(desktop ? { viewport: { width: 1280, height: 800 } } : { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const p = await Q.phone(env, name, { desktop, hash: null, ctx });
  // Q.phone sahte CDN yanıtları kurar; gerçek ağ için kaldır
  await p.ctx.unrouteAll({ behavior: 'ignoreErrors' });
  await p.page.goto(`${env.srv.url}/?debug#/multi/shazam`);
  await p.page.click('.mode-card[data-mode="online"]');
  await p.page.fill('#shazam-online input[placeholder="Takma adın"]', name);
  return p;
}

const mediaInfo = (p) => p.page.evaluate(() => {
  const m = window.tss.media;
  return {
    kind: m.kind,
    audioTime: m.kind === 'audio' ? m.audio.currentTime : null,
    audioSrc: m.kind === 'audio' ? m.audio.src.slice(0, 60) : null,
    ytState: m.kind === 'youtube' ? window.tss.yt.player?.getPlayerState?.() : null,
    ytTime: m.kind === 'youtube' ? window.tss.yt.player?.getCurrentTime?.() : null,
  };
});

async function playRounds(host, guests, n, tracks, label) {
  const g1 = guests[0];
  const kinds = new Set();
  for (let r = 1; r <= n; r++) {
    await Q.waitNet(g1.page, `view.round === ${r} && view.phase === 'play'`, 30000);
    const v = (await Q.st(g1.page)).view;
    const t = tracks.find((x) => (v.media.ytId && x.ytId === v.media.ytId) || (v.media.audio && x.audio === v.media.audio));
    console.log(`tur ${r}:`, v.media.ytId ? `YouTube ${v.media.ytId}` : 'ses', '→', t ? `${t.title} — ${t.artist}` : '??');
    // Şarkı hazır olunca kendiliğinden 3-2-1 + çalma: iki misafiri aynı anda izle
    await Promise.all(guests.map(async (p) => {
      const sawCount = await p.page.waitForFunction(() => /Hazır ol/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? ''), undefined, { timeout: 25000, polling: 50 }).then(() => true).catch(() => false);
      const lbl0 = await p.page.locator('#shazam-online .play-label').textContent().catch(() => '');
      soft(sawCount, `tur ${r} ${p.name}: otomatik geri sayım yok (etiket: ${lbl0})`);
      if (!sawCount) { await Q.shot(p, `real-${label}-r${r}-${p.name}-no-countdown`); return; }
      const started = await p.page.waitForFunction(() => { const m = window.tss.media; return m.kind === 'youtube' ? window.tss.yt.player?.getPlayerState?.() === 1 : !m.audio.paused; }, undefined, { timeout: 12000, polling: 20 }).then(() => true).catch(() => false);
      soft(started, `tur ${r} ${p.name}: geri sayımdan sonra medya çalmaya başlamadı`);
      const during = await mediaInfo(p);
      kinds.add(during.kind);
      if (r === 1 && p === g1) await Q.shot(p, `real-${label}-r1-autoplaying-guest`);
      const done = await p.page.waitForFunction(() => / sn dinle$/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? '') && !document.querySelector('#shazam-online .play-btn.playing'), undefined, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
      soft(done, `tur ${r} ${p.name}: klip durmadı / etiket "sn dinle" olmadı`);
      await p.page.waitForTimeout(300);
      const after = await mediaInfo(p);
      const t0 = during.kind === 'audio' ? during.audioTime : during.ytTime;
      const t1 = during.kind === 'audio' ? after.audioTime : after.ytTime;
      console.log(`  ${p.name}: ${during.kind} ${t0?.toFixed?.(2)} → ${t1?.toFixed?.(2)} (yt durum ${after.ytState})`);
      soft(t1 - t0 >= 0 && t1 - t0 < 1.0 && t1 > 0, `tur ${r} ${p.name}: 0.5 sn klipte medya ${t0} → ${t1}`);
    }));
    // ▶ ile tekrar dinleme (Misafir1)
    await g1.page.click('#shazam-online .play-btn');
    const replay = await g1.page.waitForSelector('#shazam-online .play-btn.playing', { timeout: 5000 }).then(() => true).catch(() => false);
    soft(replay, `tur ${r}: ▶ tekrar dinleme çalmadı`);
    // Misafir1 doğru bilir, diğerleri geçer/pes eder
    if (t) await Q.guess(g1, t.title); else await Q.skip(g1);
    for (const p of [...guests.slice(1), host]) {
      const vv = (await Q.st(p.page)).view;
      if (!vv.me.done) await Q.giveUp(p);
    }
    if (!(await Q.st(g1.page)).view.me.done) await Q.giveUp(g1);
    await Q.waitNet(g1.page, "view.phase === 'reveal'");
    await g1.page.waitForTimeout(2500);
    const cover = await g1.page.evaluate(() => { const i = document.querySelector('#shazam-online img.ol-cover'); return i ? { src: i.src.slice(0, 70), ok: i.complete && i.naturalWidth > 0 } : null; });
    const title = await g1.page.locator('#shazam-online .reveal-title').textContent();
    console.log(`  açılış: ${title} | kapak`, cover, '| tekrar çalıyor mu', JSON.stringify(await mediaInfo(g1)));
    soft(cover?.ok, `tur ${r}: açılışta kapak yok/yüklenmedi (${JSON.stringify(cover)})`);
    await Q.shot(g1, `real-${label}-r${r}-reveal-guest`);
    await host.page.click(`button:has-text("${r === n ? 'Sonuçları göster' : 'Sonraki şarkı'}")`);
  }
  return kinds;
}

async function loadLinks(host, links, label) {
  await host.page.fill('#shazam-online textarea', links.join('\n'));
  await host.page.click('#shazam-online button:has-text("Linkleri yükle")');
  // Yükleme + otomatik gönderim bitene kadar
  await host.page.waitForFunction(() => {
    const t = document.getElementById('shazam-online').innerText;
    return !/yükleniyor…|Yükleniyor…|Gönderiliyor/.test(t);
  }, undefined, { timeout: 120000, polling: 500 });
  await host.page.waitForTimeout(1500);
  const rows = await host.page.locator('#shazam-online .sources li').allInnerTexts();
  const s = await Q.st(host.page);
  console.log(`[${label}] kaynaklar:`, rows.map((r) => r.replace(/\s+/g, ' ')), '| odada:', s.room?.prep?.trackCount, '| bağlı:', s.connected);
  await Q.shot(host, `real-${label}-lobby-host`);
  return { rows, count: s.room?.prep?.trackCount ?? 0 };
}

test('gerçek linkler: Deezer albüm + Spotify playlist + YouTube video/playlist → misafirlerde çalma', { timeout: 600000 }, async () => {
  const host = await realPhone('Host', true);
  const code = await Q.createRoom(host);
  const g1 = await realPhone('Misafir1');
  const g2 = await realPhone('Misafir2');
  await Q.joinCode(g1, code);
  await Q.joinCode(g2, code);

  const a = await loadLinks(host, [LINKS.deezerAlbum, LINKS.spotifyPlaylist, LINKS.youtubeVideo, LINKS.youtubeVideo2, LINKS.youtubePlaylist], 'mixed');
  const localByKind = await host.page.evaluate(() => window.tss.state.sources.map((s) => ({
    url: s.url, name: s.name, error: s.error ?? null, n: s.tracks.length,
    playable: s.tracks.filter((t) => t.ytId || t.audio).length,
  })));
  console.log('host yerel kaynaklar:', JSON.stringify(localByKind, null, 1));
  const expected = localByKind.reduce((n, s) => n + s.playable, 0);
  soft(a.count > 0, 'odaya hiç şarkı gitmedi');
  soft(a.count >= expected * 0.9, `odaya giden ${a.count}, çalınabilir yerel ${expected} (fark kaynaklar arası tekrarlar olmalı)`); console.log(`odaya giden ${a.count} / yerel ${expected} (kaynaklar arası tekrarlar tek sayılır)`);
  for (const s of localByKind) soft(!s.error, `kaynak hatası: ${s.url} → ${s.error}`);
  await Q.shot(g1, 'real-mixed-lobby-guest');

  await Q.setSetting(host, 'Şarkı sayısı', 5);
  await Q.setSetting(host, 'Tur süresi', 180);
  await Q.start(host, [host, g1, g2]);

  const tracks = await host.page.evaluate(() => window.tss.state.sources.flatMap((s) => s.tracks));
  const kinds = await playRounds(host, [g1, g2], 5, tracks, 'mix');
  console.log('çalınan türler:', [...kinds]);
  await Q.waitNet(g1.page, "room.phase === 'over'");
  await Q.shot(g1, 'real-over-guest');

  // YouTube: linkten yükleme sunucuda bozuk (yukarıda); oynatıcı yolunu yine de dene → ytId'leri doğrudan prep ile ver
  await host.page.click('button:has-text("Bekleme odasına dön")');
  await Q.waitNet(host.page, "room.phase === 'lobby'");
  // Gerçek YouTube linkleri arayüzden (yukarıda yüklendi): sadece YouTube kaynaklarını bırak ve odaya gönder
  for (const name of ['Discovery', 'Today']) {
    const row = host.page.locator('#shazam-online .sources li', { hasText: name });
    if (await row.count()) await row.locator('button').click();
  }
  await host.page.click('#shazam-online button:has-text("Odaya gönder")');
  await host.page.waitForFunction(() => !/Gönderiliyor/.test(document.getElementById('shazam-online').innerText), undefined, { timeout: 30000 });
  await host.page.waitForTimeout(1000);
  const ytCount = (await Q.st(host.page)).room.prep.trackCount;
  const YT = await host.page.evaluate(() => window.tss.state.sources.flatMap((s) => s.tracks).filter((t) => t.ytId));
  console.log('YouTube odası:', ytCount, 'şarkı; yerelde YouTube', YT.length, YT.slice(0, 4).map((t) => `${t.ytId} ${t.title} — ${t.artist}`));
  await Q.shot(host, 'real-yt-lobby-host');
  soft(ytCount >= 4, `YouTube linklerinden odaya ${ytCount} şarkı gitti`);
  await Q.setSetting(host, 'Şarkı sayısı', 3);
  await Q.start(host, [host, g1, g2]);
  const ytKinds = await playRounds(host, [g1, g2], Math.min(3, ytCount - 3), YT, 'yt');
  soft(ytKinds.has('youtube'), `YouTube oynatıcı kullanılmadı: ${[...ytKinds]}`);
  await Q.waitNet(g1.page, "room.phase === 'over'");

  // 51 şarkılık Deezer playlist (uzun önizleme adresleri → 25'lik parça 8 KB'ı aşar mı?)
  await host.page.click('button:has-text("Bekleme odasına dön")');
  await Q.waitNet(host.page, "room.phase === 'lobby'");
  const beforeBig = (await Q.st(host.page)).room.prep.trackCount;
  const b = await loadLinks(host, [LINKS.deezerBigPlaylist], 'deezer51');
  const bigLocal = await host.page.evaluate(() => window.tss.state.sources.find((s) => /1249073201/.test(s.url))?.tracks.filter((t) => t.audio).length);
  const allLocal = await host.page.evaluate(() => window.tss.state.sources.flatMap((s) => s.tracks).filter((t) => t.ytId || t.audio).length);
  console.log('51lik: önce', beforeBig, 'sonra', b.count, 'yerel çalınabilir', bigLocal);
  soft(b.count >= Math.min(300, allLocal) - 5, `büyük Deezer playlist odaya eksik gitti: yerelde ${allLocal} çalınabilir şarkı → odada ${b.count}`);
  const prepSizes = host.sent.filter((f) => f.includes('"t":"prep"')).map((f) => Buffer.byteLength(f));
  console.log('prep mesajları:', prepSizes.length, 'en büyük', Math.max(...prepSizes), 'bayt; host soketleri', host.sockets.length, 'kapanan', host.sockets.filter((x) => x.closed).length);
  soft(Math.max(...prepSizes) <= 8192 && host.sockets.length === 1, 'host bağlantısı koptu veya 8 KB üstü mesaj');
  const closes = host.frames.length;
  console.log('host çerçeve sayısı', closes);

  for (const p of [host, g1, g2]) {
    const errs = Q.realErrors(p);
    const e2 = errs.filter((e) => !/compute-pressure|Permissions policy/.test(e));
    if (e2.length) console.log(`${p.name} konsol:`, e2.slice(0, 8));
  }
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of [host, g1, g2]) await p.ctx.close();
  assert.deepEqual(issues, []);
});
