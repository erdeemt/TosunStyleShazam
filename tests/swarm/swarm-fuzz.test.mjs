// Düşmanca girdi fuzz'u: her mesaj tipi × her alan × kötü değerler (yanlış tip, dev sayı, dizi, __proto__/constructor,
// toString/valueOf tuzakları, 8 KB'ın hemen altında derin iç içe JSON). Her yükten sonra bir "nöbetçi" mesajla sunucunun
// yaşadığı doğrulanır; çökerse yük kaydedilir, sunucu yeniden başlatılır ve devam edilir. Oyun içindeki botlara
// SpyfallReferee bağlıdır (fuzz oyunu tutarsız bir duruma sokmamalı).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeRoom } from '../lib/bot.js';
import { startProbedServer, SpyfallReferee, sleep } from './swarm-lib.mjs';

const MAX = 8 * 1024;

function deepArray(budget) {
  const depth = Math.floor(budget / 2);
  return '['.repeat(depth) + ']'.repeat(depth);
}
function deepObject(budget) {
  const unit = '{"a":';
  const depth = Math.floor((budget - 2) / (unit.length + 1));
  return unit.repeat(depth) + '1' + '}'.repeat(depth);
}

// Değerler JSON metni olarak (ör. __proto__ JSON.parse ile *kendi* alanı olur).
const VALUES = {
  null: 'null', true: 'true', zero: '0', neg: '-1', float: '1.5', huge: '1e308', negHuge: '-1e308', unsafe: '9007199254740993',
  empty: '""', long7k: JSON.stringify('ş'.repeat(3400)), html: JSON.stringify('<img src=x onerror=alert(1)>'), rtl: JSON.stringify('‮\u0000​'),
  emoji: JSON.stringify('🕵️‍♂️'.repeat(50)), protoStr: '"__proto__"', ctorStr: '"constructor"',
  arr: '[]', arr2: '[1,"a",null]', nestedArr: '[[["x"]]]', obj: '{}',
  proto: '{"__proto__":{"polluted":1,"t":"start"}}', ctor: '{"constructor":{"prototype":{"polluted":1}}}',
  toStr: '{"toString":1}', valueOf: '{"valueOf":1}', bothNull: '{"toString":null,"valueOf":null}', arrToStr: '[{"toString":1}]',
};

// Her mesaj tipi için alan yolları (iç içe alanlar dahil).
const TARGETS = [
  { t: 'hello', fields: ['playerId', 'token', 'name'], fresh: true },
  { t: 'create', fields: ['game'], ctx: 'lobby' },
  { t: 'join', fields: ['code'], ctx: 'lobby' },
  { t: 'settings', fields: ['settings', 'settings.rounds', 'settings.minutes', 'settings.spies', 'settings.seconds'], ctx: 'lobby' },
  { t: 'rename', fields: ['name'], ctx: 'lobby' },
  { t: 'kick', fields: ['playerId'], ctx: 'lobby' },
  { t: 'start', fields: ['x'], ctx: 'lobby' },
  { t: 'kick', fields: ['playerId'], ctx: 'game' },
  { t: 'action', fields: ['action', 'action.type'], ctx: 'game' },
  ...['accuse', 'vote', 'guess', 'finalVote', 'next'].map((type) => ({ t: 'action', type, fields: ['action.targetId', 'action.locationId', 'action.yes'], ctx: 'game' })),
  { t: 'backToLobby', fields: ['x'], ctx: 'over' },
  { t: 'leave', fields: ['x'], ctx: 'lobby' },
];

function build(target, field, valueJson) {
  const parts = field.split('.');
  const extra = target.type ? `"type":${JSON.stringify(target.type)},` : '';
  if (parts.length === 1) return `{"t":${JSON.stringify(target.t)},${JSON.stringify(parts[0])}:${valueJson}}`;
  return `{"t":${JSON.stringify(target.t)},${JSON.stringify(parts[0])}:{${extra}${JSON.stringify(parts[1])}:${valueJson}}}`;
}

function* payloads() {
  for (const target of TARGETS) {
    for (const field of target.fields) {
      const values = { ...VALUES };
      // 8 KB'ın hemen altına sığacak derin iç içe değerler
      const shell = build(target, field, '');
      values.deepArr = deepArray(MAX - shell.length - 8);
      values.deepObj = deepObject(MAX - shell.length - 8);
      for (const [name, json] of Object.entries(values)) {
        const text = build(target, field, json);
        if (Buffer.byteLength(text) > MAX) continue;
        yield { target, label: `${target.t}${target.type ? `/${target.type}` : ''}.${field}=${name}`, text };
      }
    }
  }
  // Mesajın kendisi bozuk / t alanı tuhaf
  const odd = ['[]', '"hello"', '42', 'null', '{"t":["hello"]}', '{"t":{"toString":1}}', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"hasOwnProperty"}', '{"t":"toString"}',
    '{"t":"settings","__proto__":{"t":"start"}}', `{"t":"rename","name":"a","x":${deepArray(MAX - 40)}}`, deepArray(MAX - 10), deepObject(MAX - 10)];
  for (const text of odd) yield { target: { t: 'raw', ctx: 'game' }, label: `raw:${text.slice(0, 40)}`, text };
}

