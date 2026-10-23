// 🧛 Vampir Köylü — istemci ekranı. Oyun mantığı sunucuda (server/games/vampir.js), kurallar PLAN.md §4.3.
// Aynı odada oynandığı için rolü ele veren her şey (rol, gece talimatı, müttefik seçimleri, gözcü sonucu)
// sadece "kartını göster" açıkken görünür; gece herkesin ekranı aynı yapıda.
import { mountLobby } from '../lobby.js';
import { $, el, countdown, toast } from '../ui.js';

const ROLES = {
  vampir: { name: 'Vampir', icon: '🧛', desc: 'Her gece diğer vampirlerle bir kurban seç. Gündüz köylü gibi davran.', night: 'Kurbanını seç.' },
  koylu: { name: 'Köylü', icon: '🧑‍🌾', desc: 'Özel gücün yok. Konuş, şüphelen, vampirleri as.', night: 'En çok şüphelendiğin kişiyi seç.' },
  doktor: { name: 'Doktor', icon: '🩺', desc: 'Her gece birini koru. Aynı kişiyi üst üste iki gece koruyamazsın.', night: 'Bu gece kimi koruyorsun?' },
  gozcu: { name: 'Gözcü', icon: '🔮', desc: 'Her gece birinin vampir olup olmadığını öğren. Bildiğini dikkatli kullan.', night: 'Kimin içini göreceksin?' },
  deli: { name: 'Deli', icon: '🤡', desc: 'Tek başınasın: gündüz asılırsan sen kazanırsın! Şüphe çek ama çok belli etme.', night: 'En çok şüphelendiğin kişiyi seç.' },
};
const TEAM_WIN = {
  town: '🧑‍🌾 Köy kazandı! Bütün vampirler öldü.',
  vampires: '🧛 Vampirler kazandı! Köy düştü.',
  jester: '🤡 Deli kazandı! Köy onu astı.',
};

let lobby = null;
let cardOpen = false;
let cardKey = '';

function settingsUI(s, { editable, change, playerCount }) {
  const select = (key, options, label) => el('label', {},
    label,
    el('select', { disabled: !editable, onchange: (e) => change({ [key]: Number(e.target.value) }) },
      options.map(([v, text]) => el('option', { value: String(v), selected: s[key] === v }, text))));
  const toggle = (key, label) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: s[key], disabled: !editable, onchange: (e) => change({ [key]: e.target.checked }) }),
    label);
  const auto = playerCount <= 7 ? 1 : playerCount <= 10 ? 2 : 3;
  const cap = Math.max(1, Math.floor((playerCount - 1) / 3)); // sunucudaki maxVampires ile aynı
  const vampLabel = (n) => (n > cap ? `${n} → bu kişi sayısında ${cap}` : String(n));
  return el('div', { class: 'stack' },
    el('div', { class: 'settings' },
      select('vampires', [[0, `Otomatik (${auto})`], [1, vampLabel(1)], [2, vampLabel(2)], [3, vampLabel(3)]], 'Vampir sayısı'),
      select('dayMinutes', [2, 3, 4, 5, 6, 8].map((n) => [n, `${n} dakika`]), 'Gündüz tartışması'),
      select('defenseSeconds', [15, 30, 45, 60].map((n) => [n, `${n} saniye`]), 'Savunma süresi'),
      select('nightSeconds', [30, 45, 60, 90, 120].map((n) => [n, `${n} saniye`]), 'Gece süresi')),
    el('p', { class: 'hint' }, 'Elle seçilen vampir sayısı en fazla: 5–6 kişide 1, 7–9 kişide 2, 10+ kişide 3 (fazlası ilk geceden sonra oyunu bitirir).'),
    el('div', { class: 'checks' },
      toggle('doktor', '🩺 Doktor'), toggle('gozcu', '🔮 Gözcü'), toggle('deli', '🤡 Deli')));
}

const nameOf = (view, id) => view.players.find((p) => p.id === id)?.name ?? '?';

