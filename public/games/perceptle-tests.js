// 👁️ Algıla — beş testin ekranları (canvas çizimi + girdi). Akış ve sunucu iletişimi perceptle.js'te.
// Her test: create(opts) → { node, stop(), value?() }  (value: şu anki cevap ya da null; lobide süre dolunca otomatik gönderim için); opts = { stim, friday, showMs, leadMs, timeScale, submit(answer) }.
// stim null olabilir (sayfa test sürerken yenilendi: zamanlı gösterim tekrar edilmez). Kurallar: PLAN.md §4.7.
import { el } from '../ui.js';
import { timeBar } from './recall-client.js';
import { FIELD, SPLIT_RANGE, angleError, samplePos, splitLabel, splitValue, tempoExpected } from '../perceptle-math.js';
import { audioContext, clickAt, unlockAudio } from './tone-audio.js';
import { fetchBitmap } from '../media.js';

const TAU = Math.PI * 2;
const INK = '#f3ecff';
const ACCENT = '#ffb547';
const PINK = '#ff4d8d';
const GOOD = '#3ee08f';
const DIM = '#ffffff33';

// Kesin çizimli (devicePixelRatio) canvas sahnesi. aspect = genişlik / yükseklik.
export function stage(cls, aspect) {
  const canvas = el('canvas', { class: 'pc-canvas', 'aria-hidden': 'true' });
  const node = el('div', { class: `pc-stage ${cls}` }, canvas);
  node.style.aspectRatio = String(aspect);
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let draw = () => {};
  const resize = () => {
    const r = canvas.getBoundingClientRect(); // kenarlık içi (dış kutu değil): keskin ve kaymasız
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  };
  const paint = () => { if (w) { ctx.clearRect(0, 0, w, h); draw(ctx, w, h); } };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(node);
  return {
    node,
    paint,
    setDraw(fn) { draw = fn; paint(); },
    size: () => ({ w, h }),
    destroy: () => ro?.disconnect(),
  };
}

const lockButton = (onclick, disabled = false) =>
  el('button', { type: 'button', class: 'btn big pc-lock rc-submit', disabled, onclick }, '🎯 Kilitle');

// Pointer (dokunma + fare) sürükleme: down/move/up, yakalama ile.
function dragOn(node, { down, move, up }) {
  let pid = null;
  node.addEventListener('pointerdown', (e) => {
    if (pid != null) return;
    e.preventDefault();
    pid = e.pointerId;
    try { node.setPointerCapture(pid); } catch { /* yok say */ }
    node.classList.add('active');
    down?.(e);
  });
  node.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move?.(e); });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    node.classList.remove('active');
    up?.(e);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

const local = (node, e) => {
  const r = (node.querySelector('canvas.pc-canvas') ?? node).getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
};

// ---------- 1. Say ----------
// Noktalar koordinat listesi olarak gelmez: sunucunun çizdiği PNG (stim.image, opak adres). Cuma'da alt alta
// stim.frames kare (stim.fps kare/sn) — gerçek zamana göre kare seçilir. Beyaz noktalar INK rengine boyanır.

const bitmaps = new Map(); // url -> Promise<ImageBitmap>
// Uyaran gelir gelmez görseli indirmeye başla (tek oyunculu bekler, lobide "Hazır ol…" sırasında iner).
export function preloadStimulus(stim) {
  if (!stim?.image) return Promise.resolve();
  let p = bitmaps.get(stim.image);
  if (!p) {
    p = fetchBitmap(stim.image);
    p.catch(() => bitmaps.delete(stim.image));
    bitmaps.set(stim.image, p);
    while (bitmaps.size > 4) bitmaps.delete(bitmaps.keys().next().value);
  }
  return p.then(() => {}, () => {});
}

