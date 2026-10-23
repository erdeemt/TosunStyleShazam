// Sunucu tahmin kontrolü (online Shazam) — tek oyunculu kopya ile aynı kurallar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrect, trackKey } from '../../server/matcher.js';

test('tek tahminde birden çok şarkı adı yazma hilesi tutmaz; sanatçı + şarkı adı tutar', () => {
  const t = { title: 'Şımarık', artist: 'Tarkan' };
  assert.equal(isCorrect('simarik gidiyorum bohemian rhapsody yalnizlar rihtimi dudu kuzu kuzu', t), false);
  assert.equal(isCorrect('tarkan şımarık', t), true);
  assert.equal(isCorrect('şımarık - tarkan', t), true);
});

test('Latin dışı alfabeler (Kiril vb.) bilinebilir', () => {
  assert.equal(isCorrect('Звезда', { title: 'Звезда', artist: 'Кино' }), true);
});

test('sanatçısı olmayan / Latin dışı şarkılar birbirinin üstüne yazılmaz', () => {
  assert.notEqual(trackKey({ title: 'Song A', ytId: 'aaaaaaaaaaa' }), trackKey({ title: 'Song A', ytId: 'bbbbbbbbbbb' }));
});