function roleCard(view) {
  // Her faz değişiminde kart kendiliğinden kapanır (gece açılan kart gündüz masada açık kalmasın).
  const key = `${view.gameKey}:${view.phase}:${view.night}`;
  if (cardKey !== key) { cardKey = key; cardOpen = false; }
  if (!view.me) return null;
  const toggle = () => { cardOpen = !cardOpen; lobby.rerender(); };
  if (!cardOpen) {
    return el('button', { class: 'role-card hidden-card', onclick: toggle },
      el('span', { class: 'role-emoji' }, '🃏'),
      el('b', {}, 'Kartını görmek için dokun'),
      el('small', {}, 'Rolün, gece görevin ve gizli bilgilerin burada.'));
  }
  const r = ROLES[view.me.role];
  const extra = [];
  if (view.me.allies?.length) extra.push(el('span', { class: 'role-name' }, `Diğer vampirler: ${view.me.allies.map((id) => nameOf(view, id)).join(', ')}`));
  if (view.me.allies && !view.me.allies.length) extra.push(el('small', {}, 'Bu oyunda tek vampir sensin.'));
  if (view.me.seerResults?.length) {
    extra.push(el('ul', { class: 'seer-list' }, view.me.seerResults.map((x) =>
      el('li', {}, `${x.night}. gece: ${nameOf(view, x.targetId)} → `, el('b', {}, x.isVampire ? '🧛 Vampir' : '✅ Vampir değil')))));
  }
  if (view.me.role === 'doktor' && view.me.lastProtected) {
    extra.push(el('small', {}, `Dün gece ${nameOf(view, view.me.lastProtected)} adlı oyuncuyu korudun; bu gece onu koruyamazsın.`));
  }
  // Bütün roller aynı renkte: uzaktan bakınca kart renginden rol anlaşılmasın.
  return el('button', { class: 'role-card', onclick: toggle },
    el('span', { class: 'role-emoji' }, r.icon),
    el('b', {}, r.name),
    el('small', {}, r.desc),
    ...extra,
    el('small', { class: 'tap-hint' }, 'Gizlemek için dokun'));
}

function headline(view, ctx) {
  const titles = {
    night: `🌙 ${view.night}. gece`,
    day: `☀️ ${view.night}. gün`,
    trial: '⚖️ Savunma',
    trialVote: '🗳️ Oylama',
    over: '🏁 Oyun bitti',
  };
  return el('div', { class: 'game-head' },
    el('div', { class: 'round' }, titles[view.phase]),
    view.endsAt ? el('div', { class: 'big-timer' }, countdown(view.endsAt, ctx.serverOffset)) : null);
}

function announcement(view) {
  if (!view.announcement || view.phase === 'night' || view.phase === 'over') return null;
  const a = view.announcement;
  const trial = view.lastTrial && view.phase === 'day' && view.lastTrial.hanged === false
    ? el('p', { class: 'hint' }, `${nameOf(view, view.lastTrial.targetId)} için oylama: ${view.lastTrial.yes}/${view.lastTrial.voters} Evet — asılmadı.`)
    : null;
  return el('section', { class: 'card center' },
    a.deadId
      ? el('p', { class: 'announce' }, '🩸 Bu gece ', el('b', {}, nameOf(view, a.deadId)), ' öldü.')
      : el('p', { class: 'announce' }, '🌅 Bu gece kimse ölmedi.'),
    trial);
}

function nightScreen(view, ctx) {
  const me = view.me;
  const r = me ? ROLES[me.role] : null;
  const picked = me?.nightPick;
  const allyPicks = cardOpen ? me?.allyPicks ?? {} : {};
  // Seçim sadece kart açıkken yapılır: kapalıyken herkesin ekranı ve dokunuşa tepkisi birebir aynı
  // (vurgu, pasif düğme, hata mesajı rolü ele verirdi). Herkes gece kartını açmak zorunda.
  let hint;
  if (!me) hint = '👀 İzleyicisin; gece olayları gizli.';
  else if (!me.alive) hint = '💀 Ölüler gece görev almaz.';
  else if (!cardOpen) hint = picked ? '✓ Seçimini yaptın. Değiştirmek için kartını aç.' : 'Seçim yapmak için kartını aç. Herkes bir seçim yapar.';
  else hint = `${r.night} ${me.role === 'gozcu' ? 'Tek bakış hakkın var, seçimin değişmez.' : 'Seçimini gece bitene kadar değiştirebilirsin.'}`;
  return el('section', { class: 'card' },
    el('h2', {}, '🌙 Köy uyuyor — gece görevin'),
    el('p', { class: 'hint' }, hint),
    me?.alive
      ? el('div', { class: 'target-grid' }, view.players.filter((p) => p.alive).map((p) => {
        const allowed = me.nightTargets.includes(p.id);
        const allies = Object.entries(allyPicks).filter(([, t]) => t === p.id).map(([id]) => nameOf(view, id));
        return el('button', {
          class: `target${cardOpen && picked === p.id ? ' chosen' : ''}`,
          disabled: cardOpen && !allowed,
          onclick: () => {
            if (!cardOpen) return toast('Seçim yapmak için kartını aç.');
            ctx.act({ type: 'nightPick', targetId: p.id });
          },
        }, p.name, p.id === ctx.playerId ? ' (sen)' : '',
        allies.length ? el('small', { class: 'ally-pick' }, `🧛 ${allies.join(', ')}`) : null);
      }))
      : null,
    el('p', { class: 'hint center' }, `${view.nightProgress.done}/${view.nightProgress.total} kişi seçti`));
}

