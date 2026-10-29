// ⚽ Tosun Top kötüye kullanım sürüsü: lobbyAction suistimali, girdi/ping selleri, adalet (spam yapan daha hızlı koşmaz),
// karelerin kime gittiği (ayrılan/taşınan/atılan/değiştirilen sekme), sıra/adım tekdüzeliği, kopma–dönüş sınırı.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';
import { Bot } from '../lib/bot.js';
import { setupMatch, myDisc, stats, sleep } from './haxball-lib.mjs';
import { createWorld, setInput, step } from '../../public/haxball-physics.js';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.1 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });
const track = (g) => { all.push(...g.bots); return g; };

// Hata gelirse { t:'error' }, 600 ms içinde gelmezse { t:'none' } (arada uçuşan oda yayınları sayılmaz).
async function lobbyErr(bot, data) {
  const p = bot.waitFor((m) => m.t === 'error', { timeout: 600 }).catch(() => ({ t: 'none' }));
  bot.send({ t: 'lobbyAction', data });
  return p;
}

test('lobbyAction suistimali: geçersiz takım, başkası adına seçim, host olmayan karıştırma, oyun sırasında seçim', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { teams: ['red', 'blue', 'red'], start: false }));
  const [host, b, c] = g.bots;
  const before = JSON.stringify(host.room.prep.teams);
  for (const data of [
    { type: 'team', team: 'green' }, { type: 'team', team: '__proto__' }, { type: 'team', team: 1 },
    { type: 'team', team: { a: 1 } }, { type: 'team' }, { type: 'nuke' }, {}, { type: ['team'], team: 'red' },
  ]) {
    const m = await lobbyErr(b, data);
    assert.equal(m.t, 'error', `${JSON.stringify(data)} reddedilmeli`);
  }
  assert.equal(JSON.stringify(b.room.prep.teams), before, 'reddedilen seçimler prep değiştirmemeli');
  for (const raw of [{ t: 'lobbyAction' }, { t: 'lobbyAction', data: 'team' }, { t: 'lobbyAction', data: ['team', 'red'] }, { t: 'lobbyAction', data: null }]) {
    const p = b.waitFor((m) => m.t === 'error');
    b.send(raw);
    assert.equal((await p).code, 'game');
  }
  // başkası adına: playerId/id alanları yok sayılır, sadece kendi takımı değişir
  b.send({ t: 'lobbyAction', data: { type: 'team', team: 'blue', playerId: c.playerId, id: c.playerId } });
  b.send({ t: 'lobbyAction', data: { type: 'team', team: 'spec', playerId: host.playerId } });
  const r = await host.waitRoom((x) => x.prep.teams[b.playerId] === 'spec');
  assert.equal(r.prep.teams[c.playerId], 'red');
  assert.equal(r.prep.teams[host.playerId], 'red');
  // host olmayan karıştırma
  assert.equal((await lobbyErr(c, { type: 'shuffle' })).t, 'error');
  // izleyici (spec) karıştırmada izleyici kalır
  host.send({ t: 'lobbyAction', data: { type: 'shuffle' } });
  const sh = await host.waitRoom((x) => x !== r && x.prep.teams[b.playerId] === 'spec' && x.prep.teams[c.playerId] !== undefined);
  assert.equal(sh.prep.teams[b.playerId], 'spec');
  assert.notEqual(sh.prep.teams[host.playerId], sh.prep.teams[c.playerId]);
  await sleep(5100); // hız penceresi sıfırlansın
  // oyun sırasında: takım seçimi reddedilir, prep değişmez; izleyici (spec) diski yok, girdisi etkisiz
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'kickoff');
  const m = await lobbyErr(b, { type: 'team', team: 'red' });
  assert.equal(m.t, 'error');
  assert.equal((await lobbyErr(host, { type: 'shuffle' })).t, 'error');
  assert.equal(b.view.myTeam, null);
  assert.equal(host.view.discs.length, 2);
  b.input(1, 1, true);
  b.action({ type: 'debugPlace', ball: { x: 0, y: 0 }, me: { x: 0, y: 0 } });
  await sleep(200);
  assert.equal(host.view.discs.length, 2, 'spec oyuncu sahaya giremez');
  // oyun ortası katılan izleyici lobbyAction ile sahaya giremez
  const late = new Bot(srv.wsUrl, 'Late');
  all.push(late);
  await late.connect();
  await late.join(g.code);
  assert.equal((await lobbyErr(late, { type: 'team', team: 'blue' })).t, 'error');
  late.input(1, 0, true);
  await sleep(150);
  assert.equal(host.view.discs.length, 2);
  g.bots.forEach((x) => x.leave()); late.leave();
});

