// 🔤 Harf Çarkı birim testleri: normalleştirme + yazım payı, harf kuralı, ipucu bankası doğrulaması, çark kurma
// kuralları, günlük belirlenimcilik, run durum makinesi (pas döngüsü, süre, bitiş). Kurallar PLAN.md §4.13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tss-hc-unit-'));
process.env.HARFCARKI_SALT = 'unit-salt';
const T = await import('../../server/harfcarki-text.js');
const H = await import('../../server/harfcarki.js');
const { validate } = await import('../../content/harfcarki/validate.mjs');
const { createRng, cryptoRng } = await import('../../server/rng.js');

const { LETTERS, fold, compact, checkAnswer, editDistance, letterRuleOk, rivalIndex } = T;
const clue = (answer, alt = [], extra = {}) => ({ id: 'x', letter: 'K', mode: 'starts', answer, alt, ...extra });

test('normalleştirme: Türkçe katlama, büyük/küçük, noktalama, boşluk', () => {
  assert.equal(fold('İSTANBUL'), 'istanbul');
  assert.equal(fold('ışık'), 'isik');
  assert.equal(fold('IŞIK'), 'isik');
  assert.equal(fold('Çğıöşü ÂÎÛ'), 'cgiosu aiu');
  assert.equal(fold("  Ankara'nın   taşı! "), 'ankaranin tasi');
  assert.equal(fold('Jeanne d’Arc'), 'jeanne darc');
  assert.equal(fold('Beyoncé'), 'beyonce');
  assert.equal(fold('Fred-Çakmaktaş'), 'fred cakmaktas');
  assert.equal(compact('ay çiçeği'), 'aycicegi');
});

test('cevap kontrolü: tam eşleşme, alt biçimler, Türkçe karakter ve boşluk farkı', () => {
  const c = clue('kaplumbağa', ['kaplumbağalar']);
  for (const g of ['kaplumbağa', 'KAPLUMBAĞA', 'kaplumbaga', ' Kaplumbağa. ', 'kaplum bağa', 'Kaplumbağalar']) {
    assert.deepEqual(checkAnswer(c, g), { ok: true, exact: true }, g);
  }
  assert.equal(checkAnswer(c, '').ok, false);
  assert.equal(checkAnswer(c, '   ').ok, false);
  assert.equal(checkAnswer(c, null).ok, false);
  assert.equal(checkAnswer(clue('İzmir'), 'izmir').ok, true);
  assert.equal(checkAnswer(clue('ılık'), 'ILIK').ok, true);
  assert.equal(checkAnswer(clue('ılık'), 'ilik').ok, true, 'ı/i katlanır');
});

test('yazım payı: 6+ harfte Damerau-Levenshtein ≤ 1, kısa cevapta yok, baş harf korunur', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abcd', 'abdc'), 1, 'yer değiştirme 1');
  assert.equal(editDistance('kitap', 'kitaplar', 1), 2);
  const c = clue('kaplumbağa');
  assert.deepEqual(checkAnswer(c, 'kaplumbaa'), { ok: true, exact: false }, 'eksik harf');
  assert.equal(checkAnswer(c, 'kaplumbğaa').ok, true, 'yan yana yer değiştirme');
  assert.equal(checkAnswer(c, 'kaplumbagax').ok, true, 'fazla harf');
  assert.equal(checkAnswer(c, 'kaplumbxga').ok, true, 'değişen harf');
  assert.equal(checkAnswer(c, 'kplumbga').ok, false, 'iki hata');
  assert.equal(checkAnswer(c, 'taplumbağa').ok, false, 'baş harf hatası affedilmez (starts)');
  assert.equal(checkAnswer(clue('kalem'), 'kalen').ok, false, '5 harf: pay yok');
  assert.equal(checkAnswer(clue('kalemlik'), 'kalemlk').ok, true);
  // contains modunda baş harf serbest
  assert.equal(checkAnswer({ id: 'y', letter: 'Z', mode: 'contains', answer: 'Denizli', alt: [] }, 'Tenizli').ok, true);
});

test('yazım payı aynı harfin başka bir geçerli cevabını kabul etmez', () => {
  const a = { id: 'a', letter: 'K', mode: 'starts', answer: 'kartal', alt: [] };
  const b = { id: 'b', letter: 'K', mode: 'starts', answer: 'kartel', alt: ['karteller'] };
  const rivals = rivalIndex([a, b]);
  assert.equal(checkAnswer(a, 'kartel', rivals).ok, false, 'kartel başka ipucunun cevabı');
  assert.equal(checkAnswer(a, 'kartal', rivals).ok, true);
  assert.equal(checkAnswer(a, 'kartall', rivals).ok, true, 'rakip değil: yazım payı geçerli');
  assert.equal(checkAnswer(b, 'kartal', rivals).ok, false);
  assert.equal(checkAnswer(a, 'kartel', null).ok, true, 'rakip listesi olmadan pay geçerli (kontrol)');
});