function dayScreen(view, ctx) {
  const me = view.me;
  const nom = view.nomination;
  const parts = [];
  if (nom) {
    const canSupport = me?.alive && ctx.playerId !== nom.byId && ctx.playerId !== nom.targetId;
    parts.push(el('section', { class: 'card alert center' },
      el('p', {}, '☝️ ', el('b', {}, nameOf(view, nom.byId)), ', ', el('b', {}, nameOf(view, nom.targetId)), ' adlı oyuncuyu aday gösterdi.'),
      el('p', { class: 'hint' }, 'Biri desteklerse yargılama başlar. Süre: ', countdown(nom.expiresAt, ctx.serverOffset)),
      canSupport ? el('button', { class: 'btn primary', onclick: () => ctx.act({ type: 'support' }) }, '✋ Destekliyorum') : null));
  }
  parts.push(el('section', { class: 'card' },
    el('h2', {}, '🗣️ Tartışın'),
    el('p', { class: 'hint' }, me?.canNominate
      ? 'Şüphelendiğin birini aday gösterebilirsin (günde bir kez).'
      : me?.alive ? 'Bugünkü aday gösterme hakkını kullandın.' : me ? '💀 Ölüler konuşmaz.' : '👀 İzleyicisin.'),
    playerList(view, ctx, (p) => (me?.canNominate && !nom && p.alive && p.id !== ctx.playerId
      ? el('button', { class: 'btn ghost small', onclick: () => ctx.act({ type: 'nominate', targetId: p.id }) }, '☝️ Aday göster')
      : null))));
  if (ctx.isHost) {
    parts.push(el('button', {
      class: 'btn ghost',
      onclick: () => { if (confirm('Tartışma bitsin, kimse asılmadan geceye geçilsin mi?')) ctx.act({ type: 'endDay' }); },
    }, '🌙 Geceye geç (kimse asılmadan)'));
  }
  return parts;
}

function trialScreen(view, ctx) {
  const t = view.trial;
  const amTarget = t.targetId === ctx.playerId;
  if (view.phase === 'trial') {
    return el('section', { class: 'card alert center' },
      el('h2', {}, `⚖️ ${nameOf(view, t.targetId)} kendini savunuyor`),
      el('p', { class: 'hint' }, 'Herkes dinlesin. Savunma bitince "Asılsın mı?" oylaması başlar.'),
      amTarget ? el('button', { class: 'btn primary', onclick: () => ctx.act({ type: 'endDefense' }) }, 'Savunmam bitti') : null);
  }
  const canVote = view.me?.alive && !amTarget && t.myVote == null;
  return el('section', { class: 'card alert center' },
    el('h2', {}, `🗳️ ${nameOf(view, t.targetId)} asılsın mı?`),
    el('p', { class: 'hint' }, `Oy hakkı olanların yarısından fazlası Evet derse asılır. Oy vermeyen Hayır sayılır. (${t.votedCount}/${t.voterCount} oy)`),
    canVote
      ? el('div', { class: 'row center' },
        el('button', { class: 'btn primary', onclick: () => ctx.act({ type: 'trialVote', yes: true }) }, '👍 Evet, asılsın'),
        el('button', { class: 'btn ghost', onclick: () => ctx.act({ type: 'trialVote', yes: false }) }, '👎 Hayır'))
      : el('p', {}, amTarget ? '😰 Senin hakkında oylanıyor.' : t.myVote != null ? `Verdiğin oy: ${t.myVote ? '👍 Evet' : '👎 Hayır'}` : view.me ? '💀 Ölüler oy veremez.' : '👀 İzleyiciler oy veremez.'));
}

function playerList(view, ctx, action) {
  const deathText = (d) => (d.cause === 'night' ? `${d.night}. gece öldü` : d.cause === 'hanged' ? `${d.night}. gün asıldı` : 'oyundan ayrıldı');
  return el('ul', { class: 'player-list' }, view.players.map((p) =>
    el('li', { class: `${p.alive ? '' : 'dead'}${ctx.connected(p.id) ? '' : ' offline'}` },
      el('span', { class: 'player-name' }, `${p.alive ? '' : '💀 '}${p.name}`),
      p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
      p.id === ctx.hostId ? el('span', { class: 'tag' }, '👑') : null,
      p.alive ? null : el('span', { class: 'tag' }, deathText(p.death)),
      ctx.connected(p.id) ? null : el('span', { class: 'tag' }, '📴'),
      action?.(p))));
}

