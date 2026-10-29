// 👁️ Algıla — çok oyunculu (lobi) istemcisi. Sunucu: server/games/perceptle.js; kurallar PLAN.md §4.7 "Çok oyunculu".
// Test ekranları tek oyunculudakilerin aynısı (perceptle-tests.js); uyaran herkese aynı sunucu anında (startAt) başlar.
// Girdi düğümü görünümler arasında korunur: başka oyuncu cevap verince sürükleme/yazı sıfırlanmaz.
import { net } from '../net.js';
import { mountLobby } from '../lobby.js';
import { el, toast } from '../ui.js';
import { TESTS, gradeOf } from '../perceptle-math.js';
import { TEST_UI, revealView } from './perceptle-tests.js';
import { secondsTimer, timeBar } from './recall-client.js';
import { audioReady, unlockAudio } from './tone-audio.js';
import { HOW_TO, META, detailText, scoreClass } from './perceptle.js';

const TIMED = new Set(['count', 'track', 'tempo']);
const fmt = (v, d = 0) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('tr-TR', { maximumFractionDigits: d });

// Fonksiyon: perceptle.js ile karşılıklı içe aktarma var, HOW_TO modül yüklenirken henüz hazır değil.
const lobbyHowTo = () => [
  'Herkes aynı testleri aynı anda oynar; uyaran (noktalar, top, ritim…) herkese aynı anda başlar.',
  ...HOW_TO.slice(1, 6),
  'Her testten sonra gerçek değer, herkesin cevabı ve puanı görünür. Sonuç: testlerin ortalaması + harf notu.',
  'Oda sahibi 🃏 Cuma kurallarını ve hangi testlerin oynanacağını seçer.',
];

let root = null;
let lobby = null;
let onGesture = null;
let offStatus = null;

// Oynanan testin canlı ekranı: { key, index, ui, stage, timers, sent, resent, lastAnswer, stim }
let cur = null;
// Aynı görünüm anahtarında aynı öğe döner (lobby.js aynı-öğe önbelleği): { key, node }
let cached = { key: '', node: null };
let statusSlot = null;

const phaseKey = (v) => `${v.gameKey}:${v.index}:${v.phase}`;
// Host bilgisi de anahtarda: host ayrılınca yeni host "Hemen başla"/"Sonraki test" düğmelerini görsün.
// (Girdi düğümü phaseKey'e bağlı; host değişse de oynanan test ekranı korunur.)
const fullKey = (v, ctx) => `${phaseKey(v)}:${v.me.playing ? 1 : 0}:${v.me.answered ? 1 : 0}:${ctx.isHost ? 1 : 0}`;
const RESEND_CHECK_MS = 1500;

function stopPlay() {
  if (!cur) return;
  cur.timers.forEach(clearTimeout);
  cur.ui?.stop();
  cur = null;
}

// ---------- Ortak parçalar ----------

function head(view, text) {
  return el('div', { class: 'game-head' },
    el('div', { class: 'round' }, text),
    view.friday ? el('span', { class: 'pc-friday' }, '🃏 Cuma kuralları') : null);
}

const testTitle = (view) => `Test ${view.index + 1} / ${view.tests.length} · ${META[view.test].icon} ${META[view.test].name}`;

function progress(view, ctx) {
  return el('div', { class: 'rc-dots pc-dots' }, view.tests.map((t, i) => {
    const h = view.history.find((x) => x.index === i);
    const r = h?.results[ctx.playerId];
    const now = !view.over && i === view.index && view.phase !== 'reveal';
    return el('span', { class: `rc-dot${r ? ` done ${scoreClass(r.score)}` : ''}${now ? ' now' : ''}`, title: META[t].name },
      `${META[t].icon} ${r ? r.score : ''}`.trim());
  }));
}

function statusList(view, ctx) {
  return el('ul', { class: 'rc-status' }, view.players.map((p) =>
    el('li', { class: `${p.answered ? 'in' : ''}${ctx.connected(p.id) ? '' : ' offline'}` },
      el('span', { class: 'player-name' }, p.name),
      p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
      view.phase === 'play' ? el('span', { class: 'rc-check' }, p.answered ? '✓ cevapladı' : '…düşünüyor') : null)));
}

function statusCard(view, ctx) {
  statusSlot = el('div', {}, statusList(view, ctx));
  return el('section', { class: 'card' }, el('h2', {}, '👥 Durum'), statusSlot);
}