function countTest({ stim, friday, showMs, timeScale, submit }) {
  const st = stage('pc-square', 1);
  const t0 = performance.now();
  let shown = Boolean(stim);
  let raf = 0;
  let sprite = null;
  if (stim?.image) {
    preloadStimulus(stim);
    bitmaps.get(stim.image)?.then((b) => { sprite = b; st.paint(); }, () => {});
  }
  st.setDraw((ctx, w) => {
    if (!shown || !sprite) return;
    const t = (performance.now() - t0) / timeScale / 1000;
    const size = stim.size;
    const f = friday && stim.frames > 1 ? Math.min(stim.frames - 1, Math.max(0, Math.round(t * stim.fps))) : 0;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sprite, 0, f * size, size, size, 0, 0, w, w);
    ctx.globalCompositeOperation = 'source-atop'; // sadece nokta piksellerini boya
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
  });
  const field = el('input', {
    type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '3', autocomplete: 'off',
    class: 'pc-num', placeholder: '?', 'aria-label': 'Kaç nokta vardı?', disabled: shown,
  });
  const lock = lockButton(() => send(), true);
  const send = () => {
    const v = field.value.replace(/[^0-9]/g, '');
    if (!v || field.disabled) return;
    lock.disabled = true;
    submit(Number(v));
  };
  field.addEventListener('input', () => {
    const clean = field.value.replace(/[^0-9]/g, '').slice(0, 3);
    if (clean !== field.value) field.value = clean;
    lock.disabled = !clean;
  });
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const ask = el('div', { class: 'pc-overlay pc-ask hidden' }, el('b', {}, 'Kaç nokta vardı?'));
  st.node.append(ask);
  const bar = shown ? timeBar(Date.now() + showMs, showMs) : null;
  const hide = () => {
    shown = false;
    cancelAnimationFrame(raf);
    st.paint();
    ask.classList.remove('hidden');
    bar?.remove();
    field.disabled = false;
    field.focus({ preventScroll: true });
  };
  let timer = 0;
  if (shown) {
    if (friday) {
      const loop = () => { st.paint(); if (shown) raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    timer = setTimeout(hide, showMs);
  } else {
    hide();
  }
  const node = el('section', { class: 'card pc-card' },
    st.node, bar,
    el('div', { class: 'pc-answer' }, field),
    lock);
  const value = () => { const v = field.value.replace(/[^0-9]/g, ''); return v && !field.disabled ? Number(v) : null; };
  return { node, value, stop() { clearTimeout(timer); cancelAnimationFrame(raf); st.destroy(); } };
}

// ---------- 2. Yörünge ----------

function drawField(ctx, w, h, friday) {
  const k = w / FIELD.w;
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.stroke();
  if (friday) {
    ctx.strokeStyle = PINK;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(2, 0); ctx.lineTo(2, h);
    ctx.moveTo(w - 2, 0); ctx.lineTo(w - 2, h);
    ctx.stroke();
  }
  return { X: (x) => x * k, Y: (y) => h - y * k };
}

// Yörünge sunucudan sadece örnek noktalar olarak gelir ([t, x, y]; atış parametreleri yok): [from, to] arası çizilir.
function drawPath(ctx, samples, X, Y, from, to, color, width = 3) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const a = samplePos(samples, from);
  ctx.moveTo(X(a.x), Y(a.y));
  for (const [t, x, y] of samples) if (t > from && t < to) ctx.lineTo(X(x), Y(y));
  const b = samplePos(samples, to);
  ctx.lineTo(X(b.x), Y(b.y));
  ctx.stroke();
}

function drawGuessX(ctx, X, h, gx, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(gx), 0);
  ctx.lineTo(X(gx), h);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(X(gx), h - 14);
  ctx.lineTo(X(gx) - 9, h);
  ctx.lineTo(X(gx) + 9, h);
  ctx.closePath();
  ctx.fill();
}

