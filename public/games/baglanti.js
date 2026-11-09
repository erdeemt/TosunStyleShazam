// 🔗 Bağlantı Avı — tek oyunculu akış (Günlük + Sınırsız) ve kabuk. Çok oyunculu (lobi): baglanti-lobby.js. Kurallar: PLAN.md §4.12.
// Her adım sunucuya gider; sunucu bağlantıyı doğrular ve sadece o bağlantının nedenini döner. En kısa yol zincir bitince gelir.
import { net } from '../net.js';
import { $, el, toast } from '../ui.js';
import { DIFFS } from '../baglanti-math.js';
import {
  HOW_TO, chainView, closeSheet, diffLabel, ensureCss, hintsCard, liveClock, loadIndex, openSheet, person, resultCard,
  share, shareText, statsBar,
} from './baglanti-ui.js';
import { enterLobby, leaveLobby } from './baglanti-lobby.js';

const MODE_KEY = 'tss:baglanti-mode';
const DIFF_KEY = 'tss:baglanti-diff';
const base = '/api/baglanti';

let root = null;
let mode = 'daily';
let diff = 'orta';
let game = null; // sunucu yanıtı: { mode, gameId, puzzleNo?, diff, opt, run }
let phase = 'loading'; // loading | error | ready | setup | play | final
let board = null;
let busy = false;
let loadSeq = 0;
let newIndex = -1; // animasyonlu (yeni eklenen) adım

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
    throw new Error('Bağlantı koptu, tekrar dene.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Sunucuya ulaşılamadı, tekrar dene.');
  return json;
}

async function load(newMode = mode) {
  mode = newMode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* yok say */ }
  closeSheet();
  game = null; board = null; busy = false; newIndex = -1;
  phase = 'loading';
  render();
  const seq = ++loadSeq;
  try {
    await Promise.all([ensureIdentity(), loadIndex()]);
    if (seq !== loadSeq) return;
    if (mode === 'free') { phase = 'setup'; render(); return; }
    apply(await api('/start', { mode: 'daily' }));
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(err.message);
    phase = 'error';
  }
  render();
}

function apply(g) {
  game = g;
  if (!g.run) { phase = 'ready'; return; }
  if (g.run.done) { phase = 'final'; closeSheet(); loadBoard(); return; }
  phase = 'play';
}

async function loadBoard() {
  if (mode !== 'daily') return;
  try { board = await api('/leaderboard'); } catch { board = null; }
  render();
}

async function begin() {
  if (busy) return;
  busy = true;
  render();
  try {
    apply(mode === 'free' ? await api('/start', { mode: 'free', difficulty: diff }) : await api('/begin', { mode: 'daily' }));
  } catch (err) { toast(err.message); }
  busy = false;
  render();
}

// Adım: sunucu doğrular. Dönen { ok } arama sayfasına (sallanma/kapanma) gider.
async function step(endpoint, body) {
  const before = game.run.chain.length;
  const g = await api(`/${endpoint}`, { mode, gameId: game.gameId, ...body });
  const fb = g.fb ?? {};
  newIndex = endpoint === 'add' && fb.ok && g.run.chain.length > before ? g.run.chain.length - 1 : -1;
  apply({ ...game, ...g });
  render();
  return { ok: fb.ok !== false, wrong: g.run.wrong };
}

function addPerson() {
  const run = game.run;
  openSheet({
    from: run.chain.length ? run.chain.at(-1).q : run.start,
    target: run.target,
    exclude: [run.start, ...run.chain.map((c) => c.q)],
    onPick: (q) => step('add', { qid: q }).catch((err) => ({ ok: false, error: err.message })),
  });
}

async function removeAt(pos) {
  if (busy) return;
  busy = true;
  try { await step('remove', { pos }); } catch (err) { toast(err.message); }
  busy = false;
  render();
}

async function hint(kind) {
  if (busy) return;
  busy = true;
  try { await step('hint', { kind }); } catch (err) { toast(err.message); }
  busy = false;
  render();
}

async function giveUp() {
  if (busy || !confirm('Pes etmek istiyor musun? Bu yapbozdan 0 puan alırsın, en kısa yol gösterilir.')) return;
  busy = true;
  try { await step('giveup', {}); } catch (err) { toast(err.message); }
  busy = false;
  render();
}

// ---------- Çizim ----------

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

export function diffPicker(selected, onPick, { disabled = false } = {}) {
  return el('div', { class: 'bg-diffs' }, DIFFS.map((d) => el('button', {
    type: 'button',
    class: `rc-diff bg-diff${selected === d.id ? ' active' : ''}`,
    'aria-pressed': selected === d.id ? 'true' : 'false',
    'data-diff': d.id,
    disabled,
    onclick: () => onPick(d.id),
  }, el('b', {}, d.name), el('small', {}, d.hint))));
}

const headLine = () => (mode === 'daily' ? `📅 Günlük #${game.puzzleNo} · ${diffLabel(game.run?.diff ?? game.diff)}` : `♾️ Sınırsız · ${diffLabel(game.run.diff)}`);

function playScreen() {
  const run = game.run;
  const ni = newIndex;
  newIndex = -1;
  return [
    el('div', { class: 'game-head' }, el('div', { class: 'round' }, headLine())),
    statsBar({ run, clockNode: liveClock(run.elapsedMs) }),
    el('section', { class: 'card bg-board' },
      chainView({ start: run.start, target: run.target, steps: run.chain, editable: true, onAdd: addPerson, onRemove: removeAt, newIndex: ni, busy })),
    hintsCard({ run, onHint: hint, busy }),
    el('div', { class: 'row center' }, el('button', { class: 'btn ghost small', onclick: giveUp, disabled: busy, 'data-testid': 'bg-giveup' }, '🏳️ Pes et')),
  ];
}

