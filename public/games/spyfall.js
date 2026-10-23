// 🕵️ Casus Kim? — istemci ekranı. Oyun mantığı sunucuda (server/games/spyfall.js).
import { mountLobby } from '../lobby.js';
import { $, el, countdown } from '../ui.js';

let lobby = null;
let cardVisible = false; // rol kartı varsayılan gizli (yandaki görmesin)
let cardKey = '';
let crossed = new Set(); // casusun/köylünün elendi diye işaretlediği mekânlar (sadece bu cihazda)
let guessOpen = false;

const REASONS = {
  caught: 'Casus suçlandı ve yakalandı!',
  wrong_accuse: 'Masum biri suçlandı — casus kazandı!',
  guess: 'Casus mekânı doğru tahmin etti!',
  bad_guess: 'Casus mekânı yanlış tahmin etti!',
  final_caught: 'Süre bitti, oylamada casus yakalandı!',
  final_wrong: 'Süre bitti, oylamada masum biri seçildi — casus kazandı!',
  tie: 'Oylamada eşitlik çıktı — casus kazandı!',
  no_votes: 'Kimse oy vermedi — casus kazandı!',
  spy_left: 'Casus oyundan ayrıldı, tur iptal.',
  not_enough: 'Yeterli oyuncu kalmadı.',
};

function settingsUI(settings, { editable, change, playerCount }) {
  const select = (key, options, label) => el('label', {},
    label,
    el('select', { disabled: !editable, onchange: (e) => change({ [key]: Number(e.target.value) }) },
      options.map(([v, text]) => el('option', { value: String(v), selected: settings[key] === v }, text))));
  return el('div', { class: 'settings' },
    select('rounds', [1, 2, 3, 4, 5, 6, 8, 10].map((n) => [n, `${n} tur`]), 'Tur sayısı'),
    select('minutes', [3, 4, 5, 6, 7, 8, 10, 12, 15].map((n) => [n, `${n} dakika`]), 'Tur süresi'),
    select('spies', [[1, '1 casus'], [2, '2 casus (9+ kişi)']], 'Casus sayısı'),
    settings.spies === 2 && playerCount < 9 ? el('p', { class: 'hint' }, '9 kişiden az olursa 1 casusla oynanır.') : null);
}

function roleCard(view) {
  const key = `${view.gameKey}:${view.round}`;
  if (cardKey !== key) { cardKey = key; cardVisible = false; crossed = new Set(); guessOpen = false; }
  if (!view.me) return null;
  const toggle = () => { cardVisible = !cardVisible; lobby.rerender(); };
  if (!cardVisible) {
    return el('button', { class: 'role-card hidden-card', onclick: toggle },
      el('span', { class: 'role-emoji' }, '🃏'),
      el('b', {}, 'Kartını görmek için dokun'),
      el('small', {}, 'Yanındakiler görmesin!'));
  }
  if (view.me.spy) {
    return el('button', { class: 'role-card spy', onclick: toggle },
      el('span', { class: 'role-emoji' }, '🕵️'),
      el('b', {}, 'CASUSSUN'),
      el('small', {}, view.me.spyCount > 1
        ? 'Bu turda 2 casus var ama diğerinin kim olduğunu bilmiyorsun. Mekânı bulmaya çalış, belli etme!'
        : 'Mekânı bilmiyorsun. Sorulardan çıkarmaya çalış, belli etme!'),
      el('small', { class: 'tap-hint' }, 'Gizlemek için dokun'));
  }
  return el('button', { class: 'role-card', onclick: toggle },
    el('span', { class: 'role-emoji' }, view.me.location.emoji),
    el('b', {}, view.me.location.name),
    el('span', { class: 'role-name' }, `Rolün: ${view.me.role}`),
    el('small', { class: 'tap-hint' }, 'Gizlemek için dokun'));
}