function trackTest({ stim, friday, showMs, timeScale, submit }) {
  const st = stage('pc-field', FIELD.w / FIELD.h);
  const t0 = performance.now();
  let flying = Boolean(stim);
  let guess = null;
  let raf = 0;
  st.setDraw((ctx, w, h) => {
    const { X, Y } = drawField(ctx, w, h, friday);
    if (stim) {
      const t = flying ? Math.min(stim.visible, (performance.now() - t0) / timeScale / 1000) : stim.visible;
      drawPath(ctx, stim.samples, X, Y, 0, t, flying ? ACCENT : '#ffb54799');
      if (flying) {
        const { x, y } = samplePos(stim.samples, t);
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(X(x), Y(y), FIELD.ball * (w / FIELD.w) + 2, 0, TAU);
        ctx.fill();
      }
    }
    if (guess != null) drawGuessX(ctx, X, h, guess, PINK);
  });
  const lock = lockButton(() => { if (guess != null) { lock.disabled = true; submit(Math.round(guess * 10) / 10); } }, true);
  const tip = el('div', { class: 'pc-overlay pc-tip hidden' }, 'Nereye düşecek? Dokun, istersen kaydır.');
  st.node.append(tip);
  st.node.setAttribute('tabindex', '0');
  st.node.setAttribute('aria-label', 'Topun düşeceği yer');
  const place = (e) => {
    if (flying) return;
    const p = local(st.node, e);
    guess = Math.min(FIELD.w, Math.max(0, (p.x / p.w) * FIELD.w));
    tip.classList.add('hidden');
    lock.disabled = false;
    st.paint();
  };
  dragOn(st.node, { down: place, move: place });
  st.node.addEventListener('keydown', (e) => {
    if (flying || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    guess = Math.min(FIELD.w, Math.max(0, (guess ?? 500) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 25 : 5)));
    lock.disabled = false;
    st.paint();
  });
  const land = () => { flying = false; cancelAnimationFrame(raf); tip.classList.remove('hidden'); st.paint(); };
  let timer = 0;
  if (flying) {
    const loop = () => { st.paint(); if (flying) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    timer = setTimeout(land, showMs);
  } else land();
  const node = el('section', { class: 'card pc-card' }, st.node, lock);
  const value = () => (guess == null ? null : Math.round(guess * 10) / 10);
  return { node, value, stop() { clearTimeout(timer); cancelAnimationFrame(raf); st.destroy(); } };
}

// ---------- 3. Açı ----------

const rad = (deg) => (deg * Math.PI) / 180;

// Açıyı çiz: 0° sağa, saat yönünün tersine. Cuma'da her tur bir halka dışarı (sarmal).
function drawAngle(ctx, w, h, value, { color = PINK, spiral = false, ray = true } = {}) {
  const cx = w / 2;
  const cy = h / 2;
  const R = w * 0.42;
  const r0 = w * 0.1;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const n = Math.max(2, Math.ceil(Math.abs(value) / 3));
  for (let i = 0; i <= n; i++) {
    const a = (value * i) / n;
    const r = spiral ? r0 + (Math.abs(a) / 360) * w * 0.07 : w * 0.14;
    const x = cx + Math.cos(rad(a)) * r;
    const y = cy - Math.sin(rad(a)) * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (ray) {
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad(value)) * R, cy - Math.sin(rad(value)) * R);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(rad(value)) * R, cy - Math.sin(rad(value)) * R, 9, 0, TAU);
    ctx.fill();
  }
}

function drawReference(ctx, w, h) {
  ctx.save();
  ctx.strokeStyle = '#ffffff88';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(w / 2, h / 2);
  ctx.lineTo(w / 2 + w * 0.46, h / 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 5, 0, TAU);
  ctx.fill();
}

function angleTest({ stim, friday, submit }) {
  const target = stim.target;
  // Rastgele başlangıç: hedefe en az 40° uzak
  let value;
  do value = Math.random() * 360; while (angleError(value, target, friday) < 40);
  let touched = false;
  let sent = false;
  let downAt = null; // sürükleme başı (kaza dokunuşu ayırt etmek için)
  let moved = 0;
  const st = stage('pc-square pc-dial', 1);
  st.setDraw((ctx, w, h) => {
    drawReference(ctx, w, h);
    drawAngle(ctx, w, h, value, { spiral: friday });
  });
  st.node.setAttribute('tabindex', '0');
  st.node.setAttribute('role', 'slider');
  st.node.setAttribute('aria-label', 'Açı (değer gizli)');
  const pointerAngle = (e) => {
    const p = local(st.node, e);
    const a = (Math.atan2(-(p.y - p.h / 2), p.x - p.w / 2) * 180) / Math.PI;
    return (a + 360) % 360;
  };
  const follow = (e) => {
    const a = pointerAngle(e);
    if (friday) {
      // sarım: mevcut değere en kısa yoldan ilerle (tam turlar birikir)
      const cur = ((value % 360) + 360) % 360;
      value += ((((a - cur) % 360) + 540) % 360) - 180;
    } else value = a;
    if (!touched) { touched = true; lock.disabled = false; }
    st.paint();
  };
  const send = () => {
    if (sent) return;
    sent = true;
    lock.disabled = true;
    submit(Math.round(value * 10) / 10);
  };
  dragOn(st.node, {
    down: (e) => { downAt = [e.clientX, e.clientY]; moved = 0; follow(e); },
    move: (e) => { if (downAt) moved = Math.max(moved, Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])); follow(e); },
    // Normal modda sadece gerçek sürükleme bırakılınca gönderilir; tek dokunuş yönü ayarlar, Kilitle ile gönderilir.
    up: () => { if (!friday && moved >= 15) send(); downAt = null; },
  });
  st.node.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 1 : -1);
    value = friday ? value + step : (((value + step) % 360) + 360) % 360;
    if (!touched) { touched = true; lock.disabled = false; }
    st.paint();
  });
  const lock = lockButton(send, true);
  const node = el('section', { class: 'card pc-card' },
    el('div', { class: 'pc-target' }, `${target}°`),
    st.node,
    el('p', { class: 'pc-note center' }, friday ? 'Tam turlar sayılır — döndürmeye devam et, sonra Kilitle.' : 'Sürükle; bıraktığında kilitlenir.'),
    lock);
  return { node, value: () => (touched ? Math.round(value * 10) / 10 : null), stop() { st.destroy(); } };
}