test('harf kuralı: başlar / içerir, noktalı-noktasız I ayrımı', () => {
  assert.ok(letterRuleOk('I', 'starts', 'ılık'));
  assert.ok(!letterRuleOk('I', 'starts', 'inek'));
  assert.ok(letterRuleOk('İ', 'starts', 'İzmir'));
  assert.ok(!letterRuleOk('İ', 'starts', 'ılık'));
  assert.ok(letterRuleOk('Z', 'contains', 'Denizli'));
  assert.ok(!letterRuleOk('Z', 'contains', 'zeytin'), 'içerir modunda baş harf olamaz');
  assert.ok(!letterRuleOk('Ç', 'starts', 'cam'));
});

test('ipucu bankası: her harf ≥ 80, 0 doğrulama hatası, harf kuralı, harf içinde tekrar yok', () => {
  const bank = H._bank;
  const r = validate(bank, { minPerLetter: 80 });
  assert.deepEqual(r.errors, []);
  assert.ok(bank.length >= 2300, `toplam ${bank.length}`);
  for (const L of LETTERS) {
    const list = bank.filter((c) => c.letter === L);
    assert.ok(list.length >= 80, `${L}: ${list.length}`);
    for (const c of list) assert.ok(letterRuleOk(L, c.mode, c.answer), `${c.id} ${c.answer}`);
    const forms = list.flatMap((c) => [...new Set([c.answer, ...c.alt].map(compact))]);
    assert.equal(new Set(forms).size, forms.length, `${L}: tekrar eden cevap/alt`);
    assert.ok(list.filter((c) => c.difficulty === 1).length >= 15 && list.filter((c) => c.difficulty >= 2).length >= 15, `${L} zorluk dağılımı`);
  }
  assert.equal(new Set(bank.map((c) => c.id)).size, bank.length, 'id benzersiz');
  assert.ok(!LETTERS.includes('Ğ'));
});

test('çark: harf başına bir ipucu (sırayla), aynı cevap iki kez yok, ipucu başka cevabı ele vermez', () => {
  for (let s = 0; s < 150; s++) {
    for (const difficulty of ['easy', 'mixed', 'hard']) {
      const ids = H.composeWheel(createRng(s), { difficulty });
      const cs = ids.map((id) => H.BY_ID.get(id));
      assert.deepEqual(cs.map((c) => c.letter), LETTERS);
      const keys = cs.map((c) => compact(c.answer));
      assert.equal(new Set(keys).size, 28, `seed ${s}: aynı cevap`);
      for (const a of cs) for (const b of cs) {
        if (a === b) continue;
        const name = fold(b.answer);
        if (name.replace(/ /g, '').length >= 4) assert.ok(!` ${fold(a.clue)} `.includes(` ${name} `), `${a.id} ipucu ${b.id} cevabını içeriyor`);
      }
    }
  }
});

test('çark: zorluk ve kategori dengesi', () => {
  const tally = { easy: [0, 0, 0, 0], mixed: [0, 0, 0, 0], hard: [0, 0, 0, 0] };
  let maxCat = 0, maxContains = 0;
  for (let s = 0; s < 100; s++) {
    for (const d of Object.keys(tally)) {
      const cs = H.composeWheel(createRng(1000 + s), { difficulty: d }).map((id) => H.BY_ID.get(id));
      for (const c of cs) tally[d][c.difficulty]++;
      const cats = {};
      for (const c of cs) cats[c.category] = (cats[c.category] ?? 0) + 1;
      for (const [k, v] of Object.entries(cats)) if (k !== 'genel') maxCat = Math.max(maxCat, v);
      maxContains = Math.max(maxContains, cs.filter((c) => c.mode === 'contains').length);
    }
  }
  const avg = (d, lvl) => tally[d][lvl] / 100;
  assert.ok(avg('easy', 1) >= 20 && avg('easy', 3) === 0, JSON.stringify(tally.easy));
  assert.ok(avg('mixed', 1) >= 11 && avg('mixed', 2) >= 9 && avg('mixed', 3) >= 3 && avg('mixed', 3) <= 6, JSON.stringify(tally.mixed));
  assert.ok(avg('hard', 3) >= 8 && avg('hard', 1) <= 6, JSON.stringify(tally.hard));
  assert.ok(maxCat <= 5, `kategori tavanı (4, nadiren esner): ${maxCat}`);
  assert.ok(maxContains <= 3, `içerir ipucu: ${maxContains}`);
});

test('çark: kaçınma listesi (yakında görülenler) mümkünse tekrar etmez', () => {
  const rng = cryptoRng();
  const seen = new Set();
  for (let k = 0; k < 2; k++) {
    const ids = H.composeWheel(rng, { avoid: seen });
    for (const id of ids) { assert.ok(!seen.has(id), `tekrar ${id}`); seen.add(id); }
  }
});

test('günlük çark belirlenimci, gün sabitlenir, ardışık günler farklı', () => {
  const a = H.dailyWheel('2030-01-01');
  assert.deepEqual(H.dailyWheel('2030-01-01'), a);
  const b = H.dailyWheel('2030-01-02');
  assert.notDeepEqual(a, b);
  assert.ok(a.filter((id) => b.includes(id)).length <= 6, 'ardışık günlerde az ortak ipucu');
  assert.equal(H.dayIndex('2026-11-09'), 0);
});

