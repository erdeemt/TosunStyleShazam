// ⚽ Tosun Top kural sürüsü: gol tam bir kez sayılır (ağda seken top, süre bitimine denk gelen gol), altın gol,
// uzatma sınırı → berabere, gol limiti. Süre ölçeği 0.02: 2 dk maç = 144 adım ≈ 2.4 sn, altın gol en fazla 216 adım.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { setupMatch, sleep } from './haxball-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.02 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });
const track = (g) => { all.push(...g.bots); return g; };

// Kırmızı sağdaki kaleye atar: topu çizginin hemen önüne, oyuncuyu arkasına koy, sağa koş + vur.
function shoot(bot, { team = 'red' } = {}) {
  const s = team === 'red' ? 1 : -1;
  bot.action({ type: 'debugPlace', ball: { x: s * 355, y: 0 }, me: { x: s * 328, y: 0 } });
  bot.input(s, 0, true);
}

function invariants(v) {
  const errs = [];
  if (v.score[0] + v.score[1] !== v.goals.length) errs.push(`skor ${v.score} ≠ gol listesi ${v.goals.length}`);
  const red = v.goals.filter((x) => x.team === 'red').length;
  if (red !== v.score[0]) errs.push(`kırmızı gol sayısı ${red} ≠ skor ${v.score[0]}`);
  if (v.phase === 'over') {
    const w = v.score[0] > v.score[1] ? 'red' : v.score[1] > v.score[0] ? 'blue' : 'draw';
    if (v.result?.winner !== w) errs.push(`kazanan ${v.result?.winner} ≠ skordan ${w}`);
  }
  return errs;
}

test('gol tam bir kez: top ağda sekerken / duvara yapışıkken ikinci kez sayılmaz', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { settings: { minutes: 5, goals: 0 } }));
  const [red, blue] = g.bots;
  const views = [];
  red.taps.push((m) => { if (m.t === 'view') views.push(m.view); });
  shoot(red);
  const v = await red.waitView((x) => x.phase === 'goal', { timeout: 3000 });
  assert.deepEqual(v.score, [1, 0]);
  // Gol sevinci boyunca (2.5 sn) top ağda sekmeye devam eder: skor değişmemeli
  red.input(1, 0, true);
  await sleep(1500);
  red.input(0, 0, false);
  const k = await red.waitView((x) => x.phase === 'kickoff', { timeout: 4000 });
  assert.deepEqual(k.score, [1, 0]);
  assert.equal(k.goals.length, 1);
  assert.equal(k.kickoffTeam, 'blue', 'yiyen takım başlar');
  assert.equal(k.goals[0].id, red.playerId);
  assert.equal(k.goals[0].own, false);
  // Kendi kalesine: mavi oyuncu topu kendi (sağ) kalesine iter
  blue.action({ type: 'debugPlace', ball: { x: 355, y: 0 }, me: { x: 328, y: 0 } });
  blue.input(1, 0, true);
  const v2 = await blue.waitView((x) => x.goals.length === 2, { timeout: 3000 });
  assert.deepEqual(v2.score, [2, 0]);
  assert.equal(v2.goals[1].own, true, 'kendi kalesine');
  for (const x of views) assert.deepEqual(invariants(x), []);
  g.bots.forEach((b) => b.leave());
});

test('gol limiti: 3. gol maçı sevinçten sonra bitirir, sonra gelen top sayılmaz', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { settings: { minutes: 5, goals: 3 } }));
  const [red] = g.bots;
  for (let i = 1; i <= 3; i++) {
    await red.waitView((x) => x.phase === 'kickoff' || x.phase === 'play', { timeout: 5000 });
    shoot(red);
    await red.waitView((x) => x.score[0] === i, { timeout: 3000 });
    red.input(0, 0, false);
  }
  const over = await red.waitView((x) => x.phase === 'over', { timeout: 5000 });
  assert.deepEqual(over.score, [3, 0]);
  assert.equal(over.result.reason, 'limit');
  assert.deepEqual(invariants(over), []);
  // Bittikten sonra eylem/girdi skoru değiştirmez, kare gelmez
  const n = red.frameCount;
  red.input(1, 0, true);
  red.action({ type: 'debugPlace', ball: { x: 355, y: 0 } });
  await sleep(300);
  assert.equal(red.frameCount, n, 'maç bitince kare gelmemeli');
  assert.deepEqual(red.view.score, [3, 0]);
  g.bots.forEach((b) => b.leave());
});

