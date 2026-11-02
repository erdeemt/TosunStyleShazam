// 📸 Ne Zaman Nerede? — harita (Leaflet 1.9.4, public/vendor/leaflet, BSD-2) + OpenStreetMap karoları.
// Tahmin haritası: dokun → iğne, sürükle → düzelt, iki parmakla yakınlaştır/kaydır. Açıklama haritası: iğneler + gerçek yer + çizgiler.
// Leaflet sadece bu oyun açılınca yüklenir (script + css, CSP 'self'). Karolar: tile.openstreetmap.org (CSP img-src'de sadece o).
import { el } from '../ui.js';
import { wrapLon } from '../whenwhere-math.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> katkıcıları';

// Setin başlangıç görünümü (İstanbul'da sokak seviyesine kadar inilebilir).
export const VIEWS = {
  world: { center: [30, 15], zoom: 1 },
  turkiye: { center: [39.1, 35.2], zoom: 5 },
  istanbul: { center: [41.03, 28.99], zoom: 11 },
};

let loading = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet]')) {
      document.head.append(el('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css', 'data-leaflet': '1' }));
    }
    const s = el('script', { src: '/vendor/leaflet/leaflet.js' });
    s.onload = () => (window.L ? resolve(window.L) : reject(new Error('Harita yüklenemedi.')));
    s.onerror = () => { loading = null; reject(new Error('Harita yüklenemedi.')); };
    document.head.append(s);
  });
  return loading;
}

function baseMap(L, node, view) {
  const map = L.map(node, {
    center: view.center,
    zoom: view.zoom,
    minZoom: 1,
    maxZoom: 18,
    worldCopyJump: true,
    zoomControl: true,
    attributionControl: true,
    tapTolerance: 12,
    maxBounds: [[-88, -540], [88, 540]],
    maxBoundsViscosity: 0.8,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, crossOrigin: false }).addTo(map);
  return map;
}

// İğne: renkli damla + (varsa) ad etiketi. Ad metin düğümü olarak eklenir (innerHTML yok).
function pinIcon(L, { color = '#ff4d8d', label = '', kind = 'guess' } = {}) {
  const node = el('div', { class: `ww-pin ww-pin-${kind}` },
    el('span', { class: 'ww-pin-dot', style: `--c:${color}` }, kind === 'truth' ? '📍' : ''),
    label ? el('span', { class: 'ww-pin-label' }, label) : null);
  return L.divIcon({ html: node, className: 'ww-pin-wrap', iconSize: [0, 0], iconAnchor: [0, 0] });
}

// Tahmin haritası. onChange({ lat, lon }) iğne her değiştiğinde. Dönen: { pin(), setPin(), lock(), destroy(), node }
export function guessMap(node, { view = VIEWS.world, initial = null, onChange = () => {} } = {}) {
  let map = null;
  let marker = null;
  let locked = false;
  let pin = initial;
  const set = (L, latlng) => {
    pin = { lat: latlng.lat, lon: wrapLon(latlng.lng) };
    if (!marker) {
      marker = L.marker(latlng, { icon: pinIcon(L, { kind: 'me' }), draggable: !locked, keyboard: false, autoPan: true }).addTo(map);
      marker.on('dragend', () => { set(L, marker.getLatLng()); });
    } else marker.setLatLng(latlng);
    onChange(pin);
  };
  const ready = loadLeaflet().then((L) => {
    map = baseMap(L, node, view);
    if (initial) set(L, { lat: initial.lat, lng: initial.lon });
    map.on('click', (e) => { if (!locked) set(L, e.latlng); });
    // Kapsayıcı boyutu yerleşince (ilk çizim sonrası) yeniden ölç.
    requestAnimationFrame(() => map?.invalidateSize());
    setTimeout(() => map?.invalidateSize(), 300);
    return map;
  });
  return {
    node,
    ready,
    pin: () => pin,
    lock() {
      locked = true;
      marker?.dragging?.disable();
    },
    invalidate: () => map?.invalidateSize(),
    destroy() { map?.remove(); map = null; marker = null; },
  };
}

// Açıklama haritası: pins [{ lat, lon, color, label, me }], truth { lat, lon }. Hepsi görünecek şekilde sığdırır.
export function revealMap(node, { pins = [], truth, view = VIEWS.world }) {
  let map = null;
  const ready = loadLeaflet().then((L) => {
    map = baseMap(L, node, view);
    const t = L.latLng(truth.lat, truth.lon);
    const pts = [t];
    for (const p of pins) {
      // Çizgi kısa yoldan gitsin: tahmin boylamını gerçeğe en yakın kopyaya taşı.
      let lon = p.lon;
      while (lon - truth.lon > 180) lon -= 360;
      while (truth.lon - lon > 180) lon += 360;
      const ll = L.latLng(p.lat, lon);
      pts.push(ll);
      L.polyline([ll, t], { color: p.color, weight: p.me ? 3 : 2, opacity: 0.85, dashArray: p.me ? null : '6 6' }).addTo(map);
      L.marker(ll, { icon: pinIcon(L, { color: p.color, label: p.label, kind: p.me ? 'me' : 'other' }), keyboard: false, zIndexOffset: p.me ? 500 : 0 }).addTo(map);
    }
    L.marker(t, { icon: pinIcon(L, { kind: 'truth', label: 'Burası' }), keyboard: false, zIndexOffset: 1000 }).addTo(map);
    const fit = () => {
      if (!map) return;
      map.invalidateSize();
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 15 });
      else map.setView(t, Math.max(view.zoom, 12));
    };
    requestAnimationFrame(fit);
    setTimeout(fit, 300);
    return map;
  });
  return { node, ready, destroy() { map?.remove(); map = null; } };
}
