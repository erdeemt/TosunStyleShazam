// 🔗 Bağlantı Avı gerçek veri testleri (content/baglanti/*.json, betikle üretilir): kişi sayısı, Türkiye payı, fotoğraf kapsamı,
// şema, bağlantıların geçerliliği, yapbozların en kısa uzunluğu (bağımsız BFS) ve uçların "karışık" olması. Kurallar: PLAN.md §4.12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../../content/baglanti/${name}`, import.meta.url), 'utf8'));
const { people, meta } = read('people.json');
const E = read('edges.json');
const Z = read('puzzles.json');
const LEN = { kolay: 3, orta: 4, zor: 5 };
const adj = people.map(() => []);
for (const [a, b] of E.edges) { adj[a].push(b); adj[b].push(a); }

function dist(s, t) {
  const d = new Int16Array(people.length).fill(-1);
  d[s] = 0;
  const q = [s];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    if (u === t) return d[u];
    for (const v of adj[u]) if (d[v] < 0) { d[v] = d[u] + 1; q.push(v); }
  }
  return -1;
}

test('kişiler: 3000–5000, benzersiz, Türkiye ≥ %20, fotoğraf ≥ %80, herkesin en az bir bağlantısı var, kaynak notu', () => {
  assert.ok(people.length >= 3000 && people.length <= 5000, `${people.length}`);
  assert.equal(new Set(people.map((p) => p.q)).size, people.length);
  const tr = people.filter((p) => p.t).length;
  assert.ok(tr / people.length >= 0.2, `Türkiye ${tr}`);
  const photo = people.filter((p) => p.img).length;
  assert.ok(photo / people.length >= 0.8, `fotoğraf ${photo}`);
  assert.ok(adj.every((l) => l.length > 0), 'bağlantısız kişi kalmamalı');
  assert.match(meta.source, /Wikidata/);
  for (const p of people) {
    assert.match(p.q, /^Q[1-9]\d*$/);
    assert.ok(typeof p.n === 'string' && p.n.length > 0 && p.n.length <= 80, p.q);
    assert.ok(p.img == null || /^[^/]+\.(jpe?g|png)$/i.test(p.img), `${p.q} ${p.img}`);
    assert.ok(p.b == null || Number.isInteger(p.b));
    assert.ok((p.s ?? '').length <= 80, `${p.q} açıklama uzun`);
  }
  for (const famous of ['Q5152', 'Q615', 'Q517', 'Q34503']) assert.ok(people.some((p) => p.q === famous), `${famous} (Atatürk/Messi/Napolyon/Fatih) olmalı`);
});

test('bağlantılar: geçerli uçlar, tür ve bağlam; aynı çift bir kez', () => {
  const seen = new Set();
  for (const e of E.edges) {
    const [a, b, t, c] = e;
    assert.ok(a !== b && people[a] && people[b]);
    assert.ok(E.types[t], `tür ${t}`);
    assert.ok(c === -1 || Array.isArray(E.ctx[c]), `bağlam ${c}`);
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    assert.ok(!seen.has(k), `çift tekrar ${k}`);
    seen.add(k);
  }
  const byType = {};
  for (const e of E.edges) byType[E.types[e[2]]] = (byType[E.types[e[2]]] ?? 0) + 1;
  for (const t of ['spouse', 'parent', 'team', 'cast', 'successor', 'band']) assert.ok(byType[t] > 30, `${t}: ${byType[t]}`);
});

test('yapbozlar: her zorlukta ≥ 200; örneklemde yol geçerli ve en kısa uzunluk tam 3/4/5; uçlar fotoğraflı ve karışık', () => {
  for (const [k, L] of Object.entries(LEN)) {
    assert.ok(Z[k].length >= 200, `${k}: ${Z[k].length}`);
    const sample = Z[k].filter((_, i) => i % Math.ceil(Z[k].length / 40) === 0);
    for (const [s, t, path] of sample) {
      assert.equal(path.length, L + 1);
      assert.equal(path[0], s);
      assert.equal(path.at(-1), t);
      for (let i = 1; i < path.length; i++) assert.ok(adj[path[i - 1]].includes(path[i]), `${k} kopuk yol`);
      assert.equal(dist(s, t), L, `${k}: ${people[s].n} → ${people[t].n}`);
      assert.ok(people[s].img && people[t].img, 'uçlar fotoğraflı');
      const sameCat = people[s].c?.[0] && people[s].c[0] === people[t].c?.[0];
      const gap = Math.abs((people[s].b ?? 0) - (people[t].b ?? 0));
      assert.ok(!sameCat || gap >= 60, `karışık değil: ${people[s].n} / ${people[t].n}`);
    }
    const withTr = Z[k].filter(([s, t]) => people[s].t || people[t].t).length;
    assert.ok(withTr / Z[k].length >= 0.3, `${k}: Türkiye'den uç ${withTr}`);
  }
});
