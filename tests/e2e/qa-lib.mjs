// QA yardımcıları: çok telefonlu Casus Kim? senaryoları için ortak araçlar (qa-*.test.mjs dosyaları kullanır).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';

export const SHOTS = fileURLToPath(new URL('../../test-results/qa/', import.meta.url));

export async function setup({ timeScale = 0.05 } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  const srv = await startServer({ timeScale, seed: 1, env: { TEST_GAMES: '' } });
  const browser = await chromium.launch({ channel: 'chrome' });
  return { srv, browser, close: async () => { await browser.close(); await srv.stop(); } };
}

export const MOBILE = { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, bypassCSP: true };
export const DESKTOP = { viewport: { width: 1280, height: 800 }, bypassCSP: true };

// Bir "telefon": ayrı bağlam (ayrı localStorage). Diyaloglar (confirm/prompt) otomatik kabul edilir.
export async function phone(env, name, { desktop = false, hash = '#/multi/spyfall', promptAnswer, ctx } = {}) {
  const context = ctx ?? await env.browser.newContext(desktop ? DESKTOP : MOBILE);
  const page = await context.newPage();
  const p = { name, ctx: context, page, errors: [], frames: [], dialogs: [] };
  attach(p, page, promptAnswer ?? name);
  if (hash != null) {
    await page.goto(`${env.srv.url}/${hash}`);
    if (hash.startsWith('#/multi/')) {
      await page.waitForSelector('input[placeholder="Takma adın"]');
      await page.fill('input[placeholder="Takma adın"]', name);
    }
  }
  return p;
}

export function attach(p, page, promptAnswer) {
  page.on('pageerror', (e) => p.errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') p.errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => { p.dialogs.push(`${d.type()}: ${d.message()}`); d.accept(d.type() === 'prompt' ? promptAnswer : undefined); });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => p.frames.push(String(f.payload))));
}

// İstemcinin gördüğü durum (net.js tekil nesnesi)
export async function state(page) {
  return page.evaluate(async () => {
    const { net } = await import('/net.js');
    return { room: net.room, view: net.view, playerId: net.playerId, connected: net.connected, name: net.name };
  });
}

export async function waitFor(page, fnSrc, arg, timeout = 15000) {
  return page.waitForFunction(fnSrc, arg, { timeout });
}

// net.js'e göre bekle: predicate (room, view, playerId) => boolean, sayfa içinde çalışır.
export async function waitNet(page, predicate, timeout = 15000) {
  // Not: sayfanın CSP'si eval/new Function'ı engeller; koşul burada metin olarak birleştirilip
  // Playwright'a ifade olarak verilir (CDP üzerinden çalışır, CSP'ye takılmaz).
  await page.evaluate(async () => { window.__qaNet = (await import('/net.js')).net; });
  const expr = `(() => { const net = window.__qaNet; const room = net.room, view = net.view, me = net.playerId;
    try { return !!(${predicate}); } catch { return false; } })()`;
  await page.waitForFunction(expr, undefined, { timeout, polling: 100 });
}

export async function shot(p, label) {
  const path = `${SHOTS}${label}.png`;
  await p.page.screenshot({ path, fullPage: true });
  return path;
}

export async function createRoom(host) {
  await host.page.click('text=Yeni oda kur');
  await host.page.waitForSelector('.lobby-code');
  return (await host.page.locator('.lobby-code').textContent()).trim();
}

export async function joinCode(p, code) {
  await p.page.fill('.code-input', code.toLowerCase());
  await p.page.click('button:has-text("Katıl")');
  await p.page.waitForSelector('.lobby-code, .room-bar');
}

export async function startGame(host, players) {
  await host.page.click('#game-spyfall button:has-text("Oyunu başlat")');
  for (const p of players) await waitNet(p.page, "room && room.phase === 'playing' && view && view.phase === 'play'");
}

export async function setSetting(host, label, value) {
  const sel = host.page.locator('#game-spyfall label', { hasText: label }).locator('select');
  await sel.selectOption(String(value));
}

// Herkesin rolünü çıkar: { spy: [p], town: [p] }
export async function roles(players) {
  const spy = []; const town = [];
  for (const p of players) {
    const s = await state(p.page);
    (s.view?.me?.spy ? spy : town).push(p);
    p.id = s.playerId;
  }
  return { spy, town };
}

// İstemci konsol hatalarını, yok sayılacak bilinen gürültüden (YouTube API, font) ayıkla.
export function realErrors(p) {
  return p.errors.filter((e) => !/youtube|fonts\.g|ERR_INTERNET|net::ERR/i.test(e));
}

// 360 px'te yatay taşma var mı?
export async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    for (const n of document.querySelectorAll('#game-spyfall *, #view-home *, .sidebar *')) {
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > w + 1 || r.left < -1) && n.offsetParent !== null) bad.push(`${n.tagName}.${n.className}:${Math.round(r.left)}-${Math.round(r.right)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, w, bad: bad.slice(0, 10) };
  });
}

// Görünür butonlardan 44 px'ten küçük olanlar
export async function smallButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('#game-spyfall button, #game-spyfall a.btn, #game-spyfall select, #game-spyfall input')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.placeholder || b.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.h < 44 || x.w < 44));
}
