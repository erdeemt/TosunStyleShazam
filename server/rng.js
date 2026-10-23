// Tohumlu rastgele sayı üreteci (mulberry32). Testlerde SEED ile oyunlar tekrarlanabilir olur.
import { randomInt } from 'node:crypto';

// Gizli atamalar (roller, casus, mekân) için: çıktılarından iç durum geri hesaplanamaz.
export function cryptoRng() {
  const rng = {
    seed: null,
    next: () => randomInt(2 ** 48 - 1) / 2 ** 48,
    int: (n) => randomInt(n),
    pick: (arr) => arr[randomInt(arr.length)],
    shuffle(arr) {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
}

// Tohumlu üreteç: SADECE testlerde (SEED) ve gizli olmayan işler için. Çıktısını istemciye gönderme —
// mulberry32'nin iç durumu tek bir çıktıdan geri hesaplanabilir.

export function createRng(seed = randomInt(2 ** 31)) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    seed,
    next,
    int: (n) => Math.floor(next() * n), // 0..n-1
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
}

// Metinden sabit tohum (günlük bulmacalar: "wordle:2026-10-22" → herkese aynı kelime).
export function seedFrom(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