test('süre sonu ile aynı anlara denk gelen goller: tutarlı skor/sonuç (6 deneme)', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { settings: { minutes: 2, goals: 0 } }));
  const [red] = g.bots;
  const results = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const lead = attempt - 1; // süre bitimine bu kadar adım kala şut (≈ 3 adımda çizgiyi geçer)
    // 1 gol önde olmak için önce bir gol at (beraberlik yerine "time" sonucu da görülsün diye her iki durumu dene)
    if (attempt % 2 === 0) {
      shoot(red);
      await red.waitView((x) => x.goals.length === 1, { timeout: 3000 });
      red.input(0, 0, false);
      await red.waitView((x) => x.phase === 'kickoff', { timeout: 6000 });
    }
    // Saat gol sevincinde ve başlama vuruşunda (en fazla 5 sn) durur; bu yüzden adım sayısı yerine saatin
    // 2→1 sn'ye düştüğü kareyi çapa al: o anda tam 60 adım kalmıştır.
    const goals = red.view.goals.length;
    let goalAt = '?';
    const one = await red.waitFrame((f) => f.c === 1, { timeout: 15_000 });
    const target = one.k + 60 - lead - 3;
    await red.waitFrame((f) => f.k >= target, { timeout: 3000 });
    shoot(red);
    red.waitView((x) => x.goals.length > goals, { timeout: 3000 }).then((x) => {
      goalAt = `gol@kalan${target + 3 + lead - red.frame.k}/${x.phase}`;
    }).catch(() => { goalAt = 'gol yok'; });
    const end = await red.waitView((x) => x.phase === 'over' || x.overtime, { timeout: 8000 });
    let fin = end;
    if (end.overtime && end.phase !== 'over') {
      // beraberlik → altın gol; hemen gol at
      await sleep(100);
      shoot(red);
      fin = await red.waitView((x) => x.phase === 'over', { timeout: 8000 });
      assert.equal(fin.result.reason, 'golden');
    }
    results.push(`${goalAt} → ${fin.score.join('-')} ${fin.result.reason} ${fin.result.winner}`);
    assert.deepEqual(invariants(fin), [], results.at(-1));
    g.host.send({ t: 'backToLobby' });
    await g.host.waitRoom((r) => r.phase === 'lobby');
    g.bots.forEach((b) => { b.frame = null; });
    g.host.send({ t: 'start' });
    await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'kickoff' && v.goals.length === 0, { timeout: 5000 })));
    await red.waitFrame(() => true);
    await sleep(1100); // genel hız sınırı için soluklan
  }
  console.log(`# süre sonu denemeleri: ${results.join(' | ')}`);
  g.bots.forEach((b) => b.leave());
});

test('altın gol: süre berabere biter → uzatma (c eksi), ilk gol kazanır', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { settings: { minutes: 2, goals: 3 } }));
  const [red, blue] = g.bots;
  const ot = await red.waitView((x) => x.overtime, { timeout: 12_000 }); // + 5 sn başlama vuruşu bekleme
  assert.notEqual(ot.phase, 'over');
  await red.waitFrame((f) => f.c < 0, { timeout: 3000 });
  shoot(blue, { team: 'blue' });
  const fin = await red.waitView((x) => x.phase === 'over', { timeout: 6000 });
  assert.equal(fin.result.reason, 'golden');
  assert.equal(fin.result.winner, 'blue');
  assert.deepEqual(fin.score, [0, 1]);
  g.bots.forEach((b) => b.leave());
});

test('altın gol süresi dolarsa berabere', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { settings: { minutes: 2, goals: 3 } }));
  const [red] = g.bots;
  const fin = await red.waitView((x) => x.phase === 'over', { timeout: 20_000 });
  assert.equal(fin.overtime, true);
  assert.equal(fin.result.winner, 'draw');
  assert.equal(fin.result.reason, 'time');
  g.bots.forEach((b) => b.leave());
});