function finalScreen() {
  const run = game.run;
  return [
    resultCard({ run, headline: headLine() }),
    el('section', { class: 'card' },
      el('h2', {}, run.gaveUp ? '🧩 Senin yarım zincirin' : '🧩 Senin zincirin'),
      chainView({ start: run.start, target: run.target, steps: run.chain, final: run.final, compact: true })),
    run.optimal ? el('section', { class: 'card bg-optimal' },
      el('h2', {}, `🏁 En kısa yol (${run.opt} ara kişi)`),
      chainView({ start: run.start, target: run.target, steps: run.optimal.slice(0, -1), final: run.optimal.at(-1), compact: true }),
      el('p', { class: 'hint' }, 'Aynı uzunlukta başka yollar da olabilir.')) : null,
    el('div', { class: 'row center' },
      el('button', { class: 'btn ghost', onclick: () => share(shareText({ headLine: mode === 'daily' ? `🔗 Bağlantı Avı #${game.puzzleNo}` : '🔗 Bağlantı Avı', run }), toast) }, '📤 Paylaş'),
      mode === 'free' ? el('button', { class: 'btn primary', onclick: () => { phase = 'setup'; render(); }, 'data-testid': 'bg-new-game' }, 'Yeni yapboz →') : null),
    leaderboardPanel(),
  ];
}

function leaderboardPanel() {
  if (mode !== 'daily' || !board) return null;
  return el('section', { class: 'card' },
    el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
    board.entries.length
      ? el('ol', { class: 'w-board bg-lb' }, board.entries.map((e) =>
        el('li', { class: `${e.me ? 'me' : ''}${e.fresh ? ' fresh' : ''}` },
          el('span', { class: 'w-rank' }, e.fresh ? '🆕' : `${e.rank}.`),
          el('span', { class: 'player-name' }, e.name, e.fresh ? el('small', { class: 'w-fresh', title: 'Bu hesap bugün açıldı; günün sıralamasına girmez.' }, '🆕 sıralama dışı') : null),
          el('span', { class: 'bg-lb-meta' }, `🔗${e.steps} ❌${e.wrong}`),
          el('b', { class: 'w-tries' }, String(e.score)),
          e.chain ? el('span', { class: 'bg-lb-chain' }, e.chain.map((q) => person(q).name).join(' → ')) : null)))
      : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi. İlk sen ol!'),
    board.viewerDone ? null : el('p', { class: 'hint' }, 'Başkalarının zincirini görmek için önce kendininkini bitir.'),
    board.gaveUp ? el('p', { class: 'hint' }, `🏳️ ${board.gaveUp} kişi pes etti.`) : null,
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
        el('h2', {}, '♾️ Sınırsız'),
        el('p', { class: 'hint' }, 'Rastgele iki ünlü. Zorluğu seç; istediğin kadar oyna (sıralamaya girmez). Gördüğün yapbozlar tekrar gelmez.'),
        diffPicker(diff, (id) => { diff = id; try { localStorage.setItem(DIFF_KEY, id); } catch { /* yok say */ } render(); }),
        el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: begin, 'data-testid': 'bg-start' }, 'Başla →'))];
    case 'ready':
      return [el('section', { class: 'card center bg-start' },
        el('div', { class: 'hint' }, `📅 Günlük #${game.puzzleNo}`),
        el('h2', {}, 'Bugünün iki ünlüsü seni bekliyor'),
        el('p', { class: 'hint' }, `Herkese aynı yapboz, tek deneme. En kısa yolda ${game.opt} ara kişi var. Süre "Başla"ya basınca işler.`),
        el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: begin, 'data-testid': 'bg-start' }, 'Başla →'))];
    case 'play':
      return playScreen();
    case 'final':
      return finalScreen();
    default:
      return [];
  }
}

function render() {
  if (!root) return;
  const inRun = phase === 'play';
  root.replaceChildren(el('div', { class: 'screen active bg' },
    el('div', { class: 'tabs' },
      el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, onclick: () => mode !== 'daily' && load('daily') },
        `📅 Günlük${game?.puzzleNo && mode === 'daily' ? ` #${game.puzzleNo}` : ''}`),
      el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, onclick: () => mode !== 'free' && load('free') }, '♾️ Sınırsız')),
    mode === 'daily' && !inRun ? nameCard() : null,
    ...body(),
    inRun ? null : howToBox(phase === 'ready' || phase === 'setup')));
}

export function enter(category) {
  ensureCss();
  leaveLobby();
  root = $('game-baglanti');
  loadSeq++;
  closeSheet();
  if (category === 'multi') {
    const node = root;
    root = null;
    node.replaceChildren();
    enterLobby(node, { diffPicker });
    return;
  }
  try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
  try { diff = DIFFS.some((d) => d.id === localStorage.getItem(DIFF_KEY)) ? localStorage.getItem(DIFF_KEY) : 'orta'; } catch { diff = 'orta'; }
  load(mode);
}

export function leave() {
  leaveLobby();
  closeSheet();
  loadSeq++;
  root?.replaceChildren();
  root = null;
}

