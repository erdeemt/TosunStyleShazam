// 📸 Ne Zaman Nerede? — tek oyunculu akış (Günlük + Serbest). Çok oyunculu (lobi): whenwhere-lobby.js. Kurallar: PLAN.md §4.10.
// Fotoğraf sadece opak /api/media adresinden gelir; yeri, yılı ve başlığı tahmin kilitlenince sunucudan açılır.
import { net } from '../net.js';
import { $, el, toast } from '../ui.js';
import { DAILY_ROUNDS, SETS, fmtDy, fmtKm, setById, squareOf, titleFor } from '../whenwhere-math.js';
import { guessMap, revealMap } from './whenwhere-map.js';
import { HOW_TO, creditCard, missText, photoCard, pointsLine, scoreClass, viewOfSet, yearPicker } from './whenwhere-ui.js';
import { enterLobby, leaveLobby } from './whenwhere-lobby.js';

const MODE_KEY = 'tss:whenwhere-mode';
const SET_KEY = 'tss:whenwhere-set';
const base = '/api/whenwhere';

let root = null;
let mode = 'daily';
let set = 'karisik';
let game = null; // sunucunun publicGame'i
let phase = 'loading'; // loading | error | setup | ready | guess | retry | reveal | final
let current = null; // { index, image, photo, map, year, pin }
let lastReveal = null;
let board = null;
let counts = null; // set başına fotoğraf sayısı (5'ten azı seçilemez)
let busy = false;
let loadSeq = 0;
let disposers = [];

const cleanup = () => { for (const d of disposers.splice(0)) { try { d(); } catch { /* yok say */ } } };

async function ensureIdentity() {
  const res = await fetch('/api/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token, name: net.identity.name }),
  });
  const id = await res.json();
  if (!res.ok) throw new Error(id.error);
  net.identity = { playerId: id.playerId, token: id.token, name: id.name };
  try { localStorage.setItem('tss:identity', JSON.stringify(net.identity)); } catch { /* yok say */ }
}

async function api(path, body = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token, ...body }),
    });
  } catch {
    throw Object.assign(new Error('Bağlantı koptu, tekrar dene.'), { retry: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? 'Sunucuya ulaşılamadı, tekrar dene.'), { retry: res.status >= 500 || !json.error });
  return json;
}

function resetRun() {
  cleanup();
  game = null; current = null; lastReveal = null; board = null; busy = false;
}

async function load(newMode = mode) {
  mode = newMode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* yok say */ }
  resetRun();
  phase = 'loading';
  render();
  const seq = ++loadSeq;
  try {
    await ensureIdentity();
    if (seq !== loadSeq) return;
    const g = await api('/start', { mode: 'daily' }); // serbest modda da: set sayıları için (günlük kayıt açmaz)
    if (seq !== loadSeq) return;
    counts = g.counts ?? null;
    if (mode === 'free') { if (counts && counts[set] < DAILY_ROUNDS) set = 'karisik'; phase = 'setup'; render(); return; }
    applyGame(g);
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(err.message);
    phase = 'error';
  }
  render();
}

function applyGame(g) {
  game = g;
  if (g.done) { phase = 'final'; loadBoard(); return; }
  if (g.pending) { openRound(g.pending.index, g.pending.image); return; } // sayfa tur sürerken yenilendi
  phase = g.played.length ? 'between' : 'ready';
}

async function loadBoard() {
  if (mode !== 'daily') return;
  try { board = await api('/leaderboard'); } catch { board = null; }
  render();
}

async function startFree() {
  if (busy) return;
  busy = true;
  render();
  try {
    game = await api('/start', { mode: 'free', set });
    busy = false;
    await beginRound();
    return;
  } catch (err) {
    toast(err.message);
  }
  busy = false;
  render();
}

async function beginRound() {
  if (busy || !game) return;
  busy = true;
  const index = game.played.length;
  try {
    const r = await api('/round', { mode, gameId: game.gameId, round: index });
    openRound(index, r.image);
  } catch (err) {
    toast(err.message);
    if (mode === 'daily') { busy = false; load('daily'); return; }
  } finally {
    busy = false;
  }
  render();
}

