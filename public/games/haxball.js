// ⚽ Tosun Top — istemci. Fizik sunucuda (server/games/haxball.js + public/haxball-physics.js).
// İstemci sadece girdi yollar ve gelen kareleri (~30 Hz) ~100 ms geriden ara değerleyerek (interpolasyon) 60 fps çizer.
// Kendi oyuncu için tahmin (prediction) YOK: herkes aynı zaman çizgisinde, top ile oyuncu hep tutarlı. Bkz. PLAN.md §4.8.
import { mountLobby } from '../lobby.js';
import { net } from '../net.js';
import { $, el } from '../ui.js';
import { HZ, PITCHES, PHYS } from '../haxball-physics.js';

const TICK_MS = 1000 / HZ;
const INTERP_MS = 100; // çizim sunucu zamanının bu kadar gerisinden (2–3 kare tampon: sarsıntı ve kayıp kare emilir)
const BUFFER = 40; // saklanan kare sayısı (~1.3 sn)
const INPUT_MIN_MS = 33; // değişince en sık bu aralıkla gönder
const HEARTBEAT_MS = 100; // değişmese de bu aralıkla tekrar gönder (sunucu 1.5 sn girdi görmezse durdurur)
const JOY_RADIUS = 52; // px
const COLORS = { red: '#ff4d5e', blue: '#3d8bff' };
const TEAM_NAMES = { red: 'Kırmızı', blue: 'Mavi', spec: 'İzleyici' };
const REASONS = {
  time: '⏱️ Süre bitti',
  limit: '🎯 Gol limitine ulaşıldı',
  golden: '⚡ Altın gol!',
  forfeit: '🚪 Bir takım sahada kalmadı',
};

let lobby = null;
let ui = null;

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// ---------- Bekleme odası: ayarlar + takım seçimi ----------

function settingsUI(settings, { editable, change, room, lobbyAction, playerId, playerCount }) {
  const select = (key, options, label) => el('label', {},
    label,
    el('select', { disabled: !editable, onchange: (e) => change({ [key]: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value }) },
      options.map(([v, text]) => el('option', { value: String(v), selected: settings[key] === v }, text))));
  const teams = room?.prep?.teams ?? {};
  const players = room?.players ?? [];
  const mine = teams[playerId] ?? null;
  const col = (key, title) => {
    const list = players.filter((p) => (key === 'none' ? !teams[p.id] : teams[p.id] === key));
    return el('div', { class: `hx-team ${key}` },
      el('b', {}, `${title} (${list.length})`),
      el('ul', {}, list.map((p) => el('li', { class: p.connected ? '' : 'offline' }, p.name, p.id === playerId ? ' (sen)' : ''))));
  };
  const pick = (key, label) => el('button', {
    class: `btn hx-pick ${key}${mine === key ? ' selected' : ''}`,
    'aria-pressed': mine === key ? 'true' : 'false',
    onclick: () => lobbyAction({ type: 'team', team: key }),
  }, label);
  const auto = settings.size === 'auto';
  return el('div', { class: 'stack' },
    el('div', { class: 'settings' },
      select('minutes', [[2, '2 dakika'], [3, '3 dakika'], [5, '5 dakika']], 'Süre'),
      select('goals', [[3, '3 gol'], [5, '5 gol'], [0, 'Sınırsız']], 'Gol limiti'),
      select('size', [['auto', `Otomatik (${playerCount <= 4 ? 'küçük' : 'orta'})`], ['small', 'Küçük'], ['medium', 'Orta']], 'Saha')),
    auto ? el('p', { class: 'hint' }, '4 kişiye kadar küçük, daha kalabalıkta orta saha.') : null,
    el('h2', {}, '👕 Takımlar'),
    el('div', { class: 'hx-picks' }, pick('red', '🔴 Kırmızı'), pick('blue', '🔵 Mavi'), pick('spec', '👀 İzle')),
    el('div', { class: 'hx-teams' }, col('red', '🔴 Kırmızı'), col('blue', '🔵 Mavi'), col('spec', '👀 İzleyici')),
    players.some((p) => !teams[p.id]) ? el('p', { class: 'hint' },
      `Seçmeyenler başlarken az olan takıma konur: ${players.filter((p) => !teams[p.id]).map((p) => p.name).join(', ')}`) : null,
    editable ? el('button', { class: 'btn', onclick: () => lobbyAction({ type: 'shuffle' }) }, '🔀 Takımları karıştır / dengele') : null);
}

