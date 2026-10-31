// Tarayıcı testi: 🧛 Vampir 3D köy meydanı (Aşama 1). 7 telefon (2 vampir) kısa bir oyun oynar:
// tuval yeniden çizimlerde aynı öğe kalır, gece/gündüz durumu değişir, kart kapalıyken sahneye dokunmak seçim
// göndermez, açıkken gönderir; kartlar kapalıyken sahne tarifi (data-state) vampirde ve köylüde birebir aynıdır.
// Başsız tarayıcıda WebGL yoksa sahne sessizce gizlenmeli (yedek yol) — test o zaman onu doğrular.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, startGame, state, waitNet, realErrors } from './qa-vampir-lib.mjs';

const SHOTS = fileURLToPath(new URL('../../test-results/vampir-3d/', import.meta.url));
const EXTRA_SHOTS = process.env.V3D_SHOTS; // isteğe bağlı: ekran görüntülerinin bir kopyası
let env;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  env = await setup({ timeScale: 1 });
});
after(async () => { await env?.close(); });

const stageAttr = (p, name) => p.page.locator('#game-vampir .v3d').getAttribute(name);
const stageState = async (p) => JSON.parse(await stageAttr(p, 'data-state'));
async function stageShot(p, label) {
  const loc = p.page.locator('#game-vampir .v3d');
  await loc.screenshot({ path: `${SHOTS}${label}.png` });
  if (EXTRA_SHOTS) await loc.screenshot({ path: `${EXTRA_SHOTS}/${label}.png` });
}
// Karakterin ekran konumuna gerçek tıklama (tuval üzerinden ışın).
async function tapChar(p, id) {
  await p.page.locator('#game-vampir .v3d').scrollIntoViewIfNeeded();
  await p.page.waitForTimeout(150);
  const pt = await p.page.evaluate((pid) => {
    const st = document.querySelector('#game-vampir .v3d');
    const c = st.v3dProject(pid);
    // Öndeki karakter örtüyorsa biraz yukarı (şapka/kafa) kay
    for (let dy = 0; c && dy < 60; dy += 6) if (st.v3dHitAt(c.x, c.y - dy) === pid) return { x: c.x, y: c.y - dy };
    return { miss: c, hit: c && st.v3dHitAt(c.x, c.y) };
  }, id);
  assert.ok(pt && pt.x != null, `${p.name}: karaktere dokunulacak nokta yok ${JSON.stringify(pt)}`);
  await p.page.mouse.click(pt.x, pt.y);
}
const openCard = (p) => p.page.click('#game-vampir .role-card.hidden-card');
const closeCard = (p) => p.page.click('#game-vampir .role-card:not(.hidden-card)');
const tagCanvas = (p) => p.page.evaluate(() => { document.querySelector('#game-vampir .v3d canvas').__v3dTag = 'same'; });
const canvasTag = (p) => p.page.evaluate(() => document.querySelector('#game-vampir .v3d canvas')?.__v3dTag ?? null);

