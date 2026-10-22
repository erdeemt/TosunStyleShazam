// data/ altında JSON dosyalarına kalıcı kayıt (kimlikler, günlük sonuçlar). Yazmalar gecikmeli ve atomik.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || join(fileURLToPath(new URL('..', import.meta.url)), 'data');
mkdirSync(DATA_DIR, { recursive: true });

export function jsonStore(name, fallback) {
  const file = join(DATA_DIR, `${name}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
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
