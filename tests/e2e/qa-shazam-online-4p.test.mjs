// QA: Shazam online — 4 telefon. Yazarken başkalarının ilerlemesi (odak/metin), öneri seçme, yenileme (oyuncu + host),
// oyuncu ayrılır, oyun ortası izleyici, ilk bilen bonusu, host açılışta ayrılır → devir, lobiye dönüş, tekrar oyun.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const issues = [];
async function giveUp(p) {
  while ((await Q.st(p.page)).view.me.stage < 4) await Q.skip(p);
  await Q.giveUp(p);
}
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('4 telefon: odak, öneri, yenileme, ayrılma, izleyici, bonus, host devri, tekrar oyun', async () => {
  const TR = Q.makeTracks(8);
  const { ps, host, code } = await Q.room(env, ['Ali', 'Ayşe', 'Mert', 'Zeynep']);
  const [, ayse, mert, zeynep] = ps;
  await Q.injectTracks(host, TR);
  await Q.waitNet(ayse.page, 'room.prep.trackCount === 8');
  await Q.setSetting(host, 'Tur süresi', 180);
  await Q.setSetting(host, 'Şarkı sayısı', 5);
  await Q.waitNet(ayse.page, 'room.settings.roundSeconds === 180 && room.settings.rounds === 5');
  await Q.shot(ayse, '4p-00-lobby-guest');
  await Q.start(host, ps);

  // ---------- Tur 1 ----------
  let v = (await Q.st(host.page)).view;
  const t1 = Q.trackOf(v, TR);
  soft(v.totalRounds === 5, `totalRounds ${v.totalRounds}`);
  // Ayşe yazarken diğerleri ilerler
  await ayse.page.click('#ol-guess');
  await ayse.page.keyboard.type(t1.title.slice(0, 2), { delay: 60 });
  await Q.skip(mert);
  await ayse.page.keyboard.type(t1.title.slice(2, 4), { delay: 60 });
  await Q.skip(zeynep);
  await Q.guess(zeynep, 'olmayan şarkı');
  await ayse.page.waitForTimeout(300);
  const focus = await ayse.page.evaluate(() => ({ id: document.activeElement?.id, val: document.getElementById('ol-guess')?.value, sel: document.getElementById('ol-guess')?.selectionStart }));
  soft(focus.id === 'ol-guess' && focus.val === t1.title.slice(0, 4), `yazarken odak/metin: ${JSON.stringify(focus)}`);
  // Yazmaya devam edebilmeli (imleç sonda)
  await ayse.page.keyboard.type('X');
  soft(await ayse.page.inputValue('#ol-guess') === `${t1.title.slice(0, 4)}X`, `devam yazımı: ${await ayse.page.inputValue('#ol-guess')}`);
  await ayse.page.keyboard.press('Backspace');
  const acTexts = await ayse.page.locator('#ol-ac button').allTextContents();
  soft(acTexts.some((x) => x.startsWith(t1.title)), `öneri yok: ${acTexts}`);
  await Q.shot(ayse, '4p-10-typing-with-suggestions');
  // Öneri sanatçı adıyla da çıkmalı
  await ayse.page.fill('#ol-guess', '');
  await ayse.page.keyboard.type(t1.artist.split(' ')[0].slice(0, 4));
  const acArtist = await ayse.page.locator('#ol-ac button').allTextContents();
  soft(acArtist.some((x) => x.includes(t1.artist)), `sanatçıyla öneri yok: ${acArtist}`);
  // Öneriye dokun → sadece şarkı adı yazılır, sonra Tahmin et
  await ayse.page.locator('#ol-ac button', { hasText: t1.title }).first().click();
  soft(await ayse.page.inputValue('#ol-guess') === t1.title, `öneri seçimi: ${await ayse.page.inputValue('#ol-guess')}`);
  soft(await ayse.page.locator('#ol-ac button').count() === 0, 'öneri seçince liste kapanmadı');
  // Başka biri bir şey yapınca (yeniden çizim) seçilmiş öneri listesi geri açılmamalı.
  // (Bayat adım numaralı eylem sunucuda sessizce yok sayılır ama herkese yeni görünüm gider → güvenilir tetik.)
  await host.page.evaluate(async () => { const { net } = await import('/net.js'); net.action({ type: 'skip', stage: 99, round: net.view.round }); });
  await ayse.page.waitForTimeout(300);
  const reopened = await ayse.page.locator('#ol-ac button').count();
  if (reopened) await Q.shot(ayse, '4p-10b-suggestions-reopened');
  soft(reopened === 0, `öneri seçildikten sonra başkasının hamlesiyle liste yeniden açıldı (${reopened} öneri)`);
  await Q.act(ayse, () => ayse.page.click('#shazam-online button:has-text("Tahmin et")'));
  v = (await Q.st(ayse.page)).view;
  soft(v.me.won && v.me.points === 6, `Ayşe puan ${v.me.points}`);
  await Q.shot(ayse, '4p-11-ayse-done');
  // Diğerleri Ayşe'nin bildiğini görür ama cevabı görmez
  const mertText = await mert.page.locator('#shazam-online').textContent();
  soft(/✓ bildi/.test(mertText), 'Mert, Ayşe\'nin bildiğini görmüyor');
  soft(!mertText.includes(t1.title) || (await mert.page.locator('#ol-ac button').count()) > 0, 'Mert ekranında cevap');

  // Mert yenilenir (adım 1, bir geçiş): ilerleme korunmalı
  await mert.page.reload();
  await Q.waitNet(mert.page, "room && room.phase === 'playing' && view && view.phase === 'play'");
  await Q.waitAutoPlayDone(mert).catch(() => soft(false, 'yenileme sonrası şarkı yüklenip kendiliğinden çalmadı'));
  v = (await Q.st(mert.page)).view;
  soft(v.me.stage === 1 && v.me.guesses.length === 1, `yenileme sonrası ilerleme: ${JSON.stringify(v.me)}`);
  soft(/1\.5 sn dinle/.test(await mert.page.locator('#shazam-online .play-label').textContent()), 'yenileme sonrası etiket');
  await Q.shot(mert, '4p-12-mert-after-refresh');

  // Oyun ortası izleyici
  const kemal = await Q.phone(env, 'Kemal');
  await Q.joinCode(kemal, code);
  await Q.waitNet(kemal.page, "room.phase === 'playing' && view");
  await kemal.page.waitForTimeout(300);
  await Q.shot(kemal, '4p-13-spectator');
  const kt = await kemal.page.locator('#shazam-online').textContent();
  soft(/izliyorsun|izleyicisin/.test(kt), 'izleyici uyarısı yok');
  soft(await kemal.page.locator('#ol-guess').count() === 0, 'izleyicide tahmin kutusu var');
  soft(!kt.includes(t1.title), 'izleyici ekranında cevap');
  soft(Q.leaks(kemal, t1, 1).length === 0, `izleyici sızıntı ${Q.leaks(kemal, t1, 1)}`);
  // İzleyici eylem gönderemez
  await kemal.page.evaluate(async (t) => { const { net } = await import('/net.js'); net.action({ type: 'guess', text: t }); }, t1.title);
  await kemal.page.waitForTimeout(300);
  soft(/İzleyiciler/.test(await kemal.page.locator('#toast').textContent()), 'izleyici eylemi reddedilmedi (toast)');

  // Zeynep odadan çıkar (onay)
  await zeynep.page.click('#shazam-online button:has-text("Odadan çık")');
  await Q.waitNet(host.page, 'room.players.length === 4 && !room.players.some((p) => p.name === "Zeynep")');
  // Kalanlar: host bilir, Mert pes eder → tur açılır
  await Q.guess(host, t1.title);
  v = (await Q.st(host.page)).view;
  soft(v.me.points === 5, `host 0. adımda ikinci bilen: ${v.me.points} (beklenen 5)`);
  await giveUp(mert);
  await Q.waitNet(host.page, "view.phase === 'reveal'");
  // Host açılışta yenilenir → Sonraki şarkı hâlâ var
  await host.page.reload();
  await Q.waitNet(host.page, "room && view && view.phase === 'reveal'");
  await host.page.waitForSelector('button:has-text("Sonraki şarkı")', { timeout: 5000 }).catch(() => soft(false, 'host yenileme sonrası Sonraki şarkı yok'));
  await Q.shot(host, '4p-14-reveal-host-after-refresh');
  await Q.shot(kemal, '4p-14-reveal-spectator');
  v = (await Q.st(host.page)).view;
  soft(!v.players.some((p) => p.name === 'Zeynep'), 'ayrılan Zeynep hâlâ listede');

  // ---------- Tur 2: üçü de 0. adımda bilir → sadece ilk +1 ----------
  await host.page.click('button:has-text("Sonraki şarkı")');
  await Q.waitNet(ayse.page, "view.round === 2 && view.phase === 'play'");
  const t2 = Q.trackOf((await Q.st(ayse.page)).view, TR);
  await Q.guess(mert, t2.title);
  await Q.guess(host, t2.title);
  await Q.guess(ayse, t2.title.toUpperCase());
  v = (await Q.st(host.page)).view;
  const pts = Object.fromEntries(v.players.map((p) => [p.name, p.roundPoints]));
  soft(pts.Mert === 6 && pts.Ali === 5 && pts['Ayşe'] === 5, `tur 2 puanları ${JSON.stringify(pts)}`);
  await Q.shot(ayse, '4p-20-reveal-r2');

  // ---------- Tur 3: host açılışta ayrılır → devir ----------
  await host.page.click('button:has-text("Sonraki şarkı")');
  await Q.waitNet(ayse.page, "view.round === 3 && view.phase === 'play'");
  const t3 = Q.trackOf((await Q.st(ayse.page)).view, TR);
  for (const p of [ayse, mert, host]) await Q.guess(p, t3.title);
  await Q.waitNet(ayse.page, "view.phase === 'reveal'");
  await host.page.click('#shazam-online button:has-text("Odadan çık")');
  await Q.waitNet(ayse.page, `room.hostId !== ${JSON.stringify(host.id)} && room.players.length === 3`);
  const s = await Q.st(ayse.page);
  const newHost = [ayse, mert, kemal].find((p) => p.id === s.room.hostId);
  console.log('yeni host:', newHost?.name);
  soft(newHost && newHost !== kemal, `yeni host izleyici oldu: ${newHost?.name}`);
  await newHost.page.waitForSelector('button:has-text("Sonraki şarkı")', { timeout: 5000 }).catch(() => soft(false, 'yeni hostta Sonraki şarkı yok'));
  await Q.shot(newHost, '4p-30-new-host-reveal');
  await newHost.page.click('button:has-text("Sonraki şarkı")');
  await Q.waitNet(ayse.page, "view.round === 4 && view.phase === 'play'");
  // Tur 4 ve 5: hızlı geç
  for (const r of [4, 5]) {
    for (const p of [ayse, mert]) await giveUp(p);
    await Q.waitNet(newHost.page, "view.phase === 'reveal'");
    await newHost.page.click(`button:has-text("${r === 5 ? 'Sonuçları göster' : 'Sonraki şarkı'}")`);
    if (r === 4) await Q.waitNet(ayse.page, "view.round === 5 && view.phase === 'play'");
  }
  await Q.waitNet(ayse.page, "room.phase === 'over'");
  await Q.shot(kemal, '4p-40-over-spectator');
  await Q.shot(newHost, '4p-40-over-newhost');
  // Lobiye dön → Kemal artık oyuncu, şarkılar duruyor
  await newHost.page.click('button:has-text("Bekleme odasına dön")');
  await Q.waitNet(kemal.page, "room.phase === 'lobby'");
  soft(/Odada 8 şarkı/.test(await kemal.page.locator('#shazam-online').textContent()), 'lobiye dönünce şarkı özeti yok');
  await Q.shot(newHost, '4p-41-lobby-newhost');
  // Yeni host şarkı ekleyebiliyor mu? (yerelde kaynağı yok → "Odaya gönder (0)")
  const sendBtn = newHost.page.locator('#shazam-online button:has-text("Odaya gönder")');
  console.log('yeni host Odaya gönder:', await sendBtn.textContent(), 'disabled', await sendBtn.isDisabled());
  await newHost.page.click('#shazam-online button:has-text("Oyunu başlat")');
  await Q.waitNet(kemal.page, "room.phase === 'playing' && view && view.me");
  soft(true, '');
  await Q.shot(kemal, '4p-42-kemal-plays-second-game');

  for (const p of [ayse, mert, kemal, newHost]) soft(Q.realErrors(p).length === 0, `${p.name} konsol: ${Q.realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of [...ps, kemal]) await p.ctx.close().catch(() => {});
  assert.deepEqual(issues, []);
});
