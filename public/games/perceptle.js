// 👁️ Algıla — günlük algı testi (perceptle.com tarzı), sadece tek oyunculu. Beş test sırayla:
// 🔢 Say, ☄️ Yörünge, 📐 Açı, 🥁 Ritim, ✂️ Böl. Puanı sunucu hesaplar (server/perceptle.js). Kurallar: PLAN.md §4.7.
import { net } from '../net.js';
import { $, el, toast } from '../ui.js';
import { TESTS, gradeOf, squareOf } from '../perceptle-math.js';
import { TEST_UI, revealView } from './perceptle-tests.js';
import { unlockAudio } from './tone-audio.js';

const MODE_KEY = 'tss:perceptle-mode';
const RULES_KEY = 'tss:perceptle-rules';
const base = '/api/perceptle';

const META = {
  count: {
    icon: '🔢', name: 'Say',
    normal: 'Noktalar 2 saniye görünecek. Kaç tane olduklarını tahmin et.',
    friday: 'Noktalar hareket ediyor! 2 saniyede kaç tane olduklarını tahmin et.',
  },
  track: {
    icon: '☄️', name: 'Yörünge',
    normal: 'Top fırlatılacak ve yolda kaybolacak. Yere nereye düşeceğine dokun, sonra Kilitle.',
    friday: 'Yerçekimi zayıf ve top yan duvarlardan seker! Nereye düşeceğine dokun, sonra Kilitle.',
  },
  angle: {
    icon: '📐', name: 'Açı',
    normal: 'Kesikli çizgi 0°. Saat yönünün tersine istenen açıyı parmağınla çiz; bırakınca kilitlenir.',
    friday: 'Açı 360°\'ı aşabilir: tam turları da döndür (her tur sayılır), sonra Kilitle.',
  },
  tempo: {
    icon: '🥁', name: 'Ritim',
    normal: '4 vuruş duyacaksın, istersen birlikte vur. Sonra ses kesilir: aynı tempoda 8 vuruş daha sen vur. Sesini aç 🔈',
    friday: '4 vuruşu dinle; sonra ses kesilince 8 kez tam iki vuruşun ARASINA vur. Sesini aç 🔈',
  },
  split: {
    icon: '✂️', name: 'Böl',
    normal: 'Çizgide istenen kesrin ya da yüzdenin yerini bul ve Kilitle.',
    friday: 'Kesir çizginin dışına taşabilir (8/5, −1/4 gibi): uzantıya da koyabilirsin.',
  },
};

const HOW_TO = [
  'Beş kısa algı testi, hep aynı sırayla: 🔢 Say, ☄️ Yörünge, 📐 Açı, 🥁 Ritim, ✂️ Böl.',
  '🔢 Say: noktalar 2 saniye görünür; kaç tane olduklarını tahmin et.',
  '☄️ Yörünge: topun yayını izle; kaybolunca yere nereye düşeceğine dokun.',
  '📐 Açı: sağa bakan kesikli çizgiden saat yönünün tersine istenen açıyı çiz.',
  '🥁 Ritim: 4 vuruşu dinle (istersen birlikte vur), ses kesilince 8 vuruş daha sen vur.',
  '✂️ Böl: çizgide istenen kesrin ya da yüzdenin yerini bul.',
  'Her test 0–100 puan. Sonuç beşinin ortalaması ve bir harf notu: S, A, B, C, D, F.',
  '🃏 Cuma günleri kurallar değişir: noktalar kayar, top duvardan seker, açı 360°\'ı aşar, ritim vuruş aralarına kayar, kesir çizgiden taşar.',
];

// ---------- Biçimleme ----------

