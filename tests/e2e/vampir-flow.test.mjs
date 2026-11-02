// Tarayıcı testi: 🧛 Vampir Aşama 2 — anlatıcı akışı. 3 telefon (biri 3D kapalı → 2D anlatıcı kartı) + 2 🤖 bot:
// açılış (dusk/intro) → gece → sabah anlatımı (ölüm animasyonu) → gündüz → aday/destek ipuçları → savunma → oylama →
// karar anlatımı (mancınık / kurtuldu) → akşam. Anlatıcı satırı her telefonda aynı; kartlar kapalıyken sahne tarifi
// (data-state) herkeste aynı. Ekranlar test-results/vampir-flow/ (FLOW_SHOTS verilirse bir kopyası flow-*.png).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, phone, applySettings, nightClick, state, waitNet, realErrors } from './qa-vampir-lib.mjs';
import { MOBILE } from './qa-lib.mjs';

const SHOTS = fileURLToPath(new URL('../../test-results/vampir-flow/', import.meta.url));
const EXTRA = process.env.FLOW_SHOTS;
let env;
before(async () => { mkdirSync(SHOTS, { recursive: true }); env = await setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

async function snap(p, label) {
  await p.page.screenshot({ path: `${SHOTS}${label}.png` });
  if (EXTRA) await p.page.screenshot({ path: `${EXTRA}/flow-${label}.png` });
}
const narr = (p) => p.page.evaluate(() => {
  const n = document.querySelector('#game-vampir .vnar');
  return n && { active: n.classList.contains('active'), kind: n.dataset.kind, beat: n.dataset.beat, cue: n.dataset.cue ?? '', cueing: n.classList.contains('cueing'),
    title: n.querySelector('.vnar-title')?.textContent, hidden: n.hidden, visible: !!n.offsetParent };
});
const stageState = (p) => p.page.locator('#game-vampir .v3d').getAttribute('data-state');
// Sunucu saatinde anlatımın belli bir kesrine kadar bekle (her telefon aynı anı görür)
async function waitFrac(p, frac, extraMs = 0) {
  // (waitForFunction async koşulu Promise'i "doğru" sayar; bu yüzden kalan süre burada hesaplanır)
  const left = await p.page.evaluate(async ([f, extra]) => {
    const { net } = await import('/net.js');
    const n = net.view?.narration;
    if (!n || !n.endsAt) return 0;
    return n.startedAt + (n.endsAt - n.startedAt) * f + extra - (Date.now() + net.serverOffset);
  }, [frac, extraMs]);
  if (left > 0) await p.page.waitForTimeout(left + 60);
}
// Bütün telefonlarda aynı anda anlatıcı satırı (küçük zaman farkı: bir kez yeniden dene)
async function sameNarration(phones) {
  for (let i = 0; i < 3; i++) {
    const ns = await Promise.all(phones.map(narr));
    if (new Set(ns.map((n) => `${n.kind}|${n.beat}|${n.title}`)).size === 1) return ns[0];
    await phones[0].page.waitForTimeout(120);
  }
  const ns = await Promise.all(phones.map(narr));
  assert.fail(`anlatıcı satırı telefonlarda farklı: ${JSON.stringify(ns)}`);
}

test('anlatıcı akışı: açılış → gece → sabah → aday/destek → oylama → karar → akşam; her telefonda aynı', async () => {
  const a = await phone(env, 'Ali');
  const b = await phone(env, 'Ayşe');
  const ctx2d = await env.browser.newContext(MOBILE);
  await ctx2d.addInitScript(() => { try { localStorage.setItem('tss:vampir-3d', '0'); } catch { /* */ } });
  const c = await phone(env, 'Can', { ctx: ctx2d });
  const humans = [a, b, c];
  await a.page.click('text=Yeni oda kur');
  await a.page.waitForSelector('.lobby-code');
  const code = (await a.page.locator('.lobby-code').textContent()).trim();
  for (const p of [b, c]) {
    await p.page.fill('.code-input', code.toLowerCase());
    await p.page.click('button:has-text("Katıl")');
    await p.page.waitForSelector('.lobby-code, .room-bar');
  }
  for (let i = 0; i < 2; i++) {
    await a.page.click('#game-vampir button.add-bot');
    await waitNet(a.page, `room && room.players.length === ${4 + i}`);
  }
  await applySettings(a, { Deli: false, 'Savunma süresi': 15, 'Gece süresi': 120 });
  await a.page.click('#game-vampir button:has-text("Oyunu başlat")');

  // ---- Açılış anlatımı (dusk/intro)
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'dusk'");
  for (const p of humans) await p.page.waitForSelector('#game-vampir .vnar.active[data-kind="intro"] .vnar-box');
  const intro = await sameNarration(humans);
  assert.match(intro.title, /Köye hoş geldiniz/);
  const nc = await narr(c);
  assert.ok(nc.visible, '3D kapalı telefonda anlatıcı kartı görünür');
  assert.equal(await c.page.locator('#game-vampir .v3d.off').count(), 1);
  const ready = await a.page.locator('#game-vampir .v3d').getAttribute('data-ready');
  console.log(`# vampir-flow: sahne kipi = ${ready}`);
  await waitFrac(a, 0.4);
  const intro2 = await sameNarration(humans);
  assert.match(intro2.title, /Roller dağıtıldı/);
  await snap(a, 'dusk-intro');
  await snap(c, 'dusk-intro-2d');
  // anlatıcı konuşurken: büyük sayaç yok, oyuncu listesi var (akşam), hedef düğmesi yok
  assert.equal(await a.page.locator('#game-vampir .big-timer').count(), 0);
  assert.equal(await a.page.locator('#game-vampir .target').count(), 0);
  let st = await Promise.all(humans.map(stageState));
  assert.equal(new Set(st).size, 1, 'açılış: sahne tarifi herkeste aynı');
  assert.equal(JSON.parse(st[0]).sky, 'night');

  // ---- Gece: insanlar kartını açıp bir bota (izin varsa) dokunur
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'night'", 15000);
  const s0 = await state(a.page);
  const botIds = s0.room.players.filter((x) => x.bot).map((x) => x.id);
  for (const p of humans) {
    const s = await state(p.page);
    p.id = s.playerId;
    const me = s.view.me;
    const target = me.nightTargets.find((id) => botIds.includes(id)) ?? me.nightTargets.find((id) => id !== p.id) ?? me.nightTargets[0];
    await nightClick(p, s.view.players.find((x) => x.id === target).name);
  }
  // ---- Sabah anlatımı
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'dawn'", 20000);
  for (const p of humans) await p.page.waitForSelector('#game-vampir .vnar.active[data-kind="dawn"] .vnar-box');
  assert.match((await sameNarration(humans)).title, /Sabah oldu/);
  st = await Promise.all(humans.map(stageState));
  assert.equal(new Set(st).size, 1, 'sabah (kartlar kapalı): sahne tarifi herkeste aynı');
  const dawnDesc = JSON.parse(st[0]);
  assert.equal(dawnDesc.sky, 'day');
  const dawnView = (await state(a.page)).view;
  const deadId = dawnView.narration.deadId;
  if (deadId) assert.ok(['bats', 'tomb', 'coffin'].includes(dawnDesc.narr.style));
  // oyuncu listesi açıklamadan önce gösterilmez (ölüm herkese anlatıcıyla birlikte açıklanır)
  assert.equal(await a.page.locator('#game-vampir .player-list').count(), 0);
  await waitFrac(a, 0.45, 1300); // açıklama + ölüm animasyonunun ortası
  const reveal = await sameNarration(humans);
  if (deadId) assert.equal(reveal.title, `${dawnView.players.find((x) => x.id === deadId).name} bu gece öldü.`);
  else assert.equal(reveal.title, 'Bu gece kimse ölmedi!');
  await snap(a, `dawn-${deadId ? dawnDesc.narr.style : 'nobody'}`);
  await snap(c, 'dawn-2d');
  console.log(`# vampir-flow: sabah ölen=${deadId ? 'var' : 'yok'} tür=${dawnDesc.narr?.style}`);

  // ---- Gündüz: insan aday gösterir, diğer insan destekler
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'day'", 15000);
  const day = (await state(a.page)).view;
  const alive = (id) => day.players.find((x) => x.id === id)?.alive;
  const liveHumans = humans.filter((p) => alive(p.id));
  const accusedId = botIds.find(alive);
  const accusedName = day.players.find((x) => x.id === accusedId).name;
  const [nominator, supporter] = liveHumans;
  await nominator.page.locator('#game-vampir .player-list li', { hasText: accusedName }).locator('button:has-text("Aday göster")').click();
  const watcher = humans.find((p) => p !== nominator);
  await watcher.page.waitForFunction(() => document.querySelector('#game-vampir .vnar')?.dataset.cue?.includes('aday gösterildi'));
  assert.ok((await narr(watcher)).cueing, 'aday ipucu görünür');
  await snap(watcher, 'cue-nomination');
  await supporter.page.waitForSelector('button:has-text("Destekliyorum")');
  await supporter.page.click('button:has-text("Destekliyorum")');
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'trial'");
  await nominator.page.waitForFunction(() => /destekledi|Destek geldi/.test(document.querySelector('#game-vampir .vnar')?.dataset.cue ?? ''));
  // ---- Oylama: yaşayan insanlar Evet (2+ insan Evet ≥ yarıdan fazla: bot sanık asılır)
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'trialVote'", 20000);
  await nominator.page.waitForFunction(() => /Oylama başladı/.test(document.querySelector('#game-vampir .vnar')?.dataset.cue ?? ''));
  for (const p of liveHumans) {
    await p.page.waitForSelector('button:has-text("Evet, asılsın")');
    await p.page.click('button:has-text("Evet, asılsın")');
  }
  // ---- Karar anlatımı
  for (const p of humans) await waitNet(p.page, "view && view.phase === 'verdict'", 20000);
  const verdict = (await state(a.page)).view.narration.trial;
  assert.equal(verdict.targetId, accusedId);
  const tally = await sameNarration(humans);
  assert.equal(tally.title, `Oylama: ${verdict.yes}/${verdict.voters} Evet`);
  st = await Promise.all(humans.map(stageState));
  assert.equal(new Set(st).size, 1, 'karar: sahne tarifi herkeste aynı');
  assert.equal(JSON.parse(st[0]).spotlight, accusedId);
  await waitFrac(a, 0.35, 2300); // mancınık uçuşunun ortası
  const after = await sameNarration(humans);
  assert.match(after.title, verdict.hanged ? /fırlatıl|atılıyor/ : /kurtuldu/);
  await snap(a, `verdict-${verdict.hanged ? 'catapult' : 'saved'}`);
  await snap(c, 'verdict-2d');
  console.log(`# vampir-flow: karar ${verdict.yes}/${verdict.voters} asıldı=${verdict.hanged}`);

  // ---- Sonrası: asıldıysa akşam (ya da oyun sonu), asılmadıysa gündüz
  await waitNet(a.page, "view && ['dusk', 'day', 'over'].includes(view.phase)", 15000);
  const next = (await state(a.page)).view;
  if (next.phase === 'dusk') {
    await a.page.waitForSelector('#game-vampir .vnar.active[data-kind="dusk"] .vnar-box');
    assert.match((await sameNarration(humans)).title, /Akşam oldu/);
    await waitFrac(a, 0.6);
    assert.match((await sameNarration(humans)).title, /uykuya dalıyor/);
    await snap(a, 'dusk');
    st = await Promise.all(humans.map(stageState));
    assert.equal(new Set(st).size, 1, 'akşam: sahne tarifi herkeste aynı');
  } else if (next.phase === 'over') {
    await a.page.waitForSelector('#game-vampir .vnar.active[data-kind="over"] .vnar-box');
    await a.page.waitForTimeout(1800);
    assert.match((await narr(a)).title, /kazandı/);
    await snap(a, 'over');
  }
  for (const p of humans) assert.deepEqual(realErrors(p), [], `${p.name} konsol hatası`);
});