test('lobbyAction seli: genel sınır uygulanır (30 / 5 sn düşer, 120 kapatır), oda diğerleri için çalışır', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { start: false, prefix: 'Spam' }));
  const [host, spammer, other] = g.bots;
  for (let i = 0; i < 100; i++) spammer.send({ t: 'lobbyAction', data: { type: 'team', team: i % 2 ? 'red' : 'blue' } });
  await sleep(400);
  assert.ok(spammer.isOpen, '100 < 120: kapanmamalı');
  assert.ok(spammer.errors.some((e) => e.code === 'rate'));
  // diğerlerine kaç oda yayını gitti? (yükseltme: en fazla ~30)
  const rooms = other.messages.filter((m) => m.t === 'room').length;
  assert.ok(rooms < 45, `spam diğerlerine ${rooms} yayın üretti`);
  for (let i = 0; i < 30; i++) spammer.send({ t: 'lobbyAction', data: { type: 'team', team: 'red' } });
  await spammer.waitFor(() => false, { timeout: 500 }).catch(() => {});
  assert.equal(spammer.closed?.code, 1008);
  other.send({ t: 'lobbyAction', data: { type: 'team', team: 'blue' } });
  await host.waitRoom((r) => r.prep.teams[other.playerId] === 'blue');
  g.bots.forEach((x) => x.leave());
});

test('girdi: hello öncesi / odasız / lobide / izleyici — yok sayılır, lobideki girdi sonraki maça taşınmaz', async () => {
  const lone = new Bot(srv.wsUrl, 'Lone');
  all.push(lone);
  await lone.connect();
  for (let i = 0; i < 50; i++) lone.input(1, 0, true);
  lone.sendRaw({ t: 'ping', c: 1 });
  const pong = await lone.waitFor((m) => m.t === 'pong', { timeout: 400 }).catch(() => null);
  assert.equal(pong, null, 'odasız ping yanıtlanmaz (sadece oynanan odada)');
  assert.equal(lone.errors.length, 0);
  lone.close();

  const g = track(await setupMatch(srv.wsUrl, 2, { start: false, prefix: 'Lob' }));
  for (let i = 0; i < 60; i++) g.bots.forEach((b) => b.input(1, 0, true));
  await sleep(100);
  g.host.send({ t: 'start' });
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'kickoff')));
  const f0 = await g.bots[0].waitFrame((f) => f.k >= 2);
  await sleep(400);
  const f1 = g.bots[0].frame;
  assert.deepEqual(f1.p, f0.p, 'lobide gönderilen girdi maç başında diskleri oynatmamalı');
  assert.deepEqual(g.bots.map((b) => b.errors.filter((e) => e.code !== 'game').length), [0, 0]);
  g.bots.forEach((b) => b.leave());
});

test('ping/girdi karışık sel: ~550/sn açık kalır ve saniyede ≤ 64 işlenir; ~1000/sn 1008 ile kapanır', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Fl' }));
  const [a, b] = g.bots;
  let pongs = 0;
  a.taps.push((m) => { if (m.t === 'pong') pongs++; });
  // 3 sn boyunca her 50 ms'de 27 mesaj (≈ 540/sn), yarısı ping
  for (let t = 0; t < 60; t++) {
    for (let i = 0; i < 27; i++) a.sendRaw(i % 2 ? { t: 'ping', c: t * 100 + i } : { t: 'input', x: 0, y: 1, k: 0 });
    await sleep(50);
  }
  await sleep(200);
  assert.ok(a.isOpen, `~540/sn kapatmamalı (kapanış ${JSON.stringify(a.closed)})`);
  assert.ok(pongs <= 64 * 4, `pong sayısı ${pongs} (≤ 64/sn × ~3.5 sn)`);
  assert.ok(pongs > 20, `bazı pinglere yanıt gelmeli (${pongs})`);
  // Sel: tek pencerede 1000 mesaj
  await sleep(1100);
  for (let i = 0; i < 1000; i++) a.sendRaw(i % 2 ? { t: 'ping', c: i } : { t: 'input', x: 1, y: 0, k: 1 });
  await a.waitFor(() => false, { timeout: 1000 }).catch(() => {});
  assert.equal(a.closed?.code, 1008);
  const n = b.frameCount;
  await sleep(300);
  assert.ok(b.frameCount - n >= 7, 'diğer oyuncu kare almaya devam etmeli');
  b.leave();
});

