// QA: Shazam online — tarayıcı dokunuşsuz sese izin vermezse (Safari gibi). Playwright'ın kendi tıklamaları/prompt'u
// sayfaya "kullanıcı etkinliği" verdiği için Chrome bayrağı yetmiyor; bunun yerine HTMLMediaElement.play, sayfada gerçek bir
// pointerdown/keydown olana kadar NotAllowedError ile reddedecek şekilde taklit edilir (Safari davranışı).
// Misafir davet linkiyle gelir (hiç dokunmaz) → "▶ Ses için bir kez dokun" → ▶'ye dokununca çalar → sonraki şarkı kendiliğinden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const SAFARI_LIKE = () => {
  let gesture = false;
  const mark = () => { gesture = true; };
  addEventListener('pointerdown', mark, true);
  addEventListener('keydown', mark, true);
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play() {
    if (!gesture) return Promise.reject(new DOMException('dokunuş yok', 'NotAllowedError'));
    return orig.call(this);
  };
};
async function strictPhone(name, opts) {
  const ctx = await env.browser.newContext(Q.MOBILE);
  await ctx.addInitScript(SAFARI_LIKE);
  return Q.phone(env, name, { ...opts, ctx });
}

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('otomatik çalma engellenince bir kez dokun; sonra kendiliğinden', async () => {
  const host = await Q.phone(env, 'Host');
  const code = await Q.createRoom(host);
  await Q.injectTracks(host, Q.makeTracks(8));
  // Hiç dokunmamış misafir (davet linki + prompt)
  const g = await strictPhone('Dokunmayan', { hash: null });
  await g.page.goto(`${env.srv.url}/#/join/${code}`);
  await g.page.waitForSelector('#shazam-online .lobby-code', { timeout: 10000 });
  // Bir kez sayfaya dokunmuş misafir
  const t = await strictPhone('Dokunan');
  await Q.joinCode(t, code);
  await Q.waitNet(host.page, 'room.players.length === 3');
  const tAuto = t.page.waitForFunction(() => document.querySelector('#shazam-online .play-btn.playing') && !document.querySelector('#shazam-online .play-count'), undefined, { timeout: 15000, polling: 10 }).then(() => true).catch(() => false);
  await host.page.click('#shazam-online button:has-text("Oyunu başlat")');

  const hint = await g.page.waitForFunction(() => /Ses için bir kez dokun/.test(document.querySelector('#shazam-online .play-label')?.textContent ?? ''), undefined, { timeout: 15000 }).then(() => true).catch(() => false);
  await Q.shot(g, 'ap-00-blocked-hint');
  soft(hint, `engellenen otomatik çalmada ipucu yok (etiket: ${await g.page.locator('#shazam-online .play-label').textContent().catch(() => '?')})`);
  // Dokunan oyuncu kendiliğinden çaldı mı
  const autoOk = await tAuto;
  soft(autoOk, 'bir kez dokunmuş oyuncuda otomatik çalma olmadı');
  // ▶'ye dokun → çalar
  const playedP = g.page.waitForFunction(() => document.querySelector('#shazam-online .play-btn.playing'), undefined, { timeout: 5000, polling: 10 }).then(() => true).catch(() => false);
  await g.page.click('#shazam-online .play-btn');
  const played = await playedP;
  soft(played, 'dokunduktan sonra çalmadı');
  await Q.waitAutoPlayDone(g).catch(() => soft(false, 'dokunduktan sonra klip bitmedi'));
  // Sonraki şarkı: artık kendiliğinden
  for (const p of [host, g, t]) await Q.giveUp(p);
  await Q.waitNet(host.page, "view.phase === 'reveal'");
  await host.page.click('button:has-text("Sonraki şarkı")');
  const auto2 = await g.page.waitForFunction(() => /Şarkı 2/.test(document.body.innerText) && document.querySelector('#shazam-online .play-btn.playing') && !document.querySelector('#shazam-online .play-count'), undefined, { timeout: 15000, polling: 10 }).then(() => true).catch(() => false);
  soft(auto2, '2. şarkıda (dokunduktan sonra) kendiliğinden çalmadı');
  await Q.shot(g, 'ap-01-second-song');
  for (const p of [host, g, t]) soft(Q.realErrors(p).length === 0, `${p.name} konsol: ${Q.realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of [host, g, t]) await p.ctx.close();
  assert.deepEqual(issues, []);
});
