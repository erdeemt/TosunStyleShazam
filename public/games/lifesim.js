// 🎲 Doğum Piyangosu — istemci (tamamen tarayıcıda; sunucu gerekmez). Simülasyon: public/lifesim-sim.js, olaylar: public/lifesim-events.js,
// veri: public/data/lifesim.json (scripts/lifesim-build.mjs ile üretilir).
import { $, el, toast } from '../ui.js';
import * as sim from '../lifesim-sim.js';

const HISTORY_KEY = 'tss:lifesim-history';
const SPEED_KEY = 'tss:lifesim-speed';
const SEED_KEY = 'tss:lifesim-seed'; // testler sabit tohum verebilir
const YEAR_MS = 2500;
const SPEEDS = [1, 2, 4];

let root = null;
let world = null;
let loading = null;
let screen = 'intro';
let L = null;
let speed = 1;
let paused = false;
let timer = null;
let nameSalt = 0;
let reduced = false;
let ui = {}; // oyun ekranının kalıcı düğümleri

// ---------- Kalıcı kayıtlar (try/catch: gizli sekmede localStorage olmayabilir) ----------

const store = {
  get(key, fb) { try { const v = localStorage.getItem(key); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* yok say */ } },
};
const history = () => { const h = store.get(HISTORY_KEY, []); return Array.isArray(h) ? h : []; };

async function ensureWorld() {
  if (world) return world;
  loading ??= fetch('data/lifesim.json').then((r) => { if (!r.ok) throw new Error('Veri yüklenemedi'); return r.json(); }).then((d) => { world = sim.prepareWorld(d); return world; });
  return loading;
}

const fmt = (x, d = 0) => Number(x).toLocaleString('tr-TR', { maximumFractionDigits: d });
const sexWord = (s) => (s === 'M' ? 'Erkek' : 'Kız');

function statDetails(text, cls = '') {
  if (!text) return null;
  return el('details', { class: `ls-stat ${cls}` }, el('summary', { 'aria-label': 'Gerçek veriyi göster', title: 'Gerçek veri' }, '📊'), el('p', {}, text));
}

// ---------- Ekranlar ----------

function render() {
  if (!root) return;
  stopClock();
  ui = {};
  const body = { intro: introScreen, birth: birthScreen, play: playScreen, end: endScreen, history: historyScreen, sources: sourcesScreen }[screen]();
  root.replaceChildren(el('div', { class: `screen active lifesim ls-${screen}` }, body));
  if (screen === 'play') { renderHeader(); if (L.pending) showChoice(); else startClock(); }
}

function introScreen() {
  const h = history();
  return [
    el('section', { class: 'card ls-hero' },
      el('div', { class: 'ls-dice', 'aria-hidden': 'true' }, '🎲'),
      el('h2', {}, 'Dünyada şu an doğan bir bebek olsaydın, kim olurdun?'),
      el('p', {}, world ? `Her yıl yaklaşık ${fmt(world.total / 1e6)} milyon bebek doğuyor. Nerede, hangi ailede doğacağın gerçek doğum sayılarına göre çekilir; hayatının olasılıkları da o ülkenin gerçek istatistiklerinden gelir.` : 'Veriler yükleniyor…'),
      el('button', { class: 'btn big primary ls-born', type: 'button', disabled: !world, onclick: newLife }, '🎲 Doğ!')),
    el('div', { class: 'row center' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => go('history') }, `📜 Geçmiş hayatlar${h.length ? ` (${h.length})` : ''}`),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => go('sources') }, '📚 Kaynaklar')),
    howto(),
  ];
}

function howto() {
  return el('details', { class: 'card howto-box' },
    el('summary', {}, '📖 Nasıl oynanır?'),
    el('ul', { class: 'howto' },
      el('li', {}, '“Doğ!” de: ülken, cinsiyetin ve ailenin varlığı gerçek doğum dağılımına göre çekilir. Adını sen koy.'),
      el('li', {}, 'Hayat yıl yıl kendiliğinden akar (1×, 2×, 4×, duraklat, ⏭ sonraki olaya atla).'),
      el('li', {}, 'Bazı anlarda seçim yaparsın: okul, evlilik, çocuk, göç, sağlık… Seçimler olasılıkları değiştirir, sonucu garanti etmez.'),
      el('li', {}, 'Her olayın yanındaki 📊, arkasındaki gerçek veriyi gösterir. Ömrün, ülkenin yaşam tablosundan gelir; erken ölümler de gerçek oranlarda olur.'),
      el('li', {}, 'Sonunda “Hayat Karnesi”: ömrün, ülke ortalaması, dünyadaki gelir sıran ve bir kart. Son 20 hayatın bu cihazda saklanır.')));
}

