// QA: kenar durumlar. Bilinen hatalar burada "✗" olarak loglanır; test sadece çökme/beklenmeyen istisnada kırılır.
// Ekran görüntüleri: test-results/qa/edge-*.png
import { test, before, after } from 'node:test';
import {
  setup, phone, state, waitNet, shot, createRoom, joinCode, startGame, setSetting, roles, realErrors, SHOTS,
} from './qa-lib.mjs';

let env;
before(async () => { env = await setup({ timeScale: 0.1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } else console.log('  ✓', msg); };

test('yavaş bağlantı: ad yazarken sunucu mesajı gelirse ad kaybolmamalı', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, bypassCSP: true });
  const page = await ctx.newPage();
  // Sunucudan gelen mesajları 1.5 sn geciktir
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => setTimeout(() => ws.send(m), 1500));
    ws.onMessage((m) => server.send(m));
  });
  await page.goto(`${env.srv.url}/#/multi/spyfall`);
  await page.waitForSelector('input[placeholder="Takma adın"]');
  await page.fill('input[placeholder="Takma adın"]', 'Yavaş');
  await page.waitForTimeout(2500);
  const val = await page.inputValue('input[placeholder="Takma adın"]');
  await page.screenshot({ path: `${SHOTS}edge-00-slow-name.png` });
  soft(val === 'Yavaş', `yavaş ağda yazılan ad korunuyor (şu an: "${val}")`);
  // Oda kurma yavaş ağda: çift tıklama iki oda kurar mı?
  await page.fill('input[placeholder="Takma adın"]', 'Yavaş');
  await page.click('text=Yeni oda kur');
  await page.click('text=Yeni oda kur').catch(() => {});
  await page.waitForSelector('.lobby-code', { timeout: 10000 });
  await page.waitForTimeout(2000);
  const s = await state(page);
  console.log('çift tıklama sonrası oda:', s.room?.code);
  await ctx.close();
});

test('aynı ad, prompt iptali, başka odadayken davet linki, çift tıklama "Sonraki tur", host kopması', async () => {
  const a = await phone(env, 'Ali');
  const code = await createRoom(a);
  const a2 = await phone(env, 'ali');
  await joinCode(a2, code);
  const c = await phone(env, 'Can');
  await joinCode(c, code);
  const names = (await state(a.page)).room.players.map((p) => p.name);
  soft(names.includes('ali 2'), `aynı ad sonek alır: ${names}`);

  // Prompt iptal: adsız kullanıcı davet linkinde "İptal"e basar
  const ctx = await env.browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, bypassCSP: true });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.dismiss());
  await pg.goto(`${env.srv.url}/#/join/${code}`);
  await pg.waitForSelector('.lobby-code', { timeout: 8000 }).catch(() => {});
  const ps = await state(pg);
  console.log('prompt iptal → ad:', ps.room?.players.find((p) => p.id === ps.playerId)?.name);
  await pg.screenshot({ path: `${SHOTS}edge-01-prompt-cancel.png` });
  soft(ps.room?.players.find((p) => p.id === ps.playerId)?.name !== 'Oyuncu', 'prompt iptal edilince "Oyuncu" adıyla odaya girmemeli (ad sormaya devam etmeli)');
  // Ad verilmezse artık odaya hiç girilmiyor (ana sayfaya dönülüyor); girildiyse çık.
  if (await pg.locator('button:has-text("Odadan çık")').count()) await pg.click('button:has-text("Odadan çık")');
  await ctx.close();

  // Oyun başlasın
  const all = [a, a2, c];
  await setSetting(a, 'Tur sayısı', 2);
  await startGame(a, all);
  const { spy } = await roles(all);

  // Can başka bir odanın davet linkini açar (oyun sürerken) → uyarısız oyundan çıkar mı?
  const o = await phone(env, 'Osman');
  const other = await createRoom(o);
  await c.page.goto(`${env.srv.url}/#/join/${other}`);
  await c.page.waitForTimeout(1500);
  const cs = await state(c.page);
  await shot(c, 'edge-02-invite-while-ingame');
  // Artık onay soruluyor; bu telefon onayı kabul ettiği için yeni odaya geçmesi doğru.
  soft(c.dialogs.some((d) => d.startsWith('confirm:') && d.includes('oyunundasın')), `oyun ortasında başka davet linki açınca onay sorulmadı (şimdi oda ${cs.room?.code}, dialogs=${JSON.stringify(c.dialogs)})`);
  const as = await state(a.page);
  console.log('ana oda faz:', as.room.phase, as.view?.phase, as.view?.result?.reason, 'oyuncu:', as.view?.players.length);
  await shot(a, 'edge-03-host-after-can-left');

  // Odaya geri dön
  await c.page.goto(`${env.srv.url}/#/join/${code}`);
  await c.page.waitForTimeout(1000);
  console.log('Can geri döndü:', (await state(c.page)).room?.players.find((p) => p.id === (cs.playerId))?.spectator ? 'izleyici' : 'oyuncu');

  // Oyun hâlâ sürüyorsa: casus tahmin edip turu bitirsin, host "Sonraki tur"a çift tıklasın
  let s = await state(a.page);
  if (s.room.phase === 'playing' && s.view.phase === 'play') {
    const sp = spy.find((p) => p !== c) ?? spy[0];
    await sp.page.click('button:has-text("Mekânı tahmin et")');
    await sp.page.locator('.loc').first().click();
    await waitNet(a.page, "view.phase === 'reveal'");
    await a.page.dblclick('button:has-text("Sonraki tur"), button:has-text("Sonuçları göster")');
    await a.page.waitForTimeout(800);
    s = await state(a.page);
    soft(s.view.round === 2 && s.view.phase === 'play', `çift tıklama "Sonraki tur" tur atlamadı (tur ${s.view.round}, faz ${s.view.phase})`);
    const toastText = await a.page.locator('#toast').textContent();
    console.log('çift tıklama toast:', toastText);
    // Tur 2 bitir → reveal; host sekmeyi kapatır (kopma) → diğerleri ne görür?
    const r2 = await roles([a, a2]);
    const sp2 = r2.spy[0] ?? null;
    if (sp2) {
      await sp2.page.click('button:has-text("Mekânı tahmin et")');
      await sp2.page.locator('.loc').first().click();
    } else {
      // casus Can (dönmüşse) değilse, süre dolmasını bekle
    }
  }
  for (const p of [a, a2]) soft(realErrors(p).length === 0, `${p.name} konsol: ${realErrors(p).join(' | ')}`);
  for (const p of [a, a2, c, o]) await p.ctx.close();
});

