// QA: ⚽ Tosun Top ağ hissi — tarayıcı, gecikme/sarsıntı ekleyen bir TCP vekil (proxy) üzerinden bağlanır, rakip bir bot.
// Ölçülenler: kendi diskinin çizimdeki akıcılığı (60 Hz ekran örneklemesiyle adım düzensizliği, donma), tuşa basıştan
// ekranda kıpırdamaya kadar geçen süre, ping HUD, 3 sn takılma, bağlantı kopması (2 sn / 4 sn) ve 5 sn kuralı,
// altın gol. Sonuçlar test-results/qa-haxball/net-notes.txt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { Bot } from '../lib/bot.js';

const SHOTS = fileURLToPath(new URL('../../test-results/qa-haxball/', import.meta.url));
const NOTES = [];
const note = (s) => { NOTES.push(s); console.log(`# ${s}`); };
let srv;
let browser;
const cleanups = [];

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 0.2 });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => {
  writeFileSync(`${SHOTS}net-notes.txt`, NOTES.join('\n'));
  for (const fn of cleanups) { try { await fn(); } catch { /* */ } }
  await browser?.close();
  await srv?.stop();
});

// Sırayı koruyan gecikmeli TCP vekili: her parça `oneWay + rastgele·jitter` ms sonra, öncekinden önce değil.
function makeProxy(targetPort) {
  const conf = { oneWay: 0, jitter: 0, stallUntil: 0, refuse: false };
  const socks = new Set();
  const pipe = (from, to) => {
    let last = 0;
    from.on('data', (buf) => {
      const now = Date.now();
      const at = Math.max(last, conf.stallUntil, now + conf.oneWay + Math.random() * conf.jitter);
      last = at;
      setTimeout(() => { if (!to.destroyed) to.write(buf); }, Math.max(0, at - now));
    });
  };
  const server = net.createServer((c) => {
    if (conf.refuse) { c.destroy(); return; }
    const s = net.connect(targetPort, 'localhost');
    socks.add(c); socks.add(s);
    const kill = () => { c.destroy(); s.destroy(); socks.delete(c); socks.delete(s); };
    for (const x of [c, s]) { x.on('error', kill); x.on('close', kill); }
    pipe(c, s); pipe(s, c);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const px = {
      conf,
      url: `http://127.0.0.1:${port}`,
      cut(ms) { conf.refuse = true; for (const x of socks) x.destroy(); socks.clear(); setTimeout(() => { conf.refuse = false; }, ms); },
      stall(ms) { conf.stallUntil = Date.now() + ms; },
      close: () => new Promise((r) => { for (const x of socks) x.destroy(); server.close(() => r()); }),
    };
    cleanups.push(px.close);
    resolve(px);
  }));
}

function instrument() {
  const q = { ball: [], me: [] };
  window.__qa = q;
  const arc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function patched(x, y, r, ...rest) {
    const t = performance.now();
    if (r === 10) { q.ball.push([t, x, y]); if (q.ball.length > 20000) q.ball.splice(0, 10000); }
    else if (r === 21) { q.me.push([t, x, y]); if (q.me.length > 20000) q.me.splice(0, 10000); }
    return arc.call(this, x, y, r, ...rest);
  };
}

