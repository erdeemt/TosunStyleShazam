// 🎲 Doğum Piyangosu — çevrimdışı veri derleme adımı.
// Açık veri setlerini indirir ve public/data/lifesim.json dosyasını yazar (oyun çalışırken internete çıkmaz).
//   node scripts/lifesim-build.mjs
// Not: Bazı alanlarda (sıtma, çocuk işçiliği, bodurluk, çocuk evliliği) yüksek gelirli/endemik olmayan ülkeler ölçülmez;
// bunlar bölge ortalaması yerine 0 / küçük sabit alır (aşağıda).
// Kaynaklar (hepsi atıf ister; oyundaki "Kaynaklar" ekranında listelenir):
//   - World Bank, World Development Indicators (CC BY 4.0) — api.worldbank.org
//     (WDI'nin kendisi UN WPP, UN IGME, WHO, UNESCO UIS, UNODC, ITU gibi kaynaklardan derlenir)
//   - Our World in Data (CC BY 4.0): ortalama eğitim yılı (Lee & Lee 2016), yaşam memnuniyeti (World Happiness Report),
//     silahlı çatışma ölümleri (UCDP).
// Eksik değerler bölge (Dünya Bankası bölgesi) ortalamasıyla doldurulur ve ülkenin `est` listesine yazılır.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/data/lifesim.json', import.meta.url));
const WB = 'https://api.worldbank.org/v2';

// alan → WDI göstergesi
const WDI = {
  pop: 'SP.POP.TOTL',
  cbr: 'SP.DYN.CBRT.IN', // kaba doğum hızı (binde) → yıllık doğum = nüfus × cbr / 1000
  leM: 'SP.DYN.LE00.MA.IN',
  leF: 'SP.DYN.LE00.FE.IN',
  imrM: 'SP.DYN.IMRT.MA.IN',
  imrF: 'SP.DYN.IMRT.FE.IN',
  u5M: 'SH.DYN.MORT.MA',
  u5F: 'SH.DYN.MORT.FE',
  gdp: 'NY.GDP.PCAP.PP.KD', // kişi başı GSYH, SAGP (sabit uluslararası $)
  gini: 'SI.POV.GINI',
  eys: 'HD.HCI.EYRS', // beklenen okul yılı (İnsan Sermayesi Endeksi)
  ter: 'SE.TER.ENRR', // yükseköğretim brüt okullaşma (%)
  urb: 'SP.URB.TOTL.IN.ZS',
  tfr: 'SP.DYN.TFRT.IN',
  mmr: 'SH.STA.MMRT', // anne ölümü (100 bin canlı doğumda)
  hom: 'VC.IHR.PSRC.P5', // kasten öldürme (100 binde)
  road: 'SH.STA.TRAF.P5', // trafik ölümü (100 binde)
  net: 'IT.NET.USER.ZS', // internet kullanan (%)
  // --- olay olasılıkları için (her olayın "src" alanı bunlardan birine dayanır) ---
  unem: 'SL.UEM.TOTL.ZS', // işsizlik oranı (ILO modellenmiş, %)
  lfpM: 'SL.TLF.CACT.MA.ZS', // işgücüne katılım, erkek (ILO, %)
  lfpF: 'SL.TLF.CACT.FE.ZS', // işgücüne katılım, kadın (ILO, %)
  smkM: 'SH.PRV.SMOK.MA', // tütün kullanımı, erkek (WHO, %)
  smkF: 'SH.PRV.SMOK.FE', // tütün kullanımı, kadın (WHO, %)
  m18: 'SP.M18.2024.FE.ZS', // 18'inden önce evlenen kadınlar (20–24 yaş, UNICEF, %)
  smamM: 'SP.DYN.SMAM.MA', // ilk evlilik ortalama yaşı, erkek (UN)
  smamF: 'SP.DYN.SMAM.FE', // ilk evlilik ortalama yaşı, kadın (UN)
  ado: 'SP.ADO.TFRT', // ergen doğurganlığı (15–19 yaş, binde)
  oos: 'SE.PRM.UNER.ZS', // ilkokul çağında okul dışı çocuk (%)
  cmpP: 'SE.PRM.CMPT.ZS', // ilkokul tamamlama (brüt, %)
  cmpL: 'SE.SEC.CMPT.LO.ZS', // ortaokul tamamlama (brüt, %)
  upE: 'SE.SEC.ENRR.UP', // lise brüt okullaşma (%)
  baA: 'SE.TER.CUAT.BA.ZS', // en az lisans mezunu (25+, %)
  msA: 'SE.TER.CUAT.MS.ZS', // en az yüksek lisans mezunu (25+, %)
  stunt: 'SH.STA.STNT.ZS', // 5 yaş altı bodurluk (%)
  diab: 'SH.STA.DIAB.ZS', // diyabet yaygınlığı (20–79, %)
  mal: 'SH.MLR.INCD.P3', // sıtma insidansı (risk altındaki binde)
  tb: 'SH.TBS.INCD', // tüberküloz insidansı (100 binde)
  dpt: 'SH.IMM.IDPT', // DTP3 aşılama (12–23 ay, %)
  meas: 'SH.IMM.MEAS', // kızamık aşılama (12–23 ay, %)
  elecR: 'EG.ELC.ACCS.RU.ZS', // kırsalda elektriğe erişim (%)
  waterR: 'SH.H2O.BASW.RU.ZS', // kırsalda temel içme suyu (%)
  suiM: 'SH.STA.SUIC.MA.P5', // intihar, erkek (100 binde)
  suiF: 'SH.STA.SUIC.FE.P5', // intihar, kadın (100 binde)
  // Ölüm nedeni payları: 2019 (COVID-19 öncesi; 2021 değerleri salgın ölümleriyle şişkin)
  dCom: 'SH.DTH.COMM.ZS@2019', // ölüm nedeni: bulaşıcı, anne, perinatal, beslenme (% tüm ölümler, WHO GHE)
  dNcd: 'SH.DTH.NCOM.ZS@2019', // ölüm nedeni: bulaşıcı olmayan hastalıklar (%)
  dInj: 'SH.DTH.INJR.ZS@2019', // ölüm nedeni: yaralanmalar (%)
  grow: 'SP.POP.GROW', // nüfus artış hızı (%) → ölüm nedeni paylarını yaş yapısıyla tartmak için (durağan nüfus yaklaşımı)
  disas: 'EN.CLC.MDAT.ZS', // kuraklık/sel/aşırı sıcaktan etkilenen nüfus (yıllık ort. 1990–2009, %)
  clab: 'SL.TLF.0714.ZS', // çalışan çocuklar (7–14 yaş, %)
  netm: 'SM.POP.NETM', // net göç (kişi/yıl)
  imm: 'SM.POP.TOTL.ZS', // uluslararası göçmen stoku (nüfusun %)
};

