#!/usr/bin/env node
// Validates content/wordle/valid.json and answers.json. Exit code 1 on any failure.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALPHABET = new Set([...'abcçdefgğhıijklmnoöprsştuüvyz']);
const load = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const lists = { 'valid.json': load('valid.json'), 'answers.json': load('answers.json') };
for (const [name, list] of Object.entries(lists)) {
  console.log(`\n${name}: ${list.length} words`);
  check(Array.isArray(list) && list.every((w) => typeof w === 'string'), `${name}: array of strings`);
  const badLen = list.filter((w) => [...w].length !== 5);
  check(badLen.length === 0, `${name}: every word is 5 code points${badLen.length ? ' -> ' + badLen.slice(0, 10).join(', ') : ''}`);
  const badChars = list.filter((w) => ![...w].every((c) => ALPHABET.has(c)));
  check(badChars.length === 0, `${name}: only Turkish lowercase letters${badChars.length ? ' -> ' + badChars.slice(0, 10).join(', ') : ''}`);
  const notNfc = list.filter((w) => w !== w.normalize('NFC'));
  check(notNfc.length === 0, `${name}: NFC normalised`);
  const notLower = list.filter((w) => w !== w.toLocaleLowerCase('tr'));
  check(notLower.length === 0, `${name}: lowercase (tr)`);
  const dup = list.length - new Set(list).size;
  check(dup === 0, `${name}: no duplicates (${dup})`);
  const sorted = [...list].sort((a, b) => a.localeCompare(b, 'tr'));
  check(sorted.every((w, i) => w === list[i]), `${name}: sorted (tr collation)`);
}

const valid = new Set(lists['valid.json']);
const missing = lists['answers.json'].filter((w) => !valid.has(w));
console.log('');
check(missing.length === 0, `answers ⊆ valid${missing.length ? ' -> ' + missing.join(', ') : ''}`);
const n = lists['answers.json'].length;
check(n >= 1000 && n <= 2000, `answers count in [1000, 2000] (${n})`);

// Letter distribution of answers (informational).
const freq = {};
for (const w of lists['answers.json']) for (const c of w) freq[c] = (freq[c] ?? 0) + 1;
console.log('\nanswer letter frequency:', Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c}:${k}`).join(' '));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
