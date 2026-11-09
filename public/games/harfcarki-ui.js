// 🔤 Harf Çarkı — ortak arayüz parçaları: harf çarkı (SVG), oyun paneli (ipucu + yazı kutusu + Gönder/Pas),
// süre halkası, harf harf döküm, paylaşım metni, mini çark (lobi). Tek oyunculu (harfcarki.js) ve lobi
// (harfcarki-lobby.js) kullanır. Kullanıcı metinleri her zaman textContent ile basılır.
import { el, toast } from '../ui.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of children) if (c != null) n.append(c);
  return n;
}

export const EMOJI = { ok: '🟩', bad: '🟥', pass: '⬜', todo: '⬜' };
export const STATE_LABEL = { ok: 'doğru', bad: 'yanlış', pass: 'pas', todo: 'cevapsız' };

export const HOW_TO = [
  'Çarkta 28 harf var; her harf için bir ipucu gelir. Cevap o harfle başlar (bazı zor harflerde "… harfini içerir" yazar).',
  'Cevabı yazıp Gönder\'e bas. Doğruysa harf yeşil, yanlışsa kırmızı olur — ikinci hakkın yok.',
  'Emin değilsen Pas: o harf ilk turdan sonra tekrar gelir.',
  'Tüm çark için toplam süre var (varsayılan 5 dk). Türkçe karakter, büyük/küçük harf ve 6+ harfli cevaplarda tek harflik yazım hatası sorun değil.',
  'Sıralama: önce doğru sayısı, sonra az yanlış, sonra hızlı bitiren. Hepsini erken bitirirsen küçük süre ödülü.',
];

