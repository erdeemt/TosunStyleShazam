// QA: 10 telefon (9 mobil + 1 masaüstü), otomatik 2 vampir. Süreler: gece kimse seçmeden biter,
// gündüz kimse asılmadan biter, desteksiz aday düşer, host günü erken bitirir, vampir oyu eşit → rastgele,
// köy iki vampiri asarak kazanır. Hızlı ölçek (TIME_SCALE=0.1).
// Çalıştır: node --test tests/e2e/qa-vampir-game10.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, startGame, shot, state, waitNet, nightSignature, act, toastText, overflow, smallButtons, roleLeaks, realErrors, byRole,
} from './qa-vampir-lib.mjs';

let env;
const notes = [];
const note = (s) => { notes.push(s); console.log('NOTE:', s); };
const bugs = [];
const bug = (s) => { bugs.push(s); console.log('BUG:', s); };

before(async () => { env = await setup({ timeScale: 0.1 }); });
after(async () => { console.log('\n--- NOTES ---\n' + notes.join('\n')); await env?.close(); });

const NAMES = ['Arda', 'Bora', 'Cansu', 'Derya', 'Elif', 'Furkan', 'Gizem', 'Hakan', 'Irmak', 'Kerem'];
const all = (ps, pred, t = 20000) => Promise.all(ps.map((p) => waitNet(p.page, pred, t)));

