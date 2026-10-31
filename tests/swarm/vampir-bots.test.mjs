// Lobi botları (game.bots kancası, PLAN.md §3.8) + 🧛 Vampir botları: host ekler/çıkarır, yetki, üst sınır,
// kalıcılık yok, tek insan + 5 botla oyun sonuna kadar, lobiye dönüşte kalırlar, oda kapanınca zamanlayıcılar durur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../lib/server.js';
import { Bot, sleep } from '../lib/bot.js';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.01 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const stats = async () => (await fetch(`${srv.url}/api/_test/stats`)).json();
async function human(name) {
  const b = await new Bot(srv.wsUrl, name).connect();
  all.push(b);
  return b;
}
async function addBots(host, n) {
  for (let i = 0; i < n; i++) {
    const before = host.room.players.length;
    host.send({ t: 'addBot' });
    await host.waitRoom((r) => r.players.length === before + 1);
  }
  return host.room.players.filter((p) => p.bot);
}
const errorAfter = (b, msg) => {
  const p = b.waitFor((m) => m.t === 'error');
  b.send(msg);
  return p;
};

test('host bot ekler/çıkarır; botlar işaretli, bağlı, benzersiz', async () => {
  const host = await human('Erdem');
  await host.create('vampir');
  assert.equal(host.room.bots, true);
  const bots = await addBots(host, 4);
  assert.equal(bots.length, 4);
  for (const b of bots) {
    assert.match(b.id, /^bot-[0-9a-f]{16}$/);
    assert.ok(b.name.startsWith('🤖 Bot '), b.name);
    assert.equal(b.connected, true);
    assert.equal(b.isHost, false);
  }
  assert.equal(new Set(bots.map((b) => b.name)).size, 4);
  assert.equal(new Set(bots.map((b) => b.id)).size, 4);
  host.send({ t: 'removeBot', playerId: bots[0].id });
  const r = await host.waitRoom((x) => x.players.length === 4);
  assert.ok(!r.players.some((p) => p.id === bots[0].id));
  // removeBot gerçek oyuncu için çalışmaz
  const e = await errorAfter(host, { t: 'removeBot', playerId: host.playerId });
  assert.match(e.message, /bot yok/);
  host.leave();
});

test('host olmayan bot ekleyemez/çıkaramaz', async () => {
  const host = await human('Host');
  const guest = await human('Misafir');
  const code = await host.create('vampir');
  await guest.join(code);
  const [bot] = await addBots(host, 1);
  assert.match((await errorAfter(guest, { t: 'addBot' })).message, /oda sahibi/);
  assert.match((await errorAfter(guest, { t: 'removeBot', playerId: bot.id })).message, /oda sahibi/);
  await sleep(50);
  assert.equal(host.room.players.length, 3);
  host.leave(); guest.leave();
});

test('botlar maxPlayers ile sınırlı ve oyuncu sayısına dahil', async () => {
  const host = await human('Dolu');
  const code = await host.create('vampir');
  await addBots(host, 11);
  assert.equal(host.room.players.length, 12);
  assert.match((await errorAfter(host, { t: 'addBot' })).message, /dolu/);
  const late = await human('Geç');
  late.send({ t: 'join', code });
  assert.match((await late.waitFor((m) => m.t === 'error')).message, /dolu/);
  host.leave();
});

test('bot kancası olmayan oyunda bot eklenemez', async () => {
  const host = await human('Casus');
  await host.create('spyfall');
  assert.equal(host.room.bots, false);
  assert.match((await errorAfter(host, { t: 'addBot' })).message, /bot yok/);
  host.leave();
});

test('botlar kimliklere yazılmaz, bot id ile hello sahiplenemez, 🤖 adı alınamaz', async () => {
  const host = await human('Kalıcı');
  await host.create('vampir');
  const bots = await addBots(host, 3);
  await sleep(800); // jsonStore 500 ms gecikmeli yazar
  const file = join(srv.dataDir, 'identities.json');
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const b of bots) assert.ok(!text.includes(b.id), 'bot id kimlik dosyasında');
    assert.ok(!text.includes('🤖'), 'bot adı kimlik dosyasında');
  }
  const thief = new Bot(srv.wsUrl, '🤖 Bot Hüsnü');
  thief.playerId = bots[0].id;
  thief.token = 'x';
  await thief.connect();
  all.push(thief);
  assert.notEqual(thief.playerId, bots[0].id);
  assert.ok(!thief.name.includes('🤖'), thief.name);
  const s = await stats();
  assert.ok(s.bots >= 3);
  host.leave();
});

