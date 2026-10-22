// Validates content/spyfall/locations.json
// Usage: node content/spyfall/validate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIN_LOCATIONS = 45;
const MIN_ROLES = 8;
const MAX_ROLES = 10;

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'locations.json'), 'utf8'));

const errors = [];
const err = (m) => errors.push(m);

// Case- and diacritic-insensitive key (Turkish-aware lowercasing).
const norm = (s) =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

if (data.version !== 1) err(`version must be 1 (got ${JSON.stringify(data.version)})`);
if (!Array.isArray(data.locations)) {
  err('locations must be an array');
  data.locations = [];
}
if (data.locations.length < MIN_LOCATIONS) err(`need >= ${MIN_LOCATIONS} locations (got ${data.locations.length})`);

const ids = new Map();
const names = new Map();
let totalRoles = 0;
let minR = Infinity;
let maxR = 0;

data.locations.forEach((loc, i) => {
  const at = `locations[${i}]${loc && loc.id ? ` (${loc.id})` : ''}`;
  if (!loc || typeof loc !== 'object') return err(`${at}: not an object`);
  const extra = Object.keys(loc).filter((k) => !['id', 'name', 'emoji', 'roles'].includes(k));
  if (extra.length) err(`${at}: unexpected keys ${extra.join(', ')}`);

  if (typeof loc.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(loc.id)) err(`${at}: id must be lowercase ASCII slug`);
  else if (ids.has(loc.id)) err(`${at}: duplicate id (also at ${ids.get(loc.id)})`);
  else ids.set(loc.id, i);

  if (typeof loc.name !== 'string' || !loc.name.trim()) err(`${at}: name missing`);
  else {
    const k = norm(loc.name);
    if (names.has(k)) err(`${at}: duplicate name "${loc.name}" (also at ${names.get(k)})`);
    else names.set(k, i);
  }

  if (typeof loc.emoji !== 'string' || !loc.emoji.trim() || /[A-Za-z0-9]/.test(loc.emoji)) err(`${at}: emoji missing/invalid`);
  else {
    const graphemes = [...new Intl.Segmenter('tr', { granularity: 'grapheme' }).segment(loc.emoji)];
    if (graphemes.length !== 1) err(`${at}: emoji must be a single grapheme (got ${graphemes.length})`);
  }

  if (!Array.isArray(loc.roles)) return err(`${at}: roles must be an array`);
  const n = loc.roles.length;
  totalRoles += n;
  minR = Math.min(minR, n);
  maxR = Math.max(maxR, n);
  if (n < MIN_ROLES || n > MAX_ROLES) err(`${at}: ${n} roles (need ${MIN_ROLES}-${MAX_ROLES})`);
  const seen = new Set();
  loc.roles.forEach((r, j) => {
    if (typeof r !== 'string' || !r.trim()) return err(`${at}: roles[${j}] empty`);
    if (r !== r.trim()) err(`${at}: roles[${j}] has surrounding whitespace`);
    const k = norm(r);
    if (seen.has(k)) err(`${at}: duplicate role "${r}"`);
    seen.add(k);
  });
});

console.log(`Locations: ${data.locations.length}`);
console.log(`Roles total: ${totalRoles} (min ${minR}, max ${maxR}, avg ${(totalRoles / (data.locations.length || 1)).toFixed(2)})`);
const hist = {};
data.locations.forEach((l) => { const n = l.roles?.length ?? 0; hist[n] = (hist[n] || 0) + 1; });
console.log(`Role-count histogram: ${Object.entries(hist).map(([k, v]) => `${k}→${v}`).join(', ')}`);

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  errors.forEach((e) => console.error(' - ' + e));
  process.exit(1);
}
console.log('OK: all checks passed');
