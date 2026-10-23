// Tosun Shazam (online) sürü testleri için ortak araçlar (test dosyası değil; swarm-shazam-*.test.mjs kullanır).
// - makeTracks: test şarkıları üretir (test cevapları bilir çünkü şarkıları prep ile kendisi verir).
// - sendPrep: istemcinin syncPrep'i gibi parça parça (varsayılan 25 şarkı/mesaj) gönderir.
// - ShazamReferee: her mesajdan sonra değişmezleri (invariant) denetler, ihlalleri toplar.
// - shazamMonkey: rastgele ama çoğunlukla kurallara uygun oynayan bot döngüsü (bazen doğru cevap).
import { createRng, sleep } from './swarm-lib.mjs';

export const STAGES = [0.5, 1.5, 5, 10, 20];
const STAGE_COUNT = STAGES.length;

// Birbirine benzemeyen, şarkı adı olarak kullanılacak kelimeler (eşleştirici bir başlığı diğeriyle karıştırmasın).
const WORDS = [
  'Kayısı', 'Fırtına', 'Gölge', 'Martı', 'Pusula', 'Çınar', 'Lodos', 'Yakamoz', 'Kervan', 'Zümrüt', 'Ağustos', 'Bulut',
  'Şelale', 'Kehribar', 'Mercan', 'Vapur', 'Lavanta', 'Kumsal', 'Yıldırım', 'Papatya', 'Okyanus', 'Fener', 'Tülin',
  'Sarmaşık', 'Hazan', 'Rüzgâr', 'İnci', 'Kartal', 'Böğürtlen', 'Gümüş', 'Nergis', 'Çağlayan', 'Poyraz', 'Yasemin',
  'Kestane', 'Turna', 'Menekşe', 'Akasya', 'Ilgaz', 'Sümbül', 'Kızılcık', 'Ebruli', 'Defne', 'Zeytin', 'Mavişehir',
];
const ARTISTS = ['Grup Kuzgun', 'Selin Ova', 'Deniz Taşkın', 'Murat Ekin', 'Ayla Çevik', 'Kaan Berk', 'Nilüfer Atlas', 'Ozan Doruk'];

const hex = (rng, n) => Array.from({ length: n }, () => '0123456789abcdef'[rng.int(16)]).join('');
const alnum = (rng, n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789'[rng.int(58)]).join('');

// n adet geçerli şarkı: 3 tür (Deezer önizleme, Spotify önizleme, YouTube), her birinin adı/sanatçısı/kapağı/Spotify kimliği benzersiz.
export function makeTracks(n, seed = 1, { tag = '' } = {}) {
  const rng = createRng(seed * 7919 + n);
  const out = [];
  const used = new Set();
  for (let i = 0; out.length < n; i++) {
    const a = WORDS[rng.int(WORDS.length)];
    const b = WORDS[rng.int(WORDS.length)];
    if (a === b) continue;
    const title = `${a} ${b}${tag}`;
    if (used.has(title)) continue;
    used.add(title);
    const kind = out.length % 3;
    const t = { title, artist: `${ARTISTS[rng.int(ARTISTS.length)]} ${out.length}` };
    if (kind === 0) {
      const h = hex(rng, 32);
      t.audio = `https://cdnt-preview.dzcdn.net/api/1/1/${h[0]}/${h[1]}/${h[2]}/0/${h}.mp3`;
      t.cover = `https://cdn-images.dzcdn.net/images/cover/${hex(rng, 32)}/250x250-000000-80-0-0.jpg`;
    } else if (kind === 1) {
      t.audio = `https://p.scdn.co/mp3-preview/${hex(rng, 40)}`;
      t.cover = `https://i.scdn.co/image/ab67616d0000b273${hex(rng, 24)}`;
      t.spotifyId = alnum(rng, 22);
    } else {
      t.ytId = alnum(rng, 11);
      t.cover = `https://i.ytimg.com/vi/${t.ytId}/hqdefault.jpg`;
    }
    out.push(t);
  }
  return out;
}

// Gerçekçi boyutta Deezer şarkısı (api.deezer.com'dan alınan önizleme/kapak adresi uzunluklarıyla, 2026-10).
export function deezerLikeTrack(rng, i) {
  const h = hex(rng, 32);
  return {
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} (Remastered 2015) ${i}`,
    artist: `${ARTISTS[i % ARTISTS.length]}`,
    audio: `https://cdnt-preview.dzcdn.net/api/1/1/${h[0]}/${h[1]}/${h[2]}/0/${h}.mp3?hdnea=exp=1792791555~acl=/api/1/1/${h[0]}/${h[1]}/${h[2]}/0/${h}.mp3*~data=user_id=0,application_id=42~hmac=${hex(rng, 64)}`,
    cover: `https://cdn-images.dzcdn.net/images/cover/${hex(rng, 32)}/1000x1000-000000-80-0-0.jpg`,
  };
}

