// Vampir Köylü gizlilik + yan kanal ölçümleri.
// 1) Sızıntı: izleyiciler oyun ortasında katılır, ölüler izlemeye devam eder; VampirReferee her görünümü alan izin listesi +
//    oyun sonunda gerçek gizli değerlerle (roller, doktor/gözcü/vampir id'leri, gece kaydı) tarar.
// 2) Yan kanallar: vampir olmayan biri ağdan/ekrandan gördükleriyle (mesaj sayısı, sırası, boyutu, hata metinleri, nightProgress,
//    gece hedef listesi) rolleri çıkarabilir mi? Ölçümler konsola tablo olarak yazılır; kesin sızıntılar assert edilir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom, Bot, sleep } from '../lib/bot.js';
import { startProbedServer, createRng, until } from './swarm-lib.mjs';
import { VampirReferee, vampMonkey, setupVampir, livingBots, playNight, publicPart, summarizeV, FAST } from './swarm-vampir-lib.mjs';

let srv;
const all = [];
before(async () => { srv = await startProbedServer({ timeScale: 0.01, seed: 31 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const track = (g) => { all.push(...g.bots); return g; };
const assertRef = (ref) => { const v = ref.finalChecks(); assert.deepEqual(v, [], v.join('\n')); };

test('sızıntı: 10 kişi + oyun ortasında 2 izleyici, ölüler izlemeye devam eder — oyun sonuna kadar hiçbir görünümde başkasının sırrı yok', async () => {
  for (const [n, seed, settings] of [[10, 5, { vampires: 3 }], [8, 6, { vampires: 0 }], [6, 7, { deli: false }]]) {
    const room = await makeRoom(srv.wsUrl, 'vampir', n, `L${n}-`);
    all.push(...room.bots);
    const s = { ...FAST, ...settings };
    const ref = new VampirReferee({ label: `leak n=${n}` }).attachAll(room.bots);
    room.host.send({ t: 'settings', settings: s });
    await room.host.waitRoom((r) => Object.entries(s).every(([k, v]) => r.settings[k] === v));
    const stop = { done: false };
    const loops = room.bots.map((b, i) => vampMonkey(b, { rng: createRng(seed * 100 + i), stop }));
    room.host.send({ t: 'start' });
    // gece 1'de bir izleyici, ilk gündüz (oyun bitmediyse) bir izleyici daha
    await until(() => room.host.view, { what: 'ilk görünüm' });
    const specs = [];
    const addSpec = async (tag) => {
      const sp = await new Bot(srv.wsUrl, `İzleyici${n}${tag}`).connect();
      ref.attach(sp); all.push(sp); specs.push(sp);
      sp.joinedDuring = room.host.view.phase;
      await sp.join(room.code);
    };
    await addSpec('a');
    await until(() => room.host.view.phase !== 'night', { timeout: 10_000, what: 'ilk gündüz' });
    if (room.host.view.phase !== 'over') await addSpec('b');
    loops.push(...specs.map((b, i) => vampMonkey(b, { rng: createRng(seed * 7 + i), stop, deadActRate: 1 })));
    try {
      await room.host.waitRoom((r) => r.phase === 'over', { timeout: 60_000 });
      await Promise.all([...room.bots, ...specs].map((b) => b.waitView((v) => v.phase === 'over', { timeout: 3000 })));
    } finally {
      stop.done = true;
      await Promise.all(loops);
    }
    for (const sp of specs) {
      assert.ok(sp.room.players.find((p) => p.id === sp.playerId).spectator, 'oyun ortasında gelen izleyici olmalı');
      const pre = sp.messages.filter((m) => m.t === 'view' && m.view.phase !== 'over');
      assert.ok(sp.messages.every((m) => m.t !== 'view' || m.view.me === null), 'izleyicinin me alanı boş olmalı');
      if (pre.length > 3) assert.ok(sp.errors.some((e) => /İzleyiciler/.test(e.message)), 'izleyici eylemleri reddedilmeli');
    }
    console.log(summarizeV(ref));
    assertRef(ref);
    assert.equal(ref.stats.overs, 1);
  }
});

// ---------- Yan kanallar ----------
const stat = (xs) => xs.length ? { n: xs.length, min: Math.min(...xs), max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) } : null;

test('yan kanal: gece yayınları — mesaj sayısı/sırası herkes için aynı, herkese açık kısım bayt bayt aynı, eylemi yapanın rolü boyuttan anlaşılmaz', async () => {
  const g = track(await setupVampir(srv.wsUrl, makeRoom, 9, { vampires: 2 }, 'Y'));
  const role = (b) => b.view.me.role;
  const [v1, v2] = g.vamps;
  const doc = g.by('doktor')[0];
  const seer = g.by('gozcu')[0];
  const deli = g.by('deli')[0];
  const koylu = g.by('koylu');
  const observer = koylu[0];
  const marks = new Map(g.bots.map((b) => [b, b.messages.length]));
  const nightViews = (b) => b.messages.slice(marks.get(b)).filter((m) => m.t === 'view' && m.view.phase === 'night');

  // Her rolden biri sırayla ilk seçimini yapar; gözlemci (köylü) tarafında her eylemin ürettiği görünümün boyutu ölçülür.
  const actorSizes = {};
  const target = koylu[1].playerId;
  const order = [v1, doc, seer, deli, koylu[2], v2];
  for (const actor of order) {
    const before = observer.messages.length;
    actor.action({ type: 'nightPick', targetId: target });
    await until(() => observer.messages.slice(before).some((m) => m.t === 'view'), { what: 'gözlemci görünümü' });
    const m = observer.messages.slice(before).find((x) => x.t === 'view');
    // seq/serverNow hane sayısı değişebilir; görünümün kendisi ölçülür
    actorSizes[`${role(actor)}${actor === v2 ? '2' : ''}`] = { bytes: Buffer.byteLength(JSON.stringify(m.view)), done: m.view.nightProgress.done };
  }
  // Tekrar dokunuşlar: vampir fikrini değiştirir, doktor değiştirir, gözcü ikinci kez dokunur (sessizce yok sayılır), köylü değiştirir.
  const noopBefore = observer.messages.length;
  const alt = koylu[3].playerId;
  for (const actor of [v1, v1, doc, seer, koylu[2]]) {
    actor.action({ type: 'nightPick', targetId: actor === seer ? alt : (actor.view.me.nightPick === target ? alt : target) });
    await sleep(30);
  }
  await sleep(100);
  const noops = observer.messages.slice(noopBefore).filter((m) => m.t === 'view').length;

  // Kalanlar seçer → gece biter
  await playNight(g, { victim: koylu[1] });
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase !== 'night')));

  // (a) mesaj sayıları: gece boyunca her alıcı aynı sayıda görünüm aldı
  const counts = Object.fromEntries(g.bots.map((b) => [`${b.name}/${role(b)}`, nightViews(b).length]));
  assert.equal(new Set(Object.values(counts)).size, 1, `gece görünüm sayıları alıcıya göre farklı: ${JSON.stringify(counts)}`);
  // (b) aynı seq'te herkese açık kısım aynı (hakem her mesajda bakar)
  for (const b of g.bots) {
    const ref0 = nightViews(observer).map((m) => publicPart(m.view));
    const mine = nightViews(b).map((m) => publicPart(m.view));
    assert.deepEqual(mine, ref0, `${b.name} (${role(b)}) herkese açık gece görünümü gözlemcininkinden farklı`);
  }
  // (c) eylemi yapanın rolü gözlemciye giden boyuttan anlaşılmamalı (sadece nightProgress.done değişir; 1 hane)
  const sizes = Object.values(actorSizes).map((x) => x.bytes);
  assert.equal(new Set(sizes).size, 1, `gözlemciye giden boyut eylemi yapanın rolüne göre değişti: ${JSON.stringify(actorSizes)}`);

  // (d) ölçümler: alıcının rolüne göre kendi gece görünümünün boyutu (yalnızca ağ dinleyen biri görebilir)
  const byRole = {};
  for (const b of g.bots) (byRole[role(b)] ??= []).push(...nightViews(b).map((m) => m.bytes));
  const sizeTable = Object.fromEntries(Object.entries(byRole).map(([r, xs]) => [r, stat(xs)]));
  const targetsTable = Object.fromEntries(g.bots.map((b) => [role(b), b.messages.slice(marks.get(b)).find((m) => m.t === 'view' && m.view.me?.nightTargets)?.view.me.nightTargets.length]));
  // (e) yayın sırası: alıcılara gönderim sırası katılım sırası mı (rol ile ilişkili değil)
  const seqs = nightViews(observer).map((m) => m.seq);
  const orderBy = (seq) => g.bots.map((b) => ({ b, at: b.messages.find((m) => m.t === 'view' && m.seq === seq)?.receivedAt })).sort((a, b) => a.at - b.at).map((x) => g.bots.indexOf(x.b));
  const spreads = seqs.map((seq) => { const ats = g.bots.map((b) => b.messages.find((m) => m.t === 'view' && m.seq === seq)?.receivedAt); return Math.max(...ats) - Math.min(...ats); });
  console.log('YAN KANAL ÖLÇÜMÜ (9 kişi: 2 vampir, doktor, gözcü, deli, 4 köylü)');
  console.log(`  gözlemciye (köylü) giden görünüm boyutu, eylemi yapana göre: ${JSON.stringify(actorSizes)}`);
  console.log(`  gece görünüm sayısı alıcıya göre: ${JSON.stringify(Object.values(counts))}`);
  console.log(`  tekrar dokunuşların (5 adet: 2 vampir, doktor, gözcü-yok sayılan, köylü) gözlemciye ürettiği görünüm: ${noops}`);
  console.log(`  alıcının rolüne göre kendi gece görünüm boyutu (bayt): ${JSON.stringify(sizeTable)}`);
  console.log(`  ilk gece seçilebilir hedef sayısı (kart açıkken aktif düğme): ${JSON.stringify(targetsTable)}`);
  console.log(`  yayın sırası (seq başına alıcı indeksleri, ilk 3): ${JSON.stringify(seqs.slice(0, 3).map(orderBy))}; alıcılar arası varış farkı ms: ${JSON.stringify(stat(spreads))}`);
  assertRef(g.ref);
});

