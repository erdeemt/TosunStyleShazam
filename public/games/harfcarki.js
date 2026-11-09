// 🔤 Harf Çarkı — tek oyunculu (📅 Günlük + ♾️ Sınırsız, HTTP). Çok oyunculu (lobi): harfcarki-lobby.js.
// Kurallar: PLAN.md §4.13. İstemci sadece o anki ipucunu görür; cevap sunucuda kontrol edilir, cevaplar oyun bitince gelir.
import { net } from '../net.js';
import { $, el, toast } from '../ui.js';
import {
  DIFF_OPTS, HOW_TO, MIN_OPTS, emojiGrid, ensureCss, fmtTime, keyboardAware, optionButtons, playPanel, recapList,
  share, shareText, summaryLine,
} from './harfcarki-ui.js';
import { enterLobby, leaveLobby } from './harfcarki-lobby.js';

const MODE_KEY = 'tss:harfcarki-mode';
const OPT_KEY = 'tss:harfcarki-free';
const base = '/api/harfcarki';
const DIFF_NAME = Object.fromEntries(DIFF_OPTS);

let root = null;
let mode = 'daily';
let data = null; // sunucu yanıtı (status: ready | playing | done)
let board = null;
let busy = false;
let loadSeq = 0;
let offset = 0; // sunucu saati - yerel saat
let panel = null;
let freeOpts = { difficulty: 'mixed', minutes: 5 };
let disposers = [];

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
  const sentAt = Date.now();
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token, ...body }),
    });
  } catch {
    throw new Error('Bağlantı koptu, tekrar dene.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Sunucuya ulaşılamadı, tekrar dene.');
  if (Number.isFinite(json.serverNow)) offset = json.serverNow - (sentAt + Date.now()) / 2;
  return json;
}

function dropPanel() {
  panel?.destroy();
  panel = null;
  for (const d of disposers.splice(0)) { try { d(); } catch { /* yok say */ } }
}

async function load(newMode = mode) {
  mode = newMode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* yok say */ }
  dropPanel();
  data = null; board = null; busy = false;
  render();
  const seq = ++loadSeq;
  try {
    await ensureIdentity();
    if (seq !== loadSeq) return;
    const d = await api('/start', { mode });
    if (seq !== loadSeq) return;
    apply(d);
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(err.message);
    data = { status: 'error' };
    render();
  }
}

function apply(d, last = null) {
  const wasPlaying = data?.status === 'playing';
  data = d;
  if (d.status === 'done') {
    dropPanel();
    if (mode === 'daily') loadBoard();
    render();
    if (wasPlaying) toast(d.reason === 'time' ? '⏰ Süre doldu!' : d.reason === 'all' ? '🎉 Çarkı bitirdin!' : 'Çark bitti.');
    return;
  }
  if (d.status === 'playing') {
    if (!panel) render();
    panel.update(d, last);
    return;
  }
  render();
}

async function loadBoard() {
  try { board = await api('/leaderboard'); } catch { board = null; }
  render();
}

async function begin() {
  if (busy) return;
  busy = true;
  render();
  try {
    const d = await api('/begin', { mode, ...(mode === 'free' ? freeOpts : {}) });
    busy = false;
    apply(d);
    panel?.focus();
  } catch (err) {
    busy = false;
    toast(err.message);
    render();
  }
}

async function sendMove(body) {
  try {
    const d = await api('/move', { mode, gameId: data.gameId, ...body });
    apply(d, d.last);
  } catch (err) {
    toast(err.message);
    // Harf geçildiyse ya da oyun değiştiyse güncel durumu al
    try { apply(await api('/start', { mode })); } catch { panel?.unlock(); }
  }
}

async function timeUp() {
  // Sunucu saati yetkili: süre dolunca güncel durumu iste (sunucu oyunu bitirir).
  await new Promise((r) => setTimeout(r, 1700));
  if (data?.status !== 'playing') return;
  try { apply(await api('/start', { mode })); } catch { panel?.resetTimeUp(); }
}

// ---------- Çizim ----------

function nameCard() {
  if (net.identity.name && net.identity.name !== 'Oyuncu') return null;
  const input = el('input', { type: 'text', maxlength: '16', placeholder: 'Takma adın', autocomplete: 'nickname' });
  return el('section', { class: 'card' },
    el('h2', {}, '🙋 Sıralamada görünecek adın'),
    el('form', {
      class: 'row',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        net.identity.name = name;
        await ensureIdentity().catch((err) => toast(err.message));
        render();
      },
    }, input, el('button', { class: 'btn primary', type: 'submit' }, 'Kaydet')));
}

function readyCard() {
  if (mode === 'daily') {
    return el('section', { class: 'card center hc-ready' },
      el('h2', {}, `📅 Günün çarkı #${data.puzzleNo}`),
      el('p', {}, `28 harf · ${data.minutes} dakika · herkese aynı çark`),
      el('p', { class: 'hint' }, 'Tek hakkın var: Başla\'ya basınca süre işlemeye başlar, sayfayı kapatsan da durmaz.'),
      el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: begin }, busy ? 'Hazırlanıyor…' : '▶️ Başla'));
  }
  return el('section', { class: 'card hc-ready' },
    el('h2', {}, '♾️ Yeni çark'),
    el('div', { class: 'hint' }, 'Zorluk'),
    optionButtons(DIFF_OPTS, freeOpts.difficulty, (v) => { freeOpts.difficulty = v; saveFree(); render(); }, { key: 'diff' }),
    el('div', { class: 'hint' }, 'Süre'),
    optionButtons(MIN_OPTS, freeOpts.minutes, (v) => { freeOpts.minutes = v; saveFree(); render(); }, { key: 'min' }),
    el('p', { class: 'hint' }, 'Yakında gördüğün ipuçları tekrar gelmez.'),
    el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: begin }, busy ? 'Hazırlanıyor…' : '▶️ Başla'));
}

