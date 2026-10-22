// Lobili oyunların ortak ekranı: oda kur / koda katıl → bekleme odası → oyun → sonuç.
// Oyun modülü sadece ayar ve oyun ekranını çizer; gerisi burada. Bkz. PLAN.md §3.5.
import { net } from './net.js';
import { el, toast } from './ui.js';

const GAME_NAMES = {}; // id -> ad (başka oyunun odasındayken uyarı için)

// game: { id, name, icon, howTo: [metin], renderSettings(settings, { editable, change }), renderGame(view, ctx) }
export function mountLobby(root, game) {
  GAME_NAMES[game.id] = `${game.icon} ${game.name}`;
  let active = true;
  let joinCode = '';
  let draftName = net.name;

  const render = () => {
    if (!active) return;
    const room = net.room;
    const screen = room && room.game === game.id ? roomScreen(room) : entryScreen(room);
    if (net.replaced) {
      screen.prepend(el('section', { class: 'card warn' },
        '📱 Bu oyuna başka bir sekmeden (veya cihazdan) bağlandın; bu sekme durduruldu.',
        el('button', { class: 'btn primary', onclick: () => net.takeover() }, 'Bu sekmede devam et')));
    }
    root.replaceChildren(screen);
  };

  // ---------- Giriş: ad + oda kur / katıl ----------
  function entryScreen(otherRoom) {
    const nameInput = el('input', {
      type: 'text', maxlength: '16', placeholder: 'Takma adın', value: draftName, autocomplete: 'nickname',
      oninput: (e) => { draftName = e.target.value; },
    });
    const codeInput = el('input', {
      type: 'text', maxlength: '4', placeholder: 'KOD', value: joinCode, class: 'code-input',
      autocapitalize: 'characters', autocomplete: 'off', inputmode: 'text',
      oninput: (e) => { joinCode = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); e.target.value = joinCode; },
    });
    const ensureName = () => {
      const name = nameInput.value.trim();
      if (!name) { toast('Önce bir takma ad yaz.'); nameInput.focus(); return false; }
      if (name !== net.name) net.setName(name);
      return true;
    };
    return el('div', { class: 'screen active' },
      otherRoom ? el('section', { class: 'card warn' },
        `Şu an ${GAME_NAMES[otherRoom.game] ?? otherRoom.game} odasındasın (${otherRoom.code}).`,
        el('div', { class: 'row' },
          el('a', { class: 'btn', href: `#/multi/${otherRoom.game}` }, 'Odaya dön'),
          el('button', { class: 'btn ghost', onclick: () => net.send({ t: 'leave' }) }, 'Odadan çık'))) : null,
      el('section', { class: 'card' },
        el('h2', {}, '🙋 Takma adın'),
        nameInput),
      el('section', { class: 'card' },
        el('h2', {}, '🏠 Oda kur'),
        el('p', { class: 'hint' }, 'Odayı sen kurarsın, arkadaşların kodla katılır.'),
        el('button', { class: 'btn big primary', onclick: () => { if (ensureName()) net.send({ t: 'create', game: game.id }); } }, 'Yeni oda kur')),
      el('section', { class: 'card' },
        el('h2', {}, '🔑 Koda katıl'),
        el('form', {
          class: 'row',
          onsubmit: (e) => {
            e.preventDefault();
            if (joinCode.length !== 4) return toast('Kod 4 harfli.');
            if (ensureName()) net.send({ t: 'join', code: joinCode });
          },
        }, codeInput, el('button', { class: 'btn primary', type: 'submit' }, 'Katıl'))),
      game.howTo?.length ? el('section', { class: 'card' },
        el('h2', {}, '📖 Nasıl oynanır?'),
        el('ul', { class: 'howto' }, game.howTo.map((line) => el('li', {}, line)))) : null,
    );
  }

  // ---------- Oda: bekleme / oyun / sonuç ----------
  function roomScreen(room) {
    const me = room.players.find((p) => p.id === net.playerId);
    const isHost = room.hostId === net.playerId;
    const ctx = {
      room, me, isHost,
      playerId: net.playerId,
      serverOffset: net.serverOffset,
      act: (action) => net.action(action),
      name: (id) => room.players.find((p) => p.id === id)?.name ?? 'Biri',
      connected: (id) => room.players.find((p) => p.id === id)?.connected !== false,
      hostId: room.hostId,
    };

    if (room.phase === 'lobby') return waitingRoom(room, ctx);

    return el('div', { class: 'screen active' },
      el('div', { class: 'room-bar' },
        el('span', { class: 'room-code-small' }, `Oda ${room.code}`),
        el('span', { class: 'hint' }, `${room.players.filter((p) => p.connected).length} kişi bağlı`),
        net.connected ? null : el('span', { class: 'badge offline' }, 'Bağlantı yok…')),
      me?.spectator ? el('section', { class: 'card warn' }, '👀 Oyun başladıktan sonra katıldın; bu el izleyicisin.') : null,
      net.view ? game.renderGame(net.view, ctx) : el('section', { class: 'card' }, 'Yükleniyor…'),
      room.phase === 'over'
        ? (isHost
          ? el('button', { class: 'btn big primary', onclick: () => net.send({ t: 'backToLobby' }) }, 'Bekleme odasına dön')
          : el('p', { class: 'hint center' }, 'Oda sahibinin yeni oyunu başlatması bekleniyor…'))
        : null,
      el('button', {
        class: 'btn link',
        onclick: () => { if (confirm('Odadan çıkmak istiyor musun?')) net.send({ t: 'leave' }); },
      }, 'Odadan çık'),
      isHost && room.phase === 'playing' ? el('button', {
        class: 'btn link',
        onclick: () => { if (confirm('Oyunu herkes için bitirip bekleme odasına dönülsün mü?')) net.send({ t: 'backToLobby' }); },
      }, 'Oyunu iptal et') : null,
    );
  }

  function waitingRoom(room, ctx) {
    const link = `${location.origin}/#/join/${room.code}`;
    const connectedCount = room.players.filter((p) => p.connected).length;
    const enough = connectedCount >= room.minPlayers;
    return el('div', { class: 'screen active' },
      el('section', { class: 'card center' },
        el('div', { class: 'hint' }, 'Oda kodu'),
        el('div', { class: 'lobby-code' }, room.code),
        el('div', { class: 'row center' },
          el('button', {
            class: 'btn ghost',
            onclick: async () => {
              try {
                if (navigator.share) await navigator.share({ title: 'Tosun Style', text: `${game.name} odasına gel!`, url: link });
                else { await navigator.clipboard.writeText(link); toast('Link kopyalandı.'); }
              } catch { /* paylaşım iptal */ }
            },
          }, '🔗 Davet linki'))),
      el('section', { class: 'card' },
        el('h2', {}, `👥 Oyuncular (${room.players.length}/${room.maxPlayers})`),
        el('ul', { class: 'player-list' }, room.players.map((p) =>
          el('li', { class: p.connected ? '' : 'offline' },
            el('span', { class: 'player-name' }, p.name),
            p.isHost ? el('span', { class: 'tag' }, '👑 oda sahibi') : null,
            p.id === ctx.playerId ? el('span', { class: 'tag' }, 'sen') : null,
            p.connected ? null : el('span', { class: 'tag' }, '📴'),
            ctx.isHost && p.id !== ctx.playerId
              ? el('button', { class: 'icon-btn', title: 'Çıkar', 'aria-label': `${p.name} adlı oyuncuyu çıkar`, onclick: () => { if (confirm(`${p.name} odadan çıkarılsın mı?`)) net.send({ t: 'kick', playerId: p.id }); } }, '✕')
              : null))),
        enough ? null : el('p', { class: 'hint' }, `Başlamak için en az ${room.minPlayers} kişi lazım.`)),
      game.renderSettings ? el('section', { class: 'card' },
        el('h2', {}, '⚙️ Ayarlar'),
        game.renderSettings(room.settings, {
          editable: ctx.isHost,
          change: (patch) => net.send({ t: 'settings', settings: patch }),
          playerCount: connectedCount,
        }),
        ctx.isHost ? null : el('p', { class: 'hint' }, 'Ayarları oda sahibi değiştirir.')) : null,
      ctx.isHost
        ? el('button', { class: 'btn big primary', disabled: !enough, onclick: () => net.send({ t: 'start' }) }, 'Oyunu başlat')
        : el('p', { class: 'hint center' }, 'Oda sahibinin oyunu başlatması bekleniyor…'),
      el('button', { class: 'btn link', onclick: () => net.send({ t: 'leave' }) }, 'Odadan çık'),
    );
  }

  const offs = [
    net.on('room', render),
    net.on('view', render),
    net.on('status', render),
    net.on('replaced', render),
    net.on('error', (e) => toast(e.message)),
    net.on('kicked', () => toast('Oda sahibi seni odadan çıkardı.')),
  ];
  net.connect();
  render();

  return {
    unmount() {
      active = false;
      offs.forEach((off) => off());
    },
    rerender: render,
  };
}

// #/join/KOD linki: bağlan, (gerekirse onay al) katıl, odanın oyununa geç.
export async function joinFromLink(code) {
  const clean = String(code).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  await net.whenReady();
  const current = net.room;
  if (current?.code === clean) return location.replace(`#/multi/${current.game}`);
  if (current && current.phase === 'playing'
    && !confirm(`Şu an ${GAME_NAMES[current.game] ?? 'bir'} oyunundasın (oda ${current.code}). Oyundan çıkıp bu odaya katılmak istiyor musun?`)) {
    return location.replace(`#/multi/${current.game}`);
  }
  if (!net.name) {
    const name = prompt('Odaya katılmak için takma adın?')?.trim();
    if (!name) { toast('Katılmak için bir ad gerekli.'); return location.replace('#/'); }
    net.setName(name);
  }
  const offRoom = net.on('room', (room) => {
    if (room?.code !== clean) return;
    offRoom(); offErr();
    location.replace(`#/multi/${room.game}`);
  });
  const offErr = net.on('error', (e) => {
    offRoom(); offErr();
    toast(e.message);
    location.replace('#/');
  });
  net.send({ t: 'join', code: clean });
}
