// 🔗 Bağlantı Avı — tek ve çok oyunculu ekranların ortak parçaları: kişi dizini, fotoğraf/baş harf avatarı, kişi kartı,
// zincir görünümü, arama sayfası (Türkçe duyarsız), ipuçları, puan dökümü. Kurallar: PLAN.md §4.12.
// Kişi dizini sadece ad/yıl/açıklama/alan taşır; bağlantılar sunucuda (her adım sunucuya sorulur).
import { el } from '../ui.js';
import { CATS, HINT_COST, MAX_CHAIN, diffById, fmtClock, fmtYears, indexEntries, search } from '../baglanti-math.js';

export const HOW_TO = [
  'Üstte BAŞLANGIÇ, altta HEDEF kişi var. Aralarına, her biri bir öncekiyle BAĞLANTILI kişiler ekleyerek zincir kur.',
  'Bağlantı: eş, anne/baba/çocuk, kardeş, hoca/öğrenci, tahtta/görevde ardıl, aynı takımda oynadılar (aynı yıllarda), aynı film/dizi, aynı grup, düet, şarkısını yazdı, aynı seçim, aynı muharebe, etkilendi…',
  '➕ Kişi ekle → adını yaz (Türkçe karakter şart değil: "ataturk", "inonu" da olur) → seç. Bağlıysa kart nedeniyle birlikte eklenir; değilse "Bağlantı yok" (yanlış deneme sayılır, adım sayılmaz).',
  'Son eklediğin kişi hedefle bağlantılıysa zincir kendiliğinden tamamlanır. ✕ ile bir adımı (ve sonrasını) silebilirsin.',
  'Puan: en kısa zincir 1000. Fazladan her ara kişi −150, yanlış deneme −25, ipucu (baş harf −100, alan −50), ilk 1 dakikadan sonra her 10 sn −5.',
  'Bitince en kısa yol fotoğraflı ve nedenleriyle gösterilir. Veri: Wikidata (CC0), fotoğraflar Wikimedia Commons.',
];

// ---------- Stil ----------
export function ensureCss() {
  if (document.getElementById('baglanti-css')) return;
  document.head.append(el('link', { id: 'baglanti-css', rel: 'stylesheet', href: 'games/baglanti.css' }));
}

// ---------- Kişi dizini ----------
let indexPromise = null;
let entries = [];
let byQ = new Map();

export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('/api/baglanti/people')
      .then((res) => { if (!res.ok) throw new Error('Kişi listesi alınamadı.'); return res.json(); })
      .then((j) => {
        entries = indexEntries(j.people ?? []);
        byQ = new Map(entries.map((e) => [e.q, e]));
        return entries;
      });
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

export const person = (q) => byQ.get(q) ?? { q, name: 'Bilinmeyen kişi', alt: '', b: null, d: null, desc: '', cats: [], photo: false };
export const findPeople = (query, limit = 8) => search(entries, query, limit);