function saveFree() { try { localStorage.setItem(OPT_KEY, JSON.stringify(freeOpts)); } catch { /* yok say */ } }

function doneCards() {
  const s = data.summary;
  const title = mode === 'daily' ? `Harf Çarkı #${data.puzzleNo}` : `Harf Çarkı · ${DIFF_NAME[data.difficulty] ?? ''}`.trim();
  const states = data.letters.map((l) => l.state);
  return [
    el('section', { class: 'card center hc-result' },
      el('div', { class: 'hc-score' }, `${s.correct}`, el('small', {}, ` / ${data.letters.length}`)),
      el('p', { class: 'hc-summary' }, summaryLine(s)),
      el('p', { class: 'hint' },
        data.reason === 'all' ? `⏱ ${fmtTime(s.durationMs)} sürede bitirdin${s.bonus ? ` · süre ödülü +${s.bonus} puan` : ''}`
          : data.reason === 'time' ? '⏰ Süre doldu' : 'Erken bitirdin',
        ` · ${s.points} puan`),
      el('pre', { class: 'hc-grid' }, emojiGrid(states)),
      el('div', { class: 'row center' },
        el('button', { class: 'btn ghost', onclick: () => share(shareText(title, s, states)) }, '📤 Paylaş'),
        mode === 'free' ? el('button', { class: 'btn primary', onclick: () => { data = { status: 'ready' }; render(); } }, 'Yeni çark →') : null),
      mode === 'daily' ? el('p', { class: 'hint' }, 'Yarın yeni çark!') : null),
    leaderboardPanel(),
    data.recap ? el('section', { class: 'card' }, el('h2', {}, '🔎 Harf harf'), recapList(data.recap)) : null,
  ];
}

function leaderboardPanel() {
  if (mode !== 'daily' || !board) return null;
  return el('section', { class: 'card' },
    el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
    board.entries.length
      ? el('ol', { class: 'w-board hc-board' }, board.entries.map((e, i) =>
        el('li', { class: `${e.me ? 'me' : ''}${e.fresh ? ' fresh' : ''}` },
          el('span', { class: 'w-rank' }, e.fresh ? '🆕' : `${e.rank ?? i + 1}.`),
          el('span', { class: 'player-name' }, e.name, e.fresh ? el('small', { class: 'w-fresh', title: 'Bu hesap bugün açıldı; günün sıralamasına girmez.' }, '🆕 sıralama dışı') : null),
          el('span', { class: 'w-tries hc-b-score' }, `${e.correct}✓ ${e.wrong}✗`, el('small', {}, ` ${fmtTime(e.durationMs)}`)),
          e.grid ? el('span', { class: 'w-mini' }, emojiGrid(e.grid)) : null)))
      : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi.'),
    board.playing ? el('p', { class: 'hint' }, `${board.playing} kişi şu an oynuyor.`) : null);
}

function howToBox(openIt) {
  return el('details', { class: 'card howto-box', open: openIt || null },
    el('summary', {}, '📖 Nasıl oynanır?'),
    el('ul', { class: 'howto' }, HOW_TO.map((l) => el('li', {}, l))));
}

function render() {
  if (!root) return;
  const playing = data?.status === 'playing';
  if (playing && panel?.node.isConnected) return; // panel yerinde güncellenir
  dropPanel();
  let body;
  if (!data) body = [el('p', { class: 'hint center' }, 'Yükleniyor…')];
  else if (data.status === 'error') body = [el('section', { class: 'card center' }, el('p', {}, 'Yüklenemedi.'), el('button', { class: 'btn primary', onclick: () => load(mode) }, 'Tekrar dene'))];
  else if (playing) {
    panel = playPanel({
      offset: () => offset,
      onAnswer: (text, pos) => sendMove({ kind: 'answer', pos, answer: text }),
      onPass: (pos) => sendMove({ kind: 'pass', pos }),
      onQuit: () => sendMove({ kind: 'quit' }),
      onTimeUp: timeUp,
    });
    body = [panel.node];
  } else if (data.status === 'done') body = doneCards();
  else body = [mode === 'daily' ? nameCard() : null, readyCard()];
  const screen = el('div', { class: `screen active hc${playing ? ' hc-playing' : ''}` },
    el('div', { class: 'tabs' },
      el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, disabled: playing, onclick: () => mode !== 'daily' && load('daily') },
        `📅 Günlük${data?.puzzleNo && mode === 'daily' ? ` #${data.puzzleNo}` : ''}`),
      el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, disabled: playing, onclick: () => mode !== 'free' && load('free') }, '♾️ Sınırsız')),
    ...body,
    playing ? null : howToBox(data?.status === 'ready'));
  root.replaceChildren(screen);
  if (panel) {
    const p = panel;
    disposers.push(keyboardAware(screen, () => p.input));
    panel.update(data);
  }
}

// ---------- Kabuk ----------

export function enter(category) {
  ensureCss();
  leaveLobby();
  root = $('game-harfcarki');
  loadSeq++;
  dropPanel();
  if (category === 'multi') {
    const node = root;
    root = null;
    node.replaceChildren();
    enterLobby(node);
    return;
  }
  try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) ?? 'null');
    if (o && DIFF_NAME[o.difficulty] && [3, 5, 7].includes(o.minutes)) freeOpts = o;
  } catch { /* yok say */ }
  load(mode);
}

export function leave() {
  leaveLobby();
  loadSeq++;
  dropPanel();
  data = null;
  root?.replaceChildren();
  root = null;
}
