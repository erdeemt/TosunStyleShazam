// 🔗 Bağlantı Avı — çok oyunculu (lobi) istemcisi. Sunucu: server/games/baglanti.js; kurallar PLAN.md §4.12.
// Herkes aynı iki kişiyi aynı anda görür; zinciri kuran bitirir. Tur sürerken başkalarının sadece adım sayısı görünür.
// Tur kapanınca herkesin zinciri yan yana + en kısa yol.
import { net } from '../net.js';
import { mountLobby } from '../lobby.js';
import { countdown, el } from '../ui.js';
import { MINUTE_OPTIONS, ROUND_OPTIONS, diffById, fmtClock } from '../baglanti-math.js';
import {
  HOW_TO, chainView, closeSheet, diffLabel, hintsCard, loadIndex, openSheet, person, statsBar,
} from './baglanti-ui.js';

const lobbyHowTo = [
  'Herkes aynı iki ünlüyü aynı anda görür. Aradaki kişileri ekleyip zinciri en kısa ve en hızlı kuran kazanır.',
  ...HOW_TO.slice(1, 4),
  'Tur sürerken diğerlerinin sadece kaç adımda olduğunu görürsün ("Ayşe: 2 adım"); kimleri seçtikleri tur sonunda açılır.',
  'Puan: en kısa zincir 1000; fazladan ara kişi, yanlış deneme, ipucu ve süre puan düşürür. Süre biterse o tur 0.',
  'Oda sahibi zorluğu (2/3/4 ara kişi), tur sayısını (1/3/5) ve süreyi (3/5/8 dk) seçer.',
];

let lobby = null;
let diffPickerFn = null;
let offs = [];
let indexReady = false;
let pending = null; // { n0, resolve, timer } — arama sayfasından gönderilen adımın sonucu
let seen = { key: '', fbN: 0, len: 0 }; // tur başına son geri bildirim (yeni kart animasyonu)
let raceSlot = null;
let cached = { key: '', node: null };

const roundKey = (v) => `${v.gameKey}:${v.index}`;

function settle(result) {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  p.resolve(result);
}

// ---------- Ayarlar ----------

function settingsUI(settings, { editable, change }) {
  const opt = (key, value, label) => el('button', {
    type: 'button',
    class: `pl-test${settings[key] === value ? ' active' : ''}`,
    disabled: !editable,
    'aria-pressed': settings[key] === value ? 'true' : 'false',
    'data-opt': `${key}-${value}`,
    onclick: () => change({ [key]: value }),
  }, label);
  return el('div', { class: 'settings bg-settings' },
    el('div', { class: 'hint' }, `Zorluk: ${diffLabel(settings.difficulty)}`),
    diffPickerFn(settings.difficulty, (id) => change({ difficulty: id }), { disabled: !editable }),
    el('div', { class: 'hint' }, 'Tur sayısı'),
    el('div', { class: 'pl-tests' }, ROUND_OPTIONS.map((n) => opt('rounds', n, `${n} tur`))),
    el('div', { class: 'hint' }, 'Tur süresi'),
    el('div', { class: 'pl-tests' }, MINUTE_OPTIONS.map((n) => opt('minutes', n, `${n} dk`))));
}

// ---------- Parçalar ----------

function head(view, text) {
  return el('div', { class: 'game-head' }, el('div', { class: 'round' }, text),
    el('span', { class: 'bg-diff-badge' }, diffById(view.difficulty).name));
}

function raceList(view, ctx) {
  const rows = [...view.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || (b.steps ?? 0) - (a.steps ?? 0));
  return el('ul', { class: 'rc-status bg-race' }, rows.map((p) => {
    let status;
    if (view.phase !== 'play') status = null;
    else if (p.steps == null) status = '👀 izliyor';
    else if (p.done) status = `✅ ${p.place}. bitirdi (${p.steps} adım)`;
    else if (p.gaveUp) status = '🏳️ pes etti';
    else status = `${p.steps} adım`;
    return el('li', { class: `${p.done ? 'in' : ''}${ctx.connected(p.id) ? '' : ' offline'}` },
      el('span', { class: 'player-name' }, p.name),
      p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
      status ? el('span', { class: 'rc-check' }, status) : null,
      el('span', { class: 'rc-sum' }, `Σ ${p.total}`));
  }));
}

function raceCard(view, ctx) {
  raceSlot = el('div', {}, raceList(view, ctx));
  return el('section', { class: 'card' }, el('h2', {}, '🏁 Yarış'), raceSlot);
}

function clock(view, ctx) {
  return el('div', { class: 'rc-clock bg-lclock' }, '⏱️ ', countdown(view.endsAt, ctx.serverOffset));
}

// ---------- Oyun ekranı ----------