class Harness {
  constructor() { this.crashes = []; this.internal = []; this.closes = []; this.refViolations = []; }

  async boot() {
    this.srv = await startProbedServer({ timeScale: 0.02, seed: 11 });
    this.ctx = {};
  }

  async ensure(kind) {
    const c = this.ctx[kind];
    if (c && c.bots.every((b) => b.isOpen) && c.ok()) return c;
    c?.bots.forEach((b) => b.close());
    const game = kind === 'lobby' ? '_test' : 'spyfall';
    const room = await makeRoom(this.srv.wsUrl, game, 4, kind === 'lobby' ? 'L' : 'G');
    const ref = new SpyfallReferee({ label: `fuzz-${kind}` });
    if (kind !== 'lobby') ref.attachAll(room.bots);
    const ctx = { ...room, ref, sent: 0 };
    if (kind === 'game' || kind === 'over') {
      room.host.send({ t: 'settings', settings: { rounds: 1, minutes: 15 } });
      await room.host.waitRoom((r) => r.settings.minutes === 15);
      room.host.send({ t: 'start' });
      await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'play')));
      if (kind === 'over') {
        const spy = room.bots.find((b) => b.view.me.spy);
        await spy.act({ type: 'guess', locationId: room.bots.find((b) => !b.view.me.spy).view.me.location.id });
        room.host.action({ type: 'next' });
        await room.host.waitRoom((r) => r.phase === 'over');
      }
    }
    ctx.ok = () => kind === 'lobby' ? room.host.room?.phase === 'lobby' && room.host.room.hostId === room.host.playerId
      : kind === 'game' ? room.host.room?.phase === 'playing' && room.host.view?.phase === 'play'
        : room.host.room?.phase === 'over';
    this.ctx[kind] = ctx;
    return ctx;
  }

  // Yükü gönder, ardından nöbetçi: sunucu sırayla işlediği için nöbetçinin yanıtı geldiyse yük işlenmiştir.
  async fire(p) {
    let ws;
    let fuzzer;
    if (p.target.fresh) {
      ws = new WebSocket(this.srv.wsUrl);
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    } else {
      const ctx = await this.ensure(p.target.ctx);
      fuzzer = ctx.host;
      if (ctx.sent >= 12) { await fuzzer.reconnect(); ctx.sent = 0; } // hız sınırı penceresi bağlantı başına
      ctx.sent += 2;
      ws = fuzzer.ws;
    }
    const got = [];
    const done = new Promise((resolve) => {
      const onMsg = (d) => {
        const m = JSON.parse(String(d));
        got.push(m);
        if (m.t === 'error' && (m.code === 'unknown' || m.code === 'no_hello')) { ws.off('message', onMsg); resolve('ok'); }
      };
      ws.on('message', onMsg);
      ws.once('close', (code) => resolve(`close:${code}`));
      setTimeout(() => resolve('timeout'), 3000);
    });
    ws.send(p.text);
    if (ws.readyState === 1) ws.send('{"t":"__sentinel__"}');
    const outcome = await done;
    if (p.target.fresh) ws.terminate();
    for (const m of got) if (m.t === 'error' && m.code === 'internal') this.internal.push(p.label);
    if (got.some((m) => JSON.stringify(m).includes('polluted'))) this.internal.push(`${p.label} (polluted yansıdı)`);
    if (outcome !== 'ok') {
      const alive = await this.srv.alive();
      if (!alive) {
        const tail = this.srv.log().split('\n').filter((l) => !l.startsWith('@@probe')).slice(-14).join('\n');
        this.crashes.push({ label: p.label, text: p.text.slice(0, 120), tail });
        await this.restart();
      } else {
        this.closes.push(`${p.label} → ${outcome}`);
      }
    }
  }

  async restart() {
    for (const c of Object.values(this.ctx)) { this.collect(c); c.bots.forEach((b) => b.close()); }
    await this.srv.stop();
    await this.boot();
  }

  collect(c) { if (c?.ref) this.refViolations.push(...c.ref.violations); }

  async shutdown() {
    for (const c of Object.values(this.ctx)) { this.collect(c); c.bots.forEach((b) => b.close()); }
    const log = this.srv.log();
    await this.srv.stop();
    return log;
  }
}

