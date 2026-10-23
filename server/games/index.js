// Sunucu tarafı oyun modülleri. Yeni lobili oyun: modülü yaz, buraya ekle (bkz. PLAN.md §3.2).
import testGame from './_test.js';
import spyfall from './spyfall.js';
import vampir from './vampir.js';
import shazam from './shazam.js';

export const GAMES = {
  [spyfall.id]: spyfall,
  [vampir.id]: vampir,
  [shazam.id]: shazam,
};

// Lobi altyapısını gerçek oyunlardan bağımsız test etmek için; sadece TEST_GAMES=1 iken açık.
if (process.env.TEST_GAMES === '1') GAMES[testGame.id] = testGame;