function newLife() {
  const fixed = store.get(SEED_KEY, null);
  const seed = fixed ?? `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  L = sim.birth(world, { seed, year: new Date().getFullYear() });
  nameSalt = 0;
  L.name = sim.randomName(world, L, nameSalt);
  go('birth');
}

function birthScreen() {
  const c = world.byIso.get(L.born);
  const s = L.sex === 'M' ? 0 : 1;
  const share = (100 * c.b) / world.total;
  const fam = L.parentW < 20 ? 'yoksul' : L.parentW < 45 ? 'dar gelirli' : L.parentW < 75 ? 'orta halli' : L.parentW < 95 ? 'varlıklı' : 'çok zengin';
  const input = el('input', { type: 'text', maxlength: '20', value: L.name, 'aria-label': 'Bebeğin adı', autocomplete: 'off', class: 'ls-name-input' });
  return [
    el('section', { class: 'card ls-birth-card', 'data-testid': 'birth-card' },
      el('div', { class: 'ls-flag', 'aria-hidden': 'true' }, c.f),
      el('h2', {}, `${sim.suffix(c.n, 'de')} doğdun!`),
      el('p', { class: 'ls-sub' }, `${sexWord(L.sex)} bebek · ${L.urban ? 'şehirde' : 'kırsalda'} · ${fam} bir aile`),
      el('ul', { class: 'ls-facts' },
        el('li', {}, `🌍 Dünyadaki doğumların %${fmt(share, share < 1 ? 2 : 1)}'i burada (yılda ${fmt(c.b)} bebek)`),
        el('li', {}, `⏳ Beklenen ömür: ${fmt(c.le[s], 1)} yıl`),
        el('li', {}, `👶 Bebek ölümü: binde ${fmt(c.imr[s], 1)}`),
        el('li', {}, `💰 Kişi başı gelir: ${fmt(c.gdp)} $ (satın alma gücüyle)`),
        L.lat.noElec ? el('li', {}, '💡 Evinizde elektrik yok') : null),
      statDetails(`Ülke, gerçek yıllık doğum sayılarıyla ağırlıklı çekildi (UN WPP / Dünya Bankası). Cinsiyet 105:100. Aile varlığı ülke içindeki gelir sırasıdır; gelir GSYH ve Gini katsayısından (${fmt(c.gini, 1)}) log-normal dağılımla hesaplanır.${c.est?.length ? ` Bu ülkede bazı göstergeler bölge ortalamasından tahmini: ${c.est.join(', ')}.` : ''}`)),
    el('form', {
      class: 'card ls-name',
      onsubmit: (e) => { e.preventDefault(); start(input.value); },
    },
      el('label', { class: 'ls-label' }, 'Adını koy'),
      el('div', { class: 'row' }, input,
        el('button', { type: 'button', class: 'btn ghost', onclick: () => { nameSalt++; input.value = sim.randomName(world, L, nameSalt); } }, '🎲 Rastgele')),
      el('button', { type: 'submit', class: 'btn big primary ls-start' }, 'Hayata başla ▶')),
  ];
}

function start(name) {
  sim.setName(L, name);
  L.log = [sim.birthEntry(world, L)];
  paused = false;
  go('play');
}

// ---------- Oyun ekranı ----------

