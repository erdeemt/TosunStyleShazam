// 🔊 Ton Avı — perde hafızası. Sinüs tonu 3 sn çalar (tekrar dinlenemez); sonra dikey pedde parmağınla
// aynı perdeyi bulursun. Puan sunucuda (sent farkı). Ortak akış: recall-client.js. Kurallar: PLAN.md §4.5.
import { el } from '../ui.js';
import { TONE_RANGES, centsBetween, centsHint, freqAt } from '../recall-math.js';
import { createRecallGame, secondsTimer, timeBar } from './recall-client.js';
import { audioReady, decodeAudio, playBuffer, playTone, startLive, stopAll, unlockAudio } from './tone-audio.js';
import { fetchMedia } from '../media.js';
import { createWave } from './tone-wave.js';

let memoKey = '';
let memoStop = null;
let replayStop = null;

function stopSound() {
  memoStop?.();
  memoStop = null;
  replayStop?.();
  replayStop = null;
}

function replay(freq) {
  unlockAudio();
  replayStop?.();
  replayStop = playTone(freq, 1500);
}

const hz = (f) => `${f >= 1000 ? Math.round(f) : f.toFixed(1).replace(/\.0$/, '')} Hz`;

// Siyah sahne + dalga. Ezberde dalga hedef perdeden bağımsız (gözle eşleştirilmesin, kulak oyunu).
function scene(extraClass, ...children) {
  const wave = createWave({ level: 0.35, active: true });
  return { wave, node: el('div', { class: `tn-stage ${extraClass}` }, wave.node, ...children) };
}

// Zor mod: hedef Hz JSON'da yok; sunucunun WAV'ı (opak, tek kullanımlık adres) indirilip çözülür. Adres başına bir kez.
const decoded = new Map(); // url -> Promise<AudioBuffer>
function prepareMedia(url) {
  let p = decoded.get(url);
  if (!p) {
    p = fetchMedia(url).then(decodeAudio);
    p.catch(() => decoded.delete(url));
    decoded.set(url, p);
    while (decoded.size > 4) decoded.delete(decoded.keys().next().value);
  }
  return p;
}

// Hedef ton bu ekranda bir kez çalar. Ses kilitliyse (tarayıcı dokunuş istemiş) bir düğmeyle kalan süre çalınır.
// target: Hz (Kolay) ya da null + media: WAV adresi (Zor).
function memorizeView(target, { endsAt, totalMs, key, media }) {
  let buffer = null;
  let wantPlay = false;
  if (target == null && media) {
    prepareMedia(media).then((b) => { buffer = b; if (wantPlay) play(); }).catch(() => {});
  }
  const play = () => {
    const left = endsAt - Date.now();
    if (left < 120) return;
    memoStop?.();
    if (target != null) { memoStop = playTone(target, left); return; }
    if (!buffer) { wantPlay = true; return; } // indirilince çalar
    wantPlay = false;
    memoStop = playBuffer(buffer, Math.max(0, buffer.duration * 1000 - left));
  };
  const overlay = el('div', { class: 'tn-overlay' });
  const { node } = scene('tn-orb tn-memo', overlay);
  const fill = () => {
    overlay.replaceChildren(
      el('div', { class: 'tn-listen' }, 'Dinle… ', secondsTimer(endsAt, { urgentAt: 0 })),
      el('p', { class: 'tn-note' }, 'Bu perdeyi aklında tut — bir daha çalmayacak!'));
  };
  const card = el('section', { class: 'card tn-card' }, node, timeBar(endsAt, totalMs));
  if (memoKey !== key) {
    if (audioReady()) {
      memoKey = key;
      play();
      fill();
    } else {
      unlockAudio();
      // Bazı tarayıcılar resume'u hemen yapar; kısa bir bekleyişten sonra tekrar dene, olmazsa düğme göster.
      overlay.append(el('button', {
        class: 'btn big tn-lock',
        onclick: () => { unlockAudio(); memoKey = key; setTimeout(play, 30); fill(); },
      }, '🔊 Sesi aç ve dinle'));
      setTimeout(() => { if (memoKey !== key && audioReady() && card.isConnected) { memoKey = key; play(); fill(); } }, 80);
    }
  } else {
    fill();
  }
  return card;
}