// Eşit puan eşit sıra: 1, 1, 3…
function ranked(rows, valueOf) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  const ranks = sorted.map((p, i) => (i && valueOf(p) === valueOf(sorted[i - 1]) ? null : i + 1));
  for (let i = 1; i < ranks.length; i++) ranks[i] ??= ranks[i - 1];
  return sorted.map((p, i) => ({ p, rank: ranks[i] }));
}

function answerText(test, r) {
  if (!r || r.timedOut || r.answer == null) return 'cevap yok';
  switch (test) {
    case 'count': return `${r.answer} nokta`;
    case 'track': return `${fmt(r.answer)}`;
    case 'angle': return `${fmt(r.answer, 1)}°`;
    case 'tempo': return `${r.detail?.hits ?? 0}/8 vuruş · ${fmt(r.error)} ms`;
    default: return fmt(r.answer, 2);
  }
}

function truthText(h) {
  switch (h.test) {
    case 'count': return `Gerçek: ${h.truth} nokta`;
    case 'track': return `İniş noktası: ${fmt(h.truth)}`;
    case 'angle': return `Hedef: ${h.truth}°`;
    case 'tempo': return `Tempo: ${h.truth} BPM`;
    default: return `Hedef: ${h.label} (${fmt(h.truth, 2)})`;
  }
}

// Ritim testi için ses: davet linkinden gelen (hiç dokunmamış) oyuncuda tarayıcı sesi kapalı tutar.
function soundButton() {
  unlockAudio();
  if (audioReady()) return null;
  const btn = el('button', {
    type: 'button',
    class: 'btn big pc-lock pl-sound',
    onclick: () => { unlockAudio(); setTimeout(() => { if (audioReady()) { btn.replaceWith(el('p', { class: 'hint center' }, '🔈 Ses açık.')); } }, 60); },
  }, '🔊 Sesi aç');
  setTimeout(() => { if (audioReady() && btn.isConnected) btn.remove(); }, 120);
  return btn;
}

// ---------- Ayarlar ----------

function settingsUI(settings, { editable, change }) {
  const chosen = settings.tests.split(',');
  const rule = (id, label, hint) => el('button', {
    type: 'button',
    class: `rc-diff${settings.rules === id ? ' active' : ''}`,
    disabled: !editable,
    'aria-pressed': settings.rules === id ? 'true' : 'false',
    onclick: () => change({ rules: id }),
  }, el('b', {}, label), el('small', {}, hint));
  const toggle = (t) => {
    const on = chosen.includes(t);
    return el('button', {
      type: 'button',
      class: `pl-test${on ? ' active' : ''}`,
      disabled: !editable,
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => {
        const next = on ? chosen.filter((x) => x !== t) : [...chosen, t];
        if (!next.length) { toast('En az bir test seçili olmalı.'); return; }
        change({ tests: TESTS.filter((x) => next.includes(x)).join(',') });
      },
    }, `${META[t].icon} ${META[t].name}`);
  };
  return el('div', { class: 'settings' },
    el('div', { class: 'hint' }, 'Kurallar'),
    el('div', { class: 'rc-diffs' },
      rule('normal', 'Normal', 'Klasik kurallar'),
      rule('friday', '🃏 Cuma kuralları', 'Hareketli, sekmeli, daha zor')),
    el('div', { class: 'hint' }, chosen.length === TESTS.length ? 'Testler: Hepsi (5 test)' : `Testler: ${chosen.length} / ${TESTS.length}`),
    el('div', { class: 'pl-tests' }, TESTS.map(toggle)));
}

// ---------- Fazlar ----------

function introScreen(view, ctx, endsLocal) {
  const m = META[view.test];
  return el('div', { class: 'stack recall pc' },
    head(view, `Test ${view.index + 1} / ${view.tests.length}`),
    el('section', { class: 'card center pc-intro' },
      el('div', { class: 'pc-intro-icon' }, m.icon),
      el('h2', {}, m.name),
      el('p', {}, m[view.friday ? 'friday' : 'normal']),
      el('div', { class: 'pl-count' }, secondsTimer(endsLocal, { urgentAt: 0, suffix: '' })),
      view.test === 'tempo' && view.me.playing ? soundButton() : null,
      ctx.isHost && view.me.playing
        ? el('button', { class: 'btn big primary rc-go', onclick: () => ctx.act({ type: 'go', index: view.index }) }, 'Hemen başla →')
        : null),
    progress(view, ctx),
    statusCard(view, ctx));
}

