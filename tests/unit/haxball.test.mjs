// ⚽ Tosun Top: saf fizik (public/haxball-physics.js) ve sunucu oyun modülünün kuralları (server/games/haxball.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HZ, RED, BLUE, PHYS, PITCHES, createWorld, step, setInput, resetKickoff, snapshot,
} from '../../public/haxball-physics.js';
import game from '../../server/games/haxball.js';
import { createRng } from '../../server/rng.js';

const P = PHYS;
const free = (world) => { world.kickoff = null; return world; }; // başlama vuruşu kısıtı olmadan
const run = (world, n) => { let goal = -1; for (let i = 0; i < n; i++) { const ev = step(world); if (ev.goal >= 0 && goal < 0) goal = ev.goal; } return goal; };

test('iki oyuncu çarpışınca iç içe kalmaz, momentum korunur', () => {
  const w = free(createWorld('small', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]));
  const [a, b] = w.players;
  a.x = -40; a.y = 0; a.vx = 2; a.vy = 0;
  b.x = 40; b.y = 0; b.vx = -2; b.vy = 0;
  w.ball.x = 0; w.ball.y = 150;
  for (let i = 0; i < 40; i++) {
    step(w);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * P.playerRadius - 1e-6, 'diskler iç içe');
    assert.ok(Math.abs(a.vx + b.vx) < 1e-9, 'momentum korunmalı (eşit kütle)');
  }
  assert.ok(a.vx < 0 && b.vx > 0, 'çarpışınca geri sekmeliler');
});

test('top duvardan seker (katsayı 0.5), en hızlı top bile duvarı/ağı delemez', () => {
  const w = free(createWorld('small', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]));
  w.players[0].x = -300; w.players[1].x = 300; w.players[0].y = w.players[1].y = 0;
  const b = w.ball;
  b.x = 0; b.y = -150; b.vx = 0; b.vy = -6;
  run(w, 10);
  assert.ok(b.vy > 0, 'yukarıdaki duvardan aşağı dönmeli');
  assert.ok(b.vy < 6 * 0.5 + 0.01, 'sekme enerji kaybetmeli');
  assert.ok(b.y - P.ballRadius >= -PITCHES.small.h - 1e-6);
  // 72 açıyla maksimum hızda atış: top her zaman saha + ağ sınırları içinde
  const p = PITCHES.small;
  for (let k = 0; k < 72; k++) {
    resetKickoff(w, RED); w.kickoff = null;
    w.players[0].x = -400; w.players[0].y = -190; w.players[1].x = 400; w.players[1].y = 190;
    const ang = (k / 72) * Math.PI * 2;
    b.x = 0; b.y = 0; b.vx = Math.cos(ang) * 40; b.vy = Math.sin(ang) * 40; // sınırın üstü: kırpılır
    w.goalsEnabled = false;
    for (let i = 0; i < 300; i++) {
      step(w);
      assert.ok(Math.abs(b.y) <= p.h - P.ballRadius + 1e-6, `top dikeyde dışarı çıktı (açı ${k})`);
      assert.ok(Math.abs(b.x) <= p.w + p.depth - P.ballRadius + 1e-6, `top yatayda dışarı çıktı (açı ${k})`);
      if (Math.abs(b.x) > p.w + P.ballRadius) assert.ok(Math.abs(b.y) < p.goal, 'kale dışında çizgiyi geçti');
    }
  }
});

