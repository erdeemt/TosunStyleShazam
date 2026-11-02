// 🎲 Doğum Piyangosu — saf simülasyon çekirdeği (tarayıcı + Node testleri ortak kullanır).
// Tohumdan deterministik: aynı tohum + aynı seçimler = aynı hayat. DOM, saat, Math.random yok.
//
// İlke: her olasılık gerçek bir veriden (public/data/lifesim.json, kaynak kodları "codes" alanında) ya da LIT tablosundaki
// yayımlanmış bir ortalamadan gelir. Doğrudan dayanağı olmayan küçük etkiler "varsayım" olarak işaretlidir.
// - Doğum: ülke ∝ yıllık doğum; cinsiyet 105:100; aile gelir yüzdeliği tekdüze; gelir log-normal(GSYH, Gini).
// - Ölüm: bebek/5 yaş altı ölüm hızı + Gompertz–Makeham; bileşenler WHO ölüm nedeni paylarına ve doğumda beklenen
//   yaşama birlikte kalibre (lifeTable). Kişisel risk çarpanları (sigara, diyabet…) nüfus ortalaması 1 olacak şekilde normalize.
// - Statlar gösterimdir: Sağlık riskten, Varlık gelir modelinden, Bilgi okul yılından türetilir; sonuçları belirlemez.
import { EVENTS, STAGES, stageOf } from './lifesim-events.js';

export const STATS = [
  { key: 'h', icon: '❤️', name: 'Sağlık' },
  { key: 'j', icon: '😊', name: 'Keyif' },
  { key: 'k', icon: '📚', name: 'Bilgi' },
  { key: 'w', icon: '💰', name: 'Varlık' },
];
export { STAGES, EVENTS, stageOf };

// ---------- Rastgelelik (sfc32, durum life.rs içinde → kaydedilebilir) ----------