// Tek fuzz koşusu; sonuçlar aşağıdaki üç testte ayrı ayrı değerlendirilir (çökme = sert hata, diğerleri bilinen bulgu).
let runPromise;
function runFuzz() {
  runPromise ??= (async () => {
    const h = new Harness();
    await h.boot();
    let count = 0;
    let log = '';
    try {
      for (const p of payloads()) {
        await h.fire(p);
        count++;
      }
    } finally {
      log = await h.shutdown();
    }
    const uniq = (xs) => [...new Set(xs)];
    const uncaught = (log.match(/Yakalanmamış hata:[^\n]*\n[^\n]*/g) ?? []).map((l) => l.replace(/\s+/g, ' '));
    const zombies = h.closes.filter((c) => c.endsWith('timeout'));
    console.log(`fuzz: ${count} yük, ${h.crashes.length} çökme, ${zombies.length} yanıtsız kalan soket, ${uniq(h.internal).length} iç hata, ${uncaught.length} yakalanmamış istisna`);
    for (const c of h.crashes) console.log(`ÇÖKME ${c.label}\n  yük: ${c.text}\n${c.tail.split('\n').map((l) => `    ${l}`).join('\n')}`);
    if (zombies.length) console.log(`Yükten sonra yanıt vermeyen soketler:\n  ${zombies.join('\n  ')}`);
    if (h.internal.length) console.log(`İÇ HATA (internal) dönen yükler:\n  ${uniq(h.internal).join('\n  ')}`);
    if (uncaught.length) console.log(`Sunucu logunda yakalanmamış istisna (ilk 2):\n  ${uniq(uncaught).slice(0, 2).join('\n  ')}`);
    return { count, crashes: h.crashes, zombies, internal: uniq(h.internal), uncaught, refViolations: h.refViolations.filter((v) => !v.includes('(internal)')) };
  })();
  return runPromise;
}

test('fuzz: her mesaj tipi × alan × düşmanca değer — sunucu çökmez, oyun durumu tutarlı kalır', async () => {
  const r = await runFuzz();
  assert.ok(r.count > 300, `yeterli yük üretilmeli (${r.count})`);
  assert.deepEqual(r.refViolations, [], r.refViolations.join('\n'));
  assert.deepEqual(r.crashes.map((c) => c.label), [], 'sunucu tek bir mesajla çökmemeli (bkz. ÇÖKME logları)');
});

test('fuzz: düşmanca hello sonrası soket yanıt vermeye devam etmeli (yakalanmamış istisna yok)', async () => {
  const r = await runFuzz();
  assert.deepEqual(r.zombies, []);
  assert.deepEqual(r.uncaught, []);
});

test('fuzz: iç hata (internal) dönen yük olmamalı (toString/valueOf tuzakları → GameError olmalı)', async () => {
  const r = await runFuzz();
  assert.deepEqual(r.internal, []);
});

test('fuzz: 8 KB sınırı tam kenarda — 8192 bayt kabul, 8193 bayt bağlantıyı kapatır (1009)', async () => {
  const srv = await startProbedServer({ timeScale: 0.02 });
  try {
    const [a, b] = await Promise.all([0, 1].map(async () => {
      const ws = new WebSocket(srv.wsUrl);
      await new Promise((r) => ws.once('open', r));
      return ws;
    }));
    const pad = (n) => { const base = '{"t":"rename","name":""}'; return `{"t":"rename","name":"${'x'.repeat(n - base.length)}"}`; };
    const closeA = new Promise((r) => a.once('close', (c) => r(c)));
    const closeB = new Promise((r) => b.once('close', (c) => r(c)));
    const replyA = new Promise((r) => a.once('message', (d) => r(JSON.parse(String(d)))));
    a.send(pad(8192));
    b.send(pad(8193));
    assert.equal((await replyA).code, 'no_hello', '8192 bayt işlenmeli');
    assert.equal(await closeB, 1009);
    a.terminate();
    await closeA;
    assert.ok(await srv.alive());
  } finally {
    await srv.stop();
  }
});

test('fuzz: hello seli — tek bağlantıdan çok sayıda hello / yeni kimlik', async () => {
  const srv = await startProbedServer({ timeScale: 0.02, probeMs: 100 });
  try {
    const before = (await srv.waitProbe(() => true)).identities;
    const ws = new WebSocket(srv.wsUrl);
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise((r) => ws.once('close', (c) => r(c)));
    for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ t: 'hello', name: `sel${i}` }));
    const code = await Promise.race([closed, sleep(1000).then(() => 'open')]);
    await sleep(250);
    const after = srv.lastProbe().identities;
    console.log(`hello seli: kapanış=${code}, yeni kimlik=${after - before}`);
    assert.ok(after - before <= 5, `tek bağlantı sınırsız kimlik üretmemeli (${after - before})`);
    ws.terminate();
  } finally {
    await srv.stop();
  }
});
