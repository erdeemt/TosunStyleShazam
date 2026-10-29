// QA (oyuncu gözüyle): ⚽ Tosun Top — 2 yatay telefon + 1 dikey telefon + 1 masaüstü (+ maç ortası izleyici).
// Takım seçimi / karıştırma / başlama şartı, joystick hissi (ölü bölge, çapraz, takip, bırakınca durma), çoklu dokunuş,
// şut menzili, klavye, gol + duraklama + başlama vuruşu kısıtı, saat, gol limiti, sonuç ekranı, rövanş, sekme gizleme,
// yerleşim (sığma, ŞUT–kale çakışması). Ekran görüntüleri: test-results/qa-haxball/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/qa-haxball/', import.meta.url));
const NOTES = [];
const note = (s) => { NOTES.push(s); console.log(`# ${s}`); };
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.2 });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => {
  writeFileSync(`${SHOTS}play-notes.txt`, NOTES.join('\n'));
  await browser?.close();
  await srv?.stop();
});

// Sayfaya ölçüm kancası: tuvale çizilen top (r 10) ve kendi diskinin halesi (r 21) her çizimde kaydedilir.
function instrument() {
  const q = { ball: [], me: [] };
  window.__qa = q;
  const arc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function patched(x, y, r, ...rest) {
    const t = performance.now();
    if (r === 10) { q.ball.push([t, x, y]); if (q.ball.length > 6000) q.ball.splice(0, 3000); }
    else if (r === 21) { q.me.push([t, x, y]); if (q.me.length > 6000) q.me.splice(0, 3000); }
    return arc.call(this, x, y, r, ...rest);
  };
}

const KINDS = {
  land: { viewport: { width: 800, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  port: { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  desk: { viewport: { width: 1280, height: 800 } },
};

async function open(name, kind) {
  const ctx = await browser.newContext(KINDS[kind]);
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${srv.url}/#/multi/haxball`);
  await page.fill('input[placeholder="Takma adın"]', name);
  const cdp = kind === 'desk' ? null : await ctx.newCDPSession(page);
  const p = { page, errors, name, cdp, kind, ctx };
  return p;
}

async function hookSent(p) {
  await p.page.evaluate(async () => {
    const { net } = await import('/net.js');
    if (window.__sent) return;
    window.__sent = [];
    const orig = net.sendFast.bind(net);
    net.sendFast = (m) => { if (m.t === 'input') window.__sent.push({ at: performance.now(), x: m.x, y: m.y, k: m.k }); return orig(m); };
  });
}
const lastSent = (p) => p.page.evaluate(() => window.__sent.at(-1));

const state = (p) => p.page.evaluate(async () => {
  const { net } = await import('/net.js');
  return { view: net.view, room: net.room, me: net.playerId, frame: net.frame };
});
async function until(p, pred, timeout = 15000, label = 'koşul') {
  const t0 = Date.now();
  for (;;) {
    const s = await state(p);
    if (pred(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`${p.name}: ${label} sağlanmadı`);
    await p.page.waitForTimeout(60);
  }
}
const discOf = (s, id) => {
  const i = s.view.discs.findIndex((d) => d.id === id);
  if (i < 0 || s.frame?.v !== s.view.ver) return null;
  return { x: s.frame.p[2 * i] / 10, y: s.frame.p[2 * i + 1] / 10, i, kick: (s.frame.f >> i) & 1 };
};
const myPos = (s) => discOf(s, s.me);
const shot = (p, name, fullPage = false) => p.page.screenshot({ path: `${SHOTS}${name}.png`, fullPage });
const touch = (p, type, points) => p.cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })),
});
const debugPlace = (p, a) => p.page.evaluate(async (act) => {
  const { net } = await import('/net.js');
  net.action({ type: 'debugPlace', ...act });
}, a);
async function noHScroll(p, label) {
  const m = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, sh: document.documentElement.scrollHeight, h: innerHeight }));
  assert.ok(m.sw <= m.w, `${p.name} ${label}: yatay kaydırma (${m.sw} > ${m.w})`);
  return m;
}
const toastText = (p) => p.page.evaluate(() => document.getElementById('toast')?.textContent ?? '');

let A; let B; let C; let D; let E; let code;