function playScreen() {
  ui.name = el('b', { class: 'ls-pname' });
  ui.place = el('span', { class: 'ls-place' });
  ui.age = el('div', { class: 'ls-age', 'aria-live': 'off' });
  ui.stage = el('div', { class: 'ls-stage' });
  ui.bars = el('div', { class: 'ls-bars' });
  ui.log = el('ol', { class: 'ls-log', 'aria-live': 'polite' });
  ui.choice = el('div', { class: 'ls-choice-wrap hidden' });
  ui.pause = el('button', { type: 'button', class: 'btn ls-ctl', 'aria-label': 'Duraklat', onclick: togglePause });
  ui.speeds = SPEEDS.map((s) => el('button', { type: 'button', class: 'btn ls-ctl ls-speed', 'data-speed': String(s), 'aria-pressed': String(s === speed), onclick: () => setSpeed(s) }, `${s}×`));
  ui.skip = el('button', { type: 'button', class: 'btn ls-ctl ls-skip', onclick: skipToEvent, 'aria-label': 'Sonraki olaya atla' }, '⏭ Olay');
  for (const e of [...L.log].reverse()) ui.log.append(logItem(e));
  return [
    el('header', { class: 'card ls-head' },
      el('div', { class: 'ls-who' }, ui.name, ui.place),
      el('div', { class: 'ls-agebox' }, ui.age, ui.stage),
      ui.bars),
    ui.log,
    ui.choice,
    el('div', { class: 'ls-controls' }, ui.pause, ...ui.speeds, ui.skip),
  ];
}

