// 🔗 Bağlantı Avı — kişi grafiği oluşturucu (çevrimdışı, elle çalıştırılır; sunucu bunu çalıştırmaz).
//
//   node scripts/baglanti-build.mjs   → content/baglanti/{people,edges,puzzles}.json
//
// Kaynak: Wikidata (CC0). Sorgular Wikidata'nın SPARQL uç noktasına gider; varsayılan olarak QLever'in Wikidata aynası
// (qlever.cs.uni-freiburg.de, aynı veri, "insan + site bağlantısı sayısı" taraması WDQS'te 60 sn'yi aşıyor). BG_SPARQL ile
// başka uç nokta (ör. https://query.wikidata.org/sparql) verilebilir. Fotoğraflar: P18 (Commons dosya adı) → küçük resim
// adresi sunucuda hesaplanır, görseller commit'lenmez (sunucu vekili çeker, üst veriyi siler, önbellekler).
//
// Kişiler: dünya genelinde en çok Vikipedi diline sahip insanlar + Türkiye/Osmanlı vatandaşı tr.wikipedia maddeli insanlar
// + Süper Lig'de oynamış tanınmış yabancı futbolcular. Bağlantılar (sadece kümedeki kişiler arası): eş, ebeveyn/çocuk,
// kardeş, akraba, partner, hoca/öğrenci (doktora danışmanı dahil), görevde/tahtta ardıl-selef, etkilenme, aynı müzik grubu,
// takım arkadaşlığı (aynı takımda en az 1 yıl çakışma; milli takımlar dahil), aynı film/dizi kadrosu, yönetmen-oyuncu,
// aynı seçimde aday. Ayrıntı: PLAN.md §4.12.
//
// Ağ nazik: tek sıra + aralık (BG_GAP_MS), hata/429'da geri çekilme, yanıtlar BG_CACHE klasöründe saklanır.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'content', 'baglanti');
const CACHE = process.env.BG_CACHE || join(tmpdir(), 'bg-build-cache');
const ENDPOINT = process.env.BG_SPARQL || 'https://qlever.cs.uni-freiburg.de/api/wikidata';
const UA = 'TosunStyleGames/1.0 (https://github.com/erdeemt/TosunStyleShazam; offline people graph builder) node';
const GAP_MS = Number(process.env.BG_GAP_MS) || 1500;
const GLOBAL_N = 3000; // dünya: en çok dil sürümü olan insanlar
const TR_N = 1350; // Türkiye/Osmanlı
const SL_N = 220; // Süper Lig'in tanınmış yabancıları
const POP_N = 450; // Türkiye popüler kültür (oyuncu, şarkıcı, futbolcu…)
const CHUNK = 400;
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

const PREFIX = `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#> PREFIX schema: <http://schema.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX p: <http://www.wikidata.org/prop/> PREFIX ps: <http://www.wikidata.org/prop/statement/> PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
`;

async function sparql(query) {
  const body = `query=${encodeURIComponent(PREFIX + query)}`;
  const key = createHash('sha1').update(`${ENDPOINT}\n${body}`).digest('hex');
  const file = join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 7; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let status = 0;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        body,
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(180_000),
      });
      status = res.status;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      const json = JSON.parse(text);
      const rows = json.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
      writeFileSync(file, JSON.stringify(rows));
      return rows;
    } catch (err) {
      const backoff = Math.min(120_000, 4000 * 2 ** attempt);
      console.warn(`  ! ${status} ${String(err.message).slice(0, 100)} — ${backoff / 1000} sn bekle`);
      await sleep(backoff);
    }
  }
  throw new Error('SPARQL alınamadı');
}

const qid = (uri) => (uri ?? '').replace('http://www.wikidata.org/entity/', '');
const values = (ids) => ids.map((q) => `wd:${q}`).join(' ');
const chunks = (arr, n = CHUNK) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function perChunk(ids, build) {
  const out = [];
  const parts = chunks(ids);
  for (const [i, part] of parts.entries()) {
    process.stdout.write(`\r    ${i + 1}/${parts.length}`);
    out.push(...await sparql(build(values(part))));
  }
  process.stdout.write('\n');
  return out;
}

// Wikidata RDF yılı: 0 ve öncesi astronomik (−68 = MÖ 69). Burada da astronomik saklanır; arayüz MÖ'ye çevirir.
function yearOf(v) {
  if (!v) return null;
  const m = /^(-?)(\d{1,6})-/.exec(v);
  if (!m) return null;
  const y = Number(m[2]) * (m[1] ? -1 : 1);
  return Number.isFinite(y) ? y : null;
}

// ---------- Alanlar (ipucu + açıklama yedeği) ----------
// Sıra önceliktir: hükümdar > futbolcu > sporcu > müzisyen > oyuncu > yönetmen > siyasetçi > asker > bilim > yazar > filozof > sanatçı > din > iş.
export const CATS = [
  ['monarch', '👑', 'hükümdar', /\b(monarch|emperor|empress|king|queen regnant|sultan|pharaoh|tsar|czar|shah|caliph|sovereign|khan|kaiser)\b/i],
  ['football', '⚽', 'futbolcu', /\b(association football player|footballer|football manager|soccer)\b/i],
  ['sport', '🏅', 'sporcu', /\b(basketball|tennis|athlete|boxer|wrestler|swimmer|racing driver|cyclist|sprinter|runner|volleyball|chess player|weightlifter|golfer|skier|gymnast|martial|cricketer|baseball|american football|ice hockey|sport shooter|bodybuilder|mixed martial|judoka|fencer|formula one)\b/i],
  ['music', '🎵', 'müzisyen', /\b(singer|musician|composer|rapper|guitarist|pianist|songwriter|drummer|bassist|violinist|record producer|disc jockey|conductor|lyricist)\b/i],
  ['actor', '🎬', 'oyuncu', /\b(actor|actress|comedian|television presenter|model)\b/i],
  ['director', '🎥', 'yönetmen', /\b(film director|filmmaker|screenwriter|film producer)\b/i],
  ['politics', '🏛️', 'siyasetçi', /\b(politician|statesman|stateswoman|diplomat|head of state|president|prime minister|lawyer|jurist|revolutionary|activist|civil servant)\b/i],
  ['military', '⚔️', 'asker', /\b(military|general|officer|soldier|admiral|commander|military leader|military personnel)\b/i],
  ['science', '🔬', 'bilim insanı', /\b(physicist|chemist|mathematician|scientist|biologist|astronomer|inventor|engineer|physician|economist|psychologist|geologist|naturalist|astronaut|computer scientist|historian|sociologist|anthropologist|geographer|explorer)\b/i],
  ['writer', '✍️', 'yazar', /\b(writer|poet|novelist|playwright|journalist|author|essayist|translator|dramatist|historian)\b/i],
  ['philosophy', '🤔', 'düşünür', /\b(philosopher|theologian)\b/i],
  ['art', '🎨', 'sanatçı', /\b(painter|sculptor|artist|architect|photographer|designer|illustrator|cartoonist)\b/i],
  ['religion', '🕌', 'din insanı', /\b(priest|imam|pope|bishop|cleric|prophet|saint|religious leader|monk|rabbi|preacher|sheikh|missionary)\b/i],
  ['business', '💼', 'iş insanı', /\b(businessperson|entrepreneur|business magnate|investor|executive|businessman|businesswoman|industrialist|banker)\b/i],
];

function catsOf(occLabels, posLabels) {
  const text = occLabels.join(' | ');
  const out = [];
  if (posLabels.some((l) => CATS[0][3].test(l)) || CATS[0][3].test(text)) out.push('monarch');
  for (const [id, , , re] of CATS.slice(1)) if (re.test(text)) out.push(id);
  return out.slice(0, 3);
}

// ---------- 1) Kişi kümesi ----------

