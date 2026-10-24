// Hafıza oyunlarının (🎨 Nüans, 🔊 Ton Avı) ortak istemcisi: tek oyunculu (📅 Günlük / ♾️ Sınırsız, HTTP)
// ve çok oyunculu (lobi) akış burada; oyuna özel parçalar (hedef gösterimi, girdi, sonuç satırı) spec'ten gelir.
// Puanı her zaman sunucu hesaplar (server/recall.js). Bkz. PLAN.md §4.4, §4.5.
import { net } from '../net.js';
import { mountLobby } from '../lobby.js';
import { $, el, toast } from '../ui.js';

// Saniye sayacı (yerel saat). Ekrandan kalkınca kendini durdurur.
export function secondsTimer(endsAtLocal, { urgentAt = 5, suffix = ' sn' } = {}) {
  const node = el('span', { class: 'rc-timer' });
  let started = false;
  const tick = () => {
    if (started && !node.isConnected) return;
    started = true;
    const left = Math.max(0, endsAtLocal - Date.now());
    const s = Math.ceil(left / 1000);
    node.textContent = `${s}${suffix}`;
    node.classList.toggle('urgent', s <= urgentAt);
    if (left > 0) setTimeout(tick, 200);
  };
  tick();
  return node;
}

// Kalan sürenin çubuğu (CSS animasyonu ile azalır)
export function timeBar(endsAtLocal, totalMs) {
  const fill = el('div', { class: 'rc-bar-fill' });
  const left = Math.max(0, endsAtLocal - Date.now());
  fill.style.width = `${Math.min(100, (left / Math.max(1, totalMs)) * 100)}%`;
  fill.style.transitionDuration = `${left}ms`;
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = '0%'; }));
  return el('div', { class: 'rc-bar' }, fill);
}

async function share(text) {
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Sonuç kopyalandı.'); }
  } catch { /* iptal */ }
}

function nextPuzzleIn() {
  // İstanbul gece yarısına kalan süre (UTC+3, yaz saati yok)
  const now = Date.now();
  const ist = new Date(now + 3 * 3600_000);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 3 * 3600_000;
  const left = Math.max(0, midnight - now);
  return `${Math.floor(left / 3600_000)} sa ${Math.floor((left % 3600_000) / 60_000)} dk`;
}