// ---------- 4. Ritim ----------

function tempoTest({ stim, friday, leadMs, timeScale, submit }) {
  const I = (60_000 / stim.bpm) * timeScale; // ölçekli vuruş aralığı (ms)
  const lastExpected = tempoExpected(stim.bpm, friday).at(-1) * timeScale;
  const taps = [];
  const timers = [];
  const pad = el('button', { type: 'button', class: 'pc-pad', 'aria-label': 'Vur' }, el('span', {}, '🥁'));
  const label = el('div', { class: 'pc-tempo-label' }, 'Hazır ol…');
  const dots = el('div', { class: 'pc-beats' }, Array.from({ length: 4 }, () => el('i', {})));
  let t0 = 0;
  let open = false;
  let done = false;
  const later = (fn, ms) => timers.push(setTimeout(fn, Math.max(0, ms)));

  const tap = (stamp) => {
    if (!open || done || taps.length >= 40 || stamp - t0 < -I / 2) return;
    taps.push(Math.round((stamp - t0) * 10) / 10);
    pad.classList.remove('hit');
    void pad.offsetWidth; // animasyonu yeniden başlat
    pad.classList.add('hit');
  };
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(e.timeStamp || performance.now()); });
  const onKey = (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) tap(e.timeStamp || performance.now());
  };
  document.addEventListener('keydown', onKey);

  const finish = () => {
    if (done) return;
    done = true;
    open = false;
    label.textContent = 'Tamam!';
    submit(taps);
  };

  // Ses: tıklar AudioContext zamanında planlanır; performance zamanına getOutputTimestamp ile bağlanır.
  unlockAudio();
  const ac = audioContext();
  t0 = performance.now() + leadMs;
  pad.dataset.t0 = String(t0);
  pad.dataset.beat = String(I);
  if (ac) {
    const ts = ac.getOutputTimestamp?.();
    const ok = ts && ts.performanceTime > 0;
    const toCtx = (perf) => (ok ? ts.contextTime + (perf - ts.performanceTime) / 1000 : ac.currentTime + (perf - performance.now()) / 1000);
    for (let k = 0; k < 4; k++) clickAt(toCtx(t0 + k * I), { accent: k === 0 });
  }
  for (let k = 0; k < 4; k++) {
    later(() => {
      if (k === 0) { open = true; label.textContent = 'Dinle — istersen birlikte vur'; }
      dots.children[k].classList.add('on');
      pad.classList.add('beat');
      later(() => pad.classList.remove('beat'), Math.min(140, I / 2));
    }, t0 - performance.now() + k * I);
  }
  open = true; // öncü sürede erken dokunuşlar da ısınma sayılır
  later(() => {
    label.textContent = friday ? '🤫 Şimdi vuruşların ARASINA vur!' : '🤫 Ses kesildi — ritmi sen sürdür!';
    label.classList.add('go');
    dots.classList.add('off');
  }, t0 - performance.now() + 3.5 * I);
  later(finish, t0 - performance.now() + lastExpected + Math.max(I, 400 * timeScale));

  const node = el('section', { class: 'card pc-card pc-tempo' },
    label, dots, pad,
    el('p', { class: 'pc-note center' }, 'Düğmeye dokun ya da Boşluk tuşuna bas.'));
  return {
    node,
    stop() {
      timers.forEach(clearTimeout);
      document.removeEventListener('keydown', onKey);
      done = true;
    },
  };
}

// ---------- 5. Böl ----------

function splitGeom(w, friday) {
  // Normal: çizgi genişliğin %8–92'si; Cuma: ortadaki %50 (dışarısı −0.5 … 1.5'e kadar ulaşılabilir)
  const a = friday ? w * 0.25 : w * 0.08;
  const b = friday ? w * 0.75 : w * 0.92;
  return { a, len: b - a, X: (v) => a + v * (b - a) };
}

