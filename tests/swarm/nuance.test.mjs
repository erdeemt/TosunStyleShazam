// 🎨 Nüans lobi sürü testleri (senaryolar: recall-lib.mjs).
import { recallSuite } from './recall-lib.mjs';

const hex2 = (n) => n.toString(16).padStart(2, '0');

recallSuite('nuance', {
  // Her bot/tur için benzersiz cevap (sızıntı taraması metin araması yapar); bot 0 hedefi birebir bilir.
  guessFor: (i, round, target) => (i === 0 && target ? target : `#${hex2(17 + i * 23)}${hex2(round * 40)}${hex2(201 - i)}`),
  invalid: 'kırmızı',
});
