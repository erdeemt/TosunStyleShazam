// QA: Shazam online — 8 telefon, 3 tur. Karışık eylemler (doğru/yanlış/geç/pes), puanlar kurallardan bağımsız
// hesaplanıp karşılaştırılır; açılıştan önce şarkı bilgisi hiçbir telefonun ekranında ve WS çerçevesinde yok.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from './qa-shazam-online-lib.mjs';

let env;
before(async () => { env = await Q.setup({ timeScale: 1 }); });
after(async () => { await env?.close(); });

const issues = [];
const soft = (ok, msg) => { if (!ok) { issues.push(msg); console.log('  ✗', msg); } };

test('8 telefon: 3 tur, puan kuralları, sızıntı yok, odak korunur', async () => {
  const TR = Q.makeTracks(12);
  const names = ['Ali', 'Ayşe', 'Mert', 'Zeynep', 'Can', 'Deniz', 'Ece', 'Fırat'];
  const { ps, host } = await Q.room(env, names);
  await Q.injectTracks(host, TR.slice(0, 6), 'Birinci');
  await Q.injectTracks(host, TR.slice(6), 'İkinci');
  await Q.waitNet(ps[7].page, 'room.prep.trackCount === 12');
  await Q.setSetting(host, 'Tur süresi', 180);
  await Q.setSetting(host, 'Şarkı sayısı', 5); // 5 seçeneği en küçük; 3 turda bitirmek için 5 tur oynanır
  await Q.waitNet(ps[7].page, 'room.settings.roundSeconds === 180 && room.settings.rounds === 5');
  await Q.shot(ps[7], '8p-00-lobby');
  await Q.start(host, ps);
  const expected = Object.fromEntries(names.map((n) => [n, 0]));

  // Her oyuncunun planı: [geç sayısı, sonra 'right' | 'wrong-all' | 'giveup']
  const plans = [
    [[0, 'right'], [1, 'right'], [0, 'giveup'], [4, 'right'], [0, 'right']],
    [[0, 'right'], [0, 'right'], [2, 'right'], [0, 'giveup'], [3, 'right']],
    [[1, 'right'], [0, 'wrong-all'], [2, 'right'], [1, 'right'], [0, 'right']],
    [[1, 'right'], [4, 'right'], [0, 'giveup'], [0, 'right'], [1, 'right']],
    [[2, 'right'], [0, 'giveup'], [3, 'right'], [2, 'right'], [0, 'wrong-all']],
    [[0, 'wrong-all'], [2, 'right'], [4, 'right'], [0, 'right'], [2, 'right']],
    [[3, 'right'], [1, 'right'], [1, 'right'], [0, 'giveup'], [4, 'right']],
    [[4, 'right'], [0, 'right'], [0, 'right'], [3, 'right'], [0, 'giveup']],
  ];

  for (let r = 1; r <= 5; r++) {
    await Q.waitNet(ps[0].page, `view.round === ${r} && view.phase === 'play'`);
    const t = Q.trackOf((await Q.st(ps[0].page)).view, TR);
    // Fırat yazıyor; diğerleri oynarken odak/metin korunmalı (sadece 1. turda)
    const typer = ps[7];
    if (r === 1) { await typer.page.click('#ol-guess'); await typer.page.keyboard.type('yaz'); }
    const first = {};
    for (const [i, p] of ps.entries()) {
      if (r === 1 && i === 7) continue;
      await play(p, plans[i][r - 1], t, first, expected);
      if (r === 1 && i === 3) {
        const f = await typer.page.evaluate(() => ({ id: document.activeElement?.id, val: document.getElementById('ol-guess')?.value }));
        soft(f.id === 'ol-guess' && f.val === 'yaz', `8 kişide yazarken odak/metin: ${JSON.stringify(f)}`);
        await Q.shot(typer, '8p-10-typing-while-others-play');
      }
    }
    if (r === 1) { await typer.page.fill('#ol-guess', ''); await play(typer, plans[7][0], t, first, expected); }
    await Q.waitNet(ps[0].page, "view.phase === 'reveal'");
    // Sızıntı: açılıştan önce
    for (const p of ps) {
      const l = Q.leaks(p, t, r);
      soft(l.length === 0, `${p.name} tur ${r} sızıntı: ${l}`);
    }
    const v = (await Q.st(ps[0].page)).view;
    const got = Object.fromEntries(v.players.map((p) => [p.name, p.score]));
    soft(JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.keys(got).map((k) => [k, expected[k]]))), `tur ${r} skorlar ${JSON.stringify(got)} beklenen ${JSON.stringify(expected)}`);
    if (r === 1) { await Q.shot(ps[3], '8p-20-reveal-r1'); await Q.shot(host, '8p-20-reveal-r1-host'); }
    await host.page.click(`button:has-text("${r === 5 ? 'Sonuçları göster' : 'Sonraki şarkı'}")`);
  }
  await Q.waitNet(ps[5].page, "room.phase === 'over'");
  await ps[5].page.waitForTimeout(300);
  await Q.shot(ps[5], '8p-30-over');
  soft((await Q.overflow(ps[5].page)).scrollW <= 360, '8 kişi final taşma');
  // Ekranda sıralama doğru mu
  const rows = await ps[5].page.locator('#shazam-online .player-list li').allTextContents();
  console.log('final:', rows);
  const nums = rows.map((x) => Number(x.match(/(\d+) puan/)?.[1]));
  soft(nums.every((n, i) => i === 0 || nums[i - 1] >= n), `final sıralı değil: ${nums}`);
  // Bütün telefonlarda tahmin metinlerinin başkasına gitmediği (WS)
  for (const p of ps) {
    const others = p.frames.filter((f) => f.includes('"guesses"')).map((f) => { try { return JSON.parse(f).view; } catch { return null; } }).filter(Boolean);
    soft(others.every((v) => !JSON.stringify(v.players).includes('guesses')), `${p.name}: başkalarının tahminleri çerçevede`);
  }
  for (const p of ps) soft(Q.realErrors(p).length === 0, `${p.name} konsol: ${Q.realErrors(p).join(' | ')}`);
  console.log('ISSUES:', JSON.stringify(issues, null, 1));
  for (const p of ps) await p.ctx.close();
  assert.deepEqual(issues, []);
});

async function play(p, [skips, end], t, first, expected) {
  for (let i = 0; i < skips; i++) await Q.skip(p);
  const stage = Math.min(skips, 4);
  if (end === 'right') {
    await Q.guess(p, t.title);
    const bonus = first[stage] ? 0 : 1;
    first[stage] = p.name;
    expected[p.name] += 5 - stage + bonus;
  } else if (end === 'giveup') {
    const v = (await Q.st(p.page)).view;
    if (v.me.done) return;
    await Q.giveUp(p); // Pes et artık her adımda
    if (!(await Q.st(p.page)).view.me?.done && (await Q.st(p.page)).view.phase === 'play') throw new Error(`${p.name} pes edemedi`);
  } else {
    for (let i = (await Q.st(p.page)).view.me.stage; i <= 4; i++) await Q.guess(p, `yanlış ${i}`);
    const v = (await Q.st(p.page)).view;
    if (!(v.me.done && !v.me.won)) throw new Error(`${p.name} 5 yanlıştan sonra bitmedi`);
  }
}