// Sahne: bas-tut-kaydır (yukarı tiz, aşağı pes), parmak bastıkça ton çalar ve dalga perdeyle sıklaşır.
// Konum → frekans logaritmik (eşit kaydırma = eşit sent). Kilitle düğmesi sahnenin altında, kartın içinde.
function createInput({ difficulty, submit }) {
  const range = TONE_RANGES[difficulty] ?? TONE_RANGES.easy;
  const showHz = difficulty !== 'hard';
  let t = 0.1 + Math.random() * 0.8; // her turda rastgele başlangıç (dokunmadan gönderen ortadan puan alamasın)
  let freq = freqAt(t, range);
  let voice = null;
  let pid = null;
  let touched = false;

  const hzLabel = el('span', { class: 'tn-hz' });
  const marker = el('div', { class: 'tn-marker' });
  const hint = el('span', { class: 'tn-hint' }, '↕ Bas, basılı tut ve yukarı-aşağı kaydır');
  const { wave, node: pad } = scene('tn-pad',
    el('span', { class: 'tn-end top' }, 'tiz'), el('span', { class: 'tn-end bottom' }, 'pes'),
    marker, showHz ? hzLabel : null, hint);
  pad.setAttribute('tabindex', '0');
  pad.setAttribute('role', 'slider');
  pad.setAttribute('aria-label', 'Perde');
  pad.setAttribute('aria-valuemin', '0');
  pad.setAttribute('aria-valuemax', '100');
  wave.setActive(false);

  const place = () => {
    marker.style.bottom = `${t * 100}%`;
    hzLabel.textContent = hz(freq);
    wave.setLevel(t);
    pad.setAttribute('aria-valuenow', String(Math.round(t * 100)));
    pad.setAttribute('aria-valuetext', showHz ? hz(freq) : `%${Math.round(t * 100)}`);
  };
  const setT = (nt) => {
    t = Math.min(1, Math.max(0, nt));
    freq = freqAt(t, range);
    place();
    voice?.set(freq);
  };
  const fromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    setT(1 - (e.clientY - r.top) / r.height);
  };
  const end = (e) => {
    if (e && e.pointerId !== pid) return;
    pid = null;
    voice?.stop();
    voice = null;
    pad.classList.remove('active');
    wave.setActive(false);
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    pid = e.pointerId;
    try { pad.setPointerCapture(pid); } catch { /* yok say */ }
    pad.classList.add('active');
    wave.setActive(true);
    if (!touched) { touched = true; hint.remove(); }
    fromEvent(e);
    voice?.stop();
    voice = startLive(freq);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === pid) fromEvent(e); });
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('lostpointercapture', end);
  pad.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.02 : 0.004;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setT(t + (e.key === 'ArrowUp' ? step : -step));
    replayStop?.();
    replayStop = playTone(freq, 300);
  });
  place();

  const node = el('section', { class: 'card tn-card tn-input' },
    pad,
    el('p', { class: 'tn-note center' }, showHz ? 'Bıraktığında seçtiğin perde kalır; istediğin kadar dene.' : 'Zor mod: frekans gizli, sadece kulağına güven!'),
    el('button', { class: 'btn big tn-lock rc-submit', onclick: () => submit?.() }, '🎯 Kilitle'));
  return {
    node,
    value: () => Math.round(freq * 10) / 10,
    stop: () => end({ pointerId: pid }),
  };
}

const playBtn = (freq, label) => el('button', {
  type: 'button', class: 'btn small ghost tn-play', 'aria-label': `${label} tonunu çal`,
  onclick: (e) => { e.stopPropagation(); replay(freq); },
}, '▶');

function fmtCents(c) {
  const r = Math.round(c);
  return `${r > 0 ? '+' : ''}${r} sent`;
}

