// 🎨 Nüans — renk hafızası. Hedef renk birkaç saniye görünür, sonra HSB yay kadranları (veya hex) ile yeniden kurulur.
// Puan sunucuda (CIEDE2000). Ortak akış: recall-client.js. Kurallar: PLAN.md §4.4.
import { el } from '../ui.js';
import { hexToRgb, hsbToRgb, nuanceTier, normalizeHex, rgbToHex, rgbToHsb } from '../recall-math.js';
import { createRecallGame, secondsTimer, timeBar } from './recall-client.js';
import { fetchObjectUrl } from '../media.js';

const swatch = (hex, cls = '') => {
  const node = el('div', { class: `nu-swatch ${cls}`, role: 'img', 'aria-label': hex ? `Renk ${hex}` : 'Renk yok' });
  if (hex) node.style.background = hex;
  else node.classList.add('empty');
  return node;
};

// Hedef hex JSON'da yok: sunucu küçük, hafif gürültülü bir PNG verir (opak, tek kullanımlık adres); büyütülüp gösterilir.
const images = new Map(); // url -> Promise<blob: adresi>
function prepareMedia(url) {
  let p = images.get(url);
  if (!p) {
    p = fetchObjectUrl(url);
    p.catch(() => images.delete(url));
    images.set(url, p);
    while (images.size > 4) {
      const [old, op] = images.entries().next().value;
      images.delete(old);
      op.then((u) => URL.revokeObjectURL(u), () => {});
    }
  }
  return p;
}

function memorizeView(target, { endsAt, totalMs, media }) {
  const big = swatch(target, 'nu-target nu-disc');
  if (!target && media) {
    big.classList.remove('empty');
    big.classList.add('nu-img');
    big.setAttribute('aria-label', 'Hedef renk');
    const img = el('img', { class: 'nu-target-img', alt: '', draggable: 'false' });
    big.prepend(img);
    prepareMedia(media).then((u) => { img.src = u; }).catch(() => big.classList.add('empty'));
  }
  big.append(el('span', { class: 'nu-count' }, secondsTimer(endsAt, { urgentAt: 1, suffix: '' })));
  return el('section', { class: 'card center nu-memo nu-card' },
    big,
    timeBar(endsAt, totalMs),
    el('p', { class: 'hint' }, 'Bu rengi aklına kazı — birazdan kaybolacak!'));
}

// Yay kadran: 270°lik halka (alt kısmı açık), parmakla döndürülür. Erişilebilirlik ve klavye için içinde
// görünmez bir range girdisi var (.nu-range .nu-h/s/b); kadran onu sürer, o da değeri tutar.
const ARC_FROM = 225; // derece, saat yönünde tepeden (sol alt)
const ARC_SWEEP = 270;

function knob(key, max, label, onInput) {
  const range = el('input', { type: 'range', min: '0', max: String(max), step: 'any', class: `nu-range nu-${key}`, 'aria-label': label });
  const thumb = el('span', { class: 'nu-thumb' });
  const ring = el('div', { class: 'nu-ring' });
  const dial = el('div', { class: 'nu-dial' }, ring, thumb);
  const value = el('b', { class: 'nu-val' });
  let pid = null;

  const setFromEvent = (e) => {
    const r = dial.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const ang = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = tepe, saat yönü
    let rel = (((ang - ARC_FROM) % 360) + 360) % 360;
    if (rel > ARC_SWEEP) rel = rel > ARC_SWEEP + (360 - ARC_SWEEP) / 2 ? 0 : ARC_SWEEP; // alttaki boşluk: en yakın uç
    range.value = String((rel / ARC_SWEEP) * max);
    onInput();
  };
  dial.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pid = e.pointerId;
    try { dial.setPointerCapture(pid); } catch { /* yok say */ }
    dial.classList.add('active');
    setFromEvent(e);
  });
  dial.addEventListener('pointermove', (e) => { if (e.pointerId === pid) setFromEvent(e); });
  const end = (e) => { if (e.pointerId === pid) { pid = null; dial.classList.remove('active'); } };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  range.addEventListener('input', onInput);

  return {
    key, range, ring,
    node: el('div', { class: 'nu-knob' }, dial, range, el('small', {}, label), value),
    show(v) {
      const a = ((ARC_FROM + (v / max) * ARC_SWEEP) * Math.PI) / 180;
      thumb.style.left = `${50 + 41 * Math.sin(a)}%`;
      thumb.style.top = `${50 - 41 * Math.cos(a)}%`;
      value.textContent = String(Math.round(v));
    },
  };
}

// Halka rengi: başlangıçtan bitişe conic-gradient, alttaki 90° boş.
const arc = (stops) => `conic-gradient(from ${ARC_FROM}deg, ${stops.map((c, i) => `${c} ${(i / (stops.length - 1)) * ARC_SWEEP}deg`).join(', ')}, transparent ${ARC_SWEEP}deg)`;