const fmt = (v, d = 0) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('tr-TR', { maximumFractionDigits: d });
const pct = (e) => `%${fmt(e * 100)} hata`;
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v))}`;

function detailText(p) {
  if (p.timedOut || p.answer == null) return 'Süre doldu';
  switch (p.test) {
    case 'count': return `Gerçek ${p.truth} · Sen ${p.answer} · ${pct(p.error)}`;
    case 'track': return `İniş ${fmt(p.truth)} · Sen ${fmt(p.answer)} · ${fmt(p.error)} birim fark`;
    case 'angle': return `Hedef ${p.truth}° · Sen ${fmt(p.answer, 1)}° · ${fmt(p.error, 1)}° fark`;
    case 'tempo': {
      const d = p.detail ?? {};
      return `${p.truth} BPM · ${d.hits ?? 0}/8 vuruş · ${fmt(p.error)} ms sapma${d.latency ? ` · gecikme ${signed(d.latency)} ms` : ''}`;
    }
    default: return `Hedef ${p.label ? `${p.label} (${fmt(p.truth, 2)})` : fmt(p.truth, 2)} · Sen ${fmt(p.answer, 2)} · ${pct(p.error)}`;
  }
}

const scoreClass = (s) => (s >= 85 ? 'good' : s >= 55 ? 'mid' : 'bad');

function shareText(g) {
  const head = g.mode === 'daily'
    ? `Tosun Algıla #${g.puzzleNo}${g.friday ? ' 🃏' : ''}`
    : `Tosun Algıla (sınırsız${g.friday ? ', 🃏 Cuma' : ''})`;
  return `${head} · ${g.total} (${g.grade ?? gradeOf(g.total)})\n${g.played.map((p) => squareOf(p.score)).join('')}`;
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

// ---------- Durum ----------

let root = null;
let mode = 'daily';
let rules = 'normal'; // sınırsız: 'normal' | 'friday'
let game = null; // sunucunun publicGame'i
let phase = 'loading'; // loading | error | setup | ready | intro | running | retry | result | final
let current = null; // { index, resp, ui, stim }
let lastPlayed = null;
let lastStim = null;
let board = null;
let busy = false;
let loadSeq = 0;
const timers = new Set();
const later = (fn, ms) => {
  const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms));
  timers.add(t);
};

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

// Ağ hatası / 5xx: err.retry = true (tekrar denenebilir), Türkçe mesajla.
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
  timers.forEach(clearTimeout);
  timers.clear();
  current?.ui?.stop();
  game = null; current = null; lastPlayed = null; lastStim = null; board = null; busy = false;
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
    if (mode === 'free') { phase = 'setup'; render(); return; }
    const g = await api('/start', { mode: 'daily' });
    if (seq !== loadSeq) return;
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
  if (g.pending) {
    // Sayfa test sürerken yenilendi: zamanlı gösterim tekrar edilmez; açı/böl hedefi tekrar gelir.
    const p = g.pending;
    const wait = p.recallAt - g.serverNow;
    if (p.test === 'tempo') {
      phase = 'running';
      current = { index: p.index, ui: { node: el('p', { class: 'hint center' }, 'Ritim testi yarıda kaldı; tekrar çalınamaz.'), stop() {} } };
      later(() => sendAnswer([]), wait + 100);
      return;
    }
    const start = () => runTest(p.index, { stimulus: p.stimulus, showMs: 0, leadMs: 0, timeScale: 1, friday: g.friday });
    if (wait > 0) { phase = 'loading'; later(() => { start(); render(); }, wait + 100); } else start();
    return;
  }
  phase = g.played.length ? 'intro' : 'ready';
}

async function loadBoard() {
  if (mode !== 'daily') return;
  try { board = await api('/leaderboard'); } catch { board = null; }
  render();
}

async function startFree() {
  if (busy) return;
  busy = true;
  try {
    game = await api('/start', { mode: 'free', rules });
    phase = 'intro';
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
  }
  render();
}

// Testin uyaranını iste ve ekranı aç (dokunuş anında: ses ancak etkileşimden sonra açılır).
async function beginTest() {
  if (busy || !game) return;
  unlockAudio();
  busy = true;
  const index = game.played.length;
  try {
    const r = await api('/test', { mode, gameId: game.gameId, index });
    runTest(index, r);
  } catch (err) {
    toast(err.message);
    if (mode === 'daily') load('daily');
  } finally {
    busy = false;
  }
  render();
}

function runTest(index, r) {
  const test = TESTS[index];
  current = { index, stim: r.stimulus ?? null };
  current.ui = TEST_UI[test]({
    stim: r.stimulus ?? null,
    friday: game.friday,
    showMs: r.showMs ?? 0,
    leadMs: r.leadMs ?? 0,
    timeScale: r.timeScale ?? 1,
    submit: (answer) => sendAnswer(answer),
  });
  phase = 'running';
}

// Gönderim düşerse cevap kaybolmasın (ritim dokunuşları dahil): 3 deneme, sonra "Tekrar gönder" ekranı.
let pendingAnswer = null;
const RETRY_DELAYS = [600, 1500];

