// QA: 7 telefon (mobil) + geç gelen izleyici. 2 vampir (elle), vampirler birbirinin seçimini canlı görür,
// gece ortasında yenile, savunma/oylama ortasında yenile, oyuncu oyundan ayrılır, ölü ekranları,
// vampirler eşitlikle (gece) kazanır.
// Çalıştır: node --test tests/e2e/qa-vampir-game7.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, startGame, phone, shot, state, waitNet, nightClick, closedTap, nightSignature, act, toastText,
  overflow, roleLeaks, realErrors, byRole,
} from './qa-vampir-lib.mjs';

let env;
const notes = [];
const note = (s) => { notes.push(s); console.log('NOTE:', s); };
const bugs = [];
const bug = (s) => { bugs.push(s); console.log('BUG:', s); };

before(async () => { env = await setup({ timeScale: 0.25 }); });
after(async () => { console.log('\n--- NOTES ---\n' + notes.join('\n')); await env?.close(); });

const NAMES = ['Ahmet', 'Banu', 'Cem', 'Dilek', 'Emre', 'Fatma', 'Gökhan'];

test('7 telefon: ayrılma, yenileme, izleyici, vampirler eşitlikle kazanır', async () => {
  const { phones, host, code } = await startGame(env, NAMES, { settings: { 'Vampir sayısı': '2', 'Gece süresi': '120' } });
  console.log('roles', phones.map((p) => `${p.name}=${p.role}`).join(' '));
  const [v1, v2] = byRole(phones, 'vampir');
  const [doc] = byRole(phones, 'doktor');
  const [seer] = byRole(phones, 'gozcu');
  const [deli] = byRole(phones, 'deli');
  const [k1, k2] = byRole(phones, 'koylu');
  assert.ok(v1 && v2 && doc && seer && deli && k1 && k2);

  // ---- Kart kapalı: 7 ekranın imzası aynı mı?
  const sigs = [];
  for (const p of phones) sigs.push({ role: p.role, ...(await nightSignature(p)) });
  const keyOf = (s) => JSON.stringify({ n: s.nTargets, d: s.disabled, c: s.chosen, a: s.allyTags, cl: s.cardClass, h: s.hint });
  if (new Set(sigs.map(keyOf)).size > 1) bug(`7 kişi gece 1 kart kapalı imzalar farklı: ${JSON.stringify(sigs)}`);
  await shot(v1, 'g7-n1-closed-vampir');
  await shot(k1, 'g7-n1-closed-koylu');

  // ---- Vampir 1 seçer, vampir 2 kartı açınca görür; kapalıyken görmez
  await nightClick(v1, k1.name);
  await v2.page.waitForTimeout(400);
  const closedAlly = await v2.page.locator('.ally-pick').count();
  assert.equal(closedAlly, 0, 'kart kapalıyken müttefik seçimi görünmemeli');
  await v2.page.click('.role-card');
  await v2.page.waitForSelector('.ally-pick');
  const allyTxt = await v2.page.locator('.target', { has: v2.page.locator('.ally-pick') }).innerText();
  assert.match(allyTxt, new RegExp(`${k1.name}[\\s\\S]*${v1.name}`));
  await shot(v2, 'g7-n1-vampir2-sees-ally-pick');
  // Vampir 2 kartı açıkken vampir 1'e (müttefik) dokunabilir mi? düğme pasif olmalı
  assert.equal(await v2.page.locator('.target', { hasText: v1.name }).first().isDisabled(), true, 'vampir müttefikini seçememeli (kart açıkken pasif)');
  await act(v2, { type: 'nightPick', targetId: v1.id });
  await v2.page.waitForTimeout(300);
  assert.ok(/yapılamaz|seçemezsin/.test(await toastText(v2)), 'sunucu vampir→vampir seçimini reddetmeli');
  // Vampir 2 kartı kapalıyken müttefike dokunursa ne olur? (yandaki ne görür)
  await v2.page.click('.role-card');
  await closedTap(v2, v1.name);
  await v2.page.waitForTimeout(350);
  const v2toast = await toastText(v2);
  // köylü aynı kişiye dokunsun (geçerli seçim) → tepki farkı
  await closedTap(k2, v1.name);
  await k2.page.waitForTimeout(350);
  const k2toast = await toastText(k2);
  if (v2toast !== k2toast) bug(`Kart kapalı, aynı kişiye (vampir ${v1.name}) dokununca vampir "${v2toast}" toast'u görüyor, köylü "${k2toast}" — yandaki fark eder`);
  await shot(v2, 'g7-n1-vampir2-taps-ally-closed');
  await nightClick(v2, k1.name);

  // ---- İzleyici gece ortasında katılır
  const spec = await phone(env, 'Hale');
  await spec.page.fill('.code-input', code.toLowerCase());
  await spec.page.click('button:has-text("Katıl")');
  await waitNet(spec.page, "room && room.phase === 'playing' && view && view.phase === 'night'");
  await shot(spec, 'g7-n1-spectator');
  const specTxt = await spec.page.locator('#game-vampir').innerText();
  const specView = (await state(spec.page)).view;
  assert.equal(specView.me, null, 'izleyicinin rolü yok');
  if (/kartını aç/i.test(specTxt)) bug('İzleyici gece ekranında "Görevini görmek için kartını aç" yazısını görüyor ama kartı yok (kafa karıştırıcı)');

  // ---- Bir köylü seçim yaptıktan sonra gece ortasında sayfayı yeniler
  await nightClick(k1, doc.name);
  await k1.page.reload();
  await waitNet(k1.page, "view && view.phase === 'night'");
  await k1.page.waitForSelector('.target');
  const k1after = await nightSignature(k1);
  assert.equal(k1after.chosen, 0, 'kart kapalıyken vurgu yok');
  assert.match(k1after.hint, /Seçimini yaptın/, 'yenileme sonrası "seçimini yaptın" ipucu');
  assert.ok((await state(k1.page)).view.me.nightPick, 'yenileme sonrası gece seçimi korunmalı');
  await k1.page.click('.role-card');
  assert.equal((await nightSignature(k1)).chosen, 1, 'kart açınca seçim vurgulu');
  await k1.page.click('.role-card');
  assert.equal(k1after.cardClass, 'role-card hidden-card', 'yenileme sonrası kart kapalı açılmalı');
  await shot(k1, 'g7-n1-koylu-after-reload');

  // Kalanlar seçer: doktor kendini, gözcü vampir 1'e, deli birine
  await nightClick(doc, doc.name);
  await nightClick(seer, v1.name);
  await nightClick(deli, k2.name);
  await nightClick(k2, v1.name);
  for (const p of phones) await waitNet(p.page, "view.phase === 'day'");
  await waitNet(spec.page, "view.phase === 'day'");
  const ann = await host.page.locator('.announce').innerText();
  assert.match(ann, new RegExp(`${k1.name}.*öldü`));
  await shot(k1, 'g7-d1-dead');
  await shot(spec, 'g7-d1-spectator');
  const specDayTxt = await spec.page.locator('#game-vampir').innerText();
  if (/Ölüler konuşmaz/.test(specDayTxt) && !/Öldün/.test(specDayTxt)) bug('İzleyiciye gündüz "💀 Ölüler konuşmaz." deniyor (izleyici ölü değil)');

  // ---- Başarısız yargılama, savunma ortasında aday yeniler, oylama ortasında bir seçmen yeniler
  await v1.page.locator('#game-vampir .player-list li', { hasText: k2.name }).locator('button:has-text("Aday göster")').click();
  await v2.page.waitForSelector('button:has-text("Destekliyorum")');
  await v2.page.click('button:has-text("Destekliyorum")');
  await k2.page.waitForSelector('button:has-text("Savunmam bitti")');
  await k2.page.reload();
  await waitNet(k2.page, "view && view.phase === 'trial'");
  await k2.page.waitForSelector('button:has-text("Savunmam bitti")');
  await shot(k2, 'g7-trial-accused-after-reload');
  await k2.page.click('button:has-text("Savunmam bitti")');
  for (const p of phones.filter((x) => x !== k1)) await waitNet(p.page, "view.phase === 'trialVote'");
  await v1.page.click('button:has-text("Evet, asılsın")');
  await v1.page.reload();
  await waitNet(v1.page, "view && view.phase === 'trialVote'");
  await v1.page.waitForTimeout(300);
  const v1txt = await v1.page.locator('#game-vampir').innerText();
  assert.match(v1txt, /Verdiğin oy: 👍 Evet/, 'yenileme sonrası verilen oy görünmeli');
  await shot(v1, 'g7-vote-after-reload');
  // ölü k1 oy veremez
  assert.equal(await k1.page.locator('button:has-text("Evet, asılsın")').count(), 0);
  await shot(k1, 'g7-vote-dead-view');
  await doc.page.click('button:has-text("Hayır")');
  await seer.page.click('button:has-text("Hayır")');
  await deli.page.click('button:has-text("Hayır")');
  // v2 oy vermez → 5 seçmen, 1 Evet → asılmaz; v2 oyu beklenir (süre dolar)
  for (const p of phones) await waitNet(p.page, "view.phase === 'day'", 20000);

  // ---- Deli oyundan ayrılır (gündüz)
  await deli.page.click('button:has-text("Odadan çık")');
  await waitNet(host.page, `view.players.find(p => p.id === '${deli.id}').death?.cause === 'left'`);
  await shot(host, 'g7-d1-after-leave');
  const leftTxt = await host.page.locator('#game-vampir').innerText();
  console.log('after leave text:', leftTxt.split('\n').filter((l) => /ayrıl/.test(l)));
  // 2 vampir vs doktor, gözcü, k2 → devam
  assert.equal((await state(host.page)).view.phase, 'day');

  // Host günü bitirir (host hayatta olmayabilir; yine de yetkili)
  await host.page.click('button:has-text("Geceye geç")');
  const alive = phones.filter((p) => p !== k1 && p !== deli);
  for (const p of alive) await waitNet(p.page, "view.phase === 'night' && view.night === 2");

  // ---- Gece 2: ölü k1 ekranı, gece ortasında vampir yenile
  await shot(k1, 'g7-n2-dead-koylu');
  assert.equal(await k1.page.locator('.target').count(), 0, 'ölüler gece görev almaz');
  await nightClick(v1, k2.name);
  await v1.page.reload();
  await waitNet(v1.page, "view && view.phase === 'night' && view.night === 2");
  await v1.page.waitForSelector('.target');
  assert.ok((await state(v1.page)).view.me.nightPick, 'yenileme sonrası vampir seçimi korunmalı');
  assert.equal(await v1.page.locator('.role-card.hidden-card').count(), 1, 'yenileme sonrası kart kapalı');
  await nightClick(v2, k2.name);
  await nightClick(doc, seer.name);
  await nightClick(seer, v2.name);
  await nightClick(k2, doc.name);
  for (const p of alive) await waitNet(p.page, "view.phase === 'over'");
  const over = (await state(host.page)).view;
  assert.equal(over.result.winner, 'vampires', '2 vampir vs 2 → vampirler kazanır');
  for (const p of [...alive, k1]) await shot(p, `g7-over-${p.name}-${p.role}`);
  await waitNet(spec.page, "view.phase === 'over'");
  await shot(spec, 'g7-over-spectator');
  const overTxt = await host.page.locator('#game-vampir').innerText();
  console.log('OVER:\n' + overTxt);
  // Ayrılan deli oyun sonu listesinde var mı?
  if (!new RegExp(`${deli.name}[^
]*oyundan ayrıldı`).test(overTxt)) bug('Ölümler listesinde ayrılan oyuncu "oyundan ayrıldı" olarak yok');
  if (!new RegExp(`${k1.name}[^
]*1\. gece öldürüldü`).test(overTxt)) bug('Ölümler listesinde 1. gece ölümü yok');
  const tags = await host.page.locator('#game-vampir').innerText();
  void tags;
  for (const p of [...phones, spec]) {
    const o = await overflow(p.page);
    if (o.scrollW > o.w || o.bad.length) note(`${p.name} taşma: ${JSON.stringify(o)}`);
    assert.deepEqual(roleLeaks(p), [], `${p.name} sızıntı`);
    const errs = realErrors(p);
    if (errs.length) note(`${p.name} konsol: ${errs.join(' | ')}`);
  }
});

test('Bulunan kural/ipucu ihlalleri (boş olmalı)', () => { assert.deepEqual(bugs, []); });