test('9 kişi, 2 casus: casuslar birbirini görmüyor, mekân görmüyorlar', async () => {
  const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'J9'];
  const ps = [];
  for (const nm of names) ps.push(await phone(env, nm));
  const code = await createRoom(ps[0]);
  await setSetting(ps[0], 'Casus sayısı', 2);
  for (const p of ps.slice(1)) await joinCode(p, code);
  await waitNet(ps[0].page, 'room.players.length === 9');
  await startGame(ps[0], ps);
  const { spy, town } = await roles(ps);
  soft(spy.length === 2, `9 kişide 2 casus (${spy.length})`);
  const loc = (await state(town[0].page)).view.me.location;
  for (const s of spy) {
    const raw = s.frames.join('\n');
    soft(!raw.includes('spyIds') && !raw.includes('"roles"'), `${s.name} (casus) çerçevesinde spyIds/roles yok`);
    soft(!new RegExp(`"location":\\{"id":"${loc.id}"`).test(raw), `${s.name} (casus) çerçevesinde mekân yok`);
  }
  await ps[0].page.click('.role-card');
  await spy[0].page.click('.role-card');
  await shot(spy[0], 'edge-10-two-spies-spy');
  await shot(ps[0], 'edge-11-nine-players');
  for (const p of ps) await p.ctx.close();
});

test('masaüstü oyun ekranı + suçlama oylaması zaman aşımı', async () => {
  const d = await phone(env, 'Masa', { desktop: true });
  const code = await createRoom(d);
  const m1 = await phone(env, 'Mob1');
  const m2 = await phone(env, 'Mob2');
  for (const p of [m1, m2]) await joinCode(p, code);
  await setSetting(d, 'Tur süresi', 3);
  await startGame(d, [d, m1, m2]);
  await d.page.click('.role-card');
  await shot(d, 'edge-20-desktop-play');
  await d.page.locator('.player-list li', { hasText: 'Mob1' }).locator('button:has-text("Suçla")').click();
  await waitNet(d.page, "view.phase === 'accuse'");
  await shot(d, 'edge-21-desktop-accuse');
  // Kimse oy vermez → 45 sn * 0.1 = 4.5 sn sonra oyun devam etmeli
  await waitNet(d.page, "view.phase === 'play'", 10000);
  soft(true, 'oy verilmeyen suçlama zaman aşımında oyuna dönüyor');
  const ms = await state(m1.page);
  console.log('suçlama sonrası kalan sn:', Math.round((ms.view.endsAt - Date.now()) / 1000));
  for (const p of [d, m1, m2]) soft(realErrors(p).length === 0, `${p.name} konsol: ${realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of [d, m1, m2]) await p.ctx.close();
});
