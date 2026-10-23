// QA: 5 telefon (4 mobil + 1 masaüstü) Vampir Köylü — gece ekranı eşitliği (kart kapalı), doktor kurtarır,
// doktor aynı kişiyi üst üste koruyamaz, gözcü sonuçları birikir, başarısız yargılama + saat devamı,
// desteklenmeyen aday düşer, host günü erken bitirir, köy kazanır; lobiye dön → Deli asılır (2. oyun).
// Çalıştır: node --test tests/e2e/qa-vampir-game5.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, startGame, shot, state, waitNet, nightClick, closedTap, nightSignature, normalizedText, act, lastErrors,
  toastText, overflow, smallButtons, roleLeaks, realErrors, byRole, identify,
} from './qa-vampir-lib.mjs';

let env;
const notes = []; // gözlemler (testi düşürmeyen ama rapora girecek şeyler)
const note = (s) => { notes.push(s); console.log('NOTE:', s); };
const bugs = []; // kural/ipucu ihlalleri: son testte toplu olarak düşer (akış yarıda kalmasın diye)
const bug = (s) => { bugs.push(s); console.log('BUG:', s); };

before(async () => { env = await setup({ timeScale: 0.25 }); });
after(async () => { console.log('\n--- NOTES ---\n' + notes.join('\n')); await env?.close(); });

const NAMES = ['Ali', 'Burak', 'Ceren', 'Deniz', 'Ece'];
let G;