export function ensureCss() {
  if (document.getElementById('harfcarki-css')) return;
  document.head.append(el('link', { id: 'harfcarki-css', rel: 'stylesheet', href: 'games/harfcarki.css' }));
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const summaryLine = (s) => `${s.correct} doğru · ${s.wrong} yanlış · ${s.passed} pas`;

// ---------- Büyük çark ----------

const SIZE = 300;
const C = SIZE / 2;
const R_LETTER = 134;
const R_DOT = 13;
const R_RING = 98;
const RING_LEN = 2 * Math.PI * R_RING;

function wheel(letters) {
  const n = letters.length;
  const dots = letters.map((l, i) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x = C + R_LETTER * Math.cos(a);
    const y = C + R_LETTER * Math.sin(a);
    const g = svg('g', { class: 'hc-dot hc-todo', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, 'data-i': i },
      svg('circle', { r: R_DOT }),
      svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 1 }, l.letter));
    return g;
  });
  const ring = svg('circle', { class: 'hc-ring-fill', cx: C, cy: C, r: R_RING, 'stroke-dasharray': RING_LEN.toFixed(1), 'stroke-dashoffset': 0, transform: `rotate(-90 ${C} ${C})` });
  const bigLetter = svg('text', { class: 'hc-big', x: C, y: C - 10, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '');
  const time = svg('text', { class: 'hc-time', x: C, y: C + 46, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '');
  const root = svg('svg', { class: 'hc-wheel', viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', 'aria-label': 'Harf çarkı' },
    svg('circle', { class: 'hc-ring-bg', cx: C, cy: C, r: R_RING }),
    ring, bigLetter, time, ...dots);
  return {
    root,
    setStates(list, cur) {
      list.forEach((l, i) => {
        const d = dots[i];
        const cls = `hc-dot hc-${l.state}${i === cur ? ' hc-cur' : ''}`;
        if (d.getAttribute('class').replace(/ hc-(pulse|wrong)/g, '') !== cls) {
          const keep = d.getAttribute('class').match(/ hc-(pulse|wrong)/g)?.join('') ?? '';
          d.setAttribute('class', cls + keep);
        }
        d.setAttribute('aria-label', `${l.letter}: ${STATE_LABEL[l.state]}`);
      });
    },
    setCenter(letter) { bigLetter.textContent = letter ?? ''; },
    setTime(leftMs, totalMs) {
      time.textContent = fmtTime(leftMs);
      const f = totalMs > 0 ? Math.max(0, Math.min(1, leftMs / totalMs)) : 0;
      ring.setAttribute('stroke-dashoffset', (RING_LEN * (1 - f)).toFixed(1));
      root.classList.toggle('urgent', leftMs <= 30_000 * (totalMs / 300_000 || 1) && leftMs > 0);
    },
    flash(i, result) {
      const d = dots[i];
      if (!d) return;
      const cls = result === 'ok' ? 'hc-pulse' : result === 'bad' ? 'hc-wrong' : null;
      if (!cls) return;
      d.classList.remove(cls);
      void d.getBoundingClientRect();
      d.classList.add(cls);
      setTimeout(() => d.classList.remove(cls), 700);
    },
  };
}

// ---------- Oyun paneli ----------
// opts: { onAnswer(text, pos), onPass(pos), onQuit(), onTimeUp(), offset: () => sunucu-yerel saat farkı }
// Panel bir kez kurulur ve yerinde güncellenir: yazı kutusu yeniden oluşturulmaz (mobil klavye kapanmasın).
export function playPanel(opts) {
  let run = null; // sunucunun publicRun'ı
  let busy = false;
  let timeUpSent = false;
  let lastPos = -1;
  const w = wheel(Array.from({ length: 28 }, () => ({ letter: '', state: 'todo' })));
  const ruleEl = el('div', { class: 'hc-rule' });
  const catEl = el('span', { class: 'hc-cat' });
  const clueEl = el('p', { class: 'hc-clue', 'aria-live': 'polite' });
  const clueCard = el('div', { class: 'hc-clue-card' }, el('div', { class: 'hc-clue-head' }, ruleEl, catEl), clueEl);
  const input = el('input', {
    class: 'hc-input', type: 'text', maxlength: '40', autocomplete: 'off', autocapitalize: 'none',
    autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Cevabın…', 'aria-label': 'Cevap',
  });
  // Düğmeler odağı yazı kutusundan almasın (mobil klavye açık kalsın).
  const keepFocus = (e) => e.preventDefault();
  const sendBtn = el('button', { type: 'submit', class: 'btn primary hc-send', onpointerdown: keepFocus }, 'Gönder');
  const passBtn = el('button', { type: 'button', class: 'btn hc-pass-btn', onpointerdown: keepFocus, onclick: () => doPass() }, 'Pas ⏭');
  const form = el('form', { class: 'hc-form', onsubmit: (e) => { e.preventDefault(); doAnswer(); } },
    input, el('div', { class: 'hc-actions' }, passBtn, sendBtn));
  const statsEl = el('div', { class: 'hc-stats' });
  const quitBtn = el('button', {
    type: 'button', class: 'btn link hc-quit',
    onclick: () => { if (!run?.done && confirm('Çarkı şimdi bitirmek istiyor musun? Kalan harfler cevapsız sayılır.')) opts.onQuit?.(); },
  }, 'Bitir');
  const countdownEl = el('div', { class: 'hc-countdown hidden' });
  const node = el('div', { class: 'hc-play' },
    el('div', { class: 'hc-wheel-wrap' }, w.root, countdownEl), clueCard, form, statsEl, quitBtn);

  function doAnswer() {
    if (!run?.current || busy) return;
    const text = input.value.trim();
    if (!text) { toast('Bir cevap yaz ya da pas geç.'); input.focus(); return; }
    busy = true;
    sendBtn.disabled = true; passBtn.disabled = true;
    opts.onAnswer(text, run.current.pos);
  }
  function doPass() {
    if (!run?.current || busy) return;
    busy = true;
    sendBtn.disabled = true; passBtn.disabled = true;
    opts.onPass(run.current.pos);
  }

  // Sunucu saatine göre kalan süre
  const leftMs = () => (run ? run.endsAt - (Date.now() + (opts.offset?.() ?? 0)) : 0);
  const startsIn = () => (run ? run.startAt - (Date.now() + (opts.offset?.() ?? 0)) : 0);
  let timer = null;
  const tick = () => {
    if (!node.isConnected && timer) { clearInterval(timer); timer = null; return; }
    if (!run) return;
    const total = run.endsAt - run.startAt;
    const pre = startsIn();
    countdownEl.classList.toggle('hidden', !(pre > 0) || run.done);
    if (pre > 0) countdownEl.textContent = String(Math.ceil(pre / 1000));
    const left = run.done ? 0 : Math.min(total, leftMs());
    w.setTime(left, total);
    if (!run.done && left <= 0 && !timeUpSent) { timeUpSent = true; opts.onTimeUp?.(); }
  };
  timer = setInterval(tick, 250);

  return {
    node,
    input,
    // run: publicRun; last: { pos, result } (animasyon için, opsiyonel)
    update(next, last) {
      const prevPos = run?.current?.pos;
      run = next;
      busy = false;
      w.setStates(run.letters, run.current?.pos ?? -1);
      w.setCenter(run.current?.letter ?? (run.done ? '✓' : ''));
      if (last) {
        w.flash(last.pos, last.result);
        clueCard.classList.remove('hc-ok-flash', 'hc-bad-flash', 'hc-pass-slide');
        void clueCard.offsetWidth;
        clueCard.classList.add(last.result === 'ok' ? 'hc-ok-flash' : last.result === 'bad' ? 'hc-bad-flash' : 'hc-pass-slide');
      }
      const c = run.current;
      if (c) {
        ruleEl.textContent = c.mode === 'contains' ? `${c.letter} harfini içerir` : `${c.letter} ile başlar`;
        ruleEl.classList.toggle('contains', c.mode === 'contains');
        catEl.textContent = `${c.lap === 2 ? '↩︎ pas · ' : ''}${c.category}`;
        clueEl.textContent = c.clue;
        if (c.pos !== prevPos || c.pos !== lastPos) input.value = '';
        lastPos = c.pos;
      } else {
        ruleEl.textContent = run.done ? 'Çark bitti' : 'Hazır ol';
        catEl.textContent = '';
        clueEl.textContent = run.done ? summaryLine(run.summary) : 'Süre başlayınca ilk ipucu gelecek.';
      }
      const playable = Boolean(c) && !run.done;
      sendBtn.disabled = !playable; passBtn.disabled = !playable;
      input.disabled = run.done;
      statsEl.textContent = summaryLine(run.summary);
      quitBtn.classList.toggle('hidden', !playable);
      tick();
    },
    // İstek başarısız: düğmeleri geri aç, yazılanı koru.
    unlock() { busy = false; if (run?.current && !run.done) { sendBtn.disabled = false; passBtn.disabled = false; } },
    resetTimeUp() { timeUpSent = false; },
    focus() { try { input.focus({ preventScroll: true }); } catch { input.focus(); } },
    destroy() { clearInterval(timer); timer = null; },
  };
}

// Mobil klavye açıkken (visualViewport küçülür) çarkı küçült, yazı kutusunu görünür tut. Döner: kaldırıcı.
export function keyboardAware(root, getInput) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const onResize = () => {
    const open = vv.height < window.innerHeight - 120;
    root.classList.toggle('hc-kb', open);
    root.style.setProperty('--hc-vvh', `${Math.round(vv.height)}px`);
    const input = getInput();
    if (open && input && document.activeElement === input) {
      requestAnimationFrame(() => input.scrollIntoView({ block: 'center', behavior: 'auto' }));
    }
  };
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onResize);
  onResize();
  return () => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); };
}