test('run: ilk tur ileri, paslananlar geri gelir, yanlış tekrar sorulmaz, hepsi bitince biter', () => {
  const ids = H.composeWheel(createRng(5));
  const run = H.newRun(ids, 1000, 300_000);
  const ans = (i) => H.BY_ID.get(ids[i]).answer;
  let r = H.applyMove(run, { pos: 0, kind: 'answer', answer: ans(0) }, 2000);
  assert.deepEqual(r, { pos: 0, result: 'ok' });
  r = H.applyMove(run, { pos: 1, kind: 'answer', answer: 'zzzzqq' }, 2100);
  assert.equal(r.result, 'bad');
  r = H.applyMove(run, { pos: 2, kind: 'pass' }, 2200);
  assert.equal(r.result, 'pass');
  assert.equal(run.pos, 3);
  assert.throws(() => H.applyMove(run, { pos: 2, kind: 'pass' }, 2300), /geçildi/);
  for (let i = 3; i < 28; i++) H.applyMove(run, { pos: i, kind: i % 2 ? 'pass' : 'answer', answer: ans(i) }, 3000 + i);
  // Tur 2: sadece paslananlar (2 ve tek sayılı 3..27) çark sırasıyla
  assert.equal(run.pos, 2);
  assert.equal(run.states[1], 'bad');
  H.applyMove(run, { pos: 2, kind: 'answer', answer: ans(2) }, 5000);
  assert.equal(run.pos, 3);
  H.applyMove(run, { pos: 3, kind: 'pass' }, 5001); // tekrar pas: döngüde kalır
  assert.equal(run.pos, 5);
  while (!run.done) H.applyMove(run, { pos: run.pos, kind: 'answer', answer: ans(run.pos) }, 6000);
  assert.equal(run.reason, 'all');
  const s = H.summarize(run);
  assert.equal(s.correct, 27);
  assert.equal(s.wrong, 1);
  assert.equal(s.passed, 0);
  assert.equal(s.durationMs, 5000);
  assert.equal(s.bonus, 9, 'neredeyse 5 dk erken: tavan 9');
  assert.equal(s.points, 279);
  assert.throws(() => H.applyMove(run, { pos: 0, kind: 'pass' }, 7000), /bitti/);
});

test('run: süre sunucuda — süre + ağ payı dolunca hamle reddedilir, oyun "time" ile biter', () => {
  const ids = H.composeWheel(createRng(9));
  const run = H.newRun(ids, 0, 60_000);
  H.applyMove(run, { pos: 0, kind: 'pass' }, 59_000);
  H.applyMove(run, { pos: 1, kind: 'pass' }, 60_000 + 1000); // ağ payı içinde
  assert.throws(() => H.applyMove(run, { pos: 2, kind: 'pass' }, 60_000 + 1600), /Süre/);
  assert.equal(run.done, true);
  assert.equal(run.reason, 'time');
  assert.equal(run.finishedAt, 60_000);
  assert.equal(H.summarize(run).bonus, 0);
  // görünüm: bitince cevaplar, bitmeden yok
  const fresh = H.newRun(ids, 0, 60_000);
  const pub = JSON.stringify(H.publicRun(fresh));
  for (const id of ids) {
    const c = H.BY_ID.get(id);
    if (compact(c.answer).length >= 5) assert.ok(!pub.toLocaleLowerCase('tr').includes(`"${c.answer.toLocaleLowerCase('tr')}"`), `cevap sızdı: ${c.answer}`);
  }
  assert.equal(H.publicRun(fresh).recap, null);
  assert.equal(H.publicRun(run).recap.length, 28);
});

test('run: boş cevap ve bilinmeyen hamle reddedilir, cevap 40 karaktere kırpılır', () => {
  const run = H.newRun(H.composeWheel(createRng(3)), 0, 60_000);
  assert.throws(() => H.applyMove(run, { pos: 0, kind: 'answer', answer: '  ' }, 10), /cevap yaz/);
  assert.throws(() => H.applyMove(run, { pos: 0, kind: 'zıpla' }, 10), /Bilinmeyen/);
  H.applyMove(run, { pos: 0, kind: 'answer', answer: 'x'.repeat(500) }, 10);
  assert.equal(run.typed[0].length, 40);
  H.applyMove(run, { kind: 'quit' }, 20);
  assert.equal(run.reason, 'quit');
  assert.equal(H.summarize(run).passed, 27);
});

test('sıralama: doğru ↓, yanlış ↑, süre ↑', () => {
  const list = [
    { n: 'a', correct: 20, wrong: 3, durationMs: 100 },
    { n: 'b', correct: 22, wrong: 6, durationMs: 300 },
    { n: 'c', correct: 20, wrong: 1, durationMs: 300 },
    { n: 'd', correct: 20, wrong: 1, durationMs: 200 },
  ].sort(H.rankCmp);
  assert.deepEqual(list.map((x) => x.n), ['b', 'd', 'c', 'a']);
});