test('5 telefon: tam oyun (kurtarma, doktor kuralı, gözcü, başarısız yargılama, erken gece, köy kazanır)', async () => {
  G = await startGame(env, NAMES, { desktop: ['Ece'], settings: { 'Gece süresi': '120' } });
  const { phones, host } = G;
  const [vamp] = byRole(phones, 'vampir');
  const [doc] = byRole(phones, 'doktor');
  const [seer] = byRole(phones, 'gozcu');
  const [deli] = byRole(phones, 'deli');
  const [koy] = byRole(phones, 'koylu');
  assert.ok(vamp && doc && seer && deli && koy, 'beklenen roller: 1 vampir + doktor + gözcü + deli + köylü');
  console.log('roles', phones.map((p) => `${p.name}=${p.role}`).join(' '));

  // ---- Gece 1, kart KAPALI: herkesin ekranı aynı mı?
  const sigs = {};
  const texts = {};
  for (const p of phones) {
    await p.page.waitForSelector('.role-card.hidden-card');
    sigs[p.role] = await nightSignature(p);
    if (p !== G.host) texts[p.role] = await normalizedText(p); // host'ta fazladan "Oyunu iptal et" var
    await shot(p, `g5-n1-closed-${p.role}${p.name === 'Ece' ? '-desktop' : ''}`);
  }
  console.log('closed signatures', JSON.stringify(sigs, null, 1));
  const distinctTexts = new Set(Object.values(texts));
  if (distinctTexts.size > 1) bug(`Gece 1 kart kapalı: normalize metinler roller arasında farklı (${distinctTexts.size} çeşit): ${JSON.stringify(texts)}`);
  const disabledByRole = Object.fromEntries(Object.entries(sigs).map(([r, s]) => [r, s.disabled.join(',') || '(yok)']));
  if (new Set(Object.values(disabledByRole)).size > 1) bug(`GÖRSEL İPUCU gece 1: pasif düğmeler role göre farklı: ${JSON.stringify(disabledByRole)}`);

  // Kart kapalıyken herkes kendi adına ve başka birine dokunursa: herkes için aynı tepki olmalı (PLAN §4.3)
  const closedReact = {};
  for (const p of phones) {
    const other = phones.find((x) => x !== p && x.role !== 'vampir') ?? phones.find((x) => x !== p);
    const r = [];
    for (const name of [p.name, other.name]) {
      await closedTap(p, name);
      await p.page.waitForTimeout(300);
      r.push({ toast: await toastText(p), chosen: (await nightSignature(p)).chosen });
      await p.page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    }
    closedReact[p.role] = r;
  }
  console.log('closed taps:', JSON.stringify(closedReact));
  if (new Set(Object.values(closedReact).map((x) => JSON.stringify(x))).size > 1) bug(`Kart kapalı dokunuşlara roller farklı tepki veriyor: ${JSON.stringify(closedReact)}`);
  assert.equal(closedReact.koylu[0].toast, 'Seçim yapmak için kartını aç.');
  assert.equal((await state(host.page)).view.nightProgress.done, 0, 'kart kapalı dokunuş seçim sayılmamalı');
  await shot(doc, 'g5-n1-closed-doctor-selftap');
  await shot(koy, 'g5-n1-closed-koylu-selftap');

  // Kartı aç (görev metinlerini gör); tüm kartlar aynı renk/sınıf olmalı
  const openCls = {};
  for (const p of phones) {
    await p.page.click('.role-card');
    openCls[p.role] = await p.page.evaluate(() => {
      const c = document.querySelector('#game-vampir .role-card');
      const cs = getComputedStyle(c);
      return `${c.className}|${cs.borderColor}|${cs.backgroundImage.slice(0, 60)}`;
    });
    await shot(p, `g5-n1-open-${p.role}`);
  }
  if (new Set(Object.values(openCls)).size > 1) bug(`Açık rol kartları role göre farklı renkte: ${JSON.stringify(openCls)}`);
  // Kart açıkken pasifler: vampir/köylü/gözcü/deli kendi adı, doktor hiçbiri
  const openDis = {};
  for (const p of phones) openDis[p.role] = (await nightSignature(p)).disabled.join(',') || '(yok)';
  console.log('open disabled:', JSON.stringify(openDis));
  assert.equal(openDis.doktor, '(yok)');
  assert.equal(openDis.koylu, 'SELF');
  // Mobil 360'ta taşma / küçük düğme
  for (const p of phones.filter((x) => x.name !== 'Ece')) {
    const o = await overflow(p.page);
    if (o.scrollW > o.w || o.bad.length) note(`${p.name} gece taşma: ${JSON.stringify(o)}`);
    const sb = await smallButtons(p.page);
    if (sb.length) note(`${p.name} gece <44px: ${JSON.stringify(sb)}`);
  }

  // ---- Gece 1 seçimleri (kart açık): vampir → köylü, doktor → köylü (kurtarır), gözcü → deli
  await nightClick(vamp, koy.name);
  await nightClick(doc, koy.name);
  await nightClick(seer, deli.name);
  await seer.page.waitForTimeout(300);
  const seerHint = await seer.page.locator('#game-vampir .card .hint').first().innerText();
  console.log('seer open hint:', seerHint);
  await nightClick(seer, koy.name); // ikinci bakış: sessizce yok sayılır
  await seer.page.waitForTimeout(400);
  const seerToast = await toastText(seer);
  if (seerToast) bug(`Gözcü ikinci dokunuşta toast: "${seerToast}"`);
  const sres = (await state(seer.page)).view.me.seerResults;
  assert.equal(sres.length, 1, 'gözcü gecede tek bakar');
  await shot(seer, 'g5-n1-seer-second-tap');
  // Kart kapatınca: vurgu yok, ipucu "✓ Seçimini yaptın"
  for (const p of [vamp, doc, seer]) {
    await p.page.click('.role-card');
    const sig = await nightSignature(p);
    if (sig.chosen !== 0) bug(`${p.role}: kart kapalıyken seçim vurgusu görünüyor`);
    assert.match(sig.hint, /Seçimini yaptın/);
  }
  await shot(vamp, 'g5-n1-closed-after-pick-vampir');
  // Vampir kartı kapalıyken + seçim yapmış; köylü henüz seçmedi → metin farkı sadece "seçti/seçmedi"
  await nightClick(deli, vamp.name);
  await nightClick(koy, deli.name);

  for (const p of phones) await waitNet(p.page, "view.phase === 'day'");
  const ann = await host.page.locator('.announce').innerText();
  assert.match(ann, /kimse ölmedi/, 'doktor kurbanı korudu → kimse ölmemeli');
  await shot(host, 'g5-d1-morning-host');

  // Gözcünün sonucu
  let sv = (await state(seer.page)).view;
  assert.equal(sv.me.seerResults.length, 1);
  assert.equal(sv.me.seerResults[0].isVampire, false);
  // kartlar açıksa gündüz de açık kalır mı? (rol telefonda açık kalabilir)
  for (const p of phones) {
    if (await p.page.locator('.role-card:not(.hidden-card)').count()) bug(`${p.name} (${p.role}): gece açılan kart gündüze geçince açık kaldı`);
  }
  await shot(vamp, 'g5-d1-vamp-card-after-phase');
  for (const p of phones) if (await p.page.locator('.role-card:not(.hidden-card)').count()) await p.page.click('.role-card');

  // ---- Başarısız yargılama: köylü deliyi aday gösterir, doktor destekler, çoğunluk Hayır
  const before1 = (await state(host.page)).view.endsAt;
  await koy.page.locator('#game-vampir .player-list li', { hasText: deli.name }).locator('button:has-text("Aday göster")').click();
  await doc.page.waitForSelector('button:has-text("Destekliyorum")');
  await shot(doc, 'g5-d1-nomination-supporter');
  // aday ve aday gösteren destekleyemez
  assert.equal(await koy.page.locator('button:has-text("Destekliyorum")').count(), 0);
  assert.equal(await deli.page.locator('button:has-text("Destekliyorum")').count(), 0);
  const tTrial = Date.now();
  const remainingAtTrial = before1 - tTrial; // yaklaşık (istemci saati ≈ sunucu)
  await doc.page.click('button:has-text("Destekliyorum")');
  for (const p of phones) await waitNet(p.page, "view.phase === 'trial'");
  await shot(deli, 'g5-d1-defense-accused');
  await shot(koy, 'g5-d1-defense-other');
  await deli.page.click('button:has-text("Savunmam bitti")');
  for (const p of phones) await waitNet(p.page, "view.phase === 'trialVote'");
  await shot(koy, 'g5-d1-vote-before');
  // 4 seçmen: 2 Evet + 1 Hayır + 1 oy vermez (=Hayır) → 2*2 <= 4 → asılmaz
  await koy.page.click('button:has-text("Evet, asılsın")');
  await doc.page.click('button:has-text("Evet, asılsın")');
  await seer.page.click('button:has-text("Hayır")');
  await shot(koy, 'g5-d1-vote-after-own');
  // vampir oy vermez → süre dolar (30 sn * 0.25)
  const tVoteStart = Date.now();
  for (const p of phones) await waitNet(p.page, "view.phase === 'day'", 20000);
  const resumeAt = Date.now();
  const v1 = (await state(host.page)).view;
  const remainingAfter = v1.endsAt - resumeAt;
  console.log({ remainingAtTrial, remainingAfter, voteWait: resumeAt - tVoteStart });
  assert.ok(Math.abs(remainingAfter - remainingAtTrial) < 2500, `saat kaldığı yerden sürmeli: önce ${remainingAtTrial} sonra ${remainingAfter}`);
  assert.equal(v1.lastTrial.hanged, false);
  await shot(host, 'g5-d1-after-failed-trial');
  const failedTxt = await host.page.locator('#game-vampir').innerText();
  assert.match(failedTxt, /asılmadı/);
  // Deli bugün aday gösterilmiş oldu; köylü hakkını kullandı
  assert.equal(await koy.page.locator('button:has-text("Aday göster")').count(), 0, 'köylü günde bir kez aday gösterebilir');

  // ---- Desteklenmeyen aday 30 sn (×0.25 = 7.5 sn) sonra düşmeli
  await seer.page.locator('#game-vampir .player-list li', { hasText: vamp.name }).locator('button:has-text("Aday göster")').click();
  await doc.page.waitForSelector('button:has-text("Destekliyorum")');
  await shot(doc, 'g5-d1-nomination2');
  await doc.page.waitForTimeout(9000);
  const stale = await doc.page.locator('button:has-text("Destekliyorum")').count();
  const nomButtons = await doc.page.locator('button:has-text("Aday göster")').count();
  await shot(doc, 'g5-d1-nomination2-after-expiry-doc');
  if (stale) {
    bug(`Aday süresi dolduktan sonra "Destekliyorum" kartı hâlâ ekranda (doktor), doktorun "Aday göster" düğmesi sayısı: ${nomButtons}`);
    await doc.page.click('button:has-text("Destekliyorum")');
    await doc.page.waitForTimeout(400);
    note(`Süresi dolmuş adaya destek → toast: "${await toastText(doc)}"`);
  }
  // Ekran güncellensin diye (başka bir view tetiklemeden) doktor yeni aday gösterebiliyor mu?
  if (!(nomButtons > 0)) bug('süresi dolan adaydan sonra kimse yeni aday gösteremiyor (düğmeler gizli; sunucu süre dolunca yayın yapmıyor)');

  // ---- Host günü erken bitirir (confirm otomatik kabul)
  await host.page.click('button:has-text("Geceye geç")');
  for (const p of phones) await waitNet(p.page, "view.phase === 'night' && view.night === 2");
  assert.ok(host.dialogs.some((d) => /Tartışma bitsin/.test(d)));

  // ---- Gece 2: doktor dün koruduğunu (köylü) koruyamaz
  await doc.page.click('.role-card');
  const docBtnDisabled = await doc.page.locator('#game-vampir .target', { hasText: koy.name }).first().isDisabled();
  assert.equal(docBtnDisabled, true, 'doktor dün koruduğu kişiyi seçememeli (düğme pasif)');
  await shot(doc, 'g5-n2-doctor-open');
  await act(doc, { type: 'nightPick', targetId: koy.id });
  await doc.page.waitForTimeout(300);
  assert.ok(lastErrors(doc, 1)[0], 'sunucu doktorun aynı kişiyi tekrar korumasını reddetmeli');
  console.log('doctor repeat error:', lastErrors(doc, 1)[0]);
  await doc.page.click('.role-card'); // kapat
  // Kart kapalı, gece 2 imzaları
  const sigs2 = {};
  for (const p of phones) {
    if (await p.page.locator('.role-card:not(.hidden-card)').count()) await p.page.click('.role-card');
    sigs2[p.role] = await nightSignature(p);
    await shot(p, `g5-n2-closed-${p.role}`);
  }
  const dis2 = Object.fromEntries(Object.entries(sigs2).map(([r, s]) => [r, s.disabled.join(',') || '(yok)']));
  if (new Set(Object.values(dis2)).size > 1) bug(`GÖRSEL İPUCU gece 2: pasif düğmeler role göre farklı: ${JSON.stringify(dis2)}`);

  // Vampir köylüyü öldürür; doktor gözcüyü korur; gözcü vampire bakar
  await nightClick(vamp, koy.name);
  await nightClick(doc, seer.name);
  await nightClick(seer, vamp.name);
  await nightClick(deli, doc.name);
  await nightClick(koy, deli.name);
  for (const p of phones) await waitNet(p.page, "view.phase === 'day' && view.night === 2");
  const ann2 = await host.page.locator('.announce').innerText();
  assert.match(ann2, new RegExp(`${koy.name}.*öldü`));
  assert.ok(!/Vampir|Köylü|Doktor|Gözcü|Deli/.test(ann2), 'duyuruda rol yok');
  // dünkü başarısız yargılama satırı bugün hâlâ duruyor mu?
  const d2txt = await host.page.locator('#game-vampir').innerText();
  if (/asılmadı/.test(d2txt)) bug('2. gün sabahı, 1. günün başarısız yargılama satırı ("... asılmadı") hâlâ gösteriliyor (bayat bilgi)');
  await shot(host, 'g5-d2-morning-host');
  await shot(koy, 'g5-d2-dead-koylu');
  // Ölü köylünün ekranı: aday gösterme yok, destek yok, eylem reddi
  assert.equal(await koy.page.locator('button:has-text("Aday göster")').count(), 0);
  await act(koy, { type: 'nominate', targetId: vamp.id });
  await koy.page.waitForTimeout(300);
  assert.match(lastErrors(koy, 1)[0] ?? '', /Ölüler/);

  // Gözcü sonuçları birikti
  sv = (await state(seer.page)).view;
  assert.equal(sv.me.seerResults.length, 2);
  assert.equal(sv.me.seerResults[1].isVampire, true);
  await seer.page.click('.role-card');
  await shot(seer, 'g5-d2-seer-card-open');
  const seerCard = await seer.page.locator('.role-card').innerText();
  assert.match(seerCard, /1\. gece.*Vampir değil/s);
  assert.match(seerCard, /2\. gece.*Vampir/s);
  await seer.page.click('.role-card');

  // ---- Vampiri as: gözcü aday gösterir, doktor destekler, vampir savunmayı bitirir, 3 Evet → köy kazanır
  await seer.page.locator('#game-vampir .player-list li', { hasText: vamp.name }).locator('button:has-text("Aday göster")').click();
  await doc.page.waitForSelector('button:has-text("Destekliyorum")');
  await doc.page.click('button:has-text("Destekliyorum")');
  await vamp.page.waitForSelector('button:has-text("Savunmam bitti")');
  await vamp.page.click('button:has-text("Savunmam bitti")');
  for (const p of [seer, doc, deli]) {
    await p.page.waitForSelector('button:has-text("Evet, asılsın")');
    await p.page.click('button:has-text("Evet, asılsın")');
  }
  for (const p of phones) await waitNet(p.page, "view.phase === 'over'");
  const over = (await state(host.page)).view;
  assert.equal(over.result.winner, 'town');
  for (const p of phones) await shot(p, `g5-over-${p.role}${p.name === 'Ece' ? '-desktop' : ''}`);
  const overTxt = await host.page.locator('#game-vampir').innerText();
  console.log('OVER TEXT:\n' + overTxt);
  if (!new RegExp(`${vamp.name}[^
]*2\. gün asıldı`).test(overTxt)) bug('Oyun sonu "Ölümler" listesinde asılan vampir "2. gün asıldı" olarak yok');
  if (!new RegExp(`${koy.name}[^
]*2\. gece öldürüldü`).test(overTxt)) bug('Oyun sonu "Ölümler" listesinde gece ölümü yok');
  for (const p of phones) {
    const o = await overflow(p.page);
    if (o.scrollW > o.w || o.bad.length) note(`${p.name} oyun sonu taşma: ${JSON.stringify(o)}`);
  }
  for (const p of phones) {
    const leaks = roleLeaks(p);
    assert.deepEqual(leaks, [], `${p.name} (${p.role}) görünümünde gizli bilgi sızıntısı`);
    assert.deepEqual(realErrors(p), [], `${p.name} konsol hatası`);
  }
});

