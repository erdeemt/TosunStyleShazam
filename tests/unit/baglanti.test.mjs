// 🔗 Bağlantı Avı birim testleri: Türkçe duyarsız arama, puan, yıl biçimi, zincir motoru (kenar doğrulama, yanlış deneme,
// silme, ipucu, 12 adım sınırı), yapbozların en kısa uzunluğu (BFS), günlük belirlenimcilik, fotoğraf adresi koruması.
// Test grafiği: content/baglanti/test-graph.json (TEST_MODE). Gerçek veri şeması: baglanti-data.test.mjs. Kurallar: PLAN.md §4.12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIFFS, HINT_COST, MAX_CHAIN, SCORE, fmtYear, fmtYears, fold, indexEntries, initialOf, scoreRun, search, titleFor,
} from '../../public/baglanti-math.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-bg-unit-'));
process.env.TEST_MODE = '1';
process.env.BAGLANTI_SALT = 'unit-salt';
const bg = await import('../../server/baglanti.js');
const { GameError } = await import('../../server/errors.js');

const GRAPH = JSON.parse(readFileSync(new URL('../../content/baglanti/test-graph.json', import.meta.url), 'utf8'));
const LEN = { kolay: 3, orta: 4, zor: 5 };

// Bağımsız BFS (sunucu kodundan ayrı): test grafiğinde iki kişi arası mesafe
function bfsDist(s, t) {
  const adj = GRAPH.people.map(() => []);
  for (const [a, b] of GRAPH.edges) { adj[a].push(b); adj[b].push(a); }
  const dist = new Map([[s, 0]]);
  const q = [s];
  for (let h = 0; h < q.length; h++) for (const v of adj[q[h]]) if (!dist.has(v)) { dist.set(v, dist.get(q[h]) + 1); q.push(v); }
  return dist.get(t) ?? -1;
}

// ---------- Arama ----------

test('fold: Türkçe harfler, büyük İ/I, şapka ve aksanlar düz harfe iner', () => {
  assert.equal(fold('İsmet İnönü'), 'ismet inonu');
  assert.equal(fold('ISPARTA'), 'isparta');
  assert.equal(fold('Şükrü Saracoğlu'), 'sukru saracoglu');
  assert.equal(fold('Çağan Irmak'), 'cagan irmak');
  assert.equal(fold('Nâzım Hikmet'), 'nazim hikmet');
  assert.equal(fold('Pelé'), 'pele');
  assert.equal(fold('Zlatan Ibrahimović'), 'zlatan ibrahimovic');
  assert.equal(fold('Søren Kierkegaard'), 'soren kierkegaard');
  assert.equal(fold("  Ahmet  Necdet-Sezer "), 'ahmet necdet sezer');
  assert.equal(fold('II. Mehmed'), 'ii mehmed');
  assert.equal(fold(null), '');
});

test('search: Türkçe duyarsız, baş eşleşme önce, kelime başı, içerik; ek adlar (Fatih → II. Mehmed)', () => {
  const rows = [
    ['Q1', 'İsmet İnönü', 'Ismet Inonu', 1884, 1973, 'cumhurbaşkanı', 'politics', 1, ''],
    ['Q2', 'II. Mehmed', 'Mehmed II', 1432, 1481, 'padişah', 'monarch', 1, 'Fatih Sultan Mehmet|Fatih'],
    ['Q3', 'Mehmet Ali Birand', '', 1941, 2013, 'gazeteci', 'writer', 0, ''],
    ['Q4', 'Ali Koç', '', 1967, null, 'iş insanı', 'business', 1, ''],
    ['Q5', 'Muhammed Ali', 'Muhammad Ali', 1942, 2016, 'boksör', 'sport', 1, ''],
  ];
  const entries = indexEntries(rows);
  assert.deepEqual(search(entries, 'inonu').map((e) => e.q), ['Q1']);
  assert.deepEqual(search(entries, 'İNÖNÜ').map((e) => e.q), ['Q1']);
  assert.deepEqual(search(entries, 'ismet i').map((e) => e.q), ['Q1']);
  assert.deepEqual(search(entries, 'fatih').map((e) => e.q), ['Q2'], 'ek ad');
  assert.deepEqual(search(entries, 'mehmed').map((e) => e.q), ['Q2'], 'İngilizce adı "Mehmed II" baştan eşleşir');
  // "ali": Ali Koç (baştan) önce, sonra kelime başı eşleşmeleri (Mehmet Ali Birand, Muhammed Ali) ünlülük sırasıyla
  assert.deepEqual(search(entries, 'ali').map((e) => e.q), ['Q4', 'Q3', 'Q5']);
  assert.deepEqual(search(entries, 'koc').map((e) => e.q), ['Q4']);
  assert.deepEqual(search(entries, 'nön').map((e) => e.q), ['Q1'], '3+ harf: içerik eşleşmesi');
  assert.deepEqual(search(entries, '').length, 0);
  assert.equal(search(entries, 'a', 2).length, 2, 'sınır');
  const e = entries[1];
  assert.equal(e.photo, true);
  assert.deepEqual(e.cats, ['monarch']);
});