function locationGrid(view, ctx) {
  const spyGuessing = view.me?.spy && guessOpen && view.phase === 'play';
  return el('section', { class: 'card' },
    el('h2', {}, spyGuessing ? '📍 Mekân hangisi?' : '🗺️ Olası mekânlar'),
    el('p', { class: 'hint' }, spyGuessing
      ? 'Seçtiğin mekân kesin tahminin olur. Yanlışsa kaybedersin!'
      : 'Dokunarak elediğin mekânların üstünü çiz (sadece sende görünür).'),
    el('div', { class: 'loc-grid' }, view.locations.map((loc) =>
      el('button', {
        class: `loc${crossed.has(loc.id) ? ' crossed' : ''}`,
        onclick: () => {
          if (spyGuessing) {
            if (confirm(`Mekân "${loc.name}" mi? Bu kesin tahminin.`)) { guessOpen = false; ctx.act({ type: 'guess', locationId: loc.id }); }
            return;
          }
          if (crossed.has(loc.id)) crossed.delete(loc.id); else crossed.add(loc.id);
          lobby.rerender();
        },
      }, `${loc.emoji} ${loc.name}`))));
}

function playerList(view, ctx, { mode }) {
  // mode: 'accuse' (suçlama butonları) | 'final' (oylama) | 'scores'
  return el('ul', { class: 'player-list' }, view.players.map((p) => {
    const me = p.id === ctx.playerId;
    let action = null;
    if (mode === 'accuse' && view.canAccuse && !me) {
      action = el('button', {
        class: 'btn ghost small',
        onclick: () => { if (confirm(`${p.name} adlı oyuncuyu casus diye suçla? Bu turda tek hakkın.`)) ctx.act({ type: 'accuse', targetId: p.id }); },
      }, '☝️ Suçla');
    }
    if (mode === 'final' && view.me && !me) {
      const chosen = view.finalVote.myVote === p.id;
      action = el('button', {
        class: `btn small ${chosen ? 'primary' : 'ghost'}`,
        disabled: view.finalVote.myVote != null,
        onclick: () => ctx.act({ type: 'finalVote', targetId: p.id }),
      }, chosen ? '✓ Oyunu verdin' : 'Casus bu');
    }
    return el('li', { class: ctx.connected(p.id) ? '' : 'offline' },
      el('span', { class: 'player-name' }, p.name),
      me ? el('span', { class: 'tag' }, 'sen') : null,
      p.id === ctx.hostId ? el('span', { class: 'tag' }, '👑') : null,
      ctx.connected(p.id) ? null : el('span', { class: 'tag' }, '📴 bağlantı yok'),
      view.phase === 'play' && view.qa?.askerId === p.id ? el('span', { class: 'tag' }, '❓ soruyor') : null,
      view.phase === 'play' && view.qa?.targetId === p.id ? el('span', { class: 'tag' }, '💬 cevaplıyor') : null,
      el('span', { class: 'score' }, `${p.score} puan`),
      action);
  }));
}