function clock(view, endsLocal) {
  const total = view.recallAt && view.endsAt ? view.endsAt - view.recallAt : Math.max(1, endsLocal - Date.now());
  return el('div', { class: 'rc-clock' }, '⏱️ ', secondsTimer(endsLocal), timeBar(endsLocal, total));
}

// Testi yerel saatte startAt anında başlat (sunucu saat farkı ctx.serverOffset).
function ensurePlay(view, ctx) {
  const key = phaseKey(view);
  if (cur?.key === key) return cur;
  stopPlay();
  const test = view.test;
  const ts = view.timeScale ?? 1;
  const startLocal = view.startAt - ctx.serverOffset;
  const recallLocal = view.recallAt - ctx.serverOffset;
  const endsLocal = view.endsAt - ctx.serverOffset;
  const stage = el('div', { class: 'pl-stage' });
  const c = { key, index: view.index, ui: null, stage, timers: [], sent: false, resent: false, lastAnswer: undefined, stim: view.stimulus };
  cur = c;
  const later = (fn, ms) => c.timers.push(setTimeout(fn, Math.max(0, ms)));
  const submit = (answer) => {
    if (c.sent || cur !== c) return;
    c.sent = true;
    c.lastAnswer = answer;
    net.action({ type: 'answer', index: view.index, answer });
    c.check = () => verifySent(c);
    later(c.check, RESEND_CHECK_MS);
  };
  c.submit = submit;
  // Kilit açıldıktan sonra (cevap kayboldu/reddedildi) Kilitle tekrar gönderebilsin: testin kendi düğmesi
  // bir kez gönderdikten sonra susar (ör. açı), o yüzden tıklamayı burada da yakala.
  stage.addEventListener('click', (e) => {
    if (!e.target.closest?.('.pc-lock') || c.sent) return;
    const v = c.ui?.value?.();
    setTimeout(() => submit(v != null ? v : c.lastAnswer), 0);
  });
  const make = () => {
    if (cur !== c) return;
    const now = Date.now();
    if (test === 'tempo' && (!c.stim || now > startLocal + 250)) {
      // Ritim başladıktan sonra gelen (yeniden bağlanan) oyuncu: vuruşlar tekrar çalınamaz, boş gönderilir.
      stage.replaceChildren(el('section', { class: 'card center' }, el('p', {}, '🥁 Ritim testi senin için kaçtı; bu test 0 sayılacak.')));
      later(() => submit([]), recallLocal - Date.now() + 200);
      return;
    }
    const late = TIMED.has(test) && now >= recallLocal - 30;
    c.ui = TEST_UI[test]({
      stim: late ? null : c.stim,
      friday: view.friday,
      showMs: Math.max(0, recallLocal - now),
      leadMs: test === 'tempo' ? Math.max(0, startLocal + view.leadMs * ts - now) : 0,
      timeScale: ts,
      submit,
    });
    stage.replaceChildren(c.ui.node);
    if (test === 'tempo') mutedHint(c.ui.node);
  };
  const wait = startLocal - Date.now();
  if (wait > 0) {
    stage.append(el('section', { class: 'card center pl-ready' },
      el('div', { class: 'pc-intro-icon' }, META[test].icon),
      el('h2', {}, 'Hazır ol…'),
      test === 'tempo' ? soundButton() : null));
    later(make, wait);
  } else make();
  // Süre dolunca son hâlin otomatik gider (sunucu 2 sn daha bekler). Ritim kendi bitince gönderir.
  if (test !== 'tempo') later(() => { const v = c.ui?.value?.(); if (v != null) submit(v); }, endsLocal - Date.now() - 150);
  return c;
}

// Gönderilen cevap sunucuya ulaşmadı ya da reddedildi mi? (görünüm hâlâ "cevaplamadın" diyor)
// Bir kez kendiliğinden yeniden gönderilir; o da tutmazsa Kilitle tekrar açılır.
function verifySent(c) {
  const v = net.view;
  if (cur !== c || !c.sent || !v || phaseKey(v) !== c.key || v.me.answered) return;
  if (!c.resent && c.lastAnswer !== undefined) {
    c.resent = true;
    net.action({ type: 'answer', index: c.index, answer: c.lastAnswer });
    c.timers.push(setTimeout(() => verifySent(c), RESEND_CHECK_MS));
    return;
  }
  c.sent = false;
  for (const b of c.stage.querySelectorAll('.pc-lock')) b.disabled = false;
}