test('3D köy: tek tuval, gece/gündüz, dokunarak seçim kapısı, kart kapalıyken sızıntı yok', async () => {
  const names = ['Ali', 'Ayşe', 'Mert', 'Zeynep', 'Can', 'Ece', 'Bora'];
  const { phones, host } = await startGame(env, names, {
    settings: { 'Vampir sayısı': 2, Deli: false, 'Gece süresi': 120, 'Gündüz tartışması': 2, 'Savunma süresi': 60 },
  });
  const ids = Object.fromEntries(phones.map((p) => [p.name, p.id]));
  const vamps = phones.filter((p) => p.role === 'vampir');
  const town = phones.filter((p) => p.role !== 'vampir');
  assert.equal(vamps.length, 2);

  // Sahne herkeste hazır olsun (WebGL veya yedek yol)
  for (const p of phones) await p.page.waitForSelector('#game-vampir .v3d[data-ready="webgl"], #game-vampir .v3d[data-ready="fallback"]', { timeout: 20000 });
  const mode = await stageAttr(host, 'data-ready');
  console.log(`# vampir-3d: sahne kipi = ${mode}`);
  for (const p of phones) assert.equal(await stageAttr(p, 'data-ready'), mode, `${p.name}: farklı kip`);

  if (mode === 'fallback') {
    // WebGL yok: blok gizli, oyun 2D olarak sürer, sahne tarifi yine üretilir.
    assert.equal(await host.page.locator('#game-vampir .v3d').isVisible(), false);
    assert.equal(await host.page.locator('#game-vampir .target').count() > 0, true);
  }
  const webgl = mode === 'webgl';
  if (webgl) for (const p of phones) await tagCanvas(p);
  for (const p of phones) assert.equal(await stageAttr(p, 'data-sky'), 'night');

  const [va, vb] = vamps;
  const villager = town.find((p) => p.role === 'koylu') ?? town[0];
  const victim = town.find((p) => p !== villager);

  // 1) Kart kapalıyken karaktere dokunmak seçim göndermez, sadece uyarı verir.
  if (webgl) {
    await tapChar(villager, victim.id);
    await villager.page.waitForSelector('#toast.show');
    assert.match(await villager.page.locator('#toast').textContent(), /Seçim yapmak için kartını aç/);
    await villager.page.waitForTimeout(400);
    const s = await state(villager.page);
    assert.equal(s.view.me.nightPick, null, 'kart kapalıyken dokunuş seçim göndermemeli');
    assert.equal(s.view.nightProgress.done, 0);
  }

  // 2) Kart açıkken dokunuş seçim gönderir; halka sadece kart açıkken görünür.
  await openCard(va);
  if (webgl) await tapChar(va, victim.id);
  else await va.page.locator('#game-vampir .target', { hasText: victim.name }).first().click();
  await waitNet(va.page, `view.me.nightPick === ${JSON.stringify(victim.id)}`);
  await va.page.waitForTimeout(150);
  let sa = await stageState(va);
  assert.equal(sa.chars.find((c) => c.id === victim.id).ring, true, 'seçilen hedefte halka olmalı (kart açık)');
  if (webgl) await stageShot(va, 'night-card-open-vampire');
  // Diğer vampir kartını açınca müttefik işaretini görür.
  await openCard(vb);
  await vb.page.waitForTimeout(200);
  const sb = await stageState(vb);
  assert.equal(sb.chars.find((c) => c.id === victim.id).allies, 1, 'müttefik seçimi kart açıkken işaretli');
  await closeCard(va);
  await closeCard(vb);
  await va.page.waitForTimeout(200);
  sa = await stageState(va);
  assert.ok(sa.chars.every((c) => !c.ring && !c.allies), 'kart kapanınca halka/işaret kalkmalı');

  // 3) Sızıntı: kartlar kapalıyken herkesin sahne tarifi aynı (vampir = köylü).
  const night = await Promise.all(phones.map((p) => stageAttr(p, 'data-state')));
  assert.equal(new Set(night).size, 1, 'gece, kartlar kapalı: sahne tarifi herkeste aynı olmalı');
  if (webgl) {
    await host.page.waitForTimeout(500);
    await stageShot(host, 'night');
  }

  // Herkes seçsin → sabah. Köylüler kurban dışında birini seçer (düğmeyle).
  await openCard(vb);
  await vb.page.locator('#game-vampir .target', { hasText: victim.name }).first().click();
  for (const p of town) {
    await openCard(p);
    const s = await state(p.page);
    const target = s.view.me.nightTargets.find((id) => id !== victim.id && id !== p.id);
    const name = s.view.players.find((x) => x.id === target).name;
    await p.page.locator('#game-vampir .target', { hasText: new RegExp(`^${name}`) }).first().click();
  }
  for (const p of phones) await waitNet(p.page, "view && view.phase === 'day'");
  for (const p of phones) {
    await p.page.waitForFunction(() => document.querySelector('#game-vampir .v3d')?.dataset.sky === 'day');
    if (webgl) assert.equal(await canvasTag(p), 'same', `${p.name}: tuval yeniden çizimde aynı öğe kalmalı`);
  }
  const day = await Promise.all(phones.map((p) => stageAttr(p, 'data-state')));
  assert.equal(new Set(day).size, 1, 'gündüz: sahne tarifi herkeste aynı');
  const dayState = JSON.parse(day[0]);
  assert.equal(dayState.chars.find((c) => c.id === victim.id).alive, false);
  assert.ok(dayState.chars.every((c) => !c.sleeping));
  if (webgl) {
    await host.page.waitForTimeout(3200); // gün doğumu geçişi
    await stageShot(host, 'day');
    // Gündüz dokunuş: eylem yok, sadece satıra kaydırır.
    const before = (await state(villager.page)).view;
    await tapChar(villager, va.id);
    await villager.page.waitForSelector(`#game-vampir .player-list li.flash`);
    const after2 = (await state(villager.page)).view;
    assert.equal(after2.nomination, before.nomination);
  }

  // 4) Aday → ❗; yargılama → spot ışığı + herkes sanığa döner.
  const alive = phones.filter((p) => p !== victim);
  const accused = va;
  const [nominator, supporter] = alive.filter((p) => p !== accused);
  await nominator.page.locator('#game-vampir .player-list li', { hasText: accused.name }).locator('button:has-text("Aday göster")').click();
  await host.page.waitForFunction((id) => JSON.parse(document.querySelector('#game-vampir .v3d').dataset.state)
    .chars.find((c) => c.id === id)?.nominee, accused.id);
  await supporter.page.waitForSelector('button:has-text("Destekliyorum")');
  await supporter.page.click('button:has-text("Destekliyorum")');
  for (const p of phones) await waitNet(p.page, "view && view.phase === 'trial'");
  await host.page.waitForTimeout(200);
  const trial = await stageState(host);
  assert.equal(trial.spotlight, accused.id);
  assert.ok(trial.chars.filter((c) => c.alive && c.id !== accused.id).every((c) => c.look === 'accused'));
  if (webgl) {
    await host.page.waitForTimeout(1200);
    await stageShot(host, 'trial');
  }
  await accused.page.click('button:has-text("Savunmam bitti")');
  for (const p of alive.filter((x) => x !== accused)) {
    await p.page.waitForSelector('button:has-text("Hayır")');
    await p.page.click('button:has-text("Hayır")');
  }
  await waitNet(host.page, "view && view.phase === 'day'");

  // 5) Gece 2: gökyüzü yine gece, tuval hâlâ aynı.
  await host.page.click('button:has-text("Geceye geç")');
  for (const p of phones) {
    await p.page.waitForFunction(() => document.querySelector('#game-vampir .v3d')?.dataset.sky === 'night');
    if (webgl) assert.equal(await canvasTag(p), 'same');
  }
  const night2 = await Promise.all(phones.map((p) => stageAttr(p, 'data-state')));
  assert.equal(new Set(night2).size, 1, 'gece 2: sahne tarifi herkeste aynı');

  // 6) 3D kapat düğmesi: WebGL tamamen kalkar, tercih saklanır.
  if (webgl) {
    await host.page.click('#game-vampir .v3d-toggle');
    await host.page.waitForFunction(() => !document.querySelector('#game-vampir .v3d canvas'));
    assert.equal(await host.page.evaluate(() => localStorage.getItem('tss:vampir-3d')), '0');
    await host.page.click('#game-vampir .v3d-toggle');
    await host.page.waitForSelector('#game-vampir .v3d[data-ready="webgl"] canvas');
  }

  for (const p of phones) assert.deepEqual(realErrors(p), [], `${p.name} konsol hatası`);
});