// Büyük daire önizleme + 3 yay kadran (ton/doygunluk/parlaklık) + hex kutusu (iki yönlü bağlı). Her turda rastgele başlar.
function createInput({ submit } = {}) {
  let hsb = { h: Math.random() * 360, s: 20 + Math.random() * 80, b: 20 + Math.random() * 80 };
  const hex = () => rgbToHex(hsbToRgb(hsb.h, hsb.s, hsb.b));
  const css = (h, s, b) => rgbToHex(hsbToRgb(h, s, b));

  const preview = swatch(hex(), 'nu-preview nu-disc');
  preview.append(el('span', { class: 'nu-aim', 'aria-hidden': 'true' }));
  const hexInput = el('input', {
    type: 'text', class: 'nu-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    'aria-label': 'Hex renk kodu', inputmode: 'text',
  });
  const knobs = [
    knob('h', 360, 'TON', () => { hsb = { ...hsb, h: Number(knobs[0].range.value) }; sync({ fromHex: false }); }),
    knob('s', 100, 'DOY', () => { hsb = { ...hsb, s: Number(knobs[1].range.value) }; sync({ fromHex: false }); }),
    knob('b', 100, 'PAR', () => { hsb = { ...hsb, b: Number(knobs[2].range.value) }; sync({ fromHex: false }); }),
  ];
  knobs[0].ring.style.background = arc(['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000']);

  function sync({ fromHex }) {
    const h = hex();
    preview.style.background = h;
    if (!fromHex) hexInput.value = h.toUpperCase();
    knobs[1].ring.style.background = arc([css(hsb.h, 0, hsb.b), css(hsb.h, 100, hsb.b)]);
    knobs[2].ring.style.background = arc(['#000000', css(hsb.h, hsb.s, 100)]);
    for (const k of knobs) {
      if (fromHex) k.range.value = String(hsb[k.key]);
      k.show(hsb[k.key]);
    }
  }

  hexInput.addEventListener('input', () => {
    const raw = hexInput.value.trim();
    const norm = normalizeHex(raw);
    hexInput.classList.toggle('bad', !norm && raw.replace('#', '').length >= 6);
    if (!norm) return;
    const next = rgbToHsb(...hexToRgb(norm));
    // Gri/siyahta ton (ve siyahta doygunluk) tanımsız: önceki değer kalsın, kaydırınca renk kırmızıya kaymasın.
    if (next.s === 0) next.h = hsb.h;
    if (next.b === 0) { next.h = hsb.h; next.s = hsb.s; }
    hsb = next;
    sync({ fromHex: true });
  });
  hexInput.addEventListener('blur', () => { hexInput.classList.remove('bad'); hexInput.value = hex().toUpperCase(); });

  for (const k of knobs) k.range.value = String(hsb[k.key]);
  sync({ fromHex: false });

  const node = el('section', { class: 'card nu-input nu-card' },
    preview,
    el('div', { class: 'nu-knobs' }, knobs.map((k) => k.node)),
    el('label', { class: 'nu-hexbox' }, el('span', { class: 'hint' }, 'Hex'), hexInput),
    el('button', { class: 'btn big nu-lock rc-submit', onclick: () => submit?.() }, '🎯 Kilitle'));
  return { node, value: hex };
}

function answerChip(guess, { big, mini, isTarget } = {}) {
  if (mini) return swatch(guess, 'nu-mini');
  return el('span', { class: `nu-chip${big ? ' big' : ''}` }, swatch(guess, 'nu-chipsw'),
    el('code', {}, guess ? guess.toUpperCase() : isTarget ? '' : 'cevap yok'));
}

function roundDetail({ round, target, guess, score, timedOut }, { big } = {}) {
  return el('div', { class: `nu-round${big ? ' big' : ''}` },
    big ? null : el('span', { class: 'nu-rn' }, `${round + 1}`),
    el('div', { class: 'nu-pair' },
      el('figure', {}, swatch(target, 'nu-psw'), el('figcaption', {}, 'Hedef', el('code', {}, target.toUpperCase()))),
      el('figure', {}, swatch(guess, 'nu-psw'), el('figcaption', {}, 'Sen', el('code', {}, guess ? guess.toUpperCase() : timedOut ? 'süre doldu' : '—')))),
    el('b', { class: 'nu-score' }, String(score), big ? el('small', {}, ' / 1000') : null));
}

const formatTotal = (total, { short } = {}) => (short ? `${total}` : `${total}/1000 · ${nuanceTier(total)}`);

const game = createRecallGame({
  id: 'nuance',
  name: 'Nüans',
  icon: '🎨',
  rootId: 'game-nuance',
  difficulties: [
    { id: 'normal', label: 'Normal', hint: '5 sn ezber' },
    { id: 'expert', label: 'Uzman', hint: '2 sn ezber' },
  ],
  dailyDifficulty: 'normal',
  verbs: { start: 'Başla', show: 'Rengi göster', submit: '🎯 Kilitle', memorize: 'Ezberle!', recall: 'Şimdi yeniden oluştur!' },
  howTo: [
    'Her turda bir renk birkaç saniye ekranda kalır, sonra kaybolur.',
    'Ton, Doygunluk ve Parlaklık kadranlarını parmağınla çevirerek (ya da hex kodunu yazarak) aynı rengi yeniden oluştur, sonra "Kilitle".',
    '30 saniyen var; süre bitince o anki rengin kendiliğinden gönderilir.',
    'Puan, gözün farkı ne kadar algıladığına göre (CIEDE2000): birebir aynı renk 1000, uzaklaştıkça hızla düşer.',
    '5 turun ortalaması sonucun: Acemi · Orta · İyi · Uzman · Elit.',
  ],
  readyHint: (g) => `Her turda renk ${Math.round(g.memorizeMs / 1000) || 1} sn görünecek, sonra ${Math.round(g.recallMs / 1000)} sn içinde yeniden oluşturacaksın.`,
  memorizeView,
  prepareMedia,
  createInput,
  answerChip,
  roundDetail,
  formatScore: (s) => String(s),
  formatTotal,
  inlineSubmit: true,
  shareText: ({ mode, puzzleNo, total }) => `${mode === 'daily' ? `Tosun Nüans #${puzzleNo}` : 'Tosun Nüans (sınırsız)'} · ${total}/1000 (${nuanceTier(total)})`,
});

export const enter = game.enter;
export const leave = game.leave;