function playScreen(view, ctx) {
  const run = view.me.run;
  const top = [head(view, `Tur ${view.index + 1} / ${view.rounds}`), clock(view, ctx)];
  if (!run) {
    return el('div', { class: 'stack bg' }, ...top,
      el('section', { class: 'card bg-board' }, chainView({ start: view.start, target: view.target, steps: [] })),
      el('p', { class: 'hint center' }, '👀 İzliyorsun — oyuncular zincir kuruyor.'),
      raceCard(view, ctx));
  }
  const key = roundKey(view);
  let newIndex = -1;
  if (seen.key === key && run.chain.length > seen.len && run.fb?.n !== seen.fbN) newIndex = run.chain.length - 1;
  seen = { key, fbN: run.fb?.n ?? 0, len: run.chain.length };
  if (run.done) {
    closeSheet();
    return el('div', { class: 'stack bg' }, ...top,
      el('section', { class: 'card center bg-done' },
        el('div', { class: 'bg-title-icon' }, run.gaveUp ? '🏳️' : '✅'),
        el('h2', {}, run.gaveUp ? 'Pes ettin' : `Bitirdin! ${run.chain.length} ara kişi`),
        el('p', { class: 'hint' }, 'Diğerleri bekleniyor… En kısa yol ve herkesin zinciri tur sonunda.')),
      el('section', { class: 'card bg-board' }, chainView({ start: run.start, target: run.target, steps: run.chain, final: run.final, compact: true, newIndex })),
      raceCard(view, ctx));
  }
  const started = Date.now() >= view.startAt - ctx.serverOffset - 100;
  const index = view.index;
  const onAdd = () => {
    if (!started) return;
    openSheet({
      from: run.chain.length ? run.chain.at(-1).q : run.start,
      target: run.target,
      exclude: [run.start, ...run.chain.map((c) => c.q)],
      onPick: (q) => new Promise((resolve) => {
        settle({ ok: false, error: 'İptal' });
        const n0 = net.view?.me?.run?.fb?.n ?? 0;
        pending = { n0, resolve, timer: setTimeout(() => settle({ ok: false, error: 'Sunucu yanıt vermedi, tekrar dene.' }), 6000) };
        ctx.act({ type: 'add', index, qid: q });
      }),
    });
  };
  return el('div', { class: 'stack bg' }, ...top,
    statsBar({ run }),
    el('section', { class: 'card bg-board' },
      chainView({ start: run.start, target: run.target, steps: run.chain, editable: true, onAdd, onRemove: (pos) => ctx.act({ type: 'remove', index, pos }), newIndex, busy: !started })),
    hintsCard({ run, onHint: (kind) => ctx.act({ type: 'hint', index, kind }) }),
    raceCard(view, ctx),
    el('div', { class: 'row center' }, el('button', {
      class: 'btn ghost small',
      onclick: () => { if (confirm('Bu turda pes etmek istiyor musun? (0 puan)')) ctx.act({ type: 'giveup', index }); },
    }, '🏳️ Pes et')));
}

// Herkesin zinciri yan yana (yatay kaydırma) + en kısa yol.
function columns(h, view, ctx) {
  const cols = [el('div', { class: 'bg-col bg-col-opt' },
    el('div', { class: 'bg-col-head' }, el('b', {}, '🏁 En kısa yol'), el('small', {}, `${h.opt} ara kişi`)),
    chainView({ start: h.start, target: h.target, steps: h.optimal.slice(0, -1), final: h.optimal.at(-1), compact: true }))];
  const rows = view.players.filter((p) => h.results[p.id]).sort((a, b) => h.results[b.id].score - h.results[a.id].score);
  for (const p of rows) {
    const r = h.results[p.id];
    cols.push(el('div', { class: `bg-col${p.id === ctx.playerId ? ' me' : ''}`, 'data-pid': p.id },
      el('div', { class: 'bg-col-head' },
        el('b', {}, r.place ? `${['🥇', '🥈', '🥉'][r.place - 1] ?? `${r.place}.`} ` : '', p.name),
        el('small', {}, r.done ? `${r.score} puan · ${r.chain.length} ara · ❌${r.wrong} · ⏱️${fmtClock(r.ms)}` : r.gaveUp ? '🏳️ pes etti · 0' : '⌛ yetişmedi · 0')),
      chainView({ start: h.start, target: h.target, steps: r.chain, final: r.final, compact: true })));
  }
  return el('div', { class: 'bg-cols', 'data-testid': 'bg-reveal' }, cols);
}

function revealScreen(view, ctx) {
  const h = view.last;
  const isLast = view.index + 1 >= view.rounds;
  closeSheet();
  return el('div', { class: 'stack bg' },
    head(view, `Tur ${view.index + 1} / ${view.rounds} sonucu`),
    el('section', { class: 'card' },
      el('h2', {}, `${person(h.start).name} ➜ ${person(h.target).name}`),
      el('p', { class: 'hint' }, 'Yana kaydır: herkesin zinciri ve en kısa yol.'),
      columns(h, view, ctx)),
    ctx.isHost && view.me.playing
      ? el('button', { class: 'btn big primary rc-go bg-next', onclick: () => ctx.act({ type: 'next', index: view.index }) }, isLast ? 'Sonuçları göster' : 'Sonraki tur →')
      : null,
    el('p', { class: 'hint center' }, ctx.isHost && view.me.playing ? 'Basmazsan ' : 'Oda sahibi geçirmezse ',
      countdown(view.endsAt, ctx.serverOffset), ' sonra kendiliğinden devam eder.'));
}