test('büyük/bozuk mesajlar: > 8 KB kapanır (1009), 257 baytlık girdi normal yoldan, ikili mesaj 1003', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { prefix: 'Big', teams: ['red', 'blue', 'red'] }));
  const [a, b, c] = g.bots;
  const pad = 'x'.repeat(256 - JSON.stringify({ t: 'input', x: 1, y: 0, k: 0, p: '' }).length);
  a.sendRaw(JSON.stringify({ t: 'input', x: 1, y: 0, k: 0, p: pad })); // tam 256: hızlı yol, hata yok
  a.sendRaw(JSON.stringify({ t: 'input', x: 1, y: 0, k: 0, p: `${pad}y` })); // 257: normal yol → bilinmeyen
  const e = await a.waitFor((m) => m.t === 'error');
  assert.equal(e.code, 'unknown');
  assert.equal(a.errors.length, 1, '256 baytlık girdi hata üretmemeli');
  // Çok baytlı karakter: ~250 karakter ama ~450 bayt — hızlı yol bayt sayar → normal yol (bilinmeyen mesaj)
  a.sendRaw(JSON.stringify({ t: 'input', x: 1, y: 0, k: 0, p: 'ğ'.repeat(200) }));
  await sleep(100);
  b.ws.send('{"t":"input","x":1,"pad":"' + 'z'.repeat(9000) + '"}');
  c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  await sleep(300);
  assert.equal(b.closed?.code, 1009);
  assert.equal(c.closed?.code, 1003);
  assert.ok(a.isOpen);
  const n = a.frameCount;
  await sleep(200);
  assert.ok(a.frameCount > n);
  a.leave();
});

test('adalet: 500/sn girdi gönderen, 20 Hz gönderenden hızlı koşmaz', async () => {
  const g = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Fair' }));
  const [spam, calm] = g.bots;
  // İkisini de kendi yarısında, aynı y'de koy; ikisi de aşağı (+y) koşar
  spam.action({ type: 'debugPlace', ball: { x: 0, y: -150 }, me: { x: -200, y: -150 } });
  calm.action({ type: 'debugPlace', me: { x: 200, y: -150 } });
  await sleep(100);
  const p0 = [myDisc(spam), myDisc(calm)];
  const t0 = Date.now();
  const spamTimer = setInterval(() => { for (let i = 0; i < 25; i++) spam.input(0, 1, false); }, 50);
  const calmTimer = setInterval(() => calm.input(0, 1, false), 50);
  spam.input(0, 1, false); calm.input(0, 1, false);
  await sleep(900);
  clearInterval(spamTimer); clearInterval(calmTimer);
  const p1 = [myDisc(spam), myDisc(calm)];
  void t0;
  const dy = [p1[0].y - p0[0].y, p1[1].y - p0[1].y];
  console.log(`# adalet: spam Δy=${dy[0].toFixed(1)} sakin Δy=${dy[1].toFixed(1)}`);
  assert.ok(dy[1] > 50, 'sakin oyuncu koşmalı');
  assert.ok(dy[0] <= dy[1] * 1.05 + 2, `spam daha hızlı koştu: ${dy[0]} vs ${dy[1]}`);
  // Spam yapan, 64/sn sınırı yüzünden yön değişimini kaçırmamalı mı? (pencere dolunca sonraki girdiler düşer)
  // 1 sn içinde 64'ü aşan spam'den sonra yön değişikliği bir sonraki pencereye kadar işlenmez: ölç
  await sleep(1100);
  for (let i = 0; i < 70; i++) spam.input(0, 1, false);
  spam.input(0, -1, false); // yön değişimi
  await sleep(400);
  const vy = myDisc(spam).y;
  await sleep(200);
  const goingUp = myDisc(spam).y < vy;
  console.log(`# 64/sn penceresi dolduktan sonra yön değişimi ${goingUp ? 'işlendi' : 'pencere bitene kadar düştü'}`);
  // Bekletilen son girdi pencere sıfırlanınca uygulanır: en geç ~1 sn içinde yukarı koşmalı
  await sleep(900);
  const y1 = myDisc(spam).y;
  await sleep(250);
  assert.ok(myDisc(spam).y < y1 - 3, 'pencere sıfırlanınca bekletilen yön değişimi uygulanmalı');
  g.bots.forEach((b) => b.leave());
});