// alan → OWID grapher CSV (son yıl alınır; çatışma için son 3 yılın ortalaması)
const OWID = {
  mys: { slug: 'mean-years-of-schooling-long-run', col: 'mf_youth_and_adults__15_64_years__average_years_of_education' },
  sat: { slug: 'happiness-cantril-ladder', col: 'cantril_ladder_score' },
  emi: { slug: 'migrant-populations', q: '&metric=emigrants&unit=share', col: 'emigrants_share_of_total_population' }, // yurt dışında yaşayan doğumlular (UN DESA, %)
  div: { slug: 'divorces-per-1000-people', col: 'value__gender_both__indicator_divorce_rate' }, // kaba boşanma hızı (binde)
  war: { slug: 'deaths-in-armed-conflicts-by-country', col: 'number_deaths_ongoing_conflicts__conflict_type_all', avgYears: 3, beforeYear: new Date().getFullYear() },
};

const REGIONS = {
  EAS: 'Doğu Asya ve Pasifik',
  ECS: 'Avrupa ve Orta Asya',
  LCN: 'Latin Amerika ve Karayipler',
  MEA: 'Orta Doğu, Kuzey Afrika, Afganistan ve Pakistan',
  NAC: 'Kuzey Amerika',
  SAS: 'Güney Asya',
  SSF: 'Sahra Altı Afrika',
};