function overScreen(view, ctx) {
  const res = view.result;
  const won = res.winnerIds.includes(ctx.playerId);
  return el('div', { class: 'stack' },
    el('section', { class: 'card center' },
      el('div', { class: `result-msg ${!view.me ? '' : won ? 'good' : 'bad'}` }, TEAM_WIN[res.winner]),
      el('p', {}, !view.me ? '👀 Bu oyunu izledin.' : won ? '🎉 Kazanan taraftasın!' : '😵 Kaybettin.')),
    el('section', { class: 'card' },
      el('h2', {}, '🃏 Roller'),
      el('ul', { class: 'player-list roles' }, view.players.map((p) => {
        const r = ROLES[res.roles[p.id]];
        return el('li', { class: p.alive ? '' : 'dead' },
          el('span', { class: 'player-name' }, `${p.alive ? '' : '💀 '}${p.name}`),
          el('span', { class: 'tag' }, `${r.icon} ${r.name}`),
          res.winnerIds.includes(p.id) ? el('span', { class: 'score good' }, '🏆') : null);
      }))),
    el('section', { class: 'card' },
      el('h2', {}, '⚰️ Ölümler'),
      el('ul', { class: 'howto' }, view.players.filter((p) => !p.alive)
        .sort((a, b) => a.death.night - b.death.night || (a.death.cause === 'night' ? -1 : 1))
        .map((p) => el('li', {}, `${p.name} (${ROLES[res.roles[p.id]].name}) — ${p.death.cause === 'night' ? `${p.death.night}. gece öldürüldü` : p.death.cause === 'hanged' ? `${p.death.night}. gün asıldı` : 'oyundan ayrıldı'}`)))),
    el('section', { class: 'card' },
      el('h2', {}, '📜 Geceler'),
      el('ul', { class: 'howto' }, res.log.filter((l) => !l.trial).map((l) => el('li', {},
        `${l.night}. gece: `,
        l.victimId ? `${nameOf(view, l.victimId)} öldürüldü` : l.savedId ? `doktor ${nameOf(view, l.savedId)} adlı oyuncuyu kurtardı` : 'kimse ölmedi',
        l.doctorPick && !l.savedId ? ` (doktor: ${nameOf(view, l.doctorPick)})` : ''))),
      res.seerResults.length ? el('p', { class: 'hint' }, 'Gözcünün baktıkları: '
        + res.seerResults.map((x) => `${nameOf(view, x.targetId)} (${x.isVampire ? 'vampir' : 'değil'})`).join(', ')) : null));
}

function renderGame(view, ctx) {
  if (view.phase === 'over') return el('div', { class: 'stack' }, headline(view, ctx), overScreen(view, ctx));
  const parts = [headline(view, ctx)];
  if (view.me && !view.me.alive) parts.push(el('section', { class: 'card warn center' }, '💀 Öldün. Ölüler konuşmaz — oyun bitene kadar sessizce izle.'));
  parts.push(roleCard(view));
  if (view.phase === 'night') parts.push(nightScreen(view, ctx));
  else {
    parts.push(announcement(view));
    if (view.phase === 'day') parts.push(...dayScreen(view, ctx));
    else parts.push(trialScreen(view, ctx));
  }
  if (view.phase !== 'day') { // gündüz ekranının kendi listesi var
    parts.push(el('section', { class: 'card' }, el('h2', {}, '👥 Köy'), playerList(view, ctx)));
  }
  const counts = Object.entries(view.roleCounts).map(([r, n]) => `${ROLES[r].icon} ${n > 1 ? `${n} ` : ''}${ROLES[r].name}`).join(' · ');
  parts.push(el('p', { class: 'hint center' }, `Bu oyunda: ${counts}`));
  return el('div', { class: 'stack' }, parts);
}

export function enter() {
  lobby?.unmount();
  lobby = mountLobby($('game-vampir'), {
    id: 'vampir',
    name: 'Vampir Köylü',
    icon: '🧛',
    howTo: [
      'Herkes gizli bir rol alır: vampirler birbirini bilir, köylüler kimseyi bilmez.',
      'Gece herkes telefonundan bir seçim yapar: vampirler kurban, doktor korunacak kişi, gözcü bakılacak kişi seçer; diğerleri şüphelendiğini işaretler.',
      'Sabah kimin öldüğü duyurulur — roller oyun bitene kadar hiç açıklanmaz.',
      'Gündüz tartışın. Biri aday gösterir, başka biri desteklerse aday savunma yapar, sonra "Asılsın mı?" oylanır.',
      'Vampirler ölünce köy, vampirler köylülere eşitlenince vampirler kazanır. Deli asılırsa tek başına kazanır!',
      'Ölüler konuşmaz. 🤫',
    ],
    renderSettings: settingsUI,
    renderGame,
  });
}

export function leave() {
  lobby?.unmount();
  lobby = null;
}