// ---------- Oyun ekranı (kalıcı öğe; her görünümde yerinde güncellenir) ----------

function createUI() {
  const canvas = el('canvas', { class: 'hx-canvas', 'aria-label': 'Saha' });
  const scoreRed = el('span', { class: 'hx-score red' }, '0');
  const scoreBlue = el('span', { class: 'hx-score blue' }, '0');
  const clock = el('span', { class: 'hx-clock' }, '0:00');
  const ping = el('span', { class: 'hx-ping' }, '— ms');
  const status = el('span', { class: 'hx-status' });
  const banner = el('div', { class: 'hx-banner hidden' });
  const joyBase = el('div', { class: 'hx-joy hidden' }, el('div', { class: 'hx-knob' }));
  const kickBtn = el('button', { class: 'hx-kick', type: 'button', 'aria-label': 'Şut' }, 'ŞUT');
  const touch = el('div', { class: 'hx-touch' }, joyBase, kickBtn);
  const wrap = el('div', { class: 'hx-canvas-wrap' }, canvas, banner,
    el('div', { class: 'hx-rotate' }, '📱 Telefonu yan çevir, daha rahat oynarsın'),
    el('div', { class: 'hx-keys' }, 'WASD / oklar: koş · Boşluk / X: şut'),
    touch);
  const fsBtn = el('button', { class: 'hx-btn', type: 'button', title: 'Tam ekran', 'aria-label': 'Tam ekran', onclick: () => toggleFullscreen() }, '⛶');
  const exitBtn = el('button', {
    class: 'hx-btn', type: 'button', title: 'Maçtan çık', 'aria-label': 'Maçtan çık',
    onclick: () => { if (confirm('Maçtan çıkmak istiyor musun?')) net.send({ t: 'leave' }); },
  }, '✕');
  const hud = el('div', { class: 'hx-hud' }, scoreRed, clock, scoreBlue, status, ping, fsBtn, exitBtn);
  const stage = el('div', { class: 'hx-stage' }, hud, wrap);
  const end = el('div', { class: 'stack hx-end hidden' });
  const root = el('div', { class: 'hx' }, stage, end);

  const u = {
    root, stage, end, canvas, wrap, scoreRed, scoreBlue, clock, ping, status, banner, joyBase, kickBtn, touch,
    view: null,
    discsByVer: new Map(), // ver → [{ id, name, team }]
    frames: [], // { k, v, c, b, p, f, at }
    offset: null, // yerel saat − sunucu adımı·TICK_MS (en hızlı gelen kareye göre)
    raf: 0, live: false, rtt: null,
    input: { x: 0, y: 0, k: false }, sent: { x: 9, y: 9, k: false }, lastSent: 0, inputTimer: 0,
    keys: new Set(), joy: null, kickPointers: new Set(),
    fps: { n: 0, start: 0, value: 0 },
  };

  // ----- Kareler -----
  u.offFrame = net.on('frame', (m) => onFrame(u, m));
  // Odadan çıkınca / bekleme odasına dönünce tam ekran sahne kapanır.
  u.offRoom = net.on('room', (r) => { if (!r || r.game !== 'haxball' || r.phase !== 'playing') setLive(u, false); });
  u.offPong = net.on('pong', (m) => {
    if (typeof m.c !== 'number') return;
    const rtt = performance.now() - m.c;
    if (rtt < 0 || rtt > 10_000) return;
    u.rtt = u.rtt == null ? rtt : u.rtt * 0.7 + rtt * 0.3;
    u.ping.textContent = `${Math.round(u.rtt)} ms`;
    u.ping.classList.toggle('bad', u.rtt > 200);
  });

  // ----- Dokunmatik: sol tarafta parmağın indiği yerde joystick, sağda büyük ŞUT (çoklu dokunuş) -----
  const touchMode = () => root.classList.add('touch');
  if (navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches) touchMode();
  touch.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') touchMode();
    if (e.target === kickBtn || u.joy) return;
    const r = touch.getBoundingClientRect();
    if (e.clientX - r.left > r.width * 0.6) { // sağ taraf: ŞUT gibi davran (butonu tam tutturamayan parmak)
      u.kickPointers.add(e.pointerId);
      kickBtn.classList.add('down');
      touch.setPointerCapture?.(e.pointerId);
      pump(u);
      return;
    }
    u.joy = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, x: 0, y: 0 };
    touch.setPointerCapture?.(e.pointerId);
    joyBase.classList.remove('hidden');
    placeJoy(u, 0, 0);
    e.preventDefault();
  });
  touch.addEventListener('pointermove', (e) => {
    if (!u.joy || e.pointerId !== u.joy.id) return;
    const r = touch.getBoundingClientRect();
    let dx = e.clientX - r.left - u.joy.ox;
    let dy = e.clientY - r.top - u.joy.oy;
    const len = Math.hypot(dx, dy);
    if (len > JOY_RADIUS * 1.6) { // parmak çok uzaklaşırsa joystick peşinden gelir
      const k = (len - JOY_RADIUS * 1.6) / len;
      u.joy.ox += dx * k; u.joy.oy += dy * k;
      dx -= dx * k; dy -= dy * k;
    }
    let x = dx / JOY_RADIUS;
    let y = dy / JOY_RADIUS;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    if (l < 0.15) { x = 0; y = 0; } // ölü bölge
    u.joy.x = x; u.joy.y = y;
    placeJoy(u, dx, dy);
    pump(u);
  });
  const release = (e) => {
    if (u.joy && e.pointerId === u.joy.id) {
      u.joy = null;
      joyBase.classList.add('hidden');
      pump(u);
    }
    if (u.kickPointers.delete(e.pointerId)) { if (!u.kickPointers.size) kickBtn.classList.remove('down'); pump(u); }
  };
  touch.addEventListener('pointerup', release);
  touch.addEventListener('pointercancel', release);
  kickBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') touchMode();
    u.kickPointers.add(e.pointerId);
    kickBtn.setPointerCapture?.(e.pointerId);
    kickBtn.classList.add('down');
    pump(u);
    e.preventDefault();
    e.stopPropagation();
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    kickBtn.addEventListener(t, (e) => { if (u.kickPointers.delete(e.pointerId)) { if (!u.kickPointers.size) kickBtn.classList.remove('down'); pump(u); } });
  }
  touch.addEventListener('contextmenu', (e) => e.preventDefault());

  // ----- Klavye -----
  u.onKey = (e) => {
    if (!u.live) return;
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!KEYS.has(e.code)) return;
    e.preventDefault();
    if (e.type === 'keydown') u.keys.add(e.code); else u.keys.delete(e.code);
    pump(u);
  };
  u.onBlur = () => { u.keys.clear(); u.joy = null; u.kickPointers.clear(); joyBase.classList.add('hidden'); kickBtn.classList.remove('down'); pump(u); };
  u.onVis = () => {
    if (document.hidden) { u.onBlur(); stopLoop(u, true); } else if (u.live) startLoop(u);
  };
  u.onResize = () => resize(u);
  window.addEventListener('keydown', u.onKey);
  window.addEventListener('keyup', u.onKey);
  window.addEventListener('blur', u.onBlur);
  window.addEventListener('resize', u.onResize);
  document.addEventListener('visibilitychange', u.onVis);
  u.ro = new ResizeObserver(() => resize(u));
  u.ro.observe(wrap);
  return u;
}

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyX']);

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else ui?.stage.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
  } catch { /* desteklenmiyor */ }
}