test('yan kanal: geçersiz gece seçimlerinde hata metni her rol için aynı; gözcünün ikinci bakışı diğer rollerin tekrar seçimiyle aynı yanıtı alır', async () => {
  const g = track(await setupVampir(srv.wsUrl, makeRoom, 8, { vampires: 2 }, 'H'));
  const msgs = {};
  const dead = null;
  for (const b of g.bots) {
    const me = b.view.me;
    // her rol için "seçilemez" hedef: kendisi (doktor hariç), vampir için müttefik
    const bad = me.role === 'vampir' ? me.allies[0] : me.role === 'doktor' ? 'olmayan-id' : b.playerId;
    const err = await b.expectError({ type: 'nightPick', targetId: bad });
    (msgs[err.message] ??= []).push(me.role);
    const err2 = await b.expectError({ type: 'nightPick', targetId: 'yok-boyle-biri' });
    (msgs[err2.message] ??= []).push(me.role);
  }
  void dead;
  console.log(`geçersiz seçim hata metinleri: ${JSON.stringify(Object.keys(msgs))}`);
  assert.equal(Object.keys(msgs).length, 1, `hata metni role göre değişiyor: ${JSON.stringify(msgs)}`);
  // ilk seçimler + ikinci dokunuş: hepsi hata değil görünüm almalı (gözcünün ikinci bakışı sessizce yok sayılır)
  const seer = g.by('gozcu')[0];
  const koy = g.by('koylu')[0];
  const t1 = seer.view.me.nightTargets.find((id) => id !== koy.playerId);
  await seer.act({ type: 'nightPick', targetId: t1 });
  await koy.act({ type: 'nightPick', targetId: t1 });
  const r1 = await seer.act({ type: 'nightPick', targetId: koy.playerId });
  const r2 = await koy.act({ type: 'nightPick', targetId: seer.playerId });
  assert.equal(r1.t, 'view', 'gözcünün ikinci dokunuşu hata vermemeli');
  assert.equal(r2.t, 'view');
  assert.equal(seer.view.me.seerResults.length, 1, 'gözcü tek bakış');
  assert.equal(seer.view.me.nightPick, t1);
  assertRef(g.ref);
});

