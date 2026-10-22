// Testler için sunucuyu boş bir portta başlatır, gerçek portu stdout'tan okur.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function startServer({ timeScale = 0.02, seed = 1, env = {} } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TIME_SCALE: String(timeScale), SEED: String(seed), TEST_GAMES: '1', ...env },
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
