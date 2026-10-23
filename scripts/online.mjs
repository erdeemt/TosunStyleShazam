// İnternetten oynamak için: sunucuyu + Cloudflare Quick Tunnel'ı birlikte başlatır, paylaşılacak linki yazar.
// Kullanım: npm run online   (cloudflared kurulu olmalı: winget install Cloudflare.cloudflared)
// Ctrl+C ikisini birden kapatır. Link her açılışta değişir.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT || '3000';

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? 'cloudflared'; // PATH'te varsa
}

const children = [];
const stopAll = () => { for (const c of children) if (c.exitCode == null) c.kill(); };
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'inherit', 'inherit'] });
children.push(server);
server.on('exit', (code) => { console.error(`Sunucu kapandı (${code}).`); stopAll(); process.exit(code ?? 1); });

const tunnel = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
tunnel.on('error', () => {
  console.error('\ncloudflared bulunamadı. Kurmak için:  winget install Cloudflare.cloudflared\n');
  stopAll();
  process.exit(1);
});

let shown = false;
const onData = (d) => {
  const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !shown) {
    shown = true;
    console.log(`\n  🎮 Tosun Style internette açık!\n\n  Arkadaşlarına bu linki gönder:  ${m[0]}\n\n  (Kapatmak için Ctrl+C. Link her açılışta değişir.)\n`);
  }
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);
tunnel.on('exit', (code) => { console.error(`Tünel kapandı (${code}).`); stopAll(); process.exit(code ?? 1); });