function drawSplit(ctx, w, h, friday, marks) {
  const { a, len, X } = splitGeom(w, friday);
  const y = h * 0.55;
  if (friday) {
    ctx.save();
    ctx.strokeStyle = DIM;
    ctx.setLineDash([5, 7]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(4, y); ctx.lineTo(w - 4, y);
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a, y); ctx.lineTo(a + len, y);
  ctx.moveTo(a, y - 14); ctx.lineTo(a, y + 14);
  ctx.moveTo(a + len, y - 14); ctx.lineTo(a + len, y + 14);
  ctx.stroke();
  ctx.fillStyle = '#ffffff99';
  ctx.font = '600 13px Rubik, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('0', a, y + 32);
  ctx.fillText('1', a + len, y + 32);
  for (const { v, color } of marks) {
    const x = X(v);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y - 30); ctx.lineTo(x, y + 18);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - 34, 10, 0, TAU);
    ctx.fill();
  }
}

function splitTest({ stim, friday, submit }) {
  const target = splitValue(stim);
  const [lo, hi] = SPLIT_RANGE[friday ? 'friday' : 'normal'];
  let value;
  do value = lo + Math.random() * (hi - lo); while (Math.abs(value - target) < (friday ? 0.25 : 0.15));
  let touched = false;
  const st = stage('pc-line', 2.2);
  st.setDraw((ctx, w, h) => drawSplit(ctx, w, h, friday, [{ v: value, color: PINK }]));
  st.node.setAttribute('tabindex', '0');
  st.node.setAttribute('role', 'slider');
  st.node.setAttribute('aria-label', 'Çizgideki konum');
  const follow = (e) => {
    const p = local(st.node, e);
    const { a, len } = splitGeom(p.w, friday);
    value = Math.min(hi, Math.max(lo, (p.x - a) / len));
    touched = true;
    lock.disabled = false;
    st.paint();
  };
  dragOn(st.node, { down: follow, move: follow });
  st.node.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    value = Math.min(hi, Math.max(lo, value + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.02 : 0.002)));
    touched = true;
    lock.disabled = false;
    st.paint();
  });
  const lock = lockButton(() => { lock.disabled = true; submit(Math.round(value * 10000) / 10000); }, true);
  const node = el('section', { class: 'card pc-card' },
    el('div', { class: 'pc-target' }, splitLabel(stim)),
    st.node,
    el('p', { class: 'pc-note center' }, friday ? 'Nokta çizginin dışında olabilir — uzantıya da koyabilirsin.' : 'İşaretçiyi kaydır, sonra Kilitle.'),
    lock);
  return { node, value: () => (touched ? Math.round(value * 10000) / 10000 : null), stop() { st.destroy(); } };
}

export const TEST_UI = { count: countTest, track: trackTest, angle: angleTest, tempo: tempoTest, split: splitTest };

// ---------- Sonuç çizimleri (doğru cevap ve senin cevabın yan yana) ----------

// Yörüngede stim = sunucunun sonuç örnekleri { samples (tüm uçuş), visible, landing }.
export function revealView(test, stim, answer, friday) {
  if (!stim || answer == null) return null;
  if (test === 'track') {
    if (!stim.samples?.length || stim.landing == null) return null;
    const end = stim.samples.at(-1)[0];
    const st = stage('pc-field', FIELD.w / FIELD.h);
    st.setDraw((ctx, w, h) => {
      const { X, Y } = drawField(ctx, w, h, friday);
      drawPath(ctx, stim.samples, X, Y, 0, stim.visible, ACCENT);
      ctx.save();
      ctx.setLineDash([4, 6]);
      drawPath(ctx, stim.samples, X, Y, stim.visible, end, GOOD, 2);
      ctx.restore();
      drawGuessX(ctx, X, h, stim.landing, GOOD);
      drawGuessX(ctx, X, h, answer, PINK);
    });
    return st.node;
  }
  if (test === 'angle') {
    const st = stage('pc-square pc-small', 1);
    st.setDraw((ctx, w, h) => {
      drawReference(ctx, w, h);
      drawAngle(ctx, w, h, stim.target, { color: GOOD, spiral: friday });
      drawAngle(ctx, w, h, answer, { color: PINK, spiral: friday });
    });
    return st.node;
  }
  if (test === 'split') {
    const st = stage('pc-line', 2.2);
    st.setDraw((ctx, w, h) => drawSplit(ctx, w, h, friday, [{ v: splitValue(stim), color: GOOD }, { v: answer, color: PINK }]));
    return st.node;
  }
  return null;
}