function placeJoy(u, dx, dy) {
  u.joyBase.style.left = `${u.joy.ox}px`;
  u.joyBase.style.top = `${u.joy.oy}px`;
  const l = Math.hypot(dx, dy);
  const k = l > JOY_RADIUS ? JOY_RADIUS / l : 1;
  u.joyBase.firstChild.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
}

function destroyUI(u) {
  stopLoop(u, true);
  u.offFrame(); u.offPong(); u.offRoom();
  window.removeEventListener('keydown', u.onKey);
  window.removeEventListener('keyup', u.onKey);
  window.removeEventListener('blur', u.onBlur);
  window.removeEventListener('resize', u.onResize);
  document.removeEventListener('visibilitychange', u.onVis);
  u.ro.disconnect();
  document.body.classList.remove('hx-live');
}

// ----- Girdi gönderimi: değişince (en sık 33 ms) + 100 ms kalp atışı -----

function currentInput(u) {
  let x = 0;
  let y = 0;
  if (u.joy) { x = u.joy.x; y = u.joy.y; } else {
    const k = u.keys;
    x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
  }
  u.input.x = Math.round(x * 100) / 100;
  u.input.y = Math.round(y * 100) / 100;
  u.input.k = u.kickPointers.size > 0 || u.keys.has('Space') || u.keys.has('KeyX');
  return u.input;
}