test('gol: top çizgiyi TAMAMEN geçince; çizgi üstünde veya direğe çarpınca gol yok', () => {
  const p = PITCHES.small;
  const w = free(createWorld('small', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]));
  w.players[0].x = -300; w.players[1].x = -200;
  const b = w.ball;
  // Çizginin yarısını geçmiş, duran top: gol değil
  b.x = p.w + 2; b.y = 0; b.vx = 0; b.vy = 0;
  assert.equal(run(w, 30), -1, 'çizgi üstündeki top gol sayılmamalı');
  // Kaleye yuvarlanan top: kırmızı atar (sağ kale)
  b.x = p.w - 60; b.y = 0; b.vx = 4; b.vy = 0;
  assert.equal(run(w, 60), RED);
  // Sol kale: mavi atar
  resetKickoff(w, RED); w.kickoff = null; w.players[0].x = 300; w.players[1].x = 200;
  b.x = -p.w + 60; b.y = 10; b.vx = -4; b.vy = 0;
  assert.equal(run(w, 60), BLUE);
  // Direğe dik gelen top geri seker, gol yok
  resetKickoff(w, RED); w.kickoff = null; w.players[0].x = -300; w.players[1].x = -200;
  b.x = p.w - 100; b.y = p.goal; b.vx = 5; b.vy = 0;
  assert.equal(run(w, 120), -1, 'direkten dönen top gol olmamalı');
  assert.ok(b.x < p.w, 'top direkten sahaya dönmeli');
});

test('şut: menzilde itki, menzil dışında yok, basılı tutunca bekleme süresi', () => {
  const w = free(createWorld('small', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]));
  const [a, other] = w.players;
  other.x = 300; other.y = 150;
  a.x = 0; a.y = 0;
  const b = w.ball;
  b.x = P.playerRadius + P.ballRadius + 2; b.y = 0;
  setInput(a, 0, 0, true);
  const ev = step(w);
  assert.equal(ev.kicks, 1);
  assert.ok(Math.abs(b.vx - P.kickStrength * P.ballDamping) < 1e-6, `itki ${b.vx}`);
  assert.ok(Math.abs(b.vy) < 1e-9);
  // Top geri getirilir; tuş hâlâ basılı: bekleme süresi dolana kadar ikinci şut yok
  let kicks = 0;
  let firstAgain = null;
  for (let i = 1; i <= 30; i++) {
    b.x = a.x + P.playerRadius + P.ballRadius + 2; b.y = a.y; b.vx = 0; b.vy = 0;
    if (step(w).kicks) { kicks++; firstAgain ??= i; }
  }
  assert.equal(firstAgain, P.kickCooldown, 'ikinci şut bekleme süresinden sonra');
  assert.ok(kicks <= Math.ceil(30 / P.kickCooldown), 'makineli tüfek olmamalı');
  // Menzil dışı
  setInput(a, 0, 0, false); step(w); for (let i = 0; i < 20; i++) step(w);
  b.x = a.x + P.playerRadius + P.ballRadius + P.kickReach + 3; b.y = a.y; b.vx = 0; b.vy = 0;
  setInput(a, 0, 0, true);
  assert.equal(step(w).kicks, 0, 'menzil dışında şut olmamalı');
});

test('şut tuşu basılıyken oyuncu biraz yavaş koşar; en yüksek hız sınırlı', () => {
  const speed = (kick) => {
    const w = free(createWorld('medium', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]));
    const a = w.players[0];
    a.x = -500; a.y = -200; w.players[1].x = 500; w.players[1].y = 200; w.ball.y = 200; w.ball.x = 0;
    setInput(a, 1, 0, kick);
    for (let i = 0; i < 150; i++) step(w);
    return a.vx;
  };
  const normal = speed(false);
  const slow = speed(true);
  assert.ok(Math.abs(normal - 2.4 * 0.96 / 0.96) < 0.1, `normal hız ${normal}`);
  assert.ok(slow < normal * 0.8, `şutta yavaşlamalı (${slow} / ${normal})`);
});

