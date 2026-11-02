// 📸 Ne Zaman Nerede? — tek ve çok oyunculu ekranların ortak parçaları: fotoğraf kartı, yıl seçici, künye, sonuç satırı.
import { el } from '../ui.js';
import { fetchObjectUrl } from '../media.js';
import { YEAR_MAX, YEAR_MIN, fmtDy, fmtKm, setById } from '../whenwhere-math.js';
import { VIEWS } from './whenwhere-map.js';

export const HOW_TO = [
  'Eski bir fotoğraf görürsün. İki şeyi tahmin et: NEREDE çekildi ve NE ZAMAN?',
  '🗺️ Haritaya dokun, iğneyi koy; sürükleyerek düzelt. İki parmakla yakınlaştır/kaydır.',
  '📅 Yılı kaydırıcıyla seç; −10 / −1 / +1 / +10 düğmeleriyle ince ayar yap.',
  '🔒 Kilitle: tahminin gider, gerçek yer ve yıl açılır.',
  'Her tur en fazla 1000 puan: yer 500 + yıl 500. Ne kadar yakınsan o kadar çok.',
  'Dünya setinde doğru şehir ~450+ yer puanı; Türkiye setinde ölçek 10 kat, Eski İstanbul\'da sokak sokak (3 km).',
  'Yıl: tam isabet 500, 5 yıl şaşınca ~330, 20 yıl şaşınca ~95.',
  'Fotoğraflar Wikimedia Commons\'tan, özgür lisanslı; her turdan sonra yazarı ve lisansı gösterilir.',
];

export const viewOfSet = (setId) => VIEWS[setById(setId).scale] ?? VIEWS.world;

// Fotoğraf: /api/media/<jeton> kimlikle indirilir (blob:). Dokununca tam ekran (tekrar dokununca kapanır).
export function photoCard(mediaUrl, { onLoad } = {}) {
  const img = el('img', { class: 'ww-img', alt: 'Tahmin edilecek fotoğraf', draggable: 'false' });
  const status = el('div', { class: 'ww-img-status' }, '⏳ Fotoğraf yükleniyor…');
  const fig = el('figure', { class: 'ww-photo loading', title: 'Büyütmek için dokun' }, img, status);
  fig.addEventListener('click', () => {
    if (fig.classList.contains('loading')) return;
    fig.classList.toggle('full');
    document.body.classList.toggle('ww-noscroll', fig.classList.contains('full'));
  });
  let objectUrl = null;
  fetchObjectUrl(mediaUrl).then((u) => {
    objectUrl = u;
    img.onload = () => { fig.classList.remove('loading'); status.remove(); onLoad?.(); };
    img.onerror = () => { status.textContent = '⚠️ Fotoğraf açılamadı.'; };
    img.src = u;
  }).catch((err) => { status.textContent = `⚠️ ${err.message}`; fig.classList.add('failed'); });
  fig.release = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    document.body.classList.remove('ww-noscroll');
  };
  return fig;
}

// Büyük yıl göstergesi + kaydırıcı (1840–2020) + ince ayar düğmeleri.
export function yearPicker({ initial = 1930, onChange = () => {} } = {}) {
  let value = initial;
  const readout = el('output', { class: 'ww-year-out', 'aria-live': 'polite' }, String(value));
  const range = el('input', {
    type: 'range', min: String(YEAR_MIN), max: String(YEAR_MAX), step: '1', value: String(value), class: 'ww-year-range', 'aria-label': 'Yıl',
    oninput: (e) => set(Number(e.target.value)),
  });
  const set = (v) => {
    value = Math.min(YEAR_MAX, Math.max(YEAR_MIN, Math.round(v)));
    readout.textContent = String(value);
    if (Number(range.value) !== value) range.value = String(value);
    onChange(value);
  };
  const step = (d, label) => el('button', { type: 'button', class: 'btn ww-step', onclick: () => set(value + d), 'aria-label': `${label} yıl` }, label);
  const node = el('div', { class: 'ww-year' },
    el('div', { class: 'ww-year-row' }, step(-10, '−10'), step(-1, '−1'), readout, step(1, '+1'), step(10, '+10')),
    range,
    el('div', { class: 'ww-year-ends' }, el('span', {}, String(YEAR_MIN)), el('span', {}, String(YEAR_MAX))));
  return {
    node,
    value: () => value,
    set,
    disable() { for (const b of node.querySelectorAll('button, input')) b.disabled = true; },
  };
}

const link = (href, text) => (href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);

// Başlık + açıklama + Vikipedi + yazar/lisans (CC BY/BY-SA atıf şartı).
export function creditCard(r) {
  return el('section', { class: 'card ww-credit' },
    el('h2', {}, `📸 ${r.title}`),
    el('p', { class: 'ww-caption' }, r.caption),
    r.descEn ? el('p', { class: 'hint ww-desc' }, `Orijinal açıklama: “${r.descEn}”`) : null,
    el('p', { class: 'ww-links' },
      link(r.wikiUrl, '📖 Vikipedi\'de oku'), ' · ', link(r.fileUrl, '🖼️ Commons\'taki dosya')),
    el('p', { class: 'hint ww-attr' }, 'Fotoğraf: ', el('b', {}, r.author || 'Bilinmiyor'), ' · ', link(r.licenseUrl, r.license || 'Lisans'),
      ' · Wikimedia Commons'));
}

export const scoreClass = (s) => (s >= 800 ? 'good' : s >= 450 ? 'mid' : 'bad');

export function missText(r) {
  if (!r.guess) return 'Tahmin yok — süre doldu.';
  return `${fmtKm(r.km)} / ${fmtDy(r.dy)} şaştın`;
}

export function pointsLine(r) {
  return el('div', { class: 'ww-pts' },
    el('span', {}, '🗺️ Yer ', el('b', {}, String(r.place))),
    el('span', {}, '📅 Yıl ', el('b', {}, String(r.yearPts))),
    el('span', {}, r.guess ? `Tahminin: ${r.guess.year}` : '—'),
    el('span', {}, `Gerçek: ${r.truth.year}`));
}

// Oyuncu renkleri (çok oyunculu açıklama haritası); sıra oyuncu listesine göre sabit.
export const COLORS = ['#ff4d8d', '#3ee08f', '#4dabff', '#ffb547', '#b07bff', '#ff7a5c', '#2fd3c8', '#f5e04a', '#ff9de0', '#9be15d', '#c9a27b', '#e6e6e6'];
