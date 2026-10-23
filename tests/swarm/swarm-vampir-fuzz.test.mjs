// Vampir Köylü düşmanca girdi fuzz'u: her vampir eylem tipi × alan × kötü değer (yanlış tip, dev sayı, dizi, __proto__,
// toString/valueOf tuzakları, geçerli id'nin dizi/nesne/NUL'lu hâlleri), eylemin doğal fazında (gece/gündüz/savunma/oylama)
// ve ölü oyuncu olarak. Her yükten sonra nöbetçi mesajla sunucunun yaşadığı doğrulanır. Oyun botlarına VampirReferee bağlı;
// hiçbir düşmanca yük durumu değiştirmemeli (gece seçimi / aday / oy oluşmamalı). Ayrıca lobide vampir ayarları fuzz'lanır.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer } from './swarm-lib.mjs';
import { setupVampir, playNight, startTrialOn, livingBots, settle } from './swarm-vampir-lib.mjs';

const VALUES = {
  null: 'null', true: 'true', false: 'false', zero: '0', neg: '-1', float: '1.5', huge: '1e308', nan: '"NaN"', unsafe: '9007199254740993',
  empty: '""', long7k: JSON.stringify('ş'.repeat(3000)), html: JSON.stringify('<img src=x onerror=alert(1)>'), rtl: JSON.stringify('‮\u0000​'),
  protoStr: '"__proto__"', ctorStr: '"constructor"', arr: '[]', arr2: '[1,"a",null]', obj: '{}',
  proto: '{"__proto__":{"polluted":1,"type":"endDay"}}', ctor: '{"constructor":{"prototype":{"polluted":1}}}',
  toStr: '{"toString":1}', valueOf: '{"valueOf":1}', bothNull: '{"toString":null,"valueOf":null}', arrToStr: '[{"toString":1}]',
  deep: '['.repeat(500) + ']'.repeat(500),
};
const TYPES = ['nightPick', 'nominate', 'support', 'endDefense', 'trialVote', 'endDay'];
const PHASE_OF = { nightPick: 'night', nominate: 'day', support: 'day', endDefense: 'trial', trialVote: 'trialVote', endDay: 'day' };

class Harness {
  constructor(srv) { this.srv = srv; this.ctx = {}; this.internal = []; this.closes = []; this.crashes = []; this.stateChanges = []; this.refs = []; }

  // kind: night | day | trial | trialVote | dead — fuzzer: host olmayan, (dead hariç) yaşayan, vampir olmayan bir oyuncu
  async ensure(kind) {
    const c = this.ctx[kind];
    if (c && c.ok()) return c;
    c?.g.bots.forEach((b) => b.close());
    const g = await setupVampir(this.srv.wsUrl, makeRoom, 7, { vampires: 1 }, `Z${kind}`);
    this.refs.push(g.ref);
    const pick = () => livingBots(g).find((b) => b !== g.host && b.view.me.role === 'koylu');
    let fuzzer = pick();
    let target = null;
    if (kind !== 'night') {
      const victim = kind === 'dead' ? fuzzer : livingBots(g).find((b) => b !== g.host && b !== fuzzer && b.view.me.role === 'koylu');
      await playNight(g, { victim });
      if (kind !== 'dead' && victim) fuzzer = livingBots(g).find((b) => b !== g.host && b.view.me.role === 'koylu');
      if (['trial', 'trialVote'].includes(kind)) {
        target = livingBots(g).find((b) => b !== fuzzer && b.view.me.role !== 'vampir' && b !== g.host);
        await startTrialOn(g, target, { nominator: g.host, supporter: livingBots(g).find((b) => ![g.host, target, fuzzer].includes(b)) });
        if (kind === 'trialVote') { target.action({ type: 'endDefense' }); await g.host.waitView((v) => v.phase === 'trialVote'); }
      }
    }
    await settle(g);
    const phase = kind === 'dead' ? 'day' : kind;
    const ctx = {
      g, fuzzer, target, sent: 0, kind,
      // oylamada: henüz oy vermemiş (host/sanık olmayan) seçmenler sırayla fuzzer olur; bitince bağlam yenilenir
      spare: kind === 'trialVote' ? livingBots(g).filter((b) => ![g.host, target, fuzzer].includes(b)) : [],
      ok: () => ctx.fuzzer.isOpen && ctx.fuzzer.view?.phase === phase && g.host.room?.phase === 'playing',
      snapshot: () => { const f = ctx.fuzzer; return JSON.stringify({ pick: f.view.me.nightPick ?? null, nom: f.view.nomination, can: f.view.me.canNominate, myVote: f.view.trial?.myVote ?? null, phase: f.view.phase, night: f.view.night, alive: f.view.players.map((p) => p.alive) }); },
    };
    this.ctx[kind] = ctx;
    return ctx;
  }

