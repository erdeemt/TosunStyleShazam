// 📸 Ne Zaman Nerede? — çok oyunculu (lobi) istemcisi. Sunucu: server/games/whenwhere.js; kurallar PLAN.md §4.10.
// Herkes aynı fotoğrafı aynı anda görür; haritaya iğne + yıl kilitler. Tur kapanınca herkesin iğnesi tek haritada.
// Tahmin ekranı (harita + iğne + yıl) görünümler arasında korunur: başkası kilitleyince sıfırlanmaz.
import { net } from '../net.js';
import { mountLobby } from '../lobby.js';
import { el } from '../ui.js';
import { ROUND_OPTIONS, TIME_OPTIONS, fmtDy, fmtKm, setById } from '../whenwhere-math.js';
import { secondsTimer, timeBar } from './recall-client.js';
import { guessMap, revealMap } from './whenwhere-map.js';
import { COLORS, HOW_TO, creditCard, missText, photoCard, pointsLine, scoreClass, viewOfSet, yearPicker } from './whenwhere-ui.js';

const lobbyHowTo = [
  'Herkes aynı tarihi fotoğrafı aynı anda görür. Haritaya iğneni koy, yılı seç, 🔒 Kilitle.',
  ...HOW_TO.slice(1, 3),
  'Süre dolunca iğnen yerindeyse otomatik kilitlenir; hiç iğne koymadıysan o tur 0.',
  'Herkes kilitleyince (ya da süre bitince) gerçek yer açılır: herkesin iğnesi, mesafesi ve puanı tek haritada.',
  'Tur 0–1000 puan (yer 500 + yıl 500). En çok toplayan kazanır.',
  'Oda sahibi seti (Karışık, Türkiye, Eski İstanbul, dönem, tema), tur sayısını ve süreyi seçer.',
];

let root = null;
let lobby = null;
let setPickerFn = null;
let cur = null; // oynanan turun canlı ekranı: { key, map, year, photo, lockBtn, timers, sent }
let cached = { key: '', node: null };
let statusSlot = null;
let disposers = [];

const phaseKey = (v) => `${v.gameKey}:${v.index}:${v.phase}`;
const fullKey = (v, ctx) => `${phaseKey(v)}:${v.me.playing ? 1 : 0}:${v.me.locked ? 1 : 0}:${ctx.isHost ? 1 : 0}`;
const RESEND_CHECK_MS = 1500;

function dispose() {
  for (const d of disposers.splice(0)) { try { d(); } catch { /* yok say */ } }
}

function stopPlay() {
  if (!cur) return;
  cur.timers.forEach(clearTimeout);
  cur.map?.destroy();
  cur.photo?.release();
  cur = null;
}

const colorOf = (view, id) => COLORS[Math.max(0, view.players.findIndex((p) => p.id === id)) % COLORS.length];

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
  return el('div', { class: 'settings ww-settings' },
    el('div', { class: 'hint' }, `Fotoğraf seti: ${setById(settings.set).icon} ${setById(settings.set).name}`),
    setPickerFn(settings.set, (id) => change({ set: id }), { disabled: !editable }),
    el('div', { class: 'hint' }, 'Tur sayısı'),
    el('div', { class: 'pl-tests' }, ROUND_OPTIONS.map((n) => opt('rounds', n, `${n} tur`))),
    el('div', { class: 'hint' }, 'Tur süresi'),
    el('div', { class: 'pl-tests' }, TIME_OPTIONS.map((n) => opt('time', n, `${n} sn`))));
}

// ---------- Ortak parçalar ----------

function head(view, text) {
  return el('div', { class: 'game-head' }, el('div', { class: 'round' }, text),
    el('span', { class: 'ww-set-badge' }, `${setById(view.set).icon} ${setById(view.set).name}`));
}