function renderHeader() {
  const c = world.byIso.get(L.iso);
  ui.name.textContent = L.name;
  ui.place.textContent = `${c.f} ${c.n}`;
  ui.age.textContent = String(L.age);
  ui.stage.textContent = `${sim.stageOf(L.age).name} · ${L.year0 + L.age}`;
  const top = worldTop();
  ui.bars.replaceChildren(...sim.STATS.map((s) => {
    const v = Math.round(L.st[s.key]);
    return el('div', { class: `ls-bar ls-bar-${s.key}` },
      el('span', { class: 'ls-bar-label' }, `${s.icon} ${s.name}`),
      el('span', { class: 'ls-bar-track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(v), 'aria-label': s.name },
        el('span', { class: 'ls-bar-fill', style: `width:${v}%` })),
      el('span', { class: 'ls-bar-val' }, s.key === 'w' ? `${v} · 🌍%${fmt(top, top < 10 ? 1 : 0)}` : String(v)));
  }));
  ui.pause.textContent = paused ? '▶' : '⏸';
  ui.pause.setAttribute('aria-label', paused ? 'Devam et' : 'Duraklat');
  for (const b of ui.speeds) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
}

// Varlığın dünya karşılığı: "dünyanın en zengin %X'i"
function worldTop() {
  const c = world.byIso.get(L.iso);
  return Math.min(99.9, Math.max(0.1, 100 - sim.worldPct(world, sim.incomeOf(c, L.st.w))));
}

function logItem(e) {
  return el('li', { class: `ls-entry ls-${e.kind}${e.hl >= 2 ? ' ls-big' : ''}`, 'data-id': e.id ?? '' },
    el('span', { class: 'ls-badge' }, `${e.age} yaş`, el('small', {}, String(e.year))),
    el('span', { class: 'ls-icon', 'aria-hidden': 'true' }, e.icon),
    el('span', { class: 'ls-text' }, e.text),
    e.kind === 'choice' ? null : statDetails(e.stat));
}

function addEntries(entries) {
  for (const e of entries) {
    L.log.push(e);
    const li = logItem(e);
    if (!reduced) li.classList.add('ls-new');
    ui.log.prepend(li);
  }
}

function advance() {
  if (!L.alive || L.pending) return false;
  const out = sim.step(world, L);
  addEntries(out);
  renderHeader();
  if (!L.alive) { finish(); return false; }
  if (L.pending) { showChoice(); return false; }
  return out;
}

function startClock() {
  stopClock();
  if (paused || !L?.alive || L.pending || screen !== 'play') return;
  timer = setTimeout(() => { timer = null; if (advance() !== false) startClock(); }, YEAR_MS / speed);
}
function stopClock() { clearTimeout(timer); timer = null; }

function togglePause() {
  paused = !paused;
  renderHeader();
  if (paused) stopClock(); else startClock();
}

function setSpeed(s) {
  speed = s;
  store.set(SPEED_KEY, s);
  renderHeader();
  if (!paused) startClock();
}

// Sonraki önemli olaya kadar hızlı ilerle (en fazla 25 yıl)
function skipToEvent() {
  stopClock();
  for (let i = 0; i < 25; i++) {
    const out = advance();
    if (out === false) return;
    if (out.some((e) => e.hl >= 1 || e.kind !== 'event')) break;
  }
  startClock();
}

function showChoice() {
  stopClock();
  const p = L.pending;
  ui.choice.classList.remove('hidden');
  ui.choice.replaceChildren(el('section', { class: 'card ls-choice', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Seçim', 'data-testid': 'choice' },
    el('div', { class: 'ls-choice-q' }, el('span', { class: 'ls-icon', 'aria-hidden': 'true' }, p.icon), el('span', {}, p.text)),
    statDetails(p.stat),
    el('div', { class: 'ls-options' }, p.options.map((o, i) => el('button', {
      type: 'button',
      class: 'btn ls-option',
      onclick: () => pick(i),
    }, o.l)))));
  ui.choice.querySelector('.ls-option')?.focus({ preventScroll: true });
}

function pick(i) {
  if (!L.pending) return;
  const out = sim.choose(world, L, i);
  ui.choice.classList.add('hidden');
  ui.choice.replaceChildren();
  addEntries(out);
  renderHeader();
  if (!L.alive) { finish(); return; }
  startClock();
}

function finish() {
  stopClock();
  const rep = sim.report(world, L);
  const h = history();
  h.unshift({ name: rep.name, sex: rep.sex, f: rep.born.f, n: rep.born.n, iso: rep.born.iso, df: rep.died.f, age: rep.age, span: Math.round(rep.span * 10) / 10, le: rep.le, cause: rep.cause, ep: rep.epitaph, top: Math.round(rep.worldTop), at: Date.now() });
  store.set(HISTORY_KEY, h.slice(0, 20));
  setTimeout(() => { if (screen === 'play' && !L.alive) go('end'); }, reduced ? 300 : 1400);
}

// ---------- Hayat Karnesi ----------

function endScreen() {
  const r = sim.report(world, L);
  const max = Math.max(r.span, r.le, r.cmp.le, 1);
  const bar = (label, v, cls) => el('div', { class: `ls-cmp ${cls}` },
    el('span', { class: 'ls-cmp-label' }, label),
    el('span', { class: 'ls-cmp-track' }, el('span', { class: 'ls-cmp-fill', style: `width:${(100 * v) / max}%` })),
    el('span', { class: 'ls-cmp-val' }, `${fmt(v, 1)} yıl`));
  return [
    el('section', { class: 'card ls-report', 'data-testid': 'report' },
      el('h2', {}, '📜 Hayat Karnesi'),
      el('div', { class: 'ls-rep-head' },
        el('div', { class: 'ls-flag', 'aria-hidden': 'true' }, r.born.f),
        el('div', {},
          el('b', { class: 'ls-rep-name' }, r.name),
          el('div', { class: 'ls-sub' }, `${r.born.n}${r.died.iso !== r.born.iso ? ` → ${r.died.f} ${r.died.n}` : ''} · ${r.age} yaşında${r.cause ? ` · ${r.cause}` : ''}`))),
      el('p', { class: 'ls-epitaph' }, `“${r.epitaph}”`),
      el('div', { class: 'ls-cmps' },
        bar('Senin ömrün', r.span, 'me'),
        bar(`${r.born.n} ortalaması`, r.le, 'avg'),
        bar(r.cmp.label.replace(/ beklenen ömrün$/, ''), r.cmp.le, 'cmp')),
      el('p', { class: 'ls-diff' }, Math.abs(r.diff) < 1 ? 'Tam ülke ortalaması kadar yaşadın.' : r.diff > 0 ? `Ülke ortalamasından ${fmt(r.diff, 1)} yıl fazla yaşadın.` : `Ülke ortalamasından ${fmt(-r.diff, 1)} yıl erken gittin.`),
      el('p', { class: 'ls-rich' }, `💰 Gelirinle dünyanın en zengin ${r.worldTopText}'i arasındaydın.`),
      el('div', { class: 'ls-bars ls-final' }, sim.STATS.map((s) => {
        const v = Math.round(r.stats[s.key]);
        return el('div', { class: `ls-bar ls-bar-${s.key}` }, el('span', { class: 'ls-bar-label' }, `${s.icon} ${s.name}`),
          el('span', { class: 'ls-bar-track' }, el('span', { class: 'ls-bar-fill', style: `width:${v}%` })), el('span', { class: 'ls-bar-val' }, String(v)));
      })),
      el('ul', { class: 'ls-facts' },
        el('li', {}, `🎓 ${r.edu}`),
        r.job ? el('li', {}, `💼 ${r.job}`) : null,
        el('li', {}, `👶 ${r.kids ? `${r.kids} çocuk` : 'Çocuk yok'}${r.grandkids ? `, ${r.grandkids} torun` : ''}`),
        r.migrations.length ? el('li', {}, `✈️ ${r.migrations.map((m) => `${m.f} ${m.n} (${m.age} yaş)`).join(', ')}`) : null),
      el('h3', {}, '⭐ Önemli anlar'),
      el('ol', { class: 'ls-timeline' }, r.highlights.map((e) => el('li', {}, el('span', { class: 'ls-badge' }, `${e.age}`), el('span', { class: 'ls-icon', 'aria-hidden': 'true' }, e.icon), el('span', {}, e.text)))),
      el('details', { class: 'ls-stat ls-stat-block' }, el('summary', {}, '📊 Bu hayatın arkasındaki veriler'), el('ul', {}, r.stats2.map((t) => el('li', {}, t))))),
    el('div', { class: 'row center ls-end-actions' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => shareCard(r) }, '📤 Kartı paylaş'),
      el('button', { type: 'button', class: 'btn', onclick: newLife }, '🎲 Yeniden doğ'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => go('history') }, '📜 Geçmiş')),
  ];
}

