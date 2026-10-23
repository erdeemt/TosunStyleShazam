// QA: Shazam modları birlikte — tek oyunculu Serbest/Puanlı ve yerel Yarışma hâlâ çalışıyor mu; Yarışma ↔ Online
// geçişi, başka oyuna gidip dönme, davet linki, host'un lobide link yüklemesi (gerçekçi uzunlukta Deezer adresleriyle,
// /api/resolve Playwright ile taklit), kaynak kaldırma / odayı temizleme.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

// Gerçek Deezer önizleme adresleri ~280 karakter (hdnea imzası); kapak ~105.
const longAudio = (k) => `https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/qa${k}f8c5dc3837912dba37c9a1ab3170cc3f.mp3?hdnea=exp=1792791953~acl=/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3*~data=user_id=0,application_id=42~hmac=7774c9c5114c9cbc423cad5f5fe525b5aa8dc33910b2c79a7947e435418e162a`;
function fakeSource(n, prefix) {
  return {
    name: `${prefix} listesi`,
    tracks: Array.from({ length: n }, (_, i) => ({
      id: `dz:${prefix}${i}`,
      title: `${prefix} Şarkı ${i + 1}`,
      artist: `${prefix} Sanatçı ${i % 7}`,
      audio: longAudio(`${prefix}${i}`),
      cover: `https://e-cdns-images.dzcdn.net/images/cover/qa${i}/1000x1000-000000-80-0-0.jpg`,
    })),
  };
}
async function routeResolve(p) {
  await p.ctx.route(/\/api\/resolve\?/, (route) => {
    const u = new URL(route.request().url()).searchParams.get('url');
    const m = u.match(/fake\/(\w+)\/(\d+)/);
    if (!m) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Tanınmayan link.' }) });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeSource(Number(m[2]), m[1])) });
  });
}