// İnsan basitçe oynar: gece ilk hedef, savunmayı bitirir, oylamada evet.
function autoplay(b) {
  let lastKey = '';
  b.taps.push((m) => {
    if (m.t !== 'view' || !m.view?.me?.alive) return;
    const v = m.view;
    const key = `${v.phase}:${v.night}:${v.trial?.targetId ?? ''}:${v.lastTrial ? 1 : 0}`;
    if (key === lastKey) return;
    if (v.phase === 'night' && !v.me.nightPick && v.me.nightTargets?.length) { lastKey = key; b.action({ type: 'nightPick', targetId: v.me.nightTargets[0] }); }
    if (v.phase === 'trial' && v.trial.targetId === b.playerId) { lastKey = key; b.action({ type: 'endDefense' }); }
    if (v.phase === 'trialVote' && v.trial.targetId !== b.playerId && v.trial.myVote == null) { lastKey = key; b.action({ type: 'trialVote', yes: true }); }
  });
}

test('1 insan + 5 bot: oyun "over"a ulaşır, roller sızmaz, botlar lobiye dönüşte kalır', async () => {
  const host = await human('Tek');
  await host.create('vampir');
  await addBots(host, 5);
  host.send({ t: 'settings', settings: { dayMinutes: 2, nightSeconds: 30, defenseSeconds: 15 } });
  await host.waitRoom((r) => r.settings.dayMinutes === 2);
  autoplay(host);
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'night');
  assert.equal(host.view.players.length, 6);
  await host.waitView((v) => v.phase !== 'night' || v.nightProgress.done >= 5, { timeout: 5000 }); // botlar seçti
  const over = await host.waitView((v) => v.phase === 'over', { timeout: 90_000 });
  assert.ok(['town', 'vampires', 'jester'].includes(over.result.winner));
  // Oyun bitmeden hiçbir mesajda başkasının rolü yok
  for (const m of host.messages) {
    if (m.t === 'view' && m.view && !m.view.result) {
      assert.ok(m.view.players.every((p) => !('role' in p)));
    }
    if (m.t === 'room' && m.room) assert.ok(m.room.players.every((p) => !('role' in p)));
  }
  // Oyun bitti: bot zamanlayıcıları temiz
  await sleep(50);
  assert.equal((await stats()).botTimers, 0);

  host.send({ t: 'backToLobby' });
  const lobby = await host.waitRoom((r) => r.phase === 'lobby');
  assert.equal(lobby.players.filter((p) => p.bot).length, 5);
  // Tekrar başlatılabilir
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'night' && v.night === 1, { timeout: 5000 });
  assert.equal(host.room.phase, 'playing');
  // Bot oyunda kick ile atılamaz, removeBot oyunda reddedilir
  const botId = host.room.players.find((p) => p.bot).id;
  assert.match((await errorAfter(host, { t: 'kick', playerId: botId })).message, /sadece bağlantısı kopmuş/);
  assert.match((await errorAfter(host, { t: 'removeBot', playerId: botId })).message, /bekleme odasında/);

  // İnsan çıkınca oda (sadece botlar kalır) kapanır ve bot zamanlayıcıları durur
  const before = await stats();
  assert.ok(before.botTimers > 0 || before.bots > 0);
  host.leave();
  await sleep(100);
  const s = await stats();
  assert.equal(s.botTimers, 0);
  assert.equal(s.bots, before.bots - 5);
});

test('insan bağlantısı kopunca botlar host olmaz, oda boş sayılır', async () => {
  const host = await human('Kopan');
  await host.create('vampir');
  await addBots(host, 4);
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'night');
  host.drop();
  await sleep(300); // hostHandoffMs 15 sn * 0.01
  await host.connect();
  const room = await host.waitFreshRoom(() => true);
  assert.equal(room.hostId, host.playerId, 'host bir bota geçmemeli');
  assert.ok(room.players.filter((p) => p.bot).every((p) => p.connected));
  host.leave();
});