async function candidates() {
  console.log('1) Kişi adayları');
  const global = await sparql('SELECT ?p ?sl WHERE { ?p wdt:P31 wd:Q5 . ?p wikibase:sitelinks ?sl . FILTER(?sl >= 55) }');
  const tr = await sparql(`SELECT DISTINCT ?p ?sl WHERE { ?p wdt:P31 wd:Q5 . VALUES ?c0 { wd:Q43 wd:Q12560 } ?p wdt:P27 ?c0 .
    ?a schema:about ?p ; schema:isPartOf <https://tr.wikipedia.org/> . ?p wikibase:sitelinks ?sl . FILTER(?sl >= 6) }`);
  const sl = await sparql(`SELECT DISTINCT ?p ?sl WHERE { ?club wdt:P118 wd:Q485568 . ?p wdt:P54 ?club . ?p wdt:P31 wd:Q5 .
    ?a schema:about ?p ; schema:isPartOf <https://tr.wikipedia.org/> . ?p wikibase:sitelinks ?sl . FILTER(?sl >= 20) }`);
  // Türkiye popüler kültür (oyuncu, şarkıcı, futbolcu…): site bağlantısı az olsa da tanınan isimler
  const pop = await sparql(`SELECT DISTINCT ?p ?sl WHERE { ?p wdt:P31 wd:Q5 . ?p wdt:P27 wd:Q43 . ?p wdt:P106 ?o .
    VALUES ?o { wd:Q33999 wd:Q10800557 wd:Q10798782 wd:Q177220 wd:Q639669 wd:Q488205 wd:Q2252262 wd:Q245068 wd:Q937857 wd:Q3665646 wd:Q15117302 wd:Q2526255 wd:Q36834 }
    ?a schema:about ?p ; schema:isPartOf <https://tr.wikipedia.org/> . ?p wikibase:sitelinks ?sl . FILTER(?sl >= 4) }`);
  const top = (rows, n) => [...new Map(rows.map((r) => [qid(r.p), Number(r.sl)])).entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const set = new Map();
  for (const [q, s] of top(global, GLOBAL_N)) set.set(q, { fame: s, origin: 'global' });
  for (const [q, s] of top(tr, TR_N)) if (!set.has(q)) set.set(q, { fame: s, origin: 'tr' });
  // Popüler kültür ve Süper Lig: kümede OLMAYANLARDAN en ünlü n kişi (en ünlüleri zaten Türkiye listesinde)
  const addNew = (rows, n, origin) => { let k = 0; for (const [q, s] of top(rows, Infinity)) { if (k >= n) break; if (!set.has(q)) { set.set(q, { fame: s, origin }); k++; } } return k; };
  const popN = addNew(pop, POP_N, 'trpop');
  const slN = addNew(sl, SL_N, 'superlig');
  console.log(`   dünya ${Math.min(GLOBAL_N, global.length)}, Türkiye ${Math.min(TR_N, tr.length)}, popüler kültür +${popN}, Süper Lig +${slN} → ${set.size} aday`);
  return set;
}

// ---------- 2) Kişi bilgileri ----------

function commonsFile(v) {
  if (!v) return null;
  const m = /Special:FilePath\/(.+)$/.exec(v);
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return null; }
  name = name.replace(/ /g, '_');
  return /\.(jpe?g|png)$/i.test(name) ? name : null;
}

async function details(ids) {
  console.log('2) Kişi bilgileri');
  const rows = await perChunk(ids, (v) => `SELECT ?p ?trl ?enl ?trd ?end ?b ?d ?img ?g ?trw WHERE { VALUES ?p { ${v} }
    OPTIONAL { ?p rdfs:label ?trl . FILTER(LANG(?trl) = "tr") } OPTIONAL { ?p rdfs:label ?enl . FILTER(LANG(?enl) = "en") }
    OPTIONAL { ?p schema:description ?trd . FILTER(LANG(?trd) = "tr") } OPTIONAL { ?p schema:description ?end . FILTER(LANG(?end) = "en") }
    OPTIONAL { ?p wdt:P569 ?b } OPTIONAL { ?p wdt:P570 ?d } OPTIONAL { ?p wdt:P18 ?img } OPTIONAL { ?p wdt:P21 ?g }
    OPTIONAL { ?art schema:about ?p ; schema:isPartOf <https://tr.wikipedia.org/> ; schema:name ?trw } }`);
  const info = new Map();
  for (const r of rows) {
    const q = qid(r.p);
    const cur = info.get(q) ?? {};
    cur.trl ??= r.trl; cur.enl ??= r.enl; cur.trd ??= r.trd; cur.end ??= r.end; cur.trw ??= r.trw;
    cur.b ??= yearOf(r.b); cur.d ??= yearOf(r.d);
    cur.img ??= commonsFile(r.img);
    cur.g ??= r.g ? (qid(r.g) === 'Q6581072' || qid(r.g) === 'Q1052281' ? 'f' : qid(r.g) === 'Q6581097' || qid(r.g) === 'Q2449503' ? 'm' : null) : null;
    info.set(q, cur);
  }
  console.log('   meslekler');
  const occ = await perChunk(ids, (v) => `SELECT ?p ?ol WHERE { VALUES ?p { ${v} } ?p wdt:P106 ?o . ?o rdfs:label ?ol . FILTER(LANG(?ol) = "en") }`);
  for (const r of occ) (info.get(qid(r.p)).occ ??= []).push(r.ol);
  console.log('   diğer adlar');
  const als = await perChunk(ids, (v) => `SELECT ?p ?al WHERE { VALUES ?p { ${v} } ?p skos:altLabel ?al . FILTER(LANG(?al) = "tr" || LANG(?al) = "en") }`);
  for (const r of als) { const cur = info.get(qid(r.p)); if (r.al.length <= 40 && (cur.al ??= []).length < 6 && !cur.al.includes(r.al)) cur.al.push(r.al); }
  console.log('   vatandaşlık');
  const cit = await perChunk(ids, (v) => `SELECT ?p ?c WHERE { VALUES ?p { ${v} } ?p wdt:P27 ?c . VALUES ?c { wd:Q43 wd:Q12560 } }`);
  for (const r of cit) info.get(qid(r.p)).turkish = true;
  return info;
}

// ---------- 3) Bağlantılar ----------

export const TYPES = ['spouse', 'parent', 'sibling', 'relative', 'partner', 'teacher', 'successor', 'influence', 'band', 'team', 'cast', 'director', 'election',
  'coach', 'founder', 'battle', 'duet', 'song', 'associate', 'significant'];
// Aynı çift için birden fazla bağlantı varsa gösterilecek olan (öncelik sırası)
// Oyunculuk olmayan yapım türleri (P31/P136, alt sınıflarıyla): belgesel, TV özel bölümü (buluşma/reunion), ödül töreni, talk show,
// realite, konser filmi, müzik videosu, varyete, yarışma programı, haber/spor yayını.
const NON_ACTING = ['Q93204', 'Q1261214', 'Q4504495', 'Q622812', 'Q182415', 'Q193977', 'Q430525', 'Q336181', 'Q846662',
  'Q133731271', 'Q1358344'].map((x) => `wd:${x}`).join(' ');
const PRIORITY = ['spouse', 'parent', 'sibling', 'partner', 'band', 'duet', 'song', 'team', 'coach', 'director', 'cast', 'founder', 'successor', 'teacher',
  'battle', 'associate', 'relative', 'significant', 'election', 'influence'];

