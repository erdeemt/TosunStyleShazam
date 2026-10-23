// QA yardımcıları: çok telefonlu 🧛 Vampir Köylü senaryoları (qa-vampir-*.test.mjs dosyaları kullanır).
// Genel araçlar qa-lib.mjs'den gelir; burada sadece Vampir'e özgü olanlar var.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../lib/server.js';
import { phone as qaPhone, state, waitNet, realErrors } from './qa-lib.mjs';

export { state, waitNet, realErrors };
export const SHOTS = fileURLToPath(new URL('../../test-results/qa-vampir/', import.meta.url));

export async function setup({ timeScale = 0.25, seed = 1 } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  const srv = await startServer({ timeScale, seed, env: { TEST_GAMES: '' } });
  const browser = await chromium.launch({ channel: 'chrome' });
  return { srv, browser, timeScale, close: async () => { await browser.close(); await srv.stop(); } };
}

export async function phone(env, name, opts = {}) {
  return qaPhone(env, name, { hash: '#/multi/vampir', ...opts });
}

export async function shot(p, label) {
  const path = `${SHOTS}${label}.png`;
  await p.page.screenshot({ path, fullPage: true });
  return path;
}

// Odayı kur, herkesi kat, ayarları host arayüzünden yap, başlat. Dönen telefonlarda id + role var.
// settings: { 'Gece süresi': '120', 'Deli': false, ... } (etiket metni → değer; checkbox için boolean)
export async function startGame(env, names, { desktop = [], settings = {} } = {}) {
  const phones = [];
  for (const n of names) phones.push(await phone(env, n, { desktop: desktop.includes(n) }));
  const host = phones[0];
  await host.page.click('text=Yeni oda kur');
  await host.page.waitForSelector('.lobby-code');
  const code = (await host.page.locator('.lobby-code').textContent()).trim();
  for (const p of phones.slice(1)) {
    await p.page.fill('.code-input', code.toLowerCase());
    await p.page.click('button:has-text("Katıl")');
    await p.page.waitForSelector('.lobby-code, .room-bar');
  }
  await waitNet(host.page, `room && room.players.length === ${phones.length}`);
  await applySettings(host, settings);
  await host.page.click('#game-vampir button:has-text("Oyunu başlat")');
  for (const p of phones) await waitNet(p.page, "room && room.phase === 'playing' && view && view.phase === 'night'");
  await identify(phones);
  return { phones, host, code };
}

export async function applySettings(host, settings) {
  for (const [label, value] of Object.entries(settings)) {
    const lab = host.page.locator('#game-vampir label', { hasText: label });
    if (typeof value === 'boolean') {
      const box = lab.locator('input[type=checkbox]');
      if ((await box.isChecked()) !== value) await box.click();
    } else {
      await lab.locator('select').selectOption(String(value));
    }
    await host.page.waitForTimeout(150);
  }
  const want = JSON.stringify(settings);
  await host.page.waitForTimeout(200);
  return want;
}

export async function identify(phones) {
  for (const p of phones) {
    const s = await state(p.page);
    p.id = s.playerId;
    p.role = s.view?.me?.role;
  }
  return phones;
}

export const byRole = (phones, role) => phones.filter((p) => p.role === role);
export const nameOfId = (phones, id) => phones.find((p) => p.id === id)?.name;

// Gece: hedef düğmesine gerçek tıklama (ad tam eşleşme; "(sen)" eki olabilir)
const targetBtn = (p, targetName) => p.page.locator('#game-vampir .target', { hasText: new RegExp(`^${targetName}( \\(sen\\))?`) }).first();

// Gerçek oyuncu gibi: seçim sadece kart açıkken yapılabildiği için kart kapalıysa önce açar (PLAN §4.3).
export async function nightClick(p, targetName) {
  if (await p.page.locator('#game-vampir .role-card.hidden-card').count()) await p.page.click('#game-vampir .role-card');
  await targetBtn(p, targetName).click();
}

// Kart KAPALIYKEN dokunma (ipucu testleri: herkes için aynı tepki olmalı).
export async function closedTap(p, targetName) {
  await targetBtn(p, targetName).click();
}

// Kart kapalıyken gece ekranının "görünen imzası": metin (adlar ve 'sen' normalize), düğme sayısı,
// pasif düğmelerin kime ait olduğu (ben/başkası), seçili sınıflar, kart sınıfı.
export async function nightSignature(p) {
  return p.page.evaluate(() => {
    const root = document.getElementById('game-vampir');
    const targets = [...root.querySelectorAll('.target')];
    return {
      cardClass: root.querySelector('.role-card')?.className,
      cardText: root.querySelector('.role-card')?.innerText,
      hint: root.querySelector('.card .hint')?.innerText,
      nTargets: targets.length,
      disabled: targets.filter((b) => b.disabled).map((b) => (b.innerText.includes('(sen)') ? 'SELF' : 'OTHER:' + b.innerText.trim())),
      chosen: targets.filter((b) => b.classList.contains('chosen')).length,
      allyTags: root.querySelectorAll('.ally-pick').length,
      seerList: root.querySelectorAll('.seer-list').length,
      textLen: root.innerText.length,
    };
  });
}

// Gece metni: oyuncunun kendi adını ve '(sen)' etiketlerini çıkararak herkes için karşılaştırılabilir hale getir
export async function normalizedText(p) {
  const txt = await p.page.locator('#game-vampir').innerText();
  return txt.replace(/\d+:\d\d/g, 'T').replace(/ \(sen\)/g, '').replace(/\nsen\n/g, '\n');
}

export async function act(p, action) {
  await p.page.evaluate(async (a) => { const { net } = await import('/net.js'); net.action(a); }, action);
}

// Son gelen 'error' çerçevesi (toast metni)
export function lastErrors(p, n = 3) {
  return p.frames.filter((f) => f.includes('"t":"error"')).slice(-n).map((f) => JSON.parse(f).message);
}

export async function toastText(p) {
  return p.page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : ''; });
}

// 360 px'te yatay taşma
export async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    for (const n of document.querySelectorAll('#game-vampir *')) {
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > w + 1 || r.left < -1) && n.offsetParent !== null) bad.push(`${n.tagName}.${n.className}:${Math.round(r.left)}-${Math.round(r.right)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, w, bad: bad.slice(0, 10) };
  });
}

export async function smallButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('#game-vampir button, #game-vampir select, #game-vampir input')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.h < 44 || x.w < 44));
}

// Görünümde (WebSocket çerçeveleri) başka birinin rolü var mı? Rol adları sadece me.role / result'ta olmalı.
export function roleLeaks(p) {
  const leaks = [];
  for (const f of p.frames) {
    if (!f.includes('"t":"view"')) continue;
    const v = JSON.parse(f).view;
    if (!v || v.phase === 'over') continue;
    const s = JSON.stringify({ ...v, me: null, roleCounts: null });
    if (/"(vampir|koylu|doktor|gozcu|deli)"/.test(s)) leaks.push(s.slice(0, 200));
    if (v.me && v.me.role !== 'vampir' && (v.me.allies || v.me.allyPicks)) leaks.push('allies to non-vampire');
    if (v.me && v.me.role !== 'gozcu' && v.me.seerResults) leaks.push('seerResults to non-seer');
    if (v.me && v.me.role !== 'doktor' && v.me.lastProtected !== undefined) leaks.push('lastProtected to non-doctor');
  }
  return leaks;
}