// Yeniden bağlanınca (welcome) gönderilmiş ama onaylanmamış cevabı tekrar dene.
function onStatus(s) {
  if (!s?.connected || !cur?.sent) return;
  const c = cur;
  c.resent = false;
  c.timers.push(setTimeout(() => verifySent(c), 600));
}

// Ritim başladığında ses hâlâ kilitliyse pedin üstünde ipucu: dokununca ses açılır.
function mutedHint(node) {
  unlockAudio();
  setTimeout(() => {
    if (audioReady() || !node.isConnected) return;
    const pad = node.querySelector('.pc-pad');
    const hint = el('button', {
      type: 'button',
      class: 'pl-muted',
      onclick: () => { unlockAudio(); setTimeout(() => { if (audioReady()) hint.remove(); }, 60); },
    }, '🔇 Ses kapalı — dokun');
    (pad ?? node).before(hint);
  }, 120);
}

function playScreen(view, ctx, endsLocal) {
  const top = [head(view, testTitle(view)), clock(view, endsLocal)];
  if (!view.me.playing) {
    stopPlay();
    return el('div', { class: 'stack recall pc' }, ...top,
      el('section', { class: 'card center' }, el('p', {}, '👀 İzliyorsun — oyuncular cevaplıyor.')),
      statusCard(view, ctx));
  }
  if (view.me.answered) {
    stopPlay();
    return el('div', { class: 'stack recall pc' }, ...top,
      el('section', { class: 'card center' }, el('p', {}, '✓ Cevabın gönderildi. Diğerleri bekleniyor…')),
      progress(view, ctx),
      statusCard(view, ctx));
  }
  const c = ensurePlay(view, ctx);
  return el('div', { class: 'stack recall pc' }, ...top, c.stage, progress(view, ctx), statusCard(view, ctx));
}

function revealScreen(view, ctx, endsLocal) {
  const h = view.last;
  const m = META[h.test];
  const mine = h.results[ctx.playerId];
  const rows = ranked(view.players, (p) => h.results[p.id]?.score ?? 0);
  const drawn = mine && !mine.timedOut ? revealView(h.test, h.stimulus, mine.answer, view.friday) : null;
  const isLast = view.index + 1 >= view.tests.length;
  return el('div', { class: 'stack recall pc' },
    head(view, `Test ${view.index + 1} / ${view.tests.length} sonucu`),
    el('section', { class: 'card center pc-result' },
      el('div', { class: 'pc-result-icon' }, `${m.icon} ${m.name}`),
      mine ? el('div', { class: `pc-big-score ${scoreClass(mine.score)}` }, String(mine.score), el('small', {}, ' / 100')) : null,
      el('p', { class: 'pc-detail' }, mine ? detailText({ ...mine, test: h.test, truth: h.truth, label: h.label }) : truthText(h)),
      drawn ? el('div', { class: 'pc-reveal' }, drawn, el('p', { class: 'pc-legend' }, el('i', { class: 'good' }), ' doğru  ', el('i', { class: 'you' }), ' sen')) : null),
    el('section', { class: 'card' },
      el('h2', {}, '📊 Bu test'),
      el('p', { class: 'hint pl-truth' }, truthText(h)),
      el('ol', { class: 'rc-rank pl-rank' }, rows.map(({ p, rank }) => {
        const r = h.results[p.id];
        return el('li', { class: `wr${p.id === ctx.playerId ? ' me' : ''}` },
          el('span', { class: 'w-rank' }, `${rank}.`),
          el('span', { class: 'player-name' }, p.name),
          el('b', { class: `rc-pts pc-row-score ${scoreClass(r?.score ?? 0)}` }, String(r?.score ?? 0)),
          el('span', { class: 'rc-sum' }, `Σ ${p.total}`),
          el('span', { class: 'rc-ans' }, answerText(h.test, r)));
      }))),
    ctx.isHost && view.me.playing
      ? el('button', { class: 'btn big primary rc-go', onclick: () => ctx.act({ type: 'next', index: view.index }) },
        isLast ? 'Sonuçları göster' : 'Sonraki test →')
      : null,
    el('p', { class: 'hint center' }, ctx.isHost && view.me.playing ? 'Basmazsan ' : 'Oda sahibi geçirmezse ',
      secondsTimer(endsLocal, { urgentAt: 0 }), ' sonra kendiliğinden devam eder.'),
    progress(view, ctx));
}