function canPlay(u) {
  return u.live && !!u.view?.myTeam && !document.hidden;
}

function pump(u) {
  const inp = currentInput(u);
  if (!canPlay(u)) return;
  const now = performance.now();
  const changed = inp.x !== u.sent.x || inp.y !== u.sent.y || inp.k !== u.sent.k;
  if (!changed && now - u.lastSent < HEARTBEAT_MS) return;
  if (changed && now - u.lastSent < INPUT_MIN_MS) {
    if (!u.inputTimer) u.inputTimer = setTimeout(() => { u.inputTimer = 0; pump(u); }, INPUT_MIN_MS - (now - u.lastSent));
    return;
  }
  if (net.sendFast({ t: 'input', x: inp.x, y: inp.y, k: inp.k ? 1 : 0 })) {
    u.sent.x = inp.x; u.sent.y = inp.y; u.sent.k = inp.k;
    u.lastSent = now;
  }
}

// ----- Kareler ve ara değerleme -----

function onFrame(u, m) {
  if (!Array.isArray(m.b) || !Array.isArray(m.p) || typeof m.k !== 'number') return;
  const now = performance.now();
  const last = u.frames[u.frames.length - 1];
  if (last && m.k <= last.k) {
    if (m.k < last.k - HZ) { u.frames.length = 0; u.offset = null; } // yeni maç: adım sayacı sıfırlandı
    else return; // sırası bozuk/yinelenen kare
  }
  const sample = now - m.k * TICK_MS;
  // En hızlı gelen kareyi izle; ağ yavaşlarsa (ya da saatler kayarsa) yavaşça yukarı uyum sağla.
  if (u.offset == null || sample < u.offset) u.offset = sample;
  else u.offset += (sample - u.offset) * 0.02;
  u.frames.push({ k: m.k, v: m.v, c: m.c, b: m.b, p: m.p, f: m.f | 0 });
  if (u.frames.length > BUFFER) u.frames.shift();
  if (typeof m.c === 'number') {
    const txt = m.c >= 0 ? fmtClock(m.c) : `+${fmtClock(-m.c)}`;
    if (u.clock.textContent !== txt) u.clock.textContent = txt;
  }
}