export function seedState(seed) {
  // cyrb128
  const str = String(seed);
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const s = [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  for (let i = 0; i < 12; i++) sfc(s);
  return s;
}

function sfc(s) {
  let [a, b, c, d] = s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
  return (t >>> 0) / 4294967296;
}

export function rng(state) {
  const r = () => sfc(state);
  return {
    r,
    chance: (p) => sfc(state) < p,
    int: (n) => Math.floor(sfc(state) * n),
    pick: (arr) => arr[Math.floor(sfc(state) * arr.length)],
    normal: () => {
      const u = Math.max(sfc(state), 1e-12);
      const v = sfc(state);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    weighted: (items, w) => {
      let total = 0;
      for (const x of items) total += w(x);
      let t = sfc(state) * total;
      for (const x of items) { t -= w(x); if (t <= 0) return x; }
      return items[items.length - 1];
    },
  };
}

// ---------- Sayısal yardımcılar ----------

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function phi(x) { // standart normal birikimli dağılım (A&S 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function phiInv(p) { // Acklam
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- Türkçe ek (ülke adlarına) ----------

const BACK = 'aıou';
const FRONT = 'eiöü';
const HARD = 'çfhkpsşt';
export function suffix(word, kind) {
  // kind: 'de' (bulunma), 'den' (ayrılma), 'e' (yönelme)
  if (/^[A-ZÇĞİÖŞÜ]{2,}$/.test(word)) { // kısaltma: harf okunuşu (ABD → "de")
    const last = word.at(-1);
    const front = !'AIOU'.includes(last) && !'HK'.includes(last); // A,I,O,U,K(ka),H(ha) kalın
    const v = front ? 'e' : 'a';
    return `${word}'${{ de: `d${v}`, den: `d${v}n`, e: `y${v}` }[kind]}`;
  }
  const lower = word.toLocaleLowerCase('tr');
  let vowel = 'e';
  for (let i = lower.length - 1; i >= 0; i--) {
    if (BACK.includes(lower[i])) { vowel = 'a'; break; }
    if (FRONT.includes(lower[i])) { vowel = 'e'; break; }
  }
  const lastCh = lower.at(-1);
  const endsVowel = (BACK + FRONT).includes(lastCh);
  const buffer = /(Cumhuriyeti|Adaları|Adası|Emirlikleri|Devletleri|Bölgeleri|Krallığı)$/.test(word) ? 'n' : '';
  const dt = HARD.includes(lastCh) ? 't' : 'd';
  if (kind === 'de') return `${word}'${buffer}${buffer ? 'd' : dt}${vowel}`;
  if (kind === 'den') return `${word}'${buffer}${buffer ? 'd' : dt}${vowel}n`;
  return `${word}'${buffer || (endsVowel ? 'y' : '')}${vowel}`;
}

// ---------- Dünya (veri hazırlığı) ----------

export function prepareWorld(data) {
  const countries = data.countries;
  const byIso = new Map(countries.map((c) => [c.iso, c]));
  let total = 0;
  const cum = countries.map((c) => (total += c.b));
  let popTotal = 0;
  for (const c of countries) {
    c.sigma = Math.SQRT2 * phiInv((clamp(c.gini, 15, 70) / 100 + 1) / 2);
    c.mu = Math.log(c.gdp) - (c.sigma * c.sigma) / 2;
    popTotal += c.pop;
  }
  const world = { data, countries, byIso, cum, total, popTotal, tables: new Map() };
  // Olay kütüphanesinin çalışma anında kullandığı yardımcılar (döngüsel içe aktarma olmasın diye buradan verilir)
  world.fn = {
    lit: LIT,
    birthProb,
    emigrationRate,
    cancerSurvival,
    qAt: (iso, age, sex) => qAt(world, iso, age, sex),
    ncd: (L, x) => ncdHazard(world, L, x),
  };
  return world;
}

export function pickBirthCountry(world, u) {
  const t = u * world.total;
  let lo = 0, hi = world.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (world.cum[mid] < t) lo = mid + 1; else hi = mid;
  }
  return world.countries[lo];
}

// Ülke içi yüzdelik (0–100) → yıllık gelir ($, SAGP)
export const incomeOf = (c, pct) => Math.exp(c.mu + c.sigma * phiInv(clamp(pct / 100, 0.004, 0.996)));
export const pctOf = (c, income) => 100 * phi((Math.log(income) - c.mu) / c.sigma);

// Dünyadaki yüzdelik (nüfus ağırlıklı ülke dağılımları karışımı)
export function worldPct(world, income) {
  const li = Math.log(income);
  let s = 0;
  for (const c of world.countries) s += c.pop * phi((li - c.mu) / c.sigma);
  return (100 * s) / world.popTotal;
}

// ---------- Yayımlanmış ortalamalar (her biri Kaynaklar ekranında ve 📊 notlarında görünür) ----------
// `v: true` → "varsayım": doğrudan veriye dayanmayan, küçük tutulmuş bir etki.
export const LIT = {
  eduCorr: { v: 0.42, note: 'Ebeveyn ile çocuğun eğitim yılı korelasyonu ~0,42 (Hertz vd. 2007, 42 ülke)' },
  mincer: { v: 0.09, note: 'Her ek okul yılı geliri ortalama ~%9 artırır (Psacharopoulos & Patrinos 2018)' },
  ige: { v: 0.5, note: 'Kuşaklar arası gelir esnekliği ~0,4–0,6; 0,5 alındı (Corak 2013; Dünya Bankası GDIM)' },
  smokeRR: { v: 2.0, note: 'Sigara içenlerde bulaşıcı olmayan hastalıktan ölüm riski 2–3 kat (Doll vd. 2004; Jha vd. 2013); temkinli 2 alındı' },
  quitRR: { v: 1.3, note: '35–54 yaşında bırakanlar fazla riskin çoğundan kurtulur (Jha vd. 2013)' },
  diabRR: { v: 1.8, note: 'Diyabette tüm nedenlere bağlı ölüm ~1,8 kat (Emerging Risk Factors Collaboration 2011)' },
  rehabRR: { v: 0.74, note: 'Kalp rehabilitasyonu ve yaşam tarzı değişikliği kalp-damar ölümünü ~%26 azaltır (Anderson vd. 2016, Cochrane)' },
  checkRR: { v: 1.0, note: 'Genel sağlık taramaları toplam ölümü değiştirmiyor, RR 1,00 (Krogsbøll vd. 2019, Cochrane)' },
  ncdShares: { v: { kalp: 0.44, kanser: 0.23, solunum: 0.10, diyabet: 0.05, diger: 0.18 }, note: 'Bulaşıcı olmayan hastalık ölümleri: kalp-damar %44, kanser %23, kronik solunum %10, diyabet %5 (WHO 2023 bilgi notu, 41 milyon ölüm)' },
  u5Causes: { v: { com: 0.85, ncd: 0.10, inj: 0.05 }, note: '5 yaş altı ölümlerin ~%10\'u doğumsal anomali, ~%5\'i yaralanma (WHO/MCEE küresel tahmini)' },
  everMarried: { v: 0.9, note: 'Çoğu ülkede 45–49 yaşındakilerin %85–95\'i en az bir kez evlenmiş (UN World Marriage Data 2019); 0,9 alındı' },
  boyM18: { v: 1 / 6, note: '18 yaşından önce evlenen erkek sayısı kızların ~1/6\'sı (UNICEF 2019, 115 milyon erkek / 650 milyon kadın)' },
  unionKeep: { v: 0.9, note: 'Boşanma ve dulluk nedeniyle doğurgan yaşlarda evliliğin sürme payı ~%90 alındı — varsayım', varsayim: true },
  ageGap: { v: 3, note: 'Eşler arasında ortalama ~3 yaş fark (UN World Marriage Data)' },
  asfrShape: { v: [0.28, 0.31, 0.23, 0.13, 0.05], note: '20–44 yaş doğurganlığının yaş gruplarına dağılımı, UN WPP model takvimine yakın şekil' },
  parentAge: { v: [27, 31], note: 'Ortalama doğurma yaşı ~27 (anne) / ~31 (baba) alındı (UN WPP)' },
  unempExit: { v: 0.75, note: 'İşsizlikten çıkış hızı yılda ~0,75 (ortalama süre 3–18 ay, ILO) — varsayım', varsayim: true },
  replacement: { v: 0.6, note: 'Emeklilikte gelir ikame oranı ~%50–60 (OECD Pensions at a Glance 2023)' },
  immigrantGap: { v: 0.75, note: 'Göçmenler ilk yıllarda benzer yerlilerden ~%25 az kazanır (OECD International Migration Outlook)' },
  injuryRatio: { v: 20, note: 'Her trafik ölümüne en az ~20 ağır yaralanma düşer (WHO Global Status Report on Road Safety 2023)' },
  hypertension: { v: 0.33, note: '30–79 yaş yetişkinlerin %33\'ü hipertansif (WHO Global report on hypertension 2023)' },
  depression: { v: 0.05, note: 'Yetişkinlerin ~%5\'i depresyon yaşıyor (WHO 2023 bilgi notu)' },
  crisis: { v: 0.02, note: '1970–2017 arasında ~165 ülkede 151 sistemik bankacılık krizi ≈ ülke başına yılda ~%2 (Laeven & Valencia 2018, IMF)' },
  bizSurvive: { v: 0.5, note: 'Yeni işletmelerin yaklaşık yarısı 5 yılı tamamlıyor (ABD BLS Business Employment Dynamics)' },
  cancerSurv: { note: '5 yıllık kanser sağkalımı gelir düzeyine göre %35–65 alındı (CONCORD-3, Allemani vd. 2018 aralığından yaklaşık) — varsayım', varsayim: true },
  conscription: { note: 'Zorunlu askerlik listesi: CIA World Factbook "Military service age and obligation" (kamu malı)' },
  returnMig: { v: 0.3, note: 'Göçmenlerin %20–50\'si 5 yıl içinde geri döner ya da başka ülkeye gider (OECD International Migration Outlook 2008)' },
  microcredit: { note: 'Altı randomize çalışmada mikrokredinin gelire etkisi "olumlu ama dönüştürücü değil" (Banerjee, Karlan & Zinman 2015)' },
  warAffected: { v: 100, note: 'Çatışma ölümü başına ~100 kişinin yerinden edildiği / doğrudan etkilendiği varsayıldı (UNHCR ve UCDP oranlarından kaba ölçek) — varsayım', varsayim: true },
  acquaint: { v: 150, note: 'Bir insanın yakın tanıdık çevresi ~150 kişi (Dunbar sayısı) — varsayım', varsayim: true },
};

// ---------- Hayat tablosu (Gompertz–Makeham, ülke/cinsiyete kalibre) ----------
// Bileşenler (5+ yaş): bulaşıcı/anne (C sabit + doğum riski), yaralanma (trafik, cinayet, çatışma, intihar verisi + diğer kaza Io),
// bulaşıcı olmayan (B·e^{γx}). C ve Io, WHO ölüm nedeni paylarını (SH.DTH.COMM.ZS, SH.DTH.INJR.ZS) tutturacak,
// B doğumda beklenen yaşamı tutturacak şekilde birlikte çözülür. 0–4 yaş: bebek ve 5 yaş altı ölüm hızları.

const MAX_AGE = 115;
export const TUNE = {
  warYears: 15,
  // Gompertz eğimi: yüksek yaşlarda ölüm hızının yıllık artışı ~%8–12 (Gavrilov & Gavrilova); yaşam beklentisiyle hafif artar
  gamma0: 0.11,
  gammaSlope: 0.0012,
}; // çatışma ölüm hızı doğumdan itibaren bu ölçekte söner (çatışmalar ömür boyu sürmez) — varsayım
export const warDecay = (x) => Math.exp(-x / TUNE.warYears);

export function lifeTable(world, iso, sex) {
  const key = `${iso}:${sex}`;
  const hit = world.tables.get(key);
  if (hit) return hit;
  const c = world.byIso.get(iso);
  const s = sex === 'M' ? 0 : 1;
  const m = sex === 'M';
  const le = c.le[s];
  const imr = c.imr[s] / 1000;
  const u5 = Math.max(c.u5[s], c.imr[s] + 0.1) / 1000;
  // Cinsiyet payları: trafik ölümlerinin ~%75'i (WHO), cinayet kurbanlarının ~%81'i (UNODC) erkek; çatışma %80 erkek (varsayım)
  const ext = {
    road: (c.road / 1e5) * (m ? 1.5 : 0.5),
    hom: (c.hom / 1e5) * (m ? 1.62 : 0.38),
    war: (Math.min(c.war, 400) / 1e5) * (m ? 1.6 : 0.4),
    sui: (m ? c.suiM : c.suiF) / 1e5,
  };
  const mat = m ? 0 : (c.tfr / 35) * (c.mmr / 1e5);
  const gamma = clamp(TUNE.gamma0 + TUNE.gammaSlope * (le - 70), 0.08, 0.135);
  const gr = (c.grow ?? 1) / 100; // durağan nüfus yaklaşımı: x yaşındakilerin payı ∝ S(x)·e^{−r·x}
  const q0 = imr;
  const q14 = 1 - ((1 - u5) / (1 - imr)) ** 0.25;
  const U5 = LIT.u5Causes.v;
  const C0 = 0.0001 + 0.02 * u5; // genç yetişkinlerde bulaşıcı hastalık tabanı, çocuk ölümüyle ölçeklenir
  const split = (k) => (k <= 1 ? { C: C0 * k, phi: 0 } : { C: C0, phi: Math.min(0.9, (k - 1) * 0.1) });
  const run = (k, Io, B) => {
    const { C, phi } = split(k);
    let S = 1, e = 0, com = 0, inj = 0, pd = 0, pc = 0, pi = 0;
    for (let x = 0; x < MAX_AGE; x++) {
      let q, fc, fi;
      if (x < 5) { q = x === 0 ? q0 : q14; fc = U5.com; fi = U5.inj; } else {
        const injH = ext.road + ext.hom + ext.war * warDecay(x) + ext.sui + Io;
        const senAll = (B / gamma) * (Math.exp(gamma * (x + 1)) - Math.exp(gamma * x));
        const comH = C + phi * senAll + (x >= 15 && x < 50 ? mat : 0);
        const H = injH + comH + (1 - phi) * senAll;
        q = x === MAX_AGE - 1 ? 1 : 1 - Math.exp(-H);
        fc = comH / H; fi = injH / H;
      }
      const d = S * q;
      const wpop = Math.exp(-gr * x); // dönem (yıllık) ölümlerinde bu yaşın ağırlığı
      com += d * fc; inj += d * fi;
      pd += d * wpop; pc += d * wpop * fc; pi += d * wpop * fi;
      e += S * (1 - q) + d * (x === 0 ? 0.25 : 0.5);
      S -= d;
    }
    return { e0: e, com: pc / pd, inj: pi / pd, cohort: { com, inj, ncd: 1 - com - inj } };
  };
  const solveB = (C, Io) => {
    let lo = Math.log(1e-10), hi = Math.log(0.5);
    for (let i = 0; i < 45; i++) {
      const mid = (lo + hi) / 2;
      if (run(C, Io, Math.exp(mid)).e0 > le) lo = mid; else hi = mid;
    }
    return Math.exp((lo + hi) / 2);
  };
  const tCom = clamp(c.dCom / 100, 0.01, 0.95);
  const tInj = clamp(c.dInj / 100, 0.005, 0.6);
  let k = 1, Io = 0.0002, B = 1e-5, r;
  for (let it = 0; it < 30; it++) {
    B = solveB(k, Io);
    r = run(k, Io, B);
    k = clamp(Math.max(k, 1e-4) * (tCom / Math.max(r.com, 1e-6)) ** 0.8, 0, 10);
    Io = clamp(Math.max(Io, 1e-7) * (tInj / Math.max(r.inj, 1e-6)) ** 0.8, 0, 0.1);
  }
  B = solveB(k, Io);
  r = run(k, Io, B);
  const { C, phi } = split(k);
  // shares: dönem (o yılki tüm ölümler) payları → WHO verisiyle karşılaştırılır; cohort: bir doğum kuşağının ölüm nedenleri (simülasyonun beklenen dağılımı)
  const t = { iso, sex, le, gamma, B, C, phi, Io, ext, mat, q0, q14, e0: r.e0, shares: { com: r.com, inj: r.inj, ncd: 1 - r.com - r.inj }, cohort: r.cohort, target: { com: tCom, inj: tInj } };
  world.tables.set(key, t);
  return t;
}

// Bu yıl ölme olasılığı (ebeveyn, eş gibi oyun dışı kişiler için; kişisel risk çarpanı yok)
export function qAt(world, iso, age, sex) {
  const t = lifeTable(world, iso, sex);
  const x = Math.round(age);
  if (x <= 0) return t.q0;
  if (x < 5) return t.q14;
  if (x >= MAX_AGE - 1) return 1;
  const H = t.C + t.Io + t.ext.road + t.ext.hom + t.ext.sui + t.ext.war * warDecay(x) + (t.B / t.gamma) * (Math.exp(t.gamma * (x + 1)) - Math.exp(t.gamma * x));
  return 1 - Math.exp(-H);
}

// Bulaşıcı olmayan hastalık riski: kişisel çarpan, nüfus ortalaması 1 olacak şekilde normalize
// Normalizasyon hayatta kalanlara göre yapılır: sigara içenler daha erken öldüğü için yaşlı yaşlarda payları düşer.
// p_x = p·e^{−(RR−1)·Hn(x)} / (p·e^{−(RR−1)·Hn(x)} + 1 − p), Hn = 30 yaştan itibaren birikimli NCD tehlikesi.
function riskNorm(t, c, sex, x) {
  const key = `${sex}:${x}`;
  t.norm ??= new Map();
  let z = t.norm.get(key);
  if (z) return z;
  let Hn = 0;
  for (let a = 30; a < x; a++) Hn += senRaw(t, a) * (1 - t.phi);
  const p = (sex === 'M' ? c.smkM : c.smkF) / 100;
  const RR = LIT.smokeRR.v;
  const ps = (p * Math.exp(-(RR - 1) * Hn)) / (p * Math.exp(-(RR - 1) * Hn) + 1 - p);
  const d0 = (c.diab / 100) * clamp((x - 35) / 40, 0, 1);
  const DR = LIT.diabRR.v;
  const pd = (d0 * Math.exp(-(DR - 1) * Hn * 0.5)) / (d0 * Math.exp(-(DR - 1) * Hn * 0.5) + 1 - d0);
  z = { s: 1 + ps * (RR - 1), d: 1 + pd * (DR - 1) };
  t.norm.set(key, z);
  return z;
}

export function ncdRR(world, L, c, x) {
  let rr = L.mod.ncd;
  const t = lifeTable(world, L.iso, L.sex);
  const z = riskNorm(t, c, L.sex, Math.min(x, MAX_AGE));
  if (x >= 30) rr *= (L.smoker ? (L.flags.quit ? LIT.quitRR.v : LIT.smokeRR.v) : 1) / z.s;
  rr *= (L.diabetic ? LIT.diabRR.v : 1) / z.d;
  return rr;
}

const senRaw = (t, x) => (t.B / t.gamma) * (Math.exp(t.gamma * (x + 1)) - Math.exp(t.gamma * x));

export const ncdHazard = (world, L, x) => {
  const t = lifeTable(world, L.iso, L.sex);
  const c = world.byIso.get(L.iso);
  return senRaw(t, x) * (1 - t.phi) * ncdRR(world, L, c, x);
};

export const cancerSurvival = (c) => clamp(0.35 + 0.3 * (Math.log(c.gdp) - Math.log(2000)) / (Math.log(50000) - Math.log(2000)), 0.35, 0.65);

// Bu yılın tehlike bileşenleri (yıllık birikimli tehlike). Kanser ayrıca teşhis olayıyla gelir (payı ncd'den düşülür).
export function hazards(world, L) {
  const t = lifeTable(world, L.iso, L.sex);
  const x = L.age;
  const U5 = LIT.u5Causes.v;
  if (x < 5) {
    const H = -Math.log(1 - (x === 0 ? t.q0 : t.q14));
    return { [x === 0 ? 'bebek' : 'cocuk']: H * U5.com, dogustan: H * U5.ncd, kaza: H * U5.inj };
  }
  return {
    ncd: ncdHazard(world, L, x) * (1 - LIT.ncdShares.v.kanser),
    enf: t.C + t.phi * senRaw(t, x),
    kaza: t.Io,
    trafik: t.ext.road * L.mod.road,
    siddet: t.ext.hom,
    savas: t.ext.war * warDecay(x - (L.warT0 ?? 0)),
    intihar: t.ext.sui,
  };
}

// Ölüm nedeni kategorileri (WHO GHE gruplaması)
export const CAUSE_CAT = {
  bebek: 'com', cocuk: 'com', enf: 'com', dogum: 'com',
  dogustan: 'ncd', kalp: 'ncd', kanser: 'ncd', solunum: 'ncd', diyabet: 'ncd', diger: 'ncd',
  kaza: 'inj', trafik: 'inj', siddet: 'inj', savas: 'inj', intihar: 'inj',
};

// ---------- Eğitim (veriden; ebeveyn varlığıyla ilişkili gizli yetenek/fırsat) ----------

export function eduProbs(c) {
  const pNone = clamp(c.oos / 100, 0, 0.9);
  const pPrim = Math.min(clamp(c.cmpP / 100, 0.02, 0.99), 1 - pNone);
  const pLow = Math.min(clamp(c.cmpL / 100, 0.01, 0.98), pPrim);
  const pUp = Math.min(clamp(c.upE / 100, 0.01, 0.97), pLow);
  const pUni = Math.min(clamp(c.ter / 100, 0.005, 0.85), pUp);
  const pMs = pUni * clamp(c.msA / Math.max(c.baA, 1), 0, 0.5);
  const someP = 1 - pNone - pPrim; // okula başlayıp ilkokulu bitiremeyen
  const dist = [[0, pNone], [3, someP], [6, pPrim - pLow], [9, pLow - pUp], [12, pUp - pUni], [16, pUni - pMs], [18, pMs]];
  const meanYrs = dist.reduce((a, [y, p]) => a + y * p, 0);
  const sdYrs = Math.sqrt(dist.reduce((a, [y, p]) => a + p * (y - meanYrs) ** 2, 0));
  return { pNone, pPrim, pLow, pUp, pUni, pMs, meanYrs, sdYrs };
}

// pe: gizli eğitim yüzdeliği (0–1). Döner: hedef yıl ve üniversite/yüksek lisans "kaderi" (seçimler değiştirebilir)
export function eduTarget(c, pe) {
  const p = eduProbs(c);
  const q = 1 - pe;
  if (q <= p.pMs) return { yrs: 12, uni: true, ms: true };
  if (q <= p.pUni) return { yrs: 12, uni: true, ms: false };
  if (q <= p.pUp) return { yrs: 12, uni: false, ms: false };
  if (q <= p.pLow) return { yrs: 9, uni: false, ms: false };
  if (q <= p.pPrim) return { yrs: 6, uni: false, ms: false };
  if (q <= 1 - p.pNone) return { yrs: 1 + Math.floor(((q - p.pPrim) / Math.max(1e-9, 1 - p.pNone - p.pPrim)) * 5), uni: false, ms: false };
  return { yrs: 0, uni: false, ms: false };
}

// ---------- Evlilik ve doğurganlık ----------

export function marriageParams(c, sex) {
  const smam = sex === 'M' ? c.smamM : c.smamF;
  const m18 = (c.m18 / 100) * (sex === 'M' ? LIT.boyM18.v : 1);
  const mu = (smam - m18 * 15.5) / (1 - m18);
  return { smam, m18, mu, sd: 4 };
}

// P(evli olmuş | yaş) — yaş dağılımı karışımının birikimlisi × hiç evlenmeme payı
export function pMarriedBy(c, sex, age) {
  const { m18, mu, sd } = marriageParams(c, sex);
  if (age < 14) return 0;
  const early = m18 * clamp((age - 13) / 4, 0, 1);
  const later = age < 18 ? 0 : (1 - m18) * phi((age + 0.5 - mu) / sd);
  return LIT.everMarried.v * (early + later);
}

// Yaşa özel doğurganlık (kadın başına yıllık doğum): 15–19 ergen doğurganlığı verisi, kalan TFR 20–44'e model şekliyle
export function asfr(c, age) {
  if (age < 15 || age > 44) return 0;
  const ado = c.ado / 1000;
  if (age < 20) return ado;
  const rest = Math.max(0, c.tfr - 5 * ado);
  return (rest * LIT.asfrShape.v[Math.floor((age - 20) / 5)]) / 5;
}

// Evli bir kişinin bu yıl çocuk sahibi olma olasılığı: κ·ASFR(kadının yaşı), κ = TFR / Σ P(evli | yaş)·ASFR(yaş)
// → evli kadın başına beklenen doğum toplamı TFR'ye eşit (doğumlar evlilik yıllarına kayar, toplam korunur).
const kappaCache = new WeakMap();
export function fertilityKappa(c) {
  let k = kappaCache.get(c);
  if (k == null) {
    let s = 0;
    for (let a = 15; a <= 44; a++) s += pMarriedBy(c, 'F', a) * LIT.unionKeep.v * asfr(c, a);
    k = s > 0 ? c.tfr / s : 0;
    kappaCache.set(c, k);
  }
  return k;
}
export function birthProb(c, L) {
  const wifeAge = L.sex === 'F' ? L.age : L.age - LIT.ageGap.v;
  return clamp(fertilityKappa(c) * asfr(c, wifeAge), 0, 0.7);
}

// ---------- Göç ----------

// Yıllık göç olasılığı (18–45 yaş): yurt dışında yaşayan doğumluların payı (UN DESA) ömür boyu olasılığa çevrilir
export function emigrationRate(c) {
  const E = clamp(c.emi / 100, 0.002, 0.6);
  const life = E / (1 + E); // doğanların yurt dışında yaşayan payı
  return 1 - (1 - life) ** (1 / 28);
}

// ---------- İsimler ----------

export const NAMES = {
  TUR: { M: ['Ahmet', 'Mehmet', 'Mustafa', 'Emir', 'Yusuf', 'Eymen', 'Kerem', 'Can', 'Burak', 'Deniz', 'Murat', 'Ali'],
    F: ['Zeynep', 'Elif', 'Defne', 'Ayşe', 'Asel', 'Fatma', 'Ecrin', 'Meryem', 'Deniz', 'Selin', 'Nehir', 'Ebru'] },
  EAS: { M: ['Wei', 'Haruto', 'Minjun', 'Jian', 'Budi', 'Minh', 'Kenji', 'Somchai', 'Jose', 'Tao', 'Hiro', 'Arief'],
    F: ['Mei', 'Yui', 'Seoyeon', 'Lan', 'Siti', 'Linh', 'Hana', 'Mali', 'Maria', 'Xiu', 'Sakura', 'Ayu'] },
  ECS: { M: ['Luka', 'Noah', 'Ivan', 'Matteo', 'Lukas', 'Oliver', 'Jakub', 'Hugo', 'Arman', 'Dmitri', 'Aziz', 'Leon'],
    F: ['Emma', 'Sofia', 'Anna', 'Mia', 'Olga', 'Léa', 'Giulia', 'Zuzana', 'Aru', 'Nino', 'Maja', 'Elena'] },
  LCN: { M: ['Mateo', 'Santiago', 'João', 'Miguel', 'Diego', 'Gabriel', 'Luis', 'Thiago', 'Andrés', 'Pedro', 'Jean', 'Carlos'],
    F: ['Valentina', 'Camila', 'Ana', 'Lucía', 'Isabella', 'Maria', 'Sofía', 'Gabriela', 'Fernanda', 'Rosa', 'Daniela', 'Luana'] },
  MEA: { M: ['Muhammed', 'Ali', 'Omar', 'Yusuf', 'Ahmad', 'Karim', 'Reza', 'Hassan', 'Amir', 'Bilal', 'Tariq', 'Youssef'],
    F: ['Fatima', 'Maryam', 'Aisha', 'Layla', 'Zahra', 'Noor', 'Amina', 'Sara', 'Yasmin', 'Hiba', 'Salma', 'Rania'] },
  NAC: { M: ['Liam', 'Noah', 'James', 'Ethan', 'Lucas', 'Benjamin', 'Logan', 'Jayden', 'Daniel', 'Elijah', 'Owen', 'Mason'],
    F: ['Olivia', 'Emma', 'Ava', 'Charlotte', 'Sophia', 'Amelia', 'Harper', 'Chloe', 'Maya', 'Grace', 'Zoe', 'Aaliyah'] },
  SAS: { M: ['Arjun', 'Rahul', 'Aarav', 'Rohan', 'Imran', 'Rafiq', 'Sanjay', 'Vikram', 'Kiran', 'Arif', 'Anil', 'Bilal'],
    F: ['Priya', 'Ananya', 'Aisha', 'Fatima', 'Sita', 'Diya', 'Nusrat', 'Meera', 'Kavya', 'Rani', 'Sadia', 'Pooja'] },
  SSF: { M: ['Chinedu', 'Kwame', 'Juma', 'Tunde', 'Abdou', 'Mandla', 'Tesfaye', 'Moussa', 'Emeka', 'Baraka', 'Kofi', 'Sipho'],
    F: ['Amara', 'Ngozi', 'Aminata', 'Zawadi', 'Fatou', 'Ayana', 'Thandiwe', 'Chiamaka', 'Halima', 'Nia', 'Abena', 'Mariam'] },
};

export const namePool = (c, sex) => (NAMES[c.iso] ?? NAMES[c.r] ?? NAMES.ECS)[sex];

// ---------- Doğum ----------

export function birth(world, { seed, country, sex, year = 2026 } = {}) {
  const rs = seedState(seed);
  const R = rng(rs);
  const c = country ? world.byIso.get(country) : pickBirthCountry(world, R.r());
  if (!c) throw new Error(`Bilinmeyen ülke: ${country}`);
  const sx = sex ?? (R.r() < 105 / 205 ? 'M' : 'F');
  const parentW = clamp(R.r() * 100, 0.5, 99.5);
  const urban = R.r() < c.urb / 100;
  const zW = phiInv(parentW / 100);
  const rho = LIT.eduCorr.v;
  const pe = phi(rho * zW + Math.sqrt(1 - rho * rho) * R.normal());
  const mp = marriageParams(c, sx);
  // Çocuk yaşta evlilik eğitim yüzdeliğinin en alt diliminde (UNICEF: çocuk gelinlerin çoğu okulu erken bırakmış) — toplam oran m18 korunur
  const early = pe < mp.m18;
  const mAge = early ? 14 + R.int(4) : Math.max(18, Math.round(mp.mu + R.normal() * mp.sd));
  const L = {
    v: 2,
    seed: String(seed),
    rs,
    year0: year,
    name: '',
    sex: sx,
    born: c.iso,
    iso: c.iso,
    urban,
    age: 0,
    alive: true,
    parentW,
    zW,
    lat: {
      pe,
      edu: eduTarget(c, pe),
      smk: R.r(),
      marry: R.r() < LIT.everMarried.v,
      mAge,
      lf: R.r() < (sx === 'M' ? c.lfpM : c.lfpF) / 100,
      shock: R.normal(),
      clab: R.r(),
      noElec: !urban && R.r() > c.elecR / 100,
      noWater: !urban && R.r() > c.waterR / 100,
      stunt: R.r() < c.stunt / 100,
    },
    st: { h: 80, j: 50, k: 4, w: parentW },
    tr: { h: 0, j: 0, z: 0 }, // geçici etkiler (her yıl söner)
    zP: 0, // kalıcı gelir kayması (göç, girişim)
    jOff: R.normal() * 5,
    mod: { ncd: 1, cvd: 1, road: 1, kids: 1 },
    smoker: false,
    diabetic: false,
    edu: { yrs: 0, plan: 0, inSchool: false, level: 0, uni: false },
    job: null,
    unemployed: false,
    retired: false,
    partner: null,
    married: false,
    marriedAt: null,
    exPartners: 0,
    kids: [],
    grandkids: 0,
    siblings: 0,
    parents: { mom: true, dad: true },
    flags: {},
    cnt: {},
    last: {},
    migrations: [],
    log: [],
    pending: null,
    fatal: null,
    death: null,
  };
  L.edu.plan = L.lat.edu.yrs;
  derive(world, L);
  return L;
}

export function setName(L, name) { L.name = String(name).trim().slice(0, 20) || 'İsimsiz'; }

export function randomName(world, L, salt = 0) {
  return rng(seedState(`${L.seed}:name:${salt}`)).pick(namePool(world.byIso.get(L.born), L.sex));
}

// ---------- Yazı şablonları ----------

export function fill(text, L, world, extra = {}) {
  const c = world.byIso.get(L.iso);
  const born = world.byIso.get(L.born);
  const kid = L.kids.at(-1);
  const map = {
    name: L.name, yas: String(L.age), ulke: c.n, ulkede: suffix(c.n, 'de'), ulkeden: suffix(c.n, 'den'), ulkeye: suffix(c.n, 'e'),
    dogdugu: born.n, es: L.partner?.name ?? 'eşin', cocuk: kid?.name ?? 'çocuğun', is: L.job ?? 'işin', arkadas: L.flags.friend ?? 'arkadaşın',
    ...extra,
  };
  return text.replace(/\{(\w+)\}/g, (m, k) => map[k] ?? m);
}

export const pct = (x, d = 1) => `%${Number(x).toLocaleString('tr-TR', { maximumFractionDigits: d })}`;
export const num = (x, d = 1) => Number(x).toLocaleString('tr-TR', { maximumFractionDigits: d });

// ---------- Türetilmiş statlar (gösterim): sonuçları değiştirmez, sonuçlardan hesaplanır ----------

export function healthTarget(c, age) {
  const le = (c.le[0] + c.le[1]) / 2;
  let base;
  if (age < 20) base = 84;
  else if (age < 40) base = 84 - (age - 20) * 0.3;
  else if (age < 60) base = 78 - (age - 40) * 0.6;
  else if (age < 80) base = 66 - (age - 60) * 1.0;
  else base = 46 - (age - 80) * 1.3;
  return clamp(base + (le - 73) * 0.35, 5, 95);
}

function zAdult(world, L) {
  const c = world.byIso.get(L.iso);
  const p = eduProbs(c);
  const yrs = L.edu.yrs;
  const beta = LIT.mincer.v;
  const ige = LIT.ige.v;
  const eduZ = (beta * (yrs - p.meanYrs)) / c.sigma;
  // Varyans 1'de kalsın: ebeveyn + eğitim bileşenleri en fazla %80 açıklasın (Gini'si düşük ülkelerde σ küçük, eğitim z'si büyür)
  const sys = ige * ige + ((beta * p.sdYrs) / c.sigma) ** 2;
  const k = Math.min(1, Math.sqrt(0.8 / sys));
  return k * (ige * L.zW + eduZ) + Math.sqrt(Math.max(0, 1 - k * k * sys)) * L.lat.shock;
}

function derive(world, L) {
  const c = world.byIso.get(L.iso);
  const a = L.age;
  // Varlık: çocukken aile; 18–30 arası kendi gelirine geçiş (eğitim getirisi + kuşaklar arası esneklik)
  let z = L.zW;
  if (a >= 18 || L.job) {
    const t = clamp((a - 18) / 12, 0, 1);
    z = (1 - t) * L.zW + t * zAdult(world, L);
  }
  z += L.zP + L.tr.z;
  if (L.unemployed) z -= 0.35; // işsizlik geliri düşürür (varsayım: ~%30–40 kayıp)
  if (L.retired) z += Math.log(LIT.replacement.v) / c.sigma;
  L.st.w = clamp(100 * phi(z), 0.5, 99.5);
  // Sağlık: yaş/ülke beklentisi − kişisel risk + geçici hastalık izleri
  const rr = a >= 5 ? ncdRR(world, L, c, Math.max(a, 30)) : 1;
  const fatalPull = L.fatal ? 25 : 0;
  L.st.h = clamp(healthTarget(c, a) - 15 * Math.log(rr) + L.tr.h - fatalPull, 1, 100);
  // Bilgi: okul yılı + yaşla biriken deneyim
  L.st.k = clamp(4 + L.edu.yrs * 4 + Math.min(a, 60) * 0.3 + (a < 6 ? a * 1.5 : 0) - Math.max(0, a - 75) * 0.6, 0, 100);
  // Keyif: ülkenin yaşam memnuniyeti (Cantril) + varlık + yakınlar + geçici olaylar
  const live = L.kids.some((k) => !k.lost);
  L.st.j = clamp(c.sat * 10 + 8 + 4 * (z - 0) + (L.partner ? 3 : 0) + (live ? 2 : 0) + L.jOff + L.tr.j, 1, 100);
}

// ---------- Etki uygulama ve olay API'si ----------

function applyFx(L, fx = {}) {
  if (fx.j) L.tr.j += fx.j;
  if (fx.h) L.tr.h += fx.h;
  if (fx.z) L.tr.z += fx.z;
}

const JOBS = {
  0: ['çiftçi', 'çoban', 'seyyar satıcı', 'inşaat işçisi', 'ev işlerinde yardımcı', 'balıkçı', 'hamal'],
  1: ['şoför', 'satış danışmanı', 'kuaför', 'aşçı', 'fabrika işçisi', 'elektrikçi', 'kurye', 'terzi', 'garson', 'tamirci'],
  2: ['öğretmen', 'mühendis', 'hemşire', 'muhasebeci', 'yazılımcı', 'avukat', 'mimar', 'eczacı', 'grafik tasarımcı', 'bankacı'],
  3: ['doktor', 'akademisyen', 'araştırmacı', 'yönetici', 'diplomat'],
};

export function jobLevel(L) {
  if (L.edu.level >= 4) return 3;
  if (L.edu.level >= 3) return 2;
  if (L.edu.yrs >= 9) return 1;
  return 0;
}

const HUBS = new Set(['USA', 'DEU', 'GBR', 'FRA', 'CAN', 'SAU', 'ARE', 'AUS', 'ESP', 'ITA', 'NLD', 'ZAF', 'RUS', 'TUR', 'JPN', 'KOR', 'SGP']);

function makeApi(world, L, R, out) {
  const api = {
    R,
    world,
    lit: LIT,
    c: () => world.byIso.get(L.iso),
    q: (age, sex, iso = L.iso) => qAt(world, iso, age, sex),
    ncd: (age) => ncdHazard(world, L, age),
    die: (cause) => die(world, L, cause, R, out),
    fatal: (cause, inYears) => { L.fatal = { cause, age: L.age + inYears }; },
    pickName: (sex) => R.pick(namePool(world.byIso.get(L.iso), sex)),
    meet() {
      const sex = R.r() < 0.96 ? (L.sex === 'M' ? 'F' : 'M') : L.sex;
      let name = api.pickName(sex);
      if (name === L.name) name = api.pickName(sex);
      L.partner = { name, sex, since: L.age, alive: true };
    },
    marry() { L.married = true; if (L.marriedAt == null) L.marriedAt = L.age; },
    startUni() { L.edu.uni = true; L.edu.inSchool = true; L.edu.plan = L.edu.yrs + 4; L.job = null; L.unemployed = false; },
    redrawMarriage(minAge) {
      const mp = marriageParams(world.byIso.get(L.iso), L.sex);
      L.lat.mAge = Math.max(minAge, Math.round(mp.mu + R.normal() * mp.sd));
    },
    breakUp() { L.partner = null; L.married = false; L.exPartners++; },
    addKid() {
      const sex = R.r() < 105 / 205 ? 'M' : 'F';
      let name = api.pickName(sex);
      for (let i = 0; i < 3 && (name === L.name || L.kids.some((k) => k.name === name)); i++) name = api.pickName(sex);
      const c = world.byIso.get(L.iso);
      const u5 = (c.u5[0] + c.u5[1]) / 2000;
      const imr = (c.imr[0] + c.imr[1]) / 2000;
      const lostAt = R.r() < u5 ? L.age + (R.r() < imr / u5 ? 0 : 1 + R.int(4)) : null;
      L.kids.push({ name, sex, born: L.age, lostAt, lost: false });
      return name;
    },
    getJob(level = jobLevel(L)) {
      L.job = R.pick(JOBS[level]);
      L.jobLevel = level;
      L.unemployed = false;
      return L.job;
    },
    loseJob() { L.job = null; L.unemployed = true; },
    migrate(iso) {
      const from = world.byIso.get(L.iso);
      const to = world.byIso.get(iso);
      const income = incomeOf(from, L.st.w);
      L.migrations.push({ from: from.iso, to: iso, age: L.age });
      L.iso = iso;
      L.urban = true;
      L.warT0 = L.age;
      // Aynı geliri yeni ülkenin dağılımına yerleştir (göçmen ücret farkıyla), sonra yıllar içinde kapanır
      const newZ = phiInv(clamp(pctOf(to, income * LIT.immigrantGap.v) / 100, 0.01, 0.95));
      derive(world, L);
      const cur = phiInv(L.st.w / 100) - L.zP;
      L.zP = newZ - cur;
      L.tr.z = 0;
    },
    pickDestination() {
      const from = world.byIso.get(L.iso);
      const list = world.countries.filter((c) => (c.gdp > from.gdp * 1.1 || HUBS.has(c.iso)) && c.pop > 2e6 && c.war < 5 && c.iso !== L.iso);
      if (!list.length) return null;
      // Göçmen stoku büyük, zengin ve yakın ülkeler daha olası (UN DESA göçmen stoku SM.POP.TOTL.ZS ağırlığı)
      return R.weighted(list, (c) => (c.imm / 100) * c.pop * (c.r === from.r ? 3 : 1) * (HUBS.has(c.iso) ? 1.5 : 1)).iso;
    },
  };
  return api;
}

function entry(world, L, { text, icon = '•', kind = 'event', hl = 0, id = null, stat = null }) {
  return { age: L.age, year: L.year0 + L.age, text: fill(text, L, world), icon, kind, hl, id, stat };
}

// ---------- Yıllık akış ----------

function yearStart(world, L) {
  // Geçici etkiler söner
  L.tr.h *= 0.6;
  L.tr.j *= 0.7;
  L.tr.z *= 0.8;
  L.zP *= 0.97; // göçmen ücret farkı yıllar içinde kapanır (varsayım)
  if (L.edu.inSchool) L.edu.yrs++;
  derive(world, L);
}

function eligible(ev, L, c, world) {
  if (L.age < ev.age[0] || L.age > ev.age[1]) return false;
  if ((L.cnt[ev.id] ?? 0) >= (ev.max ?? 1)) return false;
  if (ev.gap && L.last[ev.id] != null && L.age - L.last[ev.id] < ev.gap) return false;
  if (ev.sex && ev.sex !== L.sex) return false;
  if (ev.if && !ev.if(L, c, world)) return false;
  return true;
}

const prob = (ev, L, c, world) => clamp(typeof ev.p === 'function' ? ev.p(L, c, world) : ev.p, 0, 1);
const MAX_PLAIN = 2;

function textOf(t, L, c, R) {
  if (typeof t === 'function') return t(L, c, R);
  if (Array.isArray(t)) return R.pick(t);
  return t;
}

function statOf(ev, L, c, world) {
  try { return ev.stat ? ev.stat(L, c, world) : null; } catch { return null; }
}

function fire(world, L, ev, R, out) {
  const c = world.byIso.get(L.iso);
  L.cnt[ev.id] = (L.cnt[ev.id] ?? 0) + 1;
  L.last[ev.id] = L.age;
  const stat = statOf(ev, L, c, world); // olaydan önceki duruma göre
  const ret = ev.do ? ev.do(L, c, makeApi(world, L, R, out)) : undefined;
  if (ret === false) return;
  applyFx(L, ev.fx);
  const text = textOf(ev.t, L, c, R);
  if (text) out.push(entry(world, L, { text, icon: ev.ic, hl: typeof ev.hl === 'function' ? ev.hl(L) : ev.hl ?? 0, id: ev.id, stat }));
}

// Bir yaş: olaylar (seçim varsa bekler) + ölüm zarı. Dönen: bu yılın günlük satırları.
export function step(world, L) {
  if (!L.alive || L.pending) return [];
  const R = rng(L.rs);
  const out = [];
  yearStart(world, L);
  const c = world.byIso.get(L.iso);
  let plain = 0;
  let choice = null;
  for (const ev of EVENTS) {
    if (!eligible(ev, L, c, world)) continue;
    if (!(R.r() < prob(ev, L, c, world))) continue;
    if (ev.ch) {
      // Yılda tek seçim. Veriye dayalı seçim, renk seçiminin önüne geçer; geri kalanlar sayılmaz, gelecek yıl yeniden zar atar.
      if (choice && !(choice.fl && !ev.fl)) continue;
      choice = ev;
      continue;
    }
    if (ev.fl) {
      // Sadece renk olayları yılda en fazla 2 ile sınırlı; veriye dayalı olaylar asla bastırılmaz (oranlar bozulmasın)
      if (plain >= MAX_PLAIN) continue;
      plain++;
    }
    fire(world, L, ev, R, out);
    if (!L.alive) return out;
  }
  if (choice) {
    L.cnt[choice.id] = (L.cnt[choice.id] ?? 0) + 1;
    L.last[choice.id] = L.age;
    if (choice.pre) choice.pre(L, c);
    const options = choice.ch.map((o, i) => ({ o, i })).filter(({ o }) => !o.if || o.if(L, c, world));
    L.pending = {
      id: choice.id,
      text: fill(textOf(choice.t, L, c, R), L, world),
      icon: choice.ic ?? '❓',
      stat: statOf(choice, L, c, world),
      options: options.map(({ o, i }) => ({ l: fill(o.l, L, world), i, def: choice.def === i })),
    };
    return out;
  }
  finishYear(world, L, R, out);
  return out;
}

export function choose(world, L, idx) {
  if (!L.pending) throw new Error('Bekleyen seçim yok');
  const ev = EVENTS_BY_ID.get(L.pending.id);
  const opt = L.pending.options[idx];
  if (!opt) throw new Error('Geçersiz seçenek');
  const o = ev.ch[opt.i];
  const R = rng(L.rs);
  const c = world.byIso.get(L.iso);
  const out = [];
  const api = makeApi(world, L, R, out);
  out.push(entry(world, L, { text: opt.l, icon: '👉', kind: 'choice', id: ev.id, stat: L.pending.stat }));
  L.pending = null;
  let res = o;
  if (o.odds != null) {
    const p = clamp(typeof o.odds === 'function' ? o.odds(L, c, world) : o.odds, 0, 1);
    res = R.r() < p ? o.win : o.lose;
  }
  if (res) {
    const ret = res.do ? res.do(L, c, api) : undefined;
    if (ret !== false) {
      applyFx(L, res.fx);
      const text = textOf(res.t, L, c, R);
      if (text) out.push(entry(world, L, { text, icon: res.ic ?? ev.ic ?? '↳', hl: res.hl ?? 0, id: ev.id }));
    }
  }
  if (L.alive) finishYear(world, L, R, out);
  return out;
}

const DISEASES = (c, R) => {
  const list = [['zatürre', 3], ['ishal', c.u5[0] > 40 ? 2 : 0.3], ['sepsis', 1], ['sıtma', c.mal / 50], ['tüberküloz', c.tb / 100], ['menenjit', 0.4]];
  return R.weighted(list.filter((x) => x[1] > 0), (x) => x[1])[0];
};

const DEATH_TEXT = {
  bebek: (L, c, R) => R.pick([`{name}, hayatının ilk yılını tamamlayamadı; ${DISEASES(c, R)} çok küçük bir bedene fazla geldi.`, '{name}, doğumdan sonraki ilk haftalarda, doğumla ilgili komplikasyonlar yüzünden hayatını kaybetti.']),
  cocuk: (L, c, R) => `{name}, {yas} yaşında ${DISEASES(c, R)} yüzünden hayatını kaybetti.`,
  dogustan: () => '{name}, {yas} yaşında doğuştan gelen bir rahatsızlık yüzünden hayatını kaybetti.',
  kaza: (L, c, R) => `{yas} yaşında ${R.pick(['suda boğularak', 'bir düşme sonucu', 'bir yangında', 'bir iş kazasında'])} hayatını kaybettin.`,
  trafik: () => '{yas} yaşında bir trafik kazasında hayatını kaybettin.',
  siddet: () => '{yas} yaşında bir şiddet olayında hayatını kaybettin.',
  savas: () => '{yas} yaşında bölgendeki silahlı çatışmada hayatını kaybettin.',
  intihar: () => '{yas} yaşında intihar sonucu hayatını kaybettin. Yardım istemek her zaman mümkün; yalnız değilsin.',
  dogum: () => 'Doğum sırasında gelişen komplikasyonlar yüzünden {yas} yaşında hayatını kaybettin.',
  enf: (L, c, R) => `{yas} yaşında ${DISEASES(c, R)} yüzünden hayatını kaybettin.`,
  kalp: (L, c, R) => `{yas} yaşında ${R.pick(['kalp krizi', 'felç', 'kalp yetmezliği'])} yüzünden hayatını kaybettin.`,
  kanser: () => '{yas} yaşında kanser yüzünden hayatını kaybettin.',
  solunum: () => '{yas} yaşında kronik akciğer hastalığı (KOAH) yüzünden hayatını kaybettin.',
  diyabet: () => '{yas} yaşında diyabet ve böbrek yetmezliği yüzünden hayatını kaybettin.',
  diger: (L, c, R) => (L.age >= 85 ? R.pick(['{yas} yaşında, bir gece uykunda sessizce gittin.', '{yas} yaşında, sevdiklerinin yanında huzur içinde öldün.']) : `{yas} yaşında ${R.pick(['karaciğer hastalığı', 'bir sinir sistemi hastalığı', 'bir sindirim sistemi hastalığı'])} yüzünden hayatını kaybettin.`),
};

export const CAUSE_NAMES = {
  bebek: 'bebeklikte hastalık', cocuk: 'çocukluk hastalığı', dogustan: 'doğuştan rahatsızlık', kaza: 'kaza', trafik: 'trafik kazası',
  siddet: 'şiddet', savas: 'silahlı çatışma', intihar: 'intihar', dogum: 'doğum komplikasyonu', enf: 'bulaşıcı hastalık',
  kalp: 'kalp-damar hastalığı', kanser: 'kanser', solunum: 'kronik solunum hastalığı', diyabet: 'diyabet', diger: 'yaşa bağlı hastalık',
};

export function die(world, L, cause, R, out) {
  const c = world.byIso.get(L.iso);
  L.alive = false;
  const frac = L.age === 0 ? R.r() * 0.5 : R.r();
  L.death = { cause, cat: CAUSE_CAT[cause], age: L.age, span: L.age + frac, iso: L.iso };
  const t = lifeTable(world, L.iso, L.sex);
  const stat = `${c.n}: ölümlerin ${pct(c.dCom, 0)}'i bulaşıcı/anne/bebek, ${pct(c.dNcd, 0)}'i bulaşıcı olmayan hastalık, ${pct(c.dInj, 0)}'i yaralanma (WHO GHE). Bu ülkede doğan ${L.sex === 'M' ? 'erkeklerin' : 'kadınların'} beklenen ömrü ${num(t.le)} yıl (UN WPP / Dünya Bankası).`;
  out.push(entry(world, L, { text: DEATH_TEXT[cause](L, c, R), icon: '🕯️', kind: 'death', hl: 3, id: `olum-${cause}`, stat }));
}

function finishYear(world, L, R, out) {
  if (L.fatal && L.age >= L.fatal.age) { die(world, L, L.fatal.cause, R, out); return; }
  const hz = hazards(world, L);
  let H = 0;
  for (const v of Object.values(hz)) H += v;
  const q = L.age >= MAX_AGE - 1 ? 1 : 1 - Math.exp(-H);
  if (R.r() < q) {
    let cause = H > 0 ? R.weighted(Object.keys(hz), (k) => hz[k]) : 'diger';
    if (cause === 'ncd') {
      const s = LIT.ncdShares.v;
      const w = { kalp: s.kalp * L.mod.cvd, solunum: s.solunum * (L.smoker ? 2 : 1), diyabet: s.diyabet * (L.diabetic ? 3 : 1), diger: s.diger };
      cause = R.weighted(Object.keys(w), (k) => w[k]);
    }
    die(world, L, cause, R, out);
    return;
  }
  L.age++;
  derive(world, L);
}

export const EVENTS_BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

// Doğumu anlatan ilk satır
export function birthEntry(world, L) {
  const c = world.byIso.get(L.iso);
  const place = L.urban ? 'bir şehirde' : 'kırsalda, küçük bir yerleşimde';
  const fam = L.parentW < 20 ? 'yoksul' : L.parentW < 45 ? 'dar gelirli' : L.parentW < 75 ? 'orta halli' : L.parentW < 95 ? 'varlıklı' : 'çok zengin';
  const extra = [L.lat.noElec ? ' Evinizde elektrik yok.' : '', L.lat.noWater ? ' Temiz su için uzun yol yürünüyor.' : ''].join('');
  const stat = `Dünyada yılda ~${num(world.total / 1e6, 0)} milyon bebek doğuyor; bunların ${pct((100 * c.b) / world.total)}'i ${suffix(c.n, 'de')}. ${pct(c.urb, 0)} kentte yaşıyor; kırsalda elektrik ${pct(c.elecR, 0)}, temiz su ${pct(c.waterR, 0)} (Dünya Bankası).`;
  return entry(world, L, { text: `${c.f} {name}, {ulkede} ${place}, ${fam} bir ailenin ${L.sex === 'M' ? 'oğlu' : 'kızı'} olarak doğdu.${extra}`, icon: '👶', kind: 'birth', hl: 3, id: 'dogum', stat });
}

// ---------- Hayat karnesi ----------

export function report(world, L) {
  const born = world.byIso.get(L.born);
  const c = world.byIso.get(L.iso);
  const s = L.sex === 'M' ? 0 : 1;
  const income = incomeOf(c, L.st.w);
  const wp = worldPct(world, income);
  const tr = world.byIso.get('TUR');
  const jp = world.byIso.get('JPN');
  const cmp = born.iso === 'TUR'
    ? { label: `${jp.f} Japonya'da doğsaydın beklenen ömrün`, le: jp.le[s] }
    : { label: `${tr.f} Türkiye'de doğsaydın beklenen ömrün`, le: tr.le[s] };
  const span = L.death?.span ?? L.age;
  const top = clamp(100 - wp, 0.1, 99.9);
  return {
    name: L.name,
    sex: L.sex,
    born: { iso: born.iso, n: born.n, f: born.f },
    died: { iso: c.iso, n: c.n, f: c.f },
    age: L.death?.age ?? L.age,
    span,
    cause: L.death ? CAUSE_NAMES[L.death.cause] : null,
    le: born.le[s],
    diff: span - born.le[s],
    cmp,
    stats: { ...L.st },
    worldTop: top,
    worldTopText: pct(Math.round(clamp(top, 1, 99)), 0),
    income: Math.round(income),
    kids: L.kids.length,
    grandkids: L.grandkids,
    migrations: L.migrations.map((m) => ({ ...m, f: world.byIso.get(m.to).f, n: world.byIso.get(m.to).n })),
    edu: eduText(L),
    job: L.job,
    highlights: pickHighlights(L.log),
    epitaph: epitaph(L),
    stats2: [
      `${born.f} ${born.n}: doğumda beklenen ömür ${num(born.le[s])} yıl (${L.sex === 'M' ? 'erkek' : 'kadın'}), bebek ölümü binde ${num(born.imr[s])} — UN WPP / UN IGME (Dünya Bankası).`,
      `Gelir: kişi başı GSYH ${num(Math.round(born.gdp), 0)} $ (SAGP), Gini ${num(born.gini)} — Dünya Bankası. Dünya sıralaması nüfus ağırlıklı log-normal gelir dağılımlarından hesaplandı.`,
      `Eğitim: üniversite okullaşması ${pct(born.ter, 0)}, lise ${pct(born.upE, 0)} (UNESCO UIS / Dünya Bankası).`,
      `Aile: doğurganlık ${num(born.tfr, 2)} çocuk/kadın, ilk evlilik yaşı ~${num(born.smamF, 0)} (kadın) — UN WPP / UN World Marriage Data.`,
    ],
  };
}

export function eduText(L) {
  if (L.edu.level >= 4) return 'Yüksek lisans';
  if (L.edu.level >= 3) return 'Üniversite';
  if (L.edu.uni) return 'Üniversite (yarım)';
  if (L.edu.yrs >= 12) return 'Lise';
  if (L.edu.yrs >= 9) return 'Ortaokul';
  if (L.edu.yrs >= 6) return 'İlkokul';
  if (L.edu.yrs > 0) return `${L.edu.yrs} yıl okul`;
  return 'Okula gidemedi';
}

export function pickHighlights(log) {
  const first = log.find((e) => e.kind === 'birth');
  const last = log.find((e) => e.kind === 'death');
  const mid = log.filter((e) => e !== first && e !== last && e.hl > 0 && e.kind !== 'choice');
  const ranked = mid.map((e, i) => ({ e, i, s: e.hl * 10 + (i % 7) })).sort((a, b) => b.s - a.s).slice(0, 6).sort((a, b) => a.i - b.i).map((x) => x.e);
  return [first, ...ranked, last].filter(Boolean);
}

export function epitaph(L) {
  const a = L.death?.age ?? L.age;
  const st = L.st;
  if (a === 0) return 'Bir nefeslik ömür, ömürlük bir sevgi.';
  if (a < 5) return 'Küçük adımlarla geldi, büyük bir boşluk bıraktı.';
  if (a < 18) return `Hep ${a} yaşında kalacak; gülüşü de öyle.`;
  if (a >= 100) return 'Yüzyılı devirdi, pastaya mum sığmadı.';
  if (L.migrations.length >= 2) return 'Haritada bir yere sığmadı, kalplere sığdı.';
  if (L.migrations.length === 1) return 'Bir valiz, iki memleket, tek bir hayat.';
  if (L.kids.length >= 5) return 'Sofrası kalabalık, kapısı hep açıktı.';
  if (L.grandkids >= 3) return 'Torunlarına masal, hepimize hikâye bıraktı.';
  if (['trafik', 'siddet', 'savas', 'intihar'].includes(L.death?.cause)) return 'Yarım kalan cümleleri biz tamamlayacağız.';
  const best = ['h', 'j', 'k', 'w'].reduce((m, k) => (st[k] > st[m] ? k : m), 'h');
  if (st[best] < 35) return 'Kolay olmadı; yine de sonuna kadar yürüdü.';
  return { h: 'Merdivenleri hep ikişer ikişer çıktı.', j: 'Gülmeyi hiç ertelemedi.', k: 'Merakı, ömründen uzun sürdü.', w: 'Hesabını iyi tuttu; çayı hep o ısmarladı.' }[best];
}

// ---------- Otomatik oynatma (testler) ----------
// policy: 'def' → her seçimde verinin "olağan" seçeneği (yoksa rastgele); fonksiyon → (seçenekler, R, L) => indeks
export function liveOut(world, L, policy = 'def') {
  const R = rng(seedState(`${L.seed}:policy`));
  const pick = typeof policy === 'function' ? policy : (opts) => {
    const d = policy === 'def' ? opts.findIndex((o) => o.def) : -1;
    return d >= 0 ? d : R.int(opts.length);
  };
  for (let i = 0; i < 1000 && L.alive; i++) {
    L.log.push(...step(world, L));
    if (L.pending) L.log.push(...choose(world, L, pick(L.pending.options, R, L)));
  }
  return L;
}
