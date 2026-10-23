// Tarayıcı testi: Online Shazam — 3 telefon; host şarkıları odaya gönderir, herkes tahmin eder, öneri listesi,
// yazarken odak korunur, tur açılır, oyun biter. (Ses dosyaları sahte: dış servise bağımlı olmasın; çalma ayrıca denenir.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

const SHOTS = fileURLToPath(new URL('../../test-results/shazam-online/', import.meta.url));
const TRACKS = [
  { title: 'Şımarık', artist: 'Tarkan', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok1.mp3' },
  { title: 'Gidiyorum', artist: 'Sezen Aksu', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok2.mp3' },
  { title: 'Kuzu Kuzu', artist: 'Tarkan', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok3.mp3' },
  // en az 3 şarkı her zaman çalınmadan kalır: 6 şarkı → 3 tur
  { title: 'Dudu', artist: 'Tarkan', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok4.mp3' },
  { title: 'Yalnızlar Rıhtımı', artist: 'Sezen Aksu', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok5.mp3' },
  { title: 'Bohemian Rhapsody', artist: 'Queen', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/yok6.mp3' },
];
let srv;
let browser;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer({ timeScale: 1 });
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Sahte ses adresleri yüklenemez (beklenen); diğer konsol hataları sayılır.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|no supported source/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${srv.url}/#/multi/shazam`);
  await page.click('.mode-card[data-mode="online"]');
  await page.fill('#shazam-online input[placeholder="Takma adın"]', name);
  return { page, errors, name };
}
const view = (p) => p.page.evaluate(async () => (await import('/net.js')).net.view);
const shot = (p, n) => p.page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: true });

test('3 telefon: oda, şarkı gönderme, tahmin, öneri, odak, açılış, final', async () => {
  const [host, ayse, mert] = await Promise.all(['Ali', 'Ayşe', 'Mert'].map(phone));
  await host.page.click('#shazam-online >> text=Yeni oda kur');
  const code = (await host.page.locator('.lobby-code').textContent()).trim();
  for (const p of [ayse, mert]) {
    await p.page.fill('#shazam-online .code-input', code);
    await p.page.click('#shazam-online button:has-text("Katıl")');
  }
  await host.page.waitForFunction(() => document.querySelectorAll('#shazam-online .player-list li').length === 3);
  // Şarkı yokken başlatılamaz; misafirde "oda sahibi ekliyor"
  assert.match(await ayse.page.locator('#shazam-online').textContent(), /Oda sahibi şarkıları ekliyor/);
  // Host şarkıları odaya gönderir (link çözümleme dış servise gider; burada doğrudan prep)
  await host.page.evaluate(async (tracks) => {
    const { net } = await import('/net.js');
    net.send({ t: 'prep', data: { op: 'add', source: 'Test', tracks } });
  }, TRACKS);
  await ayse.page.waitForSelector('text=Odada 6 şarkı');
  await host.page.locator('#shazam-online label', { hasText: 'Şarkı sayısı' }).locator('select').selectOption('5');
  await shot(host, '00-lobby-host');
  await host.page.click('#shazam-online button:has-text("Oyunu başlat")');

  // Tur 1: Ayşe yazarken (başkası tahmin edince ekran yeniden çizilir) odak ve metin korunmalı
  await ayse.page.waitForSelector('#ol-guess');
  await ayse.page.click('#ol-guess');
  await ayse.page.keyboard.type('ta');
  await mert.page.waitForSelector('#ol-guess');
  await mert.page.click('button:has-text("Geç")'); // Mert geçer → herkese yeni görünüm
  await ayse.page.waitForTimeout(400);
  assert.equal(await ayse.page.evaluate(() => document.activeElement?.id), 'ol-guess', 'yeniden çizimde odak kaçtı');
  assert.equal(await ayse.page.inputValue('#ol-guess'), 'ta', 'yazılan metin kayboldu');
  // Öneri listesi
  assert.ok(await ayse.page.locator('#ol-ac button', { hasText: 'Tarkan' }).count() >= 1, 'öneri çıkmadı');
  await shot(ayse, '01-typing-suggestions');

  // Doğru cevap: istemci bilmiyor → test sunucunun görünümünden değil, havuzdan dener
  const titles = TRACKS.map((t) => t.title);
  async function solve(p) {
    for (const t of titles) {
      const v = await view(p);
      if (!v.me || v.me.done || v.phase !== 'play') return;
      const before = v.me.guesses.length;
      await p.page.fill('#ol-guess', t);
      await p.page.press('#ol-guess', 'Enter');
      // sunucu bu tahmini işleyene kadar bekle (sabit bekleme kararsızdı)
      for (let i = 0; i < 60; i++) {
        const nv = await view(p);
        if (!nv.me || nv.phase !== 'play' || nv.me.done || nv.me.guesses.length > before) break;
        await p.page.waitForTimeout(50);
      }
    }
  }
  await ayse.page.fill('#ol-guess', '');
  for (const p of [host, ayse, mert]) await solve(p);
  // Herkes bitince açılır
  await host.page.waitForSelector('#shazam-online .reveal-title');
  const title = await host.page.locator('#shazam-online .reveal-title').textContent();
  assert.ok(titles.includes(title.trim()));
  await shot(host, '02-reveal-host');
  await shot(mert, '02-reveal-guest');
  assert.equal(await mert.page.locator('button:has-text("Sonraki şarkı")').count(), 0, 'misafirde sonraki düğmesi olmamalı');

  // Kalan turlar: hızlıca bitir
  for (let round = 2; round <= 3; round++) {
    await host.page.click('button:has-text("Sonraki şarkı"), button:has-text("Sonuçları göster")');
    await host.page.waitForFunction((r) => document.body.innerText.includes(`Şarkı ${r} / 3`), round);
    for (const p of [host, ayse, mert]) await solve(p);
    await host.page.waitForSelector('#shazam-online .reveal-title');
  }
  await host.page.click('button:has-text("Sonuçları göster")');
  await host.page.waitForSelector('text=Final skorları');
  await shot(host, '03-over');
  const v = await view(host);
  assert.equal(v.phase, 'over');
  assert.ok(v.players.every((p) => p.score > 0), 'herkes en az bir puan almalı');

  for (const p of [host, ayse, mert]) assert.deepEqual(p.errors, [], `${p.name} konsol hatası`);
});
