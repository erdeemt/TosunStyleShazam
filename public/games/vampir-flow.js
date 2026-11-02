// 🧛 Vampir Köylü — anlatıcı (Aşama 2: akış). Sunucunun kısa ara fazları (dusk/dawn/verdict, PLAN.md §4.3) sırasında
// büyük bir anlatıcı kutusu, oyun içi olaylarda (aday, destek, oylama) küçük ipuçları gösterir.
//
// Satırlar sunucu saatine göre sıralanır (narration.startedAt / endsAt + serverOffset): geç katılan / yeniden bağlanan
// da doğru satırı görür, bütün telefonlar aynı anda aynı satırdadır. Sadece view.narration ve herkese açık görünüm
// alanlarından üretilir — rol, gece seçimi, oy gibi gizli bir şey kullanmaz.

// Açıklama anı (fazın kesri): 3D ölüm/sürgün animasyonu da tam bu anda başlar (vampir-3d.js).
export const DAWN_REVEAL = 0.45;
export const VERDICT_REVEAL = 0.35;
export const OVER_MS = 5000; // oyun sonu duyurusu (bitiş saati yok; gerçek süre)
export const INTERMISSIONS = ['dusk', 'dawn', 'verdict'];

const WIN = {
  town: ['🧑‍🌾', 'Köy kazandı!', 'Bütün vampirler yok edildi.'],
  vampires: ['🧛', 'Vampirler kazandı!', 'Köy karanlığa gömüldü.'],
  jester: ['🤡', 'Deli kazandı!', 'Köy onu fırlattı — tam da istediği buydu.'],
};