async function edgesOf(ids, people) {
  console.log('3) Bağlantılar');
  const inSet = (q) => people.has(q);
  const raw = []; // { a, b, type, ctx?, y1?, y2? } — yönlü tiplerde a→b anlamı TYPES açıklamasında
  const direct = await perChunk(ids, (v) => `SELECT ?a ?prop ?b WHERE { VALUES ?a { ${v} }
    VALUES ?prop { wdt:P26 wdt:P22 wdt:P25 wdt:P40 wdt:P3373 wdt:P1038 wdt:P1066 wdt:P802 wdt:P184 wdt:P185 wdt:P737 wdt:P451 wdt:P1327 } ?a ?prop ?b . }`);
  for (const r of direct) {
    const a = qid(r.a), b = qid(r.b);
    if (a === b || !inSet(b)) continue;
    const prop = r.prop.split('/').pop();
    if (prop === 'P26') raw.push({ a, b, type: 'spouse' });
    else if (prop === 'P22' || prop === 'P25') raw.push({ a, b, type: 'parent' }); // a'nın ebeveyni b
    else if (prop === 'P40') raw.push({ a: b, b: a, type: 'parent' });
    else if (prop === 'P3373') raw.push({ a, b, type: 'sibling' });
    else if (prop === 'P1038') raw.push({ a, b, type: 'relative' });
    else if (prop === 'P451') raw.push({ a, b, type: 'partner' });
    else if (prop === 'P1066' || prop === 'P184') raw.push({ a, b, type: 'teacher' }); // a'nın hocası b
    else if (prop === 'P802' || prop === 'P185') raw.push({ a: b, b: a, type: 'teacher' });
    else if (prop === 'P737') raw.push({ a, b, type: 'influence' }); // a, b'den etkilendi
    else if (prop === 'P1327') raw.push({ a, b, type: 'associate' });
  }

  console.log('   görevde ardıl/selef');
  const succ = await perChunk(ids, (v) => `SELECT ?a ?pos ?nb ?pb ?s ?e WHERE { VALUES ?a { ${v} } ?a p:P39 ?st . ?st ps:P39 ?pos .
    OPTIONAL { ?st pq:P1366 ?nb } OPTIONAL { ?st pq:P1365 ?pb } OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } FILTER(BOUND(?nb) || BOUND(?pb)) }`);
  const posLabelsNeeded = new Set();
  for (const r of succ) {
    const a = qid(r.a), pos = qid(r.pos);
    const nb = qid(r.nb), pb = qid(r.pb);
    if (nb && nb !== a && inSet(nb)) { raw.push({ a, b: nb, type: 'successor', ctx: pos, y1: yearOf(r.e) }); posLabelsNeeded.add(pos); }
    if (pb && pb !== a && inSet(pb)) { raw.push({ a: pb, b: a, type: 'successor', ctx: pos, y1: yearOf(r.s) }); posLabelsNeeded.add(pos); }
  }
  const positionsHeld = await perChunk(ids, (v) => `SELECT DISTINCT ?a ?pl WHERE { VALUES ?a { ${v} } ?a wdt:P39 ?pos . ?pos rdfs:label ?pl . FILTER(LANG(?pl) = "en") }`);
  for (const r of positionsHeld) (people.get(qid(r.a)).pos ??= []).push(r.pl);

  console.log('   takımlar');
  const teams = await perChunk(ids, (v) => `SELECT ?a ?team ?s ?e WHERE { VALUES ?a { ${v} } ?a p:P54 ?st . ?st ps:P54 ?team .
    OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } }`);
  const byTeam = new Map();
  for (const r of teams) {
    const a = qid(r.a), team = qid(r.team);
    let s = yearOf(r.s), e = yearOf(r.e);
    const died = people.get(a)?.d;
    if (s == null) continue;
    if (e == null) { if (died == null && s >= 2014) e = 2026; else continue; } // süren sözleşme (yaşayan, yakın başlangıç)
    if (e < s || e - s > 22) continue; // ters ya da şüpheli uzun kayıt
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push({ a, s, e });
  }
  const teamIds = new Set();
  for (const [team, list] of byTeam) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        if (x.a === y.a) continue;
        const s = Math.max(x.s, y.s), e = Math.min(x.e, y.e);
        if (e - s < 1) continue; // en az bir sezon (≥ 1 yıl) çakışma
        raw.push({ a: x.a, b: y.a, type: 'team', ctx: team, y1: s, y2: e });
        teamIds.add(team);
      }
    }
  }

  console.log('   teknik direktörler');
  const coaches = await perChunk(ids, (v) => `SELECT ?a ?team ?s ?e WHERE { VALUES ?a { ${v} } ?a p:P6087 ?st . ?st ps:P6087 ?team .
    OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } }`);
  for (const r of coaches) {
    const c = qid(r.a), team = qid(r.team);
    const s = yearOf(r.s);
    let e = yearOf(r.e);
    if (s == null) continue;
    if (e == null) { if (people.get(c)?.d == null && s >= 2020) e = 2026; else continue; }
    if (e < s || e - s > 15) continue;
    for (const pl of byTeam.get(team) ?? []) {
      if (pl.a === c) continue;
      const os = Math.max(s, pl.s), oe = Math.min(e, pl.e);
      if (oe - os < 1) continue;
      raw.push({ a: c, b: pl.a, type: 'coach', ctx: team, y1: os, y2: oe });
      teamIds.add(team);
    }
  }

  console.log('   müzik grupları');
  const groupRows = [
    ...await perChunk(ids, (v) => `SELECT ?a ?g WHERE { VALUES ?a { ${v} } ?a wdt:P463 ?g . }`),
    ...await perChunk(ids, (v) => `SELECT ?a ?g WHERE { VALUES ?a { ${v} } ?g wdt:P527 ?a . }`),
  ];
  const byGroup = new Map();
  for (const r of groupRows) {
    const g = qid(r.g);
    if (!byGroup.has(g)) byGroup.set(g, new Set());
    byGroup.get(g).add(qid(r.a));
  }
  const multiGroups = [...byGroup].filter(([, s]) => s.size >= 2 && s.size <= 12).map(([g]) => g);
  const musical = new Set((await perChunk(multiGroups, (v) => `SELECT DISTINCT ?g WHERE { VALUES ?g { ${v} } ?g wdt:P31/wdt:P279* wd:Q215380 . }`)).map((r) => qid(r.g)));
  const groupIds = new Set();
  for (const g of multiGroups) {
    if (!musical.has(g)) continue;
    const members = [...byGroup.get(g)];
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) raw.push({ a: members[i], b: members[j], type: 'band', ctx: g });
    groupIds.add(g);
  }

  console.log('   film/dizi kadroları + yönetmenler');
  // Kadro satırları niteleyicileriyle: karakter rolü (P453), "olarak geçer" (P1932), rol (P3831). "Kendisi", arşiv görüntüsü,
  // konuk/kamera önü görünümü oyunculuk sayılmaz.
  const castRows = await perChunk(ids, (v) => `SELECT ?w ?a ?rl ?as ?ol WHERE { VALUES ?a { ${v} } ?w p:P161 ?st . ?st ps:P161 ?a .
    OPTIONAL { ?st pq:P453 ?role . ?role rdfs:label ?rl . FILTER(LANG(?rl) = "en") }
    OPTIONAL { ?st pq:P1932 ?as }
    OPTIONAL { ?st pq:P3831 ?obj . ?obj rdfs:label ?ol . FILTER(LANG(?ol) = "en") } }`);
  const SELF_ROLE = /^(himself|herself|themselves|themself|self|oneself|itself|narrator)$|archive footage|archival|cameo|guest appearance|uncredited|as himself|as herself/i;
  const selfPairs = new Set();
  for (const r of castRows) {
    if ((r.rl && SELF_ROLE.test(r.rl.trim())) || (r.ol && SELF_ROLE.test(r.ol.trim())) || (r.as && /\b(himself|herself|themselves|self|kendisi|kendi)\b/i.test(r.as))) selfPairs.add(`${qid(r.w)}|${qid(r.a)}`);
  }
  const cast = castRows.filter((r) => !selfPairs.has(`${qid(r.w)}|${qid(r.a)}`));
  console.log(`   kendisi/arşiv rolü olarak ayıklanan kadro satırı: ${selfPairs.size}`);
  const dirs = await perChunk(ids, (v) => `SELECT ?w ?a WHERE { VALUES ?a { ${v} } ?w wdt:P57 ?a . }`);
  const byWork = new Map();
  for (const r of cast) {
    const w = qid(r.w);
    if (!byWork.has(w)) byWork.set(w, new Set());
    byWork.get(w).add(qid(r.a));
  }
  const dirOf = new Map();
  for (const r of dirs) {
    const w = qid(r.w);
    if (!dirOf.has(w)) dirOf.set(w, new Set());
    dirOf.get(w).add(qid(r.a));
  }
  const workCands = [...new Set([...[...byWork].filter(([, s]) => s.size >= 2).map(([w]) => w), ...[...dirOf.keys()].filter((w) => byWork.has(w))])];
  const workInfo = new Map();
  const wRows = await perChunk(workCands, (v) => `SELECT ?w ?sl ?kind ?doc ?date ?start WHERE { VALUES ?w { ${v} } ?w wikibase:sitelinks ?sl .
    OPTIONAL { ?w wdt:P31/wdt:P279* ?k . VALUES (?k ?kind) { (wd:Q11424 "film") (wd:Q5398426 "series") (wd:Q15416 "series") } }
    OPTIONAL { ?w wdt:P31|wdt:P136 ?dk0 . ?dk0 wdt:P279* ?dk . VALUES ?dk { ${NON_ACTING} } BIND(1 AS ?doc) }
    OPTIONAL { ?w wdt:P577 ?date } OPTIONAL { ?w wdt:P580 ?start } }`);
  for (const r of wRows) {
    const cur = workInfo.get(qid(r.w)) ?? { sl: Number(r.sl), kind: null, doc: false, year: null };
    if (r.kind === 'film' || (!cur.kind && r.kind)) cur.kind = r.kind;
    if (r.doc) cur.doc = true;
    for (const y of [yearOf(r.date), yearOf(r.start)]) if (y != null && (cur.year == null || y < cur.year)) cur.year = y;
    workInfo.set(qid(r.w), cur);
  }
  // Yapım çıktığında yaşıyor (arşiv görüntüsü değil) ve doğmuş olmalı
  const aliveAt = (q, y) => { const p = people.get(q); return y == null || ((p?.b == null || p.b <= y) && (p?.d == null || p.d >= y - 1)); };
  const workIds = new Set();
  for (const w of workCands) {
    const info = workInfo.get(w);
    if (!info?.kind || info.doc) continue; // sadece film/dizi; belgesel değil
    const members = [...(byWork.get(w) ?? [])].filter((m) => aliveAt(m, info.year));
    const turkish = members.some((m) => people.get(m)?.turkish);
    if (info.sl < (turkish ? 1 : 3)) continue; // birkaç dilde maddesi olan (tanınmış) yapımlar; Türk yapımlarında tr maddesi yeter
    if (members.length <= 15) {
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) { raw.push({ a: members[i], b: members[j], type: 'cast', ctx: w }); workIds.add(w); }
    }
    for (const d of dirOf.get(w) ?? []) for (const m of members.slice(0, 40)) if (m !== d && aliveAt(d, info.year)) { raw.push({ a: d, b: m, type: 'director', ctx: w }); workIds.add(w); }
  }

  console.log('   seçimler');
  const elections = await perChunk(ids, (v) => `SELECT ?el ?a WHERE { VALUES ?a { ${v} } ?el wdt:P726 ?a . }`);
  const byEl = new Map();
  for (const r of elections) {
    const el = qid(r.el);
    if (!byEl.has(el)) byEl.set(el, new Set());
    byEl.get(el).add(qid(r.a));
  }
  const elIds = new Set();
  for (const [el, set] of byEl) {
    if (set.size < 2 || set.size > 8) continue;
    const m = [...set];
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) raw.push({ a: m[i], b: m[j], type: 'election', ctx: el });
    elIds.add(el);
  }

  const groupEdges = (rows, type, kindFilter, min = 2, max = 8) => {
    const by = new Map();
    for (const r of rows) {
      const x = qid(r.x);
      if (kindFilter && !kindFilter.has(x)) continue;
      if (!by.has(x)) by.set(x, new Set());
      by.get(x).add(qid(r.a));
    }
    const used = new Set();
    for (const [x, set] of by) {
      if (set.size < min || set.size > max) continue;
      const m = [...set];
      for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) raw.push({ a: m[i], b: m[j], type, ctx: x });
      used.add(x);
    }
    return used;
  };
  console.log('   kurucular');
  const founded = await perChunk(ids, (v) => `SELECT ?x ?a WHERE { VALUES ?a { ${v} } ?x wdt:P112 ?a . }`);
  const orgIds = groupEdges(founded, 'founder', null, 2, 6);
  console.log('   muharebeler');
  const battleRows = [
    ...await perChunk(ids, (v) => `SELECT ?x ?a WHERE { VALUES ?a { ${v} } ?a wdt:P1344 ?x . }`),
    ...await perChunk(ids, (v) => `SELECT ?x ?a WHERE { VALUES ?a { ${v} } ?x wdt:P710 ?a . }`),
  ];
  const evCands = [...new Set(battleRows.map((r) => qid(r.x)))];
  const battles = new Set((await perChunk(evCands, (v) => `SELECT DISTINCT ?x WHERE { VALUES ?x { ${v} } ?x wdt:P31/wdt:P279* ?k . VALUES ?k { wd:Q178561 wd:Q188055 } }`)).map((r) => qid(r.x)));
  const battleIds = groupEdges(battleRows, 'battle', battles, 2, 8);
  console.log('   şarkılar');
  const songRows = await perChunk(ids, (v) => `SELECT ?x ?a ?r WHERE { VALUES ?a { ${v} } ?x ?r ?a . VALUES ?r { wdt:P175 wdt:P86 wdt:P676 }
    ?x wdt:P31 ?k . VALUES ?k { wd:Q7366 wd:Q134556 } }`);
  const perf = songRows.filter((r) => r.r.endsWith('P175'));
  const songIds = groupEdges(perf, 'duet', null, 2, 4);
  const performersOf = new Map();
  for (const r of perf) { const x = qid(r.x); if (!performersOf.has(x)) performersOf.set(x, new Set()); performersOf.get(x).add(qid(r.a)); }
  for (const r of songRows) {
    if (r.r.endsWith('P175')) continue;
    const x = qid(r.x), w = qid(r.a);
    for (const pf of performersOf.get(x) ?? []) if (pf !== w) { raw.push({ a: w, b: pf, type: 'song', ctx: x }); songIds.add(x); } // a yazdı, b söyledi
  }
  console.log('   önemli kişiler (rolüyle)');
  const sig = await perChunk(ids, (v) => `SELECT ?a ?b ?role WHERE { VALUES ?a { ${v} } ?a p:P3342 ?st . ?st ps:P3342 ?b . ?st pq:P3831 ?role . }`);
  const roleIds = new Set();
  for (const r of sig) {
    const a = qid(r.a), b = qid(r.b);
    if (a === b || !inSet(b)) continue;
    raw.push({ a, b, type: 'significant', ctx: qid(r.role) }); // b, a'nın hayatında "rol" olarak geçer
    roleIds.add(qid(r.role));
  }

  // Bağlam öğelerinin (takım, grup, yapım, makam, seçim) adları + takımların spor dalı + yapımların yılı
  const ctxIds = [...new Set([...teamIds, ...groupIds, ...workIds, ...posLabelsNeeded, ...elIds, ...orgIds, ...battleIds, ...songIds, ...roleIds])];
  console.log(`   bağlam öğeleri: ${ctxIds.length}`);
  const cRows = await perChunk(ctxIds, (v) => `SELECT ?x ?trl ?enl ?sport ?date WHERE { VALUES ?x { ${v} }
    OPTIONAL { ?x rdfs:label ?trl . FILTER(LANG(?trl) = "tr") } OPTIONAL { ?x rdfs:label ?enl . FILTER(LANG(?enl) = "en") }
    OPTIONAL { ?x wdt:P641 ?sport } OPTIONAL { ?x wdt:P577 ?date } }`);
  const ctx = new Map();
  for (const r of cRows) {
    const x = qid(r.x);
    const cur = ctx.get(x) ?? {};
    cur.trl ??= r.trl; cur.enl ??= r.enl;
    if (r.sport) { const sp = qid(r.sport); cur.sport = cur.sport === 'Q2736' ? cur.sport : sp; }
    const y = yearOf(r.date);
    if (y != null && (cur.year == null || y < cur.year)) cur.year = y;
    ctx.set(x, cur);
  }
  return { raw, ctx, workInfo, rows: { direct, groupRows, cast, songRows } };
}

