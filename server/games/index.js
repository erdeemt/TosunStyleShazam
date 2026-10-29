// Sunucu tarafı oyun modülleri. Yeni lobili oyun: modülü yaz, buraya ekle (bkz. PLAN.md §3.2).
import testGame from './_test.js';
import spyfall from './spyfall.js';
import vampir from './vampir.js';
import nuance from './nuance.js';
import tone from './tone.js';
import shazam from './shazam.js';
import perceptle from './perceptle.js';

export const GAMES = {
  [spyfall.id]: spyfall,
  [vampir.id]: vampir,
  [nuance.id]: nuance,
  [tone.id]: tone,
  [shazam.id]: shazam,
  [perceptle.id]: perceptle,
};

// Lobi altyapısını gerçek oyunlardan bağımsız test etmek için; sadece TEST_GAMES=1 iken açık.
if (process.env.TEST_GAMES === '1') GAMES[testGame.id] = testGame;