test('10 telefon: süreler, erken gece, eşit vampir oyu, köy kazanır', async () => {
  const { phones, host } = await startGame(env, NAMES, { desktop: ['Kerem'], settings: { 'Gece süresi': '30', 'Gündüz tartışması': '2' } });
  console.log('roles', phones.map((p) => `${p.name}=${p.role}`).join(' '));
  const vamps = byRole(phones, 'vampir');
  assert.equal(vamps.length, 2, '10 kişide otomatik 2 vampir');
  const [doc] = byRole(phones, 'doktor');
  const kois = byRole(phones, 'koylu');
  assert.equal(kois.length, 5);

  // Kart kapalı imza (hepsi aynı mı)
  const sigs = await Promise.all(phones.map(async (p) => ({ role: p.role, ...(await nightSignature(p)) })));
  const keyOf = (s) => JSON.stringify({ n: s.nTargets, d: s.disabled, c: s.chosen, a: s.allyTags, cl: s.cardClass, h: s.hint });
  if (new Set(sigs.map(keyOf)).size > 1) bug(`10 kişi gece 1 kart kapalı imzalar farklı: ${JSON.stringify(sigs.map((s) => [s.role, keyOf(s)]))}`);
  await shot(vamps[0], 'g10-n1-closed-vampir');
  await shot(kois[0], 'g10-n1-closed-koylu');
  await shot(phones[9], 'g10-n1-closed-desktop');
  for (const p of phones.slice(0, 9)) {
    const o = await overflow(p.page);
    if (o.scrollW > o.w || o.bad.length) note(`${p.name} 360 gece taşma: ${JSON.stringify(o)}`);
    const sb = await smallButtons(p.page);
    if (sb.length) note(`${p.name} <44px: ${JSON.stringify(sb)}`);
  }

  // ---- Gece 1: kimse seçmez → süre dolar (30 sn × 0.1 = 3 sn) → kimse ölmez
  await all(phones, "view.phase === 'day' && view.night === 1");
  const ann1 = await host.page.locator('.announce').innerText();
  assert.match(ann1, /kimse ölmedi/);
  await shot(host, 'g10-d1-nobody-died');

  // ---- Gündüz 1: desteksiz aday (30 sn × 0.1 = 3 sn) düşer; sonra gündüz süresi dolar (2 dk × 0.1 = 12 sn)
  const [a, b] = kois;
  await act(a, { type: 'nominate', targetId: b.id });
  await waitNet(host.page, 'view.nomination');
  await host.page.waitForTimeout(4000);
  const sv = (await state(host.page)).view;
  const stillShown = await host.page.locator('text=aday gösterdi').count();
  await shot(host, 'g10-d1-nomination-expired');
  await waitNet(host.page, '!view.nomination', 3000).catch(() => {});
  if ((await state(host.page)).view.nomination || await host.page.locator('text=aday gösterdi').count()) bug(`Desteksiz aday süresi dolduğu halde ekranda duruyor (view.nomination=${!!sv.nomination}, metin=${stillShown}); sunucu süre dolunca yayın yapmıyor`);
  // Süre dolunca başka biri yeni aday gösterebilmeli (düğmeler geri gelmeli)
  const c = kois[1] === b ? kois[3] : kois[1];
  const nomBtns = await c.page.locator('button:has-text("Aday göster")').count();
  if (!nomBtns) bug('Aday düştükten sonra "Aday göster" düğmeleri geri gelmedi');
  await c.page.locator('#game-vampir .player-list li', { hasText: a.name }).locator('button:has-text("Aday göster")').click();
  await waitNet(host.page, `view.nomination && view.nomination.byId === '${c.id}'`);
  // aynı anda tek aday: üçüncü kişi aday gösteremez
  await act(kois[4], { type: 'nominate', targetId: c.id });
  await kois[4].page.waitForTimeout(300);
  assert.equal((await state(host.page)).view.nomination.byId, c.id, 'aynı anda tek aday');
  // bekleyen aday varken host günü bitiremez
  await act(host, { type: 'endDay' });
  await host.page.waitForTimeout(300);
  assert.equal((await state(host.page)).view.phase, 'day');
  // Süresi dolan adaydan sonra host "Geceye geç" diyebilir mi?
  // (yeni sunucu kuralı: bekleyen aday varken erken gece yok) → burada denemiyoruz; gündüz kendi kendine bitsin
  await all(phones, "view.phase === 'night' && view.night === 2", 20000);
  // dünkü duyuru gece ekranında görünmemeli
  await shot(host, 'g10-n2-after-day-timeout');

  // ---- Gece 2: iki vampir aynı köylüyü seçer, doktor başka birini korur → köylü ölür
  const victim = kois[2];
  const others = phones.filter((p) => !vamps.includes(p));
  await Promise.all(vamps.map((v) => act(v, { type: 'nightPick', targetId: victim.id })));
  for (const p of others) {
    const me = (await state(p.page)).view.me;
    const t = me.nightTargets.find((id) => id !== victim.id);
    await act(p, { type: 'nightPick', targetId: t });
  }
  await all(phones, "view.phase === 'day' && view.night === 2");
  assert.match(await host.page.locator('.announce').innerText(), new RegExp(`${victim.name}.*öldü`));

  // ---- Gündüz 2: host erken bitirir (aday yokken)
  await host.page.click('button:has-text("Geceye geç")');
  await all(phones, "view.phase === 'night' && view.night === 3");

  // ---- Gece 3: vampirler farklı kişileri seçer → eşitlik → ikisinden biri rastgele ölür
  const [t1, t2] = [kois[3], kois[4]];
  await act(vamps[0], { type: 'nightPick', targetId: t1.id });
  await act(vamps[1], { type: 'nightPick', targetId: t2.id });
  // vampir 1 kartı açınca müttefiğin seçimini görür
  await vamps[0].page.click('.role-card');
  await vamps[0].page.waitForSelector('.ally-pick');
  await shot(vamps[0], 'g10-n3-vampir-ally-picks');
  await vamps[0].page.click('.role-card');
  for (const p of others.filter((x) => x !== victim)) {
    const me = (await state(p.page)).view.me;
    await act(p, { type: 'nightPick', targetId: me.nightTargets.find((id) => id !== t1.id && id !== t2.id) });
  }
  await all(phones, "view.phase === 'day' && view.night === 3");
  const d3 = (await state(host.page)).view;
  const dead3 = d3.announcement.deadId;
  assert.ok([t1.id, t2.id].includes(dead3), 'eşitlikte eşitlerden biri ölmeli');

  // ---- Gündüz 3: vampir 1 asılır (act ile hızlı)
  const living = () => phones.filter((p) => state && true);
  const aliveNow = async () => { const v = (await state(host.page)).view; return phones.filter((p) => v.players.find((x) => x.id === p.id).alive); };
  async function hang(target) {
    const al = await aliveNow();
    const [nom, sup] = al.filter((p) => p !== target && !vamps.includes(p));
    await act(nom, { type: 'nominate', targetId: target.id });
    await waitNet(sup.page, 'view.nomination');
    await act(sup, { type: 'support' });
    await waitNet(target.page, "view.phase === 'trial'");
    await act(target, { type: 'endDefense' });
    await waitNet(host.page, "view.phase === 'trialVote'");
    await Promise.all(al.filter((p) => p !== target).map((p) => act(p, { type: 'trialVote', yes: true })));
  }
  await hang(vamps[0]);
  await all(phones, "view.phase === 'night' || view.phase === 'over'");
  assert.equal((await state(host.page)).view.phase, 'night', '1 vampir kaldı, oyun sürer');
  await shot(vamps[0], 'g10-n4-hanged-vampire-dead');
  const deadVampView = (await state(vamps[0].page)).view;
  assert.equal(deadVampView.me.allyPicks, undefined, 'ölü vampire müttefik gece seçimleri gitmemeli');

  // ---- Gece 4: vampir 2 birini öldürür
  const al4 = await aliveNow();
  const vic4 = al4.find((p) => p.role === 'koylu');
  await act(vamps[1], { type: 'nightPick', targetId: vic4.id });
  for (const p of al4.filter((x) => x !== vamps[1])) {
    const me = (await state(p.page)).view.me;
    await act(p, { type: 'nightPick', targetId: me.nightTargets.find((id) => id !== vic4.id) });
  }
  await all(phones, "view.phase === 'day'");
  await hang(vamps[1]);
  await all(phones, "view.phase === 'over'");
  const over = (await state(host.page)).view;
  assert.equal(over.result.winner, 'town');
  await shot(host, 'g10-over-host');
  await shot(phones[9], 'g10-over-desktop');
  const overTxt = await host.page.locator('#game-vampir').innerText();
  console.log('OVER:\n' + overTxt);
  for (const p of phones) {
    const o = await overflow(p.page);
    if (o.scrollW > o.w || o.bad.length) note(`${p.name} oyun sonu taşma: ${JSON.stringify(o)}`);
    assert.deepEqual(roleLeaks(p), [], `${p.name} sızıntı`);
    const errs = realErrors(p);
    if (errs.length) note(`${p.name} konsol: ${errs.join(' | ')}`);
  }
  void living; void doc; void toastText;
});

test('Bulunan kural/ipucu ihlalleri (boş olmalı)', () => { assert.deepEqual(bugs, []); });
