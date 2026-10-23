// PoC: Vampir Köylü kural/kimlik zorlamaları + host kick ile öldürme + yan kanallar + TRUST_PROXY XFF.
// Çalıştır: node tests/security/poc-vampir-actions.mjs  (yerel sunucular başlatır)
import WebSocket from 'ws';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';

const srv = await startServer({ timeScale: 1 });
const report = (label, ok, extra = '') => console.log(`${ok ? 'GÜVENLİ ' : 'AÇIK    '} ${label}${extra ? ` — ${extra}` : ''}`);
const err = async (bot, action) => {
  const m = await Promise.race([bot.expectError(action, { timeout: 1500 }).catch(() => null), sleep(1600)]);
  return m?.message ?? null;
};

async function game(n = 8, settings = {}) {
  const room = await makeRoom(srv.wsUrl, 'vampir', n, 'V');
  room.host.send({ t: 'settings', settings: { nightSeconds: 120, dayMinutes: 8, defenseSeconds: 60, ...settings } });
  await room.host.waitRoom((r) => r.settings.nightSeconds === 120);
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'night')));
  const by = (r) => room.bots.filter((b) => b.view.me.role === r);
  return { ...room, by };
}
const aliveBots = (g) => g.bots.filter((b) => b.view.players.find((p) => p.id === b.playerId)?.alive);
async function finishNight(g, choose = {}) {
  const night = g.host.view.night;
  for (const b of aliveBots(g)) {
    const t = choose[b.playerId] ?? b.view.me.nightTargets.find((id) => id !== b.playerId) ?? b.view.me.nightTargets[0];
    b.action({ type: 'nightPick', targetId: t });
  }
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase !== 'night' || v.night > night)));
}

// ---------- 1) Kural zorlamaları ----------
{
  const g = await game(8);
  const [v1, v2] = g.by('vampir');
  const doc = g.by('doktor')[0];
  const seer = g.by('gozcu')[0];
  const vill = g.by('koylu')[0];

  // Gece ekranı yapısı: etkin düğme sayısı / kendine düğme rolden role farklı mı?
  for (const b of g.bots) {
    const me = b.view.me;
    console.log(`   gece etkin düğme: ${me.role.padEnd(7)} ${me.nightTargets.length}/${b.view.players.length}${me.nightTargets.includes(b.playerId) ? ' (kendisi etkin)' : ''}`);
  }

  report('vampir vampiri seçemez', !!(await err(v1, { type: 'nightPick', targetId: v2.playerId })));
  for (const bad of ['__proto__', 'constructor', 'toString', { toString: 1 }, ['x'], null, 12, '']) {
    report(`garip targetId ${JSON.stringify(bad)}`, !!(await err(vill, { type: 'nightPick', targetId: bad })));
  }
  report('gece aday/destek/oy reddi', !!(await err(vill, { type: 'nominate', targetId: v1.playerId })) && !!(await err(vill, { type: 'trialVote', yes: true })));
  report('host olmayan endDay', !!(await err(vill, { type: 'endDay' })));

  // Yan kanal: vampir seçimini değiştirdikçe herkes (köylü dahil) bir 'view' daha alır.
  const before = vill.messages.filter((m) => m.t === 'view').length;
  const targets = v1.view.me.nightTargets;
  for (let i = 0; i < 5; i++) v1.action({ type: 'nightPick', targetId: targets[i % targets.length] });
  await sleep(300);
  const extra = vill.messages.filter((m) => m.t === 'view').length - before;
  report('seçim değiştirme yan kanalı', extra === 0, `köylü, vampirin 5 seçim değişikliğinde ${extra} görünüm aldı (gece ilerleme sayısı değişmeden)`);

  // Gözcü ikinci bakış
  seer.action({ type: 'nightPick', targetId: v1.playerId });
  await seer.waitView((v) => v.me.seerResults?.length === 1);
  report('gözcü ikinci bakamaz', !!(await err(seer, { type: 'nightPick', targetId: vill.playerId })));

  // Doktor köylüyü korur, gece biter; ertesi gece aynı kişiyi koruyamamalı.
  await finishNight(g, { [doc.playerId]: vill.playerId, [v1.playerId]: vill.playerId, [v2.playerId]: vill.playerId, [seer.playerId]: v1.playerId });
  console.log(`   1. gece duyuru: ${JSON.stringify(g.host.view.announcement)}`);
  g.host.action({ type: 'endDay' });
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'night' && v.night === 2)));
  report('doktor aynı kişiyi üst üste koruyamaz', !!(await err(doc, { type: 'nightPick', targetId: vill.playerId })));

  // Ölü eylemi: 2. gece köylüyü öldür, sonra köylü bir şey denesin.
  await finishNight(g, { [v1.playerId]: vill.playerId, [v2.playerId]: vill.playerId, [doc.playerId]: seer.playerId });
  const dead = !g.host.view.players.find((p) => p.id === vill.playerId).alive;
  report('ölü aday gösteremez / destekleyemez', dead && !!(await err(vill, { type: 'nominate', targetId: v1.playerId })));

  // Günlük tek aday; aday kendi adayını destekleyemez; çift oy.
  const a = aliveBots(g).find((b) => b.view.me.role !== 'vampir');
  a.action({ type: 'nominate', targetId: v1.playerId });
  await a.waitView((v) => v.nomination);
  report('aday kendi adayını destekleyemez', !!(await err(a, { type: 'support' })));
  report('hedef kendini destekleyemez', !!(await err(v1, { type: 'support' })));
  report('aynı gün ikinci aday', !!(await err(a, { type: 'nominate', targetId: v2.playerId })));
  v2.action({ type: 'support' });
  await a.waitView((v) => v.phase === 'trial');
  report('başkası savunmayı bitiremez', !!(await err(a, { type: 'endDefense' })));
  v1.action({ type: 'endDefense' });
  await a.waitView((v) => v.phase === 'trialVote');
  a.action({ type: 'trialVote', yes: true });
  await a.waitView((v) => v.trial?.myVote === true);
  report('çift oy', !!(await err(a, { type: 'trialVote', yes: false })));
  report('ölü oy veremez', !!(await err(vill, { type: 'trialVote', yes: true })));
  report('aday kendine oy veremez', !!(await err(v1, { type: 'trialVote', yes: false })));
  g.bots.forEach((b) => b.close());
}