// ICU'nun Türkçe adı tuhaf/uzun olanlar
const NAME_FIX = {
  CD: 'Kongo Demokratik Cumhuriyeti', CG: 'Kongo', CI: 'Fildişi Sahili', US: 'ABD', PS: 'Filistin',
  MM: 'Myanmar', CV: 'Yeşil Burun Adaları', SZ: 'Esvatini', TL: 'Doğu Timor', HK: 'Hong Kong', MO: 'Makao',
  GB: 'Birleşik Krallık', JG: 'Manş Adaları', VC: 'Saint Vincent ve Grenadinler', KN: 'Saint Kitts ve Nevis', ST: 'São Tomé ve Príncipe',
};

const MIN_POP = 90_000;

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'tosun-style-lifesim-build' } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tosun-style-lifesim-build' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// Tırnaklı alanları da anlayan küçük CSV ayrıştırıcı
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function wdi(spec) {
  const [code, date] = spec.split('@');
  const j = await getJson(`${WB}/country/all/indicator/${code}?format=json&per_page=400&${date ? `date=${date}` : 'mrnev=1'}`);
  const out = {};
  for (const r of j[1] ?? []) if (r.value != null && r.countryiso3code) out[r.countryiso3code] = { v: r.value, y: Number(r.date) };
  return out;
}

async function owid({ slug, col, q = '', avgYears = 1, beforeYear = Infinity }) {
  const rows = parseCsv(await getText(`https://ourworldindata.org/grapher/${slug}.csv?v=1&csvType=full&useColumnShortNames=true${q}`));
  const head = rows[0];
  const ci = head.indexOf('code');
  const yi = head.indexOf('year');
  const vi = head.indexOf(col);
  if (vi < 0) throw new Error(`${slug}: ${col} sütunu yok (${head.join(',')})`);
  const byCode = {};
  for (const r of rows.slice(1)) {
    const code = r[ci];
    if (!code || code.startsWith('OWID') || r[vi] === '' || Number(r[yi]) >= beforeYear) continue; // içinde bulunulan yıl eksik olabilir
    (byCode[code] ??= []).push({ y: Number(r[yi]), v: Number(r[vi]) });
  }
  const out = {};
  for (const [code, list] of Object.entries(byCode)) {
    list.sort((a, b) => b.y - a.y);
    const take = list.slice(0, avgYears);
    out[code] = { v: take.reduce((s, x) => s + x.v, 0) / take.length, y: take[0].y };
  }
  return out;
}