test('fizik: şut tuşunu her adımda aç/kapa yapan, basılı tutandan sık şut çekemez', () => {
  const count = (toggle) => {
    const w = createWorld('small', [{ id: 'a', team: 0 }]);
    w.kickoff = null;
    const d = w.players[0];
    let kicks = 0;
    for (let t = 0; t < 600; t++) {
      d.x = -40; d.y = 0; d.vx = 0; d.vy = 0;
      w.ball.x = -40 + 15 + 10 + 2; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
      // aynı adım içinde çok girdi: sadece son değer geçerli
      if (toggle) { setInput(d, 0, 0, false); setInput(d, 0, 0, true); setInput(d, 0, 0, t % 2 === 0); } else setInput(d, 0, 0, true);
      kicks += step(w).kicks;
    }
    return kicks;
  };
  const held = count(false);
  const toggled = count(true);
  assert.ok(held <= 600 / 12 + 1, `basılı: ${held}`);
  assert.ok(toggled <= held, `aç/kapa ${toggled} > basılı ${held}`);
});

test('kareler kime gider: ayrılan, başka odaya geçen, atılan, sekmesi değiştirilen oyuncuya kare gitmez', async () => {
  const g = track(await setupMatch(srv.wsUrl, 6, { prefix: 'Who', settings: { goals: 0, minutes: 5 } }));
  const [host, leaver, mover, kicked, tabbed, stay] = g.bots;
  const other = track(await setupMatch(srv.wsUrl, 2, { prefix: 'Oth', start: false }));
  // ayrılan
  leaver.leave();
  // başka (lobi) odaya geçen
  await mover.join(other.code);
  // atılan: önce kopar (oyun sırasında sadece kopuklar atılabilir), host atar, sonra aynı kimlikle döner
  kicked.drop();
  await host.waitRoom((r) => r.players.some((p) => p.id === kicked.playerId && !p.connected));
  host.send({ t: 'kick', playerId: kicked.playerId });
  await host.waitRoom((r) => !r.players.some((p) => p.id === kicked.playerId));
  await kicked.connect();
  // ikinci sekme: aynı kimlikle yeni bağlantı, eski sekme 'replaced'
  const tab2 = new Bot(srv.wsUrl, tabbed.name);
  all.push(tab2);
  tab2.playerId = tabbed.playerId; tab2.token = tabbed.token;
  await tab2.connect();
  await tab2.waitFrame(() => true);
  await sleep(150);
  const counts = () => [leaver, mover, kicked, tabbed].map((b) => b.frameCount);
  const c0 = counts();
  const s0 = [stay.frameCount, tab2.frameCount];
  await sleep(800);
  assert.deepEqual(counts(), c0, 'ayrılan/taşınan/atılan/eski sekme kare almamalı');
  assert.ok(stay.frameCount - s0[0] >= 20);
  assert.ok(tab2.frameCount - s0[1] >= 20, 'yeni sekme kare almalı');
  assert.equal(tabbed.closed?.code, 4000);
  // Diğer oda (lobi) hiç kare almadı
  assert.deepEqual(other.bots.map((b) => b.frameCount), [0, 0]);
  // tab2'nin diski korunmuş olmalı
  assert.ok(tab2.view.discs.some((d) => d.id === tabbed.playerId));
  assert.equal(tab2.view.removed, false);
  [...g.bots, tab2, ...other.bots].forEach((b) => b.leave());
});