// ---------- 2) Host kick ile oyun içinde öldürme ----------
{
  const g = await game(5, { doktor: false, gozcu: false, deli: false }); // 1 vampir, 4 köylü
  const host = g.host;
  const hostRole = host.view.me.role;
  const victims = g.bots.filter((b) => b !== host && b.view.me.role !== 'vampir');
  const k = victims[0];
  host.send({ t: 'kick', playerId: k.playerId });
  await host.waitView((v) => !v.players.find((p) => p.id === k.playerId).alive);
  const p = host.view.players.find((x) => x.id === k.playerId);
  report('host oyun sırasında kick ile oyuncu öldüremez', false, `host(${hostRole}) ${k.name} adlı köylüyü kickledi → death=${JSON.stringify(p.death)}`);
  // İkinci kick: vampir host ise 1 vampir vs 2 köylü → üçüncü kick ile kazanır.
  host.send({ t: 'kick', playerId: victims[1].playerId });
  host.send({ t: 'kick', playerId: victims[2].playerId });
  await sleep(300);
  console.log(`   3 kick sonrası: phase=${host.view.phase} winner=${host.view.result?.winner ?? '-'} (host rolü ${hostRole})`);

  // Kicklenen oyuncu izleyici olarak geri gelir: kendi rolünü hâlâ görür (beklenen), başkasını görmemeli.
  await k.join(g.code);
  const kv = await k.waitView(() => true);
  const leak = JSON.stringify(kv).match(/"role":"(\w+)"/g);
  console.log(`   geri gelen izleyici view.me: ${JSON.stringify(kv.me)?.slice(0, 120)}; rol alanları: ${leak}`);
  g.bots.forEach((b) => b.close());
}

// ---------- 3) Ölü vampir gece müttefik seçimlerini görmeye devam eder mi? ----------
{
  const g = await game(8, { vampires: 2 });
  const [v1, v2] = g.by('vampir');
  // v1'i gündüz astır
  await finishNight(g, { [v1.playerId]: g.by('koylu')[0].playerId, [v2.playerId]: g.by('koylu')[0].playerId });
  const nominator = aliveBots(g).find((b) => b !== v1 && b !== v2);
  const supporter = aliveBots(g).find((b) => b !== v1 && b !== nominator);
  nominator.action({ type: 'nominate', targetId: v1.playerId });
  await supporter.waitView((v) => v.nomination);
  supporter.action({ type: 'support' });
  await v1.waitView((v) => v.phase === 'trial');
  v1.action({ type: 'endDefense' });
  await nominator.waitView((v) => v.phase === 'trialVote');
  for (const b of aliveBots(g)) if (b !== v1) b.action({ type: 'trialVote', yes: true });
  await v1.waitView((v) => v.phase === 'night' || v.phase === 'over');
  if (v1.view.phase === 'night') {
    const t = (await v2.waitView((v) => v.phase === "night" && v.me.nightTargets)).me.nightTargets[0];
    v2.action({ type: 'nightPick', targetId: t });
    const vv = await v1.waitView((v) => v.me.allyPicks && Object.keys(v.me.allyPicks).length);
    report('ölü vampir gece olaylarını görmez (§4.3 "Ölüler")', false, `ölü v1 allyPicks=${JSON.stringify(vv.me.allyPicks)}`);
  } else console.log('   (oyun bitti, test atlandı)');
  g.bots.forEach((b) => b.close());
}
await srv.stop();

// ---------- 4) TRUST_PROXY=1 iken X-Forwarded-For ile IP sınırını atlatma ----------
{
  const s2 = await startServer({ env: { TRUST_PROXY: '1', LIMIT_SOCKETS_PER_IP: '2' } });
  const open = (xff) => new Promise((res) => {
    const ws = new WebSocket(s2.wsUrl, { headers: xff ? { 'X-Forwarded-For': xff } : {} });
    ws.once('open', () => res(ws)); ws.once('error', () => res(null)); ws.once('unexpected-response', () => res(null));
  });
  const same = await Promise.all([1, 2, 3, 4].map(() => open('10.0.0.1')));
  const spoof = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => open(`1.2.3.${i}, 10.0.0.1`)));
  report('TRUST_PROXY: XFF ilk öğesi sahte olamaz', spoof.filter(Boolean).length <= 2,
    `aynı XFF ile 4 denemede ${same.filter(Boolean).length} açıldı (sınır 2); sahte ilk-öğe ile 6 denemede ${spoof.filter(Boolean).length} açıldı`);
  [...same, ...spoof].forEach((w) => w?.terminate());
  await s2.stop();
}
process.exit(0);