// ---------- Mini çark (lobi canlı ilerleme) ----------

export function miniWheel(states, { cur = null } = {}) {
  const n = states.length;
  const S = 64, c = S / 2, r = 26;
  return svg('svg', { class: 'hc-mini', viewBox: `0 0 ${S} ${S}`, 'aria-hidden': 'true' },
    ...states.map((s, i) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      return svg('circle', { class: `hc-m-${s}${i === cur ? ' hc-m-cur' : ''}`, cx: (c + r * Math.cos(a)).toFixed(1), cy: (c + r * Math.sin(a)).toFixed(1), r: i === cur ? 4.2 : 3.2 });
    }));
}

// ---------- Döküm + paylaşım ----------

// rows: [{ letter, mode, clue, answer, typed, state }]
export function recapList(rows) {
  return el('ol', { class: 'hc-recap' }, rows.map((r) =>
    el('li', { class: `hc-r-${r.state}` },
      el('span', { class: 'hc-r-letter', title: STATE_LABEL[r.state] }, r.letter),
      el('div', { class: 'hc-r-body' },
        el('div', { class: 'hc-r-clue' }, r.mode === 'contains' ? `(${r.letter} harfini içerir) ${r.clue}` : r.clue),
        el('div', { class: 'hc-r-answer' }, el('b', {}, r.answer),
          r.typed && r.state === 'bad' ? el('span', { class: 'hc-r-typed' }, ` · sen: ${r.typed}`) : null,
          r.state === 'pass' || r.state === 'todo' ? el('span', { class: 'hc-r-typed' }, ' · cevapsız') : null)))));
}

export function emojiGrid(states) {
  const rows = [];
  for (let i = 0; i < states.length; i += 7) rows.push(states.slice(i, i + 7).map((s) => EMOJI[s]).join(''));
  return rows.join('\n');
}

export function shareText(title, summary, states) {
  const dur = summary.durationMs != null ? `\n⏱ ${fmtTime(summary.durationMs)}` : '';
  return `🔤 ${title}\n${summaryLine(summary)}\n${emojiGrid(states)}${dur}`;
}

export async function share(text) {
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Sonuç kopyalandı.'); }
  } catch { /* iptal */ }
}

export function optionButtons(options, value, onPick, { disabled = false, key = 'opt' } = {}) {
  return el('div', { class: 'pl-tests hc-opts' }, options.map(([v, label]) => el('button', {
    type: 'button',
    class: `pl-test${value === v ? ' active' : ''}`,
    disabled,
    'aria-pressed': value === v ? 'true' : 'false',
    'data-opt': `${key}-${v}`,
    onclick: () => onPick(v),
  }, label)));
}

export const DIFF_OPTS = [['easy', '🙂 Kolay'], ['mixed', '🎲 Karışık'], ['hard', '🔥 Zor']];
export const MIN_OPTS = [[3, '3 dk'], [5, '5 dk'], [7, '7 dk']];