test('bekleme odası: takım seçimi, izleyici, başlama şartı, karıştırma', async () => {
  A = await open('Ali', 'land');
  B = await open('Ayşe', 'land');
  C = await open('Mert', 'port');
  D = await open('Can', 'desk');
  await A.page.click('text=Yeni oda kur');
  code = (await A.page.locator('#game-haxball .lobby-code').textContent()).trim();
  for (const p of [B, C, D]) {
    await p.page.fill('#game-haxball .code-input', code);
    await p.page.click('#game-haxball button:has-text("Katıl")');
  }
  await A.page.waitForFunction(() => document.querySelectorAll('#game-haxball .player-list li').length === 4);
  // Herkes Kırmızı → başlatma reddedilmeli
  for (const p of [A, B, C, D]) await p.page.click('#game-haxball .hx-pick.red');
  await until(A, (s) => Object.values(s.room.prep.teams).filter((t) => t === 'red').length === 4);
  await A.page.click('#game-haxball button:has-text("Oyunu başlat")');
  await A.page.waitForTimeout(400);
  const t1 = await toastText(A);
  note(`hepsi kırmızıyken başlat → toast: "${t1}"`);
  assert.match(t1, /İki takımda da en az bir oyuncu/);
  assert.equal((await state(A)).room.phase, 'lobby');
  // Seçili düğme vurgusu
  assert.equal(await B.page.getAttribute('#game-haxball .hx-pick.red', 'aria-pressed'), 'true');
  // Can izleyici; host karıştır → izleyici izleyici kalmalı, 3 saha oyuncusu 2–1 bölünmeli
  await D.page.click('#game-haxball .hx-pick.spec');
  await until(A, (s) => s.room.prep.teams[s.room.players.find((x) => x.name === 'Can').id] === 'spec');
  assert.equal(await B.page.locator('#game-haxball button:has-text("Takımları karıştır")').count(), 0, 'host olmayan karıştır düğmesini görmemeli');
  await A.page.click('#game-haxball button:has-text("Takımları karıştır")');
  const sh = await until(A, (s) => {
    const v = Object.values(s.room.prep.teams);
    return v.filter((t) => t === 'red').length + v.filter((t) => t === 'blue').length === 3 && v.includes('blue') && v.includes('red');
  });
  const canId = sh.room.players.find((x) => x.name === 'Can').id;
  assert.equal(sh.room.prep.teams[canId], 'spec', 'karıştırınca izleyici izleyici kalmalı');
  await shot(A, '10-lobby-after-shuffle-land', true);
  // Sadece izleyici + tek takım: Can izleyici, diğerleri seçimsiz → dengelenir, başlayabilir (kontrol: canStart)
  // Asıl maç için takımlar: Ali+Mert kırmızı, Ayşe+Can mavi
  await A.page.click('#game-haxball .hx-pick.red');
  await C.page.click('#game-haxball .hx-pick.red');
  await B.page.click('#game-haxball .hx-pick.blue');
  await D.page.click('#game-haxball .hx-pick.blue');
  await until(A, (s) => Object.values(s.room.prep.teams).filter((t) => t === 'blue').length === 2 && Object.values(s.room.prep.teams).filter((t) => t === 'red').length === 2);
  await A.page.selectOption('#game-haxball select >> nth=0', '5');
  await A.page.selectOption('#game-haxball select >> nth=1', '3');
  await until(A, (s) => s.room.settings.minutes === 5 && s.room.settings.goals === 3);
  await C.page.waitForSelector('#game-haxball .hx-team.blue li:has-text("Can")');
  await shot(C, '11-lobby-portrait', true);
  await shot(D, '12-lobby-desktop', true);
  for (const p of [A, B, C, D]) await noHScroll(p, 'lobi');
  const lobbyText = await C.page.locator('#game-haxball').textContent();
  for (const w of ['Kırmızı', 'Mavi', 'İzle', 'Takımlar', 'Süre', 'Gol limiti', 'Saha']) assert.ok(lobbyText.includes(w), `lobi metni: ${w}`);
});

