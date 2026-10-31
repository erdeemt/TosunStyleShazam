// QA yardımcıları: 🎵 Shazam online mod (qa-shazam-online-*.mjs). Dış servise gitmeden oynamak için
// sahte şarkılar `prep` mesajıyla odaya konur; ses/kapak adresleri (bilinen CDN alan adları) Playwright ile
// yerelde üretilen 30 sn'lik WAV / SVG ile yanıtlanır → telefonlar gerçekten yükleyip çalabilir.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { trackOfView } from '../lib/shazam-keys.js';

export const SHOTS = fileURLToPath(new URL('../../test-results/qa-shazam-online/', import.meta.url));
export const MOBILE = { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, bypassCSP: true };
export const DESKTOP = { viewport: { width: 1280, height: 800 }, bypassCSP: true };

export async function setup({ timeScale = 0.2 } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  const srv = await startServer({ timeScale, seed: 1, env: { TEST_GAMES: '' } });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  return { srv, browser, close: async () => { await browser.close(); await srv.stop(); } };
}

// 30 sn, 8 kHz, 8 bit mono, 440 Hz ton
function wav(seconds = 30) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}
export const WAV = wav();
const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#7c3aed"/><text x="150" y="160" font-size="34" text-anchor="middle" fill="#fff">${label}</text></svg>`;

// Ayırt edici adlar: sızıntı taramasında başka alanlarla karışmasın.
const NAMES = [
  ['Zümrüt Kuyu', 'Qarnavalcı Ayten'], ['Çilekli Bulut', 'Xenon Ferhat'], ['Mavi Tren', 'Jüpiter Nesrin'],
  ['Gece Yolcusu', 'Vadi Orhan'], ['Pamuk Eller', 'Kristal Sevim'], ['Fırtına Kızı', 'Okyanus Remzi'],
  ['Limon Ağacı', 'Galaksi Nur'], ['Kırmızı Balon', 'Tundra Selim'], ['Sarı Fener', 'Kuzey Melek'],
  ['Kayıp Anahtar', 'Bozkır Cemil'], ['Gümüş Nehir', 'Ufuk Leyla'], ['Bambu Dansı', 'Plato Hikmet'],
];
export function makeTracks(n = 6, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const [title, artist] = NAMES[(i + offset) % NAMES.length];
    const k = i + offset;
    return {
      title, artist,
      audio: `https://cdnt-preview.dzcdn.net/api/1/1/q/a/0/0/qa${k}.mp3`,
      cover: `https://e-cdns-images.dzcdn.net/images/cover/qa${k}/500x500.jpg`,
      spotifyId: `QASPOTIFYID${String(k).padStart(4, '0')}`,
    };
  });
}

// Bir "telefon": ayrı bağlam. Gelen/giden WS çerçeveleri kaydedilir.
export async function phone(env, name, { desktop = false, hash = '#/multi/shazam', online = true, ctx } = {}) {
  const context = ctx ?? await env.browser.newContext(desktop ? DESKTOP : MOBILE);
  await context.route(/https:\/\/cdnt-preview\.dzcdn\.net\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await context.route(/https:\/\/e-cdns-images\.dzcdn\.net\/.*/, (route) => {
    const m = route.request().url().match(/cover\/(qa\d+)/);
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG(m?.[1] ?? 'kapak') });
  });
  const page = await context.newPage();
  const p = { name, ctx: context, page, errors: [], frames: [], sent: [], dialogs: [], audioReqs: [], sockets: [] };
  attach(p, page);
  if (hash != null) {
    await page.goto(`${env.srv.url}/${hash}`);
    if (online) {
      await page.click('.mode-card[data-mode="online"]');
      await page.waitForSelector('#shazam-online input[placeholder="Takma adın"]');
      await page.fill('#shazam-online input[placeholder="Takma adın"]', name);
    }
  }
  return p;
}