test('initialOf: Romen rakamı ve sıra eki atlanır', () => {
  assert.equal(initialOf('II. Mehmed'), 'M');
  assert.equal(initialOf('İsmet İnönü'), 'İ');
  assert.equal(initialOf('çağrı'), 'Ç');
  assert.equal(initialOf('Elon Musk'), 'E');
});

// ---------- Puan ----------

test('puan: en kısa = 1000; fazladan adım −150 (taban 300); yanlış −25 (en çok −250); ipucu; süre; en az 50; pes 0', () => {
  assert.equal(scoreRun({ steps: 3, optimal: 3 }).score, 1000);
  assert.equal(scoreRun({ steps: 4, optimal: 3 }).score, 850);
  assert.equal(scoreRun({ steps: 12, optimal: 2 }).base, SCORE.floor);
  assert.equal(scoreRun({ steps: 3, optimal: 3, wrong: 3 }).score, 925);
  assert.equal(scoreRun({ steps: 3, optimal: 3, wrong: 40 }).wrongPen, 250);
  assert.equal(scoreRun({ steps: 3, optimal: 3, hints: ['letter', 'field'] }).score, 1000 - HINT_COST.letter - HINT_COST.field);
  assert.equal(scoreRun({ steps: 3, optimal: 3, seconds: 60 }).timePen, 0);
  assert.equal(scoreRun({ steps: 3, optimal: 3, seconds: 69.9 }).timePen, 0);
  assert.equal(scoreRun({ steps: 3, optimal: 3, seconds: 120 }).timePen, 30);
  assert.equal(scoreRun({ steps: 3, optimal: 3, seconds: 3600 }).timePen, 200);
  assert.equal(scoreRun({ steps: 12, optimal: 2, wrong: 99, hints: Array(8).fill('letter'), seconds: 9999 }).score, SCORE.min);
  assert.equal(scoreRun({ steps: 3, optimal: 3, gaveUp: true }).score, 0);
  assert.equal(scoreRun({ steps: 1, optimal: 3, done: false }).score, 0);
  assert.equal(titleFor(1000).name, 'Altı Derece Ustası');
  assert.equal(titleFor(0).icon, '🙈');
});

test('yıl biçimi: MÖ (astronomik yıl), yaşayanlar, bilinmeyen', () => {
  assert.equal(fmtYear(-68), 'MÖ 69');
  assert.equal(fmtYear(0), 'MÖ 1');
  assert.equal(fmtYears(-68, -29), 'MÖ 69 – MÖ 30');
  assert.equal(fmtYears(1987, null), '1987–');
  assert.equal(fmtYears(1881, 1938), '1881 – 1938');
  assert.equal(fmtYears(null, null), '');
  assert.deepEqual(DIFFS.map((d) => d.len), [3, 4, 5]);
});

// ---------- Grafik + yapbozlar ----------

test('test grafiği: her zorlukta yapbozlar geçerli, en kısa yol uzunluğu 3/4/5 (bağımsız BFS) ve sunucu BFS aynı', () => {
  for (const [diff, list] of Object.entries(bg.PUZZLES)) {
    assert.ok(list.length >= 5, `${diff}: ${list.length} yapboz`);
    for (const z of list) {
      assert.equal(z.path.length, LEN[diff] + 1);
      const s = GRAPH.people.findIndex((p) => p.q === z.s);
      const t = GRAPH.people.findIndex((p) => p.q === z.t);
      assert.equal(bfsDist(s, t), LEN[diff], `${z.key}`);
      assert.equal(bg.shortestPath(z.s, z.t).length, LEN[diff] + 1);
      assert.equal(bg.distancesTo(z.t)[s], LEN[diff]);
      for (let i = 1; i < z.path.length; i++) assert.ok(bg.connected(z.path[i - 1], z.path[i]));
    }
  }
});