// ---------- Avatar ----------
const hueOf = (q) => { let h = 0; for (const ch of String(q)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

export function initials(name) {
  const words = String(name ?? '').split(/[\s-]+/).filter((w) => w && !/^[IVXLC]+\.?$/.test(w) && !/^\d+\.?$/.test(w) && !/^(von|van|de|da|bin|b\.|el|al)$/i.test(w));
  const pick = words.length > 1 ? [words[0], words.at(-1)] : words;
  return pick.map((w) => [...w][0]).join('').toLocaleUpperCase('tr') || '?';
}

// Fotoğraf varsa /api/baglanti/photo/<qid> (sunucu vekili); yoksa ya da yüklenemezse renkli baş harf.
export function avatar(p, size = 'm') {
  const box = el('div', { class: `bg-av bg-av-${size}`, style: `--h:${hueOf(p.q)}`, 'aria-hidden': 'true' }, el('span', { class: 'bg-av-txt' }, initials(p.name)));
  if (p.photo) {
    const img = el('img', { src: `/api/baglanti/photo/${p.q}`, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => box.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

const catBadges = (p) => (p.cats ?? []).slice(0, 2).map((c) => el('span', { class: 'bg-cat', title: CATS[c]?.[1] ?? '' }, CATS[c]?.[0] ?? ''));

// ---------- Kişi kartı ----------
// role: start | target | step | mini
export function personCard(q, { role = 'step', onRemove = null, isNew = false } = {}) {
  const p = person(q);
  const years = fmtYears(p.b, p.d);
  return el('div', { class: `bg-person bg-${role}${isNew ? ' bg-new' : ''}`, 'data-q': q },
    avatar(p, role === 'mini' ? 's' : role === 'step' ? 'm' : 'l'),
    el('div', { class: 'bg-person-txt' },
      role === 'start' ? el('span', { class: 'bg-role' }, '🚩 Başlangıç') : role === 'target' ? el('span', { class: 'bg-role' }, '🎯 Hedef') : null,
      el('b', { class: 'bg-name' }, p.name, ...catBadges(p)),
      years ? el('span', { class: 'bg-years' }, years) : null,
      role !== 'mini' && p.desc ? el('span', { class: 'bg-desc' }, p.desc) : null),
    onRemove ? el('button', { type: 'button', class: 'bg-x', 'aria-label': `${p.name} ve sonrasını çıkar`, title: 'Bu adımı ve sonrasını çıkar', onclick: onRemove }, '✕') : null);
}

// İki kart arasındaki bağlantı çizgisi + nedeni.
export function connector(label, state = 'ok') {
  return el('div', { class: `bg-link bg-link-${state}` },
    el('span', { class: 'bg-link-line' }),
    label ? el('span', { class: 'bg-link-chip' }, el('span', { class: 'bg-link-ico' }, label.e), ` ${label.t}`) : el('span', { class: 'bg-link-chip muted' }, state === 'gap' ? '⋯ henüz bağlanmadı' : '⋯'));
}

// Zincir: başlangıç → adımlar → (ekle) → hedef. steps: [{ q, e, t }], final: hedefe son bağlantı (bitince).
export function chainView({ start, target, steps, final = null, editable = false, onAdd = null, onRemove = null, newIndex = -1, compact = false, busy = false }) {
  const role = compact ? 'mini' : 'step';
  const nodes = [personCard(start, { role: compact ? 'mini' : 'start' })];
  steps.forEach((s, i) => {
    nodes.push(connector(s, 'ok'));
    nodes.push(personCard(s.q, { role, isNew: i === newIndex, onRemove: editable && onRemove ? () => onRemove(i) : null }));
  });
  if (editable && onAdd) {
    nodes.push(connector(null, 'pending'));
    const full = steps.length >= MAX_CHAIN;
    nodes.push(el('button', { type: 'button', class: 'bg-add', disabled: busy || full, onclick: onAdd, 'data-testid': 'bg-add' },
      full ? `En fazla ${MAX_CHAIN} ara kişi` : '➕ Kişi ekle'));
  }
  nodes.push(final ? connector(final, 'final') : connector(null, 'gap'));
  nodes.push(personCard(target, { role: compact ? 'mini' : 'target' }));
  return el('div', { class: `bg-chain${compact ? ' compact' : ''}` }, nodes);
}

// ---------- Arama sayfası ----------
// Tam ekran katman (body'ye eklenir; lobi ekranı yeniden çizilse de açık kalır). onPick(q) → Promise<{ ok }>.
let sheet = null;

export function closeSheet() {
  if (!sheet) return;
  sheet.node.remove();
  document.body.classList.remove('bg-noscroll');
  sheet = null;
}

export const sheetOpen = () => Boolean(sheet);

export function openSheet({ from, target, onPick, exclude = [] }) {
  closeSheet();
  const fromP = person(from);
  const input = el('input', {
    type: 'search', class: 'bg-search', placeholder: 'Kişi ara (ör. tarkan, inonu, messi)…', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Kişi ara', 'data-testid': 'bg-search',
  });
  const msg = el('div', { class: 'bg-sheet-msg', 'aria-live': 'polite' });
  const list = el('ul', { class: 'bg-results', role: 'listbox' });
  const ex = new Set(exclude);
  let busy = false;
  const draw = () => {
    const q = input.value;
    if (!q.trim()) { list.replaceChildren(el('li', { class: 'bg-res-empty' }, '✍️ Bir ad yazmaya başla.')); return; }
    const hits = findPeople(q, 8);
    if (!hits.length) { list.replaceChildren(el('li', { class: 'bg-res-empty' }, '🤷 Listede yok. Başka yazımı dene (Türkçe/İngilizce ad).')); return; }
    list.replaceChildren(...hits.map((p) => {
      const isTarget = p.q === target;
      const used = ex.has(p.q);
      return el('li', {},
        el('button', {
          type: 'button', class: `bg-res${isTarget ? ' target' : ''}`, disabled: used || busy, 'data-q': p.q, role: 'option',
          onclick: () => pick(p.q),
        },
        avatar(p, 's'),
        el('span', { class: 'bg-res-txt' },
          el('b', {}, p.name, isTarget ? el('span', { class: 'bg-tag' }, '🎯 hedef') : null, used ? el('span', { class: 'bg-tag' }, 'zincirde') : null),
          el('small', {}, [fmtYears(p.b, p.d), p.desc].filter(Boolean).join(' · ')))));
    }));
  };
  const pick = async (q) => {
    if (busy) return;
    busy = true;
    node.classList.add('busy');
    msg.className = 'bg-sheet-msg';
    msg.textContent = '⏳ Bakılıyor…';
    draw();
    let r;
    try { r = await onPick(q); } catch (err) { r = { ok: false, error: err.message }; }
    if (sheet?.node !== node) return; // bu arada kapandı
    busy = false;
    node.classList.remove('busy');
    if (r?.ok) { closeSheet(); return; }
    if (r?.error) { msg.className = 'bg-sheet-msg bad'; msg.textContent = `⚠️ ${r.error}`; draw(); return; }
    const p = person(q);
    msg.className = 'bg-sheet-msg bad';
    msg.textContent = `✋ Bağlantı yok: ${p.name} ↔ ${fromP.name}${Number.isFinite(r?.wrong) ? ` · yanlış deneme: ${r.wrong}` : ''}`;
    node.classList.remove('bg-shake');
    void node.offsetWidth; // animasyonu yeniden başlat
    node.classList.add('bg-shake');
    navigator.vibrate?.(120);
    input.select();
    draw();
  };
  input.addEventListener('input', () => { msg.textContent = ''; msg.className = 'bg-sheet-msg'; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector('.bg-res:not(:disabled)'); if (first) first.click(); }
    if (e.key === 'Escape') closeSheet();
  });
  const node = el('div', { class: 'bg-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Kişi ekle', 'data-testid': 'bg-sheet' },
    el('div', { class: 'bg-sheet-head' },
      el('div', { class: 'bg-sheet-from' }, avatar(fromP, 's'), el('span', {}, 'Kim bağlı: ', el('b', {}, fromP.name), ' ?')),
      el('button', { type: 'button', class: 'btn small ghost', onclick: closeSheet, 'aria-label': 'Kapat' }, '✕')),
    input, msg, list);
  document.body.append(node);
  document.body.classList.add('bg-noscroll');
  sheet = { node, input };
  draw();
  setTimeout(() => input.focus(), 30);
  return sheet;
}

// ---------- Bilgi, ipucu, sonuç ----------

export function statsBar({ run, clockNode = null }) {
  return el('div', { class: 'bg-stats' },
    el('span', { title: 'Ara kişi' }, `🔗 ${run.chain.length}`),
    el('span', { title: 'En kısa zincirdeki ara kişi sayısı' }, `🏁 en kısa ${run.opt}`),
    el('span', { class: run.wrong ? 'bad' : '', title: 'Yanlış deneme' }, `❌ ${run.wrong}`),
    clockNode ? el('span', { title: 'Süre' }, '⏱️ ', clockNode) : null);
}

// Yerel saatle akan süre (sunucunun verdiği geçen süreden başlar).
export function liveClock(elapsedMs) {
  const t0 = Date.now() - elapsedMs;
  const node = el('span', { class: 'bg-clock' }, fmtClock(elapsedMs));
  const tick = () => {
    if (!node.isConnected && node.dataset.on) return;
    node.dataset.on = '1';
    node.textContent = fmtClock(Date.now() - t0);
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
  return node;
}

export function hintsCard({ run, onHint, busy = false }) {
  const end = run.chain.length ? run.chain.at(-1).q : run.start;
  const usedHere = (k) => run.hints.some((h) => h.end === end && h.k === k);
  return el('section', { class: 'card bg-hints' },
    el('h2', {}, '💡 İpucu'),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn small', disabled: busy || usedHere('letter'), onclick: () => onHint('letter'), 'data-testid': 'bg-hint-letter' }, `🔤 Baş harf (−${HINT_COST.letter})`),
      el('button', { type: 'button', class: 'btn small', disabled: busy || usedHere('field'), onclick: () => onHint('field'), 'data-testid': 'bg-hint-field' }, `🧭 Alan (−${HINT_COST.field})`)),
    run.hints.length ? el('ul', { class: 'bg-hint-list' }, run.hints.map((h) => el('li', { class: h.end === end ? 'now' : 'old' }, h.text))) : el('p', { class: 'hint' }, 'İpucu, zincirin şu anki ucundan hedefe giden en kısa yoldaki SIRADAKİ kişi hakkındadır.'));
}

export function breakdown(run) {
  const r = run.result;
  const lines = [
    [`Zincir: ${run.chain.length} ara kişi (en kısa ${run.opt})`, r.base],
    r.wrongPen ? [`Yanlış deneme ×${run.wrong}`, -r.wrongPen] : null,
    r.hintPen ? [`İpucu ×${run.hints.length}`, -r.hintPen] : null,
    r.timePen ? [`Süre ${fmtClock(r.ms)}`, -r.timePen] : null,
  ].filter(Boolean);
  return el('ul', { class: 'bg-break' }, lines.map(([k, v]) => el('li', {}, el('span', {}, k), el('b', { class: v < 0 ? 'bad' : '' }, v > 0 ? `+${v}` : String(v)))));
}

export const diffLabel = (id) => { const d = diffById(id); return `${d.name} · ${d.hint}`; };

export function resultCard({ run, headline }) {
  const r = run.result;
  return el('section', { class: 'card center bg-result' },
    headline ? el('div', { class: 'hint' }, headline) : null,
    el('div', { class: 'bg-title-icon' }, r.title.icon),
    el('h2', { class: 'bg-title' }, run.gaveUp ? 'Pes ettin' : r.title.name),
    el('div', { class: 'bg-total' }, String(r.score), el('small', {}, ' / 1000')),
    run.gaveUp ? el('p', { class: 'hint' }, 'Zincir tamamlanmadı. En kısa yol aşağıda.') : breakdown(run));
}

export function shareText({ headLine, run }) {
  const s = person(run.start).name;
  const t = person(run.target).name;
  if (run.gaveUp) return `${headLine}\n${s} ➜ ${t}\n🏳️ pes ettim`;
  return `${headLine} · ${run.result.score}/1000\n${s} ➜ ${t}\n🔗 ${run.chain.length} ara kişi (en kısa ${run.opt}) · ❌ ${run.wrong} · 💡 ${run.hints.length} · ⏱️ ${fmtClock(run.result.ms)}`;
}

export async function share(text, toast) {
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Sonuç kopyalandı.'); }
  } catch { /* iptal */ }
}
