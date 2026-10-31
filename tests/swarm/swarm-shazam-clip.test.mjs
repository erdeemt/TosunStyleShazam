// 🎵 Shazam online ses vekili (server/clips.js): Ağ sekmesinden cevap sızmasın.
// - Hiçbir WS mesajında / HTTP yanıtında (oyun sırasında) YouTube kimliği, CDN adresi, şarkı adı yok (tüm bot trafiği taranır)
// - Klip adresleri opak (128 bit), benzersiz, oyuncuya bağlı (başkasının çereziyle 403), tur bitince 404
// - Adım kapısı: klip o adımın süresi kadar; uzun adımın adresi ancak oraya gelince
// - Range (Safari): 206 + Content-Range; çoklu aralık → 200; geçersiz → 416
// - Hız sınırı (oyuncu başına), opak tur anahtarı (SHAZAM_OPAQUE_KEYS=1)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { makeRoom, makeBots, sleep } from '../lib/bot.js';
import { clipCookie, getClip, roundKeyOf, trackOfView } from '../lib/shazam-keys.js';
import { parseMp3 } from '../../server/mp3.js';

const STAGES = [0.5, 1.5, 5, 10, 20];
const FD = 1152 / 44100;

let srv;
const all = [];
before(async () => { srv = await startServer({ timeScale: 0.05 }); });
after(async () => { all.forEach((b) => b.close()); await srv.stop(); });

