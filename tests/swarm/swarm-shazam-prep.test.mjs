// Tosun Shazam (online) bekleme odası hazırlığı (`prep`) — düşmanca/bozuk girdiler (PLAN §3.3, §3.4, §4.4).
// Kim gönderebilir (sadece host, sadece bekleme odasında), bozuk şekiller (null/dizi/iç içe/toString tuzakları/dev diziler),
// adres süzgeci (https + bilinen CDN; javascript:/data:/http:/hile alan adları), metin kısaltma, unicode/RTL, 300+ şarkı,
// tekrarlar, çok kaynak, room özetinin küçük kalması, 8 KB mesaj sınırı ve hız sınırının parça parça gönderimle etkileşimi.
// Doğrulanmış hatalar `{ todo }` olarak işaretli (npm test yeşil kalır).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, Bot, sleep } from '../lib/bot.js';
import { createRng } from '../../server/rng.js';
import { makeTracks, sendPrep, deezerLikeTrack, playToEnd, poolOf } from './swarm-shazam-lib.mjs';
import { trackOfView } from '../lib/shazam-keys.js';

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.01, seed: 51 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

async function fresh(n = 2) {
  const r = await makeRoom(srv.wsUrl, 'shazam', n, 'Hazır');
  all.push(...r.bots);
  return r;
}

// Sıralı işleme garantisi: ayar değişikliğini gönderip yansımasını bekle (önceki mesajlar işlenmiş olur).
let barrierN = 0;
async function barrier(host) {
  const rounds = 3 + (barrierN++ % 27);
  host.send({ t: 'settings', settings: { rounds } });
  return host.waitRoom((r) => r.settings.rounds === rounds, { timeout: 3000 });
}

const noInternal = (bots) => {
  for (const b of bots) assert.deepEqual(b.errors.filter((e) => e.code === 'internal'), [], `${b.name} internal hata aldı`);
};

// Oyunu herkes pes ederek baştan sona oynat; her turun medya + açıklamasını döndür.
async function playThrough(host, bots, rounds = 30) {
  host.send({ t: 'settings', settings: { rounds, roundSeconds: 180 } });
  await host.waitRoom((r) => r.settings.rounds === rounds);
  host.send({ t: 'start' });
  return playToEnd(host, bots);
}

test('prep yetkisi: host olmayan, odasız, hazırlıksız oyun, oyun sırasında ve bittikten sonra reddedilir', async () => {
  const lone = await new Bot(srv.wsUrl, 'Odasız').connect();
  all.push(lone);
  lone.send({ t: 'prep', data: { op: 'add', tracks: makeTracks(3, 1) } });
  assert.match((await lone.waitFor((m) => m.t === 'error')).message, /odada değilsin/);

  const spy = await makeRoom(srv.wsUrl, 'spyfall', 3, 'Casus');
  all.push(...spy.bots);
  spy.host.send({ t: 'prep', data: { op: 'add', tracks: [] } });
  assert.match((await spy.host.waitFor((m) => m.t === 'error')).message, /hazırlık yok/);

  const { bots, host } = await fresh(2);
  bots[1].send({ t: 'prep', data: { op: 'add', tracks: makeTracks(5, 2) } });
  assert.match((await bots[1].waitFor((m) => m.t === 'error')).message, /oda sahibi/);
  assert.equal((await barrier(host)).prep.trackCount, 0);
  await sendPrep(host, makeTracks(4, 3));
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'play');
  host.send({ t: 'prep', data: { op: 'reset' } });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /bekleme odasında/);
  await playToEnd(host, bots);
  host.send({ t: 'prep', data: { op: 'reset' } });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /bekleme odasında/);
  assert.equal(host.room.prep.trackCount, 4, 'oyun sonrası prep korunur');
  noInternal(bots);
});