test('etiket: her kenar iki yönde de okunur; yönlü türlerde metin yöne göre değişir', () => {
  const byType = {};
  for (const e of GRAPH.edges) {
    const a = GRAPH.people[e[0]].q;
    const b = GRAPH.people[e[1]].q;
    const ab = bg.relation(a, b);
    const ba = bg.relation(b, a);
    assert.ok(ab?.e && ab?.t && ba?.e && ba?.t, `${a}-${b}`);
    assert.ok(!/undefined|null/.test(ab.t + ba.t), `${ab.t} / ${ba.t}`);
    (byType[GRAPH.types[e[2]]] ??= []).push([ab, ba]);
  }
  for (const [ab, ba] of byType.parent ?? []) {
    assert.match(ab.t, /babası|annesi|ebeveyni/);
    assert.match(ba.t, /oğlu|kızı|çocuğu/);
  }
  for (const [ab, ba] of byType.influence ?? []) assert.notEqual(ab.t, ba.t);
  for (const [ab] of byType.team ?? []) assert.match(ab.t, /takım arkadaşı: .+ \(\d{4}(–\d{4})?\)/);
  assert.equal(bg.relation('Q1', 'Q2'), null, 'bağlı olmayan/olmayan kişi');
});

// ---------- Zincir motoru ----------

const puzzle = (diff = 'orta', i = 0) => bg.PUZZLES[diff][i];
const notAdjacent = (q, ...others) => GRAPH.people.map((p) => p.q).find((x) => x !== q && !others.includes(x) && !bg.connected(q, x));

test('motor: doğru yol tamamlanır (son kişi hedefe bağlıysa kendiliğinden), etiketler ve puan', () => {
  const z = puzzle('orta');
  const run = bg.newRun(z, 1000);
  for (const q of z.path.slice(1, -2)) assert.equal(bg.addStep(run, q, 2000).ok, true);
  assert.equal(run.done, false);
  const fb = bg.addStep(run, z.path.at(-2), 31_000);
  assert.equal(fb.ok, true);
  assert.equal(fb.done, true);
  assert.equal(run.chain.length, 3);
  assert.deepEqual(run.final, bg.relation(z.path.at(-2), z.t));
  const pub = bg.publicRun(run, { reveal: true });
  assert.equal(pub.result.score, 1000);
  assert.equal(pub.optimal.length, 4);
  assert.equal(pub.optimal.at(-1).q, z.t);
  assert.throws(() => bg.addStep(run, z.path[1]), GameError);
});

test('motor: bağlantısız kişi yanlış deneme (adım değil); aynı kişi, bilinmeyen kimlik, başlangıç → hata', () => {
  const z = puzzle('zor');
  const run = bg.newRun(z);
  const bad = notAdjacent(z.s, z.t);
  const fb = bg.addStep(run, bad);
  assert.equal(fb.ok, false);
  assert.equal(run.wrong, 1);
  assert.equal(run.chain.length, 0);
  // Hedef seçildi ama uç ona bağlı değil → yanlış
  assert.equal(bg.addStep(run, z.t).ok, false);
  assert.equal(run.wrong, 2);
  for (const q of ['Q0', 'Q999999999999', '<script>', '', 'q42', { toString: () => 'Q1' }, 42, null]) assert.throws(() => bg.addStep(run, q), GameError, String(q));
  assert.throws(() => bg.addStep(run, z.s), /zaten zincirde/);
  bg.addStep(run, z.path[1]);
  assert.throws(() => bg.addStep(run, z.path[1]), /zaten zincirde/);
  assert.equal(run.wrong, 2, 'hatalı girdi yanlış deneme sayılmaz');
});

test('motor: silme o adımı ve sonrasını atar; ortadan koparamaz', () => {
  const z = puzzle('zor');
  const run = bg.newRun(z);
  for (const q of z.path.slice(1, 4)) bg.addStep(run, q);
  assert.equal(run.chain.length, 3);
  bg.removeStep(run, 1);
  assert.deepEqual(run.chain.map((c) => c.q), [z.path[1]]);
  for (const bad of [-1, 1, 5, 'x', 0.5, null]) assert.throws(() => bg.removeStep(run, bad), GameError);
  bg.removeStep(run, 0);
  assert.equal(run.chain.length, 0);
});

