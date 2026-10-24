// 🔊 Ton Avı — perde hafızası. Sinüs tonu 3 sn çalar (tekrar dinlenemez); sonra dikey pedde parmağınla
// aynı perdeyi bulursun. Puan sunucuda (sent farkı). Ortak akış: recall-client.js. Kurallar: PLAN.md §4.5.
import { el } from '../ui.js';
import { TONE_RANGES, centsBetween, centsHint, freqAt } from '../recall-math.js';
import { createRecallGame, secondsTimer, timeBar } from './recall-client.js';
import { audioReady, playTone, startLive, stopAll, unlockAudio } from './tone-audio.js';

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

function waves() {
  return el('div', { class: 'tn-waves', 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, i) => {
    const bar = el('span', {});
    bar.style.animationDelay = `${(i % 5) * 90}ms`;
    return bar;
  }));
}

// Hedef ton bu ekranda bir kez çalar. Ses kilitliyse (tarayıcı dokunuş istemiş) bir düğmeyle kalan süre çalınır.
function memorizeView(target, { endsAt, totalMs, key }) {
  const play = () => {
    const left = endsAt - Date.now();
    if (left < 120) return;
    memoStop?.();
    memoStop = playTone(target, left);
  };
  const card = el('section', { class: 'card center tn-memo' });
  const fill = () => {
    card.replaceChildren(
      el('div', { class: 'tn-orb' }, el('span', {}, '🎵')),
      waves(),
      el('div', { class: 'rc-phase' }, 'Dinle… ', secondsTimer(endsAt, { urgentAt: 0 })),
      timeBar(endsAt, totalMs),
      el('p', { class: 'hint' }, 'Bu perdeyi aklında tut — bir daha çalmayacak!'));
  };
  if (memoKey !== key) {
    if (audioReady()) {
      memoKey = key;
      play();
      fill();
    } else {
      unlockAudio();
      // Bazı tarayıcılar resume'u hemen yapar; kısa bir bekleyişten sonra tekrar dene, olmazsa düğme göster.
      card.append(el('button', {
        class: 'btn big primary',
        onclick: () => { unlockAudio(); memoKey = key; setTimeout(play, 30); fill(); },
      }, '🔊 Sesi aç ve dinle'));
      setTimeout(() => { if (memoKey !== key && audioReady() && card.isConnected) { memoKey = key; play(); fill(); } }, 80);
    }
  } else {
    fill();
  }
  return card;
}

// Dikey ped: bas-tut-kaydır, parmak bastıkça ton çalar. Konum → frekans logaritmik (eşit kaydırma = eşit sent).
function createInput({ difficulty }) {
  const range = TONE_RANGES[difficulty] ?? TONE_RANGES.easy;
  const showHz = difficulty !== 'hard';
  let t = 0.1 + Math.random() * 0.8; // her turda rastgele başlangıç (dokunmadan gönderen ortadan puan alamasın)
  let freq = freqAt(t, range);
  let voice = null;
  let pid = null;
  let touched = false;

  const hzLabel = el('span', { class: 'tn-hz' });
  const marker = el('div', { class: 'tn-marker' }, el('span', { class: 'tn-dot' }), showHz ? hzLabel : null);
  const hint = el('span', { class: 'tn-hint' }, '👆 Bas, basılı tut ve yukarı-aşağı kaydır');
  const pad = el('div', {
    class: 'tn-pad', tabindex: '0', role: 'slider', 'aria-label': 'Perde',
    'aria-valuemin': '0', 'aria-valuemax': '100',
  }, el('span', { class: 'tn-end top' }, '▲ tiz'), el('span', { class: 'tn-end bottom' }, '▼ pes'), hint, marker);

  const place = () => {
    marker.style.bottom = `${t * 100}%`;
    hzLabel.textContent = hz(freq);
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
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    pid = e.pointerId;
    try { pad.setPointerCapture(pid); } catch { /* yok say */ }
    pad.classList.add('active');
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

  const node = el('section', { class: 'card tn-input' },
    pad,
    el('p', { class: 'hint center' }, showHz ? 'Bıraktığında seçtiğin perde kalır; istediğin kadar dene.' : 'Zor mod: frekans gizli, sadece kulağına güven!'));
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
  verbs: { start: 'Başla', show: 'Tonu dinle', submit: '🎯 Gönder', memorize: 'Dinle!', recall: 'Şimdi aynı perdeyi bul!' },
  howTo: [
    'Her turda bir ton 3 saniye çalar — bir kez. İyi dinle!',
    'Sonra büyük pede bas, basılı tutup yukarı (tiz) ya da aşağı (pes) kaydır; parmağın bastıkça ton çalar.',
    'Bıraktığında seçtiğin perde kalır; istediğin kadar dene, 30 saniye içinde "Gönder"e bas.',
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
  stopSound,
});

export const enter = game.enter;
export function leave() {
  stopSound();
  stopAll();
  memoKey = '';
  game.leave();
}