test('bozuk prep şekilleri: hiçbiri internal hata vermez, odaya geçersiz şarkı girmez', async () => {
  const { bots, host } = await fresh(2);
  const deep = (d) => (d ? { x: deep(d - 1) } : 1);
  const payloads = [
    '{"t":"prep","data":{"__proto__":{"op":"add"},"op":"reset"}}', // (reset: listenin başında, sonrakileri silmesin)
    { t: 'prep' }, { t: 'prep', data: null }, { t: 'prep', data: [] }, { t: 'prep', data: 'add' }, { t: 'prep', data: 42 },
    { t: 'prep', data: { op: { toString: 1 } } }, { t: 'prep', data: { op: ['add'] } }, { t: 'prep', data: { op: 'ADD' } },
    { t: 'prep', data: { op: 'add', tracks: { length: 1e9, 0: makeTracks(1, 9)[0] } } },
    { t: 'prep', data: { op: 'add', tracks: 'Şımarık' } },
    { t: 'prep', data: { op: 'add', tracks: [null, 1, 'x', true, [], [[[]]], {}, { title: null }] } },
    { t: 'prep', data: { op: 'add', tracks: Array(3500).fill(1) } }, // dev dizi (8 KB içinde)
    { t: 'prep', data: { op: 'add', tracks: [{ title: { toString: 1, valueOf: 1 }, audio: 'https://p.scdn.co/mp3-preview/abcdefghijk' }] } },
    { t: 'prep', data: { op: 'add', tracks: [{ title: ['a'], audio: 'https://p.scdn.co/mp3-preview/abcdefghijk' }, { title: 'ok', ytId: { toString: 1 } }] } },
    { t: 'prep', data: { op: 'add', tracks: [{ title: deep(60), artist: deep(60), audio: 'https://p.scdn.co/mp3-preview/abcdefghijk' }] } },
    { t: 'prep', data: { op: 'add', tracks: [{ title: 'Derin', alt: deep(200), audio: 'https://p.scdn.co/mp3-preview/derin123456', ytId: deep(10), cover: deep(10) }] } },
    { t: 'prep', data: { op: 'add', source: { toString: 1 }, tracks: [] } },
    { t: 'prep', data: { op: 'add', source: deep(100), tracks: [] } },
    { t: 'prep', data: { op: 'add', __proto__: { tracks: makeTracks(3, 1) } } },
    '{"t":"prep","data":{"op":"add","tracks":[{"__proto__":{"title":"proto"},"audio":"https://p.scdn.co/mp3-preview/abcdefghijk"}]}}',
    '{"t":"prep","data":{"op":"add","tracks":[{"constructor":{"prototype":{"x":1}},"title":"Yapıcı","audio":"https://p.scdn.co/mp3-preview/yapici12345"}]}}',
  ];
  for (const p of payloads) host.sendRaw(p);
  const r = await barrier(host);
  noInternal(bots);
  assert.equal(r.prep.trackCount, 2, 'sadece "Derin" ve "Yapıcı" geçerli (geçerli önizleme adresi + metin başlık)');
  assert.ok(host.errors.every((e) => e.code === 'game'), 'tüm hatalar oyun hatası olmalı');
  assert.ok(await (async () => { const b = await new Bot(srv.wsUrl, 'Nabız').connect(); all.push(b); return true; })(), 'sunucu ayakta');
  assert.doesNotMatch(srv.log(), /Lobi hatası|view hatası/);
});

