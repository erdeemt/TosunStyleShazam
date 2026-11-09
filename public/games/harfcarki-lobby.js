// 🔤 Harf Çarkı — çok oyunculu (lobi "kapışma") istemcisi. Sunucu: server/games/harfcarki.js; kurallar PLAN.md §4.13.
// Herkes aynı çarkı aynı saatle kendi hızında oynar; altta herkesin mini çarkı (sadece renkler) canlı güncellenir.
// Oyun paneli bir kez kurulur ve görünümler arasında yerinde güncellenir (yazı kutusu/klavye korunur).
import { mountLobby } from '../lobby.js';
import { el } from '../ui.js';
import {
  DIFF_OPTS, HOW_TO, MIN_OPTS, emojiGrid, fmtTime, keyboardAware, miniWheel, optionButtons, playPanel, recapList,
  share, shareText, summaryLine,
} from './harfcarki-ui.js';

const lobbyHowTo = [
  'Oda sahibi başlatınca herkes AYNI çarkı aynı anda alır; süre herkes için aynı, herkes kendi hızında oynar.',
  ...HOW_TO.slice(0, 3),
  'Altta herkesin mini çarkını canlı görürsün (sadece renkler; cevaplar oyun bitince açılır).',
  'Sıralama: en çok doğru, sonra en az yanlış, sonra en hızlı bitiren. Oda sahibi süreyi (3/5/7 dk) ve zorluğu seçer.',
];
const DIFF_NAME = Object.fromEntries(DIFF_OPTS);

let root = null;
let lobby = null;
let cur = null; // { key, node, panel, minis, seq, dispose }
let pendingTimer = null;

const keyOf = (v, ctx) => {
  const run = v.me.run;
  const mode = v.over ? 'over' : v.me.playing && !run?.done ? 'play' : v.me.playing ? 'wait' : 'watch';
  return `${v.gameKey}:${mode}:${ctx.isHost ? 1 : 0}`;
};

function teardown() {
  clearTimeout(pendingTimer);
  cur?.panel?.destroy();
  cur?.dispose?.();
  cur = null;
}

// ---------- Ayarlar ----------

function settingsUI(settings, { editable, change }) {
  return el('div', { class: 'settings hc-settings' },
    el('div', { class: 'hint' }, 'Süre (tüm çark)'),
    optionButtons(MIN_OPTS, settings.minutes, (v) => change({ minutes: v }), { disabled: !editable, key: 'minutes' }),
    el('div', { class: 'hint' }, 'Zorluk'),
    optionButtons(DIFF_OPTS, settings.difficulty, (v) => change({ difficulty: v }), { disabled: !editable, key: 'difficulty' }));
}

// ---------- Canlı ilerleme ----------

function minisList(view, ctx) {
  return el('ul', { class: 'hc-minis' }, view.players.map((p) =>
    el('li', { class: `${p.id === ctx.playerId ? 'me' : ''}${ctx.connected(p.id) ? '' : ' offline'}`, 'data-pid': p.id },
      miniWheel(p.states, { cur: p.pos }),
      el('span', { class: 'player-name' }, p.name),
      el('span', { class: 'hc-mini-score' }, `${p.correct}✓ ${p.wrong}✗`, p.done ? ' 🏁' : ''))));
}

function header(view, ctx) {
  return el('div', { class: 'game-head' },
    el('div', { class: 'round' }, `🔤 ${view.settings.minutes} dk · ${DIFF_NAME[view.settings.difficulty]}`),
    el('span', { class: 'hint' }, `${view.players.length} oyuncu`));
}

// Bekleyen / izleyen için büyük süre göstergesi (sunucu saatiyle)
function clockLine(view, ctx) {
  const node = el('div', { class: 'hc-clock' });
  const t = () => {
    if (!node.isConnected && node.dataset.on) return;
    node.dataset.on = '1';
    const now = Date.now() + ctx.serverOffset;
    node.textContent = now < view.startAt ? `Başlıyor: ${Math.ceil((view.startAt - now) / 1000)}` : `⏱ ${fmtTime(view.endsAt - now)}`;
    setTimeout(t, 250);
  };
  t();
  return node;
}

// ---------- Ekranlar ----------

function playScreen(view, ctx) {
  const panel = playPanel({
    offset: () => ctx.serverOffset,
    onAnswer: (text, pos) => { ctx.act({ type: 'answer', pos, text }); armUnlock(); },
    onPass: (pos) => { ctx.act({ type: 'pass', pos }); armUnlock(); },
    onQuit: () => ctx.act({ type: 'quit' }),
    onTimeUp: () => {},
  });
  const minis = el('div', { class: 'hc-minis-slot' }, minisList(view, ctx));
  const node = el('div', { class: 'hc hc-lobby hc-playing' }, header(view, ctx), panel.node,
    el('section', { class: 'card' }, el('h2', {}, '👥 Canlı'), minis));
  const dispose = keyboardAware(node, () => panel.input);
  return { node, panel, minis, dispose };
}

// Sunucu yanıtı gelmezse (ağ, eski harf) düğmeler kilitli kalmasın.
function armUnlock() {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => cur?.panel?.unlock(), 2500);
}