// Çizim anındaki konumlar: render zamanını çevreleyen iki kare arasında doğrusal ara değer.
function sample(u, now) {
  const fr = u.frames;
  if (!fr.length) return null;
  const rt = (now - u.offset - INTERP_MS) / TICK_MS;
  let a = fr[0];
  let b = fr[0];
  if (rt >= fr[fr.length - 1].k) { a = b = fr[fr.length - 1]; } else if (rt > fr[0].k) {
    for (let i = fr.length - 1; i > 0; i--) {
      if (fr[i - 1].k <= rt) { a = fr[i - 1]; b = fr[i]; break; }
    }
  }
  const t = b.k > a.k ? Math.max(0, Math.min(1, (rt - a.k) / (b.k - a.k))) : 1;
  return { a, b, t, same: a.v === b.v && a.p.length === b.p.length };
}

function startLoop(u) {
  if (u.raf || document.hidden) return;
  const frame = (now) => {
    u.raf = 0;
    if (!u.live || !u.root.isConnected) return;
    draw(u, now);
    u.fps.n++;
    if (now - u.fps.start > 1000) { u.fps.value = Math.round((u.fps.n * 1000) / (now - u.fps.start)); u.fps.n = 0; u.fps.start = now; u.root.dataset.fps = String(u.fps.value); }
    u.raf = requestAnimationFrame(frame);
  };
  u.raf = requestAnimationFrame(frame);
  clearInterval(u.beat);
  u.beat = setInterval(() => { pump(u); }, 50);
  clearInterval(u.pinger);
  const ping = () => net.sendFast({ t: 'ping', c: performance.now() });
  ping();
  u.pinger = setInterval(ping, 2000);
}

function stopLoop(u, sendStop) {
  cancelAnimationFrame(u.raf);
  u.raf = 0;
  clearInterval(u.beat);
  clearInterval(u.pinger);
  clearTimeout(u.inputTimer);
  u.inputTimer = 0;
  if (sendStop && u.view?.myTeam && (u.sent.x || u.sent.y || u.sent.k)) {
    net.sendFast({ t: 'input', x: 0, y: 0, k: 0 });
    u.sent.x = 0; u.sent.y = 0; u.sent.k = false;
  }
}

function resize(u) {
  const pitch = PITCHES[u.view?.pitch] ?? PITCHES.small;
  const W = u.wrap.clientWidth;
  const H = u.wrap.clientHeight;
  if (!W || !H) return;
  const aspect = pitch.outerW / pitch.outerH;
  let cw = W;
  let ch = W / aspect;
  if (ch > H) { ch = H; cw = H * aspect; }
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const key = `${Math.floor(cw)}x${Math.floor(ch)}@${dpr}`;
  if (u.sizeKey === key && u.pitch === pitch) return;
  u.sizeKey = key;
  u.canvas.style.width = `${Math.floor(cw)}px`;
  u.canvas.style.height = `${Math.floor(ch)}px`;
  u.canvas.width = Math.floor(cw * dpr);
  u.canvas.height = Math.floor(ch * dpr);
  u.scale = (cw * dpr) / (2 * pitch.outerW);
  u.pitch = pitch;
}