const TRACKS = [
  { title: 'Kehribar Lodos', artist: 'Grup Pusula', audio: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/kehribar.mp3?hdnea=exp=1~hmac=zz', cover: 'https://e-cdns-images.dzcdn.net/images/cover/kehribar.jpg' },
  { title: 'Martı Fener', artist: 'Selin Mercan', audio: 'https://p.scdn.co/mp3-preview/martifener0001', spotifyId: 'MARTISPOTIFY0000001' },
  { title: 'Yakamoz Kervan', artist: 'Deniz Çınar', audio: 'https://cdns-preview-a.dzcdn.net/stream/c-yakamoz.mp3' },
  { title: 'Zümrüt Vapur', artist: 'Kaan Turna', audio: 'https://p.scdn.co/mp3-preview/zumrutvapur02' },
  { title: 'Lavanta Kumsal', artist: 'Ayla Ilgaz', audio: 'https://p.scdn.co/mp3-preview/lavantakumsal3' },
  { title: 'Sarmaşık Hazan', artist: 'Ozan Defne', audio: 'https://p.scdn.co/mp3-preview/sarmasikhazan4' },
  { title: 'Böğürtlen Poyraz', artist: 'Nilüfer Akasya', audio: 'https://p.scdn.co/mp3-preview/bogurtlenpoyr5' },
];
// Oyun sırasında hiçbir yerde görünmemesi gerekenler (öneri havuzu hariç: o kasıtlı aday listesi)
const NEEDLES = ['dzcdn', 'scdn.co', 'mp3-preview', 'hdnea', 'ytId', 'youtube', 'audio":', ...TRACKS.flatMap((t) => [t.title, t.artist, t.spotifyId].filter(Boolean))];

async function setup(n, { server = srv, rounds = 3 } = {}) {
  const room = await makeRoom(server.wsUrl, 'shazam', n, 'Kulak');
  all.push(...room.bots);
  room.host.send({ t: 'prep', data: { op: 'add', source: 'Gizli liste', tracks: TRACKS } });
  await room.host.waitRoom((r) => r.prep?.trackCount === TRACKS.length);
  room.host.send({ t: 'settings', settings: { rounds, roundSeconds: 180 } });
  await room.host.waitRoom((r) => r.settings.rounds === rounds);
  room.host.send({ t: 'start' });
  await Promise.all(room.bots.map((b) => b.waitView((v) => v.phase === 'play')));
  for (const b of room.bots) b.cookie = await clipCookie(server.url, b);
  return room;
}

async function act(bot, action) {
  const before = bot.view.me.guesses.length;
  bot.action({ ...action, stage: bot.view.me.stage, round: bot.view.round });
  return bot.waitView((v) => !v.me || v.me.guesses.length > before || v.me.done || v.phase !== 'play');
}

const scan = (label, text) => {
  for (const n of NEEDLES) assert.ok(!text.includes(n), `${label}: "${n}" sızdı`);
};

test('tam oyun: klip her adımda o adım kadar, hiçbir mesaj/yanıtta şarkı kimliği yok; adresler opak, benzersiz', async () => {
  const { bots, host } = await setup(3, { rounds: 3 });
  const seenTokens = new Set();
  const clipBodies = [];
  for (let round = 1; round <= 3; round++) {
    await host.waitView((v) => v.round === round && v.phase === 'play');
    const ans = trackOfView(host.view, TRACKS);
    assert.ok(ans, 'test anahtarıyla şarkı bulunmalı');
    // Her oyuncu farklı adres (oyuncuya bağlı); biçim /api/clip/<22 base64url>
    const views = bots.map((b) => b.view);
    for (const v of views) assert.match(v.media.clip, /^\/api\/clip\/[\w-]{22}$/);
    assert.equal(new Set(views.map((v) => v.media.clip)).size, bots.length, 'oyunculara aynı adres gitti');
    assert.deepEqual(Object.keys(views[0].media).sort(), ['clip', 'key']);
    // bots[0]: tüm adımları geçer; her adımda klip süresi = adım (+ en fazla 5 çerçeve), yeni adres
    const a = bots[0];
    let prevDur = 0;
    for (let s = 0; s < STAGES.length; s++) {
      await a.waitView((v) => v.me.stage === s);
      const path = a.view.media.clip;
      assert.ok(!seenTokens.has(path), 'adres yeniden kullanıldı');
      seenTokens.add(path);
      const r = await getClip(srv.url, path, a.cookie);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'audio/mpeg');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('accept-ranges'), 'bytes');
      const p = parseMp3(r.body);
      assert.ok(p, 'klip geçerli MP3');
      assert.ok(p.duration >= STAGES[s] - FD && p.duration <= STAGES[s] + 5 * FD, `adım ${s}: klip ${p.duration.toFixed(3)} sn (beklenen ≈ ${STAGES[s]})`);
      assert.ok(p.duration > prevDur, 'uzun adım daha uzun klip');
      prevDur = p.duration;
      clipBodies.push(r.body);
      scan(`klip yanıt başlıkları r${round}s${s}`, JSON.stringify([...r.headers]));
      if (s < STAGES.length - 1) await act(a, { type: 'skip' });
    }
    // Eski adımın adresi hâlâ sadece kısa klip verir (daha fazlasını değil)
    // bots[1] ilk adımda bilir; bots[2] pes eder
    await act(bots[1], { type: 'guess', text: ans.title });
    // a son adımda yanlış → biter
    await act(a, { type: 'guess', text: 'kesinlikle yanlış' });
    const playClip = bots[2].view.media.clip;
    assert.equal((await getClip(srv.url, playClip, bots[2].cookie)).status, 200);
    await act(bots[2], { type: 'giveUp' });
    const rv = await host.waitView((v) => v.round === round && v.phase === 'reveal');
    // Tur bitti: oyun klipleri geçersiz (404); açılış klibi yeni adres, sona kadar
    assert.equal((await getClip(srv.url, playClip, bots[2].cookie)).status, 404, 'tur bitince oyun klibi 404 olmalı');
    const rclip = bots[2].view.media.clip;
    assert.ok(rclip && rclip !== playClip);
    const rr = await getClip(srv.url, rclip, bots[2].cookie);
    assert.equal(rr.status, 200);
    assert.ok(parseMp3(rr.body).duration > STAGES.at(-1) - 1, 'açılışta başlangıçtan sona kadar');
    assert.equal(rv.reveal.title, ans.title);
    if (round < 3) host.action({ type: 'next', round });
  }
  await host.waitView((v) => v.phase === 'over');
  // Tüm bot trafiği: açılış öncesi görünümler + room/shared/error mesajları. Havuz (aday listesi) ve açılış hariç.
  for (const b of bots) {
    for (const m of b.messages) {
      if (m.t === 'shared') continue; // öneri havuzu: kasıtlı herkese açık aday listesi (cevap değil)
      if (m.t === 'view' && (m.view?.phase !== 'play')) continue;
      const { receivedAt, bytes, ...msg } = m;
      if (msg.view?.me) msg.view.me = { ...msg.view.me, guesses: msg.view.me.guesses.filter((g) => !g.ok) }; // kendi doğru tahmini
      scan(`${b.name} ${m.t}`, JSON.stringify(msg));
    }
  }
  for (const body of clipBodies) scan('klip gövdesi', body.toString('latin1'));
});