test('maç: yerleşim, joystick hissi, çoklu dokunuş, şut menzili, klavye', async () => {
  for (const p of [A, B, C, D]) await hookSent(p);
  await A.page.click('#game-haxball button:has-text("Oyunu başlat")');
  for (const p of [A, B, C, D]) {
    await p.page.waitForSelector('#game-haxball .hx-stage.live');
    await until(p, (s) => s.frame && s.view && myPos(s), 8000, 'ilk kare');
  }
  await A.page.waitForTimeout(500);
  await shot(A, '20-kickoff-land');
  await shot(C, '21-kickoff-portrait');
  await shot(D, '22-kickoff-desktop');

  // ---- Yerleşim: saha sığıyor mu, ŞUT kaleyi ne kadar örtüyor ----
  for (const p of [A, B, C, D]) {
    const m = await noHScroll(p, 'saha');
    assert.ok(m.sh <= m.h + 1, `${p.name}: dikey kaydırma (${m.sh} > ${m.h})`);
  }
  for (const p of [A, C]) {
    const geo = await p.page.evaluate(() => {
      const c = document.querySelector('#game-haxball canvas').getBoundingClientRect();
      const k = document.querySelector('#game-haxball .hx-kick').getBoundingClientRect();
      const hud = document.querySelector('#game-haxball .hx-hud').getBoundingClientRect();
      return { c: { x: c.x, y: c.y, w: c.width, h: c.height }, k: { x: k.x, y: k.y, w: k.width, h: k.height }, hud: hud.height };
    });
    const P = { w: 370, h: 170, goal: 64, depth: 30, outerW: 420, outerH: 200 };
    const s = geo.c.w / (2 * P.outerW);
    const cx = geo.c.x + geo.c.w / 2;
    const cy = geo.c.y + geo.c.h / 2;
    // Sağ kale (ağ + ağız) ve sahanın sağ alt çeyreği (top oyun alanı) CSS piksel olarak
    const goal = { x: cx + P.w * s, y: cy - P.goal * s, w: P.depth * s, h: 2 * P.goal * s };
    const kcx = geo.k.x + geo.k.w / 2;
    const kcy = geo.k.y + geo.k.h / 2;
    const kr = geo.k.w / 2;
    // Çakışma: daire–dikdörtgen kesişim alanını ızgarayla say
    let inGoal = 0; let goalCells = 0; let inPitch = 0; let pitchCells = 0;
    for (let x = cx - P.w * s; x < cx + (P.w + P.depth) * s; x += 1) {
      for (let y = cy - P.h * s; y < cy + P.h * s; y += 1) {
        const covered = (x - kcx) ** 2 + (y - kcy) ** 2 <= kr * kr;
        const isGoal = x >= goal.x && x <= goal.x + goal.w && y >= goal.y && y <= goal.y + goal.h;
        const isPitch = x <= cx + P.w * s;
        if (isGoal) { goalCells++; if (covered) inGoal++; }
        if (isPitch) { pitchCells++; if (covered) inPitch++; }
      }
    }
    const mouthCovered = []; // kale ağzının (x = cx + w·s) hangi y aralığı ŞUT altında
    for (let y = goal.y; y <= goal.y + goal.h; y++) if ((goal.x - kcx) ** 2 + (y - kcy) ** 2 <= kr * kr) mouthCovered.push(y);
    note(`${p.name} ${p.kind}: tuval ${Math.round(geo.c.w)}×${Math.round(geo.c.h)} @(${Math.round(geo.c.x)},${Math.round(geo.c.y)}), HUD ${Math.round(geo.hud)} px, ölçek ${s.toFixed(3)} px/birim; `
      + `ŞUT ${Math.round(geo.k.w)} px; kale alanının %${Math.round((100 * inGoal) / goalCells)}'i, top sahasının %${(100 * inPitch / pitchCells).toFixed(1)}'i ŞUT altında; `
      + `kale ağzının ${mouthCovered.length}/${Math.round(goal.h)} px'i örtülü`);
  }
  assert.ok(await C.page.locator('.hx-rotate').isVisible(), 'dikeyde "yan çevir"');
  assert.match(await C.page.locator('.hx-rotate').textContent(), /Telefonu yan çevir/);
  assert.ok(!(await A.page.locator('.hx-rotate').isVisible()));
  assert.ok(await D.page.locator('.hx-keys').isVisible(), 'masaüstü klavye ipucu');
  assert.ok(!(await D.page.locator('.hx-rotate').isVisible()), 'masaüstünde yan çevir yok');

  // ---- Kickoff kuralı (maç başı Kırmızı vurur): Mavi Ayşe sola (merkeze) koşar → yarısında + yuvarlak dışında kalmalı ----
  const ayse = (await state(B)).me;
  await touch(B, 'touchStart', [[200, 220, 1]]);
  await touch(B, 'touchMove', [[140, 220, 1]]); // sola tam
  await B.page.waitForTimeout(2500);
  const kb = await state(B);
  const bp = discOf(kb, ayse);
  await touch(B, 'touchEnd', []);
  note(`başlama vuruşu (Kırmızı): Mavi Ayşe 2.5 sn sola koştu → (${bp.x.toFixed(1)}, ${bp.y.toFixed(1)}), merkeze ${Math.hypot(bp.x, bp.y).toFixed(1)} (sınır ≥ 85, x ≥ 15)`);
  assert.equal(kb.view.phase, 'kickoff');
  assert.ok(bp.x >= 14.9 && Math.hypot(bp.x, bp.y) >= 84.9, 'vurmayan takım orta yuvarlağa/rakip yarıya giremez');
  // Kırmızı Mert yuvarlak dışından sağa koşar → x ≤ -15'te durmalı (yuvarlak dışında rakip yarıya geçemez)
  const mertS0 = await state(C);
  const mert0 = myPos(mertS0);
  await touch(C, 'touchStart', [[100, 500, 1]]);
  await touch(C, 'touchMove', [[100, 500 + (mert0.y < 0 ? -60 : 60), 1]]); // önce kenara doğru (yuvarlak dışına)
  await C.page.waitForTimeout(700);
  await touch(C, 'touchMove', [[170, 500, 1]]);
  await C.page.waitForTimeout(2500);
  const mert1 = myPos(await state(C));
  await touch(C, 'touchEnd', []);
  note(`başlama vuruşu: Kırmızı Mert sağa koştu → (${mert1.x.toFixed(1)}, ${mert1.y.toFixed(1)})`);
  assert.ok(mert1.x <= -14.9 || Math.hypot(mert1.x, mert1.y) <= 55.1, 'vuran takım yuvarlak dışında rakip yarıya geçemez');

  // ---- Joystick hissi (Ali, yatay) ----
  const joyCenter = () => A.page.evaluate(() => {
    const j = document.querySelector('#game-haxball .hx-joy');
    if (j.classList.contains('hidden')) return null;
    const r = j.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await touch(A, 'touchStart', [[150, 250, 1]]);
  await A.page.waitForTimeout(60);
  const jc = await joyCenter();
  assert.ok(jc && Math.abs(jc[0] - 150) < 2 && Math.abs(jc[1] - 250) < 2, `joystick parmağın altında (${jc})`);
  await touch(A, 'touchMove', [[155, 250, 1]]);
  await A.page.waitForTimeout(80);
  const dz = await lastSent(A);
  assert.deepEqual([dz.x, dz.y], [0, 0], '5 px ölü bölgede');
  await touch(A, 'touchMove', [[176, 250, 1]]);
  await A.page.waitForTimeout(80);
  const half = await lastSent(A);
  assert.ok(Math.abs(half.x - 0.5) < 0.02 && half.y === 0, `26 px → x 0.5 (${half.x})`);
  await touch(A, 'touchMove', [[190, 290, 1]]);
  await A.page.waitForTimeout(80);
  const diag = await lastSent(A);
  assert.ok(Math.abs(diag.x - 0.71) < 0.02 && Math.abs(diag.y - 0.71) < 0.02, `çapraz (${diag.x}, ${diag.y})`);
  await touch(A, 'touchMove', [[350, 250, 1]]);
  await A.page.waitForTimeout(80);
  const far = await lastSent(A);
  const jc2 = await joyCenter();
  note(`joystick: ölü bölge 5px→0, 26px→${half.x}, çapraz→(${diag.x},${diag.y}), 200px→x ${far.x}; taban peşinden geldi: ${Math.round(jc2[0])},${Math.round(jc2[1])}`);
  assert.equal(far.x, 1);
  assert.ok(jc2[0] > 200, 'uzaklaşınca joystick tabanı peşinden gelmeli');
  // Taban takip ettikten sonra yön değiştirme: parmak 40 px geri → sola dönmeli
  await touch(A, 'touchMove', [[jc2[0] - 30, 250, 1]]);
  await A.page.waitForTimeout(80);
  const back = await lastSent(A);
  note(`takipten sonra 30 px geri: x ${back.x}`);
  assert.ok(back.x < 0, 'takipten sonra ters yöne dönüş hemen olmalı');
  await touch(A, 'touchMove', [[jc2[0] + 60, 250, 1]]);
  await A.page.waitForTimeout(1200);
  // Bırakınca: 0 gider, joystick gizlenir, disk ~1 sn'de durur
  await touch(A, 'touchEnd', []);
  await A.page.waitForTimeout(80);
  const rel = await lastSent(A);
  assert.deepEqual([rel.x, rel.y, rel.k], [0, 0, 0]);
  assert.equal(await joyCenter(), null, 'bırakınca joystick gizlenmeli');
  const s1 = myPos(await state(A));
  await A.page.waitForTimeout(400);
  const s2 = myPos(await state(A));
  await A.page.waitForTimeout(1000);
  const s3 = myPos(await state(A));
  note(`bırakınca kayma: ilk 400 ms ${(s2.x - s1.x).toFixed(1)} birim, sonraki 1 sn ${(s3.x - s2.x).toFixed(1)} birim`);
  assert.ok(Math.abs(s3.x - s2.x) < 25, 'bırakınca kısa sürede durmalı (HaxBall sürtünmesi 0.96: ~58 birim kayar)');

  // ---- Çoklu dokunuş: joystick + ŞUT; ŞUT basılıyken yön değiştirme; joystick'i bırakıp ŞUT'u tutmak ----
  const kbx = await A.page.locator('#game-haxball .hx-kick').boundingBox();
  const K = [kbx.x + kbx.width / 2, kbx.y + kbx.height / 2, 2];
  // Not: Chrome CDP'de touchEnd'e verilen noktalar BIRAKILAN parmaklardır (kalanlar basılı kalır).
  // (a) Joystick basılı + ŞUT eklenir + ŞUT bırakılır (joystick sürer)
  await touch(A, 'touchStart', [[150, 200, 1]]);
  await touch(A, 'touchMove', [[150, 150, 1]]); // yukarı
  await touch(A, 'touchStart', [[150, 150, 1], K]);
  await A.page.waitForTimeout(150);
  let ls = await lastSent(A);
  assert.ok(ls.k === 1 && ls.y < -0.9, `joystick yukarı + ŞUT (${JSON.stringify(ls)})`);
  await touch(A, 'touchEnd', [K]);
  await A.page.waitForTimeout(150);
  ls = await lastSent(A);
  assert.ok(ls.k === 0 && ls.y < -0.9, `ŞUT bırakıldı, joystick sürüyor (${JSON.stringify(ls)})`);
  await touch(A, 'touchEnd', []);
  // (b) ŞUT önce basılı, sonra joystick; ŞUT basılıyken yön değiştir; joystick bırakılır, ŞUT basılı kalır
  await touch(A, 'touchStart', [K]);
  await touch(A, 'touchStart', [K, [150, 200, 1]]);
  await touch(A, 'touchMove', [K, [150, 150, 1]]);
  await A.page.waitForTimeout(150);
  ls = await lastSent(A);
  assert.ok(ls.k === 1 && ls.y < -0.9, `ŞUT + joystick yukarı (${JSON.stringify(ls)})`);
  await touch(A, 'touchMove', [K, [200, 200, 1]]); // ŞUT basılıyken sağa çevir
  await A.page.waitForTimeout(150);
  ls = await lastSent(A);
  assert.ok(ls.k === 1 && ls.x > 0.9, `ŞUT basılıyken yön değişti (${JSON.stringify(ls)})`);
  await shot(A, '23-joystick-and-kick');
  await touch(A, 'touchEnd', [[200, 200, 1]]); // joystick parmağı kalktı, ŞUT hâlâ basılı
  await A.page.waitForTimeout(150);
  ls = await lastSent(A);
  assert.ok(ls.k === 1 && ls.x === 0 && ls.y === 0, `joystick bırakıldı, ŞUT basılı (${JSON.stringify(ls)})`);
  const fk = await until(A, (s) => myPos(s)?.kick === 1, 2000, 'f biti');
  assert.equal(myPos(fk).kick, 1);
  await touch(A, 'touchEnd', []);
  await A.page.waitForTimeout(150);
  ls = await lastSent(A);
  assert.equal(ls.k, 0);
  // Sağ %40'ta düğme dışı bir yere dokunmak da şut
  await touch(A, 'touchStart', [[560, 120, 3]]);
  await A.page.waitForTimeout(120);
  const side = await lastSent(A);
  await touch(A, 'touchEnd', []);
  assert.equal(side.k, 1, 'sağ %40 = şut');
  // İki parmak solda: ikincisi yok sayılır (joystick ilk parmakta)
  await touch(A, 'touchStart', [[150, 200, 4]]);
  await touch(A, 'touchStart', [[150, 200, 4], [300, 200, 5]]);
  await touch(A, 'touchMove', [[150, 200, 4], [380, 200, 5]]);
  await A.page.waitForTimeout(100);
  const two = await lastSent(A);
  await touch(A, 'touchEnd', []);
  note(`sol tarafta ikinci parmak: girdi ${JSON.stringify({ x: two.x, y: two.y, k: two.k })}`);

  // ---- Şut menzili (Can, masaüstü klavye, Mavi → sola atar) ----
  const canId = (await state(D)).me;
  for (const [gap, expectKick] of [[3, true], [6, false]]) {
    await debugPlace(D, { ball: { x: -100, y: 0 }, me: { x: -100 + 25 + gap, y: 0 } });
    await D.page.waitForTimeout(300);
    const b0 = (await state(D)).frame.b[0] / 10;
    await D.page.keyboard.down('Space');
    await D.page.waitForTimeout(80);
    await D.page.keyboard.up('Space');
    await D.page.waitForTimeout(400);
    const b1 = (await state(D)).frame.b[0] / 10;
    note(`şut menzili: boşluk ${gap} birim → top ${(b1 - b0).toFixed(1)} birim kaydı`);
    if (expectKick) assert.ok(b1 - b0 < -40, `boşluk ${gap}: şut olmalı`);
    else assert.ok(Math.abs(b1 - b0) < 5, `boşluk ${gap}: şut olmamalı`);
  }
  // Şut basılı tutup topa koşmak: değince vurur (HaxBall). X tuşuyla.
  await debugPlace(D, { ball: { x: -100, y: 0 }, me: { x: -20, y: 0 } });
  await D.page.waitForTimeout(250);
  await D.page.keyboard.down('KeyX');
  await D.page.keyboard.down('ArrowLeft');
  const t0 = Date.now();
  await until(D, (s) => s.frame.b[0] / 10 < -130, 4000, 'X ile koşarak şut');
  await D.page.keyboard.up('ArrowLeft');
  await D.page.keyboard.up('KeyX');
  note(`X basılı + ok sol: ${Date.now() - t0} ms içinde top vuruldu`);
  // WASD çapraz: W+D → (0.71, -0.71)
  await D.page.keyboard.down('KeyW');
  await D.page.keyboard.down('KeyD');
  await D.page.waitForTimeout(120);
  const wd = await lastSent(D);
  await D.page.keyboard.up('KeyW');
  await D.page.keyboard.up('KeyD');
  assert.ok(Math.abs(wd.x - 0.71) < 0.02 && Math.abs(wd.y + 0.71) < 0.02, `W+D çapraz (${wd.x}, ${wd.y})`);
  await D.page.waitForTimeout(150);
  assert.deepEqual([(await lastSent(D)).x, (await lastSent(D)).y], [0, 0]);
  void canId;
});

test('gol, duraklama, başlama vuruşu sıfırlama, izleyici, sekme gizleme, gol limiti, sonuç, rövanş', async () => {
  const pre = await state(B);
  const c0 = pre.frame.c;
  await debugPlace(A, { ball: { x: 300, y: 0 }, me: { x: 274, y: 0 } });
  await A.page.waitForTimeout(200);
  await A.page.keyboard.down('Space'); // telefon sayfasında da klavye olayı çalışır; burada dokunuş yerine kısa yol
  await A.page.waitForTimeout(100);
  await A.page.keyboard.up('Space');
  const g = await until(B, (s) => s.view.phase === 'goal', 4000, 'gol');
  assert.deepEqual(g.view.score, [1, 0]);
  assert.equal(g.view.lastGoal.name, 'Ali');
  await B.page.waitForSelector('#game-haxball .hx-banner.goal:has-text("GOL")');
  await shot(B, '30-goal-land');
  await shot(C, '31-goal-portrait');
  const cA = (await state(B)).frame.c;
  await B.page.waitForTimeout(1500);
  const cB = (await state(B)).frame.c;
  note(`gol duraklaması: saat ${cA} → 1.5 sn sonra ${cB} (durmalı); maç başı saat ${c0}`);
  assert.equal(cA, cB, 'gol sevincinde saat durmalı');
  const k = await until(B, (s) => s.view.phase === 'kickoff', 3000, 'başlama vuruşu');
  assert.equal(k.view.kickoffTeam, 'blue');
  assert.deepEqual(k.frame.b, [0, 0]);
  const bannerB = await B.page.locator('#game-haxball .hx-banner').textContent();
  const bannerA = await A.page.locator('#game-haxball .hx-banner').textContent();
  note(`başlama bandı: Mavi "${bannerB}" / Kırmızı "${bannerA}"`);
  assert.match(bannerB, /Mavi — sende!/);
  // Yeniden diziliş: Ali kendi yarısında diziliş yerinde
  const ali = myPos(await state(A));
  assert.ok(ali.x < -100, `Ali diziliş yerinde (${ali.x})`);
  // Şimdi Kırmızı vurmayan takım: Ali sağa koşar → yuvarlak dışında kalmalı
  await touch(A, 'touchStart', [[150, 200, 1]]);
  await touch(A, 'touchMove', [[220, 200 - (ali.y < 0 ? -20 : 20), 1]]);
  await A.page.waitForTimeout(2500);
  const ali2 = myPos(await state(A));
  await touch(A, 'touchEnd', []);
  note(`gol sonrası başlama (Mavi): Kırmızı Ali sağa koştu → (${ali2.x.toFixed(1)}, ${ali2.y.toFixed(1)}) merkeze ${Math.hypot(ali2.x, ali2.y).toFixed(1)}`);
  assert.ok(ali2.x <= -14.9 && Math.hypot(ali2.x, ali2.y) >= 84.9);

  // ---- Maç ortası izleyici (yatay telefon) ----
  E = await open('Elif', 'land');
  await E.page.fill('#game-haxball .code-input', code);
  await E.page.click('#game-haxball button:has-text("Katıl")');
  await E.page.waitForSelector('#game-haxball .hx-stage.live', { timeout: 8000 });
  await E.page.waitForTimeout(600);
  const es = await state(E);
  assert.equal(es.view.myTeam, null);
  assert.match(await E.page.locator('#game-haxball .hx-status').textContent(), /İzliyorsun/);
  assert.ok(!(await E.page.locator('#game-haxball .hx-touch').isVisible()), 'izleyicide joystick/ŞUT yok');
  const eDraws = await E.page.evaluate(() => window.__qa.ball.length);
  assert.ok(eDraws > 10, 'izleyici sahayı çiziyor');
  await shot(E, '32-spectator-midmatch');
  const roomE = es.room.players.find((p) => p.name === 'Elif');
  note(`maç ortası izleyici: room.spectator=${roomE.spectator}, status "${await E.page.locator('#game-haxball .hx-status').textContent()}"`);

  // ---- Sekme gizleme (Mert): 0 girdi, çizim durur; görünür olunca devam ----
  await hookSent(C);
  await touch(C, 'touchStart', [[100, 500, 1]]);
  await touch(C, 'touchMove', [[100, 440, 1]]);
  await C.page.waitForTimeout(300);
  await C.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await C.page.waitForTimeout(100);
  const hid = await lastSent(C);
  const d0 = await C.page.evaluate(() => window.__qa.ball.length);
  await C.page.waitForTimeout(500);
  const d1 = await C.page.evaluate(() => window.__qa.ball.length);
  assert.deepEqual([hid.x, hid.y, hid.k], [0, 0, 0], 'gizlenince sıfır girdi');
  assert.equal(d1, d0, 'gizliyken çizim durmalı');
  await touch(C, 'touchEnd', []);
  await C.page.evaluate(() => {
    delete document.hidden; delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await C.page.waitForTimeout(400);
  const d2 = await C.page.evaluate(() => window.__qa.ball.length);
  assert.ok(d2 > d1 + 5, 'görünür olunca çizim sürmeli');

  // ---- Ping HUD ----
  await A.page.waitForTimeout(2200);
  const ping = await A.page.locator('#game-haxball .hx-ping').textContent();
  note(`ping HUD: "${ping}"`);
  assert.match(ping, /^\d+ ms$/);

  // ---- 2 gol daha → gol limiti (3) ----
  for (let i = 0; i < 2; i++) {
    await until(A, (s) => s.view.phase === 'kickoff' || s.view.phase === 'play', 6000, 'oyun sürüyor');
    await debugPlace(A, { ball: { x: 300, y: 0 }, me: { x: 274, y: 0 } });
    await A.page.waitForTimeout(150);
    await A.page.keyboard.down('Space');
    await A.page.waitForTimeout(100);
    await A.page.keyboard.up('Space');
    await until(A, (s) => s.view.phase === 'goal' || s.view.phase === 'over', 4000, `gol ${i + 2}`);
  }
  const s3 = await until(A, (s) => s.view.phase === 'over', 5000, 'maç bitti');
  note(`gol limiti: skor ${s3.view.score}, sebep ${s3.view.result.reason}, 3. golden sonra ${s3.view.phase} (sevinç sonrası)`);
  assert.equal(s3.view.result.reason, 'limit');
  for (const p of [A, B, C, D, E]) await p.page.waitForSelector('#game-haxball .hx-end:not(.hidden)');
  const endA = await A.page.locator('#game-haxball .hx-end').textContent();
  const endB = await B.page.locator('#game-haxball .hx-end').textContent();
  const endE = await E.page.locator('#game-haxball .hx-end').textContent();
  note(`sonuç (Ali): ${endA.replace(/\s+/g, ' ').slice(0, 220)}`);
  note(`sonuç (izleyici Elif): ${endE.replace(/\s+/g, ' ').slice(0, 160)}`);
  assert.match(endA, /Kırmızı kazandı/);
  assert.match(endA, /Gol limitine ulaşıldı/);
  assert.match(endA, /Takımın kazandı/);
  assert.match(endB, /olmadı/);
  assert.equal((endA.match(/Ali/g) ?? []).length >= 3, true, 'golcü listesi');
  await shot(A, '40-over-land', true);
  await shot(C, '41-over-portrait', true);
  await shot(D, '42-over-desktop', true);
  for (const p of [A, B, C, D, E]) await noHScroll(p, 'sonuç');
  assert.ok(await A.page.locator('button:has-text("Bekleme odasına dön")').isVisible());
  assert.match(await B.page.locator('#game-haxball').textContent(), /Oda sahibinin yeni oyunu başlatması bekleniyor/);

  // ---- Rövanş ----
  await A.page.click('#game-haxball button:has-text("Bekleme odasına dön")');
  const lob = await until(B, (s) => s.room.phase === 'lobby', 5000, 'lobi');
  note(`rövanş lobisi: takımlar korunuyor mu → ${JSON.stringify(Object.fromEntries(lob.room.players.map((p) => [p.name, lob.room.prep.teams[p.id] ?? '-'])))}`);
  await A.page.click('#game-haxball button:has-text("Oyunu başlat")');
  const r2 = await until(E, (s) => s.room.phase === 'playing' && s.view && s.frame && s.frame.k < 600 && s.frame.v === s.view.ver, 8000, 'rövanş');
  assert.deepEqual(r2.view.score, [0, 0]);
  note(`rövanş: Elif takımı ${r2.view.myTeam}, saha ${r2.view.pitch}, diskler ${r2.view.discs.length}`);
  assert.ok(r2.view.myTeam, 'eski izleyici rövanşta oynamalı');
  await E.page.waitForTimeout(800);
  const drawn = await E.page.evaluate(() => window.__qa.ball.slice(-3));
  assert.ok(drawn.length === 3, 'rövanşta çizim sürüyor');
  await shot(E, '43-rematch-elif');
  for (const p of [A, B, C, D, E]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});