function statusList(view, ctx) {
  return el('ul', { class: 'rc-status' }, view.players.map((p) =>
    el('li', { class: `${p.locked ? 'in' : ''}${ctx.connected(p.id) ? '' : ' offline'}` },
      el('i', { class: 'ww-swatch', style: `--c:${colorOf(view, p.id)}` }),
      el('span', { class: 'player-name' }, p.name),
      p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
      view.phase === 'play' ? el('span', { class: 'rc-check' }, p.locked ? '🔒 kilitledi' : '…düşünüyor') : null,
      el('span', { class: 'rc-sum' }, `Σ ${p.total}`))));
}

function statusCard(view, ctx) {
  statusSlot = el('div', {}, statusList(view, ctx));
  return el('section', { class: 'card' }, el('h2', {}, '👥 Oyuncular'), statusSlot);
}

function clock(view, ctx) {
  const endsLocal = view.endsAt - ctx.serverOffset;
  return el('div', { class: 'rc-clock' }, '⏱️ ', secondsTimer(endsLocal, { urgentAt: 10 }), timeBar(endsLocal, view.time * 1000));
}

function ranked(rows, valueOf) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  const ranks = sorted.map((p, i) => (i && valueOf(p) === valueOf(sorted[i - 1]) ? null : i + 1));
  for (let i = 1; i < ranks.length; i++) ranks[i] ??= ranks[i - 1];
  return sorted.map((p, i) => ({ p, rank: ranks[i] }));
}

// ---------- Tur ----------

function ensurePlay(view, ctx) {
  const key = phaseKey(view);
  if (cur?.key === key) return cur;
  stopPlay();
  const c = { key, index: view.index, timers: [], sent: false, resent: false, last: null };
  const later = (fn, ms) => c.timers.push(setTimeout(fn, Math.max(0, ms)));
  c.photo = photoCard(view.image);
  c.year = yearPicker({ initial: 1930 });
  c.mapNode = el('div', { class: 'ww-map', 'data-testid': 'ww-guess-map' });
  c.hint = el('p', { class: 'hint center ww-map-hint' }, '👆 Haritaya dokun, iğneyi koy.');
  const startLocal = view.startAt - ctx.serverOffset;
  const endsLocal = view.endsAt - ctx.serverOffset;
  const canLock = () => c.pin && !c.sent && Date.now() >= startLocal - 100;
  c.lockBtn = el('button', { class: 'btn big primary ww-lock', disabled: true, onclick: () => submit() }, '🔒 Kilitle');
  const refresh = () => { c.lockBtn.disabled = !canLock(); };
  c.map = guessMap(c.mapNode, {
    view: viewOfSet(view.set),
    onChange: (pin) => { c.pin = pin; c.hint.textContent = '📌 İğne yerinde. Sürükleyerek düzeltebilirsin.'; refresh(); },
  });
  c.map.ready.catch(() => {});
  const submit = () => {
    if (!c.pin || c.sent || cur !== c) return;
    c.sent = true;
    c.last = { lat: c.pin.lat, lon: c.pin.lon, year: c.year.value() };
    refresh();
    net.action({ type: 'guess', index: c.index, guess: c.last });
    later(() => verifySent(c), RESEND_CHECK_MS);
  };
  c.submit = submit;
  if (startLocal > Date.now()) later(refresh, startLocal - Date.now());
  // Süre dolmadan hemen önce: iğne varsa otomatik kilitle (sunucu 2 sn daha bekler).
  later(() => { if (c.pin && !c.sent) submit(); }, endsLocal - Date.now() - 400);
  cur = c;
  return c;
}

// Gönderilen tahmin sunucuya ulaşmadı mı? (görünüm hâlâ kilitlemedin diyor) Bir kez yeniden gönder, olmazsa düğmeyi aç.
function verifySent(c) {
  const v = net.view;
  if (cur !== c || !c.sent || !v || phaseKey(v) !== c.key || v.me.locked) return;
  if (!c.resent && c.last) {
    c.resent = true;
    net.action({ type: 'guess', index: c.index, guess: c.last });
    c.timers.push(setTimeout(() => verifySent(c), RESEND_CHECK_MS));
    return;
  }
  c.sent = false;
  c.lockBtn.disabled = !c.pin;
}