test('başlama vuruşu: rakip orta yuvarlağa/yarıya giremez, vuran takım girer ve dokununca kısıt kalkar', () => {
  const p = PITCHES.small;
  const w = createWorld('small', [{ id: 'r', team: RED }, { id: 'b', team: BLUE }]);
  resetKickoff(w, RED);
  const [r, bl] = w.players;
  setInput(bl, -1, 0, false); // mavi ortaya koşar
  for (let i = 0; i < 300; i++) {
    step(w);
    assert.ok(Math.hypot(bl.x, bl.y) >= p.circle + P.playerRadius - 1e-6, 'mavi orta yuvarlağa girdi');
    assert.ok(bl.x >= P.playerRadius - 1e-6, 'mavi kendi yarısından çıktı');
  }
  assert.equal(w.kickoff, RED, 'top dokunulmadan kısıt sürmeli');
  setInput(bl, 0, 0, false);
  // Kırmızı rakip yarıya yuvarlak dışından geçemez
  r.x = -50; r.y = -150; setInput(r, 1, 0, false);
  for (let i = 0; i < 120; i++) { step(w); assert.ok(r.x <= -P.playerRadius + 1e-6 || Math.hypot(r.x, r.y) <= p.circle - P.playerRadius + 1e-6); }
  // Kırmızı topa koşar: yuvarlağa girer, dokununca kısıt kalkar
  r.x = -120; r.y = 0; setInput(r, 1, 0, false);
  let released = false;
  for (let i = 0; i < 200 && !released; i++) { step(w); released = w.kickoff == null; }
  assert.ok(released, 'kırmızı topa dokunabilmeli');
});

test('determinizm: aynı girdi dizisi → aynı sonuç', () => {
  const sim = () => {
    const rng = createRng(42);
    const w = createWorld('medium', Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, team: i % 2 })));
    for (let t = 0; t < 1800; t++) {
      if (t % 7 === 0) for (const d of w.players) setInput(d, rng.next() * 2 - 1, rng.next() * 2 - 1, rng.next() < 0.3);
      const ev = step(w);
      if (ev.goal >= 0) resetKickoff(w, 1 - ev.goal);
    }
    return JSON.stringify(snapshot(w));
  };
  assert.equal(sim(), sim());
});

test('girdi temizleme: NaN/Infinity/dev değer/nesne güvenli', () => {
  const w = createWorld('small', [{ id: 'a', team: RED }, { id: 'b', team: BLUE }]);
  const d = w.players[0];
  for (const [x, y] of [[NaN, 1], [Infinity, -Infinity], [1e308, 1e308], [{}, []], ['1', null]]) {
    setInput(d, x, y, 'evet');
    assert.ok(Math.hypot(d.ix, d.iy) <= 1 + 1e-9);
    assert.ok(Number.isFinite(d.ix) && Number.isFinite(d.iy));
    assert.equal(d.kick, false);
  }
  setInput(d, 3, 4, true);
  assert.ok(Math.abs(d.ix - 0.6) < 1e-9 && Math.abs(d.iy - 0.8) < 1e-9 && d.kick === true);
});

test('hız: 4 oda × 8 oyuncu, 60 sn oyun süresi gerçek zamandan çok hızlı', () => {
  const worlds = Array.from({ length: 4 }, () => createWorld('medium', Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, team: i % 2 }))));
  const rng = createRng(7);
  const t0 = performance.now();
  for (let t = 0; t < 60 * HZ; t++) {
    for (const w of worlds) {
      if (t % 5 === 0) for (const d of w.players) setInput(d, rng.next() * 2 - 1, rng.next() * 2 - 1, rng.next() < 0.2);
      const ev = step(w);
      if (ev.goal >= 0) resetKickoff(w, 1 - ev.goal);
    }
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `4×60 sn simülasyon ${ms.toFixed(0)} ms sürdü`);
});

// ---------- Oyun modülü ----------

function newGame(teams, settings = {}, timeScale = 1) {
  const ids = Object.keys(teams);
  const players = ids.map((id) => ({ id, name: id.toUpperCase() }));
  const s = game.validateSettings({ ...game.defaultSettings, ...settings });
  return game.setup({ players, settings: s, prep: { teams }, rng: createRng(1), ctx: { timeScale } });
}
const stepN = (state, n) => { let changed = 0; for (let i = 0; i < n; i++) if (game.realtime.step(state)) changed++; return changed; };