// İstemcinin syncPrep'i gibi: reset, sonra `chunk` şarkılık parçalar, aralarında `gap` ms.
export async function sendPrep(host, tracks, { chunk = 25, gap = 0, source = 'Test listesi', reset = true, wait = true } = {}) {
  if (reset) host.send({ t: 'prep', data: { op: 'reset' } });
  for (let i = 0; i < tracks.length; i += chunk) {
    host.send({ t: 'prep', data: { op: 'add', source, tracks: tracks.slice(i, i + chunk) } });
    if (gap) await sleep(gap);
  }
  if (wait) {
    const expected = Math.min(300, new Set(tracks.map((t) => `${t.title}|${t.artist}`)).size);
    await host.waitRoom((r) => r.prep?.trackCount === expected, { timeout: 8000 });
  }
}

export const mediaKey = (m) => (m?.ytId ? `yt:${m.ytId}` : `au:${m?.audio}`);
const trackMediaKey = (t) => (t.ytId ? `yt:${t.ytId}` : `au:${t.audio}`);

// Doğru cevap sayılması gereken (eşleştiricinin kesin kabul etmesi gereken) tahmin biçimleri.
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };
export function rightVariants(track) {
  const t = track.title;
  return [t, t.toLocaleLowerCase('tr'), t.toLocaleUpperCase('tr'), t.replace(/[çğıöşüâÇĞİÖŞÜ]/g, (c) => FOLD[c]), `  ${t}  `.trim(), `${track.artist} ${t}`.slice(0, 80)];
}

// pool: eski sürümde her görünümde, yeni sürümde oyun başına bir kez 't:shared' mesajında (ikisi de kabul).
const VIEW_KEYS = ['gameKey', 'round', 'totalRounds', 'phase', 'endsAt', 'stages', 'media', 'me', 'players', 'reveal', 'over'].sort().join();
const VIEW_KEYS_POOL = ['gameKey', 'round', 'totalRounds', 'phase', 'endsAt', 'stages', 'media', 'pool', 'me', 'players', 'reveal', 'over'].sort().join();
const ME_KEYS = ['stage', 'guesses', 'done', 'won', 'points'].sort().join();
const MEDIA_KEYS = ['key', 'ytId', 'audio', 'startFraction'].sort().join();
const PLAYER_PLAY_KEYS = ['id', 'name', 'score', 'stage', 'done', 'won'].sort().join();
const PLAYER_REVEAL_KEYS = ['id', 'name', 'score', 'stage', 'done', 'won', 'roundPoints', 'tries'].sort().join();
const REVEAL_KEYS = ['title', 'artist', 'cover', 'spotifyId', 'ytId'].sort().join();
const keysOf = (o) => Object.keys(o).sort().join();
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

// Görünümün açıklama öncesi gizli olması gereken değerleri (tüm şarkılar için) içerip içermediğine bakar.
// Hariç: pool (öneri listesi, kasıtlı herkese açık) ve kendi tahmin metinleri.
export function secretHits(view, tracks) {
  const { pool, me, ...rest } = view;
  const text = JSON.stringify({ ...rest, me: me && { ...me, guesses: me.guesses.map((g) => g.ok) } });
  const hits = [];
  for (const t of tracks) {
    for (const s of [t.title, t.artist, t.cover, t.spotifyId]) if (s && s.length >= 4 && text.includes(JSON.stringify(s).slice(1, -1))) hits.push(s);
  }
  return hits;
}

