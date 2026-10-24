// Ton Avı görseli: siyah sahnede dikey, iç içe geçen parlak dalga şeritleri (canvas).
// level (0–1, perde) yükseldikçe dalgalar sıklaşır ve hızlanır; active iken parlar. Ses yok, sadece çizim.
import { el } from '../ui.js';

const LINES = 12;
const COLORS = [[45, 212, 191], [59, 130, 246], [139, 92, 246]]; // turkuaz → mavi → mor

const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
const colorAt = (f) => (f < 0.5 ? mix(COLORS[0], COLORS[1], f * 2) : mix(COLORS[1], COLORS[2], (f - 0.5) * 2));

// { node, setLevel(0–1), setActive(bool) }. Döngü düğüm sayfadan çıkınca kendiliğinden durur.
export function createWave({ level = 0.4, active = false } = {}) {
  const canvas = el('canvas', { class: 'tn-wave', 'aria-hidden': 'true' });
  const g = canvas.getContext('2d');
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let target = level;
  let shown = level;
  let glow = active ? 1 : 0;
  let on = active;
  let time = Math.random() * 100;
  let last = performance.now();
  let away = 0; // sayfada olmadan geçen süre (ms)
  let w = 0;
  let h = 0;

  function fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    if (cw !== w || ch !== h) {
      w = cw;
      h = ch;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return true;
  }

  function draw() {
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    const cx = w / 2;
    const cycles = 1.4 + shown * 7; // sahne boyunca kaç dalga
    const ky = (Math.PI * 2 * cycles) / h;
    const tau = time * (0.9 + shown * 2.6);
    const step = 4;
    for (const pass of [0, 1]) {
      g.lineWidth = pass ? 1.3 : 7;
      for (let k = 0; k < LINES; k++) {
        const f = k / (LINES - 1);
        const [r, gg, b] = colorAt(f);
        const alpha = pass ? 0.35 + 0.4 * glow : 0.035 + 0.05 * glow;
        g.strokeStyle = `rgba(${r},${gg},${b},${alpha})`;
        const phi = k * 0.42;
        g.beginPath();
        for (let y = -step; y <= h + step; y += step) {
          // Zarf: şerit boyunca şişip daralan genlik (DNA benzeri bükülme)
          const env = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((y / h) * Math.PI * 2.2 + time * 0.5 + f * 1.4));
          const amp = w * (0.2 + 0.12 * glow) * env;
          const x = cx + amp * Math.sin(y * ky - tau + phi) * (0.55 + 0.45 * Math.cos(phi * 1.7 + time * 0.35));
          if (y === -step) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  }

  function frame(now) {
    const dt = Math.min(80, now - last);
    last = now;
    if (!canvas.isConnected) {
      away += dt;
      // Lobi aynı düğümü yeniden takabilir; bir süre bekle, gelmezse dur.
      if (away < 3000) setTimeout(() => frame(performance.now()), 250);
      return;
    }
    away = 0;
    time += (dt / 1000) * (calm ? 0.25 : 1);
    shown += (target - shown) * Math.min(1, dt / 90);
    glow += ((on ? 1 : 0) - glow) * Math.min(1, dt / 160);
    if (fit()) draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    node: canvas,
    setLevel(v) { target = Math.min(1, Math.max(0, v)); },
    setActive(v) { on = Boolean(v); },
  };
}