// Paylaşım kartı: 1080×1350 tuval → PNG (navigator.share ya da indirme)
async function shareCard(r) {
  const W = 1080, H = 1350;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#2a1250'); grad.addColorStop(1, '#5a1640');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  try { await document.fonts.load('80px "Noto Color Emoji"', r.born.f); } catch { /* yok say */ }
  const font = (w, s) => `${w} ${s}px Rubik, 'Noto Color Emoji', system-ui, sans-serif`;
  g.fillStyle = '#f3ecff'; g.textAlign = 'center';
  g.font = font(900, 46); g.fillText('🎲 DOĞUM PİYANGOSU', W / 2, 110);
  g.font = font(400, 200); g.fillText(r.born.f, W / 2, 360);
  g.font = font(900, 84); g.fillText(r.name, W / 2, 480);
  g.font = font(500, 44); g.fillStyle = '#d9c8f5';
  g.fillText(`${r.born.n} · ${r.age} yaş`, W / 2, 550);
  if (r.cause) g.fillText(r.cause, W / 2, 610);
  g.fillStyle = '#ffb547'; g.font = font(700, 46);
  g.fillText(`Ortalama ${fmt(r.le, 1)} → sen ${fmt(r.span, 1)} yıl`, W / 2, 720);
  g.fillStyle = '#f3ecff'; g.font = font(500, 42);
  g.fillText(`Dünyanın en zengin ${r.worldTopText}'i`, W / 2, 790);
  g.fillText(`🎓 ${r.edu} · 👶 ${r.kids} çocuk`, W / 2, 860);
  // Kitabe (satır kaydırmalı)
  g.font = `italic 500 46px Rubik, 'Noto Color Emoji', system-ui, sans-serif`; g.fillStyle = '#ff9cc2';
  const words = `“${r.epitaph}”`.split(' ');
  let line = '', y = 980;
  for (const w of words) {
    if (g.measureText(`${line} ${w}`).width > W - 160 && line) { g.fillText(line, W / 2, y); line = w; y += 60; } else line = line ? `${line} ${w}` : w;
  }
  g.fillText(line, W / 2, y);
  g.fillStyle = '#a996c7'; g.font = font(400, 30);
  g.fillText('Gerçek ülke istatistikleriyle simüle edilmiş bir hayat · Tosun Style', W / 2, H - 60);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) { toast('Kart oluşturulamadı.'); return; }
  const file = new File([blob], `dogum-piyangosu-${r.born.iso.toLowerCase()}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text: `${r.born.f} ${r.name}: ${r.age} yaş. “${r.epitaph}”` }); return; }
  } catch (err) { if (err?.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Kart indirildi.');
}

// ---------- Geçmiş ve kaynaklar ----------

function historyScreen() {
  const h = history();
  const countries = new Set(h.map((x) => x.iso));
  const avg = h.length ? h.reduce((s, x) => s + (x.span ?? x.age), 0) / h.length : 0;
  const longest = h.reduce((m, x) => ((x.span ?? 0) > (m?.span ?? -1) ? x : m), null);
  return [
    el('section', { class: 'card', 'data-testid': 'history' },
      el('h2', {}, '📜 Geçmiş hayatlar'),
      h.length ? el('div', { class: 'ls-summary' },
        el('div', {}, el('b', {}, String(h.length)), el('small', {}, 'hayat')),
        el('div', {}, el('b', {}, String(countries.size)), el('small', {}, 'farklı ülke')),
        el('div', {}, el('b', {}, fmt(avg, 1)), el('small', {}, 'ortalama ömür')),
        el('div', {}, el('b', {}, longest ? `${longest.f} ${longest.age}` : '–'), el('small', {}, 'en uzun'))) : null,
      h.length ? el('ol', { class: 'ls-hist' }, h.map((x) => el('li', {},
        el('span', { class: 'ls-hflag', 'aria-hidden': 'true' }, x.f),
        el('span', { class: 'ls-htext' }, el('b', {}, x.name), el('small', {}, `${x.n}${x.df && x.df !== x.f ? ` → ${x.df}` : ''} · ${x.cause ?? ''}`)),
        el('span', { class: 'ls-hage' }, `${x.age}`, el('small', {}, ` / ${fmt(x.le, 0)}`)))))
        : el('p', { class: 'hint' }, 'Henüz hiç yaşamadın. 🎲'),
      h.length ? el('p', { class: 'hint' }, 'Sağdaki sayı: yaşadığın yıl / doğduğun ülkenin ortalaması. Son 20 hayat bu cihazda saklanır.') : null),
    el('div', { class: 'row center' },
      el('button', { type: 'button', class: 'btn primary', disabled: !world, onclick: newLife }, '🎲 Yeni hayat'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => go('intro') }, '← Geri'),
      h.length ? el('button', { type: 'button', class: 'btn link', onclick: () => { if (confirm('Geçmiş silinsin mi?')) { store.set(HISTORY_KEY, []); render(); } } }, 'Geçmişi sil') : null),
  ];
}

const SOURCES = [
  ['Dünya Bankası, World Development Indicators', 'https://data.worldbank.org', 'CC BY 4.0', 'Nüfus, doğum hızı, yaşam beklentisi, bebek ve 5 yaş altı ölümü (UN WPP, UN IGME), GSYH (SAGP), Gini, eğitim (UNESCO UIS), işgücü ve işsizlik (ILO), tütün ve diyabet (WHO, IDF), aşılar, sıtma, tüberküloz, su ve elektrik erişimi, çocuk evliliği (UNICEF), anne ölümü, trafik, cinayet (UNODC), intihar, ölüm nedeni payları (WHO GHE 2019), göçmen stoku, afetlerden etkilenen nüfus.'],
  ['Our World in Data — eğitim yılı (Lee & Lee 2016)', 'https://ourworldindata.org/grapher/mean-years-of-schooling-long-run', 'CC BY 4.0', 'Ortalama eğitim yılı.'],
  ['Our World in Data — World Happiness Report (Cantril merdiveni)', 'https://ourworldindata.org/grapher/happiness-cantril-ladder', 'CC BY 4.0', 'Keyif stat\'ının ülke tabanı.'],
  ['Our World in Data — UN DESA International Migrant Stock', 'https://ourworldindata.org/grapher/migrant-populations', 'CC BY 4.0 (UN DESA: CC BY 3.0 IGO)', 'Yurt dışında yaşayan doğumluların payı → göç olasılığı.'],
  ['Our World in Data — UCDP silahlı çatışma ölümleri', 'https://ourworldindata.org/grapher/deaths-in-armed-conflicts-by-country', 'CC BY 4.0', 'Son 3 tam yılın ortalaması.'],
  ['Our World in Data — kaba boşanma hızı (BM, OECD)', 'https://ourworldindata.org/grapher/divorces-per-1000-people', 'CC BY 4.0', '45 ülkede var; diğerleri bölge ortalaması (tahmini).'],
];

function sourcesScreen() {
  const est = world ? world.countries.filter((c) => c.est?.length).length : 0;
  const lit = Object.values(sim.LIT).filter((x) => x.note);
  return [
    el('section', { class: 'card ls-sources', 'data-testid': 'sources' },
      el('h2', {}, '📚 Kaynaklar'),
      el('p', {}, 'Bu oyundaki her olasılık gerçek bir veriden ya da yayımlanmış bir araştırma ortalamasından türetilir. Sadece renk katan küçük anlar (ilk adım, sivilce, ekşi maya…) sonuçları değiştirmez.'),
      el('ul', { class: 'ls-src' }, SOURCES.map(([name, url, lic, what]) => el('li', {},
        el('a', { href: url, target: '_blank', rel: 'noopener' }, name), el('small', {}, ` · ${lic}`), el('p', {}, what)))),
      el('h3', {}, 'Araştırmalardan alınan etkiler'),
      el('ul', { class: 'ls-lit' }, lit.map((x) => el('li', { class: x.varsayim ? 'ls-varsayim' : '' }, x.note))),
      el('h3', {}, 'Model notları'),
      el('ul', { class: 'howto' },
        el('li', {}, 'Ömür: 0 yaş = bebek ölüm hızı, 1–4 yaş = 5 yaş altı ölümden kalan, 5 yaş üstü Gompertz–Makeham eğrisi. Eğri, her ülke ve cinsiyet için doğumda beklenen yaşamı ve WHO ölüm nedeni paylarını (bulaşıcı / bulaşıcı olmayan / yaralanma) birlikte tutturacak şekilde ayarlanır.'),
        el('li', {}, 'Sigara, diyabet gibi kişisel riskler, ülke ortalaması değişmeyecek şekilde normalize edilir: sigara içmeyen biri ülke ortalamasından biraz daha uzun yaşar.'),
        el('li', {}, 'Statlar gösterimdir: Sağlık yaş ve kişisel riskten, Varlık gelir modelinden (eğitimin getirisi %9/yıl, kuşaklar arası esneklik 0,5), Bilgi okul yılından türetilir.'),
        el('li', {}, `Eksik veriler Dünya Bankası bölge ortalamasıyla dolduruldu ve “tahmini” işaretlendi (${est} ülkede en az bir alan).`),
        el('li', {}, '“Varsayım” yazan etkiler doğrudan veriye dayanmaz; bilerek küçük tutuldu.'),
        world ? el('li', {}, `Veri derleme tarihi: ${world.data.built}. Yeniden üretmek için: node scripts/lifesim-build.mjs`) : null)),
    el('div', { class: 'row center' }, el('button', { type: 'button', class: 'btn ghost', onclick: () => go(L?.alive === false ? 'end' : 'intro') }, '← Geri')),
  ];
}

function go(next) {
  screen = next;
  render();
  root?.scrollIntoView?.({ block: 'start' });
}

// ---------- Kabuk ----------

function ensureCss() {
  if (document.getElementById('lifesim-css')) return;
  document.head.append(el('link', { id: 'lifesim-css', rel: 'stylesheet', href: 'games/lifesim.css' }));
  // Bayrak emojileri Windows'ta harf olarak görünür; Google Fonts'taki Noto Color Emoji (unicode-range ile parça parça) yedek yazı tipi
  document.head.append(el('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap' }));
}

let onVis = null;

export function enter() {
  root = $('game-lifesim');
  ensureCss();
  reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const sp = store.get(SPEED_KEY, 1);
  speed = SPEEDS.includes(sp) ? sp : 1;
  if (screen === 'play' && L?.alive) paused = true; // geri dönünce duraklatılmış başla
  render();
  ensureWorld().then(() => { if (screen === 'intro' || screen === 'sources') render(); }).catch(() => { toast('Veriler yüklenemedi. Sayfayı yenile.'); });
  onVis = () => { if (document.hidden && screen === 'play' && !paused) { paused = true; stopClock(); renderHeader(); } };
  document.addEventListener('visibilitychange', onVis);
}

export function leave() {
  stopClock();
  document.removeEventListener('visibilitychange', onVis);
  root = null;
}
