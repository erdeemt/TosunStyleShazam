// QA: Shazam online — kenar durumlar. Çift dokunma (Geç / Sonraki şarkı), bir telefonda ses yüklenemez (404),
// yavaş ağ (ses 4 sn gecikmeli), masaüstü oyun ekranı, misafir prep gönderemez, oyun sırasında prep reddedilir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('kenar durumlar: çift dokunma, ses 404, yavaş ağ, misafir prep', async () => {
  const TR = Q.makeTracks(8);
  const { ps, host } = await Q.room(env, ['Ali', 'Bozuk', 'Yavaş'], { desktopHost: true });
  const [, bad, slow] = ps;
  // Bozuk telefon: ses 404; yavaş telefon: ses 4 sn gecikmeli
  await bad.ctx.unroute(/https:\/\/cdnt-preview\.dzcdn\.net\/.*/);
  await bad.ctx.route(/https:\/\/cdnt-preview\.dzcdn\.net\/.*/, (r) => r.fulfill({ status: 404, body: 'yok' }));
  await slow.ctx.unroute(/https:\/\/cdnt-preview\.dzcdn\.net\/.*/);
  await slow.ctx.route(/https:\/\/cdnt-preview\.dzcdn\.net\/.*/, async (r) => {
    await new Promise((res) => setTimeout(res, 4000));
    await r.fulfill({ status: 200, contentType: 'audio/wav', body: Q.WAV });
  });

  // Misafir prep gönderemez
  await bad.page.evaluate(async (t) => { const { net } = await import('/net.js'); net.send({ t: 'prep', data: { op: 'add', tracks: t } }); }, TR);
  await bad.page.waitForTimeout(300);
  soft(/oda sahibi/i.test(await bad.page.locator('#toast').textContent()), 'misafir prep reddi toast');
  await Q.injectTracks(host, TR);
  await Q.waitNet(bad.page, 'room.prep.trackCount === 8');
  await Q.start(host, ps);
  // Oyun sırasında prep reddedilir
  await Q.injectTracks(host, Q.makeTracks(2, 9));
  await host.page.waitForTimeout(300);
  soft(/bekleme odasında/.test(await host.page.locator('#toast').textContent()), 'oyun sırasında prep reddi toast');

  // Bozuk telefon: yüklenemedi mesajı, yine de tahmin/geç yapılabilir
  await bad.page.waitForFunction(() => /yüklenemedi/.test(document.getElementById('shazam-online').innerText), undefined, { timeout: 12000 }).catch(() => soft(false, 'ses 404 → yüklenemedi mesajı yok'));
  await Q.shot(bad, 'ed-00-audio-404');
  // Yavaş telefon: önce "yükleniyor", sonra hazır
  const slowLbl = await slow.page.locator('#shazam-online .play-label').textContent();
  soft(/yükleniyor/.test(slowLbl), `yavaş ağda ilk etiket: ${slowLbl}`);
  await Q.shot(slow, 'ed-01-slow-loading');
  await slow.page.waitForSelector('#shazam-online .play-btn:not([disabled])', { timeout: 15000 }).catch(() => soft(false, 'yavaş ağda şarkı hiç hazır olmadı'));

  // Çift dokunma "Geç": tek adım ilerlemeli
  await bad.page.dblclick('#shazam-online .guess-form button.ghost:has-text("Geç")');
  await bad.page.waitForTimeout(600);
  let v = (await Q.st(bad.page)).view;
  soft(v.me.stage === 1, `çift dokunma Geç → ${v.me.stage} adım ilerledi`);
  // Hızlı iki Enter (aynı yanlış tahmin) → tek tahmin
  await bad.page.fill('#ol-guess', 'yanlış');
  await bad.page.press('#ol-guess', 'Enter');
  await bad.page.press('#ol-guess', 'Enter');
  await bad.page.waitForTimeout(600);
  v = (await Q.st(bad.page)).view;
  soft(v.me.stage === 2 && v.me.guesses.length === 2, `iki Enter → adım ${v.me.stage}, tahmin ${v.me.guesses.length} (beklenen 2/2)`);
  // Protokol: aynı adım için iki skip art arda (çift dokunuşun ağdan görünüşü) → tek adım
  await bad.page.evaluate(async (round) => { const { net } = await import('/net.js'); const st = net.view.me.stage; net.action({ type: 'skip', stage: st, round }); net.action({ type: 'skip', stage: st, round }); }, v.round);
  await bad.page.waitForTimeout(600);
  const v2 = (await Q.st(bad.page)).view;
  soft(v2.me.stage === 3, `aynı adım için iki skip → ${v2.me.stage} (beklenen 3)`);
  // Yanlış tur numarasıyla gelen eylem yok sayılır
  await bad.page.evaluate(async () => { const { net } = await import('/net.js'); net.action({ type: 'skip', stage: net.view.me.stage, round: 99 }); });
  await bad.page.waitForTimeout(400);
  soft((await Q.st(bad.page)).view.me.stage === 3, 'bayat tur numaralı skip uygulandı');
  // Çift dokunma sonrası Geç hâlâ çalışıyor mu (bekleyen eylem kilidi takılmasın)
  await Q.skip(bad);
  soft((await Q.st(bad.page)).view.me.stage === 4, 'çift dokunmadan sonra Geç çalışmıyor');
  // Bitir
  for (const p of ps) await p.page.evaluate(async () => { const { net } = await import('/net.js'); net.action({ type: 'giveUp' }); });
  await Q.waitNet(host.page, "view.phase === 'reveal'");
  await host.page.waitForTimeout(500);
  await Q.shot(host, 'ed-02-reveal-desktop');
  // Çift tık "Sonraki şarkı": tek tur ilerlemeli, hata toast'ı olmamalı
  await host.page.dblclick('button:has-text("Sonraki şarkı")');
  await host.page.waitForTimeout(600);
  v = (await Q.st(host.page)).view;
  const toast = await host.page.locator('#toast').textContent();
  soft(v.round === 2, `çift tık Sonraki → tur ${v.round}`);
  soft(!/Tur henüz bitmedi/.test(toast), `çift tık Sonraki sonrası hata toast'ı: ${toast}`);
  await host.page.waitForSelector('#shazam-online .play-btn:not([disabled])', { timeout: 10000 });
  await Q.shot(host, 'ed-03-play-desktop');

  for (const p of ps) { const e = Q.realErrors(p).filter((x) => !/404|Failed to load resource/.test(x)); soft(e.length === 0, `${p.name} konsol: ${e.join(' | ')}`); }
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of ps) await p.ctx.close();
  assert.deepEqual(issues, []);
});

