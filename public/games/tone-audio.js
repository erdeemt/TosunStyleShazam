// Ton Avı sesi: Web Audio sinüs osilatörü (ses dosyası yok). Tıklama olmasın diye 30 ms açılış/kapanış rampası.
// Ses seviyesi localStorage 'tss:volume' (0–1, varsayılan 0.6).

const FADE = 0.03; // sn
const PEAK = 0.28; // tam ses seviyesinde bile kulak tırmalamasın

let ctx = null;
const live = new Set(); // çalan { osc, gain }

function audioCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

function volume() {
  try {
    const v = parseFloat(localStorage.getItem('tss:volume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
  } catch {
    return 0.6;
  }
}

// Kullanıcı dokunuşunda çağrılır: tarayıcı sesi ancak bir etkileşimden sonra açar.
export function unlockAudio() {
  const c = audioCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export const audioReady = () => Boolean(ctx && ctx.state === 'running');

function voice(freq) {
  const c = audioCtx();
  if (!c) return null;
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const gain = c.createGain();
  const t = c.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(PEAK * volume(), t + FADE);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  const v = { osc, gain };
  live.add(v);
  osc.onended = () => { live.delete(v); osc.disconnect(); gain.disconnect(); };
  return v;
}

function release(v) {
  if (!v || !live.has(v)) return;
  const t = ctx.currentTime;
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setValueAtTime(v.gain.gain.value, t);
  v.gain.gain.linearRampToValueAtTime(0, t + FADE);
  try { v.osc.stop(t + FADE + 0.02); } catch { /* zaten durdu */ }
}

// Sabit süreli ton (ms). Dönen fonksiyon erken durdurur.
export function playTone(freq, ms) {
  const v = voice(freq);
  if (!v) return () => {};
  const t = ctx.currentTime;
  const end = t + Math.max(2 * FADE, ms / 1000);
  v.gain.gain.setValueAtTime(PEAK * volume(), end - FADE);
  v.gain.gain.linearRampToValueAtTime(0, end);
  v.osc.stop(end + 0.02);
  return () => release(v);
}

// Zor mod hedefi: sunucunun ürettiği WAV (Hz JSON'da yok). Rampalar dosyada; seviye osilatörle aynı olsun diye
// kazanç PEAK·ses / dosya genliği (server/media-encode.js TONE_AMPLITUDE).
const WAV_AMPLITUDE = 0.9;

export async function decodeAudio(blob) {
  const c = audioCtx();
  if (!c) throw new Error('Tarayıcı sesi desteklemiyor.');
  const data = await blob.arrayBuffer();
  // Eski Safari: sadece geri çağırmalı biçim
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// buffer'ı offsetMs'ten çal (ses kilidi geç açıldıysa kalan kısım; ortadan başlarken kısa açılış rampası).
export function playBuffer(buffer, offsetMs = 0) {
  const c = audioCtx();
  if (!c || !buffer) return () => {};
  const src = c.createBufferSource();
  src.buffer = buffer;
  const gain = c.createGain();
  const t = c.currentTime;
  const level = (PEAK * volume()) / WAV_AMPLITUDE;
  if (offsetMs > 0) {
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + FADE);
  } else gain.gain.setValueAtTime(level, t);
  src.connect(gain).connect(c.destination);
  src.start(t, Math.max(0, offsetMs / 1000));
  const v = { osc: src, gain };
  live.add(v);
  src.onended = () => { live.delete(v); src.disconnect(); gain.disconnect(); };
  return () => release(v);
}

// Parmak basılıyken çalan ton: set(freq) ile kayar, stop() ile söner.
export function startLive(freq) {
  const v = voice(freq);
  return {
    set(f) { if (v) v.osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.012); },
    stop() { release(v); },
  };
}

export function stopAll() {
  for (const v of [...live]) release(v);
}

// Ritim testi (👁️ Algıla) için kısa tık sesi; AudioContext zamanında planlanır.
export const audioContext = () => audioCtx();

export function clickAt(when, { accent = false } = {}) {
  const c = audioCtx();
  if (!c) return;
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = accent ? 1760 : 1320;
  const gain = c.createGain();
  const t = Math.max(c.currentTime, when);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(Math.max(0.0002, 0.9 * volume()), t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.09);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
