// 🎲 Doğum Piyangosu: veri dosyası, doğum dağılımı, hayat tablosu kalibrasyonu, simülasyon oranlarının veriyle uyumu,
// determinizm, olay kütüphanesinin dayanak kuralları.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sim from '../../public/lifesim-sim.js';

const DATA_FILE = fileURLToPath(new URL('../../public/data/lifesim.json', import.meta.url));
const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const world = sim.prepareWorld(data);

function live(seed, opts = {}, policy = 'def') {
  const L = sim.birth(world, { seed, ...opts });
  sim.setName(L, 'Deneme');
  L.log.push(sim.birthEntry(world, L));
  sim.liveOut(world, L, policy);
  return L;
}

// Bir ülke için çok sayıda hayat (varsayılan seçimlerle) → oranlar. Testler arasında paylaşılır.
const cache = new Map();
function cohort(iso, n = 1500) {
  if (cache.has(iso)) return cache.get(iso);
  const c = world.byIso.get(iso);
  const r = { n, span: 0, cat: { com: 0, inj: 0, ncd: 0 }, coh: { com: 0, inj: 0, ncd: 0 }, n25: 0, uni: 0, nMF: 0, mAgeF: 0, nF45: 0, kidsF: 0, n46: 0, emi: 0, n30: 0, smk: 0, smkE: 0 };
  for (let i = 0; i < n; i++) {
    const L = live(`${iso}-${i}`, { country: iso });
    r.span += L.death.span;
    r.cat[L.death.cat]++;
    const t = sim.lifeTable(world, iso, L.sex);
    for (const k in r.coh) r.coh[k] += t.cohort[k];
    if (L.death.age >= 25) { r.n25++; if (L.edu.uni) r.uni++; }
    if (L.death.age >= 46) { r.n46++; if (L.migrations.length) r.emi++; if (L.sex === 'F') { r.nF45++; r.kidsF += L.kids.length; } }
    if (L.sex === 'F' && L.marriedAt != null) { r.nMF++; r.mAgeF += L.marriedAt; }
    if (L.death.age >= 30) { r.n30++; if (L.smoker) r.smk++; r.smkE += (L.sex === 'M' ? c.smkM : c.smkF) / 100; }
  }
  cache.set(iso, r);
  return r;
}

const CAL = ['TUR', 'NGA', 'JPN', 'IND'];

test('veri: ≥180 ülke, <150 KB, gerekli alanlar sayı, kaynak kodları ve tahmini işaretleri var', () => {
  assert.ok(data.countries.length >= 180, `${data.countries.length} ülke`);
  assert.ok(statSync(DATA_FILE).size < 150 * 1024, `${statSync(DATA_FILE).size} bayt`);
  const fields = ['b', 'pop', 'gdp', 'gini', 'eys', 'ter', 'urb', 'tfr', 'mmr', 'hom', 'road', 'net', 'sat', 'unem', 'lfpM', 'lfpF', 'smkM', 'smkF', 'm18', 'smamF', 'smamM', 'ado', 'oos', 'cmpP', 'cmpL', 'upE', 'diab', 'tb', 'dpt', 'dCom', 'dNcd', 'dInj', 'emi', 'div', 'war', 'grow'];
  for (const c of data.countries) {
    assert.ok(c.n && c.f && c.iso, c.iso);
    for (const f of fields) assert.ok(Number.isFinite(c[f]), `${c.iso}.${f} = ${c[f]}`);
    for (const k of ['le', 'imr', 'u5']) assert.ok(c[k].every(Number.isFinite), `${c.iso}.${k}`);
    if (c.est) assert.ok(Array.isArray(c.est));
  }
  for (const f of ['tfr', 'm18', 'smkM', 'dCom', 'emi', 'unem', 'div']) assert.ok(data.codes[f], `kaynak kodu: ${f}`);
  assert.equal(world.byIso.get('TUR').n, 'Türkiye');
});