function draw(u, now) {
  const c = u.canvas;
  const g = c.getContext('2d');
  if (!u.pitch || !c.width) resize(u);
  const p = u.pitch;
  if (!p) return;
  const s = u.scale;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#2f6b32';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(s, 0, 0, s, c.width / 2, c.height / 2);
  // Çim şeritleri
  const stripe = (p.w * 2) / 10;
  g.fillStyle = '#3a7d3c';
  for (let i = 0; i < 10; i += 2) g.fillRect(-p.w + i * stripe, -p.h, stripe, p.h * 2);
  // Çizgiler
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.strokeRect(-p.w, -p.h, p.w * 2, p.h * 2);
  g.beginPath(); g.moveTo(0, -p.h); g.lineTo(0, p.h); g.stroke();
  g.beginPath(); g.arc(0, 0, p.circle, 0, Math.PI * 2); g.stroke();
  // Kaleler (ağ)
  for (const sd of [-1, 1]) {
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(sd > 0 ? p.w : -p.w - p.depth, -p.goal, p.depth, p.goal * 2);
    g.strokeStyle = sd > 0 ? COLORS.blue : COLORS.red;
    g.beginPath();
    g.moveTo(sd * p.w, -p.goal); g.lineTo(sd * (p.w + p.depth), -p.goal); g.lineTo(sd * (p.w + p.depth), p.goal); g.lineTo(sd * p.w, p.goal);
    g.stroke();
    for (const t of [-1, 1]) {
      g.beginPath(); g.arc(sd * p.w, t * p.goal, PHYS.postRadius, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#111'; g.stroke();
    }
  }
  const smp = sample(u, now);
  if (!smp) return;
  const { a, b, t, same } = smp;
  const lerp = (arr1, arr2, i) => (same ? arr1[i] + (arr2[i] - arr1[i]) * t : arr2[i]) / 10;
  const discs = u.discsByVer.get(b.v) ?? (u.view?.ver === b.v ? u.view.discs : null);
  if (discs && discs.length * 2 === b.p.length) {
    g.font = `bold ${PHYS.playerRadius * 1.15}px Rubik, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < discs.length; i++) {
      const x = lerp(a.p, b.p, 2 * i);
      const y = lerp(a.p, b.p, 2 * i + 1);
      const d = discs[i];
      const mine = d.id === net.playerId;
      if (mine) { // kendi diskin: sarı hale
        g.beginPath(); g.arc(x, y, PHYS.playerRadius + 6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,214,0,0.35)'; g.fill();
      }
      g.beginPath(); g.arc(x, y, PHYS.playerRadius, 0, Math.PI * 2);
      g.fillStyle = COLORS[d.team] ?? '#888'; g.fill();
      g.lineWidth = (b.f >> i) & 1 ? 3.5 : 2;
      g.strokeStyle = (b.f >> i) & 1 ? '#ffffff' : '#111';
      g.stroke();
      g.fillStyle = '#fff';
      g.fillText(initials(d.name), x, y + 1);
      g.font = `600 ${11}px Rubik, system-ui, sans-serif`;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(d.name, x, y + PHYS.playerRadius + 10);
      g.font = `bold ${PHYS.playerRadius * 1.15}px Rubik, system-ui, sans-serif`;
    }
  }
  // Top
  const bx = lerp(a.b, b.b, 0);
  const by = lerp(a.b, b.b, 1);
  g.beginPath(); g.arc(bx, by, PHYS.ballRadius, 0, Math.PI * 2);
  g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#111'; g.stroke();
}

function initials(name) {
  const parts = String(name ?? '?').trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [...parts[0]][0] + [...parts[parts.length - 1]][0] : [...(parts[0] ?? '?')].slice(0, 2).join('');
  return chars.toLocaleUpperCase('tr');
}

// ---------- Görünüm güncellemesi ----------

function update(u, view, ctx) {
  u.view = view;
  u.discsByVer.set(view.ver, view.discs);
  for (const k of u.discsByVer.keys()) if (k < view.ver - 4) u.discsByVer.delete(k);
  const pitch = PITCHES[view.pitch] ?? PITCHES.small;
  if (u.pitch !== pitch) resize(u);
  u.scoreRed.textContent = String(view.score[0]);
  u.scoreBlue.textContent = String(view.score[1]);

  const live = ctx.room.phase === 'playing' && view.phase !== 'over';
  setLive(u, live);
  u.root.classList.toggle('player', !!view.myTeam);
  u.status.textContent = view.overtime ? '⚡ Altın gol' : !view.myTeam ? (view.removed ? '📴 Sahadan çıktın' : '👀 İzliyorsun') : '';

  // Bant: gol / başlama vuruşu
  let text = '';
  if (view.phase === 'goal' && view.lastGoal) {
    const g = view.lastGoal;
    text = `⚽ GOL! ${g.name ? `${g.name}${g.own ? ' (kendi kalesine)' : ''}` : TEAM_NAMES[g.team]}`;
  } else if (view.phase === 'kickoff') {
    text = `Başlama vuruşu: ${TEAM_NAMES[view.kickoffTeam]}${view.myTeam === view.kickoffTeam ? ' — sende!' : ''}`;
  }
  u.banner.textContent = text;
  u.banner.className = `hx-banner${text ? '' : ' hidden'}${view.phase === 'goal' ? ` goal ${view.lastGoal?.team ?? ''}` : ''}`;

  if (live) requestAnimationFrame(() => resize(u));
  u.end.classList.toggle('hidden', view.phase !== 'over');
  if (view.phase === 'over') renderEnd(u, view, ctx);
}

function setLive(u, live) {
  u.live = live;
  u.stage.classList.toggle('live', live);
  document.body.classList.toggle('hx-live', live);
  if (live) startLoop(u);
  else { u.onBlur(); stopLoop(u, false); }
}

function renderEnd(u, view, ctx) {
  const res = view.result ?? { winner: 'draw', reason: 'time' };
  const winText = res.winner === 'draw' ? '🤝 Berabere!' : `🏆 ${TEAM_NAMES[res.winner]} kazandı!`;
  const me = view.myTeam ?? Object.entries(view.roster).find(([, list]) => list.some((p) => p.id === ctx.playerId))?.[0];
  const mood = me === 'red' || me === 'blue'
    ? (res.winner === 'draw' ? '' : res.winner === me ? '🎉 Takımın kazandı!' : '😵 Bu sefer olmadı.') : '';
  const teamList = (key) => el('div', { class: `hx-team ${key}` },
    el('b', {}, TEAM_NAMES[key]),
    el('ul', {}, view.roster[key].map((p) => el('li', {}, p.name, p.removed ? ' 📴' : ''))));
  u.end.replaceChildren(
    el('section', { class: 'card center' },
      el('div', { class: `result-msg ${res.winner}` }, winText),
      el('div', { class: 'hx-final' },
        el('span', { class: 'hx-score red' }, String(view.score[0])),
        el('span', {}, '–'),
        el('span', { class: 'hx-score blue' }, String(view.score[1]))),
      el('p', { class: 'hint' }, REASONS[res.reason] ?? ''),
      mood ? el('p', {}, mood) : null),
    el('section', { class: 'card' },
      el('h2', {}, '⚽ Goller'),
      view.goals.length
        ? el('ul', { class: 'howto hx-goals' }, view.goals.map((g) => el('li', { class: g.team },
          `${fmtClock(g.sec)} · ${g.name ?? 'Kimse'}${g.own ? ' (kendi kalesine)' : ''} → ${TEAM_NAMES[g.team]}`)))
        : el('p', { class: 'hint' }, 'Gol yok.')),
    el('section', { class: 'card' },
      el('h2', {}, '👕 Takımlar'),
      el('div', { class: 'hx-teams two' }, teamList('red'), teamList('blue'))),
  );
}

function renderGame(view, ctx) {
  if (!ui) ui = createUI();
  update(ui, view, ctx);
  return ui.root;
}

export function enter() {
  lobby?.unmount();
  lobby = mountLobby($('game-haxball'), {
    id: 'haxball',
    name: 'Tosun Top',
    icon: '⚽',
    howTo: [
      'İki takım: 🔴 Kırmızı ve 🔵 Mavi. Bekleme odasında takımını seç (1’e 1 de olur).',
      'Telefonda: solda parmağını bastırıp kaydır → koş. Sağdaki büyük ŞUT tuşu → vur. İkisi aynı anda olur.',
      'Bilgisayarda: WASD veya oklar ile koş, Boşluk veya X ile şut.',
      'Şut tuşu basılıyken top yakına gelince vurursun; basılıyken biraz yavaş koşarsın.',
      'Top kale çizgisini tamamen geçerse gol. Golü yiyen takım ortadan başlar; rakip orta yuvarlağa giremez.',
      'Süre bitince berabereyse ⚡ altın gol: ilk atan kazanır.',
    ],
    renderSettings: settingsUI,
    renderGame,
  });
}

export function leave() {
  lobby?.unmount();
  lobby = null;
  if (ui) { destroyUI(ui); ui = null; }
}