function overScreen(view, ctx) {
  const rows = ranked(view.players, (p) => p.total);
  const medals = ['🥇', '🥈', '🥉'];
  const best = rows[0]?.p.total;
  const winners = rows.filter((r) => r.p.total === best).map((r) => r.p);
  const done = view.history.map((h) => h.test);
  return el('div', { class: 'stack recall pc' },
    head(view, 'Oyun bitti'),
    el('section', { class: 'card' },
      el('h2', {}, '🏆 Final sıralaması'),
      rows.length
        ? el('ol', { class: 'rc-rank pl-final' }, rows.map(({ p, rank }) => {
          const grade = p.grade ?? gradeOf(p.total);
          return el('li', { class: p.id === ctx.playerId ? 'me' : '' },
            el('span', { class: 'w-rank' }, medals[rank - 1] ?? `${rank}.`),
            el('span', { class: 'player-name' }, p.name),
            el('span', { class: `pl-grade g-${grade}` }, grade),
            el('span', { class: 'rc-sum' }, `${p.total}`));
        }))
        : el('p', { class: 'hint' }, 'Herkes oyundan ayrıldı.')),
    winners.length === 1 && rows.length > 1 ? el('p', { class: 'center rc-winner' }, `👑 ${winners[0].name} kazandı!`)
      : winners.length > 1 ? el('p', { class: 'center rc-winner' }, `🤝 Berabere: ${winners.map((p) => p.name).join(', ')}`) : null,
    rows.length && done.length ? el('section', { class: 'card' },
      el('h2', {}, '🧾 Test puanları'),
      el('table', { class: 'pl-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Oyuncu'), done.map((t) => el('th', { title: META[t].name }, META[t].icon)), el('th', {}, 'Ort.'))),
        el('tbody', {}, rows.map(({ p }) => el('tr', { class: p.id === ctx.playerId ? 'me' : '' },
          el('td', { class: 'player-name' }, p.name),
          view.history.map((h) => {
            const s = h.results[p.id]?.score ?? 0;
            return el('td', { class: `pc-row-score ${scoreClass(s)}` }, String(s));
          }),
          el('td', {}, el('b', {}, String(p.total)))))))) : null);
}

function renderGame(view, ctx) {
  const key = fullKey(view, ctx);
  if (cached.key === key && cached.node) {
    // Aynı faz: sadece durum listesini yenile, girdi düğümü aynı kalsın.
    if (statusSlot) statusSlot.replaceChildren(statusList(view, ctx));
    return cached.node;
  }
  if (view.phase !== 'play') stopPlay();
  statusSlot = null;
  const endsLocal = view.endsAt ? view.endsAt - ctx.serverOffset : 0;
  let node;
  if (view.phase === 'intro') node = introScreen(view, ctx, endsLocal);
  else if (view.phase === 'play') node = playScreen(view, ctx, endsLocal);
  else if (view.phase === 'reveal' && view.last) node = revealScreen(view, ctx, endsLocal);
  else node = overScreen(view, ctx);
  cached = { key, node };
  return node;
}

// Yerinde güncelleme: test sürerken başkası cevap verince ekranı baştan çizme.
function patchGame(view, ctx) {
  if (fullKey(view, ctx) !== cached.key || !statusSlot?.isConnected) return false;
  statusSlot.replaceChildren(statusList(view, ctx));
  return true;
}

// ---------- Kabuk (perceptle.js enter('multi') çağırır) ----------

export function enterLobby(node) {
  leaveLobby();
  root = node;
  onGesture = () => unlockAudio();
  root.addEventListener('pointerdown', onGesture, true);
  root.addEventListener('keydown', onGesture, true);
  offStatus = net.on('status', onStatus);
  lobby = mountLobby(root, {
    id: 'perceptle',
    name: 'Algıla',
    icon: '👁️',
    howTo: lobbyHowTo(),
    renderSettings: settingsUI,
    renderGame,
    patchGame,
  });
}

export function leaveLobby() {
  offStatus?.();
  offStatus = null;
  stopPlay();
  cached = { key: '', node: null };
  statusSlot = null;
  lobby?.unmount();
  lobby = null;
  if (root) {
    root.removeEventListener('pointerdown', onGesture, true);
    root.removeEventListener('keydown', onGesture, true);
    root.replaceChildren();
  }
  root = null;
}