export class ShazamReferee {
  constructor({ label = 'room', tracks, noLeaves = false, clockTol = 400 } = {}) {
    this.label = label;
    this.tracks = tracks;
    this.byMedia = new Map(tracks.map((t) => [trackMediaKey(t), t]));
    this.noLeaves = noLeaves; // kimse oyundan kalıcı ayrılmıyorsa: kazanılan her adımda TAM BİR bonus olmalı
    this.clockTol = clockTol;
    this.violations = [];
    this.bots = new Map();
    this.per = new Map();
    this.games = new Map(); // gameKey -> { rounds: Map(n -> rec), totalRounds, over }
    this.stats = { views: 0, reveals: 0, timerReveals: 0, earlyReveals: 0, overs: 0, bonus: 0, wins: 0, maxViewBytes: 0 };
  }

  fail(bot, msg, detail) {
    if (this.violations.length < 200) this.violations.push(`[${this.label}] ${bot?.name ?? '-'}: ${msg}${detail !== undefined ? ` | ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }

  attach(bot) {
    this.bots.set(bot.playerId, bot);
    bot.sentGuesses ??= new Set(); // bu botun gönderdiği tahmin metinleri (temizlenmiş hâliyle)
    bot.rightGuesses ??= new Set(); // doğru olması gereken tahminler
    this.per.set(bot, { conn: bot.connections, lastView: null, prepCount: null, settings: null });
    bot.taps.push((msg) => this.onMessage(bot, msg));
    return this;
  }

  attachAll(bots) { bots.forEach((b) => this.attach(b)); return this; }

  answerFor(view) { return this.byMedia.get(mediaKey(view.media)); }

  game(key) {
    if (!this.games.has(key)) this.games.set(key, { rounds: new Map(), totalRounds: null, over: false, mediaSeen: new Map() });
    return this.games.get(key);
  }

  onMessage(bot, msg) {
    try {
      if (msg.t === 'error' && msg.code === 'internal') this.fail(bot, 'sunucu iç hatası (internal)', msg);
      if (msg.t === 'error') {
        // Hata metinleri cevabı ele vermemeli
        for (const t of this.tracks) if (t.title.length >= 4 && String(msg.message).includes(t.title)) this.fail(bot, 'hata metninde şarkı adı', msg.message);
      }
      if (msg.t === 'room') this.checkRoom(bot, msg.room);
      if (msg.t === 'view' && msg.view) this.checkView(bot, msg.view, msg);
      if (msg.t === 'shared') {
        const st = this.per.get(bot);
        st.sharedPool ??= {};
        if (keysOf(msg.data ?? {}) !== 'pool') this.fail(bot, 'shared mesajında beklenmeyen alan', Object.keys(msg.data ?? {}));
        st.sharedPool[msg.key] = msg.data?.pool;
      }
    } catch (err) {
      this.fail(bot, `hakem hatası: ${err.stack}`);
    }
  }

  checkRoom(bot, room) {
    const st = this.per.get(bot);
    if (!room) { st.lastView = null; return; } // odadan çıktı/atıldı: tekrar katılırsa (izleyici olarak) takip baştan
    if (room.prep) {
      if (keysOf(room.prep) !== 'maxTracks,sources,trackCount') this.fail(bot, 'room.prep beklenmeyen alanlar', Object.keys(room.prep));
      const size = Buffer.byteLength(JSON.stringify(room.prep));
      if (size > 8192) this.fail(bot, `room.prep özeti büyük: ${size} bayt`);
      if (!isInt(room.prep.trackCount, 0, 300)) this.fail(bot, 'trackCount 0..300 dışında', room.prep.trackCount);
      for (const t of this.tracks) if (t.title.length >= 4 && JSON.stringify(room).includes(t.title)) this.fail(bot, 'room mesajında şarkı adı', t.title);
      st.prepCount = room.prep.trackCount;
    }
    st.settings = room.settings;
  }

  checkView(bot, v, msg) {
    this.stats.views++;
    if (msg.bytes > this.stats.maxViewBytes) this.stats.maxViewBytes = msg.bytes;
    const st = this.per.get(bot);
    const reconnected = st.conn !== bot.connections;
    st.conn = bot.connections;
    let pv = st.lastView;
    if (pv && pv.gameKey !== v.gameKey) pv = null; // yeni oyun

    // 1) Biçim
    if (keysOf(v) !== VIEW_KEYS && keysOf(v) !== VIEW_KEYS_POOL) this.fail(bot, 'görünüm alanları beklenmedik', Object.keys(v));
    if (!['play', 'reveal', 'over'].includes(v.phase)) this.fail(bot, `geçersiz faz ${v.phase}`);
    if (v.over !== (v.phase === 'over')) this.fail(bot, 'over ile phase tutarsız', { over: v.over, phase: v.phase });
    if (JSON.stringify(v.stages) !== JSON.stringify(STAGES)) this.fail(bot, 'stages değişti', v.stages);
    if (keysOf(v.media) !== MEDIA_KEYS) this.fail(bot, 'media alanları beklenmedik', Object.keys(v.media));
    const track = this.answerFor(v);
    if (!track) this.fail(bot, 'media bilinen bir şarkıya ait değil', v.media);
    if (!isInt(v.totalRounds, 1, 30)) this.fail(bot, 'totalRounds 1..30 dışında', v.totalRounds);
    if (!isInt(v.round, 1, v.totalRounds)) this.fail(bot, `round ${v.round} 1..${v.totalRounds} dışında`);
    if (st.prepCount != null && v.totalRounds > st.prepCount - 3) this.fail(bot, `totalRounds (${v.totalRounds}) > odadaki şarkı − 3 (${st.prepCount})`);
    if (st.settings && v.totalRounds > st.settings.rounds) this.fail(bot, `totalRounds ${v.totalRounds} > ayar ${st.settings.rounds}`);
    if (v.phase === 'play' && v.endsAt == null) this.fail(bot, 'play fazında endsAt yok');
    if (v.endsAt != null && typeof v.endsAt !== 'number') this.fail(bot, 'endsAt sayı değil');
    const pool = v.pool ?? st.sharedPool?.[v.gameKey];
    if (!Array.isArray(pool)) this.fail(bot, 'pool yok (ne görünümde ne shared mesajında)');
    else if (pool.length < v.totalRounds) this.fail(bot, 'pool tur sayısından kısa', pool.length);

    const g = this.game(v.gameKey);
    if (g.totalRounds == null) g.totalRounds = v.totalRounds;
    else if (g.totalRounds !== v.totalRounds) this.fail(bot, 'totalRounds oyun içinde değişti');
    if (pool) {
      if (g.pool == null) g.pool = JSON.stringify(pool);
      else if (g.pool !== JSON.stringify(pool)) this.fail(bot, 'pool oyun içinde değişti');
    }
    // Aynı oyunda her tur farklı şarkı; aynı tur herkese aynı şarkı ve başlangıç noktası
    const mk = mediaKey(v.media);
    const seenRound = g.mediaSeen.get(mk);
    if (seenRound != null && seenRound !== v.round) this.fail(bot, `aynı şarkı iki turda çaldı (${seenRound}, ${v.round})`);
    g.mediaSeen.set(mk, v.round);
    const rec = g.rounds.get(v.round) ?? { media: mk, start: v.media.startFraction, key: v.media.key, points: null };
    g.rounds.set(v.round, rec);
    if (rec.media !== mk || rec.start !== v.media.startFraction || rec.key !== v.media.key) this.fail(bot, 'aynı turda oyunculara farklı medya/başlangıç', { round: v.round });

    // 2) Oyuncular
    const ids = v.players.map((p) => p.id);
    if (new Set(ids).size !== ids.length) this.fail(bot, 'players içinde tekrar eden id');
    const revealed = v.phase !== 'play';
    for (const p of v.players) {
      if (keysOf(p) !== (revealed ? PLAYER_REVEAL_KEYS : PLAYER_PLAY_KEYS)) this.fail(bot, `oyuncu alanları beklenmedik (${v.phase})`, Object.keys(p));
      if (!isInt(p.stage, 0, STAGE_COUNT - 1)) this.fail(bot, `adım 0..4 dışında: ${p.stage}`);
      if (p.won && !p.done) this.fail(bot, 'bildi ama bitirmedi', p);
      if (!isInt(p.score, 0, 6 * 30)) this.fail(bot, 'skor geçersiz', p.score);
      if (revealed) {
        if (!p.done) this.fail(bot, 'açıklamada bitirmemiş oyuncu', p);
        const base = STAGE_COUNT - p.stage;
        const ok = p.won ? p.roundPoints === base || p.roundPoints === base + 1 : p.roundPoints === 0;
        if (!ok) this.fail(bot, `tur puanı kuralı: won=${p.won} stage=${p.stage} pts=${p.roundPoints}`);
        if (!isInt(p.tries, 0, STAGE_COUNT)) this.fail(bot, 'tries 0..5 dışında', p.tries);
        if (p.won && p.tries !== p.stage + 1) this.fail(bot, `bilenin deneme sayısı adım+1 olmalı (tries=${p.tries}, stage=${p.stage})`);
      }
    }
    if (v.phase === 'play' && v.players.length && v.players.every((p) => p.done)) this.fail(bot, 'herkes bitirdi ama tur açılmadı', { round: v.round });

    // 3) Kendi görünümüm
    const me = v.me;
    if (me) {
      if (keysOf(me) !== ME_KEYS) this.fail(bot, 'me alanları beklenmedik', Object.keys(me));
      if (!isInt(me.stage, 0, STAGE_COUNT - 1)) this.fail(bot, `me.stage 0..4 dışında: ${me.stage}`);
      if (me.guesses.length > STAGE_COUNT) this.fail(bot, '5\'ten fazla deneme', me.guesses.length);
      const wrong = me.guesses.filter((x) => !x.ok).length;
      const oks = me.guesses.filter((x) => x.ok).length;
      if (oks > 1 || (oks === 1 && !me.guesses.at(-1).ok)) this.fail(bot, 'doğru tahminden sonra deneme var', me.guesses);
      if (me.won !== (oks === 1)) this.fail(bot, 'won ile doğru tahmin tutarsız', me);
      if (me.stage !== Math.min(wrong, STAGE_COUNT - 1)) this.fail(bot, `adım (${me.stage}) yanlış/geç sayısıyla (${wrong}) uyuşmuyor`);
      if (!me.won && wrong >= STAGE_COUNT && !me.done) this.fail(bot, '5 yanlışta bitmedi');
      if (me.won && me.points !== STAGE_COUNT - me.stage && me.points !== STAGE_COUNT - me.stage + 1) this.fail(bot, 'me.points kuralı', me);
      if (!me.won && me.points !== 0) this.fail(bot, 'bilemeyen puan aldı', me);
      for (const x of me.guesses) {
        if (x.text == null) continue;
        if (!bot.sentGuesses.has(x.text)) this.fail(bot, 'me.guesses içinde bu botun göndermediği metin', x.text);
        if (bot.rightGuesses.has(`${v.gameKey}:${v.round}:${x.text}`) && !x.ok) this.fail(bot, `doğru tahmin reddedildi: "${x.text}" (cevap ${track?.title})`);
        if (x.text.startsWith('yanlis ') && x.ok) this.fail(bot, `yanlış tahmin kabul edildi: "${x.text}"`);
      }
      const mineAsPlayer = v.players.find((p) => p.id === bot.playerId);
      if (mineAsPlayer && (mineAsPlayer.stage !== me.stage || mineAsPlayer.done !== me.done || mineAsPlayer.won !== me.won)) this.fail(bot, 'players[] ve me tutarsız');
    }
    // Başkalarının tahmin metinleri hiçbir görünümde olmamalı
    const raw = JSON.stringify(v);
    for (const other of this.bots.values()) {
      if (other === bot) continue;
      for (const s of other.sentGuesses) if (s.startsWith('yanlis ') && raw.includes(s)) this.fail(bot, `başkasının tahmin metni görünümde: ${s}`);
    }

    // 4) Gizlilik: açıklama öncesi hiçbir şarkının adı/sanatçısı/kapağı/Spotify kimliği
    if (v.phase === 'play') {
      if (v.reveal !== null) this.fail(bot, 'play fazında reveal dolu');
      const hits = secretHits(v, this.tracks);
      if (hits.length) this.fail(bot, 'açıklama öncesi gizli değer görünümde', hits);
      // Sunucu saatine göre (test sürecinin gecikmesi karışmasın): gönderildiği anda süre çoktan dolmuşsa zamanlayıcı geç kaldı
      const sentAt = msg.serverNow ?? msg.receivedAt;
      if (sentAt > v.endsAt + this.clockTol) this.fail(bot, `süre ${sentAt - v.endsAt} ms önce doldu ama tur açılmadı (sunucu saati)`);
    } else if (track) {
      if (keysOf(v.reveal ?? {}) !== REVEAL_KEYS) this.fail(bot, 'reveal alanları beklenmedik', v.reveal);
      else if (v.reveal.title !== track.title || v.reveal.artist !== track.artist || v.reveal.cover !== (track.cover ?? null)
        || v.reveal.spotifyId !== (track.spotifyId ?? null) || v.reveal.ytId !== (track.ytId ?? null)) this.fail(bot, 'açıklanan şarkı çalınanla uyuşmuyor', { reveal: v.reveal, track });
    }

    // 5) Faz/tur geçişi + "finished player can't act" (bitirince me değişmez)
    if (pv && !reconnected) {
      if (v.round < pv.round) this.fail(bot, `tur geri gitti ${pv.round} → ${v.round}`);
      if (v.round > pv.round + 1) this.fail(bot, `tur atladı ${pv.round} → ${v.round}`);
      if (v.round === pv.round + 1 && pv.phase === 'play') this.fail(bot, 'tur açılmadan sonraki şarkıya geçildi');
      if (v.round === pv.round + 1 && v.phase !== 'play') this.fail(bot, `yeni tur ${v.phase} fazında başladı`);
      if (v.round === pv.round && pv.phase !== 'play' && v.phase === 'play') this.fail(bot, 'açıklanan tur tekrar play oldu');
      if (pv.phase === 'over' && (v.phase !== 'over' || v.round !== pv.round)) this.fail(bot, 'oyun bittikten sonra görünüm değişti', { phase: v.phase, round: v.round });
      if (v.round === pv.round && pv.me?.done && me && JSON.stringify(pv.me) !== JSON.stringify(me)) this.fail(bot, 'bitirmiş oyuncunun durumu değişti', { before: pv.me, after: me });
      if (v.round === pv.round && pv.me && me) {
        if (me.guesses.length < pv.me.guesses.length || me.stage < pv.me.stage || (pv.me.done && !me.done)) this.fail(bot, 'ilerleme geri gitti');
      }
      // Açılış zamanı: önceki play görünümünde ≥2 kişi bitmemişse tek eylem herkesi bitiremez → zamanlayıcı olmalı
      if (v.round === pv.round && pv.phase === 'play' && v.phase !== 'play') {
        const pending = pv.players.filter((p) => !p.done).length;
        const byTimer = (msg.serverNow ?? msg.receivedAt) >= pv.endsAt - 5;
        if (pending >= 2 && !byTimer && this.noLeaves) this.fail(bot, `tur ${pv.endsAt - msg.receivedAt} ms erken açıldı, ${pending} kişi bitmemişti`);
      }
    }
    if (pv && reconnected && v.round < pv.round) this.fail(bot, 'yeniden bağlanınca tur geri gitti');

    // 6) Puan kayıtları: skor = önceki turların puan toplamı (+ bu tur bildiyse bu turun puanı)
    const cumBefore = this.cumulative(g, v.round);
    if (v.phase !== 'play') {
      if (!rec.points) {
        rec.points = new Map(v.players.map((p) => [p.id, p.roundPoints]));
        this.stats.reveals++;
        const pending = pv && pv.round === v.round && pv.phase === 'play' ? pv : null;
        if (pending && (msg.serverNow ?? msg.receivedAt) >= pv.endsAt - 5) this.stats.timerReveals++; else this.stats.earlyReveals++;
        // Adım başına en fazla bir bonus (kimse ayrılmadıysa kazanılan her adımda tam bir)
        const byStage = new Map();
        for (const p of v.players.filter((x) => x.won)) {
          this.stats.wins++;
          const b = byStage.get(p.stage) ?? { winners: 0, bonus: 0 };
          b.winners++;
          if (p.roundPoints === STAGE_COUNT - p.stage + 1) { b.bonus++; this.stats.bonus++; }
          byStage.set(p.stage, b);
        }
        for (const [s, b] of byStage) {
          if (b.bonus > 1) this.fail(bot, `adım ${s}'de ${b.bonus} bonus verildi`, { round: v.round });
          if (this.noLeaves && b.bonus !== 1) this.fail(bot, `adım ${s}'de ${b.winners} bilen var ama ${b.bonus} bonus`, { round: v.round });
        }
      } else {
        for (const p of v.players) if (rec.points.has(p.id) && rec.points.get(p.id) !== p.roundPoints) this.fail(bot, 'aynı turun puanı botlara farklı göründü');
      }
      if (cumBefore) for (const p of v.players) {
        const exp = (cumBefore.get(p.id) ?? 0) + (rec.points.get(p.id) ?? 0);
        if (p.score !== exp) this.fail(bot, `skor (${p.score}) ≠ tur puanları toplamı (${exp})`, { round: v.round, name: p.name });
      }
    } else if (cumBefore) {
      for (const p of v.players) {
        const d = p.score - (cumBefore.get(p.id) ?? 0);
        const ok = p.won ? d === STAGE_COUNT - p.stage || d === STAGE_COUNT - p.stage + 1 : d === 0;
        if (!ok) this.fail(bot, `oyun sırasında skor farkı kurala uymuyor (won=${p.won}, stage=${p.stage}, fark=${d})`);
      }
    }
    if (v.phase === 'over') {
      if (v.round !== v.totalRounds) this.fail(bot, `oyun ${v.round}/${v.totalRounds}. turda bitti`);
      if (!g.over) { g.over = true; this.stats.overs++; }
    }
    st.lastView = v;
  }

  // 1..round-1 turlarının oyuncu bazında puan toplamı; bir tur kaydı eksikse null.
  cumulative(g, round) {
    const sum = new Map();
    for (let r = 1; r < round; r++) {
      const rec = g.rounds.get(r);
      if (!rec?.points) return null;
      for (const [id, pts] of rec.points) sum.set(id, (sum.get(id) ?? 0) + pts);
    }
    return sum;
  }

  finalChecks(bots = [...this.bots.values()]) {
    for (const b of bots) {
      const text = b.transcript();
      for (const o of bots) if (o !== b && o.token && text.includes(o.token)) this.fail(b, `${o.name} token'ını gördü`);
    }
    return this.violations;
  }
}

// ---------- Monkey oyuncu ----------
// profile: 'random' (karışık), 'sharp' (sık bilir), 'idle' (hiç oynamaz → süre dolar), 'quitter' (sık pes eder).
export function shazamMonkey(bot, { rng, ref, stop, stats = {}, profile = 'random', cooldown = 180, minDelay = 15, maxDelay = 90, nextDelay = [0, 120] }) {
  let lastSent = 0;
  let n = 0;
  const count = (k) => { stats[k] = (stats[k] ?? 0) + 1; };
  const act = (a, kind) => { lastSent = Date.now(); bot.action(a); count(kind); };
  const pRight = { random: 0.18, sharp: 0.5, idle: 0, quitter: 0.1 }[profile];
  const pGiveUp = { random: 0.04, sharp: 0.02, idle: 0, quitter: 0.35 }[profile];
  return (async () => {
    while (!stop.done) {
      await sleep(minDelay + rng.int(maxDelay - minDelay + 1));
      if (stop.done) break;
      if (!bot.isOpen || !bot.view || !bot.room || bot.room.phase !== 'playing') continue;
      if (Date.now() - lastSent < cooldown) continue;
      const v = bot.view;
      if (v.phase === 'reveal') {
        if (bot.room.hostId === bot.playerId) {
          await sleep(nextDelay[0] + rng.int(nextDelay[1] - nextDelay[0] + 1));
          if (bot.view === v || bot.view?.phase === 'reveal') act({ type: 'next' }, 'next');
        }
        continue;
      }
      if (v.phase !== 'play' || !v.me) continue;
      if (profile === 'idle') continue;
      if (v.me.done) {
        // Bitirmiş oyuncu eylem dener → reddedilmeli (hakem: me değişmemeli)
        if (rng.next() < 0.15) {
          const t = `yanlis ${bot.name}-${n++}`;
          bot.sentGuesses.add(t);
          act(rng.next() < 0.5 ? { type: 'guess', text: t } : { type: rng.pick(['skip', 'giveUp']) }, 'afterDone');
        }
        continue;
      }
      const x = rng.next();
      if (x < 0.04) { act(rng.pick([{ type: 'next' }, { type: 'guess', text: { toString: 1 } }, { type: 'guess', text: '   ' }, { type: 'zz' }, { type: 'guess' }]), 'illegal'); continue; }
      if (x < 0.04 + pRight) {
        const track = ref.answerFor(v);
        if (!track) continue;
        const t = rng.pick(rightVariants(track));
        bot.sentGuesses.add(t);
        bot.rightGuesses.add(`${v.gameKey}:${v.round}:${t}`);
        act({ type: 'guess', text: t }, 'right');
      } else if (x < 0.04 + pRight + pGiveUp) act({ type: 'giveUp' }, 'giveUp');
      else if (x < 0.62) {
        const t = `yanlis ${bot.name}-${n++}`;
        bot.sentGuesses.add(t);
        act({ type: 'guess', text: t }, 'wrong');
      } else act({ type: 'skip' }, 'skip');
    }
  })();
}

export function summarizeS(ref) {
  const s = ref.stats;
  return `${ref.label}: views=${s.views} reveals=${s.reveals} (timer=${s.timerReveals}, early=${s.earlyReveals}) wins=${s.wins} bonus=${s.bonus} overs=${s.overs} maxView=${s.maxViewBytes}B`;
}

// Havuz: eski sürümde görünümde, yeni sürümde 't:shared' mesajında.
export function poolOf(bot, view = bot.view) {
  if (view?.pool) return view.pool;
  return bot.messages.findLast((m) => m.t === 'shared' && m.key === view?.gameKey)?.data?.pool ?? null;
}

// Her turda herkes pes eder, host sıradakine geçer (açılışta otomatik geçiş olsa da çalışır); oyun bitene kadar.
// Her turun { media, reveal } kaydını döndürür.
export async function playToEnd(host, bots, { onRound } = {}) {
  const out = [];
  for (;;) {
    const v = await host.waitView((x) => x.phase === 'play' && !out.some((o) => o.round === x.round) || x.phase === 'over', { timeout: 5000 });
    if (v.phase === 'over') break;
    if (onRound) await onRound(v);
    for (const b of bots) b.action({ type: 'giveUp' });
    const rv = await host.waitView((x) => (x.round === v.round && x.phase !== 'play') || x.round > v.round, { timeout: 5000 });
    const rev = rv.round === v.round ? rv : host.messages.find((m) => m.t === 'view' && m.view?.round === v.round && m.view.phase !== 'play')?.view;
    out.push({ round: v.round, media: v.media, reveal: rev?.reveal ?? null });
    if (rv.phase === 'reveal' && rv.round === v.round) host.action({ type: 'next' });
    if (rv.phase === 'over') break;
  }
  await host.waitRoom((r) => r.phase === 'over', { timeout: 5000 });
  return out;
}