function overScreen(view, ctx) {
  const rows = [...view.players].sort((a, b) => b.total - a.total);
  const medals = ['🥇', '🥈', '🥉'];
  let rank = 0;
  const ranks = rows.map((p, i) => (rank = i && p.total === rows[i - 1].total ? rank : i + 1));
  const lastH = view.history?.at(-1);
  return el('div', { class: 'stack bg' },
    head(view, 'Oyun bitti'),
    el('section', { class: 'card' },
      el('h2', {}, '🏆 Final'),
      rows.length ? el('ol', { class: 'rc-rank bg-final-rank' }, rows.map((p, i) => el('li', { class: p.id === ctx.playerId ? 'me' : '' },
        el('span', { class: 'w-rank' }, medals[ranks[i] - 1] ?? `${ranks[i]}.`),
        el('span', { class: 'player-name' }, p.name),
        p.badge ? el('span', { class: 'bg-badge' }, `${p.badge.icon} ${p.badge.name}`) : null,
        el('b', { class: 'rc-sum' }, `${p.total} / ${view.rounds * 1000}`)))) : el('p', { class: 'hint' }, 'Herkes oyundan ayrıldı.')),
    view.history?.length && rows.length ? el('section', { class: 'card' },
      el('h2', {}, '🧾 Tur tur'),
      el('div', { class: 'bg-table-wrap' }, el('table', { class: 'pl-table bg-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Yapboz'), rows.map((p) => el('th', {}, p.name)))),
        el('tbody', {}, view.history.map((h) => el('tr', {},
          el('td', {}, `${person(h.start).name} ➜ ${person(h.target).name}`),
          rows.map((p) => el('td', {}, String(h.results[p.id]?.score ?? 0))))))))) : null,
    lastH ? el('section', { class: 'card' }, el('h2', {}, `Son tur: ${person(lastH.start).name} ➜ ${person(lastH.target).name}`), columns(lastH, view, ctx)) : null);
}

function fullKey(view, ctx) {
  const r = view.me.run;
  return [view.gameKey, view.index, view.phase, view.me.playing, ctx.isHost, r?.chain.length, r?.fb?.n, r?.done, r?.hints.length, r?.wrong,
    view.phase === 'play' && Date.now() < view.startAt - ctx.serverOffset ? 'wait' : 'go'].join(':');
}

function renderGame(view, ctx) {
  if (!indexReady) {
    loadIndex().then(() => { indexReady = true; lobby?.rerender(); }).catch(() => {});
    return el('section', { class: 'card' }, 'Kişi listesi yükleniyor…');
  }
  // Bekleyen adımın sonucu: geri bildirim sayacı ilerlediyse
  const fb = view.me.run?.fb;
  if (pending && fb && fb.n !== pending.n0) settle({ ok: fb.ok !== false, wrong: view.me.run.wrong });
  if (pending && (view.phase !== 'play' || !view.me.run || view.me.run.done)) settle({ ok: true });
  const key = fullKey(view, ctx);
  if (cached.key === key && cached.node) {
    if (raceSlot) raceSlot.replaceChildren(raceList(view, ctx));
    return cached.node;
  }
  raceSlot = null;
  let node;
  if (view.phase === 'play') node = playScreen(view, ctx);
  else if (view.phase === 'reveal' && view.last) node = revealScreen(view, ctx);
  else { closeSheet(); node = overScreen(view, ctx); }
  cached = { key, node };
  // Tur başlamadan (senkron payı) "Kişi ekle" kapalı; başlayınca yeniden çiz.
  if (view.phase === 'play' && view.startAt) {
    const wait = view.startAt - ctx.serverOffset - Date.now();
    if (wait > 0) setTimeout(() => lobby?.rerender(), wait + 50);
  }
  return node;
}

function patchGame(view, ctx) {
  if (!indexReady || fullKey(view, ctx) !== cached.key || !raceSlot?.isConnected) return false;
  raceSlot.replaceChildren(raceList(view, ctx));
  return true;
}

// ---------- Kabuk (baglanti.js enter('multi') çağırır) ----------

export function enterLobby(node, { diffPicker }) {
  leaveLobby();
  diffPickerFn = diffPicker;
  loadIndex().then(() => { indexReady = true; lobby?.rerender(); }).catch(() => {});
  offs = [net.on('error', (e) => settle({ ok: false, error: e.message }))];
  lobby = mountLobby(node, {
    id: 'baglanti',
    name: 'Bağlantı Avı',
    icon: '🔗',
    howTo: lobbyHowTo,
    renderSettings: settingsUI,
    renderGame,
    patchGame,
  });
}

export function leaveLobby() {
  settle({ ok: false, error: 'Çıkıldı' });
  closeSheet();
  offs.forEach((off) => off());
  offs = [];
  cached = { key: '', node: null };
  raceSlot = null;
  seen = { key: '', fbN: 0, len: 0 };
  lobby?.unmount();
  lobby = null;
}