function scoreFor(state, team) {
  // Topu rakip kaleye yuvarla
  const w = state.world;
  const p = w.pitch;
  w.kickoff = null; state.phase = 'play';
  const dir = team === 'red' ? 1 : -1;
  const shooter = w.players.find((d) => d.team === (team === 'red' ? RED : BLUE));
  w.ball.x = dir * (p.w - 50); w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
  shooter.x = w.ball.x - dir * (P.playerRadius + P.ballRadius + 1); shooter.y = 0; shooter.kickCd = 0;
  game.input(state, shooter.id, { x: dir, y: 0, k: 1 });
  for (const d of w.players) if (d !== shooter) { d.x = -dir * 300; d.y = 150; }
  for (let i = 0; i < 60 && state.phase !== 'goal' && state.phase !== 'over'; i++) game.realtime.step(state);
  game.input(state, shooter.id, { x: 0, y: 0, k: 0 });
}

test('ayarlar: sadece izin verilen değerler', () => {
  assert.deepEqual(game.validateSettings({ minutes: 99, goals: -1, size: 'huge' }), { minutes: 3, goals: 3, size: 'auto' });
  assert.deepEqual(game.validateSettings({ minutes: 5, goals: 0, size: 'medium' }), { minutes: 5, goals: 0, size: 'medium' });
});

test('takım seçimi, karıştırma ve başlama kontrolü', () => {
  const ctx = { isHost: false, playerIds: ['a', 'b', 'c', 'd'], rng: createRng(3) };
  let prep = game.initialPrep();
  prep = game.lobbyAction(prep, 'a', { type: 'team', team: 'red' }, ctx);
  prep = game.lobbyAction(prep, 'b', { type: 'team', team: 'red' }, ctx);
  assert.throws(() => game.lobbyAction(prep, 'c', { type: 'team', team: 'yeşil' }, ctx));
  assert.throws(() => game.lobbyAction(prep, 'c', { type: 'shuffle' }, ctx), /oda sahibi/);
  // c, d seçmedi → maviye dengelenir
  assert.equal(game.canStart(prep, {}, ctx.playerIds.map((id) => ({ id, connected: true }))), null);
  // Herkes kırmızı → başlamaz
  for (const id of ['c', 'd']) prep = game.lobbyAction(prep, id, { type: 'team', team: 'red' }, ctx);
  assert.match(game.canStart(prep, {}, ctx.playerIds.map((id) => ({ id, connected: true }))), /İki takımda/);
  prep = game.lobbyAction(prep, 'd', { type: 'team', team: 'spec' }, ctx);
  prep = game.lobbyAction(prep, 'a', { type: 'shuffle' }, { ...ctx, isHost: true });
  const t = prep.teams;
  assert.equal(t.d, 'spec', 'izleyici karıştırmada izleyici kalır');
  const red = ['a', 'b', 'c'].filter((id) => t[id] === 'red').length;
  assert.ok(red === 1 || red === 2, 'karıştırma dengeli');
  // Ayrılan oyuncu prep'ten silinir
  prep = game.lobbyAction(prep, 'a', { type: 'team', team: 'blue' }, { ...ctx, playerIds: ['a', 'b'] });
  assert.deepEqual(Object.keys(prep.teams).sort(), ['a', 'b']);
});

test('gol limiti: 3 gol atan takım kazanır, golcü ve yiyen takımın başlama vuruşu', () => {
  const s = newGame({ a: 'red', b: 'blue' }, { goals: 3 });
  assert.equal(s.settings.size, 'small');
  for (let g = 0; g < 3; g++) {
    scoreFor(s, 'red');
    assert.equal(s.phase, 'goal');
    assert.equal(s.kickoffTeam, 'blue');
    stepN(s, 200);
  }
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.score, [3, 0]);
  assert.equal(s.result.winner, 'red');
  assert.equal(s.goals[0].name, 'A');
  assert.equal(s.goals[0].own, false);
});

