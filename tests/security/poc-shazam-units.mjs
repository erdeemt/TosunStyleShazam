// PoC (süreç içi, ağ yok): Shazam online doğrulamaları.
// 1) Adres allowlist kenar durumları  2) "çoklu tahmin" hilesi (matcher)  3) prep/norm CPU maliyeti  4) prep bellek
// Kullanım: node tests/security/poc-shazam-units.mjs
import shazam from '../../server/games/shazam.js';
import { isCorrect, norm } from '../../server/matcher.js';

// 1) URL kenar durumları: hangileri kabul ediliyor, hangi href'e dönüşüyor?
const urls = [
  'https://p.scdn.co/mp3-preview/x',
  'https://P.SCDN.CO/x',
  'https://p.scdn.co./x',
  'https://evil.com@p.scdn.co/x',
  'https://p.scdn.co@evil.com/x',
  'https://evil.com\\@p.scdn.co/x',
  'https://p.scdn.co\\@evil.com/x',
  'https://p.scdn.co:8443/x',
  'https://p.scdn.co%2eevil.com/x',
  'https://p%2escdn.co/x',
  'https://xn--p-scdn-co/x',
  'https://p.scdn.co.evil.com/x',
  'https://p。scdn。co/x', // ideografik nokta
  'https://ｐ.scdn.co/x', // tam genişlik
  'https://p.scdn.co/x"><script>',
  'https://p.scdn.co/x\n<script>',
  'https://cdns-preview-a.dzcdn.net/x',
  'https://cdns-preview-ab.dzcdn.net/x',
  'HTTPS://p.scdn.co/x',
  'https:p.scdn.co/x',
  'https:/\\p.scdn.co/x',
  ' https://p.scdn.co/x',
  'javascript://p.scdn.co/%0aalert(1)',
  'blob:https://p.scdn.co/x',
];
console.log('--- 1) Ses adresi allowlist ---');
for (const u of urls) {
  const p = shazam.prep(null, { op: 'add', tracks: [{ title: 'x', artist: 'y', audio: u }] });
  console.log(JSON.stringify(u).padEnd(42), '→', p.tracks[0]?.audio ?? 'RED');
}
const ytCases = ['dQw4w9WgXcQ', 'abc', '../../x', 'a'.repeat(21), '------', '______'];
for (const y of ytCases) {
  const p = shazam.prep(null, { op: 'add', tracks: [{ title: 'x', ytId: y }] });
  console.log('ytId', JSON.stringify(y).padEnd(25), '→', p.tracks[0]?.ytId ?? 'RED');
}

// 2) Çoklu tahmin: odanın şarkı listesi (pool) herkese açık; adları yan yana yazınca "içeriyor" kuralı tutuyor.
console.log('\n--- 2) Çoklu tahmin hilesi ---');
const pool = ['Şımarık', 'Gidiyorum', 'Bohemian Rhapsody', 'Yalnızlar Rıhtımı', 'Hayat Bayram Olsa', 'Dudu', 'Kuzu Kuzu'];
const shotgun = 'simarik gidiyorum bohemian rhapsody yalnizlar rihtimi dudu kuzu kuzu';
console.log(`tahmin (${shotgun.length} karakter): "${shotgun}"`);
for (const title of pool) console.log(`  cevap "${title}" →`, isCorrect(shotgun, { title }) ? 'DOĞRU sayıldı' : 'yanlış');

// 3) CPU: en kötü durum başlıklarla prep ve norm süresi
console.log('\n--- 3) CPU ---');
const evil = ' - '.repeat(66) + 'x';
const evil2 = '('.repeat(200);
for (const [name, s] of [['" - " x66', evil], ['"(" x200', evil2], ['normal', 'Bohemian Rhapsody - 2011 Remaster']]) {
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) norm(s);
  console.log(`norm ${name}: ${((performance.now() - t0) / 1000).toFixed(3)} ms/çağrı`);
}
let prep = null;
const t1 = performance.now();
for (let m = 0; m < 5; m++) prep = shazam.prep(prep, { op: 'add', tracks: Array.from({ length: 60 }, (_, i) => ({ title: `${'(' .repeat(150)}${m}-${i}`, artist: `a${m}-${i}${' - '.repeat(60)}`, ytId: 'abcdefghijk' })) });
const t2 = performance.now();
prep = shazam.prep(prep, { op: 'add', tracks: [] });
console.log(`300 şarkı sonrası tek boş prep mesajı: ${(performance.now() - t2).toFixed(1)} ms (tüm liste her mesajda yeniden anahtarlanıyor); 5 dolu mesaj: ${(t2 - t1).toFixed(0)} ms`);

// 4) Bellek: bir odanın prep'i en fazla ne kadar tutar? (alt[] istemciye hiç gitmez ama saklanır)
console.log('\n--- 4) Bellek ---');
global.gc?.();
const before = process.memoryUsage().heapUsed;
const rooms = [];
const astral = '😀'.repeat(199);
for (let r = 0; r < 20; r++) {
  let p = null;
  for (let m = 0; m < 300; m++) {
    p = shazam.prep(p, { op: 'add', tracks: [{ title: `t${r}-${m}${astral}`, artist: `a${m}${astral}`, alt: [astral + 'x', astral + 'y', astral + 'z'], audio: `https://p.scdn.co/mp3-preview/${'a'.repeat(560)}`, cover: `https://i.scdn.co/image/${'b'.repeat(560)}` }] });
  }
  rooms.push(p);
}
global.gc?.();
const per = (process.memoryUsage().heapUsed - before) / 20;
console.log(`oda başına prep belleği ≈ ${(per / 1024 / 1024).toFixed(2)} MB → 200 oda ≈ ${(per * 200 / 1024 / 1024).toFixed(0)} MB`);
console.log(`(ama tek şarkı ~${JSON.stringify(rooms[0].tracks[0]).length} bayt; 8 KB mesaja 1 şarkı sığar → oda başına 300 mesaj ≈ 50 sn)`);