/*
spec = {
  id, name, icon, rootId,
  difficulties: [{ id, label, hint }], dailyDifficulty,
  howTo: [metin],
  verbs: { show: 'Rengi göster', submit: 'Rengimi gönder', memorize: 'Ezberle!', recall: 'Hatırla!' },
  memorizeView(target, { endsAt, totalMs, difficulty, key }) → düğüm (tek seferlik ses vb. key ile)
  createInput({ difficulty }) → { node, value(), stop?() }  (her turda rastgele başlangıç)
  answerChip(guess, { difficulty }) → küçük gösterim (null = cevap yok)
  roundDetail({ round, target, guess, score, timedOut }, { difficulty }) → sonuç satırı
  formatScore(score) → '852' | '6.00'
  formatTotal(total) → '812/1000 · Uzman' gibi
  shareText({ mode, puzzleNo, total, played })
  unlock?(), stopSound?()
}
*/
export function createRecallGame(spec) {
  const MODE_KEY = `tss:${spec.id}-mode`;
  const DIFF_KEY = `tss:${spec.id}-difficulty`;
  const base = `/api/recall/${spec.id}`;

  let root = null;
  let lobby = null;
  let onGesture = null;

  // ---------- Tek oyunculu durum ----------
  let mode = 'daily';
  let difficulty = spec.difficulties[0].id;
  let game = null; // sunucunun publicGame'i
  let phase = 'loading'; // loading | setup | ready | memorize | recall | result | final | error
  let current = null; // { round, target, memorizeEnds, endsAt, memorizeMs, recallMs }
  let input = null;
  let lastResult = null;
  let board = null;
  let busy = false;
  let loadSeq = 0;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms));
    timers.add(t);
  };
  const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); };

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
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: net.identity.playerId, token: net.identity.token, ...body }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Sunucu hatası');
    return json;
  }

  function resetRun() {
    clearTimers();
    input?.stop?.();
    spec.stopSound?.();
    game = null; current = null; input = null; lastResult = null; board = null;
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
      // Sayfa yenilenmeden önce başlamış tur: hedef tekrar gösterilmez, kalan sürede cevap verilir.
      const endsAt = Date.now() + (g.pending.endsAt - g.serverNow);
      current = { round: g.pending.round, target: null, endsAt, recallMs: g.recallMs };
      // Ezber sırasında yenilendiyse sunucu erken cevabı reddeder: ezber süresi bitene kadar bekle.
      const wait = (g.pending.recallAt ?? 0) - g.serverNow;
      if (wait > 0) later(() => enterRecall(), wait + 100);
      else enterRecall();
      return;
    }
    phase = 'ready';
  }

  async function loadBoard() {
    if (mode !== 'daily') return;
    try { board = await api('/leaderboard'); } catch { board = null; }
    render();
  }

  async function startFree() {
    if (busy) return;
    spec.unlock?.();
    busy = true;
    try {
      game = await api('/start', { mode: 'free', difficulty });
    } catch (err) {
      toast(err.message);
      return;
    } finally {
      busy = false;
    }
    beginRound();
  }

  async function beginRound() {
    if (busy || !game) return;
    spec.unlock?.(); // dokunuş anında: ses ancak etkileşimden sonra açılır
    busy = true;
    const round = game.played.length;
    try {
      const r = await api('/round', { mode, gameId: game.gameId, round });
      const now = Date.now();
      current = { round, target: r.target, memorizeMs: r.memorizeMs, recallMs: r.recallMs, memorizeEnds: now + r.memorizeMs, endsAt: now + r.memorizeMs + r.recallMs };
      phase = 'memorize';
      render();
      later(() => enterRecall(), r.memorizeMs);
    } catch (err) {
      toast(err.message);
      if (mode === 'daily') load('daily');
    } finally {
      busy = false;
    }
  }

  function enterRecall() {
    spec.stopSound?.();
    phase = 'recall';
    input = spec.createInput({ difficulty: game.difficulty });
    render();
    later(() => submit(true), current.endsAt - Date.now());
  }

  async function submit(auto = false) {
    if (phase !== 'recall' || busy || !input) return;
    busy = true;
    clearTimers();
    input.stop?.();
    try {
      const g = await api('/submit', { mode, gameId: game.gameId, round: current.round, guess: input.value() });
      game = g;
      lastResult = g.played.find((p) => p.round === current.round) ?? null;
      if (auto) toast('Süre doldu, son hâlin gönderildi.');
      phase = g.done ? 'final' : 'result';
      if (g.done) loadBoard();
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
    }
    render();
  }

  // ---------- Tek oyunculu çizim ----------

  function progressDots() {
    const played = game?.played ?? [];
    return el('div', { class: 'rc-dots' }, Array.from({ length: game?.rounds ?? 5 }, (_, i) => {
      const p = played.find((x) => x.round === i);
      const cls = p ? 'done' : current?.round === i && ['memorize', 'recall'].includes(phase) ? 'now' : '';
      return el('span', { class: `rc-dot ${cls}` }, p ? spec.formatScore(p.score) : String(i + 1));
    }));
  }

  function diffPicker(value, onPick, { disabled = false } = {}) {
    return el('div', { class: 'rc-diffs' }, spec.difficulties.map((d) =>
      el('button', {
        type: 'button',
        class: `rc-diff${d.id === value ? ' active' : ''}`,
        disabled,
        'aria-pressed': d.id === value ? 'true' : 'false',
        onclick: () => onPick(d.id),
      }, el('b', {}, d.label), el('small', {}, d.hint))));
  }

  function roundHead(label) {
    return el('div', { class: 'game-head' },
      el('div', { class: 'round' }, `Tur ${current.round + 1} / ${game.rounds}`),
      el('div', { class: 'rc-phase' }, label));
  }

  function finalCard() {
    const total = game.total;
    return el('section', { class: 'card center rc-final' },
      el('div', { class: 'hint' }, mode === 'daily' ? `📅 Günlük #${game.puzzleNo}` : '♾️ Sınırsız'),
      el('div', { class: 'rc-total' }, spec.formatTotal(total)),
      el('div', { class: 'rc-rounds' }, game.played.map((p) => spec.roundDetail(p, { difficulty: game.difficulty }))),
      el('div', { class: 'row center' },
        el('button', { class: 'btn ghost', onclick: () => share(spec.shareText({ mode, puzzleNo: game.puzzleNo, total, played: game.played })) }, '📤 Paylaş'),
        mode === 'free' ? el('button', { class: 'btn primary', onclick: () => load('free') }, 'Yeni oyun →') : null),
      mode === 'daily' ? el('p', { class: 'hint' }, `Yeni günlük hedeflere ${nextPuzzleIn()} var.`) : null);
  }

  function leaderboardPanel() {
    if (mode !== 'daily' || !board) return null;
    return el('section', { class: 'card' },
      el('h2', {}, `🏆 Bugünün sıralaması (#${board.puzzleNo})`),
      board.entries.length
        ? el('ol', { class: 'w-board rc-board' }, board.entries.map((e, i) =>
          el('li', { class: e.me ? 'me' : '' },
            el('span', { class: 'w-rank' }, `${e.rank ?? i + 1}.`),
            el('span', { class: 'player-name' }, e.name),
            el('span', { class: 'w-tries' }, spec.formatTotal(e.total, { short: true })),
            e.rounds ? el('span', { class: 'rc-mini' }, e.rounds.map((r) => spec.answerChip(r.guess, { difficulty: spec.dailyDifficulty, target: r.target, mini: true }))) : null)))
        : el('p', { class: 'hint' }, 'Henüz kimse bitirmedi. İlk sen ol!'),
      board.viewerDone ? null : el('p', { class: 'hint' }, 'Başkalarının cevaplarını görmek için önce kendi oyununu bitir.'),
      board.playing ? el('p', { class: 'hint' }, `${board.playing} kişi şu an oynuyor.`) : null);
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
        },
      }, field, el('button', { class: 'btn primary', type: 'submit' }, 'Kaydet')));
  }

  function howToBox() {
    return el('details', { class: 'card howto-box' },
      el('summary', {}, '📖 Nasıl oynanır?'),
      el('ul', { class: 'howto' }, spec.howTo.map((line) => el('li', {}, line))));
  }

  function singleBody() {
    const diffInfo = (id) => spec.difficulties.find((d) => d.id === id);
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
          el('p', { class: 'hint' }, 'Zorluğu seç; istediğin kadar oyna (sıralamaya girmez).'),
          diffPicker(difficulty, (id) => {
            difficulty = id;
            try { localStorage.setItem(DIFF_KEY, id); } catch { /* yok say */ }
            render();
          }),
          el('button', { class: 'btn big primary rc-go', disabled: busy, onclick: startFree }, `${spec.verbs.start} →`))];
      case 'ready': {
        const n = game.played.length;
        return [el('section', { class: 'card center' },
          el('div', { class: 'hint' }, mode === 'daily' ? `📅 Günlük #${game.puzzleNo} · ${diffInfo(game.difficulty)?.label}` : `♾️ ${diffInfo(game.difficulty)?.label}`),
          el('h2', {}, n ? `Kaldığın yerden: Tur ${n + 1} / ${game.rounds}` : `${game.rounds} tur, tek deneme`),
          el('p', { class: 'hint' }, spec.readyHint(game)),
          progressDots(),
          el('button', { class: 'btn big primary rc-go', onclick: beginRound }, n ? `Tur ${n + 1} → ${spec.verbs.show}` : `${spec.verbs.start} →`))];
      }
      case 'memorize':
        return [roundHead(spec.verbs.memorize),
          spec.memorizeView(current.target, { endsAt: current.memorizeEnds, totalMs: current.memorizeMs, difficulty: game.difficulty, key: `${game.gameId}:${current.round}` }),
          progressDots()];
      case 'recall':
        return [roundHead(spec.verbs.recall),
          el('div', { class: 'rc-clock' }, '⏱️ ', secondsTimer(current.endsAt), timeBar(current.endsAt, current.recallMs)),
          input.node,
          el('button', { class: 'btn big primary rc-submit', onclick: () => submit(false) }, spec.verbs.submit),
          progressDots()];
      case 'result':
        return [el('div', { class: 'game-head' }, el('div', { class: 'round' }, `Tur ${lastResult.round + 1} / ${game.rounds} sonucu`)),
          el('section', { class: 'card center' },
            spec.roundDetail(lastResult, { difficulty: game.difficulty, big: true }),
            el('p', { class: 'hint' }, `Şu ana kadar: ${spec.formatTotal(game.total, { partial: true, played: game.played.length })}`),
            el('button', { class: 'btn big primary rc-go', onclick: beginRound }, `Sonraki tur → (${game.played.length + 1}/${game.rounds})`)),
          progressDots()];
      case 'final':
        return [finalCard(), leaderboardPanel()];
      default:
        return [];
    }
  }

  function renderSingle() {
    const inRun = ['memorize', 'recall'].includes(phase);
    root.replaceChildren(el('div', { class: `screen active recall rc-${spec.id}` },
      el('div', { class: 'tabs' },
        el('button', { class: `tab${mode === 'daily' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'daily' && load('daily') },
          `📅 Günlük${game?.puzzleNo && mode === 'daily' ? ` #${game.puzzleNo}` : ''}`),
        el('button', { class: `tab${mode === 'free' ? ' active' : ''}`, disabled: inRun, onclick: () => mode !== 'free' && load('free') }, '♾️ Sınırsız')),
      mode === 'daily' && !inRun ? nameCard() : null,
      ...singleBody(),
      inRun ? null : howToBox()));
  }

  // ---------- Çok oyunculu (lobi) ----------

  let mRenderedKey = '';
  let mSubmitted = null;
  let mStatusSlot = null;
  let mInput = null; // { key, input }
  let mSentKey = '';
  let mAutoKey = '';
  let mAutoTimer = null;

  const viewKey = (v) => `${v.gameKey}:${v.round}:${v.phase}`;

  function settingsUI(settings, { editable, change }) {
    const select = (key, options, label) => el('label', {},
      label,
      el('select', { disabled: !editable, onchange: (e) => change({ [key]: key === 'difficulty' ? e.target.value : Number(e.target.value) }) },
        options.map(([v, text]) => el('option', { value: String(v), selected: settings[key] === v }, text))));
    return el('div', { class: 'settings' },
      select('rounds', [3, 4, 5, 6, 7, 8, 10].map((n) => [n, `${n} tur`]), 'Tur sayısı'),
      select('difficulty', spec.difficulties.map((d) => [d.id, `${d.label} (${d.hint})`]), 'Zorluk'),
      select('recallSeconds', [15, 20, 30, 45, 60].map((n) => [n, `${n} saniye`]), 'Hatırlama süresi'));
  }

  function sendSubmit(view, ctx) {
    const key = `${view.gameKey}:${view.round}`;
    if (mSentKey === key || !mInput || mInput.key !== key) return;
    mSentKey = key;
    mInput.input.stop?.();
    ctx.act({ type: 'submit', round: view.round, guess: mInput.input.value() });
  }

  function statusList(view, ctx) {
    return el('ul', { class: 'rc-status' }, view.players.map((p) =>
      el('li', { class: `${p.submitted ? 'in' : ''}${ctx.connected(p.id) ? '' : ' offline'}` },
        el('span', { class: 'player-name' }, p.name),
        p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
        view.phase === 'recall' ? el('span', { class: 'rc-check' }, p.submitted ? '✓ gönderdi' : '…düşünüyor') : null)));
  }

  function rankList(view, ctx, { withRound }) {
    const last = view.lastRound;
    const rows = [...view.players].sort((a, b) => (withRound && last
      ? (last.answers[b.id]?.score ?? 0) - (last.answers[a.id]?.score ?? 0) : b.total - a.total));
    const medals = ['🥇', '🥈', '🥉'];
    return el('ol', { class: 'rc-rank' }, rows.map((p, i) => {
      const a = last?.answers[p.id];
      return el('li', { class: `${p.id === ctx.playerId ? 'me' : ''}${withRound ? ' wr' : ''}` },
        el('span', { class: 'w-rank' }, withRound ? `${i + 1}.` : medals[i] ?? `${i + 1}.`),
        el('span', { class: 'player-name' }, p.name),
        withRound ? el('b', { class: 'rc-pts' }, `+${a ? spec.formatScore(a.score) : '0'}`) : null,
        el('span', { class: 'rc-sum' }, withRound ? 'Σ ' : null, spec.formatTotal(p.total, { short: true, played: view.history.length })),
        withRound ? el('span', { class: 'rc-ans' }, spec.answerChip(a?.guess ?? null, { difficulty: view.difficulty, target: last.target })) : null);
    }));
  }

  function renderGame(view, ctx) {
    mRenderedKey = viewKey(view);
    mSubmitted = view.me.submitted;
    mStatusSlot = null;
    const endsLocal = view.endsAt ? view.endsAt - ctx.serverOffset : 0;
    if (view.phase !== 'recall') { clearTimeout(mAutoTimer); mAutoKey = ''; }
    if (view.phase !== 'memorize') spec.stopSound?.(); // ezber sesi (varsa) hatırlamaya taşmasın
    const head = el('div', { class: 'game-head' },
      el('div', { class: 'round' }, view.over ? 'Oyun bitti' : `Tur ${view.round} / ${view.totalRounds}`),
      view.phase === 'memorize' ? el('div', { class: 'rc-phase' }, spec.verbs.memorize) : null,
      view.phase === 'recall' ? el('div', { class: 'rc-phase' }, spec.verbs.recall) : null);

    if (view.phase === 'memorize') {
      mStatusSlot = el('div', {});
      return el('div', { class: `stack recall rc-${spec.id}` }, head,
        spec.memorizeView(view.target, { endsAt: endsLocal, totalMs: view.memorizeMs, difficulty: view.difficulty, key: `${view.gameKey}:${view.round}` }),
        mStatusSlot);
    }

    if (view.phase === 'recall') {
      const key = `${view.gameKey}:${view.round}`;
      mStatusSlot = el('div', {}, statusList(view, ctx));
      const clock = el('div', { class: 'rc-clock' }, '⏱️ ', secondsTimer(endsLocal), timeBar(endsLocal, Math.max(1, endsLocal - Date.now())));
      if (view.me.submitted || !ctx.me || ctx.me.spectator) {
        return el('div', { class: `stack recall rc-${spec.id}` }, head, clock,
          view.me.submitted ? el('section', { class: 'card center' },
            el('p', {}, '✓ Cevabın gönderildi. Diğerleri bekleniyor…'),
            spec.answerChip(view.me.guess, { difficulty: view.difficulty, big: true })) : el('p', { class: 'hint center' }, '👀 İzliyorsun.'),
          el('section', { class: 'card' }, el('h2', {}, '👥 Durum'), mStatusSlot));
      }
      if (!mInput || mInput.key !== key) mInput = { key, input: spec.createInput({ difficulty: view.difficulty }) };
      // Kendi süren dolunca son hâlin otomatik gider (sunucu 2 sn daha bekler).
      if (mAutoKey !== key) {
        mAutoKey = key;
        clearTimeout(mAutoTimer);
        mAutoTimer = setTimeout(() => { if (net.view && viewKey(net.view) === `${key}:recall`) sendSubmit(net.view, ctx); }, Math.max(0, endsLocal - Date.now() - 100));
      }
      return el('div', { class: `stack recall rc-${spec.id}` }, head, clock,
        mInput.input.node,
        el('button', { class: 'btn big primary rc-submit', onclick: () => sendSubmit(view, ctx) }, spec.verbs.submit),
        el('section', { class: 'card' }, el('h2', {}, '👥 Durum'), mStatusSlot));
    }

    if (view.phase === 'reveal') {
      const last = view.lastRound;
      const mine = last.answers[ctx.playerId];
      return el('div', { class: `stack recall rc-${spec.id}` }, head,
        el('section', { class: 'card center' },
          el('h2', {}, '🎯 Hedef buydu'),
          mine ? spec.roundDetail({ round: last.round - 1, target: last.target, guess: mine.guess, score: mine.score, timedOut: mine.guess == null }, { difficulty: view.difficulty, big: true })
            : spec.answerChip(last.target, { difficulty: view.difficulty, big: true, isTarget: true })),
        el('section', { class: 'card' }, el('h2', {}, '📊 Bu tur'), rankList(view, ctx, { withRound: true })),
        ctx.isHost
          ? el('button', { class: 'btn big primary', onclick: () => ctx.act({ type: 'next', round: view.round }) },
            view.round >= view.totalRounds ? 'Sonuçları göster' : 'Sonraki tur →')
          : null,
        el('p', { class: 'hint center' }, ctx.isHost ? 'Basmazsan ' : 'Oda sahibi geçirmezse ', secondsTimer(endsLocal, { urgentAt: 0, suffix: ' sn' }), ' sonra kendiliğinden devam eder.'));
    }

    // Oyun bitti
    const myRounds = view.history.map((h) => ({ round: h.round - 1, target: h.target, ...(h.answers[ctx.playerId] ?? { guess: null, score: 0 }) }));
    const ranked = [...view.players].sort((a, b) => b.total - a.total);
    return el('div', { class: `stack recall rc-${spec.id}` }, head,
      el('section', { class: 'card' }, el('h2', {}, '🏆 Final sıralaması'), rankList(view, ctx, { withRound: false })),
      ranked[0] ? el('p', { class: 'center rc-winner' }, `👑 ${ranked[0].name} kazandı!`) : null,
      myRounds.some((r) => r.guess !== undefined) && view.players.some((p) => p.id === ctx.playerId)
        ? el('section', { class: 'card' }, el('h2', {}, '🧾 Senin turların'),
          el('div', { class: 'rc-rounds' }, myRounds.map((r) => spec.roundDetail(r, { difficulty: view.difficulty }))))
        : null);
  }

  // Yerinde güncelleme: sürükleme sırasında başkası cevap verince ekranı baştan çizme.
  function patchGame(view, ctx) {
    if (viewKey(view) !== mRenderedKey || !mStatusSlot?.isConnected) return false;
    if (view.phase === 'memorize') return true;
    if (view.phase !== 'recall' || view.me.submitted !== mSubmitted) return false;
    mStatusSlot.replaceChildren(statusList(view, ctx));
    return true;
  }

  // ---------- Kabuk ----------

  function render() {
    if (root && !lobby) renderSingle();
  }

  return {
    enter(category) {
      // Aynı oyun başka kategoriden açılırsa shell leave() çağırmaz; önce eskisini temizle.
      root?.removeEventListener('pointerdown', onGesture, true);
      root?.removeEventListener('keydown', onGesture, true);
      root = $(spec.rootId);
      lobby?.unmount();
      lobby = null;
      loadSeq++;
      resetRun();
      onGesture = () => spec.unlock?.();
      root.addEventListener('pointerdown', onGesture, true);
      root.addEventListener('keydown', onGesture, true);
      if (category === 'multi') {
        lobby = mountLobby(root, {
          id: spec.id,
          name: spec.name,
          icon: spec.icon,
          howTo: spec.howTo,
          renderSettings: settingsUI,
          renderGame,
          patchGame,
        });
        return;
      }
      try { mode = localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'daily'; } catch { mode = 'daily'; }
      try {
        const d = localStorage.getItem(DIFF_KEY);
        if (spec.difficulties.some((x) => x.id === d)) difficulty = d;
      } catch { /* yok say */ }
      load(mode);
    },
    leave() {
      loadSeq++;
      resetRun();
      clearTimeout(mAutoTimer);
      mInput?.input.stop?.();
      mInput = null;
      lobby?.unmount();
      lobby = null;
      root?.removeEventListener('pointerdown', onGesture, true);
      root?.removeEventListener('keydown', onGesture, true);
      root?.replaceChildren();
      root = null;
    },
  };
}