test('kendi kalesine gol "kk" olarak işaretlenir', () => {
  const s = newGame({ a: 'red', b: 'blue' });
  const w = s.world;
  w.kickoff = null; s.phase = 'play';
  const blue = w.players.find((d) => d.team === BLUE);
  const red = w.players.find((d) => d.team === RED);
  red.x = -300; red.y = 150;
  blue.x = w.pitch.w - 60; blue.y = 0; blue.vx = 0;
  w.ball.x = w.pitch.w - 35; w.ball.y = 0; w.ball.vx = 0;
  setInput(blue, 1, 0, true); // mavi kendi kalesine (sağ) şut
  for (let i = 0; i < 90 && s.phase !== 'goal'; i++) game.realtime.step(s);
  assert.equal(s.phase, 'goal');
  assert.equal(s.lastGoal.team, 'red');
  assert.equal(s.lastGoal.own, true);
  assert.equal(s.lastGoal.name, 'B');
});

test('süre biter: önde olan kazanır; berabere ise altın gol', () => {
  const s = newGame({ a: 'red', b: 'blue' }, { minutes: 2 }, 0.01); // 2 dk × 0.01 = 72 adım
  scoreFor(s, 'blue'); stepN(s, 200);
  stepN(s, 100);
  assert.equal(s.phase, 'over');
  assert.equal(s.result.winner, 'blue');
  assert.equal(s.result.reason, 'time');

  const t = newGame({ a: 'red', b: 'blue' }, { minutes: 2 }, 0.01);
  stepN(t, 100);
  assert.equal(t.overtime, true, 'berabere → uzatma');
  assert.notEqual(t.phase, 'over');
  assert.ok(game.realtime.frame(t).c <= 0, 'uzatmada saat eksi (sayar)');
  scoreFor(t, 'red');
  stepN(t, 200);
  assert.equal(t.phase, 'over');
  assert.equal(t.result.reason, 'golden');
  assert.equal(t.result.winner, 'red');
});

test('bağlantısı kopan oyuncu 5 sn sonra sahadan kalkar; takım boşalırsa hükmen biter', () => {
  const s = newGame({ a: 'red', b: 'blue', c: 'blue' });
  const ver = s.ver;
  game.onConnection(s, 'c', false);
  stepN(s, 4 * HZ);
  assert.equal(s.world.players.length, 3, '4 sn: hâlâ sahada');
  game.onConnection(s, 'c', true); // döndü
  stepN(s, 2 * HZ);
  assert.equal(s.world.players.length, 3);
  game.onConnection(s, 'c', false);
  const changed = stepN(s, 5 * HZ + 1);
  assert.ok(changed >= 1);
  assert.equal(s.world.players.length, 2);
  assert.ok(s.ver > ver);
  assert.equal(game.view(s, 'c').removed, true);
  assert.equal(game.view(s, 'c').myTeam, null);
  game.onPlayerLeave(s, 'a');
  assert.equal(s.phase, 'over');
  assert.equal(s.result.reason, 'forfeit');
  assert.equal(s.result.winner, 'blue');
});

test('girdi: kötü değerler oyunu bozmaz; izleyicinin girdisi yok sayılır; kare küçük', () => {
  const teams = { a: 'red', b: 'blue', c: 'red', d: 'blue', e: 'red', f: 'blue', g: 'red', h: 'blue', z: 'spec' };
  const s = newGame(teams);
  assert.equal(s.settings.size, 'medium');
  for (const msg of [{ x: NaN, y: 'a', k: {} }, { x: 1e300, y: -1e300, k: 1 }, { x: { valueOf: 1 }, y: [], k: 'true' }, {}]) {
    game.input(s, 'a', msg);
    game.input(s, 'z', msg);
    game.input(s, 'yok', msg);
    stepN(s, 5);
  }
  for (const d of s.world.players) assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
  assert.equal(s.world.players.length, 8);
  for (const id of Object.keys(teams)) game.input(s, id, { x: 1, y: 1, k: 1 });
  stepN(s, 120);
  const frame = JSON.stringify({ ...game.realtime.frame(s), t: 'frame', s: 123456 });
  assert.ok(frame.length < 1024, `kare ${frame.length} bayt`);
  assert.ok(frame.length < 300, `8 kişilik kare ${frame.length} bayt (beklenen ~200)`);
});
