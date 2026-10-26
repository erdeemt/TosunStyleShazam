// Testler için sunucuyu boş bir portta başlatır, gerçek portu stdout'tan okur.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Botlar aynı IP'den bağlandığı için IP sınırları testlerde gevşek; güvenlik testleri env ile sıkılaştırır.
const LOOSE_LIMITS = { WORDLE_SALT: 'test-salt', RECALL_SALT: 'test-salt', PERCEPTLE_SALT: 'test-salt',LIMIT_HTTP_PER_MIN: '100000', LIMIT_UPSTREAM_PER_MIN: '100000', LIMIT_IDENTITIES_PER_HOUR: '100000', LIMIT_SOCKETS_PER_IP: '100000', LIMIT_ROOMS_PER_IP: '100000' };

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function startServer({ timeScale = 0.02, seed = 1, env = {}, dataDir } = {}) {
  // Her test sunucusu kendi geçici veri klasörünü kullanır (data/ kirlenmesin). Aynı klasörle yeniden başlatma testi için dataDir verilebilir.
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'tss-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TIME_SCALE: String(timeScale), SEED: String(seed), TEST_GAMES: '1', DATA_DIR: dir, ...LOOSE_LIMITS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sunucu başlamadı:\n${log}`)), 10_000);
    child.stdout.on('data', (d) => {
      log += d;
      const m = String(d).match(/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Sunucu kapandı (${code}):\n${log}`)); });
  });
  return {
    port,
    dataDir: dir,
    url: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    log: () => log,
    stop: () => new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }),
  };
}