function openRound(index, image) {
  cleanup();
  const c = { index, pin: null };
  c.photo = photoCard(image);
  c.year = yearPicker({ initial: 1930 });
  c.mapNode = el('div', { class: 'ww-map', 'data-testid': 'ww-guess-map' });
  c.lockBtn = el('button', { class: 'btn big primary ww-lock', disabled: true, onclick: () => sendGuess() }, '🔒 Kilitle');
  c.map = guessMap(c.mapNode, {
    view: viewOfSet(game.set),
    onChange: (pin) => { c.pin = pin; c.lockBtn.disabled = busy; c.mapHint.textContent = '📌 İğne yerinde. Sürükleyerek düzeltebilirsin.'; },
  });
  c.mapHint = el('p', { class: 'hint center ww-map-hint' }, '👆 Haritaya dokun, iğneyi koy.');
  c.map.ready.catch((err) => toast(err.message));
  disposers.push(() => c.map.destroy(), () => c.photo.release());
  current = c;
  phase = 'guess';
}

async function sendGuess() {
  const c = current;
  if (!c || busy || !c.pin) return;
  busy = true;
  c.lockBtn.disabled = true;
  const guess = { lat: c.pin.lat, lon: c.pin.lon, year: c.year.value() };
  try {
    const g = await submitWithRetry({ mode, gameId: game.gameId, round: c.index, guess });
    game = g;
    lastReveal = g.played.find((p) => p.index === c.index) ?? null;
    cleanup();
    current = null;
    phase = 'reveal';
    if (g.done) loadBoard();
  } catch (err) {
    toast(err.message);
    if (/zaten alındı|değişti|bulunamadı|başlamadı/.test(err.message)) { busy = false; load(mode); return; }
    c.lockBtn.disabled = false;
  } finally {
    busy = false;
  }
  render();
}

const RETRY_DELAYS = [600, 1500];
async function submitWithRetry(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('/guess', body);
    } catch (err) {
      if (!err.retry || attempt >= RETRY_DELAYS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

// ---------- Çizim ----------

function progress() {
  const played = game?.played ?? [];
  const n = game?.rounds ?? DAILY_ROUNDS;
  return el('div', { class: 'rc-dots ww-dots' }, Array.from({ length: n }, (_, i) => {
    const p = played.find((x) => x.index === i);
    const now = current?.index === i;
    return el('span', { class: `rc-dot${p ? ` done ${scoreClass(p.score)}` : ''}${now ? ' now' : ''}` }, p ? String(p.score) : String(i + 1));
  }));
}

function head(text) {
  return el('div', { class: 'game-head' }, el('div', { class: 'round' }, text),
    mode === 'free' && game ? el('span', { class: 'ww-set-badge' }, `${setById(game.set).icon} ${setById(game.set).name}`) : null);
}

function nameCard() {
  if (net.identity.name && net.identity.name !== 'Oyuncu') return null;
  const field = el('input', { type: 'text', maxlength: '16', placeholder: 'Takma adın', autocomplete: 'nickname' });
  return el('section', { class: 'card' },
    el('h2', {}, '🙋 Sıralamada görünecek adın'),
    el('form', {
      class: 'row',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = field.value.trim();
        if (!name) return;
        net.identity.name = name;
        await ensureIdentity().catch((err) => toast(err.message));
        render();
        if (phase === 'final') loadBoard();
      },
    }, field, el('button', { class: 'btn primary', type: 'submit' }, 'Kaydet')));
}

function howToBox(open = false) {
  return el('details', { class: 'card howto-box', open },
    el('summary', {}, '📖 Nasıl oynanır?'),
    el('ul', { class: 'howto' }, HOW_TO.map((line) => el('li', {}, line))));
}

export function setPicker(selected, onPick, { counts = null, disabled = false } = {}) {
  return el('div', { class: 'ww-sets' }, SETS.map((s) => el('button', {
    type: 'button',
    class: `rc-diff ww-set${selected === s.id ? ' active' : ''}`,
    'aria-pressed': selected === s.id ? 'true' : 'false',
    'data-set': s.id,
    disabled: disabled || (counts && counts[s.id] < DAILY_ROUNDS),
    onclick: () => onPick(s.id),
  }, el('b', {}, `${s.icon} ${s.name}`), el('small', {}, counts ? `${s.hint} · ${counts[s.id] ?? 0}` : s.hint))));
}

function shareText() {
  const headLine = mode === 'daily' ? `📸 Ne Zaman Nerede? #${game.puzzleNo}` : `📸 Ne Zaman Nerede? (${setById(game.set).name})`;
  return `${headLine} · ${game.total}/${game.rounds * 1000}\n${game.played.map((p) => squareOf(p.score)).join('')}`;
}

async function share(text) {
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Sonuç kopyalandı.'); }
  } catch { /* iptal */ }
}