async function submitWithRetry(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('/submit', body);
    } catch (err) {
      if (!err.retry || attempt >= RETRY_DELAYS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

async function sendAnswer(answer) {
  if ((phase !== 'running' && phase !== 'retry') || busy || !current) return;
  busy = true;
  pendingAnswer = answer;
  const { index, stim } = current;
  try {
    const g = await submitWithRetry({ mode, gameId: game.gameId, index, answer });
    pendingAnswer = null;
    current.ui.stop();
    game = g;
    lastPlayed = g.played.find((p) => p.index === index) ?? null;
    lastStim = stim;
    current = null;
    phase = 'result';
    if (g.done) loadBoard();
  } catch (err) {
    toast(err.message);
    if (err.retry) phase = 'retry';
    // Cevap aslında ulaşmış (yanıt kaybolmuş) ya da oyun değişmiş: durumu sunucudan yeniden yükle.
    else if (/zaten alındı|değişti|bulunamadı|başlamadı/.test(err.message)) { pendingAnswer = null; load(mode); }
  } finally {
    busy = false;
  }
  render();
}

// ---------- Çizim ----------

function progress() {
  const played = game?.played ?? [];
  return el('div', { class: 'rc-dots pc-dots' }, TESTS.map((t, i) => {
    const p = played.find((x) => x.index === i);
    const now = current?.index === i || (!p && played.length === i && phase === 'intro');
    return el('span', { class: `rc-dot${p ? ` done ${scoreClass(p.score)}` : ''}${now ? ' now' : ''}`, title: META[t].name },
      `${META[t].icon} ${p ? p.score : ''}`.trim());
  }));
}

function rulesBadge(friday) {
  return friday ? el('span', { class: 'pc-friday' }, '🃏 Cuma kuralları') : null;
}

function head(text) {
  return el('div', { class: 'game-head' },
    el('div', { class: 'round' }, text),
    rulesBadge(game?.friday));
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

function rulesPicker() {
  const opt = (id, label, hint) => el('button', {
    type: 'button',
    class: `rc-diff${rules === id ? ' active' : ''}`,
    'aria-pressed': rules === id ? 'true' : 'false',
    onclick: () => {
      rules = id;
      try { localStorage.setItem(RULES_KEY, id); } catch { /* yok say */ }
      render();
    },
  }, el('b', {}, label), el('small', {}, hint));
  return el('div', { class: 'rc-diffs' },
    opt('normal', 'Normal', 'Klasik kurallar'),
    opt('friday', '🃏 Cuma kuralları', 'Hareketli, sekmeli, daha zor'));
}

function testRow(p) {
  const m = META[p.test];
  return el('div', { class: 'pc-row' },
    el('span', { class: 'pc-row-icon' }, m.icon),
    el('div', { class: 'pc-row-text' }, el('b', {}, m.name), el('small', {}, detailText(p))),
    el('b', { class: `pc-row-score ${scoreClass(p.score)}` }, String(p.score)));
}

function finalCard() {
  const grade = game.grade ?? gradeOf(game.total);
  return el('section', { class: 'card center pc-final' },
    el('div', { class: 'hint' }, mode === 'daily' ? `📅 Günlük #${game.puzzleNo}` : '♾️ Sınırsız', game.friday ? ' · 🃏 Cuma kuralları' : ''),
    el('div', { class: `pc-grade g-${grade}` }, grade),
    el('div', { class: 'pc-total' }, `${game.total}`, el('small', {}, ' / 100')),
    el('div', { class: 'pc-rows' }, game.played.map(testRow)),
    el('div', { class: 'row center' },
      el('button', { class: 'btn ghost', onclick: () => share(shareText({ ...game, mode })) }, '📤 Paylaş'),
      mode === 'free' ? el('button', { class: 'btn primary', onclick: () => load('free') }, 'Yeni oyun →') : null),
    mode === 'daily' ? el('p', { class: 'hint' }, `Yeni günlük teste ${nextPuzzleIn()} var.`) : null);
}

function leaderboardPanel() {
  if (mode !== 'daily' || !board) return null;
  return el('section', { class: 'card' },
    el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
    board.entries.length
      ? el('ol', { class: 'w-board rc-board pc-board' }, board.entries.map((e) =>
        el('li', { class: e.me ? 'me' : '' },
          el('span', { class: 'w-rank' }, `${e.rank}.`),
          el('span', { class: 'player-name' }, e.name),
          el('span', { class: 'w-tries' }, `${e.total} (${e.grade})`),
          e.scores ? el('span', { class: 'rc-mini pc-mini' }, e.scores.map((s, i) => el('span', { class: `pc-chip ${scoreClass(s)}`, title: META[TESTS[i]].name }, `${META[TESTS[i]].icon}${s}`))) : null)))
      : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi. İlk sen ol!'),
    board.viewerDone ? null : el('p', { class: 'hint' }, 'Başkalarının test puanlarını görmek için önce kendi testini bitir.'),
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
        el('h2', {}, '♾️ Sınırsız oyun'),
        el('p', { class: 'hint' }, 'Kuralları seç; istediğin kadar oyna (sıralamaya girmez).'),
        rulesPicker(),
        el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: startFree }, 'Başla →'))];
    case 'ready':
      return [el('section', { class: 'card center pc-start' },
        el('div', { class: 'hint' }, `📅 Günlük #${game.puzzleNo}`),
        rulesBadge(game.friday),
        el('h2', {}, '5 test, tek deneme'),
        el('p', { class: 'hint' }, 'Algın ne kadar keskin? Saymak, kestirmek, ritim tutmak… Her test birkaç saniye sürer.'),
        progress(),
        el('button', { class: 'btn big primary rc-go', onclick: () => { phase = 'intro'; render(); } }, 'Başla →'))];
    case 'intro': {
      const i = game.played.length;
      const t = TESTS[i];
      return [head(`Test ${i + 1} / ${TESTS.length}`),
        el('section', { class: 'card center pc-intro' },
          el('div', { class: 'pc-intro-icon' }, META[t].icon),
          el('h2', {}, META[t].name),
          el('p', {}, META[t][game.friday ? 'friday' : 'normal']),
          el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: beginTest }, 'Hazırım →')),
        progress()];
    }
    case 'running': {
      const t = TESTS[current.index];
      return [head(`Test ${current.index + 1} / ${TESTS.length} · ${META[t].icon} ${META[t].name}`), current.ui.node, progress()];
    }
    case 'retry': {
      const t = TESTS[current.index];
      return [head(`Test ${current.index + 1} / ${TESTS.length} · ${META[t].icon} ${META[t].name}`),
        el('section', { class: 'card center' },
          el('h2', {}, '📡 Bağlantı koptu'),
          el('p', {}, 'Cevabın telefonda duruyor, kaybolmadı. İnternet gelince tekrar gönder.'),
          el('button', { class: 'btn big pc-lock', disabled: busy, onclick: () => sendAnswer(pendingAnswer) }, '🔁 Tekrar gönder')),
        progress()];
    }
    case 'result': {
      const p = lastPlayed;
      const view = p ? revealView(p.test, lastStim, p.answer, game.friday) : null;
      return [head(`Test ${p.index + 1} / ${TESTS.length} sonucu`),
        el('section', { class: 'card center pc-result' },
          el('div', { class: 'pc-result-icon' }, `${META[p.test].icon} ${META[p.test].name}`),
          el('div', { class: `pc-big-score ${scoreClass(p.score)}` }, String(p.score), el('small', {}, ' / 100')),
          el('p', { class: 'pc-detail' }, detailText(p)),
          view ? el('div', { class: 'pc-reveal' }, view, el('p', { class: 'pc-legend' }, el('i', { class: 'good' }), ' doğru  ', el('i', { class: 'you' }), ' sen')) : null,
          el('button', {
            class: 'btn big primary rc-go',
            onclick: () => { phase = game.done ? 'final' : 'intro'; render(); },
          }, game.done ? 'Sonucu gör →' : `Sonraki test → (${game.played.length + 1}/${TESTS.length})`)),
        progress()];
    }
    case 'final':
      return [finalCard(), leaderboardPanel()];
    default:
      return [];
  }
}

function render() {
  if (!root) return;
  const inRun = phase === 'running' || phase === 'retry';
  root.replaceChildren(el('div', { class: 'screen active recall pc' },
    el('div', { class: 'tabs' },
      el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'daily' && load('daily') },
        `📅 Günlük${game?.puzzleNo && mode === 'daily' ? ` #${game.puzzleNo}` : ''}`),
      el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'free' && load('free') }, '♾️ Sınırsız')),
    mode === 'daily' && !inRun ? nameCard() : null,
    ...body(),
    inRun ? null : howToBox(phase === 'ready' || phase === 'setup')));
}

export function enter() {
  root = $('game-perceptle');
  loadSeq++;
  resetRun();
  try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
  try { rules = localStorage.getItem(RULES_KEY) === 'friday' ? 'friday' : 'normal'; } catch { rules = 'normal'; }
  load(mode);
}

export function leave() {
  loadSeq++;
  resetRun();
  root?.replaceChildren();
  root = null;
}