test('motor: ipucu sıradaki kişiyi (en kısa yolda) anlatır; aynı uçta tekrar ücretsiz; sınır', () => {
  const z = puzzle('zor');
  const run = bg.newRun(z);
  bg.useHint(run, 'letter');
  const next = bg.personOf(bg.shortestPath(z.s, z.t)[1]);
  assert.equal(run.hints.length, 1);
  assert.match(run.hints[0].text, new RegExp(`“${initialOf(next.n)}”`));
  bg.useHint(run, 'letter');
  assert.equal(run.hints.length, 1, 'aynı uçta aynı ipucu tekrar ücretsiz');
  bg.useHint(run, 'field');
  assert.match(run.hints[1].text, /^Sıradaki kişi: /);
  assert.throws(() => bg.useHint(run, 'path'), GameError);
  assert.throws(() => bg.useHint(run, { k: 1 }), GameError);
  bg.addStep(run, z.path[1]);
  bg.useHint(run, 'letter');
  assert.equal(run.hints.length, 3, 'yeni uç → yeni ipucu');
  assert.equal(bg.publicRun(run).result, null);
});

test(`motor: en fazla ${MAX_CHAIN} ara kişi`, () => {
  const z = puzzle('kolay');
  const run = bg.newRun(z);
  // Yapay olarak dolu zincir (küçük test grafiğinde 12 adımlık yürüyüş yok)
  run.chain = Array.from({ length: MAX_CHAIN }, (_, i) => ({ q: `Q${900000 + i}`, e: '🔗', t: 'x' }));
  assert.throws(() => bg.addStep(run, z.path[1]), new RegExp(`${MAX_CHAIN}`));
});

test('publicRun: bitmeden en kısa yol, ara kişiler ve "path" yok', () => {
  const z = puzzle('zor');
  const run = bg.newRun(z);
  bg.addStep(run, notAdjacent(z.s, z.t));
  const s = JSON.stringify(bg.publicRun(run, { reveal: true }));
  for (const q of z.path.slice(1, -1)) assert.ok(!s.includes(`"${q}"`), `ara kişi sızdı: ${q}`);
  assert.ok(!/"path"|"key"/.test(s));
  bg.giveUp(run);
  const after = bg.publicRun(run, { reveal: true });
  assert.equal(after.result.score, 0);
  assert.equal(after.optimal.length, z.path.length - 1, 'pes edince en kısa yol açılır');
});

test('günlük: aynı tarih → aynı yapboz; ardışık günler farklı; havuz döngüsü bitene kadar tekrar yok', () => {
  const a = bg.dailyPuzzle('2026-11-20');
  assert.deepEqual(bg.dailyPuzzle('2026-11-20'), a);
  assert.equal(a.diff, 'orta');
  const n = bg.PUZZLES.orta.length;
  const keys = new Set();
  const start = Date.parse('2026-11-09T00:00:00Z');
  for (let i = 0; i < n; i++) keys.add(bg.dailyPuzzle(new Date(start + i * 86_400_000).toISOString().slice(0, 10)).key);
  assert.equal(keys.size, n);
});

test('pickPuzzles: kaçınma listesi, aynı oyunda uç tekrarı yok', () => {
  const all = bg.PUZZLES.kolay.map((z) => z.key);
  const rng = { next: () => 0.3 };
  const [z] = bg.pickPuzzles('kolay', 1, rng, all.slice(1));
  assert.equal(z.key, all[0]);
  const many = bg.pickPuzzles('orta', 5, { next: Math.random });
  const ends = many.flatMap((x) => [x.s, x.t]);
  assert.equal(new Set(ends).size, ends.length);
});

test('fotoğraf adresi: sadece upload.wikimedia.org, md5 yolu, yol ayıracı/uzantı süzgeci', () => {
  const u = bg.thumbUrl('Atatürk_Kemal.jpg');
  assert.match(u, /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/Atat%C3%BCrk_Kemal\.jpg\/330px-Atat%C3%BCrk_Kemal\.jpg$/);
  for (const bad of ['../x.jpg', 'a/b.jpg', 'x.svg', 'x.tif', '', null, 'https://evil.com/x.jpg']) assert.equal(bg.thumbUrl(bad), null, String(bad));
});

test('kişi dizini: sadece ad/yıl/açıklama/alan/fotoğraf/ek ad; bağlantı yok', () => {
  const { body } = bg.peopleIndex();
  const j = JSON.parse(body);
  assert.equal(j.people.length, GRAPH.people.length);
  for (const r of j.people) assert.equal(r.length, 9);
  const s = String(body);
  for (const c of GRAPH.ctx) assert.ok(!s.includes(c.at(-1)) || GRAPH.people.some((p) => (p.s ?? '').includes(c.at(-1)) || p.n.includes(c.at(-1))), `bağlam sızdı: ${c.at(-1)}`);
  assert.ok(!/"edges"|"path"|"puzzles"/.test(s));
});
