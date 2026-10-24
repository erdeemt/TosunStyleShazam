// data/ altında JSON dosyalarına kalıcı kayıt (kimlikler, günlük sonuçlar). Yazmalar gecikmeli ve atomik.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || join(fileURLToPath(new URL('..', import.meta.url)), 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Aynı ada ikinci çağrı aynı kaydı döner (ör. secrets: wordle ve recall birbirinin tuzunu ezmesin).
const stores = new Map();

export function jsonStore(name, fallback) {
  if (!stores.has(name)) stores.set(name, openStore(name, fallback));
  return stores.get(name);
}

function openStore(name, fallback) {
  const file = join(DATA_DIR, `${name}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Dosya yoksa boş başla; bozuksa sessizce sıfırlama (tuzlar değişir, kayıtlar silinirdi): dur.
    if (err.code !== 'ENOENT') throw new Error(`data/${name}.json okunamadı: ${err.message}`);
    data = structuredClone(fallback);
  }
  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  return {
    data,
    save() {
      if (!timer) timer = setTimeout(flush, 500);
    },
    flushNow() {
      clearTimeout(timer);
      flush();
    },
  };
}