test('tek oyunculu + Yarışma + Online geçişleri, davet linki, lobide link yükleme', async () => {
  // ---------- Tek oyunculu Serbest ----------
  const solo = await Q.phone(env, 'Solo', { hash: null });
  await routeResolve(solo);
  await solo.page.goto(`${env.srv.url}/#/single/shazam`);
  await solo.page.waitForSelector('#game-shazam:not(.hidden) .mode-card');
  await solo.page.fill('#source-input', 'https://www.deezer.com/fake/Solo/3');
  await solo.page.click('#source-add');
  await solo.page.waitForSelector('text=Toplam 3 şarkı');
  await solo.page.click('#start-btn');
  await solo.page.waitForSelector('#play-btn:not([disabled])', { timeout: 10000 });
  await solo.page.click('#play-btn');
  await solo.page.waitForSelector('#play-btn.playing', { timeout: 3000 }).catch(() => soft(false, 'serbest: çalmadı'));
  await Q.shot(solo, 'md-00-single-free-playing');
  await solo.page.waitForSelector('#play-btn:not(.playing)', { timeout: 5000 });
  await solo.page.click('#free-reveal-btn');
  await solo.page.waitForSelector('#reveal:not(.hidden)');
  const soloTitle = await solo.page.locator('#reveal-title').textContent();
  soft(/Solo Şarkı/.test(soloTitle), `serbest açılış: ${soloTitle}`);
  await Q.shot(solo, 'md-01-single-free-reveal');
  await solo.page.click('#quit-btn');
  await solo.page.waitForSelector('#screen-setup.active');
  // Puanlı
  await solo.page.click('.mode-card[data-mode="solo"]');
  await solo.page.click('#start-btn');
  await solo.page.waitForSelector('#play-btn:not([disabled])', { timeout: 10000 });
  await solo.page.click('#skip-btn');
  await solo.page.fill('#guess-input', 'yanlış');
  await solo.page.press('#guess-input', 'Enter');
  await Q.shot(solo, 'md-02-single-scored');
  soft(Q.realErrors(solo).length === 0, `tek oyunculu konsol: ${Q.realErrors(solo).join(' | ')}`);

  // ---------- Yarışma (yerel) ----------
  const h = await Q.phone(env, 'Ev Sahibi', { hash: null });
  await routeResolve(h);
  await h.page.goto(`${env.srv.url}/#/multi/shazam`);
  await h.page.waitForSelector('.mode-card[data-mode="contest"]');
  soft(await h.page.locator('.mode-card.selected').getAttribute('data-mode') === 'contest', 'çok oyunculu varsayılan mod Yarışma değil');
  await h.page.fill('#source-input', 'https://www.deezer.com/fake/Yar/4');
  await h.page.click('#source-add');
  await h.page.waitForSelector('text=Toplam 4 şarkı');
  for (const n of ['Oya', 'Can']) { await h.page.fill('#player-input', n); await h.page.press('#player-input', 'Enter'); }
  await h.page.fill('#set-per-player', '1');
  await h.page.click('#start-btn');
  await h.page.waitForSelector('#play-btn:not([disabled])', { timeout: 10000 });
  soft(/Oya/.test(await h.page.locator('#turn-name').textContent()), 'yarışma sıra adı');
  await h.page.click('#play-btn');
  await h.page.waitForSelector('#play-btn.playing', { timeout: 3000 }).catch(() => soft(false, 'yarışma: çalmadı'));
  await h.page.waitForSelector('#play-btn:not(.playing)', { timeout: 5000 });
  await h.page.click('#skip-btn');
  await h.page.fill('#guess-input', 'Yar Şarkı');
  await Q.shot(h, 'md-10-contest-ac');
  await h.page.press('#guess-input', 'Escape');
  await h.page.fill('#guess-input', 'bilmem');
  await h.page.press('#guess-input', 'Enter');
  await Q.shot(h, 'md-11-contest-round');

  // ---------- Yarışma → Online (oyun sürerken modu değiştir) ----------
  // Yarışma oyunu ekranındayken mod kartı görünmez; kullanıcı önce "Oyunu bitir" der
  await h.page.click('#quit-btn');
  await h.page.waitForSelector('#screen-end.active, #screen-setup.active');
  await Q.shot(h, 'md-12-contest-end');
  if (await h.page.locator('#screen-end.active').count()) await h.page.click('#menu-btn');
  await h.page.click('.mode-card[data-mode="online"]');
  await h.page.fill('#shazam-online input[placeholder="Takma adın"]', 'Ev Sahibi');
  const code = await Q.createRoom(h);
  soft(await h.page.locator('#mode-pick').isHidden(), 'odadayken mod kartları görünüyor');
  soft(await h.page.locator('#start-btn').isHidden(), 'online modda yerel başlat düğmesi görünüyor');
  // Tek oyunculu/yarışmada eklenen kaynaklar burada hazır mı
  const hostTxt = await h.page.locator('#shazam-online').textContent();
  soft(/Odaya gönder \(4\)/.test(hostTxt), `yerel kaynaklar lobide yok: ${hostTxt.match(/Odaya gönder \(\d+\)/)}`);
  // Uzun adresli 40 şarkılık liste yükle → otomatik gönderilir
  await h.page.fill('#shazam-online textarea', 'https://www.deezer.com/fake/Uzun/40');
  await h.page.click('#shazam-online button:has-text("Linkleri yükle")');
  await h.page.waitForFunction(() => !document.body.innerText.includes('Gönderiliyor'), undefined, { timeout: 20000 }).catch(() => {});
  await h.page.waitForTimeout(1500);
  let s = await Q.st(h.page);
  console.log('lobide yükleme sonrası: trackCount', s.room?.prep?.trackCount, 'bağlı', s.connected);
  soft(s.room?.prep?.trackCount === 44, `40+4 şarkı odaya gitmedi: trackCount=${s.room?.prep?.trackCount}, bağlı=${s.connected}`);
  await Q.shot(h, 'md-20-online-lobby-after-load');
  // Not: "welcome" sayısı bağlantı sayısı DEĞİL (ad değişince sunucu yine welcome yollar). Gerçek kopmayı
  // tarayıcının açtığı WebSocket sayısından ve kapanan soketlerden ölç; mesaj boyutlarını da kaydet.
  const welcomes = h.frames.filter((f) => f.startsWith('{"t":"welcome"')).length;
  const renames = h.sent.filter((f) => f.startsWith('{"t":"rename"')).length;
  const bigSent = h.sent.filter((f) => f.includes('"t":"prep"')).map((f) => Buffer.byteLength(f));
  console.log(`host: WebSocket açılan ${h.sockets.length}, kapanan ${h.sockets.filter((x) => x.closed).length}, welcome ${welcomes} (rename ${renames}) | prep mesaj boyutları (bayt): ${bigSent.join(', ')}`);
  soft(h.sockets.length === 1 && !h.sockets[0].closed, `şarkı gönderirken host bağlantısı koptu (soketler: ${JSON.stringify(h.sockets)})`);
  soft(Math.max(...bigSent) <= 8192, `8 KB üstü prep mesajı: ${Math.max(...bigSent)}`);

  // Misafir davet linkiyle (yeni kullanıcı, kayıtlı mod yok)
  const g = await Q.phone(env, 'Davetli', { hash: null });
  await g.page.goto(`${env.srv.url}/#/join/${code}`);
  await g.page.waitForFunction(() => location.hash === '#/multi/shazam', undefined, { timeout: 10000 }).catch(() => {});
  await g.page.waitForTimeout(800);
  await Q.shot(g, 'md-30-invite-link-guest');
  const gs = await Q.st(g.page);
  soft(gs.room?.code === code, 'davet linkiyle odaya girilmedi');
  const lobbyVisible = await g.page.locator('#shazam-online .lobby-code').isVisible().catch(() => false);
  const mode = await g.page.evaluate(() => document.body.dataset.mode);
  soft(lobbyVisible, `davet linkiyle gelen misafir oda ekranını görmüyor (mod=${mode})`);
  if (!lobbyVisible) await g.page.click('.mode-card[data-mode="online"]');
  await g.page.waitForSelector('#shazam-online .lobby-code');

  // Host kaynağı kaldırır (×) → oda güncellenir mi?
  const before = (await Q.st(g.page)).room.prep.trackCount;
  await h.page.locator('#shazam-online .sources li', { hasText: 'Uzun' }).locator('button').click();
  await h.page.waitForTimeout(500);
  const afterRemove = (await Q.st(g.page)).room.prep.trackCount;
  console.log('kaynak kaldırma: önce', before, 'sonra', afterRemove);
  // Hepsini kaldır → odayı temizlemenin yolu var mı?
  while (await h.page.locator('#shazam-online .sources li button').count()) await h.page.locator('#shazam-online .sources li button').first().click();
  await h.page.waitForTimeout(300);
  const clearBtn = h.page.locator('#shazam-online button:has-text("Odadaki listeyi temizle")');
  soft(await clearBtn.count() === 1, 'yerel kaynak yokken "Odadaki listeyi temizle" düğmesi yok');
  if (await clearBtn.count()) {
    await clearBtn.click();
    await Q.waitNet(g.page, 'room.prep.trackCount === 0').catch(() => soft(false, `temizledikten sonra odada ${'?'} şarkı`));
    soft(h.dialogs.some((d) => /temizlensin/.test(d)), 'temizle onay sormadı');
    soft(await clearBtn.count() === 0, 'boş odada temizle düğmesi hâlâ görünüyor');
    await Q.shot(h, 'md-22-room-cleared');
    // Testin devamı için şarkıları geri koy (doğrudan prep)
    await Q.injectTracks(h, Q.makeTracks(8), 'Geri');
    await Q.waitNet(g.page, 'room.prep.trackCount === 8');
  }
  await Q.shot(h, 'md-21-online-lobby-sources-removed');

  // Başka oyuna git, geri dön: oda ekranı
  await h.page.goto(`${env.srv.url}/#/multi/spyfall`);
  await h.page.waitForSelector('#game-spyfall:not(.hidden)');
  await h.page.waitForTimeout(300);
  await Q.shot(h, 'md-40-spyfall-while-in-shazam-room');
  await h.page.goBack();
  await h.page.waitForSelector('#shazam-online .lobby-code', { timeout: 5000 }).catch(() => soft(false, 'Shazam\'a dönünce oda ekranı yok'));
  // Tek oyunculu Shazam'a git (odadayken): Serbest çalışmalı, online lobi görünmemeli
  await h.page.goto(`${env.srv.url}/#/single/shazam`);
  await h.page.waitForSelector('#game-shazam:not(.hidden) .mode-card[data-mode="free"]');
  soft(await h.page.locator('#shazam-online').isHidden(), 'tek oyunculuda online lobi görünüyor');
  soft(await h.page.locator('#mode-pick').isVisible(), 'tek oyunculuda mod kartları gizli kaldı');
  await Q.shot(h, 'md-41-single-while-in-room');
  await h.page.goto(`${env.srv.url}/#/multi/shazam`);
  await h.page.waitForSelector('#shazam-online .lobby-code', { timeout: 5000 }).catch(() => soft(false, 'tek oyunculudan dönünce oda ekranı yok'));
  await Q.shot(h, 'md-42-back-to-online-blank');
  // Boş ekran: bir sunucu mesajı gelince çizilir → ayar değiştirerek yayın tetikle, sonra devam et
  if (!(await h.page.locator('#shazam-online .lobby-code').isVisible())) {
    await h.page.evaluate(async () => { const { net } = await import('/net.js'); net.send({ t: 'settings', settings: { rounds: 5 } }); });
    await h.page.waitForSelector('#shazam-online .lobby-code', { timeout: 5000 }).catch(() => soft(false, 'yayından sonra da oda ekranı yok'));
  }

  // Oyun başlat (en az 3 şarkı varsa) → Online oyun sırasında Yarışma'ya geçmeye çalış
  s = await Q.st(h.page);
  if ((s.room.prep?.trackCount ?? 0) >= 3) {
    await Q.start(h, [h, g]);
    await g.page.waitForSelector('#shazam-online .play-btn:not([disabled])', { timeout: 10000 }).catch(() => soft(false, 'uzun adresli şarkı yüklenmedi'));
    await Q.shot(g, 'md-50-online-game-guest');
    // Oyun sırasında misafir menüden tek oyunculuya gider, geri döner → oyun ekranı + şarkı hazır
    await g.page.goto(`${env.srv.url}/#/single/shazam`);
    await g.page.waitForSelector('.mode-card[data-mode="free"]');
    await g.page.goto(`${env.srv.url}/#/multi/shazam`);
    await g.page.waitForTimeout(1500);
    const vis = await g.page.locator('#shazam-online .play-btn').isVisible();
    soft(vis, 'oyun sırasında menüden dönünce oyun ekranı boş (bir sonraki sunucu mesajına kadar)');
    await Q.shot(g, 'md-51a-online-after-nav-back-blank');
    if (!vis) await Q.skip(h).catch(() => {}); // başkası eylem yapınca yeniden çizilir
    await g.page.waitForSelector('#shazam-online .play-btn:not([disabled])', { timeout: 10000 }).catch(() => soft(false, 'geri dönünce online oyun/şarkı yok'));
    await Q.shot(g, 'md-51-online-after-nav-back');
  }

  // Odadan çık → mod kartları geri gelir, Yarışma çalışır
  await h.page.evaluate(async () => { const { net } = await import('/net.js'); net.send({ t: 'leave' }); });
  await h.page.waitForSelector('#mode-pick:not(.hidden)');
  await h.page.click('.mode-card[data-mode="contest"]');
  soft(await h.page.locator('#shazam-online').isHidden(), 'Yarışma modunda online lobi görünüyor');
  await Q.shot(h, 'md-60-back-to-contest');

  for (const p of [solo, h, g]) soft(Q.realErrors(p).length === 0, `${p.name} konsol: ${Q.realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of [solo, h, g]) await p.ctx.close();
  assert.deepEqual(issues, []);
});