function renderGame(view, ctx) {
  const name = ctx.name;
  const timer = view.endsAt && !view.over
    ? countdown(view.endsAt, ctx.serverOffset)
    : null;

  const head = el('div', { class: 'game-head' },
    el('div', { class: 'round' }, view.over ? 'Oyun bitti' : `Tur ${view.round} / ${view.totalRounds}`),
    timer ? el('div', { class: 'big-timer' }, view.phase === 'accuse' ? '🗳️ ' : view.phase === 'final' ? '⚖️ ' : '⏱️ ', timer) : null);

  // ---------- Oyun bitti: final skor ----------
  if (view.over) {
    const ranked = [...view.players].sort((a, b) => b.score - a.score);
    const medals = ['🥇', '🥈', '🥉'];
    return el('div', { class: 'stack' }, head,
      view.result ? resultCard(view, ctx) : null,
      el('section', { class: 'card' },
        el('h2', {}, '🏆 Final skorları'),
        el('ol', { class: 'final-scores' }, ranked.map((p) => {
          const rank = ranked.findIndex((x) => x.score === p.score); // eşit puan = eşit sıra
          return el('li', {}, el('span', {}, `${medals[rank] ?? `${rank + 1}.`} ${p.name}`), el('b', {}, `${p.score} puan`));
        }))));
  }

  // ---------- Tur sonu ----------
  if (view.phase === 'reveal') {
    return el('div', { class: 'stack' }, head,
      resultCard(view, ctx),
      ctx.isHost
        ? el('button', { class: 'btn big primary', onclick: () => ctx.act({ type: 'next' }) },
          view.round >= view.totalRounds ? 'Sonuçları göster' : 'Sonraki tur →')
        : el('p', { class: 'hint center' }, 'Oda sahibi sonraki turu başlatacak…'));
  }

  const parts = [head, roleCard(view)];

  if (view.phase === 'play') {
    parts.push(qaCard(view, ctx));
    if (view.me?.spy && guessOpen) {
      const grid = locationGrid(view, ctx);
      parts.push(el('button', { class: 'btn ghost', onclick: () => { guessOpen = false; lobby.rerender(); } }, '✕ Vazgeç, tahmin etmeyeceğim'), grid);
      requestAnimationFrame(() => grid.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return el('div', { class: 'stack' }, parts);
    }
    if (view.me?.spy) {
      parts.push(el('button', { class: 'btn big spy-btn', onclick: () => { guessOpen = true; lobby.rerender(); } }, '📍 Mekânı tahmin et'));
    }
    parts.push(el('section', { class: 'card' },
      el('h2', {}, '👥 Oyuncular'),
      view.me && !view.canAccuse ? el('p', { class: 'hint' }, 'Bu turdaki suçlama hakkını kullandın.') : null,
      playerList(view, ctx, { mode: 'accuse' })));
    parts.push(locationGrid(view, ctx));
  }

  if (view.phase === 'accuse') {
    const acc = view.accusation;
    const amTarget = acc.targetId === ctx.playerId;
    parts.push(el('section', { class: 'card alert center' },
      el('h2', {}, '🚨 Suçlama!'),
      el('p', {}, el('b', {}, name(acc.byId)), ', ', el('b', {}, name(acc.targetId)), ' adlı oyuncuyu casus olmakla suçluyor.'),
      el('p', { class: 'hint' }, `Tur saati durdu; üstteki sayaç oylama süresi. Herkes "Evet" derse ${name(acc.targetId)} açıklanır, tek bir "Hayır" suçlamayı düşürür. Oy vermeyen "Hayır" sayılır. (${acc.votedCount}/${acc.voterCount} oy)`),
      amTarget
        ? el('p', {}, '😰 Suçlanan sensin. Kendini savun!')
        : acc.myVote == null && view.me
          ? el('div', { class: 'row center' },
            el('button', { class: 'btn primary', onclick: () => ctx.act({ type: 'vote', yes: true }) }, '👍 Evet, casus'),
            el('button', { class: 'btn ghost', onclick: () => ctx.act({ type: 'vote', yes: false }) }, '👎 Hayır'))
          : el('p', {}, acc.myVote ? 'Verdiğin oy: 👍 Evet' : acc.myVote === false ? 'Verdiğin oy: 👎 Hayır' : '')));
  }

  if (view.phase === 'final') {
    parts.push(el('section', { class: 'card alert' },
      el('h2', {}, '⚖️ Süre doldu! Casus kim?'),
      el('p', { class: 'hint' }, `Herkes bir şüpheli seçsin. En çok oy alan açıklanır; eşitlikte casus kazanır. (${view.finalVote.votedCount}/${view.finalVote.voterCount} oy)`),
      playerList(view, ctx, { mode: 'final' })));
  }

  return el('div', { class: 'stack' }, parts);
}

// Sıradaki soru-cevap: X → Y. İkisi de onaylayınca sıra cevap verene geçer (sunucu yeni ikiliyi seçer).
function qaCard(view, ctx) {
  const qa = view.qa;
  if (!qa) return null;
  const amAsker = qa.askerId === ctx.playerId;
  const amTarget = qa.targetId === ctx.playerId;
  const doneBy = (id) => qa.done.includes(id);
  const mine = amAsker || amTarget;
  return el('section', { class: 'card center qa-card' },
    el('div', { class: 'hint' }, `${qa.number}. soru`),
    el('div', { class: 'qa-pair' },
      el('b', { class: doneBy(qa.askerId) ? 'qa-done' : '' }, ctx.name(qa.askerId)),
      el('span', { class: 'qa-arrow' }, '→'),
      el('b', { class: doneBy(qa.targetId) ? 'qa-done' : '' }, ctx.name(qa.targetId))),
    el('p', { class: 'hint' }, amAsker
      ? 'Mekânla ilgili bir soru sor; cevabı alınca onayla.'
      : amTarget ? 'Sana soruluyor: cevapla, sonra onayla.' : `${ctx.name(qa.askerId)}, ${ctx.name(qa.targetId)} adlı oyuncuya soruyor. Dikkatle dinle!`),
    mine
      ? doneBy(ctx.playerId)
        ? el('p', {}, `✓ Onayladın — ${ctx.name(amAsker ? qa.targetId : qa.askerId)} bekleniyor…`)
        : el('button', { class: 'btn primary', onclick: () => ctx.act({ type: 'qaDone' }) }, amAsker ? '✓ Sordum' : '✓ Cevapladım')
      : qa.done.length ? el('p', { class: 'hint' }, `✓ ${qa.done.map(ctx.name).join(', ')} onayladı`) : null);
}

function resultCard(view, ctx) {
  const res = view.result;
  const spies = res.spyIds.map(ctx.name).join(' ve ');
  const iAmSpy = res.spyIds.includes(ctx.playerId);
  const iWon = res.winner === 'spy' ? iAmSpy : res.winner === 'town' ? !iAmSpy : false;
  return el('section', { class: 'card center' },
    el('div', { class: `result-msg ${res.winner === 'none' ? '' : iWon ? 'good' : 'bad'}` },
      res.winner === 'spy' ? '🕵️ Casus kazandı!' : res.winner === 'town' ? '🎉 Köylüler kazandı!' : '🤷 Tur iptal'),
    el('p', {}, REASONS[res.reason] ?? ''),
    el('p', {}, `${res.spyIds.length > 1 ? 'Casuslar' : 'Casus'}: `, el('b', {}, spies)),
    el('p', {}, 'Mekân: ', el('b', {}, `${res.location.emoji} ${res.location.name}`)),
    res.guess ? el('p', { class: 'hint' }, `Casusun tahmini: ${res.guess.emoji} ${res.guess.name}`) : null,
    res.accuserId ? el('p', { class: 'hint' }, `${ctx.name(res.accuserId)}, ${ctx.name(res.accusedId)} adlı oyuncuyu suçladı.`) : null,
    Object.keys(res.finalVotes ?? {}).length ? el('p', { class: 'hint' }, 'Oylar: ' + Object.entries(res.finalVotes).map(([v, t]) => `${ctx.name(v)} → ${ctx.name(t)}`).join(', ')) : null,
    el('ul', { class: 'player-list roles' }, view.players.map((p) =>
      el('li', {},
        el('span', { class: 'player-name' }, p.name),
        el('span', { class: 'tag' }, res.spyIds.includes(p.id) ? '🕵️ Casus' : res.roles[p.id] ?? ''),
        res.points[p.id] ? el('span', { class: 'score good' }, `+${res.points[p.id]}`) : null))));
}

export function enter() {
  const root = $('game-spyfall');
  lobby?.unmount();
  lobby = mountLobby(root, {
    id: 'spyfall',
    name: 'Casus Kim?',
    icon: '🕵️',
    howTo: [
      'Herkesin telefonunda aynı mekân ve kendi rolü yazar — biri hariç: casus.',
      'Ekranda kimin kime soracağı yazar ("Ali → Ayşe"). Soran sorar, sorulan cevaplar; ikisi de onaylayınca sıra cevap verene geçer.',
      'Casus mekânı bilmez; cevaplardan çıkarmaya ve belli etmemeye çalışır.',
      'Herkes turda bir kez birini suçlayabilir; herkes "Evet" derse suçlanan açıklanır.',
      'Casus istediği an mekânı tahmin edebilir: doğruysa kazanır, yanlışsa kaybeder.',
      'Süre dolarsa herkes bir şüpheliye oy verir.',
    ],
    renderSettings: settingsUI,
    renderGame,
  });
}

export function leave() {
  lobby?.unmount();
  lobby = null;
}