// Ölüm animasyonu: oyun + gece numarasından (herkeste aynı, gizli bilgiye bağlı değil).
export const DEATH_STYLES = ['bats', 'tomb', 'coffin'];
export function deathStyle(gameKey, night) {
  let h = 0x811c9dc5;
  const s = `${gameKey}:${night}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return DEATH_STYLES[(h >>> 0) % DEATH_STYLES.length];
}

// Anlatıcı satırları: [{ at (fazın kesri 0..1), emoji, title, sub, tone }]
// name(id) → oyuncu adı; winner: oyun bitince view.result.winner.
export function narrationBeats(n, name, winner = null) {
  if (!n) return [];
  switch (n.kind) {
    case 'intro':
      return [
        { at: 0, emoji: '🏡', title: 'Köye hoş geldiniz…', sub: 'Bu sessiz köyde vampirler saklanıyor.' },
        { at: 0.35, emoji: '🃏', title: 'Roller dağıtıldı', sub: 'Kartına gizlice bak — kimseye gösterme!' },
        { at: 0.75, emoji: '🌙', title: 'Akşam oluyor…', sub: `${n.night}. gece başlamak üzere. Gözler kapansın.` },
      ];
    case 'dusk':
      return [
        { at: 0, emoji: '🌇', title: 'Akşam oldu', sub: 'Güneş tepelerin ardına iniyor…' },
        { at: 0.45, emoji: '🌙', title: 'Köy uykuya dalıyor…', sub: `${n.night}. gece başlıyor. Herkes kartını açıp seçimini yapsın.` },
      ];
    case 'dawn': {
      const reveal = n.deadId
        ? { at: DAWN_REVEAL, emoji: '🩸', title: `${name(n.deadId)} bu gece öldü.`, sub: 'Rolü sır olarak kalacak. Huzur içinde yatsın…', tone: 'dark' }
        : { at: DAWN_REVEAL, emoji: '🌅', title: 'Bu gece kimse ölmedi!', sub: 'Köy derin bir nefes aldı.', tone: 'good' };
      return [
        { at: 0, emoji: '☀️', title: 'Sabah oldu…', sub: 'Köy yavaş yavaş uyanıyor.' },
        { at: 0.22, emoji: '👀', title: 'Herkes etrafına bakınıyor…', sub: 'Bu gece neler oldu?' },
        reveal,
        { at: 0.86, emoji: '🗣️', title: `${n.night}. gün`, sub: 'Konuşun, şüphelenin, aday gösterin.' },
      ];
    }
    case 'verdict': {
      const t = n.trial ?? {};
      const who = name(t.targetId);
      const tally = { at: 0, emoji: '🗳️', title: `Oylama: ${t.yes}/${t.voters} Evet`, sub: `${who} için karar veriliyor… (yarıdan fazlası gerekir)` };
      if (t.hanged) {
        return [tally,
          { at: VERDICT_REVEAL, emoji: '🔥', title: `${who} köyden atılıyor!`, sub: 'Meşaleler yandı, mancınık gerildi…', tone: 'dark' },
          { at: 0.62, emoji: '🪨', title: `${who} fırlatıldı!`, sub: 'Rolü sır olarak kalacak.', tone: 'dark' },
          { at: 0.88, emoji: '⚖️', title: 'Köy kararını verdi.', sub: 'Bakalım doğru kişi miydi…' }];
      }
      return [tally,
        { at: VERDICT_REVEAL, emoji: '😮‍💨', title: `${who} kurtuldu!`, sub: 'Yeterli Evet çıkmadı.', tone: 'good' },
        { at: 0.8, emoji: '🗣️', title: 'Tartışma kaldığı yerden sürüyor', sub: 'Gün henüz bitmedi.' }];
    }
    case 'over': {
      const w = WIN[winner] ?? ['🏁', 'Oyun bitti', ''];
      return [
        { at: 0, emoji: '🏁', title: 'Oyun bitti!', sub: 'Herkes meydanda toplanıyor…' },
        { at: 0.3, emoji: w[0], title: w[1], sub: w[2], tone: 'win' },
      ];
    }
    default:
      return [];
  }
}

// Sunucu saatinde (ms) hangi satır: { index, frac } (frac: fazın kesri, 0..1+)
export function beatAt(beats, n, serverNow) {
  const dur = n.endsAt ? Math.max(1, n.endsAt - n.startedAt) : OVER_MS;
  const frac = (serverNow - n.startedAt) / dur;
  let index = 0;
  beats.forEach((b, i) => { if (frac >= b.at) index = i; });
  return { index, frac };
}

// ---------- DOM: anlatıcı kutusu + küçük ipuçları ----------
// Tek öğe, vampir.js her çizimde yeniden yerleştirir. CSS (.vnar): 3D sahne görünürken onun üstüne biner,
// 3D kapalı/yoksa normal bir kart olarak akışta durur.
export function createNarrator() {
  const el = document.createElement('div');
  el.className = 'vnar';
  el.setAttribute('aria-live', 'polite');
  const box = document.createElement('div');
  box.className = 'vnar-box';
  const emoji = document.createElement('div');
  emoji.className = 'vnar-emoji';
  const title = document.createElement('div');
  title.className = 'vnar-title';
  const sub = document.createElement('div');
  sub.className = 'vnar-sub';
  const bar = document.createElement('div');
  bar.className = 'vnar-bar';
  const fill = document.createElement('i');
  bar.append(fill);
  box.append(emoji, title, sub, bar);
  const cueEl = document.createElement('div');
  cueEl.className = 'vnar-cue';
  el.append(box, cueEl);

  let n = null; // geçerli anlatım
  let beats = [];
  let key = '';
  let offset = 0;
  let shown = -1;
  let timer = 0;
  let cueUntil = 0;
  let endsAt = null; // faz bitişi (son 10 sn nabzı)
  let phase = '';
  let disposed = false;

  const serverNow = () => Date.now() + offset;
  function paintBeat(i) {
    const b = beats[i];
    shown = i;
    emoji.textContent = b.emoji;
    title.textContent = b.title;
    sub.textContent = b.sub;
    box.dataset.tone = b.tone ?? '';
    el.dataset.beat = String(i);
    box.classList.remove('in');
    void box.offsetWidth; // animasyonu yeniden başlat
    box.classList.add('in');
  }
  function tick() {
    if (disposed) return;
    const now = serverNow();
    let active = false;
    if (n && beats.length) {
      const { index, frac } = beatAt(beats, n, now);
      active = n.kind !== 'over' || frac < 1;
      if (active && index !== shown) paintBeat(index);
      fill.style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
    }
    el.classList.toggle('active', active);
    el.dataset.kind = active ? n.kind : '';
    const cueOn = Date.now() < cueUntil;
    el.classList.toggle('cueing', cueOn && !active);
    el.hidden = !active && !cueOn;
    // Son 10 saniye: büyük sayaç nabız gibi atar (gece/gündüz/savunma/oylama).
    const timerEl = el.isConnected ? el.closest('#game-vampir')?.querySelector('.big-timer') : null;
    if (timerEl) {
      const left = endsAt ? endsAt - now : Infinity;
      timerEl.classList.toggle('hurry', !INTERMISSIONS.includes(phase) && left > 0 && left <= 10_000);
    }
    const left = endsAt ? endsAt - now : 0;
    const busy = active || cueOn || (left > 0 && left <= 11_000);
    if (busy || (n && n.kind !== 'over')) timer = setTimeout(tick, 200);
    else if (left > 11_000) timer = setTimeout(tick, left - 10_800); // son 10 sn nabzı için uyan
    else timer = 0;
  }
  const kick = () => { if (!timer && !disposed) tick(); };

  return {
    el,
    // view: son görünüm, name: id → ad
    update(view, ctx, name) {
      if (disposed) return;
      offset = ctx.serverOffset ?? 0;
      phase = view.phase;
      endsAt = view.endsAt;
      const nn = view.narration ?? null;
      const k = nn ? `${view.gameKey}:${nn.kind}:${nn.startedAt}` : '';
      if (k !== key) {
        key = k;
        n = nn;
        beats = nn ? narrationBeats(nn, name, view.result?.winner ?? null) : [];
        shown = -1;
      }
      clearTimeout(timer);
      timer = 0;
      tick();
    },
    // Küçük ipucu (aday, destek, oylama…). Anlatım sürerken gösterilmez.
    cue(icon, text, small = '') {
      cueEl.textContent = '';
      const b = document.createElement('b');
      b.textContent = `${icon} ${text}`;
      cueEl.append(b);
      if (small) {
        const s = document.createElement('small');
        s.textContent = small;
        cueEl.append(s);
      }
      cueEl.classList.remove('in');
      void cueEl.offsetWidth;
      cueEl.classList.add('in');
      cueUntil = Date.now() + 3800;
      el.dataset.cue = text;
      clearTimeout(timer);
      timer = 0;
      kick();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

// Ardışık iki görünümden oyun içi ipuçları (herkese açık alanlar). [icon, text, small][]
export function cuesBetween(prev, view, name) {
  if (!prev || prev.gameKey !== view.gameKey) return [];
  const out = [];
  const nom = view.nomination;
  const pnom = prev.nomination;
  if (view.phase === 'day' && nom && pnom?.expiresAt !== nom.expiresAt) {
    out.push(['☝️', `${name(nom.targetId)} aday gösterildi`, `${name(nom.byId)} gösterdi — biri desteklerse yargılama başlar.`]);
  }
  if (prev.phase === 'day' && view.phase === 'day' && pnom && !nom) {
    out.push(['⌛', 'Destek gelmedi', `${name(pnom.targetId)} adaylıktan düştü.`]);
  }
  if (prev.phase === 'day' && view.phase === 'trial' && view.trial) {
    const by = view.trial.supportById;
    out.push(['✋', by ? `${name(by)} destekledi → Yargılama!` : 'Destek geldi → Yargılama!', `⚖️ ${name(view.trial.targetId)} kendini savunuyor.`]);
  }
  if (prev.phase === 'trial' && view.phase === 'trialVote' && view.trial) {
    out.push(['🗳️', 'Oylama başladı', `${name(view.trial.targetId)} asılsın mı? Oylar gizli.`]);
  }
  return out;
}
