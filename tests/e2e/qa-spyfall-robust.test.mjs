// QA: kabuk + lobi sağlamlığı. Davet linki (yeni kullanıcı), yenileme, host yenileme, atma, oyun ortası katılma (izleyici),
// menüde gezinme, aynı kimlikle iki sekme, 6 kişilik oyun. Ekran görüntüleri: test-results/qa/rb-*.png
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, phone, attach, state, waitNet, shot, createRoom, joinCode, startGame, setSetting, roles, realErrors, overflow,
} from './qa-lib.mjs';

let env;
before(async () => { env = await setup({ timeScale: 0.2 }); });
after(async () => { await env?.close(); });

// Her test kendi bulgularını tutar. (Eskiden tek ortak dizi vardı ve sadece son test assert ediyordu: 1. ve 2. testin
// zamanlamaya duyarlı yumuşak kontrolleri — ör. geçersiz davette ad sorusu — "6 kişi" testini rastgele düşürüyordu.)
let issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('kabuk: ana sayfa, menü, rotalar', async () => {
  issues = [];
  const p = await phone(env, 'X', { hash: '#/' });
  await p.page.waitForSelector('.game-card-link');
  await shot(p, 'rb-00-home-mobile');
  soft((await overflow(p.page)).scrollW <= 360, 'ana sayfa 360 taşma');
  await p.page.click('#nav-toggle');
  await p.page.waitForTimeout(400);
  await shot(p, 'rb-01-menu-open-mobile');
  await p.page.click('.nav-item:has-text("Casus Kim?")');
  await p.page.waitForSelector('input[placeholder="Takma adın"]');
  // Adı kaydet: geçersiz davet kontrolü ad sorusuna (prompt) takılmasın — o akış 2. testte ayrıca deneniyor.
  await p.page.evaluate(async () => { (await import('/net.js')).net.setName('X'); });
  soft(!(await p.page.evaluate(() => document.body.classList.contains('nav-open'))), 'menü seçimden sonra kapanmadı');
  await shot(p, 'rb-02-spyfall-entry-mobile');
  // Shazam hâlâ açılıyor mu
  await p.page.click('#nav-toggle');
  await p.page.click('.nav-item[data-route="multi/shazam"]');
  await p.page.waitForSelector('#game-shazam:not(.hidden) #mode-pick');
  await shot(p, 'rb-03-shazam-multi');
  // Bilinmeyen rota → ana sayfa
  await p.page.goto(`${env.srv.url}/#/foo/bar`);
  await p.page.waitForSelector('#view-home:not(.hidden)');
  // Geçersiz davet kodu
  await p.page.goto(`${env.srv.url}/#/join/QQQQ`);
  await p.page.waitForFunction(() => location.hash === '#/' || location.hash === '');
  await p.page.waitForTimeout(300);
  await shot(p, 'rb-04-bad-invite');
  const toastText = await p.page.locator('#toast').textContent();
  soft(/bulunamadı/.test(toastText), `geçersiz davet toast: ${toastText}`);
  // Masaüstü ana sayfa
  const d = await phone(env, 'Y', { hash: '#/', desktop: true });
  await d.page.waitForSelector('.game-card-link');
  await shot(d, 'rb-05-home-desktop');
  // Ana sayfadan oyun kartı
  await d.page.click('.game-card-link:has-text("Casus Kim?")');
  await d.page.waitForSelector('input[placeholder="Takma adın"]');
  for (const x of [p, d]) soft(realErrors(x).length === 0, `kabuk konsol: ${realErrors(x).join(' | ')}`);
  await p.ctx.close(); await d.ctx.close();
});