function nextPuzzleIn() {
  const now = Date.now();
  const ist = new Date(now + 3 * 3600_000);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 3 * 3600_000;
  const left = Math.max(0, midnight - now);
  return `${Math.floor(left / 3600_000)} sa ${Math.floor((left % 3600_000) / 60_000)} dk`;
}

function guessScreen() {
  const c = current;
  const n = game.rounds;
  return [head(`Fotoğraf ${c.index + 1} / ${n}`),
    c.photo,
    el('section', { class: 'card ww-guess' },
      el('h2', {}, '🗺️ Nerede?'),
      c.mapNode,
      c.mapHint,
      el('h2', { class: 'ww-when' }, '📅 Ne zaman?'),
      c.year.node,
      c.lockBtn),
    progress()];
}

function revealScreen() {
  const r = lastReveal;
  const mapNode = el('div', { class: 'ww-map ww-map-reveal', 'data-testid': 'ww-reveal-map' });
  const m = revealMap(mapNode, { pins: [{ lat: r.guess.lat, lon: r.guess.lon, color: '#ff4d8d', label: 'Sen', me: true }], truth: r.truth, view: viewOfSet(game.set) });
  m.ready.catch(() => {});
  disposers.push(() => m.destroy());
  return [head(`Fotoğraf ${r.index + 1} / ${game.rounds} sonucu`),
    el('section', { class: 'card center ww-result' },
      el('div', { class: `ww-big-score ${scoreClass(r.score)}` }, String(r.score), el('small', {}, ' / 1000')),
      el('p', { class: 'ww-miss' }, missText(r)),
      pointsLine(r),
      mapNode,
      el('button', {
        class: 'btn big primary rc-go ww-next',
        disabled: busy,
        onclick: () => { if (game.done) { cleanup(); phase = 'final'; render(); } else beginRound(); },
      }, game.done ? 'Sonucu gör →' : `Sonraki → (${game.played.length + 1}/${game.rounds})`)),
    creditCard(r),
    progress()];
}

function finalCard() {
  const t = game.badge ?? titleFor(game.total, game.rounds);
  return el('section', { class: 'card center ww-final' },
    el('div', { class: 'hint' }, mode === 'daily' ? `📅 Günlük #${game.puzzleNo}` : `♾️ Serbest · ${setById(game.set).icon} ${setById(game.set).name}`),
    el('div', { class: 'ww-title-icon' }, t.icon),
    el('h2', { class: 'ww-title' }, t.name),
    el('div', { class: 'ww-total' }, String(game.total), el('small', {}, ` / ${game.rounds * 1000}`)),
    el('ol', { class: 'ww-rows' }, game.played.map((p) => el('li', {},
      el('span', { class: 'ww-row-title' }, `${p.title} · ${p.truth.year}`),
      el('small', {}, `${fmtKm(p.km)} · ${fmtDy(p.dy)}`),
      el('b', { class: `ww-row-score ${scoreClass(p.score)}` }, String(p.score))))),
    el('div', { class: 'row center' },
      el('button', { class: 'btn ghost', onclick: () => share(shareText()) }, '📤 Paylaş'),
      mode === 'free' ? el('button', { class: 'btn primary', onclick: () => load('free') }, 'Yeni oyun →') : null),
    mode === 'daily' ? el('p', { class: 'hint' }, `Yeni günlük fotoğraflara ${nextPuzzleIn()} var.`) : null);
}

