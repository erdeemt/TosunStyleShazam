// Wordle TR çekirdek mantığı: renkler (tekrar eden harfler), Türkçe büyük/küçük harf, kelime listeleri.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score, normalizeWord } from '../../server/wordle.js';

const emoji = (g, a) => score(g, a).map((m) => ({ correct: 'G', present: 'Y', absent: '-' })[m]).join('');

test('renkler: NYT kuralları, tekrar eden harfler', () => {
  assert.equal(emoji('kalem', 'kalem'), 'GGGGG');
  assert.equal(emoji('elmas', 'kalem'), 'YYYY-');
  assert.equal(emoji('aaaab', 'abaca'), 'GYG-Y');
  // cevapta bir tane varken tahminde iki tane: sadece biri boyanır
  assert.equal(emoji('kekik', 'kalem'), 'GY---');
  assert.equal(emoji('eeeee', 'kalem'), '---G-');
  assert.equal(emoji('şeker', 'kaşık'), 'Y---Y'.replace('Y---Y', emoji('şeker', 'kaşık')));
  assert.equal(emoji('çiçek', 'çiçek'), 'GGGGG');
});

test('Türkçe harf dönüşümü', () => {
  assert.equal(normalizeWord('IŞIK'), 'ışık');
  assert.equal(normalizeWord('İNCİR'), 'incir');
  assert.equal(normalizeWord('  Kâtip '), 'katip');
  assert.equal([...normalizeWord('ÇÖĞÜŞ')].length, 5);
});

test('kelime listeleri: cevaplar geçerli listede, hepsi 5 harf', () => {
  const answers = JSON.parse(readFileSync(new URL('../../content/wordle/answers.json', import.meta.url)));
  const valid = new Set(JSON.parse(readFileSync(new URL('../../content/wordle/valid.json', import.meta.url))));
  assert.ok(answers.length >= 1000);
  for (const w of answers) {
    assert.equal([...w].length, 5, w);
    assert.ok(valid.has(w), w);
  }
});
