// Tosun Shazam cevap kontrolü (server/matcher.js) bulanık testi + lobi üzerinden tahmin girdisi fuzz'ı.
// - Birim: aşırı uzun, unicode (emoji, birleşik, RTL, CJK, tek vekil), regex metakarakterleri, boş/boşluk → asla fırlatmaz,
//   her zaman boolean, sunucu sınırlarındaki girdilerde hızlı; doğru başlığın çeşitli yazımları kabul, rastgele çöp red.
// - Lobi: guess.text olarak nesne/dizi/sayı/null/dev metin/kontrol karakteri → asla "internal", hep oyun hatası ya da yanlış tahmin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrect, norm, trackKey } from '../../server/matcher.js';
import { createRng } from '../../server/rng.js';
import { startServer } from '../lib/server.js';
import { makeRoom, sleep } from '../lib/bot.js';
import { makeTracks, sendPrep, rightVariants, ShazamReferee } from './swarm-shazam-lib.mjs';

const ITER = Number(process.env.FUZZ_ITER) || 3000;
// Sunucunun metin temizliğiyle aynı aralıklar (kaynakta çıplak U+2028 olmasın diye onaltılıktan kurulur)
const BAD_TEXT = new RegExp(`[${['0000-001f', '007f-009f', '200b-200f', '2028-202e', '2060-2069', 'feff-feff'].map((r) => r.split('-').map((h) => `\\u${h}`).join('-')).join('')}]`, 'g');

const POOLS = {
  ascii: 'abcdefghijklmnopqrstuvwxyz ABCXYZ0123456789',
  meta: '.*+?^${}()|[]\\/-–—&,\'"`',
  tr: 'çğıöşüÇĞİÖŞÜâîû',
  uni: ['🎵', '👍🏽', '🇹🇷', 'é', '‮', '​', '\u0000', '﻿', '漢字', 'Ж', 'ß', 'ﬁ', 'Ⅻ', '\uD800', '\uDFFF', '\t', '\n', ' '],
};
function randStr(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const k = rng.int(10);
    if (k < 4) s += POOLS.ascii[rng.int(POOLS.ascii.length)];
    else if (k < 6) s += POOLS.meta[rng.int(POOLS.meta.length)];
    else if (k < 8) s += POOLS.tr[rng.int(POOLS.tr.length)];
    else s += POOLS.uni[rng.int(POOLS.uni.length)];
  }
  return s;
}

const SPECIAL = [
  '', ' ', '   \t\n ', '\u0000', '‮‮', '()', '[]', '(((((((((', ')))))', '.*', '^$', '\\', '\\\\\\', '$&$1$$', '[^a-z]', '(?<x>a)',
  ' - remaster', ' - - - - - - - - - - - - - - - - - - - - remaster', 'feat feat feat', '& & & &', 'the', 'the the the', '🎵'.repeat(500),
  'a'.repeat(10_000), ' - '.repeat(3000) + 'x', '('.repeat(5000), '(a)'.repeat(3000), 'é'.repeat(2000), '\uD800'.repeat(100),
];