function answerChip(guess, { difficulty, target, big, mini, isTarget } = {}) {
  if (guess == null) return el('span', { class: 'tn-chip none' }, mini ? '—' : 'cevap yok');
  if (mini) {
    const c = target ? Math.round(centsBetween(target, guess)) : null;
    return el('span', { class: 'tn-mini' }, c == null ? hz(guess) : `${c > 0 ? '+' : ''}${c}¢`);
  }
  // Hatırlama sırasında (hedef bilinmezken) Zor modda değer gizli kalır, tekrar çalma yok.
  const during = target === undefined && !isTarget;
  if (during) return el('span', { class: `tn-chip${big ? ' big' : ''}` }, difficulty === 'hard' ? '🎚️ perde seçildi' : `🎚️ ${hz(guess)}`);
  return el('span', { class: `tn-chip${big ? ' big' : ''}` }, hz(guess), playBtn(guess, isTarget ? 'Hedef' : 'Bu'));
}

function roundDetail({ round, target, guess, score, timedOut }, { big } = {}) {
  const cents = guess != null ? centsBetween(target, guess) : null;
  return el('div', { class: `tn-round${big ? ' big' : ''}` },
    big ? null : el('span', { class: 'nu-rn' }, `${round + 1}`),
    el('div', { class: 'tn-vals' },
      el('div', {}, el('small', {}, 'Hedef'), el('b', {}, hz(target)), playBtn(target, 'Hedef')),
      el('div', {}, el('small', {}, 'Sen'), guess != null ? el('b', {}, hz(guess)) : el('b', {}, timedOut ? 'süre doldu' : '—'), guess != null ? playBtn(guess, 'Senin') : null)),
    cents != null ? el('div', { class: 'tn-cents' }, `${fmtCents(cents)} · ${centsHint(cents)}`) : null,
    el('b', { class: 'nu-score' }, score.toFixed(2), big ? el('small', {}, ' / 10') : null));
}

const game = createRecallGame({
  id: 'tone',
  name: 'Ton Avı',
  icon: '🔊',
  rootId: 'game-tone',
  difficulties: [
    { id: 'easy', label: 'Kolay', hint: '80–1200 Hz, Hz görünür' },
    { id: 'hard', label: 'Zor', hint: '60–1400 Hz, Hz gizli' },
  ],
  dailyDifficulty: 'easy',
  verbs: { start: 'Başla', show: 'Tonu dinle', submit: '🎯 Kilitle', memorize: 'Dinle!', recall: 'Şimdi aynı perdeyi bul!' },
  howTo: [
    'Her turda bir ton 3 saniye çalar — bir kez. İyi dinle!',
    'Sonra siyah sahneye bas, basılı tutup yukarı (tiz) ya da aşağı (pes) kaydır; parmağın bastıkça ton çalar.',
    'Bıraktığında seçtiğin perde kalır; istediğin kadar dene, 30 saniye içinde "Kilitle"ye bas.',
    'Puan sent farkına göre (10 üzerinden): yarım ton kayma 6 puan, bir oktav kayma neredeyse 0.',
    'Sesi açmayı unutma 🔈',
  ],
  readyHint: (g) => `Her turda ton ${Math.round(g.memorizeMs / 1000) || 1} sn çalacak (tekrar yok), sonra ${Math.round(g.recallMs / 1000)} sn içinde aynı perdeyi bulacaksın. Sesini aç!`,
  memorizeView,
  createInput,
  answerChip,
  roundDetail,
  formatScore: (s) => s.toFixed(2),
  formatTotal: (total, { short } = {}) => (short ? total.toFixed(2) : `${total.toFixed(2)}/50`),
  shareText: ({ mode, puzzleNo, total }) => `${mode === 'daily' ? `Tosun Ton Avı #${puzzleNo}` : 'Tosun Ton Avı (sınırsız)'} · ${total.toFixed(2)}/50`,
  unlock: unlockAudio,
  prepareMedia,
  stopSound,
  inlineSubmit: true,
});

export const enter = game.enter;
export function leave() {
  stopSound();
  stopAll();
  memoKey = '';
  game.leave();
}