function waitScreen(view, ctx) {
  const run = view.me.run;
  const minis = el('div', { class: 'hc-minis-slot' }, minisList(view, ctx));
  const node = el('div', { class: 'hc hc-lobby' }, header(view, ctx),
    el('section', { class: 'card center' },
      run ? el('h2', {}, '🏁 Çarkı bitirdin!') : el('h2', {}, '👀 İzliyorsun'),
      run ? el('p', { class: 'hc-summary' }, summaryLine(run.summary)) : el('p', { class: 'hint' }, 'Oyun bitince sonuçları göreceksin.'),
      run ? el('pre', { class: 'hc-grid' }, emojiGrid(run.letters.map((l) => l.state))) : null,
      el('p', { class: 'hint' }, 'Diğerleri bitirince (ya da süre dolunca) cevaplar açılır.'),
      clockLine(view, ctx)),
    el('section', { class: 'card' }, el('h2', {}, '👥 Canlı'), minis));
  return { node, minis };
}

function overScreen(view, ctx) {
  const medals = ['🥇', '🥈', '🥉'];
  const res = view.reveal.results;
  const myRun = view.me.run;
  const ranked = view.ranking.filter((r) => !r.left);
  let selected = ctx.playerId in res ? ctx.playerId : ranked[0]?.id;
  const recapSlot = el('div');
  const tabs = el('div', { class: 'hc-who' });
  const drawRecap = () => {
    const r = res[selected];
    tabs.replaceChildren(...ranked.map((p) => el('button', {
      type: 'button', class: `pl-test${p.id === selected ? ' active' : ''}`, 'aria-pressed': p.id === selected ? 'true' : 'false',
      onclick: () => { selected = p.id; drawRecap(); },
    }, p.name)));
    recapSlot.replaceChildren(r ? recapList(view.reveal.recap.map((c, i) => ({ ...c, typed: r.typed[i], state: r.states[i] }))) : el('p', { class: 'hint' }, '—'));
  };
  drawRecap();
  const title = `Harf Çarkı · ${DIFF_NAME[view.settings.difficulty]}`;
  return { node: el('div', { class: 'hc hc-lobby' }, header(view, ctx),
    el('section', { class: 'card hc-final' },
      el('h2', {}, '🏆 Sonuç'),
      el('ol', { class: 'hc-rank' }, ranked.map((p, i) => el('li', { class: p.id === ctx.playerId ? 'me' : '' },
        el('span', { class: 'hc-medal' }, medals[i] ?? `${i + 1}.`),
        miniWheel(res[p.id]?.states ?? []),
        el('span', { class: 'player-name' }, p.name),
        el('span', { class: 'hc-rank-score' }, `${p.correct}✓ ${p.wrong}✗`,
          el('small', {}, p.durationMs != null ? ` ${fmtTime(p.durationMs)}` : ''))))),
      myRun ? el('div', { class: 'row center' },
        el('button', { class: 'btn ghost', onclick: () => share(shareText(title, myRun.summary, myRun.letters.map((l) => l.state))) }, '📤 Paylaş')) : null),
    el('section', { class: 'card' }, el('h2', {}, '🔎 Harf harf'), tabs, recapSlot)) };
}

function renderGame(view, ctx) {
  const key = keyOf(view, ctx);
  if (cur?.key === key && cur.node) {
    patch(view, ctx);
    return cur.node;
  }
  teardown();
  const mode = key.split(':')[1];
  const built = mode === 'play' ? playScreen(view, ctx) : mode === 'over' ? overScreen(view, ctx) : waitScreen(view, ctx);
  cur = { key, ...built, seq: 0 };
  patch(view, ctx);
  if (mode === 'play') requestAnimationFrame(() => cur?.panel?.focus());
  return cur.node;
}

function patch(view, ctx) {
  if (!cur) return;
  if (cur.minis) cur.minis.replaceChildren(minisList(view, ctx));
  if (cur.panel && view.me.run) {
    const last = view.me.run.last;
    const fresh = last && last.seq > cur.seq ? last : null;
    if (last) cur.seq = Math.max(cur.seq, last.seq);
    if (fresh) clearTimeout(pendingTimer);
    // Sadece başkası hamle yaptıysa (benim durumum aynı) panele dokunma — kilitli düğme açılmasın diye değil, animasyon tekrar etmesin diye.
    cur.panel.update(view.me.run, fresh);
  }
}

function patchGame(view, ctx) {
  if (!cur || keyOf(view, ctx) !== cur.key || !cur.node?.isConnected) return false;
  patch(view, ctx);
  return true;
}

// ---------- Kabuk (harfcarki.js enter('multi') çağırır) ----------

export function enterLobby(node) {
  leaveLobby();
  root = node;
  lobby = mountLobby(root, {
    id: 'harfcarki',
    name: 'Harf Çarkı',
    icon: '🔤',
    howTo: lobbyHowTo,
    renderSettings: settingsUI,
    renderGame,
    patchGame,
  });
}

export function leaveLobby() {
  teardown();
  lobby?.unmount();
  lobby = null;
  root?.replaceChildren();
  root = null;
}