const flag = (i2) => String.fromCodePoint(...[...i2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

async function main() {
  console.log('Ülke listesi…');
  const meta = (await getJson(`${WB}/country?format=json&per_page=400`))[1].filter((c) => c.region.id !== 'NA' && REGIONS[c.region.id]);
  const names = new Intl.DisplayNames('tr', { type: 'region' });

  const raw = {};
  for (const [key, code] of Object.entries(WDI)) {
    process.stdout.write(`WDI ${code}… `);
    raw[key] = await wdi(code);
    console.log(Object.keys(raw[key]).length);
  }
  for (const [key, spec] of Object.entries(OWID)) {
    process.stdout.write(`OWID ${spec.slug}… `);
    raw[key] = await owid(spec);
    console.log(Object.keys(raw[key]).length);
  }

  // Ülkeler: nüfusu yeterli ve doğum + yaşam beklentisi bilinen
  const countries = [];
  for (const m of meta) {
    const iso = m.id;
    const pop = raw.pop[iso]?.v;
    if (!pop || pop < MIN_POP || !raw.cbr[iso] || !raw.leM[iso] || !raw.leF[iso]) continue;
    const c = { iso, i2: m.iso2Code, n: NAME_FIX[m.iso2Code] ?? names.of(m.iso2Code), f: flag(m.iso2Code), r: m.region.id };
    c.b = Math.round((pop * raw.cbr[iso].v) / 1000); // yıllık doğum
    c.pop = Math.round(pop);
    c.le = [round(raw.leM[iso].v), round(raw.leF[iso].v)];
    c._v = {};
    for (const key of Object.keys({ ...WDI, ...OWID }).filter((k) => !['pop', 'cbr', 'leM', 'leF'].includes(k))) {
      const v = raw[key][iso]?.v;
      c._v[key] = v == null || Number.isNaN(v) ? null : v;
    }
    // Çatışma ölümleri: sayı → 100 binde; kaynakta olmayan ülke = 0 (UCDP kaydı yok), tahmin sayılmaz
    c._v.war = ((c._v.war ?? 0) / pop) * 1e5;
    // Sıtma: kaynakta olmayan ülke endemik değil → 0 (tahmin sayılmaz)
    if (c._v.mal == null) c._v.mal = 0;
    // Net göç: kişi → binde oran
    if (c._v.netm != null) c._v.netm = (c._v.netm / pop) * 1000;
    // Çocuk işçiliği: yüksek gelirli ülkelerde ölçülmez → 0
    if (c._v.clab == null && (c._v.gdp ?? 0) > 25000) c._v.clab = 0;
    if (c._v.stunt == null && (c._v.gdp ?? 0) > 25000) c._v.stunt = 3; // yüksek gelirli ülkeler: WHO referans dağılımı ~%2–3
    countries.push(c);
  }

  // Bölge ortalamaları (doğum ağırlıklı değil, basit ortalama) ve doldurma
  const fields = Object.keys(countries[0]._v);
  const regionAvg = {};
  for (const r of Object.keys(REGIONS)) {
    regionAvg[r] = {};
    for (const f of fields) {
      const vals = countries.filter((c) => c.r === r && c._v[f] != null).map((c) => c._v[f]);
      const all = countries.filter((c) => c._v[f] != null).map((c) => c._v[f]);
      const use = vals.length >= 2 ? vals : all;
      regionAvg[r][f] = use.reduce((s, x) => s + x, 0) / use.length;
    }
  }
  for (const c of countries) {
    const est = [];
    for (const f of fields) if (c._v[f] == null) {
      // Çocuk evliliği yüksek gelirli ülkelerde neredeyse yok ve UNICEF ölçmüyor: bölge ortalaması yerine %1 (tahmini)
      c._v[f] = f === 'm18' && c._v.gdp > 25000 ? 1 : regionAvg[c.r][f];
      est.push(f);
    }
    // Cinsiyete göre bebek ölümü yoksa (nadiren) toplam yerine bölge ortalaması zaten girdi
    const v = c._v;
    c.imr = [round(v.imrM), round(v.imrF)];
    c.u5 = [round(v.u5M), round(v.u5F)];
    for (const [k, x] of Object.entries(v)) {
      if (/^(imr|u5)[MF]$/.test(k)) continue;
      c[k] = k === 'gdp' || k === 'mmr' ? Math.round(x) : k === 'tfr' || k === 'sat' || k === 'war' || k === 'netm' || k === 'div' ? round(x, 2) : round(x);
    }
    const estKeys = new Set(est.map((f) => f.replace(/[MF]$/, '')));
    if (estKeys.size) c.est = [...estKeys];
    delete c._v;
  }
  countries.sort((a, b) => b.b - a.b);

  const years = (key) => {
    const ys = Object.values(raw[key]).map((x) => x.y);
    return [Math.min(...ys), Math.max(...ys)];
  };
  const out = {
    v: 1,
    built: new Date().toISOString().slice(0, 10),
    regions: REGIONS,
    codes: { ...WDI, ...Object.fromEntries(Object.entries(OWID).map(([k, o]) => [k, `OWID:${o.slug}`])) },
    years: Object.fromEntries(Object.keys({ ...WDI, ...OWID }).map((k) => [k, years(k)])),
    countries,
  };
  mkdirSync(fileURLToPath(new URL('../public/data/', import.meta.url)), { recursive: true });
  const text = JSON.stringify(out);
  writeFileSync(OUT, text);
  const estCount = countries.filter((c) => c.est).length;
  console.log(`\n${countries.length} ülke, ${(text.length / 1024).toFixed(1)} KB → ${OUT}`);
  console.log(`Doğum toplamı: ${(countries.reduce((s, c) => s + c.b, 0) / 1e6).toFixed(1)} milyon/yıl; en az bir tahmini alanı olan ülke: ${estCount}`);
  const missing = {};
  for (const c of countries) for (const f of c.est ?? []) missing[f] = (missing[f] ?? 0) + 1;
  console.log('Bölge ortalamasıyla doldurulan alanlar:', missing);
}

main().catch((err) => { console.error(err); process.exit(1); });