test('sıra/adım: sağlıklı istemcide s her karede +1, k +2 (boşluk yok) — 4 oda paralel', async () => {
  const games = [];
  for (let i = 0; i < 4; i++) games.push(track(await setupMatch(srv.wsUrl, 2 + i * 2, { prefix: `Sq${i}`, settings: { goals: 0, minutes: 5 } })));
  const issues = [];
  const gaps = { s: 0, k: 0 };
  for (const g of games) for (const b of g.bots) {
    let last = null;
    b.taps.push((m) => {
      if (m.t !== 'frame') return;
      if (last) {
        if (m.s !== last.s + 1) { gaps.s++; if (m.s <= last.s) issues.push(`${b.name} s ${last.s}→${m.s}`); }
        if (m.k !== last.k + 2) { gaps.k++; if (m.k <= last.k) issues.push(`${b.name} k ${last.k}→${m.k}`); }
        if (b.view && m.v === b.view.ver && m.p.length !== b.view.discs.length * 2) issues.push(`${b.name} p uzunluğu`);
      }
      last = m;
    });
  }
  const timers = games.flatMap((g) => g.bots.map((b, i) => setInterval(() => b.input(Math.cos(Date.now() / 300 + i), Math.sin(Date.now() / 300 + i), i % 3 === 0), 50)));
  await sleep(4000);
  timers.forEach(clearInterval);
  const total = games.flatMap((g) => g.bots).reduce((n, b) => n + b.frameCount, 0);
  console.log(`# sıra: ${total} kare, s boşluğu ${gaps.s}, k boşluğu (yetişme adımı) ${gaps.k}`);
  assert.deepEqual(issues, []);
  assert.equal(gaps.s, 0, 'sağlıklı sokete kare atlanmamalı');
  games.forEach((g) => g.bots.forEach((b) => b.leave()));
});

test('kopma: tüm takım kopar → saat durur, hükmen yok; 4.3 sn sonra dönen diskini korur; açık ayrılmada hükmen', async () => {
  const g = track(await setupMatch(srv.wsUrl, 3, { teams: ['red', 'blue', 'red'], prefix: 'Rc', settings: { goals: 0, minutes: 5 } }));
  const [r1, blue, r2] = g.bots;
  blue.action({ type: 'debugPlace', ball: { x: 0, y: -150 } }); // başlama vuruşu bitsin, saat işlesin
  await blue.waitView((x) => x.phase === 'play');
  r1.drop(); r2.drop();
  const paused = await blue.waitView((x) => x.paused, { timeout: 2000 });
  assert.equal(paused.offline.length, 2);
  const c0 = blue.frame.c;
  await sleep(3000);
  assert.equal(blue.frame.c, c0, 'kırmızının bağlı kimsesi yokken saat durmalı');
  await r2.connect();
  await sleep(2600); // r1 5 sn'yi aştı: eskiden diski kalkardı
  const v = await blue.waitView((x) => !x.paused, { timeout: 2000 });
  assert.notEqual(v.phase, 'over', 'kırmızıda bir kişi döndü: hükmen olmamalı');
  assert.equal(v.discs.length, 3, 'kopuk r1 diski donuk bekler');
  assert.ok(v.offline.includes(r1.playerId));
  await r1.connect();
  const rv = await r1.waitFreshView();
  assert.equal(rv.removed, false);
  assert.equal(rv.myTeam, 'red', '20 sn içinde dönen oyuncu diskini geri alır');
  // mavi 4.3 sn kopuk kalır
  blue.drop();
  await sleep(4300);
  await blue.connect();
  await sleep(300);
  const bv = await blue.waitFreshView();
  assert.notEqual(bv.phase, 'over');
  assert.ok(bv.discs.some((d) => d.id === blue.playerId), '4.3 sn içinde dönen mavi diskini korumalı');
  // açık ayrılma: mavi takım boşalır → hükmen
  blue.leave();
  const ov = await r2.waitView((x) => x.phase === 'over', { timeout: 3000 });
  assert.equal(ov.result.reason, 'forfeit');
  assert.equal(ov.result.winner, 'red');
  await sleep(100);
  assert.equal((await stats(srv.url)).loops, 0);
  [r1, r2].forEach((x) => x.leave());
});

test('dış soket: hello öncesi 1000 girdi → 1008, sunucu ayakta', async () => {
  const ws = new WebSocket(srv.wsUrl);
  await new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  for (let i = 0; i < 1000; i++) ws.send('{"t":"input","x":1,"y":0,"k":1}');
  assert.equal(await closed, 1008);
  const s = await stats(srv.url);
  assert.ok(s.rooms >= 0);
});