test('Lobiye dön ve tekrar oyna: Deli asılır → Deli tek başına kazanır', async () => {
  const { phones, host } = G;
  await host.page.click('button:has-text("Bekleme odasına dön")');
  for (const p of phones) await waitNet(p.page, "room && room.phase === 'lobby'");
  await shot(host, 'g5-lobby-again');
  // Elle 2 vampir seç: 5 kişide üst sınır 1 (PLAN §4.3)
  await host.page.locator('#game-vampir label', { hasText: 'Vampir sayısı' }).locator('select').selectOption('2');
  await host.page.waitForTimeout(300);
  await shot(host, 'g5-lobby-2vamps-5players');
  await host.page.click('#game-vampir button:has-text("Oyunu başlat")');
  for (const p of phones) await waitNet(p.page, "room.phase === 'playing' && view && view.phase === 'night' && view.night === 1 && !view.result");
  await identify(phones);
  // Kart her yeni oyunda kapalı başlamalı
  for (const p of phones) assert.equal(await p.page.locator('.role-card.hidden-card').count(), 1, `${p.name}: yeni oyunda kart kapalı başlamalı`);
  const [deli] = byRole(phones, 'deli');
  const [vamp] = byRole(phones, 'vampir');
  assert.equal(byRole(phones, 'vampir').length, 1, '5 kişide elle 2 seçilse de 1 vampir');
  console.log('roles2', phones.map((p) => `${p.name}=${p.role}`).join(' '));
  // Gece: vampir deli dışındaki birini seçmesin → herkes vampir dışı birini seçsin; vampir deliye değil, doktor kurbana
  const victim = phones.find((p) => p.role === 'koylu');
  const doc = phones.find((p) => p.role === 'doktor');
  for (const p of phones) {
    const s = await state(p.page);
    let t = s.view.me.nightTargets[0];
    if (p === vamp) t = victim.id;
    else if (p === doc) t = victim.id;
    await act(p, { type: 'nightPick', targetId: t });
  }
  for (const p of phones) await waitNet(p.page, "view.phase === 'day'");
  const voters = phones.filter((p) => p !== deli);
  await voters[0].page.locator('#game-vampir .player-list li', { hasText: deli.name }).locator('button:has-text("Aday göster")').click();
  await voters[1].page.waitForSelector('button:has-text("Destekliyorum")');
  await voters[1].page.click('button:has-text("Destekliyorum")');
  // savunmayı bitirmesin: savunma süresi (30 sn × 0.25) dolsun
  for (const p of voters) await waitNet(p.page, "view.phase === 'trialVote'", 15000);
  await Promise.all(voters.slice(0, 3).map((p) => p.page.click('button:has-text("Evet, asılsın")')));
  for (const p of phones) await waitNet(p.page, "view.phase === 'over'", 15000);
  const v = (await state(host.page)).view;
  assert.equal(v.result.winner, 'jester');
  assert.deepEqual(v.result.winnerIds, [deli.id]);
  await shot(deli, 'g5-game2-over-deli');
  await shot(host, 'g5-game2-over-host');
  for (const p of phones) assert.deepEqual(realErrors(p), [], `${p.name} konsol hatası`);
});

test('Bulunan kural/ipucu ihlalleri (boş olmalı)', () => {
  assert.deepEqual(bugs, []);
});
