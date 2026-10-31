// 🟩 Wordle TR — istemci. Tahminler sunucuda değerlendirilir (server/wordle.js), cevap burada yok.
import { net } from '../net.js';
import { $, el, toast } from '../ui.js';

const LENGTH = 5;
const MAX = 6;
const KEY_ROWS = [
  ['e', 'r', 't', 'y', 'u', 'ı', 'o', 'p', 'ğ', 'ü'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ş', 'i'],
  ['enter', 'z', 'c', 'v', 'b', 'n', 'm', 'ö', 'ç', 'back'],
];
const LETTERS = new Set(KEY_ROWS.flat().filter((k) => k.length === 1));
const RANK = { absent: 1, present: 2, correct: 3 };
const EMOJI = { correct: '🟩', present: '🟨', absent: '⬛' };
const MODE_KEY = 'tss:wordle-mode';

let root = null;
let mode = 'daily';
let game = null; // { gameId, puzzleNo, guesses: [{ word, marks }], done, won, answer }
let typed = '';
let busy = false;
let shakeRow = false;
let revealRow = -1; // son açılan satır animasyonlu çizilir
let board = null; // sıralama
let onKey = null;

// ---------- Sunucu ----------

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
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token, ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Sunucu hatası');
  return json;
}

async function load(newMode = mode) {
  mode = newMode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* yok say */ }
  game = null;
  typed = '';
  board = null;
  render();
  try {
    await ensureIdentity();
    game = await api('/api/wordle/start', { mode });
    revealRow = -1;
    if (mode === 'daily' && game.done) await loadBoard();
  } catch (err) {
    toast(err.message);
  }
  render();
}

async function loadBoard() {
  try { board = await api('/api/wordle/leaderboard'); } catch { board = null; }
}

async function submit() {
  if (!game || game.done || busy) return;
  if ([...typed].length !== LENGTH) { shake('Harf eksik.'); return; }
  busy = true;
  try {
    const res = await api('/api/wordle/guess', { mode, gameId: game.gameId, word: typed });
    game = { ...game, ...res };
    typed = '';
    revealRow = game.guesses.length - 1;
    render();
    if (game.done) {
      setTimeout(() => toast(game.won ? ['Dahi!', 'Muhteşem!', 'Harika!', 'Güzel!', 'Fena değil!', 'Kıl payı!'][game.guesses.length - 1] : `Kelime: ${game.answer.toLocaleUpperCase('tr')}`), 1500);
      if (mode === 'daily') { await loadBoard(); setTimeout(render, 1600); }
    }
  } catch (err) {
    shake(err.message);
  } finally {
    busy = false;
  }
}

function shake(msg) {
  toast(msg);
  shakeRow = true;
  render();
  setTimeout(() => { shakeRow = false; }, 500);
}

function press(key) {
  if (!game || game.done) return;
  if (key === 'enter') return submit();
  if (key === 'back') typed = [...typed].slice(0, -1).join('');
  else if (LETTERS.has(key) && [...typed].length < LENGTH) typed += key;
  render();
}

// ---------- Çizim ----------

function keyStates() {
  const states = {};
  for (const g of game?.guesses ?? []) {
    [...g.word].forEach((ch, i) => {
      if ((RANK[g.marks[i]] ?? 0) > (RANK[states[ch]] ?? 0)) states[ch] = g.marks[i];
    });
  }
  return states;
}

function grid(flipRow) {
  const rows = [];
  for (let r = 0; r < MAX; r++) {
    const g = game?.guesses[r];
    const isCurrent = !g && r === (game?.guesses.length ?? 0) && !game?.done;
    const letters = g ? [...g.word] : isCurrent ? [...typed] : [];
    rows.push(el('div', { class: `w-row${isCurrent && shakeRow ? ' shake' : ''}` },
      Array.from({ length: LENGTH }, (_, i) => {
        const mark = g?.marks[i];
        const tile = el('div', {
          class: `w-tile${letters[i] ? ' filled' : ''}${mark ? ` ${mark}` : ''}${r === flipRow ? ' flip' : ''}`,
        }, letters[i]?.toLocaleUpperCase('tr') ?? '');
        if (r === flipRow) tile.style.animationDelay = `${i * 250}ms`;
        return tile;
      })));
  }
  return el('div', { class: 'w-grid' }, rows);
}

function keyboard() {
  const states = keyStates();
  return el('div', { class: 'w-keys' }, KEY_ROWS.map((row) =>
    el('div', { class: 'w-keyrow' }, row.map((k) =>
      el('button', {
        type: 'button',
        class: `w-key${k.length > 1 ? ' wide' : ''} ${states[k] ?? ''}`,
        'aria-label': k === 'enter' ? 'Gönder' : k === 'back' ? 'Sil' : k,
        onclick: () => press(k),
      }, k === 'enter' ? 'GİR' : k === 'back' ? '⌫' : k.toLocaleUpperCase('tr'))))));
}