test('yan kanal: doktorun kurtardığı gece ile vampirlerin oy vermediği gece herkese açık görünümde ayırt edilemez', async () => {
  const g = track(await setupVampir(srv.wsUrl, makeRoom, 7, { deli: false }, 'K'));
  const doc = g.by('doktor')[0];
  const victim = g.by('koylu')[0];
  const observer = g.by('koylu')[1];
  await playNight(g, { victim, protect: victim });
  const saved = publicPart(observer.view);
  assert.equal(observer.view.announcement.deadId, null);
  g.host.send({ t: 'action', action: { type: 'endDay' } });
  await Promise.all(g.bots.map((b) => b.waitView((v) => v.phase === 'night' && v.night === 2)));
  // 2. gece vampir seçim yapmaz → süre dolunca biter (120 sn × 0.01 = 1.2 sn)
  for (const b of livingBots(g)) if (b.view.me.role !== 'vampir') b.action({ type: 'nightPick', targetId: b.view.me.nightTargets.find((id) => id !== b.playerId && id !== doc.view.me.lastProtected) });
  await observer.waitView((v) => v.phase === 'day' && v.night === 2, { timeout: 4000 });
  const none = publicPart(observer.view);
  const norm = (t) => JSON.parse(t, (k, val) => (['endsAt', 'night', 'gameKey', 'expiresAt'].includes(k) ? 0 : val));
  const a = norm(saved);
  const b = norm(none);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.deepEqual(a.announcement, b.announcement, 'kurtarma ile oy yok aynı duyuru');
  assertRef(g.ref);
});