function playScreen(view, ctx) {
  const top = [head(view, `Fotoğraf ${view.index + 1} / ${view.rounds}`), clock(view, ctx)];
  if (!view.me.playing || view.me.locked) {
    stopPlay();
    const photo = photoCard(view.image);
    disposers.push(() => photo.release());
    return el('div', { class: 'stack ww' }, ...top, photo,
      el('section', { class: 'card center' }, el('p', {}, view.me.playing
        ? `🔒 Kilitlendi: ${view.me.guess?.year ?? ''}. Diğerleri bekleniyor…`
        : '👀 İzliyorsun — oyuncular tahmin ediyor.')),
      statusCard(view, ctx));
  }
  const c = ensurePlay(view, ctx);
  return el('div', { class: 'stack ww' }, ...top, c.photo,
    el('section', { class: 'card ww-guess' },
      el('h2', {}, '🗺️ Nerede?'), c.mapNode, c.hint,
      el('h2', { class: 'ww-when' }, '📅 Ne zaman?'), c.year.node, c.lockBtn),
    statusCard(view, ctx));
}

function revealScreen(view, ctx) {
  const h = view.last;
  const mine = h.results[ctx.playerId];
  const isLast = view.index + 1 >= view.rounds;
  const endsLocal = view.endsAt ? view.endsAt - ctx.serverOffset : 0;
  const pins = view.players.filter((p) => h.results[p.id]?.guess).map((p) => ({
    lat: h.results[p.id].guess.lat,
    lon: h.results[p.id].guess.lon,
    color: colorOf(view, p.id),
    label: p.id === ctx.playerId ? 'Sen' : p.name,
    me: p.id === ctx.playerId,
  }));
  const mapNode = el('div', { class: 'ww-map ww-map-reveal', 'data-testid': 'ww-reveal-map' });
  const m = revealMap(mapNode, { pins, truth: h.truth, view: viewOfSet(view.set) });
  m.ready.catch(() => {});
  disposers.push(() => m.destroy());
  const rows = ranked(view.players, (p) => h.results[p.id]?.score ?? 0);
  return el('div', { class: 'stack ww' },
    head(view, `Fotoğraf ${view.index + 1} / ${view.rounds} sonucu`),
    el('section', { class: 'card center ww-result' },
      mine ? el('div', { class: `ww-big-score ${scoreClass(mine.score)}` }, String(mine.score), el('small', {}, ' / 1000')) : null,
      mine ? el('p', { class: 'ww-miss' }, missText(mine)) : el('p', { class: 'ww-miss' }, `Gerçek: ${h.truth.year}`),
      mine ? pointsLine({ ...mine, truth: h.truth }) : null,
      mapNode),
    el('section', { class: 'card' },
      el('h2', {}, '📊 Bu tur'),
      el('ol', { class: 'rc-rank ww-rank' }, rows.map(({ p, rank }) => {
        const r = h.results[p.id];
        return el('li', { class: `wr${p.id === ctx.playerId ? ' me' : ''}` },
          el('span', { class: 'w-rank' }, `${rank}.`),
          el('span', { class: 'player-name' }, el('i', { class: 'ww-swatch', style: `--c:${colorOf(view, p.id)}` }), p.name),
          el('b', { class: `rc-pts ww-row-score ${scoreClass(r?.score ?? 0)}` }, String(r?.score ?? 0)),
          el('span', { class: 'rc-sum' }, `Σ ${p.total}`),
          el('span', { class: 'rc-ans' }, r?.guess ? `${fmtKm(r.km)} · ${r.guess.year} (${fmtDy(r.dy)})` : 'tahmin yok'));
      }))),
    ctx.isHost && view.me.playing
      ? el('button', { class: 'btn big primary rc-go ww-next', onclick: () => ctx.act({ type: 'next', index: view.index }) },
        isLast ? 'Sonuçları göster' : 'Sonraki →')
      : null,
    el('p', { class: 'hint center' }, ctx.isHost && view.me.playing ? 'Basmazsan ' : 'Oda sahibi geçirmezse ',
      secondsTimer(endsLocal, { urgentAt: 0 }), ' sonra kendiliğinden devam eder.'),
    creditCard(h));
}