const state = (p) => p.page.evaluate(async () => {
  const { net: n } = await import('/net.js');
  return { view: n.view, room: n.room, me: n.playerId, frame: n.frame, connected: n.connected };
});
async function until(p, pred, timeout = 15000, label = 'koşul') {
  const t0 = Date.now();
  for (;;) {
    const s = await state(p);
    if (pred(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`${p.name}: ${label} sağlanmadı`);
    await p.page.waitForTimeout(50);
  }
}
const myPos = (s) => {
  const i = s.view?.discs?.findIndex((d) => d.id === s.me) ?? -1;
  if (i < 0 || s.frame?.v !== s.view.ver) return null;
  return { x: s.frame.p[2 * i] / 10, y: s.frame.p[2 * i + 1] / 10 };
};
const debugPlace = (p, a) => p.page.evaluate(async (act) => {
  const { net: n } = await import('/net.js');
  n.action({ type: 'debugPlace', ...act });
}, a);

// Masaüstü oyuncu (vekil üzerinden) + doğrudan bağlı bot rakip. Oyuncu Kırmızı, bot Mavi.
async function match(name, { minutes = 2, goals = 0, predict = true } = {}) {
  const px = await makeProxy(srv.port);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(instrument);
  if (!predict) await ctx.addInitScript(() => { localStorage.setItem('tss:hx-predict', '0'); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION|WebSocket|ERR_EMPTY/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${px.url}/#/multi/haxball`);
  await page.fill('input[placeholder="Takma adın"]', name);
  await page.click('text=Yeni oda kur');
  const code = (await page.locator('#game-haxball .lobby-code').textContent()).trim();
  const bot = new Bot(srv.wsUrl, `Bot${name}`);
  await bot.connect();
  await bot.join(code);
  cleanups.push(() => bot.ws?.close());
  await page.click('#game-haxball .hx-pick.red');
  bot.send({ t: 'lobbyAction', data: { type: 'team', team: 'blue' } });
  const p = { page, ctx, errors, name, px, bot, code };
  await until(p, (s) => Object.keys(s.room?.prep?.teams ?? {}).length === 2, 5000, 'takımlar');
  await page.selectOption('#game-haxball select >> nth=0', String(minutes));
  await page.selectOption('#game-haxball select >> nth=1', String(goals));
  await until(p, (s) => s.room.settings.minutes === minutes && s.room.settings.goals === goals, 5000, 'ayarlar');
  await page.click('#game-haxball button:has-text("Oyunu başlat")');
  await page.waitForSelector('#game-haxball .hx-stage.live');
  await until(p, (s) => myPos(s), 8000, 'ilk kare');
  return p;
}

// Diski dinlenme hâlinden sağa koştur; çizim örneklerinden gecikme ve akıcılık çıkar.
async function measureRun(p, label) {
  await debugPlace(p, { ball: { x: 0, y: -150 }, me: { x: -330, y: 60 } });
  await p.page.waitForTimeout(900);
  const r = await p.page.evaluate(async () => {
    const q = window.__qa;
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd' }));
    await new Promise((res) => setTimeout(res, 3200));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd' }));
    const s = q.me.filter(([t]) => t >= t0 - 50);
    const x0 = s.find(([t]) => t >= t0)?.[1] ?? s[0][1];
    const first = s.find(([t, x]) => t >= t0 && x > x0 + 0.5);
    // 60 Hz ekranı taklit et: her 16.67 ms'de en son çizilen konum; sabit hız penceresinde adım dağılımı.
    const w0 = t0 + 1500;
    const w1 = t0 + 3100;
    const steps = [];
    let prev = null;
    let i = 0;
    for (let t = w0; t <= w1; t += 1000 / 60) {
      while (i + 1 < s.length && s[i + 1][0] <= t) i++;
      const x = s[i][1];
      if (prev != null) steps.push(x - prev);
      prev = x;
    }
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const sd = Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length);
    const frozen = steps.filter((d) => Math.abs(d) < 0.05).length;
    const jumps = steps.filter((d) => d > mean * 1.6).length;
    // En uzun donma (çizimde konum değişmeyen süre, sabit hız penceresinde)
    let maxFreeze = 0;
    let since = null;
    for (let j = 1; j < s.length; j++) {
      if (s[j][0] < w0 || s[j][0] > w1) continue;
      if (Math.abs(s[j][1] - s[j - 1][1]) < 0.01) { since ??= s[j - 1][0]; maxFreeze = Math.max(maxFreeze, s[j][0] - since); } else since = null;
    }
    const dts = s.filter(([t]) => t >= w0 && t <= w1).map(([t], j, arr) => (j ? t - arr[j - 1][0] : 0)).slice(1);
    return {
      latency: first ? Math.round(first[0] - t0) : null,
      mean: +mean.toFixed(2), sd: +sd.toFixed(2), frozen, jumps, n: steps.length, maxFreeze: Math.round(maxFreeze),
      fps: Math.round(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)), maxDt: Math.round(Math.max(...dts)),
      ping: document.querySelector('#game-haxball .hx-ping')?.textContent,
      resets: document.querySelector('#game-haxball .hx')?.dataset.predResets,
    };
  });
  note(`${label}: tuş→ekranda hareket ${r.latency} ms; 60 Hz adım ort ${r.mean} birim (sd ${r.sd}), donuk adım ${r.frozen}/${r.n}, sıçrama ${r.jumps}, en uzun donma ${r.maxFreeze} ms; rAF ~${r.fps} fps (en uzun ${r.maxDt} ms); ping HUD "${r.ping}"; tahmin sıfırlama ${r.resets ?? '-'}`);
  return r;
}

test('akıcılık ve girdi gecikmesi: doğrudan / 150 ms RTT / sarsıntılı tünel', async () => {
  const p = await match('Akis');
  await p.page.waitForTimeout(2500); // ping otursun
  const direct = await measureRun(p, 'doğrudan');
  p.px.conf.oneWay = 75;
  await p.page.waitForTimeout(4500);
  const rtt150 = await measureRun(p, 'RTT 150 ms, sarsıntı yok');
  p.px.conf.oneWay = 50; p.px.conf.jitter = 60;
  await p.page.waitForTimeout(4500);
  const jit = await measureRun(p, 'RTT ~160 ms, sarsıntı 0–60 ms');
  p.px.conf.oneWay = 40; p.px.conf.jitter = 150;
  await p.page.waitForTimeout(4500);
  const bad = await measureRun(p, 'RTT ~230 ms, sarsıntı 0–150 ms (kötü tünel)');
  await p.page.screenshot({ path: `${SHOTS}50-desktop-badtunnel.png` });
  assert.ok(direct.latency < 250, 'doğrudan gecikme');
  // Kendi disk istemcide tahmin edilir: 150 ms RTT tuş → ekran gecikmesine yansımamalı (eskiden ~320 ms).
  assert.ok(rtt150.latency < direct.latency + 80, `150 ms RTT'de tahminli gecikme ${rtt150.latency} ms`);
  assert.ok(bad.frozen <= 4, `kötü tünelde donma (uyarlanabilir gecikme + kısa ileri tahmin) ${bad.frozen}`);
  const dr = await measureDribble(p, 'top sürme, tahmin açık, RTT 150');
  void dr;
  assert.ok(direct.frozen <= 3, 'doğrudan bağlantıda donma olmamalı'); // 150 ms RTT'deki donma makine yüküne duyarlı: sadece not edilir
  void jit; void bad;
  assert.deepEqual(p.errors, []);
});

// Top sürme: disk topa sağa doğru dayanıp iter. Çizimde disk–top merkez mesafesi (yarıçap toplamı 25) ölçülür:
// tahminli diskle top farklı zaman çizgisinde olduğundan disk topun içine girebilir.
async function measureDribble(p, label) {
  await debugPlace(p, { ball: { x: -240, y: 60 }, me: { x: -300, y: 60 } });
  await p.page.waitForTimeout(900);
  const r = await p.page.evaluate(async () => {
    const q = window.__qa;
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd' }));
    await new Promise((res) => setTimeout(res, 2500));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd' }));
    const me = q.me.filter(([t]) => t >= t0 + 300);
    const ball = q.ball.filter(([t]) => t >= t0 + 300);
    const d = [];
    let j = 0;
    for (const [t, x, y] of me) {
      while (j + 1 < ball.length && ball[j + 1][0] <= t) j++;
      if (ball[j]) d.push(Math.hypot(ball[j][1] - x, ball[j][2] - y));
    }
    d.sort((a, b) => a - b);
    return { min: d[0], p10: d[Math.floor(d.length * 0.1)], overlap: d.filter((x) => x < 24).length / d.length };
  });
  note(`${label}: çizimde disk–top mesafesi en az ${r.min?.toFixed(1)} (p10 ${r.p10?.toFixed(1)}, temas 25), iç içe görünen kare %${(100 * r.overlap).toFixed(0)}`);
  return r;
}

test('karşılaştırma: tahmin kapalı (sadece uyarlanabilir ara değer)', async () => {
  const p = await match('Kapali', { predict: false });
  await p.page.waitForTimeout(2500);
  const direct = await measureRun(p, 'tahmin kapalı, doğrudan');
  p.px.conf.oneWay = 75;
  await p.page.waitForTimeout(4500);
  const rtt150 = await measureRun(p, 'tahmin kapalı, RTT 150 ms');
  await measureDribble(p, 'top sürme, tahmin kapalı, RTT 150');
  p.px.conf.oneWay = 40; p.px.conf.jitter = 150;
  await p.page.waitForTimeout(4500);
  const bad = await measureRun(p, 'tahmin kapalı, RTT ~230 ms, sarsıntı 0–150 ms');
  assert.ok(direct.latency < 150, `LAN'da ara değer gecikmesi küçülmeli (${direct.latency} ms)`);
  assert.ok(rtt150.latency > direct.latency, 'tahminsiz gecikme RTT ile artar');
  assert.ok(bad.frozen <= 4, `kötü tünelde donma ${bad.frozen}`);
  assert.deepEqual(p.errors, []);
});

test('3 sn takılma (Wi-Fi anlık gitti, TCP açık): disk durur, sonra toparlanır', async () => {
  const p = await match('Takil');
  await debugPlace(p, { ball: { x: 0, y: -150 }, me: { x: -300, y: 0 } });
  await p.page.waitForTimeout(500);
  await p.page.keyboard.down('KeyD');
  await p.page.waitForTimeout(300);
  p.px.stall(3000);
  const t0 = Date.now();
  await p.page.waitForTimeout(1500);
  const ui = await p.page.evaluate(() => ({
    ping: document.querySelector('#game-haxball .hx-ping').textContent,
    offline: [...document.querySelectorAll('.hx-stage *')].some((e) => /Bağlantı/.test(e.textContent) && e.offsetParent),
  }));
  await p.page.screenshot({ path: `${SHOTS}51-stall-mid.png` });
  const botSaw = [];
  const tap = (m) => { if (m.t === 'frame') { const i = p.bot.view.discs.findIndex((d) => d.id !== p.bot.playerId); botSaw.push([Date.now() - t0, m.p[2 * i] / 10]); } };
  p.bot.taps.push(tap);
  await p.page.waitForTimeout(2200);
  await p.page.keyboard.up('KeyD');
  await p.page.waitForTimeout(800);
  p.bot.taps.splice(p.bot.taps.indexOf(tap), 1);
  // Sunucu tarafında (botun gördüğü) disk: takılmanın 1.5 sn'sinden sonra durmuş olmalı
  const at = (ms) => botSaw.reduce((best, s) => (Math.abs(s[0] - ms) < Math.abs(best[0] - ms) ? s : best), botSaw[0]);
  const x15 = at(1700)[1]; const x26 = at(2600)[1]; const x28 = at(2950)[1];
  const s = await state(p);
  note(`takılma: 1.5 sn'de HUD ping "${ui.ping}", bağlantı uyarısı görünür mü: ${ui.offline}; sunucuda disk 1.7 sn→${x15.toFixed(1)}, 2.9 sn→${x28.toFixed(1)} (durmalı); sonra bağlı=${s.connected}, faz ${s.view.phase}`);
  assert.ok(Math.abs(x28 - x26) < 8, `girdi gelmeyince sunucu diski durdurmalı (2.6 sn ${x26} → 2.95 sn ${x28})`);
  assert.equal(s.connected, true);
  assert.deepEqual(p.errors, []);
});

test('bağlantı kopması: 2 sn döner (disk kalır), 4 sn kopma → yeniden bağlanma gecikmesi + 5 sn kuralı', async () => {
  const p = await match('Kop');
  await p.page.waitForTimeout(500);
  p.px.cut(2000);
  const t0 = Date.now();
  await until(p, (s) => !s.connected, 3000, 'koptu');
  const offUi = await p.page.evaluate(() => [...document.querySelectorAll('.hx-stage *')].some((e) => /Bağlantı/.test(e.textContent) && e.offsetParent));
  await p.page.screenshot({ path: `${SHOTS}52-cut-offline.png` });
  const back = await until(p, (s) => s.connected && s.view && myPos(s), 12000, 'geri bağlandı');
  const dt2 = Date.now() - t0;
  note(`2 sn kopma: ${dt2} ms sonra geri bağlandı; takım ${back.view.myTeam}, removed ${back.view.removed}; kopukken sahnede "Bağlantı" uyarısı: ${offUi}`);
  assert.equal(back.view.myTeam, 'red');

  await p.page.waitForTimeout(1500);
  p.px.cut(4000);
  const t1 = Date.now();
  await until(p, (s) => !s.connected, 3000, 'koptu 2');
  const back2 = await until(p, (s) => s.connected && s.view, 20000, 'geri bağlandı 2');
  const dt4 = Date.now() - t1;
  await p.page.waitForTimeout(300);
  const s2 = await state(p);
  note(`4 sn kopma: istemci ${dt4} ms sonra geri bağlandı (canlı maçta bekleme ≤ 1 sn); faz ${s2.view.phase}, sonuç ${JSON.stringify(s2.view.result)}, removed ${s2.view.removed}`);
  await p.page.screenshot({ path: `${SHOTS}53-after-4s-cut.png`, fullPage: true });
  void back2;
  assert.ok(dt4 < 6500, `4 sn kopmadan sonra hızlı dönmeli (${dt4} ms)`);
  assert.notEqual(s2.view.phase, 'over', '4 sn kopma maçı bitirmemeli');
  assert.equal(s2.view.removed, false);
  assert.equal(s2.view.myTeam, 'red', 'disk geri verilmeli');
  assert.ok(offUi, 'kopukken "Bağlantı koptu" bandı görünmeli');
  assert.deepEqual(p.errors, []);
});

test('altın gol: berabere biter → ⚡ uzatma, ilk gol kazanır', async () => {
  const p = await match('Altin', { minutes: 2, goals: 3 });
  const ot = await until(p, (s) => s.view?.overtime, 40000, 'uzatma');
  await p.page.waitForTimeout(1500);
  const hud = await p.page.evaluate(() => ({
    clock: document.querySelector('#game-haxball .hx-clock').textContent,
    status: document.querySelector('#game-haxball .hx-status').textContent,
  }));
  await p.page.screenshot({ path: `${SHOTS}54-golden-goal.png` });
  note(`altın gol: skor ${ot.view.score}, HUD saat "${hud.clock}", durum "${hud.status}"`);
  assert.match(hud.status, /Altın gol/);
  assert.match(hud.clock, /^\+0:0\d$/);
  await debugPlace(p, { ball: { x: 300, y: 0 }, me: { x: 274, y: 0 } });
  await p.page.waitForTimeout(150);
  await p.page.keyboard.down('Space');
  await p.page.waitForTimeout(100);
  await p.page.keyboard.up('Space');
  const over = await until(p, (s) => s.view.phase === 'over', 6000, 'bitti');
  assert.equal(over.view.result.reason, 'golden');
  await p.page.waitForSelector('#game-haxball .hx-end:not(.hidden)');
  const end = await p.page.locator('#game-haxball .hx-end').textContent();
  note(`altın gol sonucu: ${end.replace(/\s+/g, ' ').slice(0, 120)}`);
  assert.match(end, /Altın gol!/);
  await p.page.screenshot({ path: `${SHOTS}55-golden-over.png`, fullPage: true });
  assert.deepEqual(p.errors, []);
});