export function attach(p, page) {
  page.on('pageerror', (e) => p.errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') p.errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => { p.dialogs.push(`${d.type()}: ${d.message()}`); d.accept(d.type() === 'prompt' ? p.name : undefined); });
  page.on('websocket', (ws) => {
    const rec = { url: ws.url(), closed: false };
    (p.sockets ??= []).push(rec);
    ws.on('close', () => { rec.closed = true; });
    ws.on('framereceived', (f) => p.frames.push(String(f.payload)));
    ws.on('framesent', (f) => p.sent.push(String(f.payload)));
  });
  // Online modda ses sadece sunucu vekilinden (/api/clip/<opak>); tarayıcı CDN'e ses isteği atmamalı
  page.on('request', (r) => { if (/dzcdn|scdn|ytimg|googlevideo/.test(r.url())) p.audioReqs.push(r.url()); });
  page.on('request', (r) => { if (r.url().includes('/api/clip/')) (p.clipReqs ??= []).push(r.url()); });
}

export function realErrors(p) {
  return p.errors.filter((e) => !/youtube|fonts\.g|ERR_INTERNET|net::ERR|www-widgetapi|doubleclick|Failed to load resource: the server responded with a status of 4\d\d/i.test(e));
}

export async function st(page) {
  return page.evaluate(async () => {
    const { net } = await import('/net.js');
    return { room: net.room, view: net.view, playerId: net.playerId, connected: net.connected };
  });
}

export async function waitNet(page, predicate, timeout = 15000) {
  await page.evaluate(async () => { window.__qaNet = (await import('/net.js')).net; });
  const expr = `(() => { const net = window.__qaNet; const room = net.room, view = net.view, me = net.playerId;
    try { return !!(${predicate}); } catch { return false; } })()`;
  await page.waitForFunction(expr, undefined, { timeout, polling: 50 });
}

export async function shot(p, label) {
  const path = `${SHOTS}${label}.png`;
  await p.page.screenshot({ path, fullPage: true });
  return path;
}

export async function createRoom(host) {
  await host.page.click('#shazam-online >> text=Yeni oda kur');
  await host.page.waitForSelector('#shazam-online .lobby-code');
  return (await host.page.locator('#shazam-online .lobby-code').textContent()).trim();
}

export async function joinCode(p, code) {
  await p.page.fill('#shazam-online .code-input', code);
  await p.page.click('#shazam-online button:has-text("Katıl")');
  await p.page.waitForSelector('#shazam-online .lobby-code, #shazam-online .room-bar');
}

export async function room(env, names, { desktopHost = false } = {}) {
  const ps = [];
  for (const [i, nm] of names.entries()) ps.push(await phone(env, nm, { desktop: desktopHost && i === 0 }));
  const code = await createRoom(ps[0]);
  for (const p of ps.slice(1)) await joinCode(p, code);
  await waitNet(ps[0].page, `room.players.length === ${names.length}`);
  for (const p of ps) p.id = (await st(p.page)).playerId;
  return { ps, code, host: ps[0] };
}

export async function injectTracks(host, tracks, source = 'QA Liste', op = 'add') {
  await host.page.evaluate(async ({ tracks, source, op }) => {
    const { net } = await import('/net.js');
    net.send({ t: 'prep', data: { op, source, tracks } });
  }, { tracks, source, op });
}

export async function setSetting(host, label, value) {
  await host.page.locator('#shazam-online label', { hasText: label }).locator('select').selectOption(String(value));
}

export async function start(host, ps) {
  await host.page.click('#shazam-online button:has-text("Oyunu başlat")');
  for (const p of ps) await waitNet(p.page, "room && room.phase === 'playing' && view && view.phase === 'play'");
}

// Bu turun şarkısı: istemciye şarkı kimliği gitmez; test sunucusunda tur anahtarı başlıktan türetilir (tests/lib/shazam-keys.js)
export function trackOf(view, tracks) {
  return trackOfView(view, tracks);
}

// Sunucu bu oyuncunun eylemini işleyene kadar bekle
export async function act(p, fn, { timeout = 8000 } = {}) {
  const before = await st(p.page);
  const n = before.view?.me?.guesses.length ?? 0;
  await fn();
  try {
    await waitNet(p.page, `!view.me || view.phase !== 'play' || view.me.done || view.me.guesses.length > ${n}`, timeout);
  } catch (err) {
    const now = await st(p.page);
    const ui = await p.page.evaluate(() => ({ input: document.getElementById('ol-guess')?.value, label: document.querySelector('#shazam-online .play-label')?.textContent }));
    throw new Error(`${p.name}: eylem işlenmedi. son gönderilenler: ${p.sent.slice(-3).join(' || ')} | me: ${JSON.stringify(now.view?.me)} round ${now.view?.round} | ui ${JSON.stringify(ui)}`);
  }
}

export async function guess(p, text) {
  await act(p, async () => {
    // Not: başkasının ilerlemesi ekranı yeniden çizerken yazılan metin kaybolabiliyor (ayrı testte raporlanıyor);
    // burada puan/akış sınandığı için metin gerçekten kutuya girene kadar tekrar dene.
    for (let i = 0; i < 5; i++) {
      await p.page.fill('#ol-guess', text);
      if (await p.page.inputValue('#ol-guess').catch(() => '') === text) break;
    }
    await p.page.press('#ol-guess', 'Enter');
  });
}
export async function skip(p) {
  await act(p, () => p.page.click('#shazam-online .guess-form button.ghost:has-text("Geç")'));
}
// "🏳️ Pes et" (her adımda; onay penceresi otomatik kabul edilir)
export async function giveUp(p) {
  await p.page.click('#shazam-online button:has-text("Pes et")');
  await waitNet(p.page, "view.phase !== 'play' || !view.me || view.me.done");
}
// Şarkı hazır olunca kendiliğinden 3-2-1 + çalma; ilk çalma bitene kadar bekle
export async function waitAutoPlayDone(p, timeout = 15000) {
  await p.page.waitForFunction(() => {
    const b = document.querySelector('#shazam-online .play-btn');
    const l = document.querySelector('#shazam-online .play-label')?.textContent ?? '';
    return b && !b.classList.contains('playing') && !b.disabled && / sn dinle$/.test(l);
  }, undefined, { timeout, polling: 50 });
}

// Ekrandaki yatay taşma
export async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    for (const n of document.querySelectorAll('#game-shazam *')) {
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > w + 1 || r.left < -1) && n.offsetParent !== null && !n.closest('.yt-wrap')) bad.push(`${n.tagName}.${n.className}:${Math.round(r.left)}-${Math.round(r.right)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, w, bad: bad.slice(0, 10) };
  });
}

export async function smallButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('#shazam-online button, #shazam-online select, #shazam-online input, #shazam-online textarea')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.placeholder || b.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.h < 44 || x.w < 44));
}

// Açılıştan önceki görünüm/oda çerçevelerinde (öneri havuzu hariç) şarkı bilgisi var mı?
export function leaks(p, track, round) {
  const needles = [track.title, track.artist, track.cover, track.spotifyId].filter(Boolean);
  const out = [];
  for (const raw of p.frames) {
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.t === 'view' && m.view && m.view.round === round && m.view.phase === 'play') {
      // Öneri havuzu (kabul edilmiş) ve oyuncunun KENDİ yazdığı tahminler hariç
      const v = { ...m.view, pool: undefined, me: m.view.me && { ...m.view.me, guesses: m.view.me.guesses.filter((g) => !g.ok) } };
      const s = JSON.stringify(v);
      for (const n of needles) if (s.includes(n)) out.push(`view r${round}: ${n}`);
    }
  }
  return out;
}