test('matcher birim fuzz: asla fırlatmaz, hep boolean, sunucu sınırlarında hızlı', () => {
  const rng = createRng(61);
  const tracks = [...makeTracks(20, 61), { title: 'Ay', artist: 'X' }, { title: '(Remastered)', artist: '' }, { title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' }, { title: '...', artist: '!!!' }];
  let slowest = 0;
  for (let i = 0; i < ITER; i++) {
    const t = rng.next() < 0.8 ? rng.pick(tracks) : { title: randStr(rng, 1 + rng.int(100)), artist: randStr(rng, rng.int(60)), alt: [randStr(rng, rng.int(100))] };
    const g = rng.next() < 0.1 ? rng.pick(SPECIAL).slice(0, 80) : randStr(rng, rng.int(81)); // sunucu tahmini 80 karaktere kısaltır
    const t0 = process.hrtime.bigint();
    let r;
    assert.doesNotThrow(() => { r = isCorrect(g, t); }, `isCorrect(${JSON.stringify(g)}, ${JSON.stringify(t.title)})`);
    assert.doesNotThrow(() => trackKey(t));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    slowest = Math.max(slowest, ms);
    assert.equal(typeof r, 'boolean');
  }
  // Sunucu sınırları (tahmin ≤ 80, başlık/alt ≤ 200 karakter) içinde tek kontrol çok hızlı olmalı
  assert.ok(slowest < 50, `en yavaş isCorrect ${slowest.toFixed(2)} ms`);
});

test('matcher: dev/patolojik girdiler (sunucu kısaltmasa bile) fırlatmaz; süre ölçülür', () => {
  const track = { title: 'Bohemian Rhapsody', artist: 'Queen', alt: ['Bohemian Rhapsody - Remastered'] };
  const times = [];
  for (const g of SPECIAL) {
    const t0 = Date.now();
    assert.doesNotThrow(() => isCorrect(g, track));
    assert.doesNotThrow(() => isCorrect('bohemian', { title: g, artist: g, alt: [g] }));
    assert.doesNotThrow(() => norm(g));
    times.push([g.length, Date.now() - t0]);
  }
  const worst = times.sort((a, b) => b[1] - a[1])[0];
  console.log(`en yavaş patolojik girdi: ${worst[0]} karakter, ${worst[1]} ms`);
  assert.ok(worst[1] < 2000, 'patolojik girdi 2 sn altında');
});

test('matcher: doğru başlığın yazımları kabul, rastgele çöp ve "yanlis" tahminleri red', () => {
  const rng = createRng(62);
  const tracks = makeTracks(60, 62);
  for (const t of tracks) {
    for (const v of rightVariants(t)) assert.equal(isCorrect(v, t), true, `"${v}" → "${t.title}" kabul edilmeli`);
    for (let i = 0; i < 20; i++) {
      const junk = `yanlis ${randStr(rng, 1 + rng.int(30))}`;
      assert.equal(isCorrect(junk, t), false, `"${junk}" → "${t.title}" kabul edilmemeli`);
    }
    assert.equal(isCorrect('', t), false);
    assert.equal(isCorrect('     ', t), false);
    assert.equal(isCorrect('.*', t), false, 'regex olarak yorumlanmamalı');
  }
});

test('matcher: havuzdaki başlıkları art arda yazan "saçma tahmin" doğru sayılmamalı', () => {
  const tracks = makeTracks(30, 63);
  let shotgun = '';
  for (const t of tracks) { if ((`${shotgun} ${t.title}`).length > 80) break; shotgun = `${shotgun} ${t.title}`.trim(); }
  const hits = tracks.filter((t) => isCorrect(shotgun, t));
  assert.equal(hits.length, 0, `80 karakterlik "${shotgun}" ${hits.length} şarkıya doğru sayıldı`);
  // ama "sanatçı + şarkı" kabul
  assert.equal(isCorrect(`${tracks[0].artist} ${tracks[0].title}`, tracks[0]), true);
});

// ---------- Lobi üzerinden ----------
let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.05, seed: 64 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

test('lobi: tahmin girdisi fuzz (nesne/dizi/sayı/null/dev metin/kontrol karakteri) → asla internal; tahmin metni 80 karakter', async () => {
  const tracks = makeTracks(8, 64);
  const { bots, host } = await makeRoom(srv.wsUrl, 'shazam', 3, 'Fuzz');
  all.push(...bots);
  const ref = new ShazamReferee({ label: 'matcher-fuzz', tracks }).attachAll(bots);
  await sendPrep(host, tracks);
  host.send({ t: 'settings', settings: { rounds: 4, roundSeconds: 180 } });
  await host.waitRoom((r) => r.settings.rounds === 4 && r.settings.roundSeconds === 180);
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'play');
  const weird = [
    { type: 'guess', text: { toString: 1 } }, { type: 'guess', text: ['a'] }, { type: 'guess', text: null }, { type: 'guess', text: true },
    { type: 'guess', text: 12345 }, { type: 'guess', text: 1e308 }, { type: 'guess', text: -0 }, { type: 'guess' }, { type: 'guess', text: '' },
    { type: 'guess', text: '   \t ' }, { type: 'guess', text: '\u0000\u0000' }, { type: 'guess', text: '.*' }, { type: 'guess', text: '$&$1' },
    { type: 'guess', text: '🎵'.repeat(1500) }, { type: 'guess', text: 'x'.repeat(7000) }, { type: 'guess', text: '\uD800\uD800' },
    { type: { toString: 1 } }, { type: ['guess'], text: 'a' }, { type: 'GUESS', text: 'a' }, { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' },
  ];
  // Botlar sırayla (her biri hız sınırı altında) garip tahminler yollar; her yanıt bir view ya da 'game' hatası olmalı
  const actor = bots[1];
  for (const a of weird) {
    if (actor.view?.me?.done) break;
    if (typeof a.text === 'string' && a.text.trim()) actor.sentGuesses.add([...a.text.replace(BAD_TEXT, '').replace(/s+/g, ' ').trim()].slice(0, 80).join('').trim());
    if (typeof a.text === 'string') actor.sentGuesses.add([...a.text].slice(0, 80).join('').trim());
    if (typeof a.text === 'number') actor.sentGuesses.add(String(a.text));
    const m = await actor.act(a, { timeout: 2000 });
    if (m.t === 'error') assert.equal(m.code, 'game', `${JSON.stringify(a).slice(0, 60)} → ${m.code}`);
    await sleep(170);
  }
  const mine = actor.view.me.guesses.filter((g) => g.text != null);
  for (const g of mine) assert.ok([...g.text].length <= 80, `tahmin ${[...g.text].length} karakter`);
  assert.ok(mine.length >= 3, 'bazı garip ama metin olan tahminler yanlış tahmin olarak sayılmalı');
  assert.deepEqual(bots.flatMap((b) => b.errors.filter((e) => e.code === 'internal')), []);
  assert.doesNotMatch(srv.log(), /Lobi hatası|view hatası|tick hatası/);
  // Hakem: başkalarının tahmini görünmedi, me tutarlı (kendi gönderdiği metinler dışında bir şey yok)
  const unknownText = ref.violations.filter((v) => !v.includes('göndermediği metin'));
  assert.deepEqual(unknownText, [], unknownText.join('\n'));
});
