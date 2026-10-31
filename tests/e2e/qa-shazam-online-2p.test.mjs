// QA: Shazam online — 2 telefon (masaüstü host + 360 px misafir). Gerçek çalma (yerel WAV), aşamalar, yanlış/doğru,
// geç, pes et, çalarken geç/tahmin, süre dolması, açılış ekranı, final, bekleme odasına dönüş ve tekrar oyun.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 0.5 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('2 telefon: çalma, aşamalar, puanlar, süre dolması, final, tekrar oyun', async () => {
  const TR = Q.makeTracks(7);
  const { ps, host } = await Q.room(env, ['Ali', 'Ayşe'], { desktopHost: true });
  const [, g] = ps;
  // < 3 şarkıyla başlatma
  await Q.injectTracks(host, TR.slice(0, 2));
  await Q.waitNet(g.page, 'room.prep && room.prep.trackCount === 2');
  await host.page.click('#shazam-online button:has-text("Oyunu başlat")');
  await host.page.waitForTimeout(300);
  const t1 = await host.page.locator('#toast').textContent();
  soft(/en az \d şarkı/.test(t1), `<3 şarkıyla başlat toast: ${t1}`);
  soft((await Q.st(host.page)).room.phase === 'lobby', '<3 şarkıyla oyun başladı');
  await Q.shot(host, '2p-00-lobby-2songs-host');
  await Q.shot(g, '2p-00-lobby-2songs-guest');
  // Daha fazla şarkı ekle (biri tekrar)
  await Q.injectTracks(host, TR.slice(1), 'QA Liste 2'); // biri tekrar
  await Q.waitNet(g.page, 'room.prep.trackCount === 7');
  const gtext = await g.page.locator('#shazam-online').textContent();
  soft(/Odada 7 şarkı/.test(gtext), `misafir özet: ${gtext.slice(0, 200)}`);
  await Q.setSetting(host, 'Tur süresi', 45); // 45 sn * 0.5 = 22 sn
  const opts = await host.page.locator('#shazam-online label', { hasText: 'Şarkı sayısı' }).locator('option').allTextContents();
  soft(opts[0] === '3 şarkı', `şarkı sayısı seçenekleri: ${opts}`);
  await Q.setSetting(host, 'Şarkı sayısı', 5);
  await Q.shot(host, '2p-01-lobby-host');
  await Q.shot(g, '2p-01-lobby-guest');
  console.log('bilgi — 44 px altı düğmeler (lobi):', JSON.stringify(await Q.smallButtons(g.page)));
  await Q.start(host, ps);

  // ---------- Tur 1: gerçek çalma ----------
  let s = await Q.st(g.page);
  soft(s.view.totalRounds === 4, `totalRounds ${s.view.totalRounds}`);
  // Şarkı hazır olunca kendiliğinden 3-2-1 → çalma (butona basmadan)
  const sawCount = await g.page.waitForFunction(() => /Hazır ol/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? '') && document.querySelector('#shazam-online .play-count'), undefined, { timeout: 10000, polling: 50 }).then(() => true).catch(() => false);
  soft(sawCount, 'otomatik 3-2-1 geri sayımı görünmedi ("Hazır ol…")');
  await Q.shot(g, '2p-10-auto-countdown-guest');
  const autoPlayed = await g.page.waitForFunction(() => { const b = document.querySelector('#shazam-online .play-btn'); return b?.classList.contains('playing') && !document.querySelector('#shazam-online .play-count'); }, undefined, { timeout: 6000, polling: 20 }).then(() => true).catch(() => false);
  soft(autoPlayed, 'geri sayımdan sonra kendiliğinden çalmadı');
  await Q.shot(g, '2p-11-autoplaying-guest');
  await Q.waitAutoPlayDone(g);
  const label = await g.page.locator('#shazam-online .play-label').textContent();
  soft(/^0\.5 sn dinle$/.test(label.trim()), `ilk çalmadan sonra etiket: ${label}`);
  soft((await Q.overflow(g.page)).scrollW <= 360, `taşma: ${JSON.stringify(await Q.overflow(g.page))}`);
  const small = await Q.smallButtons(g.page);
  soft(small.filter((x) => x.t !== 'Şarkının adı ne? (boş Enter = çal)').length === 0, `44 px altı düğmeler (oyun): ${JSON.stringify(small)}`);
  // ▶ ile tekrar dinleme (geri sayım yok)
  await g.page.click('#shazam-online .play-btn');
  await g.page.waitForSelector('#shazam-online .play-btn.playing', { timeout: 2000 });
  soft(await g.page.locator('#shazam-online .play-count').count() === 0, 'tekrar dinlemede yine geri sayım var');
  await Q.waitAutoPlayDone(g, 5000);

  // Boş Enter = çal
  await g.page.click('#ol-guess');
  await g.page.press('#ol-guess', 'Enter');
  await g.page.waitForSelector('#shazam-online .play-btn.playing', { timeout: 3000 }).catch(() => soft(false, 'boş Enter çalmadı'));
  await g.page.waitForSelector('#shazam-online .play-btn:not(.playing)', { timeout: 4000 });

  // Yanlış tahmin → 1.5 sn
  await Q.guess(g, 'kesinlikle yanlış');
  s = await Q.st(g.page);
  soft(s.view.me.stage === 1, `yanlış sonrası stage ${s.view.me.stage}`);
  // Yeni adımın klibi sunucudan yeni (opak) adresle yüklenir: kısa bir "yükleniyor" olabilir
  await g.page.waitForFunction(() => /1\.5 sn dinle/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? ''), undefined, { timeout: 4000 })
    .catch(() => soft(false, 'yanlış sonrası etiket 1.5 değil'));
  soft((g.clipReqs ?? []).length > 0 && g.audioReqs.filter((u) => /dzcdn|scdn/.test(u) && !/images|image/.test(u)).length === 0, `ses vekilden gelmeli (klip ${g.clipReqs?.length ?? 0}, CDN ses ${g.audioReqs.length})`);
  soft(/kesinlikle yanlış/.test(await g.page.locator('#shazam-online .guesses').textContent()), 'yanlış tahmin listede yok');
  // Host ekranında misafirin tahmin metni görünmemeli, ilerlemesi görünmeli
  await host.page.waitForTimeout(200);
  const hostText = await host.page.locator('#shazam-online').textContent();
  soft(!/kesinlikle yanlış/.test(hostText), 'host ekranında misafirin tahmini görünüyor');
  soft(/1\.5 sn/.test(hostText), 'host ekranında misafirin ilerlemesi yok');
  soft(!host.frames.some((f) => f.includes('kesinlikle yanlış')), 'misafir tahmin metni host WS çerçevesinde');

  // Geç → 5 sn; 5 sn klip çalarken Geç'e bas → çal düğmesi takılı kalıyor mu?
  await Q.skip(g);
  await g.page.waitForSelector('#shazam-online .play-btn:not([disabled])');
  await g.page.click('#shazam-online .play-btn');
  await g.page.waitForSelector('#shazam-online .play-btn.playing');
  await g.page.waitForTimeout(400);
  await Q.skip(g); // çalarken geç → 10 sn
  await g.page.waitForTimeout(1500);
  const stuck = await g.page.evaluate(() => { const b = document.querySelector('#shazam-online .play-btn'); return { disabled: b.disabled, playing: b.classList.contains('playing') }; });
  await Q.shot(g, '2p-12-after-skip-while-playing');
  soft(!stuck.disabled && !stuck.playing, `çalarken Geç → çal düğmesi takıldı: ${JSON.stringify(stuck)}`);

  // Host doğru bilir (ilk adımda) → 5+1
  const tr = Q.trackOf((await Q.st(host.page)).view, TR);
  soft(Q.leaks(g, tr, 1).length === 0, `sızıntı: ${Q.leaks(g, tr, 1)}`);
  soft(!(await g.page.locator('#shazam-online').textContent()).includes(tr.title), 'açılıştan önce başlık ekranda');
  await Q.guess(host, tr.title.toLocaleLowerCase('tr'));
  s = await Q.st(host.page);
  soft(s.view.me.won && s.view.me.points === 6, `host puan ${s.view.me.points} (beklenen 6)`);
  await Q.shot(host, '2p-13-host-done-waiting');
  // Misafir: 10 sn'de Geç → 20 sn (son adımda "Geç" yok, "🏳️ Pes et" her adımda)
  await Q.skip(g); // → 20 sn
  soft(await g.page.locator('#shazam-online .guess-form button:has-text("Geç")').count() === 0, 'son adımda hâlâ Geç var');
  soft(await g.page.locator('#shazam-online button:has-text("Pes et")').count() === 1, 'son adımda Pes et yok');
  await Q.giveUp(g);
  soft(g.dialogs.some((d) => /pas geçmek/.test(d)), `Pes et onay sormadı: ${g.dialogs}`);
  await Q.waitNet(g.page, "view.phase === 'reveal'");
  await g.page.waitForSelector('#shazam-online .reveal-title');
  await g.page.waitForTimeout(600);
  await Q.shot(g, '2p-14-reveal-guest');
  await Q.shot(host, '2p-14-reveal-host');
  const rv = await g.page.locator('#shazam-online').textContent();
  soft(rv.includes(tr.title) && rv.includes(tr.artist), 'açılışta başlık/sanatçı yok');
  soft(await g.page.locator('#shazam-online img.ol-cover').count() === 1, 'açılışta kapak yok');
  const coverOk = await g.page.evaluate(() => { const i = document.querySelector('img.ol-cover'); return i && i.complete && i.naturalWidth > 0; });
  soft(coverOk, 'kapak yüklenmedi');
  soft(/\+6/.test(await host.page.locator('#shazam-online .player-list').textContent()), 'açılışta host +6 görünmüyor');
  soft(await g.page.locator('button:has-text("Sonraki şarkı")').count() === 0, 'misafirde Sonraki şarkı var');
  soft(/Bu sefer olmadı/.test(rv), 'açılışta misafire "✗ Bu sefer olmadı" yok');
  soft(/kendiliğinden/.test(rv), 'misafire otomatik geçiş ipucu yok');
  soft(/Bildin! \+6/.test(await host.page.locator('#shazam-online').textContent()), 'açılışta host "✓ Bildin! +6" yok');
  // Misafir aksiyonu "next" reddedilir
  await g.page.evaluate(async () => { const { net } = await import('/net.js'); net.action({ type: 'next' }); });
  await g.page.waitForTimeout(300);
  soft((await Q.st(g.page)).view.round === 1, 'misafir next ile tur geçti');

  // ---------- Tur 2: süre dolsun (9 sn) ----------
  await host.page.click('button:has-text("Sonraki şarkı")');
  await Q.waitNet(g.page, "view.round === 2 && view.phase === 'play'");
  await g.page.waitForSelector('#shazam-online .play-btn:not([disabled])');
  await Q.shot(g, '2p-20-round2');
  await Q.waitNet(g.page, "view.phase === 'reveal'", 40000);
  s = await Q.st(g.page);
  soft(s.view.players.every((p) => p.roundPoints === 0), 'süre dolunca puan verildi');
  await Q.shot(g, '2p-21-timeout-reveal');

  // ---------- Tur 3-4: misafir 2. adımda bilir; host aynı adımda bilir (bonus yok) ----------
  for (const r of [3, 4]) {
    await host.page.click('button:has-text("Sonraki şarkı"), button:has-text("Sonuçları göster")');
    await Q.waitNet(g.page, `view.round === ${r} && view.phase === 'play'`);
    const t = Q.trackOf((await Q.st(g.page)).view, TR);
    await Q.skip(g);
    await Q.guess(g, t.title);
    await Q.skip(host);
    await Q.guess(host, `${t.artist} ${t.title}`); // "sanatçı + şarkı" kabul
    const v = (await Q.st(host.page)).view;
    soft(v.phase === 'reveal', `tur ${r} açılmadı`);
    const pts = Object.fromEntries(v.players.map((p) => [p.name, p.roundPoints]));
    soft(pts['Ayşe'] === 5 && pts['Ali'] === 4, `tur ${r} puanları ${JSON.stringify(pts)} (beklenen Ayşe 5, Ali 4)`);
  }
  await host.page.waitForSelector('button:has-text("Sonuçları göster")');
  await host.page.click('button:has-text("Sonuçları göster")');
  await Q.waitNet(g.page, "room.phase === 'over'");
  await g.page.waitForTimeout(400);
  await Q.shot(g, '2p-30-over-guest');
  await Q.shot(host, '2p-30-over-host');
  s = await Q.st(g.page);
  const scores = Object.fromEntries(s.view.players.map((p) => [p.name, p.score]));
  soft(scores['Ali'] === 14 && scores['Ayşe'] === 10, `final ${JSON.stringify(scores)} (beklenen Ali 14, Ayşe 10)`);
  const overText = await g.page.locator('#shazam-online').textContent();
  soft(/Final skorları/.test(overText), 'final başlığı yok');
  // Oyun bitince son şarkı tekrar çalıyor mu? (bilgi)
  // Bekleme odasına dön → şarkılar duruyor mu
  await host.page.click('button:has-text("Bekleme odasına dön")');
  await Q.waitNet(g.page, "room.phase === 'lobby'");
  soft(/Odada 7 şarkı/.test(await g.page.locator('#shazam-online').textContent()), 'lobiye dönünce şarkılar kayboldu');
  await Q.shot(host, '2p-31-back-lobby-host');
  await Q.setSetting(host, 'Tur süresi', 180);
  await Q.start(host, ps);
  s = await Q.st(g.page);
  soft(s.view.round === 1 && s.view.players.every((p) => p.score === 0), 'ikinci oyun sıfırdan başlamadı');
  await g.page.waitForSelector('#shazam-online .play-btn:not([disabled])', { timeout: 10000 }).catch(() => soft(false, '2. oyunda şarkı yüklenmedi'));
  // Yeni oyunda ilk tur: önceki oyunun son şarkı anahtarı farklı olmalı; taslak temiz
  soft(await g.page.inputValue('#ol-guess') === '', 'yeni oyunda tahmin kutusu dolu');
  await Q.shot(g, '2p-32-second-game');

  for (const p of ps) soft(Q.realErrors(p).length === 0, `${p.name} konsol: ${Q.realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of ps) await p.ctx.close();
  assert.deepEqual(issues, []);
});
