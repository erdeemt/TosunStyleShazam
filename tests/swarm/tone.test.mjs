// 🔊 Ton Avı lobi sürü testleri (senaryolar: recall-lib.mjs).
import { recallSuite } from './recall-lib.mjs';

recallSuite('tone', {
  // Her bot/tur için benzersiz frekans; bot 0 hedefi birebir bilir.
  guessFor: (i, round, target) => (i === 0 && target ? target : Math.round((101.3 + i * 97.7 + round * 13.1) * 10) / 10),
  invalid: 'çok tiz',
  outOfRange: 99999,
  clampedTo: 1200,
});