function leaderboardPanel() {
  if (mode !== 'daily' || !board) return null;
  return el('section', { class: 'card' },
    el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
    board.entries.length
      ? el('ol', { class: 'w-board rc-board ww-board' }, board.entries.map((e) =>
        el('li', { class: `${e.me ? 'me' : ''}${e.fresh ? ' fresh' : ''}` },
          el('span', { class: 'w-rank' }, e.fresh ? '🆕' : `${e.rank}.`),
          el('span', { class: 'player-name' }, e.name, e.fresh ? el('small', { class: 'w-fresh', title: 'Bu hesap bugün açıldı; günün sıralamasına girmez.' }, '🆕 sıralama dışı') : null),
          el('span', { class: 'w-tries' }, `${e.total}`),
          e.scores ? el('span', { class: 'rc-mini ww-mini' }, e.scores.map((s) => el('span', { class: `pc-chip ${scoreClass(s)}` }, String(s)))) : null)))
      : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi. İlk sen ol!'),
    board.viewerDone ? null : el('p', { class: 'hint' }, 'Başkalarının tur puanlarını görmek için önce kendi oyununu bitir.'),
    board.playing ? el('p', { class: 'hint' }, `${board.playing} kişi şu an oynuyor.`) : null);
}

function body() {
  switch (phase) {
    case 'loading':
      return [el('p', { class: 'hint center' }, 'Yükleniyor…')];
    case 'error':
      return [el('section', { class: 'card center' },
        el('p', {}, 'Bağlantı kurulamadı.'),
        el('button', { class: 'btn primary', onclick: () => load(mode) }, 'Tekrar dene'))];
    case 'setup':
      return [el('section', { class: 'card' },
        el('h2', {}, '♾️ Serbest oyun'),
        el('p', { class: 'hint' }, '5 fotoğraf. Seti seç; istediğin kadar oyna (sıralamaya girmez). Yakında gördüklerin tekrar gelmez.'),
        setPicker(set, (id) => { set = id; try { localStorage.setItem(SET_KEY, id); } catch { /* yok say */ } render(); }, { counts }),
        el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: startFree }, 'Başla →'))];
    case 'ready':
    case 'between':
      return [el('section', { class: 'card center ww-start' },
        el('div', { class: 'hint' }, `📅 Günlük #${game.puzzleNo}`),
        el('h2', {}, phase === 'ready' ? '5 fotoğraf, tek deneme' : `Kaldığın yerden: ${game.played.length + 1}. fotoğraf`),
        el('p', { class: 'hint' }, 'Herkese aynı 5 tarihi fotoğraf. Nerede ve ne zaman çekildi? Süre yok, acele etme.'),
        progress(),
        el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: beginRound }, phase === 'ready' ? 'Başla →' : 'Devam →'))];
    case 'guess':
      return guessScreen();
    case 'reveal':
      return revealScreen();
    case 'final':
      return [finalCard(), leaderboardPanel()];
    default:
      return [];
  }
}

function render() {
  if (!root) return;
  const inRun = phase === 'guess';
  // Tahmin ekranı bir kez kurulur (harita/iğne korunsun); diğer fazlar baştan çizilir.
  if (inRun && root.querySelector('.ww-guess') && current?.photo.isConnected) {
    current.lockBtn.disabled = busy || !current.pin;
    return;
  }
  if (phase !== 'guess') cleanup(); // eski açıklama haritası (yeniden çizimde yenisi kurulur)
  root.replaceChildren(el('div', { class: 'screen active ww' },
    el('div', { class: 'tabs' },
      el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'daily' && load('daily') },
        `📅 Günlük${game?.puzzleNo && mode === 'daily' ? ` #${game.puzzleNo}` : ''}`),
      el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'free' && load('free') }, '♾️ Serbest')),
    mode === 'daily' && !inRun ? nameCard() : null,
    ...body(),
    inRun ? null : howToBox(phase === 'ready' || phase === 'setup')));
  if (inRun) current.map.ready.then(() => current?.map.invalidate()).catch(() => {});
}

export function enter(category) {
  leaveLobby();
  root = $('game-whenwhere');
  loadSeq++;
  resetRun();
  if (category === 'multi') {
    const node = root;
    root = null;
    node.replaceChildren();
    enterLobby(node, { setPicker });
    return;
  }
  try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
  try { set = SETS.some((s) => s.id === localStorage.getItem(SET_KEY)) ? localStorage.getItem(SET_KEY) : 'karisik'; } catch { set = 'karisik'; }
  load(mode);
}

export function leave() {
  leaveLobby();
  loadSeq++;
  resetRun();
  root?.replaceChildren();
  root = null;
}