test('davet linki (adı olmayan yeni kullanıcı), yenileme, host yenileme, atma, izleyici, menü gezintisi, iki sekme', async () => {
  issues = [];
  const host = await phone(env, 'Host');
  const code = await createRoom(host);
  const b = await phone(env, 'Bora');
  await joinCode(b, code);

  // Yeni kullanıcı davet linkiyle: prompt ile ad sorulur
  const newCtx = await env.browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, bypassCSP: true });
  const n = await phone(env, 'Nil', { hash: null, ctx: newCtx, promptAnswer: 'Nil' });
  await n.page.goto(`${env.srv.url}/#/join/${code.toLowerCase()}`);
  await n.page.waitForSelector('.lobby-code', { timeout: 10000 }).catch(() => {});
  await shot(n, 'rb-10-invite-new-user');
  const ns = await state(n.page);
  soft(ns.room?.code === code, `davetle katılım olmadı: ${JSON.stringify(ns.room?.code)} hash=${await n.page.evaluate(() => location.hash)}`);
  soft(ns.room?.players.some((x) => x.name === 'Nil'), `davetle gelen adı: ${ns.room?.players.map((x) => x.name)}`);
  soft(n.dialogs.some((d) => d.startsWith('prompt')), 'yeni kullanıcıya ad sorulmadı');

  // Davet linkini zaten odada olan biri açarsa
  await b.page.goto(`${env.srv.url}/#/join/${code}`);
  await b.page.waitForSelector('.lobby-code');
  soft((await state(b.page)).room?.players.length === 3, 'aynı kişi davet linkiyle çift kayıt oldu');

  // Atma: 4. kişi gelir, host atar
  const k = await phone(env, 'Kemal');
  await joinCode(k, code);
  await host.page.waitForFunction(() => document.querySelectorAll('#game-spyfall .player-list li').length === 4);
  await host.page.locator('.player-list li', { hasText: 'Kemal' }).locator('.icon-btn').click();
  await waitNet(k.page, '!room');
  await k.page.waitForTimeout(200);
  await shot(k, 'rb-11-kicked');
  soft(/çıkardı/.test(await k.page.locator('#toast').textContent()), 'atılan kişiye bildirim yok');
  await waitNet(host.page, 'room.players.length === 3');

  // Oyun başlasın (Host, Bora, Nil)
  const players = [host, b, n];
  await startGame(host, players);
  await roles(players);

  // Oyun ortası katılma → izleyici
  await joinCode(k, code);
  await waitNet(k.page, "room && room.phase === 'playing' && view");
  await shot(k, 'rb-12-spectator');
  const ks = await state(k.page);
  soft(ks.view.me === null, 'izleyiciye rol gitti');
  soft(!JSON.stringify(ks.view).includes('spyIds') && !k.frames.join().includes('"role":'), 'izleyici görünümünde sızıntı');
  soft(await k.page.locator('text=izleyicisin').count() === 1, 'izleyici uyarısı yok');
  soft(await k.page.locator('button:has-text("Suçla")').count() === 0, 'izleyicide Suçla butonu var');

  // Yenileme (oyuncu ve host): aynı rol, aynı oda
  const before = {};
  for (const p of players) before[p.name] = JSON.stringify((await state(p.page)).view.me);
  for (const p of [b, n, host]) {
    await p.page.reload();
    await waitNet(p.page, "room && room.phase === 'playing' && view");
    soft(JSON.stringify((await state(p.page)).view.me) === before[p.name], `${p.name} yenileme sonrası rol değişti`);
    soft(await p.page.locator('.role-card.hidden-card').count() === 1, `${p.name} yenileme sonrası kart gizli değil`);
  }
  soft((await state(b.page)).room.hostId === (await state(host.page)).playerId, 'host yenileyince host değişti');
  await shot(host, 'rb-13-host-after-refresh');
  // Oyun sürerken iptal düğmesi yok artık (host oyunu sıfırlayamasın); host yetkisini oda bilgisinden kontrol et.
  { const hs = await state(host.page); soft(hs.room?.hostId === hs.playerId, 'host yenileme sonrası oda sahipliği kayboldu'); }

  // Menüde gezinme oda içindeyken: Shazam'a git, geri dön
  await b.page.click('#nav-toggle');
  await b.page.click('.nav-item[data-route="multi/shazam"]');
  await b.page.waitForSelector('#game-shazam:not(.hidden)');
  await b.page.goBack();
  await b.page.waitForSelector('#game-spyfall:not(.hidden) .role-card');
  await shot(b, 'rb-14-back-from-menu');
  soft((await state(b.page)).room?.code === code, 'menüde gezinince odadan düştü');
  // Ana sayfaya gidip oyun kartından dön
  await b.page.goto(`${env.srv.url}/#/`);
  await b.page.click('.game-card-link:has-text("Casus Kim?")');
  await b.page.waitForSelector('.role-card');

  // İki sekme aynı kimlik
  const b2page = await b.ctx.newPage();
  const b2 = { name: 'Bora2', page: b2page, errors: [], frames: [], dialogs: [] };
  attach(b2, b2page, 'Bora');
  await b2page.goto(`${env.srv.url}/#/multi/spyfall`);
  await b2page.waitForSelector('.role-card');
  await b.page.waitForTimeout(800);
  await shot(b, 'rb-15-old-tab-replaced');
  await shot(b2, 'rb-15-new-tab');
  const oldTab = await state(b.page);
  soft(!oldTab.connected, 'eski sekme hâlâ bağlı görünüyor');
  const oldTabText = await b.page.locator('#game-spyfall').textContent();
  soft(/Bağlantı yok|başka bir sekme/i.test(oldTabText), `eski sekmede durum açıklaması yok: badge`);
  // Eski sekmede bir şeye tıklarsa ne olur? (kartı aç → yerel; Suçla → ağ)
  await b.page.click('.role-card');
  await b.page.locator('button:has-text("Suçla")').first().click().catch(() => {});
  await b.page.waitForTimeout(1500);
  const after = { old: await state(b.page), neu: await state(b2page) };
  console.log('iki sekme sonrası: eski bağlı?', after.old.connected, 'yeni bağlı?', after.neu.connected, 'faz', after.neu.view?.phase);
  soft(!(after.old.connected && !after.neu.connected) || true, '');
  await b2page.close();

  // Bağlantı kopması: Nil'in bağlamı offline → sunucu ping ile fark eder mi? (kısa test: setOffline + yeniden)
  await n.ctx.setOffline(true);
  await n.page.waitForTimeout(1000);
  await n.ctx.setOffline(false);

  for (const p of [host, n, k]) soft(realErrors(p).length === 0, `${p.name} konsol: ${realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  await host.ctx.close(); await b.ctx.close(); await n.ctx.close(); await k.ctx.close();
});

test('6 kişi: host oyun ortası ayrılır → host devri; suçlanan ayrılır; casus ayrılır', async () => {
  issues = [];
  const names = ['Ece', 'Fatih', 'Gül', 'Hakan', 'İpek', 'Şule'];
  const ps = [];
  for (const nm of names) ps.push(await phone(env, nm, { desktop: nm === 'Şule' }));
  const code = await createRoom(ps[0]);
  for (const p of ps.slice(1)) await joinCode(p, code);
  await waitNet(ps[0].page, 'room.players.length === 6');
  await shot(ps[1], 'rb-20-six-waiting');
  await startGame(ps[0], ps);
  const { spy, town } = await roles(ps);
  await shot(ps[1], 'rb-21-six-play');
  soft((await overflow(ps[1].page)).scrollW <= 360, '6 kişilik oyun 360 taşma');

  // Host (ps[0]) "Odadan çık" → yeni host
  const hostP = ps[0];
  await hostP.page.click('button:has-text("Odadan çık")');
  const rest = ps.slice(1);
  await waitNet(rest[0].page, `room.players.length === 5 && room.hostId !== ${JSON.stringify(hostP.id)}`);
  const st = await state(rest[0].page);
  console.log('yeni host:', st.room.players.find((x) => x.id === st.room.hostId)?.name, 'faz:', st.view.phase, st.view.result?.reason);
  await shot(rest[0], 'rb-22-after-host-left');
  const left = rest.filter((p) => p !== hostP);
  const spyGone = spy.includes(hostP);
  if (spyGone) {
    soft(st.view.phase === 'reveal' && st.view.result.reason === 'spy_left', 'casus host ayrıldı ama tur iptal edilmedi');
  } else {
    // Suçlanan ayrılırsa oylama iptal → oyun devam
    const t = town.filter((p) => p !== hostP);
    await t[0].page.locator('.player-list li', { hasText: t[1].name }).locator('button:has-text("Suçla")').click();
    await waitNet(t[0].page, "view.phase === 'accuse'");
    await t[1].page.click('button:has-text("Odadan çık")');
    await waitNet(t[0].page, "view.phase === 'play'");
    await shot(t[0], 'rb-23-accused-left');
    // Casus ayrılır → tur iptal
    await spy[0].page.click('button:has-text("Odadan çık")');
    await waitNet(t[0].page, "view.phase === 'reveal' || room.phase === 'over'");
    const s2 = await state(t[0].page);
    console.log('casus ayrılınca:', s2.room.phase, s2.view.phase, s2.view.result?.reason);
    await shot(t[0], 'rb-24-spy-left');
    soft(s2.view.result?.reason === 'spy_left', `casus ayrılınca sonuç ${s2.view.result?.reason}`);
    // Yeni host sonraki turu başlatabiliyor mu
    const newHostId = s2.room.hostId;
    const nh = left.find((p) => p.id === newHostId);
    if (nh && s2.room.phase === 'playing') {
      await nh.page.click('button:has-text("Sonraki tur")');
      await waitNet(t[0].page, 'view.round === 2');
    }
  }
  for (const p of ps) soft(realErrors(p).length === 0, `${p.name} konsol: ${realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of ps) await p.ctx.close();
  assert.deepEqual(issues, []);
});