test('doğum: 20 bin çekilişte ülke dağılımı doğum sayılarıyla uyumlu (ki-kare), cinsiyet oranı ~105:100', () => {
  const N = 20000;
  const counts = new Map();
  let males = 0;
  for (let i = 0; i < N; i++) {
    const L = sim.birth(world, { seed: `dogum-${i}` });
    counts.set(L.born, (counts.get(L.born) ?? 0) + 1);
    if (L.sex === 'M') males++;
  }
  // Beklenen ≥ 5 olan ülkeler tek tek, kalanlar tek grupta
  let chi = 0, df = -1, restE = 0, restO = 0;
  for (const c of world.countries) {
    const e = (N * c.b) / world.total;
    const o = counts.get(c.iso) ?? 0;
    if (e >= 5) { chi += (o - e) ** 2 / e; df++; } else { restE += e; restO += o; }
  }
  if (restE > 0) { chi += (restO - restE) ** 2 / restE; df++; }
  assert.ok(chi / df < 1.6, `ki-kare/sd = ${(chi / df).toFixed(2)} (sd ${df})`);
  const ind = (counts.get('IND') ?? 0) / N;
  const indE = world.byIso.get('IND').b / world.total;
  assert.ok(Math.abs(ind - indE) < 0.01, `Hindistan ${ind} vs ${indE}`);
  const ratio = males / (N - males);
  assert.ok(Math.abs(ratio - 1.05) < 0.04, `erkek/kız ${ratio.toFixed(3)}`);
});

test('hayat tablosu: tüm ülke/cinsiyetlerde doğumda beklenen yaşam veriye eşit; ölüm nedeni payları çoğunda tutuyor', () => {
  let fit = 0, total = 0;
  for (const c of world.countries) for (const s of ['M', 'F']) {
    const t = sim.lifeTable(world, c.iso, s);
    assert.ok(Math.abs(t.e0 - t.le) < 0.05, `${c.iso}${s} e0 ${t.e0} vs ${t.le}`);
    total++;
    if (Math.abs(t.shares.com - t.target.com) < 0.02 && Math.abs(t.shares.inj - t.target.inj) < 0.02) fit++;
  }
  assert.ok(fit / total > 0.85, `neden payı tutan ${fit}/${total}`);
  for (const iso of CAL) for (const s of ['M', 'F']) {
    const t = sim.lifeTable(world, iso, s);
    assert.ok(Math.abs(t.shares.com - t.target.com) < 0.02 && Math.abs(t.shares.inj - t.target.inj) < 0.02, `${iso}${s}`);
  }
});

for (const iso of CAL) {
  test(`kalibrasyon ${iso}: ortalama ömür ±2 yıl, ölüm nedenleri, üniversite, evlilik yaşı, çocuk sayısı, göç, sigara veriyle uyumlu`, () => {
    const c = world.byIso.get(iso);
    const r = cohort(iso);
    const le = (c.le[0] * 105 + c.le[1] * 100) / 205;
    const span = r.span / r.n;
    assert.ok(Math.abs(span - le) <= 2, `ömür ${span.toFixed(2)} vs ${le.toFixed(2)}`);
    for (const k of ['com', 'inj', 'ncd']) {
      const got = r.cat[k] / r.n;
      const exp = r.coh[k] / r.n;
      assert.ok(Math.abs(got - exp) < 0.03, `${k} ölüm payı ${got.toFixed(3)} vs beklenen ${exp.toFixed(3)}`);
    }
    const uni = r.uni / r.n25;
    const pUni = sim.eduProbs(c).pUni;
    assert.ok(Math.abs(uni - pUni) < 0.05, `üniversite ${uni.toFixed(3)} vs ${pUni.toFixed(3)}`);
    const mAge = r.mAgeF / r.nMF;
    assert.ok(Math.abs(mAge - c.smamF) < 1.5, `kadın ilk evlilik yaşı ${mAge.toFixed(1)} vs ${c.smamF}`);
    const kids = r.kidsF / r.nF45;
    assert.ok(Math.abs(kids - c.tfr) / c.tfr < 0.15, `kadın başına çocuk ${kids.toFixed(2)} vs TFR ${c.tfr}`);
    const E = c.emi / 100;
    const emi = r.emi / r.n46;
    assert.ok(Math.abs(emi - E / (1 + E)) < 0.015, `göç ${emi.toFixed(3)} vs ${(E / (1 + E)).toFixed(3)}`);
    const smk = r.smk / r.n30;
    const smkE = r.smkE / r.n30;
    assert.ok(Math.abs(smk - smkE) < 0.03, `sigara ${smk.toFixed(3)} vs ${smkE.toFixed(3)}`);
  });
}

test('determinizm: aynı tohum + aynı seçimler = aynı hayat; farklı tohum farklı', () => {
  const a = live('ayni-tohum', {}, 'rand');
  const b = live('ayni-tohum', {}, 'rand');
  assert.equal(JSON.stringify(a.log), JSON.stringify(b.log));
  assert.deepEqual(a.death, b.death);
  const c = live('baska-tohum', {}, 'rand');
  assert.notEqual(JSON.stringify(a.log), JSON.stringify(c.log));
});