function overScreen(view, ctx) {
  const rows = ranked(view.players, (p) => p.total);
  const medals = ['🥇', '🥈', '🥉'];
  const podium = rows.slice(0, 3);
  return el('div', { class: 'stack ww' },
    head(view, 'Oyun bitti'),
    podium.length ? el('section', { class: 'card center ww-podium' },
      el('div', { class: 'ww-podium-row' }, [podium[1], podium[0], podium[2]].filter(Boolean).map(({ p, rank }) =>
        el('div', { class: `ww-step-col r${rank}` },
          el('div', { class: 'ww-medal' }, medals[rank - 1] ?? `${rank}.`),
          el('div', { class: 'player-name' }, p.name),
          el('div', { class: 'ww-podium-score' }, String(p.total)),
          el('div', { class: 'ww-podium-block' }, String(rank)))))) : null,
    el('section', { class: 'card' },
      el('h2', {}, '🏆 Final'),
      rows.length ? el('ol', { class: 'rc-rank ww-final-rank' }, rows.map(({ p, rank }) => el('li', { class: p.id === ctx.playerId ? 'me' : '' },
        el('span', { class: 'w-rank' }, medals[rank - 1] ?? `${rank}.`),
        el('span', { class: 'player-name' }, p.name),
        p.badge ? el('span', { class: 'ww-player-title' }, `${p.badge.icon} ${p.badge.name}`) : null,
        el('b', { class: 'rc-sum' }, `${p.total} / ${view.rounds * 1000}`))))
        : el('p', { class: 'hint' }, 'Herkes oyundan ayrıldı.')),
    view.history.length && rows.length ? el('section', { class: 'card' },
      el('h2', {}, '🧾 Tur tur'),
      el('div', { class: 'ww-table-wrap' }, el('table', { class: 'pl-table ww-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Fotoğraf'), rows.map(({ p }) => el('th', {}, p.name)))),
        el('tbody', {}, view.history.map((h) => el('tr', {},
          el('td', {}, `${h.title} · ${h.truth.year}`),
          rows.map(({ p }) => {
            const s = h.results[p.id]?.score ?? 0;
            return el('td', { class: `ww-row-score ${scoreClass(s)}` }, String(s));
          }))))))) : null);
}

function renderGame(view, ctx) {
  const key = fullKey(view, ctx);
  if (cached.key === key && cached.node) {
    if (statusSlot) statusSlot.replaceChildren(statusList(view, ctx));
    return cached.node;
  }
  if (view.phase !== 'play' || !view.me.playing || view.me.locked) stopPlay();
  dispose();
  statusSlot = null;
  let node;
  if (view.phase === 'play') node = playScreen(view, ctx);
  else if (view.phase === 'reveal' && view.last) node = revealScreen(view, ctx);
  else node = overScreen(view, ctx);
  cached = { key, node };
  if (cur) requestAnimationFrame(() => cur?.map.invalidate());
  return node;
}

function patchGame(view, ctx) {
  if (fullKey(view, ctx) !== cached.key || !statusSlot?.isConnected) return false;
  statusSlot.replaceChildren(statusList(view, ctx));
  return true;
}

// ---------- Kabuk (whenwhere.js enter('multi') çağırır) ----------

export function enterLobby(node, { setPicker }) {
  leaveLobby();
  root = node;
  setPickerFn = setPicker;
  lobby = mountLobby(root, {
    id: 'whenwhere',
    name: 'Ne Zaman Nerede?',
    icon: '📸',
    howTo: lobbyHowTo,
    renderSettings: settingsUI,
    renderGame,
    patchGame,
  });
}

export function leaveLobby() {
  stopPlay();
  dispose();
  cached = { key: '', node: null };
  statusSlot = null;
  lobby?.unmount();
  lobby = null;
  root?.replaceChildren();
  root = null;
}
