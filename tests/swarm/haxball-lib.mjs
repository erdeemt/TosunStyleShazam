// ⚽ Tosun Top sürü testleri için ortak yardımcılar: oda kur + takım seç + başlat, basit "topa koş, kaleye vur" beyni.
import { makeRoom, sleep } from '../lib/bot.js';
import { PITCHES, PHYS } from '../../public/haxball-physics.js';

export { sleep };

// teams: her bot için 'red' | 'blue' | 'spec' (verilmezse sırayla kırmızı/mavi).
export async function setupMatch(wsUrl, n, { teams, settings = {}, prefix = 'Top', start = true } = {}) {
  const room = await makeRoom(wsUrl, 'haxball', n, prefix);
  const want = teams ?? room.bots.map((_, i) => (i % 2 ? 'blue' : 'red'));
  room.bots.forEach((b, i) => b.send({ t: 'lobbyAction', data: { type: 'team', team: want[i] } }));
  await room.host.waitRoom((r) => room.bots.every((b, i) => r.prep?.teams?.[b.playerId] === want[i]));
  if (Object.keys(settings).length) {
    room.host.send({ t: 'settings', settings });
    await room.host.waitRoom((r) => Object.entries(settings).every(([k, v]) => r.settings[k] === v));
  }
  if (start) await startMatch(room);
  return { ...room, teams: want };
}

export async function startMatch(room) {
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'kickoff' || v.phase === 'play', { timeout: 8000 })));
  await Promise.all(room.bots.map((b) => b.waitFrame(() => true, { timeout: 5000 })));
}

// Botun kendi diski (son kareden): { x, y } veya null.
export function myDisc(bot) {
  const v = bot.view;
  const f = bot.frame;
  if (!v || !f || f.v !== v.ver) return null;
  const i = v.discs.findIndex((d) => d.id === bot.playerId);
  if (i < 0) return null;
  return { x: f.p[2 * i] / 10, y: f.p[2 * i + 1] / 10, i };
}

// Basit yapay zekâ: topun arkasına (rakip kaleye göre) geç, sonra kaleye doğru it ve vur. 50 ms'de bir girdi.
export function startBrain(bot, { everyMs = 50 } = {}) {
  const R = PHYS.playerRadius + PHYS.ballRadius;
  const timer = setInterval(() => {
    const v = bot.view;
    const f = bot.frame;
    if (!v || !f || v.phase === 'over' || !v.myTeam) return;
    const me = myDisc(bot);
    if (!me) return;
    const P = PITCHES[v.pitch];
    const bx = f.b[0] / 10;
    const by = f.b[1] / 10;
    const gx = (v.myTeam === 'red' ? 1 : -1) * (P.w + 20);
    let ux = gx - bx;
    let uy = -by;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    const tx = bx - ux * (R + 4);
    const ty = by - uy * (R + 4);
    const dx = tx - me.x;
    const dy = ty - me.y;
    const dl = Math.hypot(dx, dy) || 1;
    const toBall = Math.hypot(bx - me.x, by - me.y);
    const front = (me.x - bx) * ux + (me.y - by) * uy > 0; // topla kale arasındayım
    let ix;
    let iy;
    let kick = false;
    if (!front && (dl < 14 || toBall < R + 6)) { ix = ux; iy = uy; kick = toBall < R + 6; } else if (front && toBall < R + 30) {
      // topun önündeyim: yana kaç, arkasına dolaş
      const side = (me.x - bx) * -uy + (me.y - by) * ux >= 0 ? 1 : -1;
      ix = -uy * side - ux * 0.6; iy = ux * side - uy * 0.6;
      const l = Math.hypot(ix, iy); ix /= l; iy /= l;
    } else { ix = dx / dl; iy = dy / dl; }
    bot.input(ix, iy, kick);
  }, everyMs);
  return () => clearInterval(timer);
}

export async function stats(url) {
  const res = await fetch(`${url}/api/_test/stats`);
  return res.json();
}

// Kare sırası bozulmamalı: s ve k artan, p uzunluğu görünümle tutarlı, tüm sayılar sonlu.
export function frameChecker(bot, errors) {
  let lastS = 0;
  let lastK = -1;
  bot.taps.push((m) => {
    if (m.t !== 'frame') return;
    if (m.s <= lastS && m.s > 5) errors.push(`${bot.name}: kare sırası ${lastS} → ${m.s}`);
    if (m.k <= lastK && m.k > 60) errors.push(`${bot.name}: adım geri gitti ${lastK} → ${m.k}`);
    lastS = m.s; lastK = m.k;
    if (![...m.p, ...m.b].every((x) => Number.isInteger(x))) errors.push(`${bot.name}: kare sayısı bozuk ${JSON.stringify(m)}`);
    if (m.p.length > 16) errors.push(`${bot.name}: 8'den fazla disk`);
  });
}