// ---------- 4) Birleştirme + yapbozlar ----------

const MONARCH_POS = /\b(monarch|emperor|empress|king|queen|sultan|pharaoh|tsar|czar|shah|caliph|khan|kaiser|padishah|throne|prince of|duke of|pope)\b/i;

function cleanLabel(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Bozuk hükümdar adları (Wikidata tr etiketi): "X. LouisVI" → İngilizce "Louis XVI of France"'tan "XVI. Louis".
export function fixRegnal(label, en) {
  const glued = /^([IVXLC]+)\.\s+(\S+?)([IVXLC]+)$/.exec(label);
  const doubled = /^([IVXLC]+\.)\s+\1/.test(label) || /^[IVXLC]+\.\s+[IVXLC]+\.\s/.test(label);
  if (!glued && !doubled) return label;
  const e = /^(.+?) ([IVXLC]+)(?: (?:of|the) .+)?$/.exec(en ?? '');
  if (e) return `${e[2]}. ${e[1]}`;
  if (glued) return `${glued[1]}${glued[3]}. ${glued[2]}`;
  return label.replace(/^([IVXLC]+\.)\s+\1\s*/, '$1 ');
}

// Açıklamada kalan İngilizce sözcükler (Türkçe açıklamaya karışmış) için küçük sözlük; çevrilemeyen İngilizce → alan adları.
const EN_WORDS = {
  american: 'Amerikalı', british: 'Britanyalı', english: 'İngiliz', french: 'Fransız', german: 'Alman', italian: 'İtalyan', spanish: 'İspanyol',
  russian: 'Rus', brazilian: 'Brezilyalı', argentine: 'Arjantinli', portuguese: 'Portekizli', dutch: 'Hollandalı', greek: 'Yunan', turkish: 'Türk',
  canadian: 'Kanadalı', australian: 'Avustralyalı', irish: 'İrlandalı', scottish: 'İskoç', japanese: 'Japon', chinese: 'Çinli', indian: 'Hintli',
  and: 've', actor: 'oyuncu', actress: 'oyuncu', singer: 'şarkıcı', footballer: 'futbolcu', politician: 'siyasetçi', writer: 'yazar',
  novelist: 'romancı', poet: 'şair', painter: 'ressam', printmaker: 'baskı sanatçısı', composer: 'besteci', musician: 'müzisyen',
  songwriter: 'söz yazarı', rapper: 'rapçi', director: 'yönetmen', producer: 'yapımcı', player: 'oyuncu', businessman: 'iş insanı',
  businesswoman: 'iş insanı', scientist: 'bilim insanı', philosopher: 'filozof', physicist: 'fizikçi', chemist: 'kimyager',
  mathematician: 'matematikçi', journalist: 'gazeteci', model: 'model', comedian: 'komedyen', king: 'kral', queen: 'kraliçe',
  emperor: 'imparator', general: 'general', basketball: 'basketbol', tennis: 'tenis', football: 'futbol', manager: 'teknik direktör', coach: 'antrenör',
};
const EN_LEFT = /\b(the|of|and|from|who|was|is|born|actor|actress|singer|footballer|politician|player|writer|American|British|English|French|German)\b/;
export function trDesc(d) {
  if (!EN_LEFT.test(d)) return d;
  const out = d.replace(/[A-Za-z]+/g, (w) => EN_WORDS[w.toLowerCase()] ?? w);
  return EN_LEFT.test(out) ? '' : out;
}

// Makam adları (ardıl/selef bağlamı) Türkçe etiketi yoksa: yaygın kalıplar + ülke adları.
const COUNTRY_TR = {
  France: 'Fransa', Spain: 'İspanya', England: 'İngiltere', Ireland: 'İrlanda', Scotland: 'İskoçya', Egypt: 'Mısır', Philippines: 'Filipinler',
  Brazil: 'Brezilya', Portugal: 'Portekiz', Italy: 'İtalya', Prussia: 'Prusya', Sweden: 'İsveç', Denmark: 'Danimarka', Norway: 'Norveç',
  Russia: 'Rusya', Poland: 'Polonya', Hungary: 'Macaristan', Austria: 'Avusturya', Germany: 'Almanya', Israel: 'İsrail', Iran: 'İran',
  Iraq: 'Irak', India: 'Hindistan', Pakistan: 'Pakistan', Greece: 'Yunanistan', 'United Kingdom': 'Birleşik Krallık', 'United States': 'ABD',
  Japan: 'Japonya', China: 'Çin', Mexico: 'Meksika', Argentina: 'Arjantin', Chile: 'Şili', Cuba: 'Küba', Syria: 'Suriye', Jordan: 'Ürdün',
  'Saudi Arabia': 'Suudi Arabistan', Afghanistan: 'Afganistan', Bulgaria: 'Bulgaristan', Romania: 'Romanya', Serbia: 'Sırbistan',
  Belgium: 'Belçika', Netherlands: 'Hollanda', Navarre: 'Navarra', Castile: 'Kastilya', Aragon: 'Aragon', Bohemia: 'Bohemya', Bavaria: 'Bavyera',
  Saxony: 'Saksonya', Naples: 'Napoli', Sicily: 'Sicilya', Sardinia: 'Sardinya', Hanover: 'Hannover', Georgia: 'Gürcistan', Armenia: 'Ermenistan',
  Azerbaijan: 'Azerbaycan', Ukraine: 'Ukrayna', Lebanon: 'Lübnan', Libya: 'Libya', Tunisia: 'Tunus', Algeria: 'Cezayir', Morocco: 'Fas',
  'South Africa': 'Güney Afrika', Indonesia: 'Endonezya', Venezuela: 'Venezuela', Colombia: 'Kolombiya', Peru: 'Peru', Canada: 'Kanada',
  Australia: 'Avustralya', 'New Zealand': 'Yeni Zelanda', 'Soviet Union': 'Sovyetler Birliği', USSR: 'SSCB', Rome: 'Roma', Wales: 'Galler',
};
const POS_TR = [
  [/^(?:King) of (.+)$/i, 'Kralı'], [/^(?:Queen) of (.+)$/i, 'Kraliçesi'], [/^monarch of (.+)$/i, 'hükümdarı'], [/^Emperor of (.+)$/i, 'İmparatoru'],
  [/^Empress of (.+)$/i, 'İmparatoriçesi'], [/^President of (.+)$/i, 'Devlet Başkanı'], [/^Vice President of (.+)$/i, 'Başkan Yardımcısı'],
  [/^Prime Minister of (.+)$/i, 'Başbakanı'], [/^Chancellor of (.+)$/i, 'Şansölyesi'], [/^Duke of (.+)$/i, 'Dükü'], [/^Prince of (.+)$/i, 'Prensi'],
  [/^Secretary General of (.+)$/i, 'Genel Sekreteri'], [/^Chairman of (.+)$/i, 'Başkanı'], [/^Governor of (.+)$/i, 'Valisi'],
];
const POS_FIXED = { 'Minister of Finance': 'Maliye Bakanı', 'Minister of Foreign Affairs': 'Dışişleri Bakanı', 'Minister of Defence': 'Savunma Bakanı',
  'Minister of the Interior': 'İçişleri Bakanı', 'Leader of the Opposition': 'Muhalefet Lideri', Pope: 'Papa', 'First Lord of the Treasury': 'Hazine Birinci Lordu' };
export function trPosition(en) {
  if (POS_FIXED[en]) return POS_FIXED[en];
  for (const [re, word] of POS_TR) {
    const m = re.exec(en);
    if (!m) continue;
    const parts = m[1].replace(/^the /i, '').split(/ and /);
    const tr = parts.map((x) => COUNTRY_TR[x] ?? (/^[A-Z][\p{L}-]+$/u.test(x) ? x : null));
    if (tr.every(Boolean)) return `${tr.join(' ve ')} ${word}`;
  }
  return en;
}

function shortDesc(p, cats) {
  let d = trDesc(cleanLabel(p.trd));
  if (d && d.length <= 70) return d;
  if (d) return `${d.slice(0, 67).replace(/[\s,;:]+\S*$/, '')}…`;
  const names = cats.map((c) => CATS.find((x) => x[0] === c)[2]);
  return names.length ? names.join(', ').replace(/^./, (c) => c.toLocaleUpperCase('tr')) : '';
}

function bfs(adj, src, n) {
  const dist = new Int16Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  dist[src] = 0;
  const q = [src];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const v of adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; prev[v] = u; q.push(v); }
  }
  return { dist, prev, order: q };
}