test('bağlama: çerezsiz / sahte çerez / başka oyuncunun çerezi / odada olmayan kimlik → 403; uydurma adres 404', async () => {
  const { bots } = await setup(2);
  const [a, b] = bots;
  const path = a.view.media.clip;
  assert.equal((await getClip(srv.url, path, null)).status, 403, 'çerezsiz');
  assert.equal((await getClip(srv.url, path, 'tss_clip=x.y.z')).status, 403, 'bozuk çerez');
  const [pid, exp] = a.cookie.slice('tss_clip='.length).split('.');
  assert.equal((await getClip(srv.url, path, `tss_clip=${pid}.${exp}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status, 403, 'sahte imza');
  assert.equal((await getClip(srv.url, path, `tss_clip=${pid}.${Number(exp) + 100}.${a.cookie.split('.')[2]}`)).status, 403, 'süresi oynanmış');
  assert.equal((await getClip(srv.url, path, b.cookie)).status, 403, 'odadaki başka oyuncu');
  const [outsider] = await makeBots(srv.wsUrl, 1, 'Dışarıdan');
  all.push(outsider);
  const oc = await clipCookie(srv.url, outsider);
  assert.equal((await getClip(srv.url, path, oc)).status, 403, 'odada olmayan kimlik');
  // Kimliksiz oturum alınamaz
  const bad = await fetch(`${srv.url}/api/clip-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: a.playerId, token: 'yanlis' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('set-cookie'), null);
  // Uydurma / tahmin edilmiş adresler
  assert.equal((await getClip(srv.url, '/api/clip/AAAAAAAAAAAAAAAAAAAAAA', a.cookie)).status, 404);
  assert.equal((await getClip(srv.url, '/api/clip/..%2F..%2Fetc', a.cookie)).status, 404);
  assert.equal((await getClip(srv.url, `${path}x`, a.cookie)).status, 404);
  // Sahibi: 200; POST → 405
  assert.equal((await getClip(srv.url, path, a.cookie)).status, 200);
  assert.equal((await fetch(`${srv.url}${path}`, { method: 'POST', headers: { Cookie: a.cookie } })).status, 405);
  // Çerez sadece /api/clip yoluna, HttpOnly, SameSite=Strict
  const res = await fetch(`${srv.url}/api/clip-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: a.playerId, token: a.token }) });
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /Path=\/api\/clip;/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  // Ayrılan oyuncunun adresleri iptal
  a.leave();
  await b.waitView((v) => v.players.every((p) => p.id !== a.playerId) || v.phase !== 'play');
  assert.equal((await getClip(srv.url, path, a.cookie)).status, 404, 'ayrılan oyuncunun klibi');
});

test('Range (Safari): bytes=0-1 → 206, son N bayt, aralık dışı 416, çoklu aralık 200; HEAD gövdesiz', async () => {
  const { bots } = await setup(2);
  const [a] = bots;
  const path = a.view.media.clip;
  const full = await getClip(srv.url, path, a.cookie);
  const len = full.body.length;
  const r1 = await getClip(srv.url, path, a.cookie, { Range: 'bytes=0-1' });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), `bytes 0-1/${len}`);
  assert.equal(r1.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...r1.body], [...full.body.subarray(0, 2)]);
  const r2 = await getClip(srv.url, path, a.cookie, { Range: 'bytes=-100' });
  assert.equal(r2.status, 206);
  assert.equal(r2.body.length, 100);
  const r3 = await getClip(srv.url, path, a.cookie, { Range: `bytes=${len}-` });
  assert.equal(r3.status, 416);
  assert.equal(r3.headers.get('content-range'), `bytes */${len}`);
  const r4 = await getClip(srv.url, path, a.cookie, { Range: 'bytes=0-1,4-5' });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.length, len);
  // Range ile tam önizleme alınamaz: en büyük aralık bile klibin kendisi
  const r5 = await getClip(srv.url, path, a.cookie, { Range: 'bytes=0-99999999' });
  assert.equal(r5.status, 206);
  assert.equal(r5.body.length, len);
  assert.ok(parseMp3(r5.body).duration < 0.5 + 5 * FD);
  const head = await fetch(`${srv.url}${path}`, { method: 'HEAD', headers: { Cookie: a.cookie } });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), len);
});

test('önizleme indirilemezse 502 (istemci "yüklenemedi" gösterir); tahmin/geç yine çalışır', async () => {
  const tracks = TRACKS.map((t, i) => (i < 4 ? { ...t, title: `${t.title} Y`, audio: `https://p.scdn.co/mp3-preview/yok${i}` } : t));
  const room = await makeRoom(srv.wsUrl, 'shazam', 2, 'Bozuk');
  all.push(...room.bots);
  room.host.send({ t: 'prep', data: { op: 'add', tracks } });
  await room.host.waitRoom((r) => r.prep?.trackCount === tracks.length);
  room.host.send({ t: 'settings', settings: { rounds: 4 } });
  await room.host.waitRoom((r) => r.settings.rounds === 4);
  room.host.send({ t: 'start' });
  const v = await room.host.waitView((x) => x.phase === 'play');
  const cookie = await clipCookie(srv.url, room.host);
  const t = trackOfView(v, tracks);
  const r = await getClip(srv.url, v.media.clip, cookie);
  if (/yok/.test(t.audio)) assert.equal(r.status, 502);
  else assert.equal(r.status, 200);
  const after = await act(room.host, { type: 'skip' });
  assert.equal(after.me.stage, 1);
});

test('hız sınırı (oyuncu başına) ve opak tur anahtarı (SHAZAM_OPAQUE_KEYS=1)', async () => {
  const s2 = await startServer({ timeScale: 0.05, env: { LIMIT_CLIP_PER_PLAYER_PER_MIN: '5', SHAZAM_OPAQUE_KEYS: '1' } });
  try {
    const { bots } = await setup(2, { server: s2 });
    const [a] = bots;
    assert.notEqual(a.view.media.key, roundKeyOf(a.view.gameKey, TRACKS[0].title));
    assert.equal(trackOfView(a.view, TRACKS), undefined, 'opak modda anahtardan şarkı bulunamaz');
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await getClip(s2.url, a.view.media.clip, a.cookie)).status);
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(codes.slice(5).every((c) => c === 429), `sınırdan sonra 429: ${codes}`);
  } finally {
    await s2.stop();
  }
});

test('izleyici (oyun ortasında katılan) oyun sırasında klip almaz, açılışta alır', async () => {
  const { bots, host, code } = await setup(2);
  const [spec] = await makeBots(srv.wsUrl, 1, 'İzleyici');
  all.push(spec);
  await spec.join(code);
  const sv = await spec.waitView((v) => v.phase === 'play');
  assert.equal(sv.media.clip, null);
  assert.equal(sv.me, null);
  for (const b of bots) if (!b.view.me.done) await act(b, { type: 'giveUp' });
  const rv = await spec.waitView((v) => v.phase === 'reveal');
  assert.match(rv.media.clip, /^\/api\/clip\//);
  const cookie = await clipCookie(srv.url, spec);
  assert.equal((await getClip(srv.url, rv.media.clip, cookie)).status, 200);
  await sleep(10);
  assert.ok(host);
});
