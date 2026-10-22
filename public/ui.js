// Yeni modüllerin ortak küçük yardımcıları.

export const $ = (id) => document.getElementById(id);

// Kullanıcı verisi her zaman metin düğümü olarak eklenir (innerHTML yok).
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

let toastTimer;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// Sunucu saatine göre geri sayım; ekrandan kalkınca kendini durdurur.
export function countdown(endsAt, offsetMs, { onDone } = {}) {
  const node = el('span', { class: 'countdown' });
  const tick = () => {
    if (!node.isConnected && node.dataset.started) return;
    node.dataset.started = '1';
    const left = Math.max(0, endsAt - (Date.now() + offsetMs));
    const s = Math.ceil(left / 1000);
    node.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    node.classList.toggle('urgent', s <= 30);
    if (left <= 0) { onDone?.(); return; }
    setTimeout(tick, 250);
  };
  tick();
  return node;
}