  async fire(kind, label, text, { allowVote } = {}) {
    const ctx = await this.ensure(kind);
    const bot = ctx.fuzzer;
    if (ctx.sent >= 26) { await bot.reconnect(); await bot.waitView(() => true); ctx.sent = 0; }
    ctx.sent += 2;
    const before = ctx.snapshot();
    const ws = bot.ws;
    const from = bot.messages.length;
    ws.send(text);
    ws.send('{"t":"__sentinel__"}');
    // olay tabanlı bekleme (Windows'ta setInterval çözünürlüğü ~15 ms)
    const outcome = await bot.waitFor((m) => m.t === 'error' && m.code === 'unknown', { timeout: 3000 })
      .then(() => 'ok', () => (bot.closed ? `close:${bot.closed.code}` : 'timeout'));
    const got = bot.messages.slice(from);
    for (const m of got) if (m.t === 'error' && m.code === 'internal') this.internal.push(`${kind} ${label}`);
    if (got.some((m) => JSON.stringify(m).includes('polluted'))) this.internal.push(`${kind} ${label} (polluted yansıdı)`);
    if (outcome !== 'ok') {
      if (!(await this.srv.alive())) { this.crashes.push(`${kind} ${label}`); throw new Error(`sunucu çöktü: ${kind} ${label}\n${this.srv.log().slice(-1500)}`); }
      this.closes.push(`${kind} ${label} → ${outcome}`);
      ctx.fuzzer.close();
      delete this.ctx[kind];
      return;
    }
    const after = ctx.snapshot();
    if (allowVote !== undefined) {
      // tek izinli değişim: myVote null → allowVote
      const want = JSON.stringify({ ...JSON.parse(before), myVote: allowVote });
      if (after !== want) this.stateChanges.push(`${kind} ${label}: oy ${JSON.parse(after).myVote} (beklenen ${allowVote})`);
    } else if (after !== before) this.stateChanges.push(`${kind} ${label}: ${before} → ${after}`);
  }
}