test('6 telefon: başkaları ilerlerken hızlı yazılan harfler kaybolmamalı', async () => {
  const local = [];
  const { ps, host } = await Q.room(env, ['Yazan', 'A', 'B', 'C', 'D', 'E']);
  await Q.injectTracks(host, Q.makeTracks(10));
  await Q.waitNet(ps[1].page, 'room.prep.trackCount === 10');
  await Q.start(host, ps);
  const t = ps[0];
  await Q.waitAutoPlayDone(t);
  await t.page.click('#ol-guess');
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // Diğer 5 kişi arka arkaya "Geç"e basar (her biri herkese yeni görünüm = ekran yeniden çizimi)
  const others = (async () => {
    for (let k = 0; k < 2; k++) for (const p of ps.slice(1)) {
      await p.page.evaluate(async () => { const { net } = await import('/net.js'); const v = net.view; if (v.me && !v.me.done) net.action({ type: 'skip', stage: v.me.stage, round: v.round }); });
      await p.page.waitForTimeout(15);
    }
  })();
  await t.page.keyboard.type(text, { delay: 12 });
  await others;
  await t.page.waitForTimeout(300);
  const val = await t.page.inputValue('#ol-guess');
  console.log(`yazılan ${text.length} karakter, kutuda ${val.length}: ${val}`);
  await Q.shot(t, 'ed-10-typing-lost-chars');
  if (val !== text) local.push(`yazarken ${text.length - val.length} harf kayboldu: "${val}"`);
  for (const p of ps) await p.ctx.close();
  assert.deepEqual(local, []);
});