function shareText() {
  const title = mode === 'daily' ? `Tosun Wordle #${game.puzzleNo}` : 'Tosun Wordle (sınırsız)';
  const rows = game.guesses.map((g) => g.marks.map((m) => EMOJI[m]).join(''));
  return `${title} ${game.won ? game.guesses.length : 'X'}/${MAX}\n${rows.join('\n')}`;
}

function nextPuzzleIn() {
  // İstanbul gece yarısına kalan süre (UTC+3, yaz saati yok)
  const now = Date.now();
  const istanbul = new Date(now + 3 * 3600_000);
  const midnight = Date.UTC(istanbul.getUTCFullYear(), istanbul.getUTCMonth(), istanbul.getUTCDate() + 1) - 3 * 3600_000;
  const left = Math.max(0, midnight - now);
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  return `${h} sa ${m} dk`;
}

function resultPanel() {
  if (!game?.done) return null;
  return el('section', { class: 'card center w-result' },
    el('div', { class: `result-msg ${game.won ? 'good' : 'bad'}` },
      game.won ? `🎉 ${game.guesses.length}/${MAX}` : '😬 Bilemedin'),
    el('p', {}, 'Kelime: ', el('b', {}, game.answer?.toLocaleUpperCase('tr') ?? '')),
    el('div', { class: 'row center' },
      el('button', {
        class: 'btn ghost',
        onclick: async () => {
          const text = shareText();
          try {
            if (navigator.share) await navigator.share({ text });
            else { await navigator.clipboard.writeText(text); toast('Sonuç kopyalandı.'); }
          } catch { /* iptal */ }
        },
      }, '📤 Paylaş'),
      mode === 'free' ? el('button', { class: 'btn primary', onclick: () => load('free') }, 'Yeni kelime →') : null),
    mode === 'daily' ? el('p', { class: 'hint' }, `Yeni kelimeye ${nextPuzzleIn()} var.`) : null);
}

function leaderboardPanel() {
  if (mode !== 'daily' || !board) return null;
  return el('section', { class: 'card' },
    el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
    board.entries.length
      ? el('ol', { class: 'w-board' }, board.entries.map((e, i) =>
        el('li', { class: `${e.me ? 'me' : ''}${e.fresh ? ' fresh' : ''}` },
          el('span', { class: 'w-rank' }, e.fresh ? '🆕' : `${e.rank ?? i + 1}.`),
          el('span', { class: 'player-name' }, e.name, e.fresh ? el('small', { class: 'w-fresh', title: 'Bu hesap bugün açıldı; günün sıralamasına girmez.' }, '🆕 sıralama dışı') : null),
          el('span', { class: 'w-tries' }, e.won ? `${e.tries}/${MAX}` : 'X'),
          e.grid ? el('span', { class: 'w-mini' }, e.grid.map((row) => row.map((m) => EMOJI[m]).join('')).join('\n')) : null)))
      : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi.'),
    board.playing ? el('p', { class: 'hint' }, `${board.playing} kişi şu an çözüyor.`) : null);
}

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

function render() {
  if (!root) return;
  const flipRow = revealRow; // açılış animasyonu sadece bir kez oynar
  revealRow = -1;
  root.replaceChildren(el('div', { class: 'screen active wordle' },
    el('div', { class: 'tabs' },
      el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, onclick: () => mode !== 'daily' && load('daily') },
        `📅 Günlük${game?.puzzleNo && mode === 'daily' ? ` #${game.puzzleNo}` : ''}`),
      el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, onclick: () => mode !== 'free' && load('free') }, '♾️ Sınırsız')),
    mode === 'daily' ? nameCard() : null,
    game ? grid(flipRow) : el('p', { class: 'hint center' }, 'Yükleniyor…'),
    resultPanel(),
    game && !game.done ? keyboard() : null,
    leaderboardPanel(),
    el('details', { class: 'card howto-box' },
      el('summary', {}, '📖 Nasıl oynanır?'),
      el('ul', { class: 'howto' },
        el('li', {}, '5 harfli Türkçe kelimeyi 6 denemede bul.'),
        el('li', {}, '🟩 harf doğru yerde, 🟨 kelimede var ama başka yerde, ⬛ kelimede yok.'),
        el('li', {}, 'Günlük kelime herkese aynı; sıralamada arkadaşlarınla karşılaştır. Sınırsız modda istediğin kadar oyna.')))));
}

// ---------- Kabuk ----------

export function enter() {
  root = $('game-wordle');
  try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
  onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Enter') { e.preventDefault(); press('enter'); return; }
    if (e.key === 'Backspace') { e.preventDefault(); press('back'); return; }
    const k = e.key.toLocaleLowerCase('tr');
    if (LETTERS.has(k)) press(k);
  };
  window.addEventListener('keydown', onKey);
  load(mode);
}

export function leave() {
  window.removeEventListener('keydown', onKey);
  root = null;
}