// raw kenarlarında (qid) en büyük bağlı bileşen
function mainComponent(raw, people) {
  const nb = new Map();
  for (const e of raw) {
    if (!people.has(e.a) || !people.has(e.b) || e.a === e.b) continue;
    if (!nb.has(e.a)) nb.set(e.a, []);
    if (!nb.has(e.b)) nb.set(e.b, []);
    nb.get(e.a).push(e.b); nb.get(e.b).push(e.a);
  }
  const seen = new Set();
  let best = new Set();
  for (const q0 of nb.keys()) {
    if (seen.has(q0)) continue;
    const comp = new Set([q0]); seen.add(q0);
    const queue = [q0];
    for (let h = 0; h < queue.length; h++) for (const x of nb.get(queue[h])) if (!seen.has(x)) { seen.add(x); comp.add(x); queue.push(x); }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

// Ana ağa bağlı olmayan Türkiye kişileri (ör. Barış Manço) için kümede OLMAYAN gerçek komşular: doğrudan ilişkiler, aynı grubun
// üyeleri, aynı film/dizinin kadrosu, aynı şarkının sanatçı/yazarları. Sadece tr maddeli insanlar; en çok 800. Bağlantı uydurulmaz:
// adaylar sonra normal bağlantı sorgularından geçer ve sadece gerçekten köprü olanlar kalır.
async function bridgeCandidates(people, raw, rows) {
  const main0 = mainComponent(raw, people);
  const lonely = new Set([...people].filter(([q, v]) => v.turkish && !main0.has(q)).map(([q]) => q));
  console.log(`   ana ağ dışında Türkiye'den ${lonely.size} kişi — köprü aranıyor`);
  const cand = new Map(); // qid -> kaç yalnıza komşu
  const add = (q) => { if (!people.has(q)) cand.set(q, (cand.get(q) ?? 0) + 1); };
  for (const r of rows.direct) if (lonely.has(qid(r.a))) add(qid(r.b));
  const groups = [...new Set(rows.groupRows.filter((r) => lonely.has(qid(r.a))).map((r) => qid(r.g)))];
  const works = [...new Set(rows.cast.filter((r) => lonely.has(qid(r.a))).map((r) => qid(r.w)))];
  const songs = [...new Set(rows.songRows.filter((r) => lonely.has(qid(r.a))).map((r) => qid(r.x)))];
  if (groups.length) for (const r of await perChunk(groups, (v) => `SELECT ?m WHERE { VALUES ?g { ${v} } { ?m wdt:P463 ?g } UNION { ?g wdt:P527 ?m } }`)) add(qid(r.m));
  if (works.length) for (const r of await perChunk(works, (v) => `SELECT ?m WHERE { VALUES ?w { ${v} } ?w wdt:P161 ?m . }`)) add(qid(r.m));
  if (songs.length) for (const r of await perChunk(songs, (v) => `SELECT ?m WHERE { VALUES ?x { ${v} } VALUES ?r { wdt:P175 wdt:P86 wdt:P676 } ?x ?r ?m . }`)) add(qid(r.m));
  const ids = [...cand.keys()].filter((q) => /^Q\d+$/.test(q));
  if (!ids.length) return [];
  const ok = await perChunk(ids, (v) => `SELECT DISTINCT ?p WHERE { VALUES ?p { ${v} } ?p wdt:P31 wd:Q5 . ?a schema:about ?p ; schema:isPartOf <https://tr.wikipedia.org/> . }`);
  const out = ok.map((r) => qid(r.p)).sort((a, b) => (cand.get(b) ?? 0) - (cand.get(a) ?? 0)).slice(0, 800);
  console.log(`   köprü adayı: ${out.length}`);
  return out;
}

async function main() {
  const set = await candidates();
  const ids = [...set.keys()];
  const info = await details(ids);
  for (const [q, v] of info) Object.assign(v, set.get(q));
  // Adı olmayanlar (ne Türkçe ne İngilizce etiket) atılır
  for (const q of ids) { const v = info.get(q); if (!v || !(v.trl || v.enl || v.trw)) { set.delete(q); info.delete(q); } }
  let people = info;
  let { raw, ctx, workInfo, rows } = await edgesOf([...people.keys()], people);
  const bridgeIds = await bridgeCandidates(people, raw, rows);
  if (bridgeIds.length) {
    const sl = await perChunk(bridgeIds, (v) => `SELECT ?p ?sl WHERE { VALUES ?p { ${v} } ?p wikibase:sitelinks ?sl . }`);
    for (const r of sl) set.set(qid(r.p), { fame: Number(r.sl), origin: 'bridge' });
    const all = [...people.keys(), ...bridgeIds];
    const info2 = await details(all);
    for (const [q, v] of info2) Object.assign(v, set.get(q));
    for (const q of all) { const v = info2.get(q); if (!v || !(v.trl || v.enl || v.trw)) info2.delete(q); }
    people = info2;
    ({ raw, ctx, workInfo, rows } = await edgesOf([...people.keys()], people));
  }

  // Kişi listesi: ünlüden aza
  // Hiç bağlantısı olmayan kişi zincirde kullanılamaz: kümeden çıkar (aramada çıkıp hep "Bağlantı yok" demesin)
  // Film/dizi bağlantısı sadece ekran insanları (oyuncu, yönetmen, müzisyen) arasında: siyasetçi/yazar/sporcu kadrolarda çoğu
  // zaman arşiv görüntüsü ya da "kendisi" olarak geçiyor (Merkel bir bilimkurgu filminde, Castro bir Hitchcock filminde…).
  for (const v of people.values()) v.cats = catsOf(v.occ ?? [], v.pos ?? []);
  const screen = (q) => { const c = people.get(q)?.cats ?? []; return c.some((x) => x === 'actor' || x === 'director' || x === 'music') && !c.some((x) => x === 'politics' || x === 'monarch' || x === 'military' || x === 'religion'); };
  for (let i = raw.length - 1; i >= 0; i--) {
    const e = raw[i];
    if ((e.type === 'cast' || e.type === 'director') && !(screen(e.a) && screen(e.b))) raw.splice(i, 1);
  }
  // Köprü kişisi sadece gerçekten köprüyse kalır: ana bileşende ve asıl kümeden ana ağa bağlı olmayan birine komşu
  {
    const main0 = mainComponent(raw, people);
    const nb = new Map();
    for (const e of raw) { if (!nb.has(e.a)) nb.set(e.a, new Set()); if (!nb.has(e.b)) nb.set(e.b, new Set()); nb.get(e.a).add(e.b); nb.get(e.b).add(e.a); }
    const before = mainComponent(raw.filter((e) => people.get(e.a)?.origin !== 'bridge' && people.get(e.b)?.origin !== 'bridge'), people);
    const useful = (q) => main0.has(q) && [...(nb.get(q) ?? [])].some((x) => people.get(x)?.origin !== 'bridge' && !before.has(x));
    let dropped = 0;
    for (const [q, v] of people) if (v.origin === 'bridge' && !useful(q)) { people.delete(q); dropped++; }
    const pulled = [...people.values()].filter((v) => v.origin !== 'bridge' && v.turkish).length;
    console.log(`   köprü: ${[...people.values()].filter((v) => v.origin === 'bridge').length} kişi kaldı (${dropped} atıldı)`);
    void pulled;
  }
  const linked = new Set();
  for (const e of raw) if (e.a !== e.b && people.has(e.a) && people.has(e.b)) { linked.add(e.a); linked.add(e.b); }
  console.log(`   bağlantısız ${people.size - linked.size} kişi çıkarıldı`);
  const order = [...people.entries()].filter(([q]) => linked.has(q)).sort((a, b) => b[1].fame - a[1].fame);
  const index = new Map(order.map(([q], i) => [q, i]));
  const peopleOut = order.map(([q, v]) => {
    const cats = catsOf(v.occ ?? [], v.pos ?? []);
    v.cats = cats;
    const name = fixRegnal(cleanLabel(v.trl || v.trw || v.enl), v.enl);
    const alt = cleanLabel(v.enl && v.enl !== name ? v.enl : '');
    return {
      q, n: name, a: alt || undefined, k: (v.al ?? []).filter((x) => x !== name && x !== alt).slice(0, 4).join('|') || undefined, b: v.b ?? null, d: v.d ?? null, s: shortDesc(v, cats), c: cats,
      t: v.turkish ? 1 : 0, g: v.g ?? undefined, f: v.fame, img: v.img ?? undefined,
    };
  });

  // Bağlam metinleri
  const ctxStrings = [];
  const ctxIdx = new Map();
  const ctxText = (id, type) => {
    const c = ctx.get(id);
    if (!c) return -1;
    let label = cleanLabel(c.trl || (type === 'successor' ? trPosition(cleanLabel(c.enl)) : c.enl));
    if (!label) return -1;
    let meta = '';
    if (type === 'song' || type === 'duet') meta = '🎵';
    if (type === 'founder') meta = '🏢';
    if (type === 'battle') meta = '⚔️';
    if (type === 'team' || type === 'coach') meta = c.sport === 'Q2736' ? '⚽' : c.sport === 'Q5372' ? '🏀' : c.sport === 'Q1734' ? '🏐' : c.sport ? '🏅' : '⚽';
    if (type === 'cast' || type === 'director') meta = workInfo.get(id)?.kind === 'series' ? '📺' : '🎬';
    if (type === 'successor') meta = MONARCH_POS.test(c.enl ?? '') ? '👑' : '🏛️';
    if ((type === 'cast' || type === 'director') && c.year != null && !/\d{4}/.test(label)) label = `${label} (${c.year})`;
    const key = `${meta}|${label}`;
    if (!ctxIdx.has(key)) { ctxIdx.set(key, ctxStrings.length); ctxStrings.push(meta ? [meta, label] : [label]); }
    return ctxIdx.get(key);
  };

  const best = new Map(); // "küçük-büyük" -> kenar
  for (const e of raw) {
    const ia = index.get(e.a), ib = index.get(e.b);
    if (ia == null || ib == null || ia === ib) continue;
    const key = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
    const cur = best.get(key);
    if (cur && PRIORITY.indexOf(cur.type) <= PRIORITY.indexOf(e.type)) continue;
    const c = e.ctx ? ctxText(e.ctx, e.type) : -1;
    if (e.ctx && c < 0 && e.type !== 'successor') continue; // adsız bağlam: gösterilemez
    best.set(key, { a: ia, b: ib, type: e.type, c, y1: e.y1 ?? null, y2: e.y2 ?? null });
  }
  const edges = [...best.values()].map((e) => [e.a, e.b, TYPES.indexOf(e.type), e.c, e.y1 ?? 0, e.y2 ?? 0]);
  // Etiketlenemeyen bağlantılar atılınca yalnız kalanlar da çıkar (sıra numaraları yeniden verilir)
  const deg = new Uint32Array(peopleOut.length);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  const remap = new Int32Array(peopleOut.length).fill(-1);
  let kept = 0;
  for (let i = 0; i < peopleOut.length; i++) if (deg[i]) remap[i] = kept++;
  if (kept < peopleOut.length) {
    const keepList = peopleOut.filter((_, i) => deg[i]);
    peopleOut.length = 0;
    peopleOut.push(...keepList);
    for (const e of edges) { e[0] = remap[e[0]]; e[1] = remap[e[1]]; }
  }
  const n = peopleOut.length;
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  // Komşular ünlüden aza (BFS ilk bulduğu yol ünlü kişilerden geçsin)
  for (const list of adj) list.sort((x, y) => x - y);

  // Dev bileşen
  const comp = new Int32Array(n).fill(-1);
  let compN = 0;
  const sizes = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const q = [i]; comp[i] = compN;
    for (let h = 0; h < q.length; h++) for (const v of adj[q[h]]) if (comp[v] < 0) { comp[v] = compN; q.push(v); }
    sizes.push(q.length); compN++;
  }
  const giant = sizes.indexOf(Math.max(...sizes));

  // Yapbozlar: uç kişiler fotoğraflı, tanınmış (dünya ilk ~1500 ya da Türkiye ilk ~450), dev bileşende.
  const trRank = new Map(peopleOut.filter((p) => p.t).map((p, i) => [p.q, i]));
  const endpoint = (i) => {
    const p = peopleOut[i];
    if (!p.img || comp[i] !== giant || adj[i].length < 1) return false;
    return i < 1500 || (trRank.get(p.q) ?? 1e9) < 450;
  };
  const ends = [...Array(n).keys()].filter(endpoint);
  console.log(`4) Yapbozlar: ${ends.length} uç aday`);
  const LENS = { kolay: 3, orta: 4, zor: 5 };
  const pools = { kolay: [], orta: [], zor: [] };
  const seenPairs = new Set();
  const pairType = new Map(edges.map(([a, b, t]) => [a < b ? `${a}-${b}` : `${b}-${a}`, TYPES[t]]));
  const typeOfPair = (a, b) => pairType.get(a < b ? `${a}-${b}` : `${b}-${a}`);
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); })();
  const uses = { kolay: new Map(), orta: new Map(), zor: new Map() };
  const shuffled = [...ends].sort(() => rnd() - 0.5);
  for (const s of shuffled) {
    const { dist, order } = bfs(adj, s, n);
    // Tüm en kısa yollar arasından "sıkıcı" bağlantısı en az olanı: film/dizi 1, etkilenme 2 puan; eşitlikte ünlü komşu
    const cost = new Float64Array(n).fill(Infinity);
    const bestPrev = new Int32Array(n).fill(-1);
    cost[s] = 0;
    for (const v of order) {
      if (v === s) continue;
      for (const u of adj[v]) {
        if (dist[u] !== dist[v] - 1) continue;
        const ty = typeOfPair(u, v);
        const c = cost[u] + (ty === 'cast' || ty === 'director' ? 1 : ty === 'influence' ? 2 : 0);
        if (c < cost[v]) { cost[v] = c; bestPrev[v] = u; }
      }
    }
    const byLen = { kolay: [], orta: [], zor: [] };
    for (const t of ends) {
      if (t === s || seenPairs.has(s < t ? `${s}-${t}` : `${t}-${s}`)) continue;
      for (const [k, L] of Object.entries(LENS)) if (dist[t] === L) byLen[k].push(t);
    }
    for (const [k, list] of Object.entries(byLen)) {
      // Karışık: farklı alan ya da en az 60 yıl fark; aynı alandan ve aynı dönemden iki kişi "kolay ve sıkıcı" sayılır.
      const ps = peopleOut[s];
      const good = list.filter((t) => {
        const pt = peopleOut[t];
        if ((uses[k].get(t) ?? 0) >= 3 || (uses[k].get(s) ?? 0) >= 3) return false;
        const sameCat = ps.c[0] && ps.c[0] === pt.c[0];
        const eraGap = ps.b != null && pt.b != null ? Math.abs(ps.b - pt.b) : 0;
        return !sameCat || eraGap >= 60;
      });
      // Türkiye'den biri varsa öncelik
      const trFirst = (t) => (peopleOut[t].t || ps.t ? 0 : 1);
      const keyed = good.map((t) => [t, trFirst(t), rnd()]).sort((x, y) => x[1] - y[1] || x[2] - y[2]);
      good.splice(0, good.length, ...keyed.map((x) => x[0]));
      let taken = 0;
      for (const t of good) {
        if (taken >= 2) break;
        const path = [];
        for (let v = t; v >= 0; v = bestPrev[v]) path.push(v);
        path.reverse();
        // Çeşitlilik: yolda en çok 2 film/dizi, en çok 1 "etkilendi", en az 1 film dışı bağlantı
        const types = path.slice(1).map((v, i) => typeOfPair(path[i], v));
        const film = types.filter((x) => x === 'cast' || x === 'director').length;
        const infl = types.filter((x) => x === 'influence').length;
        if (film > 2 || infl > 1 || film === types.length) continue;
        taken++;
        pools[k].push([s, t, path]);
        seenPairs.add(s < t ? `${s}-${t}` : `${t}-${s}`);
        uses[k].set(s, (uses[k].get(s) ?? 0) + 1);
        uses[k].set(t, (uses[k].get(t) ?? 0) + 1);
      }
    }
  }
  // Zorluk başına 600: yarısına kadar Türkiye'den uçlu yapbozlar, kalanı diğerleri (karıştırılmış)
  for (const k of Object.keys(pools)) {
    const mix = (l) => l.map((z) => [z, rnd()]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    const tr = mix(pools[k].filter(([s, t]) => peopleOut[s].t || peopleOut[t].t)).slice(0, 300);
    const rest = mix(pools[k].filter(([s, t]) => !(peopleOut[s].t || peopleOut[t].t))).slice(0, 600 - tr.length);
    pools[k] = mix([...tr, ...rest]);
  }

  // ---------- Çıktı ----------
  const meta = {
    source: 'Wikidata (CC0) — https://www.wikidata.org; fotoğraflar Wikimedia Commons (P18)',
    endpoint: ENDPOINT,
    builtAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(join(OUT_DIR, 'people.json'), `${JSON.stringify({ meta, people: peopleOut }).replace(/},{"q"/g, '},\n{"q"')}\n`);
  writeFileSync(join(OUT_DIR, 'edges.json'), `${JSON.stringify({ meta, types: TYPES, ctx: ctxStrings, edges }).replace(/\],\[/g, '],\n[')}\n`);
  writeFileSync(join(OUT_DIR, 'puzzles.json'), `${JSON.stringify({ meta, ...pools }).replace(/\]\],\[/g, ']],\n[')}\n`);

  // ---------- Özet ----------
  const byType = {};
  for (const e of edges) byType[TYPES[e[2]]] = (byType[TYPES[e[2]]] ?? 0) + 1;
  const tr = peopleOut.filter((p) => p.t).length;
  const photos = peopleOut.filter((p) => p.img).length;
  console.log(`Kişi: ${n} (Türkiye/Osmanlı ${tr} = %${Math.round((100 * tr) / n)}), fotoğraflı ${photos} (%${Math.round((100 * photos) / n)})`);
  console.log(`Bağlantı: ${edges.length}`, byType);
  console.log(`Dev bileşen: ${sizes[giant]} kişi; yalnız: ${adj.filter((l) => !l.length).length}`);
  console.log(`Yapboz: kolay ${pools.kolay.length}, orta ${pools.orta.length}, zor ${pools.zor.length}`);
}

// ---------- Test grafiği (TEST_MODE) ----------
// node scripts/baglanti-build.mjs --test-graph → content/baglanti/test-graph.json: gerçek verinin küçük, sabit bir alt grafiği
// (her zorlukta uçları ayrık 6 yapboz + yollarındaki kişiler + aralarındaki gerçek bağlantılar + 8 "çeldirici" ünlü).
// Alt grafikte mesafe ancak artabilir; yol hâlâ var → yapbozların en kısa uzunluğu aynı kalır (yine de doğrulanır).
function testGraph() {
  const P = JSON.parse(readFileSync(join(OUT_DIR, 'people.json'), 'utf8')).people;
  const E = JSON.parse(readFileSync(join(OUT_DIR, 'edges.json'), 'utf8'));
  const Z = JSON.parse(readFileSync(join(OUT_DIR, 'puzzles.json'), 'utf8'));
  const LEN = { kolay: 3, orta: 4, zor: 5 };
  const chosen = {};
  const nodes = new Set();
  for (const k of Object.keys(LEN)) {
    const ends = new Set();
    // Ünlü kişilerden geçenler önce; Türkiye'den biri olan yapbozlar öne
    const ranked = [...Z[k]].sort((x, y) => (P[y[0]].t || P[y[1]].t) - (P[x[0]].t || P[x[1]].t) || Math.max(...x[2]) - Math.max(...y[2]));
    chosen[k] = [];
    for (const z of ranked) {
      if (chosen[k].length >= 6) break;
      if (ends.has(z[0]) || ends.has(z[1])) continue;
      chosen[k].push(z);
      ends.add(z[0]); ends.add(z[1]);
      for (const v of z[2]) nodes.add(v);
    }
  }
  for (let i = 0, extra = 0; extra < 8 && i < P.length; i++) if (!nodes.has(i)) { nodes.add(i); extra++; }
  const keep = [...nodes].sort((x, y) => x - y);
  const map = new Map(keep.map((v, i) => [v, i]));
  const edges = E.edges.filter((e) => map.has(e[0]) && map.has(e[1])).map((e) => [map.get(e[0]), map.get(e[1]), ...e.slice(2)]);
  const usedCtx = [...new Set(edges.map((e) => e[3]).filter((c) => c >= 0))].sort((x, y) => x - y);
  const cmap = new Map(usedCtx.map((c, i) => [c, i]));
  for (const e of edges) if (e[3] >= 0) e[3] = cmap.get(e[3]);
  const people = keep.map((v) => P[v]);
  const adj = people.map(() => []);
  for (const [x, y] of edges) { adj[x].push(y); adj[y].push(x); }
  const puzzles = {};
  for (const [k, list] of Object.entries(chosen)) {
    puzzles[k] = list.map(([s0, t0, path]) => [map.get(s0), map.get(t0), path.map((v) => map.get(v))]);
    for (const [s0, t0] of puzzles[k]) {
      const d = bfs(adj, s0, people.length).dist[t0];
      if (d !== LEN[k]) throw new Error(`test yapbozu ${k} uzunluğu ${d}`);
    }
  }
  const meta = { source: 'Wikidata (CC0) alt grafiği — sadece testler (TEST_MODE)', builtAt: new Date().toISOString().slice(0, 10) };
  writeFileSync(join(OUT_DIR, 'test-graph.json'), `${JSON.stringify({ meta, people, types: E.types, ctx: usedCtx.map((c) => E.ctx[c]), edges, puzzles }, null, 1)}\n`);
  console.log(`test grafiği: ${people.length} kişi, ${edges.length} bağlantı, yapboz ${Object.values(puzzles).map((l) => l.length).join('/')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--test-graph')) testGraph();
  else main().catch((err) => { console.error(err); process.exit(1); });
}