test('vampir fuzz: her eylem tipi × alan × düşmanca değer, doğal fazında ve ölüyken — çökme/iç hata yok, durum değişmez', async () => {
  const srv = await startProbedServer({ timeScale: 1, seed: 61 });
  const h = new Harness(srv);
  let count = 0;
  try {
    for (const type of TYPES) {
      const kinds = [PHASE_OF[type], 'dead'];
      for (const kind of kinds) {
        for (const [name, json] of Object.entries(VALUES)) {
          for (const field of ['targetId', 'yes', 'x']) {
            if (field === 'yes' && type !== 'trialVote') continue;
            if (type === 'trialVote' && kind !== 'dead' && field !== 'yes') continue; // ölü bağlamında denenir; canlıda her yük bir oy
            const text = `{"t":"action","action":{"type":"${type}","${field}":${json}}}`;
            // Canlı seçmenin trialVote'u bir oy kaydeder: boolean true dışındaki her "yes" Hayır sayılmalı. Taze oylama için ctx yenilenir.
            const votes = type === 'trialVote' && kind !== 'dead';
            await h.fire(kind, `${type}.${field}=${name}`, text, { allowVote: votes ? (name === 'true' && field === 'yes' ? true : false) : undefined });
            if (votes) { const c = h.ctx[kind]; if (c?.spare.length) { c.fuzzer = c.spare.shift(); c.sent = 0; } else delete h.ctx[kind]; }
            count++;
          }
        }
      }
      // type alanının kendisi düşmanca + action'ın kendisi düşmanca
    }
    for (const [name, json] of Object.entries(VALUES)) {
      for (const kind of ['night', 'day', 'trialVote']) {
        await h.fire(kind, `type=${name}`, `{"t":"action","action":{"type":${json},"targetId":"x"}}`);
        await h.fire(kind, `action=${name}`, `{"t":"action","action":${json}}`);
        count += 2;
      }
    }
    // Geçerli bir id'nin tip karışıklığı hâlleri: dizi, nesne, toString'li nesne, NUL ekli, büyük harf
    for (const kind of ['night', 'day']) {
      const ctx = await h.ensure(kind);
      const id = livingBots(ctx.g).find((b) => b !== ctx.fuzzer && b.view.me.role !== 'vampir').playerId;
      const type = kind === 'night' ? 'nightPick' : 'nominate';
      for (const [name, json] of Object.entries({ arr: JSON.stringify([id]), obj: JSON.stringify({ id }), toStr: JSON.stringify({ toString: id }), nul: JSON.stringify(`${id}\u0000`), upper: JSON.stringify(id.toUpperCase()), spaced: JSON.stringify(` ${id}`) })) {
        await h.fire(kind, `${type}.targetId=valid-${name}`, `{"t":"action","action":{"type":"${type}","targetId":${json}}}`);
        count++;
      }
    }
    console.log(`vampir fuzz: ${count} yük, ${h.crashes.length} çökme, ${h.internal.length} iç hata, ${h.closes.length} kapanan bağlantı, ${h.stateChanges.length} durum değişimi`);
    if (h.closes.length) console.log(`  kapananlar: ${h.closes.join('; ')}`);
    assert.ok(count > 250, `yeterli yük (${count})`);
    assert.deepEqual(h.internal, [], 'iç hata (internal) dönen yük olmamalı');
    assert.deepEqual(h.stateChanges, [], 'düşmanca yük oyun durumunu değiştirmemeli');
    assert.deepEqual(h.closes.filter((c) => !c.includes('deep') && !c.includes('long7k')), [], 'sadece aşırı büyük/derin yükler bağlantıyı kapatabilir');
    const violations = h.refs.flatMap((r) => r.finalChecks());
    assert.deepEqual(violations, [], violations.join('\n'));
    assert.doesNotMatch(srv.log(), /hatası/);
  } finally {
    for (const c of Object.values(h.ctx)) c.g.bots.forEach((b) => b.close());
    await srv.stop();
  }
});

test('vampir fuzz: lobi ayarları — her alan × düşmanca değer; ayarlar hep aralıkta ve doğru tipte kalır', async () => {
  const srv = await startProbedServer({ timeScale: 1, seed: 62 });
  const { bots, host } = await makeRoom(srv.wsUrl, 'vampir', 5, 'S');
  const RANGES = { dayMinutes: [2, 8], defenseSeconds: [15, 60], nightSeconds: [30, 120], vampires: [0, 3] };
  const BOOLS = ['doktor', 'gozcu', 'deli'];
  const bad = [];
  let sent = 0;
  try {
    for (const field of [...Object.keys(RANGES), ...BOOLS]) {
      for (const [name, json] of Object.entries(VALUES)) {
        if (sent >= 12) { await host.reconnect(); sent = 0; }
        sent += 2;
        const from = host.messages.length;
        host.sendRaw(`{"t":"settings","settings":{"${field}":${json}}}`);
        host.sendRaw('{"t":"__sentinel__"}');
        await host.waitFor((m) => m.t === 'error' && m.code === 'unknown', { timeout: 3000 }).catch(() => null);
        const msgs = host.messages.slice(from);
        if (msgs.some((m) => m.t === 'error' && m.code === 'internal')) bad.push(`${field}=${name}: internal`);
        const s = host.room.settings;
        for (const [k, [lo, hi]] of Object.entries(RANGES)) if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) bad.push(`${field}=${name}: ${k}=${JSON.stringify(s[k])}`);
        for (const k of BOOLS) if (typeof s[k] !== 'boolean') bad.push(`${field}=${name}: ${k}=${JSON.stringify(s[k])}`);
        if (JSON.stringify(s).includes('polluted')) bad.push(`${field}=${name}: polluted`);
      }
    }
    // sonunda oyun bu ayarlarla başlatılabilmeli
    host.send({ t: 'start' });
    await Promise.all(bots.map((b) => b.waitView((v) => v.phase === 'night')));
    assert.deepEqual(bad, []);
    assert.ok(await srv.alive());
  } finally {
    bots.forEach((b) => b.close());
    await srv.stop();
  }
});