test('adres süzgeci: sadece https + bilinen CDN; hileli alan adları, javascript:/data:/http: elenir', async () => {
  const { bots, host } = await fresh(2);
  let i = 0;
  const T = (audio, extra = {}) => ({ title: `Adres ${String.fromCharCode(65 + i)}${i++}`, artist: `Sanatçı ${i}`, audio, ...extra });
  const bad = [
    'http://p.scdn.co/mp3-preview/a', 'javascript:alert(1)//p.scdn.co', 'data:audio/mp3;base64,AAAA', 'file:///etc/passwd',
    'https://p.scdn.co@evil.example/x', 'https://p.scdn.co.evil.example/x', 'https://evil.example/#p.scdn.co', 'https://evil.example/?p.scdn.co',
    'https://xp.scdn.co/x', 'https://p.scdn.co./x', 'https://p.sсdn.co/x' /* kiril с */, 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://cdns-preview-ab.dzcdn.net/x', 'https://cdnt-preview.dzcdn.net.evil/x', `https://p.scdn.co/${'a'.repeat(600)}`,
    'wss://p.scdn.co/x', 'https:\\\\evil.example\\p.scdn.co', '//p.scdn.co/x', 'https://P.SCDN.CO.evil.example/', 'https://p.scdn.co\@evil.example/',
  ];
  // Son ikisi WHATWG URL normalleştirmesiyle meşru adrese dönüşür (baştaki boşluk, "https:" sonrası eğik çizgisiz) — zararsız.
  const good = ['https://p.scdn.co/mp3-preview/ok1', 'https://P.SCDN.CO/mp3-preview/ok2', 'https://cdns-preview-e.dzcdn.net/stream/ok3', 'https://cdnt-preview.dzcdn.net/api/ok4', ' https://p.scdn.co/lead-space', 'https:p.scdn.co/no-slash'];
  const covers = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://evil.example/c.jpg', 'http://i.scdn.co/image/x', 'https://i.ytimg.com/vi/x/hq.jpg', 'https://image-cdn-ak.spotifycdn.com/image/x', 'https://e-cdns-images.dzcdn.net/images/x'];
  const tracks = [...bad.map((a) => T(a)), ...good.map((a, k) => T(a, { cover: covers[k], spotifyId: k === 0 ? 'bad/../id' : 'GoodSpotifyId123' })), T(good[0].replace('ok1', 'ok5'), { cover: covers[4] }), T(good[0].replace('ok1', 'ok6'), { cover: covers[5] }), T(good[0].replace('ok1', 'ok7'), { cover: covers[6] })];
  host.send({ t: 'prep', data: { op: 'add', source: 'Adresler', tracks } });
  const r = await barrier(host);
  assert.equal(r.prep.trackCount, good.length + 3, 'sadece bilinen CDN adresli şarkılar');
  const rounds = await playThrough(host, bots);
  for (const { media, reveal } of rounds) {
    // İstemciye ses adresi gitmez; sadece opak klip adresi (sunucu süzülmüş CDN adresinden indirir)
    assert.ok(!('audio' in media) && /^\/api\/clip\/[\w-]{22}$/.test(media.clip), `klip: ${JSON.stringify(media)}`);
    assert.ok(reveal.cover == null || /^https:\/\/(i\.ytimg\.com|image-cdn-ak\.spotifycdn\.com|e-cdns-images\.dzcdn\.net)\//.test(reveal.cover), `kapak: ${reveal.cover}`);
    assert.ok(reveal.spotifyId == null || /^[A-Za-z0-9]{10,30}$/.test(reveal.spotifyId));
  }
  noInternal(bots);
});

test('https adreste kullanıcı:parola@ ve özel port reddedilir', async () => {
  const { host } = await fresh(2);
  host.send({ t: 'prep', data: { op: 'add', tracks: [
    { title: 'Port', artist: 'A', audio: 'https://p.scdn.co:8443/mp3-preview/x' },
    { title: 'Userinfo', artist: 'B', audio: 'https://user:pw@p.scdn.co/mp3-preview/y' },
  ] } });
  const r = await barrier(host);
  assert.equal(r.prep.trackCount, 0);
});

test('metinler: çok uzun ad/sanatçı/kaynak kısaltılır, emoji ve birleşik karakterler bölünmez; özet küçük kalır', async () => {
  const { bots, host } = await fresh(2);
  const long = 'Çok uzun şarkı adı '.repeat(30); // ~570 karakter
  const emoji = '🎵'.repeat(250);
  host.send({ t: 'prep', data: { op: 'add', source: 'K'.repeat(500), tracks: [
    { title: long, artist: 'Uzun Sanatçı', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaaa', alt: [long, long, long, long, long].map((x, k) => `${k}${x}`) },
    { title: `Emoji ${emoji}`, artist: 'E', audio: 'https://p.scdn.co/mp3-preview/bbbbbbbbbbb' },
    { title: 'Birleşik é́́', artist: 'Zalgo z̶̷̸', audio: 'https://p.scdn.co/mp3-preview/ccccccccccc' },
  ] } });
  const r = await barrier(host);
  assert.equal(r.prep.trackCount, 3);
  const srcLen = [...r.prep.sources[0]].length;
  assert.ok(srcLen > 0 && srcLen <= 80, `kaynak adı ≤ 80 karakter (${srcLen})`);
  host.send({ t: 'prep', data: { op: 'add', tracks: makeTracks(3, 58) } }); // çalınmayabilecek yedek şarkılar
  await barrier(host);
  const rounds = await playThrough(host, bots);
  for (const { reveal } of rounds) {
    assert.ok([...reveal.title].length <= 200, `başlık ≤ 200 karakter (${[...reveal.title].length})`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(reveal.title), 'yarım emoji (tek vekil) kalmamalı');
  }
  noInternal(bots);
});

test('kontrol/yön karakterleri (RTL override, sıfır genişlik, NUL) şarkı ve kaynak adlarından atılmalı (oyuncu adları gibi)', async () => {
  const { bots, host } = await fresh(2);
  host.send({ t: 'prep', data: { op: 'add', source: 'Liste‮txt.exe', tracks: [
    { title: 'Ters‮çevir', artist: 'Sıfır​genişlik', audio: 'https://p.scdn.co/mp3-preview/ddddddddddd' }, { title: 'NUL\u0000karakter', artist: 'X', audio: 'https://p.scdn.co/mp3-preview/eeeeeeeeeee' }, { title: 'Temiz', artist: 'Y', audio: 'https://p.scdn.co/mp3-preview/fffffffffff' }, { title: 'Yedek', artist: 'Z', audio: 'https://p.scdn.co/mp3-preview/ggggggggggg' },
  ] } });
  const r = await barrier(host);
  host.send({ t: 'start' });
  const v = await host.waitView((x) => x.phase === 'play');
  const bad = /[\u0000-\u001f​-‏‪-‮⁦-⁩]/;
  assert.ok(!bad.test(r.prep.sources.join('')), `kaynak adında kontrol karakteri: ${JSON.stringify(r.prep.sources)}`);
  assert.ok(!bad.test(poolOf(host, v).join('')), `havuzda kontrol karakteri: ${JSON.stringify(poolOf(host, v))}`);
  for (const b of bots) b.action({ type: 'giveUp' });
});

test('300+ şarkı: 25\'lik parçalarla 330 şarkı → 300\'de durur, sonraki eklemeler yok sayılır, reset sıfırlar', async () => {
  const { bots, host } = await fresh(2);
  const tracks = makeTracks(330, 52);
  await sendPrep(host, tracks, { wait: false });
  const r = await host.waitRoom((x) => x.prep.trackCount === 300, { timeout: 5000 });
  assert.equal(r.prep.maxTracks, 300);
  host.send({ t: 'prep', data: { op: 'add', tracks: makeTracks(5, 99, { tag: ' ek' }) } });
  assert.equal((await barrier(host)).prep.trackCount, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(host.messages.findLast((m) => m.t === 'room'))) < 4096, 'room mesajı 300 şarkıda da küçük');
  // Ayar 30 tur, 300 şarkı → totalRounds 30; havuz 300
  host.send({ t: 'settings', settings: { rounds: 30 } });
  await host.waitRoom((x) => x.settings.rounds === 30);
  host.send({ t: 'start' });
  const v = await host.waitView((x) => x.phase === 'play');
  assert.equal(v.totalRounds, 30);
  assert.equal(poolOf(host, v)?.length, 300);
  for (const b of bots) b.action({ type: 'giveUp' });
  noInternal(bots);
});

test('tekrarlar: aynı ad + ilk sanatçı (büyük/küçük harf, Türkçe karakter, feat., parantez) bir kez sayılır', async () => {
  const { host } = await fresh(2);
  host.send({ t: 'prep', data: { op: 'add', tracks: [
    { title: 'Şımarık', artist: 'Tarkan', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa1' },
    { title: 'simarik', artist: 'TARKAN', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa2' },
    { title: 'Şımarık (Remastered)', artist: 'Tarkan feat. Biri', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa3' },
    { title: 'ŞIMARIK', artist: 'Tarkan, Başkası', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa4' },
    { title: 'Şımarık', artist: 'Başka Sanatçı', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa5' }, // farklı sanatçı → farklı şarkı
  ] } });
  assert.equal((await barrier(host)).prep.trackCount, 2);
  // Parçalar arası ve tekrar gönderimde de tekrar eklenmez
  host.send({ t: 'prep', data: { op: 'add', tracks: [{ title: 'Şımarık', artist: 'Tarkan', audio: 'https://p.scdn.co/mp3-preview/aaaaaaaaaa6' }] } });
  assert.equal((await barrier(host)).prep.trackCount, 2);
});

test('sanatçısı olmayan farklı şarkılar birbirinin tekrarı sayılmamalı', async () => {
  const { host } = await fresh(2);
  host.send({ t: 'prep', data: { op: 'add', tracks: [
    { title: 'Birinci Şarkı', audio: 'https://p.scdn.co/mp3-preview/bbbbbbbbbb1' }, { title: 'İkinci Şarkı', audio: 'https://p.scdn.co/mp3-preview/bbbbbbbbbb2' }, { title: 'Üçüncü Şarkı', artist: '', audio: 'https://p.scdn.co/mp3-preview/bbbbbbbbbb3' },
  ] } });
  assert.equal((await barrier(host)).prep.trackCount, 3);
});

test('Latin dışı alfabeyle (Kiril, Hangıl, Arapça, Yunanca) yazılmış şarkılar eklenebilmeli ve bilinebilmeli', async () => {
  const { bots, host } = await fresh(2);
  const tracks = [
    { title: 'Группа крови', artist: 'Кино', audio: 'https://p.scdn.co/mp3-preview/ccccccccccc' },
    { title: '강남스타일', artist: 'PSY', audio: 'https://p.scdn.co/mp3-preview/ddddddddddd' },
    { title: 'Ελπίδα', artist: 'Νίκος', audio: 'https://p.scdn.co/mp3-preview/eeeeeeeeeee' },
    { title: 'حبيبي', artist: 'عمرو دياب', audio: 'https://p.scdn.co/mp3-preview/fffffffffff' },
  ];
  host.send({ t: 'prep', data: { op: 'add', tracks } });
  assert.equal((await barrier(host)).prep.trackCount, 4, 'dört farklı şarkı');
  host.send({ t: 'settings', settings: { rounds: 4 } });
  await host.waitRoom((x) => x.settings.rounds === 4);
  host.send({ t: 'start' });
  const v = await host.waitView((x) => x.phase === 'play');
  const ans = trackOfView(v, tracks);
  host.action({ type: 'guess', text: ans.title });
  const after = await host.waitView((x) => x.me.guesses.length === 1);
  assert.equal(after.me.won, true, `tam başlık "${ans.title}" kabul edilmeli`);
  bots[1].action({ type: 'giveUp' });
});

test('çok kaynak: en fazla 20 kaynak adı, her biri ≤ 80 karakter; room özeti 8 KB altında', async () => {
  const { host } = await fresh(2);
  for (let k = 0; k < 26; k++) host.send({ t: 'prep', data: { op: 'add', source: `${k}-${'🎶'.repeat(100)}`, tracks: [] } });
  const r = await barrier(host);
  assert.equal(r.prep.sources.length, 20);
  for (const s of r.prep.sources) assert.ok([...s].length <= 80);
  const roomBytes = Buffer.byteLength(JSON.stringify({ t: 'room', room: r }));
  assert.ok(roomBytes < 8192, `room mesajı ${roomBytes} bayt`);
  console.log(`en kötü kaynak listesiyle room mesajı: ${roomBytes} bayt (prep özeti ${Buffer.byteLength(JSON.stringify(r.prep))} bayt)`);
});

test('8 KB sınırı: büyük prep mesajı bağlantıyı kapatır, prep değişmez, host geri bağlanınca host kalır', async () => {
  const { host } = await fresh(2);
  await sendPrep(host, makeTracks(5, 53));
  const big = { t: 'prep', data: { op: 'add', source: 'Büyük', tracks: makeTracks(60, 54).map((t) => ({ ...t, title: `${t.title} ${'x'.repeat(100)}` })) } };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 8192);
  host.send(big);
  await host.waitFor(() => false, { timeout: 2000 }).catch(() => {});
  assert.equal(host.closed?.code, 1009, 'mesaj çok büyük → 1009');
  await host.connect();
  const r = await host.waitRoom((x) => x.code, { timeout: 2000 });
  assert.equal(r.hostId, host.playerId, 'host hızlı dönünce host kalır');
  assert.equal(r.prep.trackCount, 5);
  assert.ok(!r.prep.sources.includes('Büyük'));
});

test('istemci parçalama: gerçekçi Deezer şarkıları bayt boyutuna göre parçalanır (≤ 6000 bayt), hepsi odaya ulaşır', async () => {
  const { host } = await fresh(2);
  const rng = createRng(55);
  const deezer = Array.from({ length: 50 }, (_, i) => deezerLikeTrack(rng, i));
  // public/shazam.js syncPrep ile aynı algoritma: şarkı sayısına değil bayt boyutuna göre
  const chunks = [];
  let chunk = [];
  let size = 0;
  for (const t of deezer) {
    const bytes = Buffer.byteLength(JSON.stringify(t)) + 1;
    if (size + bytes > 6000 && chunk.length) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(t);
    size += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  host.send({ t: 'prep', data: { op: 'reset' } });
  for (const c of chunks) {
    const msg = { t: 'prep', data: { op: 'add', source: 'Deezer: Rock Klasikleri', tracks: c } };
    assert.ok(Buffer.byteLength(JSON.stringify(msg)) < 8192, 'parça mesaj sınırını aşmamalı');
    host.send(msg);
    await sleep(50);
  }
  const r = await host.waitRoom((x) => x.prep.trackCount === 50, { timeout: 3000 }).catch(() => null);
  assert.equal(host.closed, null, `host bağlantısı kapandı: ${JSON.stringify(host.closed)}`);
  assert.equal(r?.prep.trackCount, 50);
});

test('hız sınırı × parçalı prep: patlama hâlinde 30/5 sn üstü düşer (rate hatası); istemci aralığıyla (200 ms) hepsi girer', async () => {
  const { host: burst } = await fresh(2);
  const tracks = makeTracks(40, 56);
  for (const t of tracks) burst.send({ t: 'prep', data: { op: 'add', tracks: [t] } });
  await sleep(300);
  const rateErr = burst.errors.find((e) => e.code === 'rate');
  assert.ok(rateErr, 'hız sınırı hatası gelmeli');
  await sleep(5000 - 300); // pencere sıfırlansın
  const r = await barrier(burst);
  // Pencere başına 30 mesaj (hello/create dahil) işlenir; kalan şarkılar SESSİZCE düşer (istemci bunu bilmez).
  assert.ok(r.prep.trackCount >= 25 && r.prep.trackCount <= 30, `işlenen: ${r.prep.trackCount}`);
  console.log(`patlama: 40 parça gönderildi, ${r.prep.trackCount} şarkı girdi`);

  // İstemci davranışı: reset + 34 parça, 200 ms arayla → 5 sn'de en fazla 25 mesaj → hiçbiri düşmez
  const { host } = await fresh(2);
  const many = makeTracks(34 * 2, 57);
  await sendPrep(host, many, { chunk: 2, gap: 200, wait: false });
  const r2 = await host.waitRoom((x) => x.prep.trackCount === 68, { timeout: 3000 });
  assert.equal(r2.prep.trackCount, 68);
  assert.equal(host.errors.filter((e) => e.code === 'rate').length, 0);
});

test('görünüm boyutu: 300 uzun adlı şarkıda her görünüm (her eylemde her oyuncuya) havuzun tamamını taşımamalı', async () => {
  const { bots, host } = await fresh(3);
  const tracks = Array.from({ length: 300 }, (_, i) => ({ title: `w${i} ${'Ş'.repeat(196)}`, artist: `${'Ü'.repeat(199)}`, audio: `https://p.scdn.co/mp3-preview/y${String(i).padStart(10, '0')}` }));
  await sendPrep(host, tracks, { chunk: 9, gap: 200, wait: false }); // istemci aralığı: 5 sn'de ≤ 25 mesaj
  await host.waitRoom((x) => x.prep.trackCount === 300, { timeout: 10_000 });
  host.send({ t: 'start' });
  await host.waitView((v) => v.phase === 'play');
  const before = bots[1].messages.length;
  host.action({ type: 'skip' });
  await bots[1].waitView((v) => v.players.some((p) => p.stage === 1));
  const bytes = bots[1].messages.slice(before).filter((m) => m.t === 'view').reduce((s, m) => s + m.bytes, 0);
  console.log(`bir 'skip' eylemi sonrası oyuncu başına görünüm: ${bytes} bayt`);
  for (const b of bots) b.action({ type: 'giveUp' });
  assert.ok(bytes < 64 * 1024, `görünüm ${bytes} bayt`);
});