test('statlar: 400 hayat boyunca her yıl NaN yok, 0–100 arasında; günlük satırlarında NaN/undefined yok', () => {
  for (let i = 0; i < 400; i++) {
    const L = sim.birth(world, { seed: `nan-${i}` });
    sim.setName(L, 'X');
    L.log.push(sim.birthEntry(world, L));
    const R = sim.rng(sim.seedState(`p${i}`));
    for (let y = 0; y < 200 && L.alive; y++) {
      const out = sim.step(world, L);
      if (L.pending) out.push(...sim.choose(world, L, R.int(L.pending.options.length)));
      for (const k of ['h', 'j', 'k', 'w']) assert.ok(Number.isFinite(L.st[k]) && L.st[k] >= 0 && L.st[k] <= 100, `${k}=${L.st[k]} yaş ${L.age}`);
      L.log.push(...out);
      for (const e of out) assert.ok(!/NaN|undefined|\{\w+\}/.test(e.text) && !/NaN|undefined/.test(e.stat ?? ''), e.text + ' | ' + e.stat);
    }
    assert.ok(!L.alive);
    const rep = sim.report(world, L);
    assert.ok(rep.worldTop > 0 && rep.worldTop < 100 && rep.epitaph && rep.highlights.length >= 2);
  }
});

test('olaylar yaş aralıkları dışında hiç tetiklenmez (1500 hayat, rastgele seçimler)', () => {
  let n = 0;
  for (let i = 0; i < 1500; i++) {
    const L = live(`yas-${i}`, {}, 'rand');
    for (const e of L.log) {
      const ev = sim.EVENTS_BY_ID.get(e.id);
      if (!ev) continue;
      n++;
      assert.ok(e.age >= ev.age[0] && e.age <= ev.age[1], `${e.id} yaş ${e.age} ∉ [${ev.age}]`);
    }
  }
  assert.ok(n > 50000, `${n} olay`);
});

test('olay kütüphanesi: ≥120 olay; dayanaklılar kaynak + türetme taşıyor, renk olayları sadece küçük Keyif etkisi', () => {
  assert.ok(sim.EVENTS.length >= 120, `${sim.EVENTS.length} olay`);
  const L = sim.birth(world, { seed: 'stat', country: 'NGA' });
  sim.setName(L, 'X');
  L.age = 30;
  L.partner = { name: 'Y', sex: 'M', since: 25, alive: true };
  const c = world.byIso.get('NGA');
  for (const ev of sim.EVENTS) {
    assert.ok(ev.fl || ev.src, `${ev.id}: ne kaynak ne renk`);
    if (ev.src) {
      assert.ok(ev.src.d && ev.src.how, `${ev.id}: src.d / src.how`);
      if (ev.stat) assert.match(ev.stat(L, c, world), /\S/);
    }
    if (ev.fl) {
      const fxs = [ev.fx, ...(ev.ch ?? []).flatMap((o) => [o.fx, o.win?.fx, o.lose?.fx])].filter(Boolean);
      for (const fx of fxs) {
        assert.deepEqual(Object.keys(fx).filter((k) => k !== 'j'), [], `${ev.id}: renk olayı sadece Keyif`);
        assert.ok(Math.abs(fx.j ?? 0) <= 3, `${ev.id}: |Keyif| ≤ 3`);
      }
      for (const o of ev.ch ?? []) assert.ok(o.odds == null, `${ev.id}: renk seçimi olasılık taşımaz`);
    }
  }
  assert.ok(sim.EVENTS.filter((e) => e.ch).length >= 25, 'seçimli olaylar');
});

test('Türkçe ekler: ülke adlarına bulunma/ayrılma/yönelme', () => {
  assert.equal(sim.suffix('Türkiye', 'de'), "Türkiye'de");
  assert.equal(sim.suffix('Japonya', 'de'), "Japonya'da");
  assert.equal(sim.suffix('Irak', 'de'), "Irak'ta");
  assert.equal(sim.suffix('ABD', 'de'), "ABD'de");
  assert.equal(sim.suffix('Orta Afrika Cumhuriyeti', 'de'), "Orta Afrika Cumhuriyeti'nde");
  assert.equal(sim.suffix('Çin', 'den'), "Çin'den");
  assert.equal(sim.suffix('Almanya', 'e'), "Almanya'ya");
  assert.equal(sim.suffix('Mısır', 'e'), "Mısır'a");
});
