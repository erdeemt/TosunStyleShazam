// 🎨 Nüans — renk hafızası. Hedef renk birkaç saniye görünür, sonra HSB kaydırıcıları (veya hex) ile yeniden kurulur.
// Puan sunucuda (CIEDE2000). Ortak akış: recall-client.js. Kurallar: PLAN.md §4.4.
import { el } from '../ui.js';
import { hexToRgb, hsbToRgb, nuanceTier, normalizeHex, rgbToHex, rgbToHsb } from '../recall-math.js';
import { createRecallGame, secondsTimer, timeBar } from './recall-client.js';

const swatch = (hex, cls = '') => {
  const node = el('div', { class: `nu-swatch ${cls}`, role: 'img', 'aria-label': hex ? `Renk ${hex}` : 'Renk yok' });
  if (hex) node.style.background = hex;
  else node.classList.add('empty');
  return node;
};

function memorizeView(target, { endsAt, totalMs }) {
  const big = swatch(target, 'nu-target');
  big.append(el('span', { class: 'nu-count' }, secondsTimer(endsAt, { urgentAt: 1, suffix: '' })));
  return el('section', { class: 'card center nu-memo' },
    big,
    timeBar(endsAt, totalMs),
    el('p', { class: 'hint' }, 'Bu rengi aklına kazı — birazdan kaybolacak!'));
}

// HSB kaydırıcıları + canlı önizleme + hex kutusu (iki yönlü bağlı). Her turda rastgele başlar.
function createInput() {
  let hsb = { h: Math.random() * 360, s: 20 + Math.random() * 80, b: 20 + Math.random() * 80 };
  const hex = () => rgbToHex(hsbToRgb(hsb.h, hsb.s, hsb.b));

  const preview = swatch(hex(), 'nu-preview');
  const hexInput = el('input', {
    type: 'text', class: 'nu-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    'aria-label': 'Hex renk kodu', inputmode: 'text',
  });
  const slider = (key, max, label, unit) => {
    const value = el('span', { class: 'nu-val' });
    const range = el('input', { type: 'range', min: '0', max: String(max), step: 'any', class: `nu-range nu-${key}`, 'aria-label': label });
    range.addEventListener('input', () => {
      hsb = { ...hsb, [key]: Number(range.value) };
      sync({ fromHex: false });
    });
    return { key, range, value, unit, node: el('label', { class: 'nu-slider' }, el('span', { class: 'nu-label' }, label, value), range) };
  };
  const sliders = [slider('h', 360, 'Ton', '°'), slider('s', 100, 'Doygunluk', ''), slider('b', 100, 'Parlaklık', '')];

  function paintTracks() {
    const [, sR, bR] = sliders.map((s) => s.range);
    const css = (h, s, b) => rgbToHex(hsbToRgb(h, s, b));
    sR.style.background = `linear-gradient(90deg, ${css(hsb.h, 0, hsb.b)}, ${css(hsb.h, 100, hsb.b)})`;
    bR.style.background = `linear-gradient(90deg, #000000, ${css(hsb.h, hsb.s, 100)})`;
  }

  function sync({ fromHex }) {
    const h = hex();
    preview.style.background = h;
    if (!fromHex) hexInput.value = h.toUpperCase();
    for (const s of sliders) {
      if (fromHex) s.range.value = String(hsb[s.key]);
      s.value.textContent = `${Math.round(hsb[s.key])}${s.unit}`;
    }
    paintTracks();
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

  for (const s of sliders) s.range.value = String(hsb[s.key]);
  sync({ fromHex: false });

  const node = el('section', { class: 'card nu-input' },
    el('div', { class: 'nu-top' }, preview, el('div', { class: 'nu-hexbox' }, el('span', { class: 'hint' }, 'Hex'), hexInput)),
    ...sliders.map((s) => s.node));
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
  verbs: { start: 'Başla', show: 'Rengi göster', submit: '🎨 Rengimi gönder', memorize: 'Ezberle!', recall: 'Şimdi yeniden oluştur!' },
  howTo: [
    'Her turda bir renk birkaç saniye ekranda kalır, sonra kaybolur.',
    'Ton, Doygunluk ve Parlaklık kaydırıcılarıyla (ya da hex kodunu yazarak) aynı rengi yeniden oluştur.',
    '30 saniyen var; süre bitince o anki rengin kendiliğinden gönderilir.',
    'Puan, gözün farkı ne kadar algıladığına göre (CIEDE2000): birebir aynı renk 1000, uzaklaştıkça hızla düşer.',
    '5 turun ortalaması sonucun: Acemi · Orta · İyi · Uzman · Elit.',
  ],
  readyHint: (g) => `Her turda renk ${Math.round(g.memorizeMs / 1000) || 1} sn görünecek, sonra ${Math.round(g.recallMs / 1000)} sn içinde yeniden oluşturacaksın.`,
  memorizeView,
  createInput,
  answerChip,
  roundDetail,
  formatScore: (s) => String(s),
  formatTotal,
  shareText: ({ mode, puzzleNo, total }) => `${mode === 'daily' ? `Tosun Nüans #${puzzleNo}` : 'Tosun Nüans (sınırsız)'} · ${total}/1000 (${nuanceTier(total)})`,
});

export const enter = game.enter;
export const leave = game.leave;
