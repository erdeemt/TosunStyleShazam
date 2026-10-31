// MP3 çerçeve ayrıştırıcı/kesici (server/mp3.js): Shazam online ses vekili sadece adımın süresi kadar çerçeve gönderir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutMp3, parseHeader, parseMp3, synthMp3 } from '../../server/mp3.js';
import { parseRange } from '../../server/clips.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≉ ${b} (±${tol})`);

test('başlık: MPEG-1 128 kbps 44.1 kHz → 417/418 bayt, 1152 örnek; geçersiz başlıklar null', () => {
  const h = parseHeader(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 0);
  assert.equal(h.bitrate, 128000);
  assert.equal(h.sampleRate, 44100);
  assert.equal(h.samples, 1152);
  assert.equal(h.size, 417);
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0x92, 0x00]), 0).size, 418, 'doldurma biti');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0x90, 0xc0]), 0).sideInfo, 17, 'mono yan bilgi');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x00]), 0), null, 'bitrate 15');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0x00, 0x00]), 0), null, 'serbest biçim');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x00]), 0), null, 'örnekleme 3');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfd, 0x90, 0x00]), 0), null, 'Layer II');
  assert.equal(parseHeader(Buffer.from([0xff, 0xeb, 0x90, 0x00]), 0), null, 'ayrılmış sürüm');
  assert.equal(parseHeader(Buffer.from([0xff, 0xfb, 0x90]), 0), null, 'kısa');
  // MPEG-2 (22.05 kHz, 64 kbps): 576 örnek, 72 × 64000 / 22050 = 208
  const m2 = parseHeader(Buffer.from([0xff, 0xf3, 0x80, 0x00]), 0);
  assert.equal(m2.samples, 576);
  assert.equal(m2.sampleRate, 22050);
  assert.equal(m2.size, 208);
  // MPEG-2.5 (11.025 kHz)
  assert.equal(parseHeader(Buffer.from([0xff, 0xe3, 0x80, 0x00]), 0).sampleRate, 11025);
});

test('ayrıştırma: düz akış, ID3v2 (içi 0xFF dolu), Xing çerçevesi, aradaki çöp, ID3v1, yarım son çerçeve', () => {
  const plain = parseMp3(synthMp3({ seconds: 10 }));
  near(plain.duration, 10, 0.03, 'süre');
  assert.equal(plain.sampleRate, 44100);

  const tricky = synthMp3({ seconds: 10, id3: 4096, xing: true, junkAt: 100, id3v1: true });
  const p = parseMp3(tricky);
  assert.equal(p.frames.length, plain.frames.length, 'Xing atlanmalı, çöp ve etiketler sayılmamalı');
  assert.ok(p.frames[0].off >= 10 + 4096 + 417, 'ilk ses çerçevesi ID3 + Xing sonrasında');
  assert.equal(tricky.toString('latin1', p.frames[0].off - 417 + 36, p.frames[0].off - 417 + 40), 'Xing');
  for (const f of p.frames) assert.ok(parseHeader(tricky, f.off), 'her çerçeve geçerli başlıkta başlar');

  const truncated = synthMp3({ seconds: 2 }).subarray(0, -100);
  const t = parseMp3(truncated);
  assert.equal(t.frames.at(-1).off + t.frames.at(-1).size <= truncated.length, true, 'yarım çerçeve atılır');

  for (const sr of [22050, 11025, 48000]) {
    const q = parseMp3(synthMp3({ seconds: 3, sampleRate: sr, kbps: sr > 30000 ? 192 : 32 }));
    near(q.duration, 3, 0.07, `süre @${sr}`);
  }
  assert.equal(parseMp3(Buffer.from('<html>bu ses değil</html>')), null);
  assert.equal(parseMp3(Buffer.alloc(5000, 0xff)), null, '0xFF dolu çöp MP3 sayılmaz');
  assert.equal(parseMp3(Buffer.alloc(0)), null);
});

test('kesme: [başlangıç, başlangıç + süre] + 2 baş / 1 son çerçeve; çıktı geçerli MP3; tam önizleme asla', () => {
  const src = synthMp3({ seconds: 30, id3: 512, xing: true });
  const parsed = parseMp3(src);
  const fd = parsed.frameDuration;
  for (const [start, dur] of [[0, 0.5], [7.3, 1.5], [12, 5], [9.99, 10], [5, 20], [28, 5]]) {
    const clip = cutMp3(src, parsed, start, dur);
    const cp = parseMp3(clip);
    assert.ok(cp, 'kesilen klip MP3 olarak ayrışmalı');
    assert.equal(clip.subarray(0, 3).toString('latin1') === 'ID3', false, 'ID3 etiketi gönderilmez');
    const want = Math.min(30, start + dur) - Math.max(0, start);
    assert.ok(cp.duration >= Math.min(want, parsed.duration - start) - fd, `klip içeriği kısa (${start}+${dur}: ${cp.duration})`);
    assert.ok(cp.duration <= want + 5 * fd, `klip fazla uzun (${start}+${dur}: ${cp.duration})`);
    assert.ok(clip.length < src.length / 1.4 || dur >= 20, 'tam önizleme gönderilmemeli');
  }
  // 0.5 sn adım: ≤ 0.5 sn + en fazla 5 çerçeve (2 baş + 1 son + yuvarlama)
  const short = parseMp3(cutMp3(src, parsed, 3, 0.5));
  assert.ok(short.duration <= 0.5 + 5 * fd, `0.5 sn klip ${short.duration}`);
  // Sona kadar (açılış)
  const rest = parseMp3(cutMp3(src, parsed, 10, Infinity));
  near(rest.duration, parsed.duration - 10, 3 * fd, 'sona kadar');
  // Aralık dışı başlangıç
  assert.equal(cutMp3(src, parsed, 999, 1).length, 0);
});

test('Range ayrıştırma: tek aralık, son N bayt, çoklu aralık yok sayılır, geçersiz → bad', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'çoklu aralık → tamamı');
  assert.equal(parseRange('bytes=100-', 100), 'bad');
  assert.equal(parseRange('bytes=5-2', 100), 'bad');
  assert.equal(parseRange('bytes=-', 100), 'bad');
  assert.equal(parseRange('bytes=-0', 100), 'bad');
  assert.equal(parseRange('items=0-1', 100), 'bad');
  assert.equal(parseRange('bytes=99999999999999999999-', 100), 'bad');
});
